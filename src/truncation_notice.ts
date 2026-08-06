// A `--json` page that dropped rows must SAY SO on some channel.
//
// The CLI's broad `--json` reads (`list`, `search`) apply an implicit page cap
// for token economy — the same reason the MCP tools cap. The MCP tools report
// `total`/`truncated` beside the array, so their cap is never silent. The CLI
// emitted a bare array and nothing else: measured 2026-08-06 on the live
// primary, `kanban list --board default --json` returned 34 of 229 rows and
// `kanban search "kanban" --json` returned 20 of 204, both with 0 bytes on fd 2
// — while the SAME invocations' human rendering prints "… N more (--all)".
// See papercut-kanban-list-json-silently-caps-while-the-human-line-says-32-more.
//
// WHY STDERR AND NOT AN ENVELOPE. The structurally better answer is the
// `{items, total, truncated}` envelope `milestone list`/`portfolio` already
// carry. It is a compat break on public output, and the consumer sweep run
// before this change found the break is not theoretical: routine
// `milestone-driver` reads `jq 'length'` off three `list --json` call sites to
// gate milestone driving. Against an envelope, `jq length` does not error — it
// returns the KEY COUNT (3) — so every one of those gates would silently read
// "3 cards" forever. That is a worse failure than the one being fixed, so the
// envelope needs its consumers migrated first (carded), and the silence gets
// closed now on a channel that costs no stdout bytes.
//
// stdout stays byte-identical, so every existing `jq '.[]'` / `jq length`
// consumer is untouched, while agents (whose tool harness captures fd 2) and
// humans both see the undercount named.

export type WarnSink = (message: string) => void;

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
