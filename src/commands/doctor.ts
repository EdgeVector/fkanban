// `kanban doctor` — health-check the local setup: config present, node
// reachable + provisioned, both schemas resolved on the node, a query
// round-trips.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pkg from "../../package.json" with { type: "json" };
import { FkanbanError, isLoopbackNodeUrl, newNodeClient, type Verbose } from "../client.ts";
import { resolveSocketPath, tryReadConfig } from "../config.ts";
import { mcpAddCommand, mcpEntrypointPath } from "../mcp/register.ts";
import { listBoards, listCards, probeSchemaWritable } from "../record.ts";
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
  // `node:` (reachability-probed below), the CLI never contacts it. The NODE
  // loads schemas from its own configured schema_service, so don't print this
  // as if it were a checked/authoritative endpoint.
  print(`  schema (config): ${cfg.schemaServiceUrl}  (informational — the node loads schemas, not the CLI)`);

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
  if (socketDataPlane) {
    try {
      const cards = await listCards(node, cfg);
      const boards = await listBoards(node, cfg);
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
      // The config hash IS loaded. Is it the write-compatible version?
      if (resolution.kind === "ok" && resolution.hash !== configHash) {
        check(
          false,
          `${OWNER_APP_ID}/${descriptive} config hash is the writable version`,
          `config is pinned to ${configHash} but the node's write-compatible ${descriptive} is ${resolution.hash} — run \`kanban init\` to adopt it`,
        );
        continue;
      }
      check(true, `${OWNER_APP_ID}/${descriptive} loaded + matches config`, configHash);

      // Write-probe the configured hash — the actual "can the board be written?"
      // signal. A red here is the #94 outage made visible (instead of a green
      // doctor over a write-broken board).
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
      const cards = await listCards(node, cfg);
      const boards = await listBoards(node, cfg);
      check(true, "query round-trip", `${cards.length} cards, ${boards.length} boards`);
    } catch (err) {
      check(false, "query round-trip", formatDoctorError(err));
    }
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
