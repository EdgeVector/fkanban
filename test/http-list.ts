/**
 * Shared LastDB GET /api/list envelope for HTTP fixtures.
 *
 * After the admin-scan cutover, `newNodeClient.listRecordKeys` always hits this
 * route. Fixtures that only modelled `/api/query` must answer it or doctor /
 * write-probe paths fail with HTTP 500 `unexpected_path`.
 */

export function apiListEnvelope(
  schema: string,
  keys: Array<{ hash: string; range?: string | null }> = [],
): { list: { schema: string; keys: Array<{ hash: string; range: string | null }>; has_more: boolean; next_cursor: string | null; truncated: boolean } } {
  return {
    list: {
      schema,
      keys: keys.map((key) => ({ hash: key.hash, range: key.range ?? null })),
      has_more: false,
      next_cursor: null,
      truncated: false,
    },
  };
}

/** Unix-socket `req.url` is often a path (`/api/list?schema=…`), not an absolute URL. */
export function requestUrl(req: Request): URL {
  return new URL(req.url, "http://localhost");
}

export function handleApiList(
  url: URL,
  keys: Array<{ hash: string; range?: string | null }> = [],
): Response {
  return Response.json(apiListEnvelope(url.searchParams.get("schema") ?? "", keys));
}

/** Keys stored as `${schema}::${hash}` (the common HTTP fixture shape). */
export function keysFromPrefixedStore(
  store: Map<string, unknown>,
  schema: string,
): Array<{ hash: string; range: string | null }> {
  const prefix = `${schema}::`;
  return [...store.keys()]
    .filter((key) => key.startsWith(prefix))
    .map((key) => ({ hash: key.slice(prefix.length), range: null }));
}

export function handleApiListFromPrefixedStore(
  url: URL,
  store: Map<string, unknown>,
): Response {
  const schema = url.searchParams.get("schema") ?? "";
  return handleApiList(url, keysFromPrefixedStore(store, schema));
}
