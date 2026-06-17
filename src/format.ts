// Render mutation-command results either as a one-line human string or as a
// JSON object (`--json`). The CLI's read commands (list/show/board list)
// already format their own output; these cover the write commands (add, move,
// dep add/rm, rm, board create) so scripts and agents can confirm a write
// machine-readably instead of parsing prose.
//
// Each formatter is pure (result-in, string-out) so it is unit-testable
// without a live node.

export interface AddResult {
  slug: string;
  action: "created" | "updated";
  board: string;
  column: string;
}

export interface MoveResult {
  slug: string;
  from: string;
  to: string;
}

export interface DepResult {
  slug: string;
  dep: string;
  action: "added" | "removed";
  deps: string[];
}

export interface RmResult {
  slug: string;
  // Slugs of live cards that still listed `slug` in their deps — now dangling.
  // Surfaced as a stderr warning by the CLI and echoed under --json.
  orphanedDependents: string[];
}

export interface BoardCreateResult {
  slug: string;
  action: "created" | "updated";
}

export interface BoardRmResult {
  slug: string;
}

function emit(res: unknown, human: string, json: boolean | undefined): string {
  return json ? JSON.stringify(res) : human;
}

// A machine-readable failure envelope for `--json` callers — so a rejected
// write (e.g. a dependency cycle) is a clean `{ error: { code, message, hint } }`
// object on stdout, not half-written success or a prose line they must parse.
export function formatError(err: { code: string; message: string; hint?: string }): string {
  return JSON.stringify({
    error: { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) },
  });
}

export function formatAdd(res: AddResult, json?: boolean): string {
  return emit(res, `${res.action} card ${res.slug} → ${res.board}/${res.column}`, json);
}

export function formatMove(res: MoveResult, json?: boolean): string {
  return emit(res, `moved ${res.slug}: ${res.from} → ${res.to}`, json);
}

export function formatDep(res: DepResult, json?: boolean): string {
  const verb = res.action === "added" ? "now depends on" : "no longer depends on";
  const deps = res.deps.join(", ") || "none";
  return emit(res, `${res.slug} ${verb} ${res.dep} (deps: ${deps})`, json);
}

export function formatRm(res: RmResult, json?: boolean): string {
  return emit(res, `removed card ${res.slug}`, json);
}

export function formatBoardCreate(res: BoardCreateResult, json?: boolean): string {
  return emit(res, `${res.action} board ${res.slug}`, json);
}

export function formatBoardRm(res: BoardRmResult, json?: boolean): string {
  return emit(res, `removed board ${res.slug}`, json);
}
