// A milestone's lifecycle follows its cards: the first card of a `planned`
// milestone that enters `doing` moves the milestone to `active`.
//
// Before this, nothing moved a milestone planned → active. A planned milestone
// whose Kind:pr cards all merged was then skipped by gap-report forever
// ("complete_proof is not legal from state=planned") and counted as open
// coverage (brain `papercut-milestone-complete-proof-skipped-state-planned-20260924`).
//
// Best effort by contract: the card move is the caller's real work and is
// already written when this runs. A failure here is reported as a warning
// (stderr + a result field) and never fails the move or the claim.

import type { NodeClient } from "./client.ts";
import type { Config } from "./config.ts";
import { findMilestone, type Card } from "./record.ts";
import { milestoneAddCmd } from "./commands/milestone.ts";

export type MilestoneActivationOutcome = {
  /** Slug of the milestone this call moved planned → active. */
  milestoneActivated?: string;
  /** Why a planned milestone could not be activated (the card move still stands). */
  milestoneActivationWarning?: string;
};

/**
 * Activate the card's milestone when it is `planned`. `knownState` lets a
 * caller that already read the milestone skip the second point read; pass
 * `undefined` to read it here.
 */
export async function activatePlannedMilestoneForDoing(
  opts: { cfg: Config; node: NodeClient },
  card: Pick<Card, "slug" | "milestone">,
  knownState?: string,
): Promise<MilestoneActivationOutcome> {
  const slug = String(card.milestone ?? "").trim();
  if (!slug) return {};
  try {
    let state = knownState;
    if (state === undefined || state === "") {
      const milestone = await findMilestone(opts.node, opts.cfg, slug);
      if (!milestone) return {};
      state = milestone.state;
    }
    if (state !== "planned") return {};
    await milestoneAddCmd({ cfg: opts.cfg, node: opts.node, slug, state: "active" });
    return { milestoneActivated: slug };
  } catch (err) {
    const warning =
      `card ${card.slug} entered doing but milestone ${slug} could not move planned → active: ` +
      `${err instanceof Error ? err.message : String(err)}. ` +
      `Run \`kanban milestone state ${slug} active\`.`;
    console.error(`kanban: warning: ${warning}`);
    return { milestoneActivationWarning: warning };
  }
}
