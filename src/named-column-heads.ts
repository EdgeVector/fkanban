// A list window is a bounded prefix of the primary Card schema's ordered key.
import type { NodeClient } from "./client.ts";
import type { Config } from "./config.ts";
import { keyPage } from "./multi-key.ts";
import { headCardFrom, headKeyId, LIST_HEAD_CAP, type HeadAtom, type HeadKey } from "./list-head.ts";

export async function namedColumnHeads(node: NodeClient, cfg: Config, keys: readonly HeadKey[]): Promise<Map<string, HeadAtom>> {
  const fields = ["slug", "title", "column", "position", "assignee", "tags", "deps", "kind", "milestone", "created_at"];
  const entries = await Promise.all(keys.map(async (key) => {
    const page = await keyPage(node, cfg, "card", "by_board", { HashRangePrefix: { hash: key.board, prefix: `${key.column}#` } }, fields, LIST_HEAD_CAP);
    const cards = page.results.map((row) => headCardFrom({
      slug: String(row.key.hash), board: key.board, column: String(row.fields.column), position: String(row.fields.position),
      title: String(row.fields.title ?? ""), assignee: String(row.fields.assignee ?? ""),
      tags: Array.isArray(row.fields.tags) ? row.fields.tags : [], deps: Array.isArray(row.fields.deps) ? row.fields.deps : [],
      kind: String(row.fields.kind ?? ""), milestone: String(row.fields.milestone ?? ""), created_at: String(row.fields.created_at ?? ""),
    }));
    return [headKeyId(key.board, key.column), { cards, partial: page.has_more }] as const;
  }));
  return new Map(entries);
}
