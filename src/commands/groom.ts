import { type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
import {
  bodyLooksLikeKnownClobber,
  deriveStructuredFields,
  listBoards,
  TERMINAL_COLUMN,
  listBoardCardsWithBodies,
  nowIso,
  sortCards,
  updateCardRecord,
  type Card,
} from "../record.ts";
import {
  groomCard,
  writeGroomedCard,
  type GroomReport,
} from "../pickup.ts";
import { renderSweepWrites } from "../sweep_report.ts";

/**
 * Every `kanban groom` subcommand, in help order.
 *
 * One list, three consumers: the dispatcher's validation, the unknown-subcommand
 * help line, and the per-sweep ops label (`groomOpsLabel` in client.ts). It was
 * spelled out three times before — a `sub !== "..."` chain, a hand-written help
 * string, and a ternary — so adding a sweep meant remembering three places, and
 * the ops label was the one that got forgotten.
 *
 * Adding a subcommand here is what makes it attributable in `lastdb ops`;
 * `ops-label-attribution.test.ts` fails if any entry maps to the plain board
 * label, so a new sweep cannot silently bill itself to the user.
 */
export const GROOM_SUBCOMMANDS = [
  "structured-routing",
  "body-clobber-scan",
  "stale-blockers",
  "board-cards-heal",
  "board-cards-rekey",
  "board-cards-heal-scheduled",
  "board-list-heal",
  "milestone-indexes-heal",
  "archive-done",
  "card-list-index-retire",
  "parity-check",
] as const;

export type GroomSubcommand = (typeof GROOM_SUBCOMMANDS)[number];

export function isGroomSubcommand(sub: string | undefined): sub is GroomSubcommand {
  return sub !== undefined && (GROOM_SUBCOMMANDS as readonly string[]).includes(sub);
}

export type GroomStaleBlockersOptions = {
  cfg: Config;
  node: NodeClient;
  apply?: boolean;
  json?: boolean;
};

export type GroomStructuredRoutingOptions = {
  cfg: Config;
  node: NodeClient;
  apply?: boolean;
  json?: boolean;
};

export type StructuredRoutingRepair = {
  slug: string;
  board: string;
  column: string;
  repo?: string;
  base?: string;
};

export type StructuredRoutingReport = {
  scanned: number;
  candidates: number;
  changed: number;
  would_change: number;
  dryRun: boolean;
  cards: StructuredRoutingRepair[];
};

/**
 * The count pair every sweep head line is rendered from.
 *
 * `changed` counts writes that HAPPENED; `would_change` counts writes a
 * `--apply` run WOULD make. They are separate fields on purpose. Both numbers
 * used to be the same field, populated from the plan's length regardless of
 * `--apply`, so a dry run reported `changed: 4` having written nothing — and
 * `last-stack-groom-board` copied that number verbatim into its durable routine
 * memory ("stale-blockers dry-run ... changed=3"). The rendered text carried a
 * `— DRY RUN, no writes` suffix, so a human reading the sentence got the truth
 * while every `--json` consumer reading the field alone did not.
 *
 * This is `archive_done`'s rule, which this file kept rediscovering: count the
 * actions that occurred, never derive them from the actions that were planned,
 * and make the KEY NAME change with the meaning so a reader cannot mistake one
 * for the other (`would_archive=` vs `archived=` there, the same swap here).
 */
export type SweepCounts = {
  scanned: number;
  candidates: number;
  changed: number;
  would_change: number;
  dryRun: boolean;
};

/**
 * One head line for every groom sweep.
 *
 * Shared rather than spelled out per sweep because the three copies had already
 * drifted three different ways: one derived `changed` from the plan, one hard-
 * coded `"0 changed"` as a string literal that consulted no field at all, and
 * only the third counted writes. A sweep added tomorrow gets the honest line by
 * construction, and `groom-sweep-counts.test.ts` fails if any head line stops
 * coming from here.
 */
export function renderSweepHead(label: string, counts: SweepCounts): string {
  // "candidate cards" stays ungrammatical at 1 on purpose: the only behavioural
  // delta this change is allowed to carry is the count semantics and the key
  // name, so that reverting it produces an unambiguous test split.
  const writes = renderSweepWrites(
    { applied: "changed", planned: "would_change" },
    { dryRun: counts.dryRun, applied: counts.changed, planned: counts.would_change },
  );
  return (
    `${label}: ${counts.candidates} candidate cards of ${counts.scanned} scanned; ` +
    `${writes}${counts.dryRun ? " — DRY RUN, no writes" : ""}`
  );
}

export type BodyClobberScanHit = {
  slug: string;
  board: string;
  column: string;
  reason: string;
};

export type BodyClobberScanReport = {
  scanned: number;
  candidates: number;
  /**
   * Literal `0` on purpose: this sweep has no `--apply` mode, and the type is
   * what stops the renderer from going stale if it ever gains one. The count
   * used to be the string `"0 changed"` spliced into the head line, consulting
   * no field at all — correct only for exactly as long as nobody added a write
   * path, and silently wrong on the day somebody did.
   */
  changed: 0;
  would_change: 0;
  dryRun: true;
  cards: BodyClobberScanHit[];
};

function renderGroomReport(report: GroomReport): string {
  const head = renderSweepHead("stale-blocker groomer", report);
  const lines = report.cards.map((card) => {
    const issues = card.issues
      .map((issue) => `${issue.kind}${issue.applyable ? "" : " (review)"}: ${issue.message}`)
      .join("; ");
    // Per card, the same distinction as the head line: `card.changed` is a plan
    // flag ("has an applyable change"), so under a dry run the honest word is
    // "would change" — printing "changed" beside a card nothing was written to
    // is the head-line defect at card granularity.
    const mark = card.changed ? (report.dryRun ? " would change" : " changed") : "";
    return `  ${card.slug} [${card.board}/${card.column} kind=${card.kind}]${mark} — ${issues}`;
  });
  const doneWhenFixes = report.cards.flatMap((card) =>
    card.issues
      .filter((issue) => issue.kind === "missing-done-when-predicate" || issue.kind === "malformed-done-when-predicate")
      .map((issue) => `  ${card.slug} kind=${card.kind} column=${card.column} — ${issue.suggestion}`)
  );
  const parts = [head];
  if (lines.length) parts.push(lines.join("\n"));
  if (doneWhenFixes.length) parts.push(`missing DONE-WHEN fix list:\n${doneWhenFixes.join("\n")}`);
  return parts.join("\n");
}

function structuredRoutingRepair(card: Card): { next: Card; repair: StructuredRoutingRepair } | null {
  const headerDerived = deriveStructuredFields({ ...card, tags: [] });
  const repair: StructuredRoutingRepair = {
    slug: card.slug,
    board: card.board,
    column: card.column,
  };
  const next: Card = { ...card };
  if (!card.repo && headerDerived.repo) {
    next.repo = headerDerived.repo;
    repair.repo = headerDerived.repo;
  }
  if (!card.base && headerDerived.base) {
    next.base = headerDerived.base;
    repair.base = headerDerived.base;
  }
  return repair.repo || repair.base ? { next, repair } : null;
}

function renderStructuredRoutingReport(report: StructuredRoutingReport): string {
  const head = renderSweepHead("structured-routing groomer", report);
  const lines = report.cards.map((card) => {
    const fields = [
      card.repo ? `repo=${card.repo}` : "",
      card.base ? `base=${card.base}` : "",
    ].filter(Boolean).join(" ");
    return `  ${card.slug} [${card.board}/${card.column}] ${fields}`;
  });
  return lines.length ? `${head}\n${lines.join("\n")}` : head;
}

function renderBodyClobberScanReport(report: BodyClobberScanReport): string {
  const head = renderSweepHead("body-clobber scan", report);
  const lines = report.cards.map((card) =>
    `  ${card.slug} [${card.board}/${card.column}] - ${card.reason}`
  );
  return lines.length ? `${head}\n${lines.join("\n")}` : head;
}

export async function groomBodyClobberScanResult(opts: GroomStructuredRoutingOptions): Promise<{
  text: string;
  report: BodyClobberScanReport;
}> {
  const boards = await listBoards(opts.node, opts.cfg);
  const cards = sortCards(await listBoardCardsWithBodies(opts.node, opts.cfg, { boards }));
  const hits: BodyClobberScanHit[] = [];
  for (const card of cards) {
    if (!bodyLooksLikeKnownClobber(card.body)) continue;
    hits.push({
      slug: card.slug,
      board: card.board,
      column: card.column,
      reason: "body matches generated/script clobber signature",
    });
  }
  const report: BodyClobberScanReport = {
    scanned: cards.length,
    candidates: hits.length,
    changed: 0,
    would_change: 0,
    dryRun: true,
    cards: hits,
  };
  return { text: renderBodyClobberScanReport(report), report };
}

export async function groomBodyClobberScanCmd(opts: GroomStructuredRoutingOptions): Promise<string> {
  const { text, report } = await groomBodyClobberScanResult(opts);
  return opts.json ? JSON.stringify(report, null, 2) : text;
}

export async function groomStructuredRoutingResult(opts: GroomStructuredRoutingOptions): Promise<{
  text: string;
  report: StructuredRoutingReport;
}> {
  const boards = await listBoards(opts.node, opts.cfg);
  const cards = await listBoardCardsWithBodies(opts.node, opts.cfg, { boards });
  const active = sortCards(cards.filter((c) => c.column !== TERMINAL_COLUMN));

  const repairs: StructuredRoutingRepair[] = [];
  // Incremented AFTER the write returns, never from `repairs.length` — the
  // whole point of `SweepCounts`.
  let changed = 0;
  for (const card of active) {
    const repair = structuredRoutingRepair(card);
    if (!repair) continue;
    repairs.push(repair.repair);
    if (opts.apply) {
      await updateCardRecord(
        opts,
        { ...repair.next, updated_at: nowIso() },
        undefined,
        card,
      );
      changed += 1;
    }
  }

  const report: StructuredRoutingReport = {
    scanned: active.length,
    candidates: repairs.length,
    changed,
    would_change: repairs.length,
    dryRun: !opts.apply,
    cards: repairs,
  };
  return { text: renderStructuredRoutingReport(report), report };
}

export async function groomStructuredRoutingCmd(opts: GroomStructuredRoutingOptions): Promise<string> {
  const { text, report } = await groomStructuredRoutingResult(opts);
  return opts.json ? JSON.stringify(report, null, 2) : text;
}

export async function groomStaleBlockersResult(opts: GroomStaleBlockersOptions): Promise<{
  text: string;
  report: GroomReport;
}> {
  // Bodies, not the thin board list: every issue this groomer reports (hollow
  // brief, stale generated BLOCKED prose, DONE-WHEN predicate) is a judgement
  // ABOUT the body, and `--apply` rewrites the card. On the body-free list it
  // called 238 of 245 live cards hollow and would have demoted the entire
  // pickup lane. One admin scan per sweep is the correct cost here.
  const boards = await listBoards(opts.node, opts.cfg);
  const cards = await listBoardCardsWithBodies(opts.node, opts.cfg, { boards });
  const active = sortCards(cards.filter((c) => c.column !== TERMINAL_COLUMN));

  const cardResults = [];
  let changed = 0;
  let wouldChange = 0;
  for (const card of active) {
    const groomed = groomCard(card, active);
    if (groomed.issues.length === 0) continue;
    const applyableChange = groomed.changed && groomed.issues.some((issue) => issue.applyable);
    if (applyableChange) wouldChange += 1;
    if (opts.apply && applyableChange) {
      await writeGroomedCard(opts, groomed.card, card);
      changed += 1;
    }
    cardResults.push({
      slug: card.slug,
      board: card.board,
      column: card.column,
      kind: card.kind,
      changed: applyableChange,
      issues: groomed.issues,
    });
  }

  const report: GroomReport = {
    scanned: active.length,
    candidates: cardResults.length,
    changed,
    would_change: wouldChange,
    dryRun: !opts.apply,
    cards: cardResults,
  };
  return { text: renderGroomReport(report), report };
}

export async function groomStaleBlockersCmd(opts: GroomStaleBlockersOptions): Promise<string> {
  const { text, report } = await groomStaleBlockersResult(opts);
  return opts.json ? JSON.stringify(report, null, 2) : text;
}
