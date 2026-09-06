// `fkanban rm <slug>` — delete a card (hard erase; no trash / undo).

import { type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
import { FkanbanError } from "../client.ts";
import { checkpointCardCompletion } from "../brain_checkpoint.ts";
import {
  deleteCardRecord,
  ensureBoardRecord,
  findCard,
  findMilestone,
  isMilestoneState,
  listCardStatuses,
  requireCard,
} from "../record.ts";
import { proofHoldReason, readProofCardRefs } from "../proof_card_refs.ts";
import { DEFAULT_BOARD_SLUG, DEFAULT_COLUMNS } from "../schemas.ts";
import { deleteBoardCardRowsBySk, listBoardCardsPartitionSpine } from "../board-cards.ts";
import { type RmResult } from "../format.ts";

export async function rmCmd(opts: {
  cfg: Config;
  node: NodeClient;
  slug: string;
  /** Row-only orphan delete: requires both `board` and `column`. */
  board?: string;
  column?: string;
}): Promise<RmResult> {
  if (opts.board !== undefined || opts.column !== undefined) {
    return await rmOrphanRow(opts);
  }
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

/**
 * Delete a BoardCards row that has no backing Card record — the shape
 * `board-cards-heal` calls a card orphan, targeted by an operator who already
 * knows the exact `board`/`column` (from `kanban list --column <x>`, which
 * shows the ghost, rather than `kanban show`/`kanban rm`, which both refuse it
 * with "No card with slug").
 *
 * `groom board-cards-heal --slug <slug> --apply` is the general-purpose orphan
 * reaper and stays the only path that DISCOVERS an orphan's board/column. This
 * path never discovers one: it takes both coordinates from the caller and does
 * a single column-scoped prefix read, so it costs one query instead of heal's
 * whole-partition scan (N field-lead queries plus a cross-board membership
 * census — minutes on a board carrying hundreds of rows, measured live
 * 2026-09-06 on `mini-cutover-post-flip-soak`). That is a real gap: heal is
 * "the ONLY path that may delete BoardCards rows for orphans" as a matter of
 * WHERE the delete is authorized (an orphan verdict, never a guess), not WHERE
 * it is nominated from — the request still requires proving no Card exists and
 * (for a milestone-state column) no Milestone claims the slug, exactly as heal
 * does, before it deletes anything.
 */
async function rmOrphanRow(opts: {
  cfg: Config;
  node: NodeClient;
  slug: string;
  board?: string;
  column?: string;
}): Promise<RmResult> {
  const board = opts.board?.trim();
  const column = opts.column?.trim();
  if (!board || !column) {
    throw new FkanbanError({
      code: "orphan_row_requires_board_and_column",
      message: "Deleting a BoardCards row by address requires both --board and --column.",
      hint:
        "Find them with `kanban list --column <x> --json` (the column that lists the ghost), " +
        `then retry \`kanban rm ${opts.slug} --board <board> --column <column>\`.`,
    });
  }

  const existing = await findCard(opts.node, opts.cfg, opts.slug);
  if (existing) {
    throw new FkanbanError({
      code: "card_exists",
      message: `Card "${opts.slug}" still exists (column "${existing.column}") — --board/--column is only for a row with no Card.`,
      hint: `Use \`kanban rm ${opts.slug}\` (no --board/--column) to delete the live card.`,
    });
  }

  const spine = await listBoardCardsPartitionSpine(opts.node, opts.cfg, board, { column });
  if (spine === null) {
    throw new FkanbanError({
      code: "board_cards_not_bound",
      message: "BoardCards is not bound in this config; cannot address rows by board/column.",
    });
  }
  const sks = spine.filter((row) => row.slug === opts.slug).map((row) => row.sk);
  if (sks.length === 0) {
    throw new FkanbanError({
      code: "row_not_found",
      message: `No BoardCards row for "${opts.slug}" in ${board}/${column}.`,
      hint: "Nothing to delete — the row may already be gone, or the column is wrong.",
    });
  }

  if (isMilestoneState(column)) {
    const ms = await findMilestone(opts.node, opts.cfg, opts.slug);
    if (ms) {
      throw new FkanbanError({
        code: "row_is_milestone_membership",
        message:
          `"${opts.slug}" in ${board}/${column} is live milestone-state membership, not a card orphan.`,
        hint: "Use `kanban milestone state` to change it instead of deleting the row.",
      });
    }
  }

  const deletedRows = await deleteBoardCardRowsBySk(opts.node, opts.cfg, board, sks);
  return { slug: opts.slug, orphanedDependents: [], rowOnly: true, deletedRows };
}
