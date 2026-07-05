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

export interface TagResult {
  slug: string;
  // The tag(s) the invocation acted on (after normalize/dedupe).
  tag: string[];
  action: "added" | "removed";
  // The card's full tag list after the edit.
  tags: string[];
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
  // Slugs of live cards tombstoned as part of a forced board removal.
  deletedCards: string[];
}

export interface RankResult {
  board: string;
  column: string;
  total: number;
  reordered: number;
  order: { slug: string; priority: string; position: number }[];
}

export interface MigrateAreaTagsResult {
  scanned: number;
  changed: number;
  skippedDone: number;
  dryRun: boolean;
  cards: { slug: string; board: string; column: string; removed: string[]; added: string[] }[];
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

export function formatTag(res: TagResult, json?: boolean): string {
  const verb = res.action === "added" ? "tagged" : "untagged";
  const acted = res.tag.join(", ") || "nothing";
  const tags = res.tags.join(", ") || "none";
  return emit(res, `${verb} ${res.slug} ${acted} (tags: ${tags})`, json);
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

export function formatRank(res: RankResult, json?: boolean): string {
  const human =
    res.total === 0
      ? `ranked ${res.board}/${res.column}: no cards`
      : `ranked ${res.board}/${res.column}: ${res.reordered} of ${res.total} reordered by priority ` +
        `(${res.order.map((c) => `${c.slug}[${c.priority}]`).join(", ")})`;
  return emit(res, human, json);
}

export function formatMigrateAreaTags(res: MigrateAreaTagsResult, json?: boolean): string {
  if (json) return JSON.stringify(res);
  const verb = res.dryRun ? "would re-derive" : "re-derived";
  const lines = res.cards.map((c) => {
    const rm = c.removed.length ? ` -[${c.removed.join(", ")}]` : "";
    const add = c.added.length ? ` +[${c.added.join(", ")}]` : "";
    return `  ${c.slug} (${c.board}/${c.column})${rm}${add}`;
  });
  const head =
    `${verb} pickup area tags: ${res.changed} of ${res.scanned} active cards changed ` +
    `(${res.skippedDone} done/terminal skipped)${res.dryRun ? " — DRY RUN, no writes" : ""}`;
  return res.cards.length ? `${head}\n${lines.join("\n")}` : head;
}
