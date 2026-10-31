// Read-only health checks for schema-owned records and named alternate keys.
import { MIN_LASTDB_API_VERSION } from "../lastdb-version.ts";
import { requireMultiKey, ownedSchemas } from "../multi-key.ts";
import { canonicalSchema } from "../canonical-vocabulary.ts";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pkg from "../../package.json" with { type: "json" };
import { DOCTOR_OPS_LABEL, FkanbanError, newNodeClient, type Verbose } from "../client.ts";
import { resolveSocketPath, tryReadConfig } from "../config.ts";
import { isOnDisk, resolveRunningBuild, shortBuild } from "../host_track.ts";
import { readRecentRejections, rejectionsPath } from "../diagnostics.ts";
import { mcpAddCommand, mcpEntrypointPath } from "../mcp/register.ts";
import { OWNER_APP_ID, type SchemaDefinition } from "../schemas.ts";

export type DoctorCheck = { name: string; status: "pass" | "fail" | "info"; detail?: string };
export type DoctorOptions = {
  configPath?: string;
  verbose?: Verbose;
  print?: (line: string) => void;
  onCheck?: (check: DoctorCheck) => void;
};
export type DoctorReport = { ok: boolean; version: string; checks: DoctorCheck[]; lines: string[] };

function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => JSON.stringify(key) + ":" + stable(item)).join(",") + "}";
  return JSON.stringify(value);
}

// Match the serialized defaults as well as every declared field and range part.
function namedKeys(keys: SchemaDefinition["alternate_keys"] = {}) {
  return Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, {
    hash_field: key.hash_field ?? "", hash_literal: key.hash_literal ?? null,
    range_field: key.range_field ?? null, range_separator: key.range_separator ?? null,
    range_parts: (key.range_parts ?? []).map(part => ({ field: part.field, format: part.format ?? "text" })),
    missing: key.missing ?? "reject", omit_empty_hash: key.omit_empty_hash ?? false,
  }]));
}

export async function runDoctorStructured(opts: Omit<DoctorOptions, "print" | "onCheck"> = {}): Promise<DoctorReport> {
  const lines: string[] = [];
  const checks: DoctorCheck[] = [];
  const ok = await doctor({ ...opts, print: line => lines.push(line), onCheck: check => checks.push(check) });
  return { ok, version: pkg.version, checks, lines };
}

