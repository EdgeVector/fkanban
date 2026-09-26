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
 * does not project `kind`. Under HASH-ELSE-LEAD (Card hash = `slug`) a sparse
 * row missing only `kind` still returns from a wide read — so this is no longer
 * a projection-drop dodge — but keeping the proof projection narrow still saves
 * latency (measured ~120ms vs ~236ms wide) and avoids inventing a policy check
 * this verdict deliberately does not own. A read-time integrity check that
 * invents failures is worse than one with a stated blind spot.
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
 * One proof verdict parser for every fkanban read of proof evidence.
 *
 * The rules match `_proof_verdict()` in last-stack
 * `bin/last-stack-milestone-driver-snapshot` exactly, so the driver and the
 * board can never disagree about one proof card body:
 *
 * - A verdict line is `PROOF:` or `RESULT:` (case-insensitive) with an
 *   optional `[tag]`, e.g. `PROOF[failed-isolated-copy-contract]: ...`.
 * - A tag that starts with `fail` or `reopened`, or contains `unmet`, is FAIL.
 *   A tag that starts with `pass` is PASS. A classifying tag wins over the word.
 * - Otherwise the first word after the colon decides, with surrounding
 *   punctuation stripped: `fail`/`failed`/`fails`/`failure`/`failing` is FAIL,
 *   `pass`/`passed`/`passes`/`passing` is PASS.
 * - A line that states neither (`PROOF: fix-card filing failed`) is skipped.
 * - The LAST verdict line wins: a later FAIL withdraws an earlier PASS, and a
 *   later PASS supersedes an earlier FAIL.
 *
 * The old test accepted only an exact `PROOF: PASS` line, so the live
 * validate-lane shape `PROOF: passed — ...` never counted, and an earlier
 * exact PASS kept counting after a later FAIL.
 */
export type ProofLineVerdict = "pass" | "fail";

const PROOF_LINE_RE = /^[ \t]*(?:PROOF|RESULT)(?:\[([^\]\n]*)\])?:[ \t]*(\S*)/gim;
const FAIL_TAG_RE = /^(?:fail|reopened)|unmet/i;
const PASS_TAG_RE = /^pass/i;
const FAIL_WORD_RE = /^fail(?:ed|s|ure|ing)?$/i;
const PASS_WORD_RE = /^pass(?:ed|es|ing)?$/i;
// Python `str.strip('.,;:!-\u2014\u2013')` — both ends, this character set only.
const WORD_EDGE_RE = /^[.,;:!\-\u2014\u2013]+|[.,;:!\-\u2014\u2013]+$/g;

/** `pass`, `fail`, or null for one PROOF/RESULT line's tag and first word. */
export function proofLineVerdict(tag: string | undefined, word: string | undefined): ProofLineVerdict | null {
  const t = (tag ?? "").trim();
  if (t && FAIL_TAG_RE.test(t)) return "fail";
  if (t && PASS_TAG_RE.test(t)) return "pass";
  const w = (word ?? "").trim().replace(WORD_EDGE_RE, "");
  if (FAIL_WORD_RE.test(w)) return "fail";
  if (PASS_WORD_RE.test(w)) return "pass";
  return null;
}

/** The LAST PROOF/RESULT verdict in a proof card body, or null when no line states one. */
export function proofVerdict(body: string | null | undefined): ProofLineVerdict | null {
  if (typeof body !== "string") return null;
  let verdict: ProofLineVerdict | null = null;
  for (const match of body.matchAll(PROOF_LINE_RE)) {
    const line = proofLineVerdict(match[1], match[2]);
    if (line) verdict = line;
  }
  return verdict;
}

/**
 * Terminal proof evidence for milestone completion.
 *
 * - The LAST PROOF/RESULT verdict line decides ({@link proofVerdict}): PASS is
 *   evidence, FAIL is not — even when an earlier line said PASS.
 * - With no verdict line at all, a satisfied `DONE-WHEN: file <path> matches
 *   /regex/` (the file exists and its first line or full content matches) is
 *   evidence. This covers PASS / PASS-OFFLINE North Star proof reports that
 *   carry no PROOF: line.
 */
export function hasPassingProofEvidence(body: string): boolean {
  const verdict = proofVerdict(body);
  if (verdict === "pass") return true;
  if (verdict === "fail") return false;
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
