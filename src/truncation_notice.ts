// A `--json` page that dropped rows must SAY SO on some channel.
//
// History (2026-08-06):
//   1. CLI broad `--json` reads (`list`, `search`) applied an implicit page cap
//      and emitted a bare array — measured 34 of 229 / 20 of 204 with 0 bytes on
//      fd 2, while the human rendering printed "… N more (--all)".
//   2. CR cr-msh8u5wt-2f6e closed the silence on stderr so stdout stayed
//      byte-identical (needed because milestone-driver ran `jq 'length'` on the
//      bare array — against an envelope, `jq length` returns the KEY COUNT and
//      silently degrades).
//   3. This file now owns the structural answer: `{items, total, truncated}`
//      matching `milestone list` / MCP. Consumers of `jq 'length'` must migrate
//      first (or use `--json-array`). See card kanban-json-envelope-total-truncated.
//
// Envelope is the default. `--json-array` restores the bare array and, when the
// implicit cap dropped rows, re-uses the stderr notice so that path is not
// silent either. The envelope path does NOT also warn on stderr — one channel.

export type WarnSink = (message: string) => void;

export type JsonPageEnvelope<K extends string, T> = {
  [P in K]: T[];
} & {
  total: number;
  truncated: boolean;
};

// Scope: the IMPLICIT default cap only. An explicit `--limit N` is the caller
// stating the bound they want, and `--all` removes the cap entirely — neither
// is a surprise, and warning on them would put a line on fd 2 for invocations
// that never had one. The defect measured was the no-flag default.
export function truncationNotice(
  command: string,
  kept: number,
  total: number,
): string | undefined {
  if (!(total > kept)) return undefined;
  const dropped = total - kept;
  return (
    `kanban: ${command} --json returned ${kept} of ${total} cards ` +
    `(${dropped} more) — this page is capped by default. ` +
    `Pass --all for the complete set, or --limit N to choose the bound. ` +
    `Never take a board total from this output.`
  );
}

export function warnIfTruncated(
  command: string,
  kept: number,
  total: number,
  warn: WarnSink,
): void {
  const message = truncationNotice(command, kept, total);
  if (message !== undefined) warn(message);
}

/**
 * Build the completeness envelope shared by list/search/board list/milestone
 * groom `--json` (and already used by milestone list/portfolio).
 *
 * `truncated` is true **iff** rows were dropped (`kept < total`). The
 * `kept === total` boundary — a complete page that happens to sit at the cap —
 * must read `truncated: false`. An off-by-one here false-alarms every full page.
 */
export function jsonPageEnvelope<K extends string, T>(
  key: K,
  items: T[],
  total: number,
): JsonPageEnvelope<K, T> {
  const kept = items.length;
  // Clamp: never claim more kept than total if a caller miscounts.
  const safeTotal = total < kept ? kept : total;
  return {
    [key]: items,
    total: safeTotal,
    truncated: kept < safeTotal,
  } as JsonPageEnvelope<K, T>;
}

/** Serialize either the envelope or the legacy bare array. */
export function renderJsonPage<K extends string, T>(
  key: K,
  items: T[],
  total: number,
  opts: { jsonArray?: boolean } = {},
): string {
  if (opts.jsonArray) {
    return JSON.stringify(items, null, 2);
  }
  return JSON.stringify(jsonPageEnvelope(key, items, total), null, 2);
}
