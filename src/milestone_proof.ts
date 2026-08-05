/**
 * Is a milestone's terminal proof STILL good?
 *
 * `proofGate` answers that question once — at the instant a milestone
 * transitions into `proving`/`complete` — and the answer is then written down as
 * `proof_status`. Every input the gate consulted is mutable: the proof card can
 * be deleted, archived, moved out of its terminal column, unlinked from the
 * milestone, or have its `PROOF: PASS` line edited away. Nothing re-runs the
 * gate. So `proof_status` is not a fact about the evidence; it is a fact about
 * what the evidence looked like at one past instant, and the two drift apart
 * silently.
 *
 * Measured on the live board 2026-08-04: of the 22 milestones naming a proof
 * card, **19 name one that does not exist**, and 14 of those still read
 * `state=complete` + `proof_status=passing`. `milestone portfolio`, `detail` and
 * `groom` all recomputed the truth and reported it — but only into a prose
 * `warnings[]` array, while `proof_status` kept saying `passing` right next to
 * it. `milestone show` (and the `fkanban_milestone_show` MCP tool) did not
 * recompute at all, so the cheapest single-milestone read was also the only one
 * with nothing to contradict the stale claim. `milestone-driver.md` gates
 * completion on `state=complete` and `proof_status=passing` and reads neither
 * `warnings[]` nor `portfolio`.
 *
 * This module promotes the gate's evidence test from a one-shot transition check
 * to a value every read path can return: a derived `proof_verdict` that degrades
 * a `passing` claim to `unproven` the moment its evidence stops holding.
 *
 * ## Derived, never stored — and `proof_status` is left alone
 *
 * The obvious alternative is to heal `proof_status` back to `pending` when the
 * evidence goes. That is wrong twice over. A read path that rewrites the record
 * it was asked to display is not a read; and `proof_status` is an OPERATOR
 * assertion, set explicitly by `--proof-status`, so overwriting it destroys the
 * record of what was claimed — which is the only thing that makes a dangling
 * proof diagnosable after the fact. The stored claim and the live verdict are
 * different facts and both are worth having. They are reported side by side.
 *
 * ## `kind` is deliberately NOT checked here
 *
 * `proofGate` additionally requires `kind=validation`. This function does not,
 * and the omission is load-bearing rather than an oversight: `PROOF_CARD_FIELDS`
 * does not project `kind`, because LastDB returns a row only when EVERY
 * projected field has an atom on it, so widening the projection to fetch `kind`
 * would make a card merely missing that one field read as ABSENT — turning a
 * healthy proof into a false `missing-proof-card`. A read-time integrity check
 * that invents failures is worse than one with a stated blind spot.
 *
 * It is also the right cut on the merits. `kind=validation` is a POLICY property
 * — it keeps `pickup` from handing the proof card out as implementation work —
 * not evidence that the proof passed. Every dimension this function does check
 * (the card exists, belongs to this milestone, reached its terminal column,
 * carries machine-readable PASS) is evidence. `test/milestone-proof-verdict.test.ts`
 * pins the correspondence to `proofGate` dimension by dimension, and asserts
 * this exclusion explicitly so a future widening has to argue with a test.
 */
import { doneWhenPredicate } from "./pickup.ts";
import { TERMINAL_COLUMN, type Card, type Milestone } from "./record.ts";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

/**
 * The live answer to "is this milestone proven?".
 *
 * Four values mirror the stored `proof_status` verbatim; `unproven` is the one
 * that cannot be stored. It means exactly: the operator asserted `passing`, and
 * the evidence behind that assertion does not currently hold.
 */
export type MilestoneProofVerdict = "pending" | "passing" | "failing" | "not_required" | "unproven";

/**
 * Why the verdict is what it is — machine-readable, and matching the existing
 * `MilestoneWarning` codes where one already covers the same condition so a
 * consumer can join the two without a translation table.
 */
export type MilestoneProofVerdictReason =
  /** Evidence re-checked and holds. */
  | "evidence-present"
  /** `not_required` — this milestone never rested on a proof card. */
  | "not-required"
  /** `pending`/`failing` — nothing is being claimed, so nothing can be stale. */
  | "not-claimed"
  /** Claimed passing with no proof card named at all. */
  | "no-proof-card"
  /** The named card does not exist. */
  | "missing-proof-card"
  /** The named card exists but a wide read cannot see it (sparse row). */
  | "unreadable-proof-card"
  /** The named card exists but is not linked to this milestone/board. */
  | "proof-card-mismatch"
  /** The named card is linked but is not in its terminal column. */
  | "proof-not-terminal"
  /** The named card is terminal but carries no machine-readable PASS. */
  | "no-pass-evidence";

