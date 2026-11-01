// One owned record per slug. Named keys contain addresses, never payload copies.
import { FkanbanError, type NodeClient, type QueryRow } from "./client.ts";
import { EXTRA_SCHEMAS, UNIQUE_SCHEMAS, type SchemaDefinition } from "./schemas.ts";
import { queryPageSize } from "./query-page-size.ts";

export const MULTI_KEY_MODEL = "multi-key-v1" as const;
export const multiKey = (cfg: { storageModel?: string }): boolean => cfg.storageModel === MULTI_KEY_MODEL;
/** `kanban init` writes MULTI_KEY_MODEL. A config without it pins schemas that this release does not read. */
export const MULTI_KEY_CONFIG_MESSAGE = "This config does not use the multi-key storage model.";
const MULTI_KEY_CONFIG_HINT =
  "Run `kanban init` with a new config path (KANBAN_CONFIG). Init does not replace this config.";
export function requireMultiKey(cfg: { storageModel?: string }): void {
  if (!multiKey(cfg)) throw new FkanbanError({ code: "multi_key_config_required",
    message: MULTI_KEY_CONFIG_MESSAGE, hint: MULTI_KEY_CONFIG_HINT });
}

export function ownedSchemas() {
  return [...UNIQUE_SCHEMAS, ...EXTRA_SCHEMAS].map((entry) => {
    const schema = structuredClone(entry.schema.schema);
    const ordered = (hash: string, state: string): NonNullable<SchemaDefinition["alternate_keys"]>[string] => ({
      hash_field: hash, missing: "reject", range_separator: "#", range_parts: [
        { field: state }, { field: "position", format: { padded_text: { width: 8 } } }, { field: "slug" },
      ],
    });
    if (entry.key === "card") schema.alternate_keys = {
      all: { hash_literal: "all", range_field: "slug" },
      by_board: ordered("board", "column"), by_milestone: { ...ordered("milestone", "column"), missing: "omit", omit_empty_hash: true },
    };
    if (entry.key === "milestone") schema.alternate_keys = { by_board: ordered("board", "state") };
    if (entry.key === "board") schema.alternate_keys = { all: { hash_literal: "all", range_field: "slug" } };
    return { key: entry.key, schema };
  });
}

export type NamedRow = QueryRow & { matched_key: { hash: string; range: string } };
export type NamedPage = { results: NamedRow[]; has_more: boolean; next_cursor?: unknown };

export async function keyPage(
  node: NodeClient, schema: string, name: string,
  filter: unknown, fields: readonly string[], limit = 1000, cursor?: unknown,
): Promise<NamedPage> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new FkanbanError({ code: "multi_key_page_size", message: "The named-key page size must be between 1 and 1000." });
  }
  const response = await node.rawCall("POST", "/api/query", {
    schema_name: schema, key_name: name, filter, fields: [...fields],
    limit: Math.min(limit, queryPageSize(fields.length)), response_format: "values",
    ...(cursor ? { cursor } : {}),
  });
  const root = response.json as { data?: unknown };
  const page = (root?.data ?? root) as NamedPage;
  if (response.status !== 200 || !Array.isArray(page?.results) || typeof page.has_more !== "boolean"
      || page.results.some((row) => !row.key?.hash || !row.matched_key?.hash || typeof row.matched_key.range !== "string")) {
    throw new FkanbanError({ code: "multi_key_read_failed", message: `The ${schema}/${name} read did not return a valid named-key page.` });
  }
  if (page.has_more && !page.next_cursor) throw new FkanbanError({ code: "multi_key_cursor_missing", message: "The named-key page has no continuation." });
  return page;
}

export async function keyRows(
  node: NodeClient, schema: string, name: string,
  filter: unknown, fields: readonly string[], pageSize = 1000,
): Promise<NamedRow[]> {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    throw new FkanbanError({ code: "multi_key_page_size", message: "The named-key page size must be between 1 and 1000." });
  }
  const rows: NamedRow[] = [];
  const boundedPageSize = Math.min(pageSize, queryPageSize(fields.length));
  let cursor: unknown;
  const seen = new Set<string>();
  const maxPages = Math.ceil(1_000_000 / boundedPageSize);
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const page = await keyPage(node, schema, name, filter, fields, boundedPageSize, cursor);
    for (const row of page.results) {
      const id = JSON.stringify(row.key);
      if (seen.has(id)) throw new FkanbanError({ code: "multi_key_duplicate", message: "The named-key pages repeat a primary record." });
      seen.add(id);
      rows.push(row);
    }
    if (!page.has_more) return rows;
    if (JSON.stringify(cursor) === JSON.stringify(page.next_cursor)) throw new FkanbanError({ code: "multi_key_cursor_stalled", message: "The named-key cursor did not advance." });
    cursor = page.next_cursor;
  }
  throw new FkanbanError({ code: "multi_key_read_limit", message: "The named-key read exceeded its page limit." });
}

export function primaryProjection(fields: readonly string[]): string[] {
  return [...new Set(["slug", "board", "column", "position", ...fields.filter((field) => !["sk", "layout"].includes(field))])];
}
