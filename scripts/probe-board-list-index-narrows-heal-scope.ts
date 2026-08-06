/**
 * READ-ONLY probe: can the board-list index narrow `milestone-indexes-heal`'s
 * scope without saying so?
 *
 * `listBoards` returns the board-list INDEX row when it exists, falling back to
 * a full Board scan only when the index is absent. `milestone_indexes_heal`
 * iterates exactly that list, so a board the index omits is a board whose
 * BoardMilestones partition is never read, never repaired, and never counted in
 * `rows_examined`. Milestones on it take the `rows === undefined` path and are
 * upserted without comparison — the same unverified-write shape as a failed
 * read, but NOT reported by `index_read_failed_boards`, because no read failed.
 *
 * This measures whether the index and the scan actually disagree on the primary.
 *
 * Writes nothing.
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { listBoards, scanBoardsForReconcile } from "../src/record.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
  opsLabel: "kanban-probe",
});

const viaIndex = await listBoards(node, cfg);
const viaScan = await scanBoardsForReconcile(node, cfg);

const indexSlugs = new Set(viaIndex.map((b) => b.slug));
const scanSlugs = new Set(viaScan.map((b) => b.slug));

const missingFromIndex = [...scanSlugs].filter((s) => !indexSlugs.has(s));
const missingFromScan = [...indexSlugs].filter((s) => !scanSlugs.has(s));

console.log(`listBoards (what heal iterates): ${viaIndex.length} -> ${[...indexSlugs].join(", ")}`);
console.log(`Board full scan:                 ${viaScan.length} -> ${[...scanSlugs].join(", ")}`);
console.log("");
console.log(`In the SCAN but not in listBoards (heal never reads these): ${missingFromIndex.length}`);
if (missingFromIndex.length > 0) console.log(`  ${missingFromIndex.join(", ")}`);
console.log(`In listBoards but not in the scan: ${missingFromScan.length}`);
if (missingFromScan.length > 0) console.log(`  ${missingFromScan.join(", ")}`);
console.log("");
console.log(
  missingFromIndex.length > 0
    ? "REPRODUCES: heal's board list is narrower than truth."
    : "DOES NOT REPRODUCE on this node today: index and scan agree.",
);

// Measured 2026-08-06 on the primary: 2 boards both ways, no disagreement.
// The hazard is real in the code — `listBoards` prefers an index that
// `board-list-heal` exists to repair — and latent in the data. Revisit only if
// `groom board-list-heal` ever reports work to do, or if a board is created
// while the index write fails.

