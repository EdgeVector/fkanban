/**
 * Which cards are a milestone's proof — i.e. which cards are EVIDENCE.
 *
 * A milestone's `proof_card` is a live reference to a Card slug, and the write
 * side has always treated it as one: `proofGate` refuses to enter
 * `proving`/`complete` unless the card exists, belongs to the milestone, has
 * `kind=validation`, sits in its terminal column, and carries a
 * machine-readable `PROOF: PASS`.
 *
 * The DELETE side knew nothing about it. `rm` refused to delete a card that was
 * a live DEPENDENCY and only that; `groom archive-done` held back a live
 * dependency and only that. So the evidence behind a `proof_status=passing`
 * claim could be deleted by a sweep that had no idea it was deleting evidence,
 * leaving a milestone that reads `complete`/`passing` next to a computed
 * blocker saying its proof is gone — which is what the live board shows for
 * [[papercut-kanban-milestone-proof-passing-with-no-proof-card]].
 *
 * ## The hold covers milestones in EVERY state, deliberately
 *
 * The obvious move is to mirror the dependency hold, which only counts cards in
 * NON-TERMINAL columns — a finished card's dep no longer blocks anything. That
 * reflex is wrong here, and applying it would re-open the exact hole:
 *
 *   a dep matters while the work is UNFINISHED
 *   a proof matters BECAUSE the work is finished
 *
 * A `complete` milestone's proof card is the whole basis of its completion
 * claim, so it is the one that must survive longest, not the first to become
 * collectable. `abandoned` counts too: the milestone still names the card, and
 * a dangling name is the defect either way. State is therefore not consulted
 * at all — see `test/proof-card-delete-hold.test.ts`, which fails if a state
 * filter is reintroduced.
 */
import type { NodeClient } from "./client.ts";
import type { Config } from "./config.ts";
import { listMilestones, type Board, type Milestone } from "./record.ts";

/** card slug -> slugs of the milestones claiming it as proof, in board order. */
export type ProofCardRefs = Map<string, string[]>;

/**
 * Index milestones by the card each one names as proof.
 *
 * Pure: takes the milestones already read by the caller rather than reading
 * them, so the guard costs nothing when the caller has the list in hand and is
 * testable without a node.
 */
export function proofCardRefsFrom(milestones: readonly Milestone[]): ProofCardRefs {
  const refs: ProofCardRefs = new Map();
  for (const m of milestones) {
    const card = (m.proof_card ?? "").trim();
    if (!card) continue;
    const claimants = refs.get(card);
    if (claimants) claimants.push(m.slug);
    else refs.set(card, [m.slug]);
  }
  return refs;
}

/**
 * Read the proof-card references a delete guard must respect.
 *
 * Two "no milestones" cases that must NOT be treated alike:
 *
 *   schema UNREGISTERED — this config has no milestone subsystem at all, so
 *     there are no milestones, so nothing can be claiming a proof card. An
 *     empty map is the CORRECT answer, and returning it keeps `rm` working on
 *     a config predating milestones instead of hard-failing on a schema it
 *     never needed.
 *
 *   read FAILED — `listMilestones` throws rather than answering from a wrong
 *     list (it refuses to substitute the Milestone product scan, which on real
 *     data both misses live milestones and invents unreachable ones). That
 *     throw is propagated deliberately: a guard against irreversible deletion
 *     must fail CLOSED, so an unverifiable reference refuses the delete rather
 *     than permitting it.
 *
 * Collapsing these — catching the throw and returning an empty map — would turn
 * routine node backpressure into silent evidence loss, which is the exact
 * failure this guard exists to prevent.
 */
export async function readProofCardRefs(
  node: NodeClient,
  cfg: Config,
  boards?: Board[],
): Promise<ProofCardRefs> {
  const hash = cfg.schemaHashes?.["milestone"];
  if (!hash || hash.length === 0) return new Map();
  return proofCardRefsFrom(await listMilestones(node, cfg, boards ? { boards } : {}));
}

/** Human-readable "why this card is held back", or null when it is free. */
export function proofHoldReason(refs: ProofCardRefs, slug: string): string | null {
  const claimants = refs.get(slug);
  if (!claimants || claimants.length === 0) return null;
  return claimants.length === 1
    ? `milestone "${claimants[0]}" names this card as its proof`
    : `${claimants.length} milestones name this card as their proof: ${claimants.join(", ")}`;
}
