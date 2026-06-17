// `fkanban add <slug>` — create or update a card. Body can come from --body
// or stdin. Column defaults to the board's first column; position appends to
// the end of that column. The whole command is two point reads (board, card)
// plus one write — it never scans the board.

import { FkanbanError, type NodeClient } from "../client.ts";
import { schemaHashFor, type Config } from "../config.ts";
import {
  appendPosition,
  cardToFields,
  ensureColumn,
  findCard,
  forwardDepWarning,
  listCardStatuses,
  normalizeDeps,
  nowIso,
  requireBoard,
  validateSlug,
  wouldCreateCycle,
  type Card,
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
  body?: string;
};

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

export type AddResult = { slug: string; action: "created" | "updated"; board: string; column: string };

export async function addCmd(opts: AddOptions): Promise<AddResult> {
  validateSlug(opts.slug);

  const hash = schemaHashFor("card", opts.cfg);
  // Resolve the card BEFORE the board context: on update we must honor the
  // card's existing board when no explicit `--board` is given. An explicit
  // `--board` still moves the card; only the implicit default would be wrong.
  const existing = await findCard(opts.node, opts.cfg, opts.slug);
  const boardSlug = opts.board ?? existing?.board ?? "default";
  const board = await requireBoard(opts.node, opts.cfg, boardSlug);
  const columns = board.columns;
  const column = opts.column ?? columns[0] ?? "backlog";
  ensureColumn(column, columns);

  const now = nowIso();

  if (existing) {
    const updated: Card = {
      ...existing,
      title: opts.title ?? existing.title,
      body: opts.body ?? existing.body,
      board: boardSlug,
      column: opts.column ?? existing.column,
      assignee: opts.assignee ?? existing.assignee,
      tags: opts.tags ?? existing.tags,
      deps: opts.deps ? await prepareDeps(opts, opts.deps, opts.slug, existing.deps) : existing.deps,
      updated_at: now,
    };
    if (opts.column) ensureColumn(updated.column, columns);
    await opts.node.updateRecord({ schemaHash: hash, fields: cardToFields(updated), keyHash: opts.slug });
    return { slug: opts.slug, action: "updated", board: boardSlug, column: updated.column };
  }

  const card: Card = {
    slug: opts.slug,
    title: opts.title ?? opts.slug,
    body: opts.body ?? "",
    board: boardSlug,
    column,
    position: appendPosition(),
    assignee: opts.assignee ?? "",
    tags: opts.tags ?? [],
    deps: opts.deps ? await prepareDeps(opts, opts.deps, opts.slug, []) : [],
    created_at: now,
    updated_at: now,
  };
  await opts.node.createRecord({ schemaHash: hash, fields: cardToFields(card), keyHash: opts.slug });
  return { slug: opts.slug, action: "created", board: boardSlug, column };
}
