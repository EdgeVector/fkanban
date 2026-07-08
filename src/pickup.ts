import { type NodeClient } from "./client.ts";
import { type Config } from "./config.ts";
import {
  cardToFields,
  depStatus,
  isRegistryCard,
  normalizeBlockStatus,
  normalizeKind,
  nowIso,
  PICKUP_AREA_ACTIVE_COLUMNS,
  PICKUP_AREA_BLOCK_PREFIX,
  resolvePickupRepo,
  sanitizeRepoValue,
  sortCards,
  type Board,
  type Card,
  type DepStatus,
} from "./record.ts";
import { schemaHashFor } from "./config.ts";

export const HUMAN_BOARD_SLUG = "human";
export const HUMAN_BOARD_TITLE = "Human / parked work";
export const HUMAN_BOARD_COLUMNS = ["todo", "waiting", "validated", "done"] as const;

export const PICKUP_CATEGORIES = [
  "pickup-ready",
  "blocked-on-dependency",
  "human-gated",
  "malformed-routing",
  "parked/non-work",
  "collision",
  "stale-metadata",
] as const;
export type PickupCategory = (typeof PICKUP_CATEGORIES)[number];

export type PickupClassification = {
  slug: string;
  title: string;
  board: string;
  column: string;
  category: PickupCategory;
  ready: boolean;
  reason: string;
  details: string[];
  suggestion: string;
  repo: string;
  base: string;
  kind: string;
  block_status: string;
  blockedBy: string[];
  missingDeps: string[];
};

export type PickupStatusReport = {
  scanned: number;
  ready: number;
  counts: Record<PickupCategory, number>;
  cards: PickupClassification[];
};

const GENERATED_BODY_BLOCK_RE = /^BLOCKED:\s*fkanban-pickup\b.*(?:Repo|Base|routing|resolve|metadata|pickup)/i;
const GENERATED_REASON_PREFIXES = [
  PICKUP_AREA_BLOCK_PREFIX,
  "Repo tag conflict:",
  "fkanban-pickup cannot resolve",
  "fkanban-pickup cannot pick up",
];

function activeCards(cards: Card[], boards: Board[]): Card[] {
  const terminalByBoard = new Map(boards.map((b) => [b.slug, b.columns[b.columns.length - 1] ?? "done"]));
  return cards.filter((c) => c.column !== (terminalByBoard.get(c.board) ?? "done"));
}

function generatedReason(reason: string): boolean {
  return GENERATED_REASON_PREFIXES.some((prefix) => reason.startsWith(prefix));
}

function baseForPickup(card: Card): string {
  return (card.base || card.body.match(/^[ \t]*Base:[ \t]*(\S+)/im)?.[1] || "").trim();
}

function repoForDisplay(card: Card): string {
  const resolved = resolvePickupRepo(card);
  return resolved.ok ? resolved.repo : "";
}

function hasGeneratedBlockedProse(card: Card): boolean {
  return card.body.split("\n").some((line) => GENERATED_BODY_BLOCK_RE.test(line.trim()));
}

function activePickupOverlapStillExists(card: Card, allCards: Card[]): boolean {
  const mentioned = [...card.block_reason.matchAll(/\b([a-z0-9][a-z0-9-_]{2,})\b/g)]
    .map((m) => m[1] ?? "")
    .filter((slug) => slug !== card.slug && slug !== "area" && slug !== "todo" && slug !== "doing" && slug !== "review");
  if (mentioned.length === 0) return false;
  const activeColumns = new Set<string>(PICKUP_AREA_ACTIVE_COLUMNS);
  const bySlug = new Map(allCards.map((c) => [c.slug, c]));
  return mentioned.some((slug) => {
    const other = bySlug.get(slug);
    return other !== undefined && activeColumns.has(other.column) && normalizeBlockStatus(other.block_status) === "none";
  });
}

function isStaleGeneratedHold(card: Card, allCards: Card[]): boolean {
  const blockStatus = normalizeBlockStatus(card.block_status);
  if (blockStatus === "none" && generatedReason(card.block_reason)) return true;
  if (
    blockStatus === "needs_human" &&
    card.block_reason.startsWith(PICKUP_AREA_BLOCK_PREFIX) &&
    !activePickupOverlapStillExists(card, allCards)
  ) {
    return true;
  }
  return false;
}