export async function doctor(opts: DoctorOptions = {}): Promise<boolean> {
  const print = opts.print ?? console.log;
  let ok = true;
  const check = (pass: boolean, name: string, detail?: string) => {
    if (!pass) ok = false;
    print(`${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
    opts.onCheck?.({ name, status: pass ? "pass" : "fail", detail });
  };
  const info = (name: string, detail?: string) => {
    print(`· ${name}${detail ? ` — ${detail}` : ""}`);
    opts.onCheck?.({ name, status: "info", detail });
  };
  print(`  fkanban v${pkg.version}`);
  reportRunningBuild(check, info);
  await reportShim(print, opts.onCheck);
  const cfg = tryReadConfig(opts.configPath);
  check(cfg !== null, "config present", cfg ? undefined : "run `kanban init`");
  if (!cfg) return false;
  try { requireMultiKey(cfg); } catch (error) {
    check(false, "multi-key config", formatDoctorError(error));
    return false;
  }
  const node = newNodeClient({ baseUrl: cfg.nodeUrl, schemaFieldAliases: cfg.schemaFieldAliases,
    userHash: cfg.userHash, verbose: opts.verbose, socketPath: resolveSocketPath(cfg),
    opsLabel: DOCTOR_OPS_LABEL, skipApiVersionGate: true });
  const transport = node.nodeTransport();
  info("node transport", transport.transport === "socket" ? transport.socketPath : "socket unavailable");
  const schemas = ownedSchemas();
  const tasks = [
    { name: "node reachable + provisioned", run: async () => {
      const identity = await node.autoIdentity();
      if (!identity.provisioned) throw new Error(identity.reason);
    } },
    { name: "node api_version", run: async () => {
      if (!node.nodeVersion) throw new Error("The node client has no version route");
      const version = await node.nodeVersion();
      if (version.apiVersion < MIN_LASTDB_API_VERSION) throw new Error(`API ${version.apiVersion}; required ${MIN_LASTDB_API_VERSION}`);
    } },
    ...schemas.map(entry => ({ name: `${entry.key} owned schema`, run: async () => {
      const name = cfg.schemaHashes[entry.key];
      if (!name) throw new Error(`No configured ${entry.key} schema`);
      const expected = cfg.schemaFieldAliases?.[name] ? canonicalSchema(entry.schema) : entry.schema;
      const reply = await node.rawCall("GET", `/api/schema/${encodeURIComponent(name)}`);
      const root = reply.json as { data?: unknown };
      const value = (root?.data ?? root) as { schema?: unknown };
      const installed = (value?.schema ?? value) as SchemaDefinition | undefined;
      if (reply.status !== 200 || !installed || installed.owner_app_id !== OWNER_APP_ID
        || installed.descriptive_name !== expected.descriptive_name || installed.schema_type !== expected.schema_type
        || stable([installed.key?.hash_field, installed.key?.range_field ?? null]) !== stable([expected.key.hash_field, expected.key.range_field ?? null])
        || !Array.isArray(installed.fields) || stable([...installed.fields].sort()) !== stable([...expected.fields].sort())
        || stable(namedKeys(installed.alternate_keys)) !== stable(namedKeys(expected.alternate_keys))) {
        throw new Error("The installed schema differs from the app's owned fields or named key layout");
      }
    } })),
  ];
  const results = await Promise.allSettled(tasks.map(task => task.run()));
  results.forEach((result, index) => check(result.status === "fulfilled", tasks[index]!.name,
    result.status === "rejected" ? formatDoctorError(result.reason) : undefined));
  info("record membership", "LastDB maintains the named keys in each primary mutation.");
  reportMcpEntrypoint(print, opts.onCheck);
  reportRecentRejections(print, opts.onCheck);
  return ok;
}

const REJECTION_REPORT_LIMIT = 5;

function reportRecentRejections(
  print: (line: string) => void,
  onCheck?: (check: DoctorCheck) => void,
): void {
  const name = "node rejections (recent)";
  const recent = readRecentRejections(REJECTION_REPORT_LIMIT);
  if (recent.length === 0) {
    print(`✓ no node rejections recorded — ${rejectionsPath()}`);
    onCheck?.({ name, status: "info", detail: `none recorded at ${rejectionsPath()}` });
    return;
  }
  print(`· ${recent.length} recent node rejection(s) — ${rejectionsPath()}`);
  for (const r of recent) {
    // argv is what separates "doctor swept a lead it expected to fail" from
    // "a list on the default board 400s", so it leads the line.
    print(`    ${r.ts} [${r.argv}] ${r.code} — ${r.message}`);
    if (r.schema) print(`      schema=${r.schema} fields=${(r.fields ?? []).length} filter=${JSON.stringify(r.filter ?? null)}`);
  }
  onCheck?.({
    name,
    status: "info",
    detail: `${recent.length} recorded — newest ${recent[recent.length - 1]!.code} from \`${recent[recent.length - 1]!.argv}\``,
  });
}

