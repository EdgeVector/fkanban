// `fkanban tag add|rm <slug> <tag...>` — edit one (or a few) labels on a card
// WITHOUT rewriting its whole tag list. This is the incremental counterpart to
// `add --tags a,b,c`, which REPLACES the list wholesale — exactly the
// relationship `dep add`/`dep rm` has to `add --deps`. Modeled byte-for-byte on
// src/commands/dep.ts.

import { FkanbanError, type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
import {
  isDoneAtTag,
  normalizeTags,
  requireCard,
  writeCardPatch,
} from "../record.ts";
import type { TagResult } from "../format.ts";

function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((tag, i) => tag === b[i]);
}

// Reject the completion stamp. Move the card to set it.
function rejectReservedTag(tag: string): void {
  if (isDoneAtTag(tag)) {
    throw new FkanbanError({
      code: "reserved_tag",
      message: `"${tag}" is a reserved completion timestamp tag.`,
      hint: "Move the card to the board's final column to set done_at.",
    });
  }
}

export async function tagAddCmd(opts: {
  cfg: Config;
  node: NodeClient;
  slug: string;
  tag: string[];
}): Promise<TagResult> {
  // Normalize/dedupe the incoming tags up front so a blank or duplicate arg is a
  // no-op, and reject the reserved ones before any read/write.
  const incoming = normalizeTags(opts.tag);
  for (const t of incoming) rejectReservedTag(t);
  const card = await requireCard(opts.node, opts.cfg, opts.slug);
  // Union: adding a tag the card already carries is idempotent (no duplicate).
  const tags = normalizeTags([...card.tags, ...incoming]);
  if (sameTags(tags, card.tags)) return { slug: opts.slug, tags, action: "added", tag: incoming };
  await writeCardPatch(opts, card, { tags });
  return { slug: opts.slug, tags, action: "added", tag: incoming };
}

export async function tagRmCmd(opts: {
  cfg: Config;
  node: NodeClient;
  slug: string;
  tag: string[];
}): Promise<TagResult> {
  const incoming = normalizeTags(opts.tag);
  const card = await requireCard(opts.node, opts.cfg, opts.slug);
  // Removing a tag the card doesn't carry is a no-op (matches how `dep rm`'s
  // mirror — `rm` of a missing edge — is non-fatal), but warn so a typo isn't
  // silently swallowed.
  const drop = new Set(incoming);
  const absent = incoming.filter((t) => !card.tags.includes(t));
  if (absent.length > 0) {
    console.error(`fkanban: warning — card "${opts.slug}" had no tag(s): ${absent.join(", ")} (nothing removed for those).`);
  }
  const tags = card.tags.filter((t) => !drop.has(t));
  if (sameTags(tags, card.tags)) return { slug: opts.slug, tags, action: "removed", tag: incoming };
  await writeCardPatch(opts, card, { tags });
  return { slug: opts.slug, tags, action: "removed", tag: incoming };
}
