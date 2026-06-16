// `fkanban doctor` — health-check the local setup: config present, node
// reachable + provisioned, both schemas resolved on the node, a query
// round-trips.

import { fileURLToPath } from "node:url";
import { FkanbanError, newNodeClient, type Verbose } from "../client.ts";
import { resolveSocketPath, tryReadConfig } from "../config.ts";
import { listBoards, listCards } from "../record.ts";
import { OWNER_APP_ID, UNIQUE_SCHEMAS } from "../schemas.ts";

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

export async function doctor(opts: DoctorOptions = {}): Promise<boolean> {
  const print = opts.print ?? ((l: string) => console.log(l));
  const onCheck = opts.onCheck;
  let ok = true;
  const check = (pass: boolean, label: string, detail?: string) => {
    if (!pass) ok = false;
    print(`${pass ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
    onCheck?.({ name: label, status: pass ? "pass" : "fail", detail });
  };

  // Informational only — the global shim is optional, so this never flips `ok`.
  // It just tells the user whether bare `fkanban` resolves on PATH.
  await reportShim(print, onCheck);

  const cfg = tryReadConfig(opts.configPath);
  check(cfg !== null, "config present", cfg ? undefined : "run `fkanban init`");
  if (!cfg) return false;

  print(`  node:   ${cfg.nodeUrl}`);
  print(`  schema: ${cfg.schemaServiceUrl}`);

  const node = newNodeClient({ baseUrl: cfg.nodeUrl, userHash: cfg.userHash, verbose: opts.verbose, socketPath: resolveSocketPath(cfg) });
  try {
    const id = await node.autoIdentity();
    check(id.provisioned, "node reachable + provisioned", id.provisioned ? undefined : id.reason);
  } catch (err) {
    // We ARE doctor, so strip the shared error's circular "run `fkanban doctor`
    // for a diagnosis." suffix and surface its `hint` (the start-folddb
    // guidance) instead — for both the printed line and the structured
    // `detail` the MCP `fkanban_doctor` tool consumes.
    let detail: string;
    if (err instanceof FkanbanError) {
      detail = err.message.replace(/ — run `fkanban doctor` for a diagnosis\.$/, "");
      if (err.hint) detail += ` — ${err.hint}`;
    } else {
      detail = err instanceof Error ? err.message : String(err);
    }
    check(false, "node reachable", detail);
    return false;
  }

  check(Boolean(cfg.schemaHashes.card), "card schema hash in config", cfg.schemaHashes.card);
  check(Boolean(cfg.schemaHashes.board), "board schema hash in config", cfg.schemaHashes.board);

  // Cross-check the config hashes against the node's loaded schema set.
  try {
    const loaded = await node.listSchemas();
    for (const entry of UNIQUE_SCHEMAS) {
      const descriptive = entry.schema.schema.descriptive_name;
      const match = loaded.find(
        (s) => s.owner_app_id === OWNER_APP_ID && s.descriptive_name === descriptive,
      );
      const configHash = cfg.schemaHashes[entry.key];
      check(
        Boolean(match) && match!.name === configHash,
        `${OWNER_APP_ID}/${descriptive} loaded + matches config`,
        match ? match.name : "not loaded on node — re-run `fkanban init`",
      );
    }
  } catch (err) {
    check(false, "node schema list", err instanceof Error ? err.message : String(err));
  }

  try {
    const cards = await listCards(node, cfg);
    const boards = await listBoards(node, cfg);
    check(true, "query round-trip", `${cards.length} cards, ${boards.length} boards`);
  } catch (err) {
    check(false, "query round-trip", err instanceof Error ? err.message : String(err));
  }

  return ok;
}

// Resolve the global `fkanban` shim on PATH, or `null` if bare `fkanban`
// doesn't resolve. Shared by `doctor` (advisory check) and `init` (to print
// the `claude mcp add` form that will actually work for this dev).
export function resolveFkanbanShim(): string | null {
  try {
    const which = Bun.spawnSync(["sh", "-c", "command -v fkanban"]);
    const out = which.stdout.toString().trim();
    if (which.exitCode === 0 && out) return out;
  } catch {
    // `command -v` unavailable — treat as not found.
  }
  return null;
}

// Is bare `fkanban` resolvable on PATH? Purely informational — prints a ✓ if a
// `fkanban` shim is found, or a · hint with the one-line install if not.
async function reportShim(
  print: (line: string) => void,
  onCheck?: (check: DoctorCheck) => void,
): Promise<void> {
  const resolved = resolveFkanbanShim();

  if (resolved) {
    print(`✓ global \`fkanban\` shim on PATH — ${resolved}`);
    onCheck?.({ name: "global `fkanban` shim on PATH", status: "info", detail: resolved });
    return;
  }

  // Point at this repo's bundled wrapper so the hint is copy-pasteable.
  const cliPath = fileURLToPath(import.meta.url); // .../src/commands/doctor.ts
  const repoRoot = cliPath.replace(/\/src\/commands\/doctor\.ts$/, "");
  const hint = `ln -sf "${repoRoot}/bin/fkanban" /usr/local/bin/fkanban`;
  print(`· no global \`fkanban\` shim on PATH (optional) — install with: ` + hint);
  onCheck?.({
    name: "global `fkanban` shim on PATH",
    status: "info",
    detail: `not found (optional) — install with: ${hint}`,
  });
}
