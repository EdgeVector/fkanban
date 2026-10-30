import { isTombstoned, WRITE_PROBE_SLUG } from "./record.ts";
// Keep the existing numeric-position window rule on one named column key.
import type { NodeClient } from "./client.ts";
import type { Config } from "./config.ts";
import { keyRows } from "./multi-key.ts";
import { capComplete, headCardFrom, headKeyId, type HeadAtom, type HeadKey } from "./column-window.ts";

export async function namedColumnHeads(node: NodeClient, cfg: Config, keys: readonly HeadKey[]): Promise<Map<string, HeadAtom>> {
  const fields = ["slug", "title", "column", "position", "assignee", "tags", "deps", "kind", "milestone", "created_at"];
  const entries = await Promise.all(keys.map(async (key) => {
    const rows = await keyRows(node, cfg.schemaHashes.card!, "by_board", { HashRangePrefix: { hash: key.board, prefix: `${key.column}#` } }, fields);
    const cards = rows.filter((row)=>row.key.hash!==WRITE_PROBE_SLUG && !isTombstoned(Array.isArray(row.fields.tags)?row.fields.tags:[])).map((row) => headCardFrom({
      slug: String(row.key.hash), column: String(row.fields.column), position: String(row.fields.position),
      title: String(row.fields.title ?? ""), assignee: String(row.fields.assignee ?? ""),
      tags: Array.isArray(row.fields.tags) ? row.fields.tags : [], deps: Array.isArray(row.fields.deps) ? row.fields.deps : [],
      kind: String(row.fields.kind ?? ""), milestone: String(row.fields.milestone ?? ""), created_at: String(row.fields.created_at ?? ""),
    }));
    return [headKeyId(key.board, key.column), capComplete(cards,key.column)] as const;
  }));
  return new Map(entries);
}
