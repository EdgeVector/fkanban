// `kanban doctor` — health-check the local setup: config present, node
// reachable + provisioned, both schemas resolved on the node, a query
// round-trips.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pkg from "../../package.json" with { type: "json" };
import { FkanbanError, isLoopbackNodeUrl, newNodeClient, type Verbose } from "../client.ts";
import { resolveSocketPath, tryReadConfig } from "../config.ts";
import { mcpAddCommand, mcpEntrypointPath } from "../mcp/register.ts";
import { listBoards, listCards, findCard, probeSchemaWritable, type Board, type Card } from "../record.ts";
import {
  MEMBERSHIP_KEY_EXPECTATIONS,
  checkMembershipKeyLayout,
  checkProjectionParity,
} from "../membership_schema_guard.ts";
import {
  listBoardCardsPartition,
  sweepBoardCardsPartition,
} from "../board-cards.ts";
import { OWNER_APP_ID, UNIQUE_SCHEMAS, resolveLoadedSchema } from "../schemas.ts";

// A single machine-readable health check. `pass`/`fail` checks flip `ok`;
// `info` checks (e.g. the optional PATH shim) are advisory and never do.
export type DoctorCheck = { name: string; status: "pass" | "fail" | "info"; detail?: string };

export type DoctorOptions = {
  configPath?: string;
  verbose?: Verbose;
  print?: (line: string) => void;
  // Optional structured channel: invoked once per check, in the same order as
  // the printed lines. The CLI omits it (keeping the boolean + text contract);
  // the MCP server passes one to build `structuredContent`. Does NOT alter the
  // printed output.
  onCheck?: (check: DoctorCheck) => void;
};

// The machine-readable doctor report — the single shape shared by the CLI
// `doctor --json` path and the MCP `fkanban_doctor` tool's `structuredContent`,
// so the two can't diverge. `version` is the installed kanban CLI version
// (from package.json, the same source as `kanban --version`) — a report field,
// not a check, so it never affects `ok`. `lines` is the human report (joined
// ✓/✗ output) for callers that also want the text (the MCP tool surfaces it as
// `content`).
export type DoctorReport = { ok: boolean; version: string; checks: DoctorCheck[]; lines: string[] };

// Run doctor while collecting the structured `{ ok, version, checks }` report
// and the human lines, without printing anything. Both the CLI `--json` flag and
// the MCP handler build their output from this so the shape stays identical.
export async function runDoctorStructured(
  opts: Omit<DoctorOptions, "print" | "onCheck"> = {},
): Promise<DoctorReport> {
  const lines: string[] = [];
  const checks: DoctorCheck[] = [];
  const ok = await doctor({ ...opts, print: (l) => lines.push(l), onCheck: (c) => checks.push(c) });
  return { ok, version: pkg.version, checks, lines };
}

