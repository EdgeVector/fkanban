import { type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
import { listBoards, listCards, sortCards } from "../record.ts";
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

export async function groomStaleBlockersResult(opts: GroomStaleBlockersOptions): Promise<{
  text: string;
  report: GroomReport;
}> {
  const [cards, boards] = await Promise.all([
    listCards(opts.node, opts.cfg),
    listBoards(opts.node, opts.cfg),
  ]);
  const terminalByBoard = new Map(boards.map((b) => [b.slug, b.columns[b.columns.length - 1] ?? "done"]));
  const active = sortCards(cards.filter((c) => c.column !== (terminalByBoard.get(c.board) ?? "done")));

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
