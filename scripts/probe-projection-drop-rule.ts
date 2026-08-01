#!/usr/bin/env bun
/**
 * Is the projection rule this codebase reasons from actually true?
 *
 * Four separate design decisions in `src/` are justified by one sentence:
 *
 *   "LastDB returns a row only when EVERY projected field has an atom on it."
 *
 * It licenses `BOARD_CARDS_SPINE_FIELDS` ("asking for 6 fields loses fewer rows
 * than asking for 24"), `listBoardCardsPartitionSpine` ("the drop-free read"),
 * `readWholeBoardCardRow` (which treats a null return as "row is not whole" and
 * escalates a narrow write to a wide one), and every "narrowing is strictly
 * less droppable" comment.
 *
 * `BoardMilestones` is a standing experiment against that rule, and nobody has
 * read the result:
 *
 *   - `boardMilestoneFieldsFromMilestone` DELIBERATELY omits `completed_at`
 *     from the write map (board-milestones.ts) — so no row this app wrote has a
 *     `completed_at` atom;
 *   - `BOARD_MILESTONES_FIELDS` INCLUDES `completed_at`;
 *   - `listBoardMilestonesPartition` projects `[...BOARD_MILESTONES_FIELDS]`.
 *
 * If the rule holds as stated, that read must return ZERO rows. It does not —
 * the portfolio works. So either the rule is narrower than stated, or something
 * gives `completed_at` an atom. Which one it is decides whether four load-
 * bearing comments are true.
 *
 * Read-only: queries only. Writes nothing, deletes nothing.
 *
 *   bun scripts/probe-projection-drop-rule.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import {
  BOARD_MILESTONES_FIELDS,
  MILESTONE_CARDS_FIELDS,
  MILESTONE_CARDS_LAYOUT,
} from "../src/schemas.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

type Row = Record<string, unknown>;

async function count(
  schemaHash: string,
  fields: readonly string[],
  filter: Record<string, string>,
): Promise<{ n: number; rows: Row[]; err: string | null }> {
  try {
    const res = await node.queryAll({ schemaHash, fields: [...fields], filter });
    const rows = (res.results ?? []).map((r) => (r.fields ?? {}) as Row);
    return { n: rows.length, rows, err: null };
  } catch (e) {
    return { n: 0, rows: [], err: e instanceof Error ? e.message : String(e) };
  }
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

// ---------------------------------------------------------------- BoardMilestones
const bmHash = cfg.schemaHashes?.board_milestones;
console.log("== BoardMilestones: the standing experiment ==\n");
if (!bmHash) {
  console.log("  board_milestones unbound — nothing to measure.");
} else {
  const board = "default";
  const spine = ["board", "sk", "slug"] as const;
  const wide = BOARD_MILESTONES_FIELDS;
  const onlyCompleted = ["board", "sk", "completed_at"] as const;

  const a = await count(bmHash, spine, { HashKey: board });
  const b = await count(bmHash, wide, { HashKey: board });
  const c = await count(bmHash, onlyCompleted, { HashKey: board });

  console.log(`  ${pad("projection", 46)} rows`);
  console.log(`  ${pad(`spine (${spine.length}: board,sk,slug)`, 46)} ${a.n}${a.err ? "  ERR " + a.err : ""}`);
  console.log(`  ${pad(`wide (${wide.length}, includes completed_at)`, 46)} ${b.n}${b.err ? "  ERR " + b.err : ""}`);
  console.log(`  ${pad(`board,sk,completed_at (3)`, 46)} ${c.n}${c.err ? "  ERR " + c.err : ""}`);

  // Did completed_at actually come back, and as what?
  const present = b.rows.filter((r) => "completed_at" in r).length;
  const nonEmpty = b.rows.filter((r) => String(r.completed_at ?? "") !== "").length;
  console.log(
    `\n  of the ${b.n} wide rows: ${present} carry a \`completed_at\` key, ${nonEmpty} carry a non-empty value`,
  );
  const sample = b.rows[0];
  if (sample) {
    const missing = [...wide].filter((f) => !(f in sample));
    console.log(`  sample row missing keys: ${missing.length ? missing.join(", ") : "(none)"}`);
  }

  console.log(
    `\n  VERDICT: ${
      b.n === 0
        ? "rule HOLDS as stated — the wide read drops every row."
        : b.n === a.n
          ? "rule is NARROWER than stated — a field with no atom did not drop the row."
          : `rule is PARTIAL — wide loses ${a.n - b.n} of ${a.n} rows.`
    }`,
  );
}

// ---------------------------------------------------------------- MilestoneCards
// `layout` is deliberately NOT a shared field description, so the node-side
// sibling fold cannot produce it (schemas.ts). Every MilestoneCards read both
// projects `layout` and re-checks its value. If the rule holds, a fold-created
// row is invisible to this client by construction.
console.log("\n== MilestoneCards: can the client see a row the fold would write? ==\n");
const mcHash = cfg.schemaHashes?.milestone_cards;
if (!mcHash) {
  console.log("  milestone_cards unbound — nothing to measure.");
} else {
  const spine = ["milestone", "sk", "slug", "column", "position"] as const;
  // Discover partitions at slug-only width so discovery cannot be blinded.
  const parts = new Set<string>();
  if (bmHash) {
    for (const board of ["default", "agent-dogfood-scratch"]) {
      const r = await count(bmHash, ["board", "sk", "slug"], { HashKey: board });
      for (const row of r.rows) {
        const s = String(row.slug ?? "");
        if (s) parts.add(s);
      }
    }
  }
  let spineTotal = 0;
  let wideTotal = 0;
  let noLayout = 0;
  let wrongLayout = 0;
  const blind: string[] = [];
  for (const ms of parts) {
    const s = await count(mcHash, spine, { HashKey: ms });
    const w = await count(mcHash, MILESTONE_CARDS_FIELDS, { HashKey: ms });
    spineTotal += s.n;
    wideTotal += w.n;
    if (s.n !== w.n) blind.push(`${ms}: spine ${s.n} vs wide ${w.n}`);
    for (const row of w.rows) {
      if (!("layout" in row)) noLayout += 1;
      else if (String(row.layout ?? "") !== MILESTONE_CARDS_LAYOUT) wrongLayout += 1;
    }
  }
  console.log(`  partitions probed:            ${parts.size}`);
  console.log(`  rows at spine (5 fields):     ${spineTotal}`);
  console.log(`  rows at wide (${MILESTONE_CARDS_FIELDS.length} fields):    ${wideTotal}`);
  console.log(`  wide rows with NO layout key: ${noLayout}`);
  console.log(`  wide rows w/ wrong layout:    ${wrongLayout}`);
  if (blind.length) {
    console.log(`\n  partitions where the wide read sees fewer rows:`);
    for (const b of blind) console.log(`    ${b}`);
  } else {
    console.log(`\n  no partition loses rows to the wide read today.`);
  }
}

console.log("\nRead-only. Nothing was written.");