export async function doctor(opts: DoctorOptions = {}): Promise<boolean> {
  const print = opts.print ?? ((l: string) => console.log(l));
  const onCheck = opts.onCheck;
  let ok = true;
  const check = (pass: boolean, label: string, detail?: string) => {
    if (!pass) ok = false;
    print(`${pass ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
    onCheck?.({ name: label, status: pass ? "pass" : "fail", detail });
  };
  const info = (label: string, detail?: string) => {
    print(`· ${label}${detail ? ` — ${detail}` : ""}`);
    onCheck?.({ name: label, status: "info", detail });
  };

  // Report the installed kanban version up front — the one fact a bug report
  // most needs. Sourced from package.json (same as `kanban --version`), it's a
  // report line, not a check, so it never flips `ok`.
  print(`  fkanban v${pkg.version}`);

  // Informational only — the global shim is optional, so this never flips `ok`.
  // It just tells the user whether bare `fkanban` resolves on PATH.
  await reportShim(print, onCheck);

  const cfg = tryReadConfig(opts.configPath);
  check(cfg !== null, "config present", cfg ? undefined : "run `kanban init`");
  if (!cfg) return false;

  const socketPath = resolveSocketPath(cfg);
  const node = newNodeClient({ baseUrl: cfg.nodeUrl, userHash: cfg.userHash, verbose: opts.verbose, socketPath });

  // Which transport the node calls take. Local nodes are socket-only (the
  // loopback TCP control plane was retired), so the socket carries the board
  // data-plane routes plus the schema/identity reads doctor needs; with
  // `folddb-full.sock` it carries the whole node HTTP app. When no socket file
  // is present the transport is `unavailable` — there is no TCP to fall back to,
  // so requests will fail. This line is informational only — never flips `ok`;
  // it lets a user confirm the socket is live (or see that it's missing).
  // Printed BEFORE the reachability probe so the transport is named even if
  // that probe then fails.
  const transport = node.nodeTransport();
  const socketDataPlane = transport.transport === "socket";
  if (transport.transport === "socket") {
    print(`  node socket:     ${transport.socketPath}`);
  } else {
    print(`  node:            ${cfg.nodeUrl}`);
  }
  // The schema_service URL is recorded in config for diagnostics only — unlike
  // `node:` (reachability-probed below), the CLI never contacts it directly.
  // Mini owns mandatory registration, so don't print this as if the CLI had
  // independently checked the authoritative endpoint.
  print(`  schema (config): ${cfg.schemaServiceUrl}  (informational — Mini owns required schema registration)`);

  if (transport.transport === "socket") {
    const fallback = isLoopbackNodeUrl(cfg.nodeUrl)
      ? "socket-only; no TCP fallback"
      : "TCP fallback configured";
    const detail = `Unix socket — ${transport.socketPath} (${fallback})`;
    print(`✓ node transport: socket — ${detail}`);
    onCheck?.({ name: "node transport", status: "info", detail });
  } else {
    // Socket-only: a missing socket means the node is unreachable, not that TCP
    // takes over. Name it plainly so a user doesn't read "tcp" as a live path.
    const detail = transport.socketPath
      ? `socket missing at ${transport.socketPath} (local nodes are socket-only; ${cfg.nodeUrl} has no live TCP control plane)`
      : `no socket configured (local nodes are socket-only; ${cfg.nodeUrl} has no live TCP control plane)`;
    print(`· node transport: unavailable — ${detail}`);
    onCheck?.({ name: "node transport", status: "info", detail });
  }

  check(Boolean(cfg.schemaHashes.card), "card schema hash in config", cfg.schemaHashes.card);
  check(Boolean(cfg.schemaHashes.board), "board schema hash in config", cfg.schemaHashes.board);

  let queryRoundTrip: { cards: number; boards: number } | null = null;
  // The board + card sets from whichever round-trip branch ran, kept so the
  // later checks don't re-read the whole board to re-derive what this already
  // fetched. `null` means no round trip succeeded — those checks then fall back
  // to reading for themselves rather than silently skipping.
  //
  // Note the `else` arm below reads like a non-socket/TCP fallback. It is not:
  // the client is socket-only, so an absent socket fails `node reachable +
  // provisioned` and doctor returns before reaching it. It is only reachable
  // when the socket IS live but this first round trip threw — i.e. it is a
  // RETRY, which is why it also records the sets.
  //
  // Reuse is safe here, and it is worth saying WHY rather than leaving the next
  // reader to re-derive it: no check below depends on observing state AFTER the
  // schema write-probes. The parity check re-reads each PARTITION itself (that
  // comparison is the check); only the board LIST is reused. The multi-field
  // smoke check just needs one live card slug, and taking it from the pre-probe
  // set is strictly better — a set read after the probes could catch a
  // throwaway probe row mid-delete.
  let boardSet: Board[] | null = null;
  let cardSet: Card[] | null = null;
  if (socketDataPlane) {
    try {
      const boards = await listBoards(node, cfg);
      const cards = await listCards(node, cfg, { boards });
      boardSet = boards;
      cardSet = cards;
      queryRoundTrip = { cards: cards.length, boards: boards.length };
      check(true, "node reachable via socket", `${transport.socketPath} — query round-trip: ${cards.length} cards, ${boards.length} boards`);
    } catch (err) {
      check(false, "node reachable via socket", formatDoctorError(err));
    }
  }

  try {
    const id = await node.autoIdentity();
    check(id.provisioned, "node reachable + provisioned", id.provisioned ? undefined : id.reason);
  } catch (err) {
    const detail = formatDoctorError(err);
    check(false, "node reachable + provisioned", detail);
    return false;
  }

  // Cross-check the config hashes against the node's loaded schema set, and
  // WRITE-PROBE the configured hash. A bare "config hash == a loaded hash"
  // match is NOT enough: the node can load a stale, narrower schema version that
  // resolves fine yet rejects every write (fkanban #94). So for each schema:
  //   - confirm the configured hash is actually loaded, AND
  //   - confirm it's the write-compatible resolution (its fields superset the
  //     local definition) — flagging a config pinned to a narrower version, AND
  //   - write-probe it (create+delete an all-fields throwaway), the runtime
  //     backstop that catches non-writability regardless of reported fields.
  // This makes `doctor` red — not cosmetically green — when writes are broken.
  try {
    const loaded = await node.listSchemas();
    for (const entry of UNIQUE_SCHEMAS) {
      const descriptive = entry.schema.schema.descriptive_name;
      const configHash = cfg.schemaHashes[entry.key];
      const match = loaded.find((s) => s.name === configHash);
      const resolution = resolveLoadedSchema(entry.key, loaded);

      if (!match) {
        check(false, `${OWNER_APP_ID}/${descriptive} loaded + matches config`, `config hash ${configHash ?? "(unset)"} not loaded on node`);
        continue;
      }
      // The config hash IS loaded. Is it A write-compatible version?
      //
      // NOT "is it the one the resolver picked". Several loaded schemas can be
      // write-compatible at once (measured: four of the six `fkanban/Card`
      // schemas on the primary), and every one of them accepts a full-field
      // write, so pinning any of them is correct. Comparing against the single
      // ranked pick turned a tiebreak into a hard FAIL: the 2026-07-30T21:58Z
      // restart reordered the node's listing, the pick moved from the configured
      // 23-field hash to an equally-writable 19-field one, and `doctor` exited 1
      // over a board that had never lost a write — advising `kanban init`, which
      // declares BY DEFINITION and hands the same configured hash straight back.
      // A red no operator action can clear is how doctors get ignored.
      const pinnedIsWritable =
        resolution.kind === "ok" && resolution.compatible.includes(configHash!);
      if (resolution.kind === "ok" && !pinnedIsWritable) {
        check(
          false,
          `${OWNER_APP_ID}/${descriptive} config hash is the writable version`,
          `config is pinned to ${configHash} but the node's write-compatible ${descriptive} is ${resolution.hash} — run \`kanban init\` to adopt it`,
        );
      } else {
        check(true, `${OWNER_APP_ID}/${descriptive} loaded + matches config`, configHash);
      }

      // Ambiguity is a real finding, not a detail to drop: several loaded schemas
      // share this identity AND all accept a full-field write, so the resolver
      // has no principled reason to prefer one. It is informational (never flips
      // `ok`) precisely BECAUSE the pinned hash being among them is fine — but it
      // is worth saying out loud, since stale identities holding records are how
      // writes end up spread across more than one version of a record type.
      if (resolution.kind === "ok" && resolution.ambiguous) {
        info(
          `${OWNER_APP_ID}/${descriptive} resolution is ambiguous`,
          `${resolution.compatible.length} loaded schemas match ${descriptive} and all accept a full-field write` +
            ` — ranked pick ${resolution.hash} (widest field set, then hash)` +
            `; config pins ${configHash}${pinnedIsWritable ? " (write-compatible)" : ""}`,
        );
      }

      // Write-probe the configured hash — the actual "can the board be written?"
      // signal. A red here is the #94 outage made visible (instead of a green
      // doctor over a write-broken board).
      //
      // This runs even when the resolution check above FAILED. It used to
      // `continue` past it, which meant a schema whose resolution looked wrong
      // never got the one check that answers the question that matters — so a
      // FALSE resolution failure silently disabled the real #94 detector for
      // that schema. The configured hash is what every write actually targets,
      // so probing it is most valuable precisely when resolution is in doubt.
      const probe = await probeSchemaWritable(node, configHash!, entry.key);
      check(
        probe.writable,
        `${OWNER_APP_ID}/${descriptive} write-probe`,
        probe.writable
          ? "create+delete of an all-fields record round-tripped"
          : `node rejected a write of all fields — ${probe.reason}`,
      );
    }
  } catch (err) {
    if (queryRoundTrip !== null && isSocketModeSchemaListMiss(err)) {
      info("schema list control-plane unavailable (socket mode)", socketModeSchemaListDetail(queryRoundTrip));
    } else {
      const detail = formatDoctorError(err);
      check(false, "node schema list", detail);
    }
  }

  if (queryRoundTrip !== null) {
    check(true, "query round-trip", `${queryRoundTrip.cards} cards, ${queryRoundTrip.boards} boards`);
  } else {
    try {
      const boards = await listBoards(node, cfg);
      const cards = await listCards(node, cfg, { boards });
      boardSet = boards;
      cardSet = cards;
      check(true, "query round-trip", `${cards.length} cards, ${boards.length} boards`);
    } catch (err) {
      check(false, "query round-trip", formatDoctorError(err));
    }
  }

  // Membership-index key layout (BoardCards must partition by board, not
  // milestone). Catalog expand that rewrites hash_field empties list scrapers.
  // Hard-fail so LaunchAgents can refuse to start Factory/list pollers.
  if (typeof node.getSchema === "function") {
    for (const exp of MEMBERSHIP_KEY_EXPECTATIONS) {
      const hash = cfg.schemaHashes[exp.configKey];
      if (!hash) {
        info(
          `${exp.label} key layout`,
          `config hash unset — run \`kanban init\` to declare ${exp.configKey}`,
        );
        continue;
      }
      try {
        const detail = await node.getSchema(hash);
        const result = checkMembershipKeyLayout(
          {
            schema_type: detail.schema_type,
            hash_field: detail.key.hash_field,
            range_field: detail.key.range_field,
          },
          exp.expected,
          exp.alsoAccepts ?? [],
        );
        check(
          result.ok,
          `${exp.label} key layout (hash_field=${exp.expected.hash_field})`,
          result.ok
            ? `${detail.schema_type} key=${detail.key.hash_field}/${detail.key.range_field ?? "—"}`
            : result.reason,
        );
      } catch (err) {
        check(
          false,
          `${exp.label} key layout (hash_field=${exp.expected.hash_field})`,
          formatDoctorError(err),
        );
      }
    }
  } else {
    info("membership key layout checks skipped", "node client has no getSchema");
  }

  // BoardCards projection parity — the check that catches silent row loss.
  //
  // Key layout above is metadata; this is behaviour, and behaviour is what the
  // board actually serves. Two things it proves that nothing else does:
  //
  //   1. The board partition ANSWERS. That is the real question the key-layout
  //      check was reaching for, and it survives a multi-key expand that moves
  //      the catalog's reported hash_field.
  //   2. The wide projection sees every row the spine sees. LastDB drops a row
  //      from a result set when the field LEADING the projection has no atom on
  //      it — with no error — so a card can fall out of list/pickup/overlap
  //      while every other check stays green. On 2026-07-30 that was 58 rows on
  //      the live board, and `board-cards-heal` reported missing_card: 0 because
  //      it was reading through the same lossy projection.
  //
  // The baseline is `listBoardCardsPartitionComplete`, NOT the spine. Comparing
  // the wide read against the spine compared two filtered reads and called their
  // agreement clean: both are gated by their own leading field (`board` and
  // `slug`), so a row carrying neither is missing from both sides of the
  // subtraction and nets to zero. That is how `todo#00007777#debug-protein` — a
  // Card-less row with one `title` atom — sat in the live `default` partition
  // under a green "spine agrees". A check whose two inputs share the blind spot
  // it is looking for cannot report the failure; the union over leading fields
  // is the only input here that is not itself a projection.
  try {
    const boards = boardSet ?? (await listBoards(node, cfg));
    for (const b of boards) {
      const sweep = await sweepBoardCardsPartition(node, cfg, b.slug);
      if (sweep === null) {
        info(`BoardCards partition probe (${b.slug})`, "board_cards not bound — skipped");
        continue;
      }
      // A refused lead is a hole in the baseline, so parity below would be
      // comparing the wide read against an enumeration that is itself short —
      // and a parity check run on an incomplete baseline is the blind check
      // this whole block replaced. Report the gap instead of a verdict.
      //
      // This is not hypothetical: the first sweep on the live primary found
      // board `agent-dogfood-scratch` returning
      // `HTTP 400 … laststore: corrupt: empty rec` for lead `column` while
      // every other lead returned 0 rows. No kanban read leads with `column`,
      // so that partition has looked empty and healthy to every check there is.
      if (sweep.failedLeads.length > 0) {
        check(
          false,
          `BoardCards projection parity (${b.slug})`,
          `enumeration incomplete — node refused lead(s) ${
            sweep.failedLeads.map((f) => f.field).join(", ")
          }: ${sweep.failedLeads[0]!.error}`,
        );
        continue;
      }
      const wide = await listBoardCardsPartition(node, cfg, b.slug);
      if (wide === null) {
        check(false, `BoardCards partition probe (${b.slug})`, "wide partition read returned no result");
        continue;
      }
      const wideSlugs = new Set(wide.map((c) => c.slug));
      const droppedSlugs = [...new Set(sweep.rows.map((r) => r.slug))].filter((s) => !wideSlugs.has(s));
      const parity = checkProjectionParity(sweep.rows.length, wide.length, droppedSlugs);
      check(
        parity.ok,
        `BoardCards projection parity (${b.slug})`,
        parity.ok
          ? `${parity.rows} rows, every lead agrees`
          : parity.reason,
      );
    }
  } catch (err) {
    check(false, "BoardCards projection parity", formatDoctorError(err));
  }

  // Multi-field Card smoke: point-read one live card and require more than slug.
  // Slug-only projection was the 2026-07-24 Mini degradation signature.
  try {
    // One live card slug is all this needs; re-listing the whole board to find
    // one was the single largest avoidable read in doctor.
    const sample = (cardSet ?? (await listCards(node, cfg))).find((c) => c.slug);
    if (!sample) {
      info("card multi-field smoke", "no cards to sample");
    } else {
      const full = await findCard(node, cfg, sample.slug);
      if (!full) {
        check(
          false,
          "card multi-field smoke",
          `show/findCard missed slug ${sample.slug} (list thin row existed) — Mini may be degraded; do not run list scrapers that heal BoardCards`,
        );
      } else {
        const hasShape =
          (full.title && full.title.length > 0) ||
          (full.board && full.board.length > 0) ||
          (full.column && full.column.length > 0);
        check(
          Boolean(hasShape),
          "card multi-field smoke",
          hasShape
            ? `${full.slug} has title/board/column`
            : `${full.slug} returned slug-only projection (title/board/column empty) — Mini field join may be broken`,
        );
      }
    }
  } catch (err) {
    check(false, "card multi-field smoke", formatDoctorError(err));
  }

  // Informational only — surface the MCP entrypoint + the exact, shim-aware
  // `claude mcp add` command so a dev who just set up the CLI knows how to wire
  // up the MCP half too. Never flips `ok` (matches the shim precedent): a
  // missing/odd entrypoint is advisory, not a failure.
  reportMcpEntrypoint(print, onCheck);

  return ok;
}

function formatDoctorError(err: unknown): string {
  if (err instanceof FkanbanError) {
    let detail = err.message.replace(/ — run `kanban doctor` for a diagnosis\.$/, "");
    if (err.hint) detail += ` — ${err.hint}`;
    return detail;
  }
  return err instanceof Error ? err.message : String(err);
}

function isSocketModeSchemaListMiss(err: unknown): boolean {
  if (!(err instanceof FkanbanError)) return false;
  if (err.code === "service_unreachable") return true;
  return (
    (err.code === "node_http_404" || err.code === "node_http_405") &&
    err.message.includes("/api/schemas")
  );
}

function socketModeSchemaListDetail(queryRoundTrip: { cards: number; boards: number }): string {
  return (
    "schema list requires the retired loopback TCP control-plane; unavailable in socket mode " +
    `(expected: node is healthy; data-plane round-tripped ${queryRoundTrip.cards} cards, ${queryRoundTrip.boards} boards)`
  );
}

// Resolve the MCP entrypoint `claude mcp add` would target and print it plus
// the canonical register command (reusing init's single source of truth in
// src/mcp/register.ts). Purely informational.
function reportMcpEntrypoint(
  print: (line: string) => void,
  onCheck?: (check: DoctorCheck) => void,
): void {
  const name = "MCP entrypoint resolves";
  const entrypoint = mcpEntrypointPath();
  const addCmd = mcpAddCommand();

  // The bun+path form points at src/mcp/main.ts on disk; confirm it exists. The
  // shim form resolves to an installed bin, which `command -v` already verified.
  if (entrypoint && existsSync(entrypoint)) {
    print(`✓ MCP entrypoint resolves — ${entrypoint}`);
    print(`  register with: ${addCmd}`);
    onCheck?.({ name, status: "info", detail: `${entrypoint} — register with: ${addCmd}` });
    return;
  }

  const detail = entrypoint
    ? `resolved to ${entrypoint} but it does not exist`
    : "could not resolve the MCP entrypoint";
  print(`· MCP entrypoint could not be confirmed (optional) — ${detail}`);
  onCheck?.({ name, status: "info", detail });
}

// Resolve the preferred global kanban shim on PATH, falling back to the legacy
// fkanban shim while Phase A aliases are in force.
export function resolveKanbanShim(): { name: "kanban" | "fkanban"; path: string } | null {
  try {
    for (const name of ["kanban", "fkanban"] as const) {
      const which = Bun.spawnSync(["sh", "-c", `command -v ${name}`]);
      const out = which.stdout.toString().trim();
      if (which.exitCode === 0 && out) return { name, path: out };
    }
  } catch {
    // `command -v` unavailable — treat as not found.
  }
  return null;
}

// Is bare `kanban` resolvable on PATH? Purely informational — prints a ✓ if a
// kanban shim is found, or a · hint with the one-line install if not. The legacy
// fkanban shim remains accepted during the alias window.
async function reportShim(
  print: (line: string) => void,
  onCheck?: (check: DoctorCheck) => void,
): Promise<void> {
  const resolved = resolveKanbanShim();

  if (resolved) {
    print(`✓ global \`${resolved.name}\` shim on PATH — ${resolved.path}`);
    onCheck?.({ name: "global `kanban` shim on PATH", status: "info", detail: resolved.path });
    return;
  }

  // Point at this repo's one-line installer so the hint is copy-pasteable from
  // any cwd (the `cd …` makes `bun run install-cli` resolve this repo's script).
  const cliPath = fileURLToPath(import.meta.url); // .../src/commands/doctor.ts
  const repoRoot = cliPath.replace(/\/src\/commands\/doctor\.ts$/, "");
  const hint = `(cd "${repoRoot}" && bun run install-cli)`;
  print(`· no global \`kanban\` shim on PATH (optional) — install with: ` + hint);
  onCheck?.({
    name: "global `kanban` shim on PATH",
    status: "info",
    detail: `not found (optional) — install with: ${hint}`,
  });
}