export function classifyPickupCard(card: Card, allCards: Card[], dep: DepStatus): PickupClassification {
  const kind = normalizeKind(card.kind);
  const blockStatus = normalizeBlockStatus(card.block_status);
  const repo = repoForDisplay(card);
  const base = baseForPickup(card);
  const details: string[] = [];
  const out = (category: PickupCategory, reason: string, suggestion: string): PickupClassification => ({
    slug: card.slug,
    title: card.title,
    board: card.board,
    column: card.column,
    category,
    ready: category === "pickup-ready",
    reason,
    details,
    suggestion,
    repo,
    base,
    kind,
    block_status: blockStatus,
    blockedBy: dep.blockedBy,
    missingDeps: dep.missing,
  });

  if (isStaleGeneratedHold(card, allCards) || (hasGeneratedBlockedProse(card) && repo && base)) {
    return out(
      "stale-metadata",
      "generated blocker metadata appears stale",
      "Run `fkanban groom stale-blockers --apply` after reviewing the dry-run.",
    );
  }

  if (card.board === HUMAN_BOARD_SLUG) {
    return out("human-gated", "card is parked on the human board", "Return it with `fkanban add <slug> --board default --column todo --block-status none` once runnable.");
  }
  if (blockStatus === "needs_human" || blockStatus === "design_first") {
    return out("human-gated", `intentional hold: ${blockStatus}`, "Move true human-gated work to `--board human`; clear the hold only when pickup-ready.");
  }
  if (blockStatus === "deferred") {
    return out("parked/non-work", "deferred hold", "Keep deferred work outside default todo until its sequence opens.");
  }
  if (kind !== "pr" || isRegistryCard(card.body, card.title)) {
    return out("parked/non-work", `non-pickup kind: ${kind}`, "Leave grouping/tracker cards out of default todo, or split a concrete PR card.");
  }
  if (card.board !== "default") {
    return out("parked/non-work", `card is on non-default board ${card.board}`, "Move to default/todo only when an agent should pick it up.");
  }
  if (card.column !== "todo") {
    return out("collision", `card is already in ${card.column}`, "Do not pick up again; reconcile the existing branch/PR or move it back to todo.");
  }

  const repoResolution = resolvePickupRepo(card);
  if (!repoResolution.ok) {
    details.push(repoResolution.reason);
    return out("malformed-routing", repoResolution.reason, "Set a bare `Repo: owner/name` header or `--repo owner/name`.");
  }
  if (!base) {
    return out("malformed-routing", "missing Base header/field", "Set `Base: main` or pass `--base main`.");
  }
  if (card.pr_url || card.branch) {
    return out("collision", "todo card already has branch/PR metadata", "Reconcile the existing branch/PR before pickup.");
  }
  if (dep.blocked) {
    details.push(`blockedBy: ${dep.blockedBy.join(", ")}`);
    return out("blocked-on-dependency", "unfinished dependency", "Finish or retarget the dependency before pickup.");
  }

  return out("pickup-ready", "ready for fkanban-agent WORK mode", "Pick this card up next.");
}

export function buildPickupStatusReport(cards: Card[], boards: Board[]): PickupStatusReport {
  const active = sortCards(activeCards(cards, boards));
  const terminalByBoard = new Map(boards.map((b) => [b.slug, b.columns[b.columns.length - 1] ?? "done"]));
  const classifications = active.map((card) =>
    classifyPickupCard(card, active, depStatus(card, active, terminalByBoard)),
  );
  const counts = Object.fromEntries(PICKUP_CATEGORIES.map((category) => [category, 0])) as Record<PickupCategory, number>;
  for (const c of classifications) counts[c.category] += 1;
  return {
    scanned: classifications.length,
    ready: counts["pickup-ready"],
    counts,
    cards: classifications,
  };
}

export function renderPickupStatus(report: PickupStatusReport): string {
  const head = `pickup-ready: ${report.ready} of ${report.scanned} active cards`;
  const counts = PICKUP_CATEGORIES
    .filter((category) => report.counts[category] > 0)
    .map((category) => `${category}=${report.counts[category]}`)
    .join(", ");
  const lines = report.cards.map((c) => {
    const detail = c.details.length ? ` (${c.details.join("; ")})` : "";
    return `${c.category.padEnd(22)} ${c.slug} [${c.board}/${c.column}] — ${c.reason}${detail}`;
  });
  return lines.length ? `${head}${counts ? ` (${counts})` : ""}\n${lines.join("\n")}` : head;
}

export type GroomIssueKind =
  | "stale-blocked-prose"
  | "malformed-repo-header"
  | "stale-block-status"
  | "stale-pickup-area-overlap"
  | "block-status-mismatch"
  | "human-parking-candidate";

