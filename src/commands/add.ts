// `fkanban add <slug>` — create or update a card. Body can come from --body
// or stdin. Column defaults to the board's first column; position appends to
// the end of that column. The whole command is two point reads (board, card)
// plus one write — it never scans the board.

import { FkanbanError, type NodeClient } from "../client.ts";
import { schemaHashFor, type Config } from "../config.ts";
import {
  appendPosition,
  applyDerivedHeader,
  applyHeaderDerivation,
  applyPickupAreaDerivation,
  BLOCK_STATUSES,
  blockedByHint,
  blockedByMessage,
  boardTerminalMap,
  CARD_KINDS,
  cardToFields,
  depStatus,
  deriveStructuredFields,
  emptyStructuredFields,
  ensureColumn,
  findCard,
  forwardDepWarning,
  isBlockStatus,
  isCardKind,
  isDepEnforcedColumn,
  listBoards,
  listCards,
  listCardStatuses,
  normalizeDeps,
  nowIso,
  requireBoard,
  validateSlug,
  withPriorityTag,
  wouldCreateCycle,
  type Card,
  type PriorityTier,
} from "../record.ts";

export type AddOptions = {
  cfg: Config;
  node: NodeClient;
  slug: string;
  title?: string;
  board?: string;
  column?: string;
  assignee?: string;
  tags?: string[];
  // Replace the card's dependency list with these slugs (validated, deduped,
  // self-references dropped). Omit to leave existing deps untouched on update.
  deps?: string[];
  // Set the card's priority tier (P0–P3). Stored as a `p0`..`p3` tag: any
  // existing priority tag is replaced, the rest of the tags are preserved.
  // Omit to leave the card's current priority untouched on update.
  priority?: PriorityTier;
  body?: string;
  // Override the dependency soft-block when placing the card into a working
  // column (doing/review/done). Mirrors `move`'s --force.
  force?: boolean;
  // Structured pickup-decision + reconcile fields. Any omitted on create is
  // auto-derived from the body/tags (deriveStructuredFields); any omitted on
  // update keeps its existing value. See `fkanban-card-structured-fields`.
  repo?: string;
  base?: string;
  kind?: string; // pr|registry|tracker
  blockStatus?: string; // none|needs_human|design_first|deferred
  blockReason?: string;
  northStar?: string;
  prUrl?: string;
  branch?: string;
};

// Reject an invalid --kind / --block-status BEFORE any write, mirroring the
// other usage-error guards (exit 2 vs operational exit 1).
function validateStructuredOpts(opts: AddOptions): void {
  if (opts.kind !== undefined && !isCardKind(opts.kind)) {
    throw new FkanbanError({
      code: "invalid_kind",
      message: `Invalid --kind "${opts.kind}".`,
      hint: `One of: ${CARD_KINDS.join(", ")}.`,
    });
  }
  if (opts.blockStatus !== undefined && !isBlockStatus(opts.blockStatus)) {
    throw new FkanbanError({
      code: "invalid_block_status",
      message: `Invalid --block-status "${opts.blockStatus}".`,
      hint: `One of: ${BLOCK_STATUSES.join(", ")}.`,
    });
  }
}

// Apply explicit --field opts onto a card, then backfill any still-empty
// structured field from the body/tags. Mutates + returns the card.
function applyStructuredFields(card: Card, opts: AddOptions): Card {
  if (opts.repo !== undefined) card.repo = opts.repo;
  if (opts.base !== undefined) card.base = opts.base;
  if (opts.kind !== undefined) card.kind = opts.kind;
  if (opts.blockStatus !== undefined) card.block_status = opts.blockStatus;
  if (opts.blockReason !== undefined) card.block_reason = opts.blockReason;
  if (opts.northStar !== undefined) card.north_star = opts.northStar;
  if (opts.prUrl !== undefined) card.pr_url = opts.prUrl;
  if (opts.branch !== undefined) card.branch = opts.branch;
  return Object.assign(card, deriveStructuredFields(card));
}

