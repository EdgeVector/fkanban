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

export interface MarkResult {
  slug: string;
  action: "created" | "updated";
  board: string;
  column: string;
}

export interface MoveResult {
  slug: string;
  from: string;
  to: string;
  promotedDependents?: string[];
}

export interface DepResult {
  slug: string;
  dep: string;
  action: "added" | "removed";
  deps: string[];
  /**
   * Set only when the edge write ALSO moved the card. `dep add` demotes a
   * default/todo card to backlog, because default/todo is the pickup claim
   * lane and a card with an unfinished dep is not claimable there.
   *
   * The demote is deliberate and pinned (test/add-update-board.test.ts), but it
   * was invisible: the result type could not express a column change, so
   * neither the CLI line nor the MCP payload mentioned that the card had just
   * left the pickup lane. An operator who ran `dep add` saw only the edge.
   */
  demoted?: { from: string; to: string };
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
  /**
   * VESTIGIAL — always `[]`, and structurally cannot be anything else.
   *
   * This described a `rm` that tombstoned the card and reported whose deps it
   * had just left dangling. Since #149 (`e92d4a4`) `rmCmd` REFUSES that delete:
   * it scans live cards first and throws `card_has_dependents`, so there is no
   * surviving path on which an orphan is created and therefore none on which
   * this can be non-empty.
   *
   * The comment here outlived the change and kept asserting a behaviour that
   * had been deleted — "surfaced as a stderr warning by the CLI", of a warning
   * (`orphanedDependentsWarning`) no caller invokes any more. Kept as a field
   * because it is public `--json` / MCP output; retiring it is a compat break
   * and wants its own card, with `orphanedDependentsWarning` and the non-empty
   * branch of `formatRm`'s unit test, which now cover nothing reachable.
   */
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
  order: { slug: string; priority: string; position: number; lane?: string; hard_tier?: number }[];
  /** hard = lane+frontier (default); priority = legacy P0→P3 only */
  mode?: "hard" | "priority";
}

export interface MigrateAreaTagsResult {
  scanned: number;
  changed: number;
  skippedDone: number;
  dryRun: boolean;
  cards: { slug: string; board: string; column: string; removed: string[]; added: string[] }[];
}

export interface MigrateLegacyColumnsResult {
  scanned: number;
  offColumn: number;
  changed: number;
  unmapped: number;
  dryRun: boolean;
  cards: { slug: string; board: string; from: string; to: string | null; reason?: string }[];
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

export function formatMark(res: MarkResult, json?: boolean): string {
  return emit(res, `marked card ${res.slug} → ${res.board}/${res.column}`, json);
}

export function formatMove(res: MoveResult, json?: boolean): string {
  const promoted = res.promotedDependents ?? [];
  const suffix = promoted.length > 0 ? `; promoted ${promoted.join(", ")} to todo` : "";
  return emit(res, `moved ${res.slug}: ${res.from} → ${res.to}${suffix}`, json);
}

export function formatDep(res: DepResult, json?: boolean): string {
  const verb = res.action === "added" ? "now depends on" : "no longer depends on";
  const deps = res.deps.join(", ") || "none";
  // Name the column change in the SAME line as the edge. A separate warning
  // line is what `move` does for its lane clear, and the lesson from the
  // overlap gate is that the conclusion line is the one that gets read: an
  // operator who scans `... now depends on ...` and moves on must not be able
  // to miss that the card left the pickup lane.
  const demoted = res.demoted
    ? `; demoted ${res.demoted.from} → ${res.demoted.to} ` +
      "(default/todo is the pickup claim lane; a card with an unfinished dep is not claimable there)"
    : "";
  return emit(res, `${res.slug} ${verb} ${res.dep} (deps: ${deps})${demoted}`, json);
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
  const mode = res.mode ?? "hard";
  const human =
    res.total === 0
      ? `ranked ${res.board}/${res.column}: no cards`
      : `ranked ${res.board}/${res.column}: ${res.reordered} of ${res.total} reordered ` +
        `(mode=${mode}) ` +
        `(${res.order
          .map((c) =>
            c.lane
              ? `${c.slug}[${c.priority}|${c.lane}]`
              : `${c.slug}[${c.priority}]`,
          )
          .join(", ")})`;
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

export function formatMigrateLegacyColumns(
  res: MigrateLegacyColumnsResult,
  json?: boolean,
): string {
  if (json) return JSON.stringify(res);
  const verb = res.dryRun ? "would move" : "moved";
  const lines = res.cards.map((c) =>
    c.to === null
      ? `  ${c.slug} (${c.board}) ${c.from} → SKIPPED (${c.reason ?? "unmapped"})`
      : `  ${c.slug} (${c.board}) ${c.from} → ${c.to}`,
  );
  const head =
    `${verb} off-column cards: ${res.dryRun ? res.offColumn - res.unmapped : res.changed} of ` +
    `${res.offColumn} off-column card(s), ${res.unmapped} unmapped` +
    `${res.dryRun ? " — DRY RUN, no writes" : ""}`;
  return res.cards.length ? `${head}\n${lines.join("\n")}` : head;
}
