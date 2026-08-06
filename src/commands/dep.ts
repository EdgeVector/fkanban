// `fkanban dep add|rm <slug> <dep-slug>` — manage one dependency edge on a
// card without rewriting its whole dep list. A card with deps is "blocked"
// until each dep card reaches its board's final column (see record.ts depStatus).

import { FkanbanError, type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
import {
  dependencyBlocks,
  listCardStatuses,
  missingDepError,
  normalizeDeps,
  requireCard,
  validateSlug,
  wouldCreateCycle,
  writeCardPatch,
} from "../record.ts";
import type { DepResult } from "../format.ts";

export async function depAddCmd(opts: {
  cfg: Config;
  node: NodeClient;
  slug: string;
  dep: string;
}): Promise<DepResult> {
  validateSlug(opts.dep);
  const card = await requireCard(opts.node, opts.cfg, opts.slug);
  if (opts.dep === opts.slug) {
    throw new FkanbanError({ code: "invalid_dep", message: "A card cannot depend on itself." });
  }
  const all = await listCardStatuses(opts.node, opts.cfg);
  // Kept as the card, not a boolean: the demote below needs this dep's state,
  // and re-finding it would be a second lookup that could disagree with the
  // existence check.
  const depCard = all.find((c) => c.slug === opts.dep);
  if (!depCard) {
    throw missingDepError(opts.dep);
  }
  // Refuse to close a dependency cycle: if `opts.dep` already (transitively)
  // depends on `opts.slug`, adding `opts.slug → opts.dep` would deadlock every
  // card on the loop (each blocked on the next, none can ever reach `done`).
  const cycle = wouldCreateCycle(all, opts.slug, opts.dep);
  if (cycle) {
    throw new FkanbanError({
      code: "dep_cycle",
      message: `Adding "${opts.slug}" → "${opts.dep}" would create a dependency cycle.`,
      hint: `Cycle: ${cycle.join(" → ")} (no edge written).`,
    });
  }
  const deps = normalizeDeps([...card.deps, opts.dep], opts.slug);
  // Default/todo is the pickup claim lane: unfinished deps belong in backlog.
  // Adding a live dep while the card sits in todo would leave a non-pickupable
  // "ready-looking" card; demote automatically (Tom 2026-07-14).
  //
  // "UNFINISHED" IS THE LOAD-BEARING WORD, and until 2026-08-06 the condition
  // did not contain it — it tested the card's placement only, so adding an edge
  // to an already-`done` dep demoted a card that nothing blocked and nothing
  // would ever promote back (`move` promotes on a dep's TRANSITION into the
  // terminal column; a dep already there never transitions again). The card
  // read as ordinary backlog, never appeared in `blocked-on-dependency`, and so
  // left the pickup queue permanently and invisibly.
  //
  // `dependencyBlocks` is the same predicate `depStatus` applies per edge, not
  // a second copy of the rule: the demote can now only fire for an edge that
  // will in fact be reported as blocking this card.
  const patch: { deps: string[]; column?: string } = { deps };
  if (card.board === "default" && card.column === "todo" && dependencyBlocks(depCard)) {
    patch.column = "backlog";
  }
  await writeCardPatch(opts, card, patch);
  // Report the demote, not just the edge. `patch.column` is the field this
  // write actually changed, so the result is derived from it rather than
  // re-deciding the condition — the two cannot disagree about whether the card
  // moved. Built AFTER the write: an echoed transition must describe a write
  // that happened, and `writeCardPatch` throws when the node refuses.
  return {
    slug: opts.slug,
    dep: opts.dep,
    action: "added",
    deps,
    ...(patch.column !== undefined ? { demoted: { from: card.column, to: patch.column } } : {}),
  };
}

export async function depRmCmd(opts: {
  cfg: Config;
  node: NodeClient;
  slug: string;
  dep: string;
}): Promise<DepResult> {
  const card = await requireCard(opts.node, opts.cfg, opts.slug);
  if (!card.deps.includes(opts.dep)) {
    throw new FkanbanError({
      code: "dep_not_found",
      message: `Card "${opts.slug}" does not depend on "${opts.dep}".`,
      hint: card.deps.length > 0 ? `Current deps: ${card.deps.join(", ")}` : "It has no dependencies.",
    });
  }
  const deps = card.deps.filter((d) => d !== opts.dep);
  await writeCardPatch(opts, card, { deps });
  return { slug: opts.slug, dep: opts.dep, action: "removed", deps };
}