// Validate + clean a user-supplied dep list for `slug`, warn (to stderr) on any
// forward/dangling dep — the same heads-up `dep add` emits — and REJECT any new
// edge that would close a dependency cycle, exactly like `dep add` does (#38).
//
// `existingDeps` is the card's current dep list (empty on create). Only deps
// that are NEW relative to it are cycle-checked, so re-`add`ing a card with an
// already-present dep never falsely trips the guard. New edges are checked
// cumulatively (against the board plus the edges this same call already added),
// so `--deps a,b` can't sneak a cycle through across two edges. The check throws
// BEFORE any write, so a rejected cycle leaves no partial card.
async function prepareDeps(
  opts: { cfg: Config; node: NodeClient },
  deps: string[],
  slug: string,
  existingDeps: string[],
): Promise<string[]> {
  const cleaned = normalizeDeps(deps, slug);
  for (const d of cleaned) validateSlug(d);

  // Board graph for the forward-dep warning + the cycle guard. One scan shared
  // by both, mirroring the single `listCardStatuses` call `dep add` makes.
  const all = await listCardStatuses(opts.node, opts.cfg);
  const live = new Set(all.map((c) => c.slug));
  for (const dep of cleaned) {
    if (!live.has(dep)) console.error(forwardDepWarning(dep));
  }

  // Cycle guard: walk the NEW edges (those not already on the card) and reject
  // the first one that would close a loop. Build the graph from `all` but with
  // THIS card's deps replaced by the cleaned list as edges accumulate, so a
  // cumulative cycle (`--deps` adds several edges at once) is caught too.
  const had = new Set(existingDeps);
  // `accrued` is the card's deps as the walk should see them: existing edges
  // plus every NEW edge accepted so far. It's the same array reference the
  // card's node in `graph` holds, so pushing to it is visible to the next
  // `wouldCreateCycle` walk (which re-reads `.deps` each call).
  const accrued: string[] = [...existingDeps];
  const graph: Card[] = all.map((c) => (c.slug === slug ? { ...c, deps: accrued } : c));
  // The card may not exist on the board yet (create): ensure it has a node so
  // its outgoing edges are visible to the walk.
  if (!live.has(slug)) graph.push({ slug, deps: accrued } as Card);
  for (const dep of cleaned) {
    if (had.has(dep)) continue; // already an edge on the card — don't re-check
    const cycle = wouldCreateCycle(graph, slug, dep);
    if (cycle) {
      throw new FkanbanError({
        code: "dep_cycle",
        message: `Adding "${slug}" → "${dep}" would create a dependency cycle.`,
        hint: `Cycle: ${cycle.join(" → ")} (no edge written).`,
      });
    }
    // Edge accepted: fold it into the graph so a later new edge is checked
    // against it too (the cumulative `--deps a,b` case).
    accrued.push(dep);
  }
  return cleaned;
}

// Soft-block: refuse to place a card into a dep-enforced column while any
// dependency is unfinished, unless --force. This mirrors `move`'s guard so
// `add` and `move` read identically — `add` is also a column-changing command
// (create+update), so a blocked card must not slip into a completion column
// through it. The gated set is the default working columns (doing/review/done)
// PLUS the card's own board's terminal column, so a custom board is enforced
// too. Backlog/todo (intake) placements are always ok. Throws BEFORE any write,
// so a blocked add leaves no partial state.
async function enforceDepBlock(
  opts: { cfg: Config; node: NodeClient; force?: boolean },
  slug: string,
  boardSlug: string,
  column: string,
  deps: string[],
): Promise<void> {
  if (opts.force) return;
  // Resolve dep done-ness, and the gating column, against each board's terminal
  // column (deps may live on other boards), falling back to `done` for
  // unresolvable boards.
  const boardTerminal = boardTerminalMap(await listBoards(opts.node, opts.cfg));
  if (!isDepEnforcedColumn(column, boardSlug, boardTerminal)) return;
  const status = depStatus(
    { slug, board: boardSlug, deps } as Card,
    await listCardStatuses(opts.node, opts.cfg),
    boardTerminal,
  );
  if (status.blocked) {
    throw new FkanbanError({
      code: "card_blocked",
      message: blockedByMessage(slug, status.blockedBy),
      hint: blockedByHint(),
    });
  }
}

