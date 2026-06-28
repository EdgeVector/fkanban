// `fkanban tag add|rm <slug> <tag...>` — edit one (or a few) labels on a card
// WITHOUT rewriting its whole tag list. This is the incremental counterpart to
// `add --tags a,b,c`, which REPLACES the list wholesale — exactly the
// relationship `dep add`/`dep rm` has to `add --deps`. Modeled byte-for-byte on
// src/commands/dep.ts.

import { FkanbanError, type NodeClient } from "../client.ts";
import { schemaHashFor, type Config } from "../config.ts";
import {
  cardToFields,
  isDepTag,
  nowIso,
  normalizeTags,
  requireCard,
  TOMBSTONE_TAG,
  type Card,
} from "../record.ts";

export type TagResult = { slug: string; tags: string[]; action: "added" | "removed"; tag: string[] };

async function writeTags(
  opts: { cfg: Config; node: NodeClient },
  card: Card,
  tags: string[],
): Promise<void> {
  const hash = schemaHashFor("card", opts.cfg);
  const updated: Card = { ...card, tags, updated_at: nowIso() };
  await opts.node.updateRecord({ schemaHash: hash, fields: cardToFields(updated), keyHash: card.slug });
}

// Reject the reserved tags users must not author by hand: dependency edges live
// in `tags` as `dep:<slug>` (use `dep add`/`dep rm`), and the soft-delete
// tombstone is internal (use `rm`). Letting them through `tag add` would forge a
// dependency / delete a card via a label, which would be surprising.
function rejectReservedTag(tag: string): void {
  if (isDepTag(tag)) {
    throw new FkanbanError({
      code: "reserved_tag",
      message: `"${tag}" is a reserved dependency tag.`,
      hint: "Use `fkanban dep add`/`dep rm` to edit dependency edges.",
    });
  }
  if (tag === TOMBSTONE_TAG) {
    throw new FkanbanError({
      code: "reserved_tag",
      message: `"${tag}" is a reserved internal tag.`,
      hint: "Use `fkanban rm` to delete a card.",
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
  await writeTags(opts, card, tags);
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
  // silently swallowed. Never let the tombstone slip out via a tag edit.
  const drop = new Set(incoming);
  const absent = incoming.filter((t) => !card.tags.includes(t));
  if (absent.length > 0) {
    console.error(`fkanban: warning — card "${opts.slug}" had no tag(s): ${absent.join(", ")} (nothing removed for those).`);
  }
  const tags = card.tags.filter((t) => !drop.has(t) || t === TOMBSTONE_TAG);
  await writeTags(opts, card, tags);
  return { slug: opts.slug, tags, action: "removed", tag: incoming };
}
