#!/usr/bin/env bun
/**
 * READ-ONLY probe: which live milestones can no longer be updated AT ALL?
 *
 * `milestoneAddCmd` is the ONLY writer of milestone records — `milestone state`
 * routes through it, and nothing else calls `upsertMilestoneRecord`. It builds
 * the full record by inheriting every field the caller did not supply, and THEN
 * runs `validateLinks` over the whole thing:
 *
 *   proof_card: opts.proofCard ?? existing?.proof_card ?? ""     <- inherited
 *   deps:       opts.deps === undefined ? existing?.deps : …     <- inherited
 *   …
 *   await validateLinks(opts, milestone)   <- re-checks BOTH, every write
 *
 * So if a milestone's proof card is deleted, the milestone becomes UNWRITABLE.
 * Not "cannot enter complete" — unwritable. `milestone state <slug> blocked`,
 * a `--block-reason` note, a title fix: all rejected, and rejected by an error
 * naming a proof card the caller never mentioned. The record is frozen exactly
 * when it most needs to be annotated as broken.
 *
 * That is invisible in `milestone show`, which reports the missing proof card as
 * a warning on a milestone that otherwise reads fine.
 *
 * ## Why this runs the real command instead of re-implementing the check
 *
 * Restating `validateLinks` here would only prove that this file agrees with
 * itself. So the probe calls the PRODUCTION path, `milestoneAddCmd`, against a
 * node whose four mutation methods throw a sentinel. Two outcomes, both
 * conclusive, neither writing anything:
 *
 *   sentinel thrown      -> validation PASSED; the write was allowed. Not frozen.
 *   FkanbanError thrown  -> validation REFUSED a no-op write.       FROZEN.
 *
 * The no-op it attempts is `state = <the milestone's current state>`, so a run
 * against a healthy milestone asks the node to store precisely what is already
 * there — and even that is intercepted before it leaves the process.
 *
 * Writes nothing, deletes nothing. Every mutation path is fused shut.
 *
 *   bun scripts/probe-milestone-frozen-by-inherited-link.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient, FkanbanError, type NodeClient } from "../src/client.ts";
import { listBoards, listMilestones } from "../src/record.ts";
import { milestoneAddCmd } from "../src/commands/milestone.ts";

const WOULD_WRITE = "__probe_would_write__";

/** A client that answers every read and refuses every write. */
function readOnly(node: NodeClient): NodeClient {
  const refuse = async (): Promise<never> => {
    throw new Error(WOULD_WRITE);
  };
  return Object.assign(Object.create(Object.getPrototypeOf(node)), node, {
    createRecord: refuse,
    updateRecord: refuse,
    deleteRecord: refuse,
    updateRecords: refuse,
  });
}

const cfg = readConfig();
const live = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});
const node = readOnly(live);

const boards = await listBoards(live, cfg);
const milestones = await listMilestones(live, cfg, { boards });

type Outcome =
  | { kind: "writable" }
  | { kind: "refused"; code: string; message: string }
  | { kind: "odd"; err: string };

async function attempt(slug: string, state: string): Promise<Outcome> {
  try {
    await milestoneAddCmd({ cfg, node, slug, state });
    return { kind: "odd", err: "completed without reaching a mutation (unexpected)" };
  } catch (err) {
    if (err instanceof Error && err.message === WOULD_WRITE) return { kind: "writable" };
    if (err instanceof FkanbanError) return { kind: "refused", code: err.code, message: err.message };
    return { kind: "odd", err: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Two arms, because one arm cannot tell the two checks apart.
 *
 *   A  target = the milestone's CURRENT state — what "is this record writable
 *      at all?" means. For a `complete` milestone this ALSO re-runs `proofGate`
 *      (a no-op re-assert still counts as entering `complete`), so a refusal
 *      here could come from either check. Ambiguous on purpose, and reported
 *      as such.
 *
 *   B  target = `active` — `proofGate` returns immediately for any target that
 *      is not `proving`/`complete`, and `active` is reachable from every state
 *      in ALLOWED_TRANSITIONS. So a refusal in arm B is `validateLinks`, with
 *      nothing else it could be. This is the arm that sizes the fix, and it is
 *      also the real repair operation: `active` is how you un-complete a
 *      milestone whose evidence turned out to be gone.
 */
const rows: Array<{ slug: string; state: string; a: Outcome; b: Outcome }> = [];
for (const m of milestones) {
  rows.push({ slug: m.slug, state: m.state, a: await attempt(m.slug, m.state), b: await attempt(m.slug, "active") });
}

const count = (pick: (r: (typeof rows)[number]) => Outcome, kind: Outcome["kind"]): number =>
  rows.filter((r) => pick(r).kind === kind).length;

console.log(`\n=== arm A — no-op: re-assert the state it already has ===`);
console.log(`  milestones examined   ${rows.length}`);
console.log(`  WRITABLE              ${count((r) => r.a, "writable")}`);
console.log(`  REFUSED               ${count((r) => r.a, "refused")}   <- refused a write that changes nothing`);
console.log(`  (ambiguous: for a complete milestone this re-runs proofGate as well)`);

console.log(`\n=== arm B — repair move: state = active (proofGate cannot fire) ===`);
console.log(`  WRITABLE              ${count((r) => r.b, "writable")}`);
console.log(`  REFUSED               ${count((r) => r.b, "refused")}   <- attributable to validateLinks ALONE`);

const byCode = new Map<string, number>();
for (const r of rows) if (r.b.kind === "refused") byCode.set(r.b.code, (byCode.get(r.b.code) ?? 0) + 1);
if (byCode.size > 0) {
  console.log(`\n  --- arm B refusal reasons ---`);
  for (const [code, n] of [...byCode.entries()].sort((x, y) => y[1] - x[1])) {
    console.log(`    ${String(n).padStart(3)}  ${code}`);
  }
}

console.log(`\n  --- milestones that cannot even be moved to active ---`);
const stuck = rows.filter((r) => r.b.kind === "refused");
for (const r of stuck.slice(0, 25)) {
  console.log(`    ${r.slug}  [state=${r.state}]`);
  console.log(`        ${(r.b as { message: string }).message}`);
}
if (stuck.length > 25) console.log(`    … and ${stuck.length - 25} more`);

for (const r of rows) {
  if (r.a.kind === "odd") console.log(`\n  UNEXPECTED (A) ${r.slug}: ${r.a.err}`);
  if (r.b.kind === "odd") console.log(`\n  UNEXPECTED (B) ${r.slug}: ${r.b.err}`);
}

console.log(
  `\nverdict: ${stuck.length} of ${rows.length} milestones cannot be moved to \`active\` — ` +
    `the one transition that repairs them — because every write re-validates an ` +
    `inherited link the caller never supplied.`,
);