function formatDoctorError(err: unknown): string {
  if (err instanceof FkanbanError) {
    let detail = err.message.replace(/ — run `kanban doctor` for a diagnosis\.$/, "");
    if (err.hint) detail += ` — ${err.hint}`;
    return detail;
  }
  return err instanceof Error ? err.message : String(err);
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

// The repo/install root of the code that is EXECUTING this doctor run —
// derived from this module's own URL, not from `command -v kanban`. The
// distinction is the whole point: a long-lived `kanban mcp` server and the
// shim on PATH can resolve to different version directories, and the honest
// answer is the tree that is actually loaded.
//
// Under the compiled artifact this returns the module's EMBEDDED path
// (`/$bunfs/root/kanban`), which is not a directory on disk. That is expected
// and handled: `resolveRunningBuild` falls back to the executable whenever the
// path it is handed does not exist. See src/host_track.ts.
export function runningSourceRoot(): string {
  return fileURLToPath(import.meta.url).replace(/\/src\/commands\/doctor\.ts$/, "");
}

/**
 * Is this doctor report coming from the build that is currently installed?
 *
 * A `✗` rather than a `·` when the answer is no, and deliberately so. The
 * failure being reported is not about the board — it is about the report's own
 * provenance, and a report from a build that is provably not the installed one
 * cannot vouch for its other verdicts. That is not hypothetical: on 2026-08-05
 * a superseded MCP server returned `✗ milestone_cards pin identity` against a
 * board the current CLI passed in the same minute, because the acknowledgement
 * field that clears it postdated the build serving the verdict. `isError` is
 * what makes an agent read the line instead of skimming past a `·`.
 *
 * The CLI cannot reach this state in normal operation — the shim re-resolves
 * `current` on every exec — so this red is, in practice, the MCP surface
 * telling an agent that its own answers are stale. The remedy is one action:
 * restart the server (a new agent session), or use the CLI, which is current
 * by construction.
 */
export function reportRunningBuild(
  check: (pass: boolean, label: string, detail?: string) => void,
  info: (label: string, detail?: string) => void,
  // The default names the source tree loaded by this process.
  sourceRoot: string = runningSourceRoot(),
): void {
  const name = "running build is the installed build";
  const running = resolveRunningBuild(sourceRoot);

  switch (running.status) {
    case "unmanaged":
      // A worktree or fresh clone. There is no `current` to be behind; saying
      // "stale" here would be false, and saying "✓ current" would be a claim
      // nothing was checked against.
      info("running build", `${running.runningRoot} (not a host-track install — nothing to compare)`);
      return;

    case "indeterminate":
      // Under a host-track root, but `current` did not resolve. Unknown must
      // fail toward "look at this", never toward "you're up to date".
      info(
        name,
        `could not resolve ${running.installRoot}/current — cannot confirm this build is the installed one`,
      );
      return;

    case "current":
      check(true, name, shortBuild(running.build, running.runningRoot));
      return;

    case "superseded": {
      const mine = shortBuild(running.build, running.runningRoot);
      const installed = shortBuild(running.currentBuild, running.currentRoot);
      check(
        false,
        name,
        `this process is running ${mine}, but ${running.installRoot}/current is ${installed} — ` +
          `it resolved the symlink at startup and a refresh cannot move a running process. ` +
          `Every verdict in this report comes from the superseded build, including any that ` +
          `postdate it. Restart this server (for an MCP server, start a new agent session), ` +
          `or re-run through the \`kanban\` CLI, which re-resolves \`current\` on every invocation.`,
      );
      return;
    }
  }
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

/**
 * How does a dev with no `kanban` on PATH get one? The remedy printed on the
 * one line whose entire job is to answer that.
 *
 * From a source checkout: this repo's one-line installer, made copy-pasteable
 * from any cwd (the `cd …` is what lets `bun run install-cli` resolve this
 * repo's script).
 *
 * From the compiled artifact there is no repo and no installer script on disk.
 * This module's URL is embedded, the regex below does not match, and the hint
 * used to read `(cd "/$bunfs/root/kanban" && bun run install-cli)` — an
 * impossible command, offered as the fix for the very thing it cannot fix. The
 * binary needs no installer to be useful: it IS the CLI, so the honest remedy
 * is to link it onto PATH.
 *
 * `isOnDisk` is the discriminator, not `existsSync` — both `existsSync` and
 * `statSync` SUCCEED on embedded paths, so either would be a no-op that looks
 * like a guard (see the measurement in src/host_track.ts).
 *
 */
export function shimInstallHint(repoRoot: string, execPath: string = process.execPath): string {
  return isOnDisk(repoRoot)
    ? `(cd "${repoRoot}" && bun run install-cli)`
    : `ln -s "${execPath}" ~/.local/bin/kanban`;
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

  const cliPath = fileURLToPath(import.meta.url); // .../src/commands/doctor.ts
  const repoRoot = cliPath.replace(/\/src\/commands\/doctor\.ts$/, "");
  const hint = shimInstallHint(repoRoot);
  print(`· no global \`kanban\` shim on PATH (optional) — install with: ` + hint);
  onCheck?.({
    name: "global `kanban` shim on PATH",
    status: "info",
    detail: `not found (optional) — install with: ${hint}`,
  });
}
