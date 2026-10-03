/**
 * Janitor queue for BoardCards membership deletes.
 *
 * Create/update requests must not contain Purge/Delete. Previous sort-keys and
 * orphan rows enqueue here; a later sweeper request issues the deletes.
 * Duplicate rows may be visible for one sweeper interval — last writer wins.
 *
 * Compliance erasure (caller-issued Purge) is a different request and is not
 * this queue.
 */
import type { NodeClient } from "./client.ts";

export type BoardCardJanitorTarget = {
  schemaHash: string;
  board: string;
  sk: string;
};

const queue: BoardCardJanitorTarget[] = [];

/** Matches `BOARD_CARDS_WRITE_BATCH` in board-cards.ts (avoid a cycle). */
const JANITOR_DELETE_BATCH = 48;

export function enqueueBoardCardJanitor(targets: readonly BoardCardJanitorTarget[]): void {
  for (const t of targets) {
    if (!t.schemaHash || !t.board || !t.sk) continue;
    queue.push({ schemaHash: t.schemaHash, board: t.board, sk: t.sk });
  }
}

export function peekBoardCardJanitor(): readonly BoardCardJanitorTarget[] {
  return queue.slice();
}

function takeBoardCardJanitor(): BoardCardJanitorTarget[] {
  return queue.splice(0, queue.length);
}

export function resetBoardCardJanitorForTests(): void {
  queue.splice(0, queue.length);
}

/**
 * Issue the queued deletes as their own mutation request(s).
 *
 * This is the sweeper: it is never mixed into a create/update batch.
 * Returns how many sks were submitted.
 */
export async function sweepBoardCardJanitor(node: NodeClient): Promise<number> {
  const targets = takeBoardCardJanitor();
  if (targets.length === 0) return 0;

  const byHashBoard = new Map<string, BoardCardJanitorTarget[]>();
  for (const t of targets) {
    const key = `${t.schemaHash}\0${t.board}`;
    const group = byHashBoard.get(key);
    if (group) group.push(t);
    else byHashBoard.set(key, [t]);
  }

  let attempted = 0;
  const batch = node.deleteRecords?.bind(node);
  for (const group of byHashBoard.values()) {
    const seen = new Set<string>();
    const unique = group.filter((t) => {
      if (seen.has(t.sk)) return false;
      seen.add(t.sk);
      return true;
    });
    attempted += unique.length;
    for (let i = 0; i < unique.length; i += JANITOR_DELETE_BATCH) {
      const chunk = unique.slice(i, i + JANITOR_DELETE_BATCH);
      try {
        if (!batch) throw new Error("node client exposes no batch delete");
        await batch(
          chunk.map((t) => ({
            schemaHash: t.schemaHash,
            keyHash: t.board,
            rangeKey: t.sk,
          })),
        );
      } catch {
        for (const t of chunk) await deleteOneWithRetry(node, t);
      }
    }
  }
  return attempted;
}

/**
 * Pauses before each re-send of a failed per-row delete.
 *
 * This catch used to be empty ("best-effort: stale sk may already be gone").
 * A delete of an absent row succeeds, so a THROWN delete is not that case — on
 * the live primary it was a `service_timeout` under load, and the swallowed
 * failure left the source row in its old column for good: the queue is
 * process-local, so nothing re-tried it after the CLI exited. Measured
 * 2026-10-02T23:20Z: a claim moved `logical-resident-set-point-admission` to
 * doing while `kanban list --column todo` kept listing it (papercut
 * papercut-fkanban-janitor-swallows-boardcards-delete-failure-20261003).
 *
 * A delete is idempotent, so re-sending one after a deadline expiry cannot
 * double-apply — unlike the generic write path in client.ts, which must not
 * re-send a mutation it cannot prove was refused.
 */
let janitorRetryDelaysMs: readonly number[] = [500, 2000];

export function setBoardCardJanitorRetryDelaysForTests(delays: readonly number[]): void {
  janitorRetryDelaysMs = delays;
}

async function deleteOneWithRetry(node: NodeClient, t: BoardCardJanitorTarget): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await node.deleteRecord({
        schemaHash: t.schemaHash,
        keyHash: t.board,
        rangeKey: t.sk,
      });
      return true;
    } catch (err) {
      const wait = janitorRetryDelaysMs[attempt];
      if (wait === undefined) {
        // Loud, not silent: the row stays listed in its old column until
        // `kanban groom board-cards-heal` reaps it, and an operator reading
        // a wrong list needs to know why.
        console.error(
          `kanban: BoardCards delete failed for ${t.board} ${t.sk} after ` +
            `${attempt + 1} attempt(s): ${err instanceof Error ? err.message : String(err)}. ` +
            "The row stays listed until `kanban groom board-cards-heal` runs.",
        );
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}
