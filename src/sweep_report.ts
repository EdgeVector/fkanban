// How a sweep reports the writes it made.
//
// Every repair command in this repo renders one head line with a number in it,
// and the number has been wrong the same way four times: it came from the PLAN
// (the length of a repair list, or a field assigned `apply ? issued : planned`)
// rather than from a counter incremented AT the write. A dry run then announces
// repairs it did not make. The rendered text carries a `— DRY RUN, no writes`
// suffix, which protects a human reading the whole sentence and protects no
// `--json` consumer reading the field — and the fleet reads the field:
// `last-stack-groom-board`'s durable memory recorded "changed=3" for weeks on
// runs that wrote nothing.
//
// The rule, first written down for `archive_done` and rediscovered by `groom`:
//
//   1. count the actions that OCCURRED, never derive them from the ones planned;
//   2. carry the plan in its own field so no consumer loses the signal;
//   3. make the KEY NAME change with the meaning, so a reader who sees only the
//      key cannot mistake a plan for a result (`would_archive=`/`archived=`,
//      `would_change=`/`changed=`, `would_heal=`/`healed=`).
//
// Rule 3 is what this module owns. It lives outside `commands/` because the
// sweeps that need it are peers — `groom.ts` and `board_cards_heal.ts` must not
// import each other to share one ternary.

export type SweepWriteCounts = {
  dryRun: boolean;
  /** Writes ISSUED. Incremented at the write, so a dry run leaves it at 0. */
  applied: number;
  /** Writes an `--apply` run WOULD have issued, in the same units as `applied`. */
  planned: number;
};

/**
 * Render the one count an operator reads as "what did this run do", under the
 * key that says which of the two questions it answers.
 *
 * Takes both key names rather than deriving them from a stem: the English is
 * irregular (`change`/`changed`, `heal`/`healed`) and a stem rule would either
 * mangle one of them or invite a sweep to invent a third spelling.
 */
export function renderSweepWrites(
  keys: { applied: string; planned: string },
  counts: SweepWriteCounts,
): string {
  return counts.dryRun
    ? `${keys.planned}=${counts.planned}`
    : `${keys.applied}=${counts.applied}`;
}
