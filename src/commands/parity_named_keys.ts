// Operational check: compare named addresses with keyed primary values.
// Two complete reads separate stable differences from concurrent changes. This command never writes.
import { FkanbanError, type NodeClient, type QueryFilter, type QueryRow } from "../client.ts";
import { schemaHashFor, type Config } from "../config.ts";
import { keyRows, requireMultiKey, type NamedRow } from "../multi-key.ts";
import { mapWithConcurrency, PARTITION_READ_CONCURRENCY } from "../concurrency.ts";
import { padPositionSegment } from "../position_key.ts";
import { findBoard, listBoards } from "../record.ts";

export type ParityCheckOptions = { cfg: Config; node: NodeClient; json?: boolean; board?: string };
type Issue = { schema: string; key: string; hash: string; range: string; slug: string; reason: string };
type Snapshot = { issues: Map<string, Issue>; partitions: number; records: number };
const cardFields = ["slug", "board", "column", "position", "milestone"];
const milestoneFields = ["slug", "board", "state", "position"];
const identity = (value: unknown) => JSON.stringify(value);
const address = (hash: string, range: string, slug: string) => identity([hash, range, slug]);

async function primaryRecords(node: NodeClient, schema: string, keys: readonly string[], fields: string[]) {
  const unique = [...new Set(keys)];
  const chunks = Array.from({ length: Math.ceil(unique.length / 128) }, (_, i) => unique.slice(i * 128, i * 128 + 128));
  const replies = await mapWithConcurrency(chunks, async chunk => {
    const response = await node.queryAll({ schemaHash: schema, fields,
      filter: { HashRangeKeys: chunk.map(hash => [hash, ""]) } as unknown as QueryFilter });
    if (response.results.some(row => !row.key?.hash || !chunk.includes(row.key.hash))) {
      throw new FkanbanError({ code: "parity_primary_scope_mismatch", message: "A primary read returned an unrequested key." });
    }
    return response.results;
  }, PARTITION_READ_CONCURRENCY);
  const result = new Map<string, QueryRow>();
  for (const row of replies.flat()) {
    const slug = row.key!.hash!;
    if (result.has(slug)) throw new FkanbanError({ code: "parity_primary_duplicate", message: "The primary read repeated one record." });
    result.set(slug, row);
  }
  return result;
}

