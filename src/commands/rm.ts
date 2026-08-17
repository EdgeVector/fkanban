// `fkanban rm <slug>` — delete a card (hard erase; no trash / undo).

import { type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
import { FkanbanError } from "../client.ts";
import { checkpointCardCompletion } from "../brain_checkpoint.ts";
import { deleteCardRecord, ensureBoardRecord, listCardStatuses, requireCard } from "../record.ts";
import { proofHoldReason, readProofCardRefs } from "../proof_card_refs.ts";
import { DEFAULT_BOARD_SLUG, DEFAULT_COLUMNS } from "../schemas.ts";

export async function rmCmd(opts: {
  cfg: Config;
  node: NodeClient;
  slug: string;
}): Promise<{ slug: string; orphanedDependents: string[] }> {
  const card = await requireCard(opts.node, opts.cfg, opts.slug);
  // Before deleting, scan live cards for dependents. A deleted dep becomes
  // unresolvable to normal reads, so refuse the delete instead of creating a
  // missing dependency slug that later board readers have to repair.
  const all = await listCardStatuses(opts.node, opts.cfg);
  const dependents = all
    .filter((c) => c.slug !== opts.slug && c.deps.includes(opts.slug))
    .map((c) => c.slug);
  if (dependents.length > 0) {
    throw new FkanbanError({
      code: "card_has_dependents",
      message: `Card "${opts.slug}" is still a dependency of ${dependents.length} live card${dependents.length === 1 ? "" : "s"}.`,
      hint: `Remove or retarget those dependency edges first: ${dependents.join(", ")}`,
    });
  }

  // A card that a milestone names as its proof is EVIDENCE, and deleting it
  // leaves the milestone asserting a `proof_status` whose basis is gone. The
  // dependency hold above would catch this only by coincidence — measured on
  // the live primary 2026-08-03, 0 of 2 surviving proof cards were incidentally
  // protected by being a dep. `listMilestones` throws rather than answering from
  // a wrong list when a partition read fails, so an unverifiable reference
  // refuses the delete instead of permitting it: fail-closed is the only safe
  // direction for a guard whose job is to prevent an irreversible loss.
  const proofRefs = await readProofCardRefs(opts.node, opts.cfg);
  const heldBy = proofHoldReason(proofRefs, opts.slug);
  if (heldBy) {
    throw new FkanbanError({
      code: "card_is_milestone_proof",
      message: `Card "${opts.slug}" is a milestone's proof card — ${heldBy}.`,
      hint:
        `Deleting it would leave the milestone claiming a proof that no longer exists. ` +
        `Re-point the milestone at the replacement card with ` +
        `\`kanban milestone add ${(proofRefs.get(opts.slug) ?? [])[0]} --proof-card <slug>\`, ` +
        `or clear the link with \`--proof-card ""\`, then retry.`,
    });
  }

  if (card.column === "done" || card.done_at) {
    const boardColumns =
      card.board === DEFAULT_BOARD_SLUG && card.column === "done"
        ? [...DEFAULT_COLUMNS]
        : (await ensureBoardRecord(opts.node, opts.cfg, card.board)).columns;
    await checkpointCardCompletion({
      cfg: opts.cfg,
      node: opts.node,
      card,
      boardColumns,
      reason: "delete-backstop",
    });
  }

  await deleteCardRecord(opts, card);
  return { slug: card.slug, orphanedDependents: [] };
}
