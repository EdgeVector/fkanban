// `fkanban dep add|rm <slug> <dep-slug>` — manage one dependency edge on a
// card without rewriting its whole dep list. A card with deps is "blocked"
// until each dep card reaches its board's final column (see record.ts depStatus).

import { FkanbanError, type NodeClient } from "../client.ts";
import { schemaHashFor, type Config } from "../config.ts";
import {
  cardToFields,
  findCard,
  forwardDepWarning,
  listCardStatuses,
  normalizeDeps,
  nowIso,
  validateSlug,
  wouldCreateCycle,
  type Card,
} from "../record.ts";

export type DepResult = { slug: string; dep: string; action: "added" | "removed"; deps: string[] };

async function writeDeps(
  opts: { cfg: Config; node: NodeClient },
  card: Card,
  deps: string[],
): Promise<void> {
  const hash = schemaHashFor("card", opts.cfg);
  const updated: Card = { ...card, deps, updated_at: nowIso() };
  await opts.node.updateRecord({ schemaHash: hash, fields: cardToFields(updated), keyHash: card.slug });
}

export async function depAddCmd(opts: {
  cfg: Config;
  node: NodeClient;
  slug: string;
  dep: string;
}): Promise<DepResult> {
  validateSlug(opts.dep);
  const card = await findCard(opts.node, opts.cfg, opts.slug);
  if (!card) {
    throw new FkanbanError({ code: "card_not_found", message: `No card with slug "${opts.slug}".` });
  }
  if (opts.dep === opts.slug) {
    throw new FkanbanError({ code: "invalid_dep", message: "A card cannot depend on itself." });
  }
  // Warn (don't fail) on a forward/dangling dep — it just never resolves.
  const all = await listCardStatuses(opts.node, opts.cfg);
  if (!all.some((c) => c.slug === opts.dep)) {
    console.error(forwardDepWarning(opts.dep));
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
  await writeDeps(opts, card, deps);
  return { slug: opts.slug, dep: opts.dep, action: "added", deps };
}

export async function depRmCmd(opts: {
  cfg: Config;
  node: NodeClient;
  slug: string;
  dep: string;
}): Promise<DepResult> {
  const card = await findCard(opts.node, opts.cfg, opts.slug);
  if (!card) {
    throw new FkanbanError({ code: "card_not_found", message: `No card with slug "${opts.slug}".` });
  }
  if (!card.deps.includes(opts.dep)) {
    throw new FkanbanError({
      code: "dep_not_found",
      message: `Card "${opts.slug}" does not depend on "${opts.dep}".`,
      hint: card.deps.length > 0 ? `Current deps: ${card.deps.join(", ")}` : "It has no dependencies.",
    });
  }
  const deps = card.deps.filter((d) => d !== opts.dep);
  await writeDeps(opts, card, deps);
  return { slug: opts.slug, dep: opts.dep, action: "removed", deps };
}
