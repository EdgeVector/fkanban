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

export function takeBoardCardJanitor(): BoardCardJanitorTarget[] {
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
        for (const t of chunk) {
          try {
            await node.deleteRecord({
              schemaHash: t.schemaHash,
              keyHash: t.board,
              rangeKey: t.sk,
            });
          } catch {
            // best-effort: stale sk may already be gone
          }
        }
      }
    }
  }
  return attempted;
}
