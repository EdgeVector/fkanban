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
  dryRun: boolean;
  cards: StructuredRoutingRepair[];
};

export type BodyClobberScanHit = {
  slug: string;
  board: string;
  column: string;
  reason: string;
};

export type BodyClobberScanReport = {
  scanned: number;
  candidates: number;
  changed: 0;
  dryRun: true;
  cards: BodyClobberScanHit[];
};

function renderGroomReport(report: GroomReport): string {
  const head =
    `stale-blocker groomer: ${report.candidates} candidate cards of ${report.scanned} scanned; ` +
    `${report.changed} changed${report.dryRun ? " — DRY RUN, no writes" : ""}`;
  const lines = report.cards.map((card) => {
    const issues = card.issues
      .map((issue) => `${issue.kind}${issue.applyable ? "" : " (review)"}: ${issue.message}`)
      .join("; ");
    return `  ${card.slug} [${card.board}/${card.column} kind=${card.kind}]${card.changed ? " changed" : ""} — ${issues}`;
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
  const head =
    `structured-routing groomer: ${report.candidates} candidate cards of ${report.scanned} scanned; ` +
    `${report.changed} changed${report.dryRun ? " — DRY RUN, no writes" : ""}`;
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
  const head =
    `body-clobber scan: ${report.candidates} candidate cards of ${report.scanned} scanned; ` +
    "0 changed - DRY RUN, no writes";
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
    }
  }

  const report: StructuredRoutingReport = {
    scanned: active.length,
    candidates: repairs.length,
    changed: repairs.length,
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
  for (const card of active) {
    const groomed = groomCard(card, active);
    if (groomed.issues.length === 0) continue;
    const applyableChange = groomed.changed && groomed.issues.some((issue) => issue.applyable);
    if (opts.apply && applyableChange) {
      await writeGroomedCard(opts, groomed.card, card);
      changed += 1;
    } else if (!opts.apply && applyableChange) {
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
    dryRun: !opts.apply,
    cards: cardResults,
  };
  return { text: renderGroomReport(report), report };
}

export async function groomStaleBlockersCmd(opts: GroomStaleBlockersOptions): Promise<string> {
  const { text, report } = await groomStaleBlockersResult(opts);
  return opts.json ? JSON.stringify(report, null, 2) : text;
}