async function snapshot(opts: ParityCheckOptions): Promise<Snapshot> {
  const cardSchema = schemaHashFor("card", opts.cfg);
  const milestoneSchema = schemaHashFor("milestone", opts.cfg);
  const [boards, allCards] = await Promise.all([
    listBoards(opts.node, opts.cfg),
    keyRows(opts.node, cardSchema, "all", { HashKey: "all" }, cardFields),
  ]);
  const boardNames = opts.board ? [opts.board] : [...new Set([
    ...boards.map(board => board.slug),
    ...allCards.map(row => row.fields.board).filter((board): board is string => typeof board === "string" && !!board),
  ])];
  const parts = await mapWithConcurrency(boardNames, async board => {
    const [cards, milestones] = await Promise.all([
      keyRows(opts.node, cardSchema, "by_board", { HashKey: board }, cardFields),
      keyRows(opts.node, milestoneSchema, "by_board", { HashKey: board }, milestoneFields),
    ]);
    return { board, cards, milestones };
  }, PARTITION_READ_CONCURRENCY);
  const boardCards = parts.flatMap(part => part.cards);
  const boardMilestones = parts.flatMap(part => part.milestones);
  const scopedAll = opts.board ? allCards.filter(row => row.fields.board === opts.board) : allCards;
  const cardKeys = [...scopedAll, ...boardCards].map(row => row.key.hash!);
  const cards = await primaryRecords(opts.node, cardSchema, cardKeys, cardFields);
  const milestoneKeys = [...new Set([
    ...boardMilestones.map(row => row.key.hash!),
    ...[...cards.values()].map(row => row.fields.milestone)
      .filter((slug): slug is string => typeof slug === "string" && !!slug),
  ])];
  const [milestones, milestoneParts] = await Promise.all([
    primaryRecords(opts.node, milestoneSchema, milestoneKeys, milestoneFields),
    mapWithConcurrency(milestoneKeys,
      slug => keyRows(opts.node, cardSchema, "by_milestone", { HashKey: slug }, cardFields),
      PARTITION_READ_CONCURRENCY),
  ]);
  const issues = new Map<string, Issue>();
  const add = (issue: Issue) => issues.set(identity(issue), issue);
  const checkFields = (schema: string, slug: string, row: QueryRow, required: string[]) => {
    if (row.fields.slug === slug && required.every(field => typeof row.fields[field] === "string")) return true;
    add({ schema, key: "primary", hash: slug, range: "", slug, reason: "invalid_primary_fields" });
    return false;
  };
  const expectedAll = new Set<string>();
  const expectedBoard = new Set<string>();
  const expectedMilestone = new Set<string>();
  const expectedMilestoneBoard = new Set<string>();
  const orderedRange = (state: string, position: string, slug: string) => state + "#" + padPositionSegment(position) + "#" + slug;
  for (const slug of new Set(cardKeys)) {
    const row = cards.get(slug);
    if (!row) {
      add({ schema: "Card", key: "primary", hash: slug, range: "", slug, reason: "missing_primary_record" });
      continue;
    }
    if (!checkFields("Card", slug, row, cardFields.filter(field => field !== "milestone"))) continue;
    if (row.fields.milestone != null && typeof row.fields.milestone !== "string") {
      add({ schema: "Card", key: "primary", hash: slug, range: "", slug, reason: "invalid_primary_fields" });
      continue;
    }
    if (opts.board && row.fields.board !== opts.board) continue;
    const fields = row.fields as Record<string, string>;
    expectedAll.add(address("all", slug, slug));
    const range = orderedRange(fields.column!, fields.position!, slug);
    expectedBoard.add(address(fields.board!, range, slug));
    if (fields.milestone) expectedMilestone.add(address(fields.milestone, range, slug));
  }
  for (const slug of milestoneKeys) {
    const row = milestones.get(slug);
    if (!row) {
      add({ schema: "Milestone", key: "primary", hash: slug, range: "", slug, reason: "missing_primary_record" });
      continue;
    }
    if (!checkFields("Milestone", slug, row, milestoneFields)) continue;
    if (opts.board && row.fields.board !== opts.board) continue;
    const fields = row.fields as Record<string, string>;
    expectedMilestoneBoard.add(address(fields.board!, orderedRange(fields.state!, fields.position!, slug), slug));
  }
  const compare = (schema: string, key: string, expected: Set<string>, rows: NamedRow[]) => {
    const actual = new Set(rows.map(row => address(row.matched_key.hash, row.matched_key.range, row.key.hash!)));
    for (const encoded of expected) if (!actual.has(encoded)) {
      const [hash, range, slug] = JSON.parse(encoded) as [string, string, string];
      add({ schema, key, hash, range, slug, reason: "missing_named_address" });
    }
    for (const encoded of actual) if (!expected.has(encoded)) {
      const [hash, range, slug] = JSON.parse(encoded) as [string, string, string];
      add({ schema, key, hash, range, slug, reason: "unexpected_named_address" });
    }
  };
  compare("Card", "all", expectedAll, scopedAll);
  compare("Card", "by_board", expectedBoard, boardCards);
  compare("Milestone", "by_board", expectedMilestoneBoard, boardMilestones);
  compare("Card", "by_milestone", expectedMilestone, milestoneParts.flat().filter(row => !opts.board || row.fields.board === opts.board));
  return { issues, partitions: 2 + 2 * boardNames.length + milestoneKeys.length, records: cards.size + milestones.size };
}

export async function parityCheckResult(opts: ParityCheckOptions) {
  requireMultiKey(opts.cfg);
  if (opts.board !== undefined && (!opts.board || !await findBoard(opts.node, opts.cfg, opts.board))) {
    throw new FkanbanError({ code: "board_not_found", message: "The requested parity-check board does not exist." });
  }
  const first = await snapshot(opts);
  const second = await snapshot(opts);
  const drift = [...second.issues].filter(([key]) => first.issues.has(key)).map(([, issue]) => issue);
  const changed = new Map([...first.issues, ...second.issues]);
  for (const issue of drift) changed.delete(identity(issue));
  return {
    ok: drift.length === 0,
    scope: "Card all-key records, declared boards, and milestone keys named by those records. This is not a count of unaddressed database data.",
    partitions_checked: second.partitions,
    rows_checked: second.records,
    reads_completed: 2,
    drift,
    churn: [...changed.values()],
  };
}

export async function parityCheckCmd(opts: ParityCheckOptions): Promise<{ text: string; ok: boolean }> {
  const report = await parityCheckResult(opts);
  if (opts.json) return { text: JSON.stringify(report, null, 2), ok: report.ok };
  const lines = [
    "parity-check: " + report.rows_checked + " primary records; " + report.partitions_checked + " named-key reads per pass",
    report.ok ? "✓ No stable named-key differences in the addressed scope." : "✗ " + report.drift.length + " stable named-key differences.",
    ...report.drift.map(issue => JSON.stringify(issue)),
    report.churn.length ? "Concurrent changes: " + report.churn.length + " differences changed between the two reads." : "No differences changed between the two reads.",
    report.scope,
  ];
  return { text: lines.join("\n"), ok: report.ok };
}