export type GroomIssue = {
  kind: GroomIssueKind;
  message: string;
  applyable: boolean;
  suggestion: string;
};

export type GroomCardResult = {
  slug: string;
  board: string;
  column: string;
  changed: boolean;
  issues: GroomIssue[];
};

export type GroomReport = {
  scanned: number;
  candidates: number;
  changed: number;
  dryRun: boolean;
  cards: GroomCardResult[];
};

function rewriteRepoHeaders(body: string): { body: string; changed: boolean } {
  let changed = false;
  const next = body.replace(/^([ \t]*Repo:[ \t]*)(.*)$/gim, (line, prefix: string, raw: string) => {
    const clean = sanitizeRepoValue(raw);
    if (!clean) return line;
    const rewritten = `${prefix}${clean}`;
    if (rewritten !== line) changed = true;
    return rewritten;
  });
  return { body: next, changed };
}

function removeGeneratedBlockedLines(body: string): { body: string; changed: boolean } {
  const lines = body.split("\n");
  const kept = lines.filter((line) => !GENERATED_BODY_BLOCK_RE.test(line.trim()));
  return { body: kept.join("\n").replace(/\n{3,}/g, "\n\n"), changed: kept.length !== lines.length };
}

export function groomCard(card: Card, allCards: Card[]): { card: Card; issues: GroomIssue[]; changed: boolean } {
  const issues: GroomIssue[] = [];
  const next: Card = { ...card, tags: [...card.tags], deps: [...card.deps] };

  const repoRewrite = rewriteRepoHeaders(next.body);
  if (repoRewrite.changed) {
    issues.push({
      kind: "malformed-repo-header",
      message: "Repo header contains inline prose/comment or mashed metadata",
      applyable: true,
      suggestion: "Rewrite the Repo line to the bare owner/name token.",
    });
    next.body = repoRewrite.body;
  }

  const resolvedRepo = resolvePickupRepo(next).ok;
  const resolvedBase = baseForPickup(next).length > 0;
  const blockedLines = removeGeneratedBlockedLines(next.body);
  if (blockedLines.changed && resolvedRepo && resolvedBase) {
    issues.push({
      kind: "stale-blocked-prose",
      message: "generated fkanban-pickup BLOCKED prose remains after routing resolved",
      applyable: true,
      suggestion: "Remove only the generated BLOCKED line.",
    });
    next.body = blockedLines.body;
  }

  const blockStatus = normalizeBlockStatus(next.block_status);
  if (blockStatus === "none" && generatedReason(next.block_reason)) {
    issues.push({
      kind: "stale-block-status",
      message: "block_reason contains generated text while block_status is none",
      applyable: true,
      suggestion: "Clear block_reason.",
    });
    next.block_reason = "";
  }
  if (
    blockStatus === "needs_human" &&
    next.block_reason.startsWith(PICKUP_AREA_BLOCK_PREFIX) &&
    !activePickupOverlapStillExists(next, allCards)
  ) {
    issues.push({
      kind: "stale-pickup-area-overlap",
      message: "pickup-area overlap hold no longer points at an active unblocked peer",
      applyable: true,
      suggestion: "Clear the generated overlap hold.",
    });
    next.block_status = "none";
    next.block_reason = "";
  }
  const finalBlockStatus = normalizeBlockStatus(next.block_status);
  if (finalBlockStatus !== "none" && next.block_reason.trim().length === 0) {
    issues.push({
      kind: "block-status-mismatch",
      message: `block_status=${finalBlockStatus} has no block_reason`,
      applyable: false,
      suggestion: "Add a human-readable reason or clear the hold explicitly.",
    });
  }
  if (
    next.board === "default" &&
    next.column === "todo" &&
    (finalBlockStatus === "needs_human" || finalBlockStatus === "design_first" || finalBlockStatus === "deferred") &&
    !generatedReason(card.block_reason)
  ) {
    issues.push({
      kind: "human-parking-candidate",
      message: `intentional ${finalBlockStatus} hold is still in default/todo`,
      applyable: false,
      suggestion: "Move true human-gated/deferred work to `--board human` or another parking board.",
    });
  }

  const changed =
    next.body !== card.body ||
    next.block_status !== card.block_status ||
    next.block_reason !== card.block_reason;
  return { card: next, issues, changed };
}

export async function writeGroomedCard(opts: { cfg: Config; node: NodeClient }, card: Card): Promise<void> {
  await opts.node.updateRecord({
    schemaHash: schemaHashFor("card", opts.cfg),
    keyHash: card.slug,
    fields: cardToFields({ ...card, updated_at: nowIso() }),
  });
}
