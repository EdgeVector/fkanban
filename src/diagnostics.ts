
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { defaultReadConfigPath } from "./config.ts";

/** Env override for the sink path. Tests point this at a temp file. */
export const DIAGNOSTICS_PATH_ENV = "FKANBAN_DIAGNOSTICS_PATH";
/** Set to "0" to disable recording entirely. */
export const DIAGNOSTICS_ENABLED_ENV = "FKANBAN_DIAGNOSTICS";

const REJECTIONS_FILE_NAME = "node-rejections.jsonl";

/**
 * Cap the file rather than rotate it. This is a diagnostic TAIL — the question
 * it answers is "what has the node refused lately", and nobody has ever wanted
 * the 10,000th-most-recent rejection. A cap with no second file also means no
 * way to leave a stale `.1` behind that a later reader mistakes for current.
 */
export const REJECTIONS_MAX_BYTES = 256 * 1024;
/** One entry must never be able to fill the file on its own. */
const MAX_MESSAGE_CHARS = 600;
const MAX_FIELDS_RECORDED = 40;

export type NodeRejection = {
  /** ISO-8601, UTC. */
  ts: string;
  pid: number;
  /** The kanban invocation, e.g. `doctor` or `mcp` — who provoked it. */
  argv: string;
  /** FkanbanError code: `unknown_fields`, `node_http_400`, … */
  code: string;
  message: string;
  schema?: string;
  fields?: string[];
  /** Filter as SENT, so a malformed key shape is visible verbatim. */
  filter?: unknown;
};

export function rejectionsPath(): string {
  const override = process.env[DIAGNOSTICS_PATH_ENV];
  if (override !== undefined && override.length > 0) return override;
  return join(dirname(defaultReadConfigPath()), REJECTIONS_FILE_NAME);
}

function recordingEnabled(): boolean {
  return process.env[DIAGNOSTICS_ENABLED_ENV] !== "0";
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * The command being run, for telling a deliberate probe apart from a real bug.
 * `process.argv` is `[runtime, script, …args]`; the args alone are what a human
 * reads as "the command". Flag VALUES are kept — a slug is not a secret here
 * and it is often the whole answer — but the string is clipped hard.
 */
function invocation(): string {
  const args = process.argv.slice(2).join(" ");
  return clip(args.length > 0 ? args : "(no args)", 200);
}

/**
 * A 400 the node raised against a query we constructed — as opposed to the
 * schema being absent, the caller lacking permission, or the node shedding load.
 *
 * `unknown_fields` is the projection naming a field the schema does not declare;
 * a bare `node_http_400` is any other malformed-request rejection (the node's
 * wire types are `deny_unknown_fields`, so a misspelled filter key lands here).
 * Deliberately NOT matched: 403, 404, 503 and transport failures, all of which
 * are the environment rather than the request.
 */
export function isMalformedQuery(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "unknown_fields" || code === "node_http_400";
}

/**
 * Append one rejection. NEVER throws and never blocks the caller's own error
 * handling: a sink that can break the path it observes is worse than no sink.
 *
 * Returns whether the line was written, so a test can assert the sink ran
 * rather than inferring it from a file it also has to locate.
 */
export function recordNodeRejection(
  entry: Omit<NodeRejection, "ts" | "pid" | "argv"> & Partial<Pick<NodeRejection, "ts">>,
): boolean {
  if (!recordingEnabled()) return false;
  try {
    const path = rejectionsPath();
    mkdirSync(dirname(path), { recursive: true });
    trimIfOversized(path);
    const line: NodeRejection = {
      ts: entry.ts ?? new Date().toISOString(),
      pid: process.pid,
      argv: invocation(),
      code: entry.code,
      message: clip(entry.message, MAX_MESSAGE_CHARS),
      ...(entry.schema !== undefined ? { schema: entry.schema } : {}),
      ...(entry.fields !== undefined
        ? { fields: entry.fields.slice(0, MAX_FIELDS_RECORDED) }
        : {}),
      ...(entry.filter !== undefined ? { filter: entry.filter } : {}),
    };
    appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
    return true;
  } catch {
    // Read-only home, full disk, a path that is a directory — all real, none
    // worth turning a degraded read into a crash. The node's own `err=` counter
    // remains the backstop.
    return false;
  }
}

/**
 * Drop the oldest half when the file passes its cap.
 *
 * Halving rather than emptying is the point: a cap that clears the file loses
 * the run-up to whatever is happening right now, and the run-up is usually the
 * evidence. Halving keeps the most recent entries across the boundary, so a
 * burst that crosses the cap is still readable end to end.
 */
function trimIfOversized(path: string): void {
  if (!existsSync(path)) return;
  if (statSync(path).size <= REJECTIONS_MAX_BYTES) return;
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
  const kept = lines.slice(Math.floor(lines.length / 2));
  writeFileSync(path, kept.length > 0 ? `${kept.join("\n")}\n` : "", "utf8");
}

/**
 * The most recent `limit` rejections, oldest first.
 *
 * Unparseable lines are SKIPPED, not thrown on: this file is appended to by
 * concurrent processes (six `kanban mcp` servers is a normal day on this
 * machine), and a torn line must cost one record, not the whole report.
 */
export function readRecentRejections(limit = 10): NodeRejection[] {
  try {
    const path = rejectionsPath();
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
    const out: NodeRejection[] = [];
    for (const line of lines.slice(-limit)) {
      try {
        const parsed = JSON.parse(line) as NodeRejection;
        if (typeof parsed?.code === "string") out.push(parsed);
      } catch {
        // torn or truncated append — skip this one
      }
    }
    return out;
  } catch {
    return [];
  }
}