// Apply an optional `--priority` to a resolved tag list: replace any existing
// p0..p3 tag and leave the rest. A no-op when no priority was requested, so an
// ordinary update never disturbs the card's current priority tag.
function applyPriority(tags: string[], priority?: PriorityTier): string[] {
  return priority ? withPriorityTag(tags, priority) : tags;
}

export type AddResult = { slug: string; action: "created" | "updated"; board: string; column: string };

export async function addCmd(opts: AddOptions): Promise<AddResult> {
  validateSlug(opts.slug);
  validateStructuredOpts(opts);

  const hash = schemaHashFor("card", opts.cfg);
  // Resolve the card BEFORE the board context: on update we must honor the
  // card's existing board when no explicit `--board` is given. An explicit
  // `--board` still moves the card; only the implicit default would be wrong.
  const existing = await findCard(opts.node, opts.cfg, opts.slug);
  const boardSlug = opts.board ?? existing?.board ?? "default";
  const board = await requireBoard(opts.node, opts.cfg, boardSlug);
  const columns = board.columns;
  const targetColumn = existing ? (opts.column ?? existing.column) : (opts.column ?? columns[0] ?? "backlog");
  ensureColumn(targetColumn, columns);

  const now = nowIso();

  if (existing) {
    const updated: Card = {
      ...existing,
      title: opts.title ?? existing.title,
      body: opts.body ?? existing.body,
      board: boardSlug,
      column: targetColumn,
      assignee: opts.assignee ?? existing.assignee,
      tags: applyPriority(opts.tags ?? existing.tags, opts.priority),
      deps: opts.deps ? await prepareDeps(opts, opts.deps, opts.slug, existing.deps) : existing.deps,
      updated_at: now,
    };
    // Auto-derive the pickup Repo:/Base: header from tags (default it when there's
    // no signal, flag a cross-repo conflict as needs_human), so a promoted/edited
    // card never silently strands in `todo`.
    applyDerivedHeader(
      updated,
      applyHeaderDerivation(
        { slug: opts.slug, body: updated.body, tags: updated.tags, title: updated.title, column: updated.column },
        console.error,
        { forcedRepo: opts.repo },
      ),
    );
    // Apply any explicit --field opts, then backfill still-empty structured
    // fields from the body/tags.
    applyStructuredFields(updated, opts);
    applyPickupAreaDerivation(updated, await listCards(opts.node, opts.cfg));
    await enforceDepBlock(opts, opts.slug, boardSlug, updated.column, updated.deps);
    await opts.node.updateRecord({ schemaHash: hash, fields: cardToFields(updated), keyHash: opts.slug });
    return { slug: opts.slug, action: "updated", board: boardSlug, column: updated.column };
  }

  const card: Card = {
    slug: opts.slug,
    title: opts.title ?? opts.slug,
    body: opts.body ?? "",
    board: boardSlug,
    column: targetColumn,
    position: appendPosition(),
    assignee: opts.assignee ?? "",
    tags: applyPriority(opts.tags ?? [], opts.priority),
    deps: opts.deps ? await prepareDeps(opts, opts.deps, opts.slug, []) : [],
    created_at: now,
    updated_at: now,
    ...emptyStructuredFields(),
  };
  applyDerivedHeader(
    card,
    applyHeaderDerivation(
      { slug: card.slug, body: card.body, tags: card.tags, title: card.title, column: card.column },
      console.error,
      { forcedRepo: opts.repo },
    ),
  );
  applyStructuredFields(card, opts);
  applyPickupAreaDerivation(card, await listCards(opts.node, opts.cfg));
  await enforceDepBlock(opts, opts.slug, boardSlug, card.column, card.deps);
  await opts.node.createRecord({ schemaHash: hash, fields: cardToFields(card), keyHash: opts.slug });
  return { slug: opts.slug, action: "created", board: boardSlug, column: targetColumn };
}