export type MilestoneProofVerdictResult = {
  verdict: MilestoneProofVerdict;
  reason: MilestoneProofVerdictReason;
};

/** The subset of a milestone the verdict reads — so callers can pass a row. */
export type ProofVerdictMilestone = Pick<Milestone, "slug" | "board" | "proof_card" | "proof_status">;

/**
 * Re-run the evidence half of `proofGate` against the CURRENT proof card.
 *
 * Pure with respect to the node: the caller supplies the proof card it already
 * read (`findProofCard`), so the reconcile and portfolio paths pay nothing extra
 * and the function is testable without a node. It is not pure with respect to
 * the filesystem — `DONE-WHEN: file … matches /…/` evidence is re-evaluated by
 * reading that file, exactly as the gate did. That is the point: a proof report
 * that has since been deleted is no longer evidence.
 *
 * `proofCardSparse` distinguishes "the card is gone" from "the card is there but
 * a wide read dropped it". Both degrade the verdict — an unverifiable proof is
 * not a proof — but they need different reasons, because the second sends the
 * operator to `board-cards-heal` and the first to recreate the card. Collapsing
 * them would send half of them hunting for a card sitting right in front of them.
 */
export function milestoneProofVerdict(
  milestone: ProofVerdictMilestone,
  proofCard: Card | null,
  proofCardSparse = false,
): MilestoneProofVerdictResult {
  if (milestone.proof_status === "not_required") return { verdict: "not_required", reason: "not-required" };
  // `pending` and `failing` assert nothing, so there is nothing to re-verify —
  // and a milestone whose proof legitimately has not run yet must NOT be
  // reported as `unproven`, which is a defect state. Passing them through
  // unchanged keeps `unproven` meaning one thing only.
  if (milestone.proof_status !== "passing") {
    return { verdict: milestone.proof_status as MilestoneProofVerdict, reason: "not-claimed" };
  }
  if (!milestone.proof_card) return { verdict: "unproven", reason: "no-proof-card" };
  if (!proofCard) {
    return { verdict: "unproven", reason: proofCardSparse ? "unreadable-proof-card" : "missing-proof-card" };
  }
  if (proofCard.board !== milestone.board || proofCard.milestone !== milestone.slug) {
    return { verdict: "unproven", reason: "proof-card-mismatch" };
  }
  if (proofCard.column !== TERMINAL_COLUMN) return { verdict: "unproven", reason: "proof-not-terminal" };
  if (!hasPassingProofEvidence(proofCard.body)) return { verdict: "unproven", reason: "no-pass-evidence" };
  return { verdict: "passing", reason: "evidence-present" };
}

/** One line naming the stale claim, or null when the verdict matches the claim. */
export function proofVerdictNote(milestone: ProofVerdictMilestone, result: MilestoneProofVerdictResult): string | null {
  if (result.verdict !== "unproven") return null;
  return `proof verdict: unproven (${result.reason}) — recorded proof_status "${milestone.proof_status}" is not currently supported by evidence`;
}

/**
 * Terminal proof evidence for milestone completion.
 *
 * Accepts either:
 * - an exact body line `PROOF: PASS` / `RESULT: PASS`, or
 * - a satisfied `DONE-WHEN: file <path> matches /regex/` when the file exists
 *   and the first line (or full content) matches (covers PASS / PASS-OFFLINE
 *   North Star proof reports without requiring a second PROOF: line).
 */
export function hasPassingProofEvidence(body: string): boolean {
  if (/^[ \t]*(?:PROOF|RESULT):[ \t]*PASS[ \t]*$/im.test(body)) return true;
  return doneWhenFileProofSatisfied(body);
}

function expandProofPath(path: string): string {
  if (path.startsWith("~/")) return `${homedir()}${path.slice(1)}`;
  if (path.startsWith("$HOME/")) return `${homedir()}${path.slice(5)}`;
  if (path.startsWith("${HOME}/")) return `${homedir()}${path.slice(7)}`;
  return path;
}

/** Evaluate `DONE-WHEN: file <path> matches /regex/` as milestone proof evidence. */
export function doneWhenFileProofSatisfied(body: string): boolean {
  const predicate = doneWhenPredicate(body);
  const match = predicate.match(/^file\s+(\S+)\s+matches\s+\/(.+)\/$/);
  if (!match) return false;
  const filePath = expandProofPath(match[1]!);
  const regexSrc = match[2]!;
  if (!existsSync(filePath)) return false;
  try {
    const content = readFileSync(filePath, "utf8");
    const re = new RegExp(regexSrc, "m");
    const firstLine = content.split(/\r?\n/, 1)[0] ?? "";
    return re.test(firstLine) || re.test(content);
  } catch {
    return false;
  }
}
