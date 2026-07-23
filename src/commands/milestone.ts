import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { FkanbanError, type NodeClient } from "../client.ts";
import type { Config } from "../config.ts";
import { doneWhenPredicate } from "../pickup.ts";
import {
  MILESTONE_PROOF_STATUSES,
  MILESTONE_STATES,
  ensureBoardRecord,
  boardTerminalMap,
  depStatus,
  findCard,
  findMilestone,
  isMilestoneState,
  listBoards,
  listCardsOnBoard,
  listDependencyStatusesForCards,
  listMilestones,
  hasPrWorkBrief,
  isSubstantiveCardBody,
  normalizeBlockStatus,
  normalizeDeps,
  normalizeKind,
  nowIso,
  requireMilestone,
  resolveMilestoneDriver,
  upsertMilestoneRecord,
  validateSlug,
  type Milestone,
  type Card,
  type Board,
} from "../record.ts";

export type MilestoneWarning = {
  code: string;
  message: string;
  hint: string;
};

export type MilestoneChildStatus = {
  slug: string;
  title: string;
  column: string;
  blocked: boolean;
  blockedBy: string[];
};

export type MilestoneReconcileResult = {
  milestone: Milestone;
  children: MilestoneChildStatus[];
  ready: MilestoneChildStatus[];
  proof: { slug: string; terminal: boolean; passingEvidence: boolean } | null;
  warnings: MilestoneWarning[];
};

export type MilestonePortfolioEntry = {
  slug: string;
  title: string;
  north_star: string;
  state: string;
  driver: string;
  proof_card: string;
  proof_status: string;
  ready: string[];
  blocker: string;
  warning_count: number;
};

export type MilestoneGroomIssue = MilestoneWarning & {
  milestone?: string;
  card?: string;
};

const ALLOWED_TRANSITIONS: Record<string, readonly string[]> = {
  planned: ["active", "abandoned"],
  active: ["blocked", "proving", "abandoned"],
  blocked: ["active", "abandoned"],
  proving: ["active", "blocked", "complete", "abandoned"],
  complete: ["active"],
  abandoned: ["planned", "active"],
};

/**
 * Terminal proof evidence for milestone completion.
 *
 * Accepts either:
 * - an exact body line `PROOF: PASS` / `RESULT: PASS`, or
 * - a satisfied `DONE-WHEN: file <path> matches /regex/` when the file exists
 *   and the first line (or full content) matches (covers PASS / PASS-OFFLINE
 *   North Star proof reports without requiring a second PROOF: line).
 */
export function hasPassingProofEvidence(body: string): boolean {
  if (/^[ \t]*(?:PROOF|RESULT):[ \t]*PASS[ \t]*$/im.test(body)) return true;
  return doneWhenFileProofSatisfied(body);
}

function expandProofPath(path: string): string {
  if (path.startsWith("~/")) return `${homedir()}${path.slice(1)}`;
  if (path.startsWith("$HOME/")) return `${homedir()}${path.slice(5)}`;
  if (path.startsWith("${HOME}/")) return `${homedir()}${path.slice(7)}`;
  return path;
}

/** Evaluate `DONE-WHEN: file <path> matches /regex/` as milestone proof evidence. */
export function doneWhenFileProofSatisfied(body: string): boolean {
  const predicate = doneWhenPredicate(body);
  const match = predicate.match(/^file\s+(\S+)\s+matches\s+\/(.+)\/$/);
  if (!match) return false;
  const filePath = expandProofPath(match[1]!);
  const regexSrc = match[2]!;
  if (!existsSync(filePath)) return false;
  try {
    const content = readFileSync(filePath, "utf8");
    const re = new RegExp(regexSrc, "m");
    const firstLine = content.split(/\r?\n/, 1)[0] ?? "";
    return re.test(firstLine) || re.test(content);
  } catch {
    return false;
  }
}

export type MilestoneAddOptions = {
  cfg: Config;
  node: NodeClient;
  slug: string;
  title?: string;
  body?: string;
  board?: string;
  state?: string;
  position?: string;
  northStar?: string;
  driver?: string;
  deps?: string[];
  proofCard?: string;
  proofStatus?: string;
  blockReason?: string;
};

function validateState(state: string): void {
  if (isMilestoneState(state)) return;
  throw new FkanbanError({
    code: "invalid_milestone_state",
    message: `Invalid milestone state "${state}".`,
    hint: `One of: ${MILESTONE_STATES.join(", ")}.`,
  });
}

function validateProofStatus(status: string): void {
  if ((MILESTONE_PROOF_STATUSES as readonly string[]).includes(status)) return;
  throw new FkanbanError({
    code: "invalid_milestone_proof_status",
    message: `Invalid milestone proof status "${status}".`,
    hint: `One of: ${MILESTONE_PROOF_STATUSES.join(", ")}.`,
  });
}

async function validateLinks(opts: MilestoneAddOptions, milestone: Milestone): Promise<void> {
  for (const dep of milestone.deps) {
    validateSlug(dep);
    if (!(await findMilestone(opts.node, opts.cfg, dep))) {
      throw new FkanbanError({
        code: "milestone_dependency_not_found",
        message: `Dependency milestone "${dep}" not found.`,
        hint: "Create dependency milestones before linking them.",
      });
    }
  }
  if (milestone.proof_card && !(await findCard(opts.node, opts.cfg, milestone.proof_card))) {
    throw new FkanbanError({
      code: "milestone_proof_card_not_found",
      message: `Proof card "${milestone.proof_card}" not found.`,
      hint: "Create the terminal proof card before linking it.",
    });
  }
}

async function proofGate(
  opts: Pick<MilestoneAddOptions, "cfg" | "node">,
  milestone: Milestone,
  target: string,
): Promise<void> {
  if (target !== "proving" && target !== "complete") return;
  if (!milestone.proof_card) {
    throw new FkanbanError({
      code: "milestone_proof_card_required",
      message: `Milestone "${milestone.slug}" cannot enter ${target} without a proof card.`,
      hint: "Link a live validation card with --proof-card, then retry.",
    });
  }
  const proof = await findCard(opts.node, opts.cfg, milestone.proof_card);
  if (!proof) {
    throw new FkanbanError({
      code: "milestone_proof_card_not_found",
      message: `Proof card "${milestone.proof_card}" not found.`,
      hint: "Create the terminal proof card before transitioning the milestone.",
    });
  }
  if (proof.board !== milestone.board || proof.milestone !== milestone.slug) {
    throw new FkanbanError({
      code: "milestone_proof_card_mismatch",
      message: `Proof card "${proof.slug}" must belong to milestone "${milestone.slug}" on board "${milestone.board}".`,
      hint: "Set the card's --milestone and --board links to match the milestone.",
    });
  }
  if (normalizeKind(proof.kind) !== "validation") {
    throw new FkanbanError({
      code: "milestone_proof_card_invalid_kind",
      message: `Proof card "${proof.slug}" must have kind=validation.`,
      hint: "Set the proof card's --kind validation so pickup never treats it as implementation work.",
    });
  }
  if (target !== "complete") return;
  const terminals = boardTerminalMap(await listBoards(opts.node, opts.cfg));
  if (proof.column !== (terminals.get(proof.board) ?? "done")) {
    throw new FkanbanError({
      code: "milestone_proof_not_terminal",
      message: `Proof card "${proof.slug}" is not in its terminal column.`,
      hint: "Complete the proof card after its validation passes.",
    });
  }
  if (milestone.proof_status !== "passing" || !hasPassingProofEvidence(proof.body)) {
    throw new FkanbanError({
      code: "milestone_proof_not_passing",
      message: `Milestone "${milestone.slug}" has no machine-readable passing proof.`,
      hint: "Set --proof-status passing and add an exact `PROOF: PASS` or `RESULT: PASS` line to the terminal proof card.",
    });
  }
}

async function validateTransition(
  opts: Pick<MilestoneAddOptions, "cfg" | "node">,
  existing: Milestone | null,
  milestone: Milestone,
): Promise<void> {
  const from = existing?.state ?? "planned";
  const to = milestone.state;
  if (from !== to && !(ALLOWED_TRANSITIONS[from] ?? []).includes(to)) {
    throw new FkanbanError({
      code: "invalid_milestone_transition",
      message: `Milestone "${milestone.slug}" cannot transition ${from} → ${to}.`,
      hint: `Allowed from ${from}: ${(ALLOWED_TRANSITIONS[from] ?? []).join(", ") || "none"}.`,
    });
  }
  if (milestone.proof_status === "failing" && to !== "active") {
    throw new FkanbanError({
      code: "milestone_failed_proof_requires_active",
      message: `A failing proof must return milestone "${milestone.slug}" to active.`,
      hint: "Transition to active with --proof-status failing and fix forward.",
    });
  }
  await proofGate(opts, milestone, to);
}

export async function milestoneAddCmd(opts: MilestoneAddOptions): Promise<{ slug: string; action: "created" | "updated"; state: string }> {
  validateSlug(opts.slug);
  const existing = await findMilestone(opts.node, opts.cfg, opts.slug);
  const state = opts.state ?? (opts.proofStatus === "failing" && existing?.state === "proving" ? "active" : existing?.state) ?? "planned";
  validateState(state);
  const proofStatus = opts.proofStatus ?? existing?.proof_status ?? "pending";
  validateProofStatus(proofStatus);
  const board = opts.board ?? existing?.board ?? "default";
  await ensureBoardRecord(opts.node, opts.cfg, board);
  const deps = opts.deps === undefined ? (existing?.deps ?? []) : normalizeDeps(opts.deps, opts.slug);
  const now = nowIso();
  const milestone: Milestone = {
    slug: opts.slug,
    title: opts.title ?? existing?.title ?? opts.slug,
    body: opts.body ?? existing?.body ?? "",
    board,
    state,
    position: opts.position ?? existing?.position ?? String(Date.now()),
    north_star: opts.northStar ?? existing?.north_star ?? "",
    // Default last-stack-milestone-driver; refuse/heal superseded program-driver.
    driver: resolveMilestoneDriver(opts.driver, existing?.driver, existing === null),
    deps,
    proof_card: opts.proofCard ?? existing?.proof_card ?? "",
    proof_status: proofStatus,
    block_reason: opts.blockReason ?? existing?.block_reason ?? "",
    created_at: existing?.created_at ?? now,
    updated_at: now,
    completed_at: state === "complete" ? (existing?.completed_at || now) : "",
  };
  await validateLinks(opts, milestone);
  await validateTransition(opts, existing, milestone);
  await upsertMilestoneRecord(opts.node, opts.cfg, milestone, existing !== null);
  return { slug: milestone.slug, action: existing ? "updated" : "created", state: milestone.state };
}

export function renderMilestone(milestone: Milestone): string {
  return [
    `${milestone.title}  (${milestone.slug})`,
    `state: ${milestone.state}`,
    `board: ${milestone.board}`,
    `north star: ${milestone.north_star || "—"}`,
    `driver: ${milestone.driver || "—"}`,
    `proof: ${milestone.proof_status}${milestone.proof_card ? ` · ${milestone.proof_card}` : ""}`,
    `dependencies: ${milestone.deps.length ? milestone.deps.join(", ") : "—"}`,
    ...(milestone.block_reason ? [`blocked: ${milestone.block_reason}`] : []),
    ...(milestone.body ? ["", milestone.body] : []),
  ].join("\n");
}

export async function milestoneListResult(opts: { cfg: Config; node: NodeClient; board?: string; state?: string }): Promise<{ text: string; milestones: Milestone[] }> {
  if (opts.state) validateState(opts.state);
  const milestones = (await listMilestones(opts.node, opts.cfg)).filter(
    (m) => (!opts.board || m.board === opts.board) && (!opts.state || m.state === opts.state),
  );
  const text = milestones.length
    ? milestones.map((m) => `${m.state.padEnd(9)} ${m.slug} — ${m.title}${m.proof_card ? ` [proof:${m.proof_status}]` : ""}`).join("\n")
    : "No milestones.";
  return { text, milestones };
}

export async function milestoneShowResult(opts: { cfg: Config; node: NodeClient; slug: string }): Promise<{ text: string; milestone: Milestone }> {
  const milestone = await requireMilestone(opts.node, opts.cfg, opts.slug);
  return { text: renderMilestone(milestone), milestone };
}

export async function milestoneStateCmd(opts: { cfg: Config; node: NodeClient; slug: string; state: string; proofStatus?: string }): Promise<{ slug: string; from: string; to: string; proof_status: string }> {
  validateState(opts.state);
  if (opts.proofStatus) validateProofStatus(opts.proofStatus);
  const existing = await requireMilestone(opts.node, opts.cfg, opts.slug);
  await milestoneAddCmd({ cfg: opts.cfg, node: opts.node, slug: opts.slug, state: opts.state, proofStatus: opts.proofStatus });
  const updated = await requireMilestone(opts.node, opts.cfg, opts.slug);
  return { slug: opts.slug, from: existing.state, to: updated.state, proof_status: updated.proof_status };
}

export async function milestoneReconcileResult(opts: { cfg: Config; node: NodeClient; slug: string }): Promise<MilestoneReconcileResult & { text: string }> {
  const milestone = await requireMilestone(opts.node, opts.cfg, opts.slug);
  const children = (await listCardsOnBoard(opts.node, opts.cfg, milestone.board)).filter((card) => card.milestone === milestone.slug);
  const statuses = await listDependencyStatusesForCards(opts.node, opts.cfg, children);
  const boards = await listBoards(opts.node, opts.cfg);
  const proofCard = milestone.proof_card ? await findCard(opts.node, opts.cfg, milestone.proof_card) : null;
  const result = milestoneReconcileFromSnapshot(milestone, children, statuses, boards, proofCard);
  return { ...result, text: renderMilestoneReconcile(result) };
}

export function milestoneReconcileFromSnapshot(
  milestone: Milestone,
  boardCards: Card[],
  statuses: Card[],
  boards: Board[],
  proofCard: Card | null,
): MilestoneReconcileResult {
  const children = boardCards.filter((card) => card.milestone === milestone.slug);
  const terminals = boardTerminalMap(boards);
  const childStatuses = children.map((card): MilestoneChildStatus => {
    const dep = depStatus(card, statuses, terminals);
    return { slug: card.slug, title: card.title, column: card.column, blocked: dep.blocked, blockedBy: dep.blockedBy };
  });
  const bySlug = new Map(children.map((card) => [card.slug, card]));
  const ready = childStatuses.filter((status) => {
    const card = bySlug.get(status.slug)!;
    return status.column === "todo" && !status.blocked && normalizeKind(card.kind) === "pr" && normalizeBlockStatus(card.block_status) === "none";
  });
  const proof = proofCard ? {
    slug: proofCard.slug,
    terminal: proofCard.column === (terminals.get(proofCard.board) ?? "done"),
    passingEvidence: hasPassingProofEvidence(proofCard.body),
  } : null;
  const warnings: MilestoneWarning[] = [];
  if (!milestone.driver) warnings.push({ code: "no-driver", message: "Milestone has no reconciliation driver.", hint: "Assign --driver to a person, agent, or routine." });
  if (!milestone.proof_card) warnings.push({ code: "no-proof-card", message: "Milestone has no terminal proof card.", hint: "Create and link a validation card with --proof-card." });
  else if (!proofCard) warnings.push({ code: "missing-proof-card", message: `Linked proof card "${milestone.proof_card}" is missing.`, hint: "Repair the proof link before proving." });
  else if (proofCard.board !== milestone.board || proofCard.milestone !== milestone.slug) warnings.push({ code: "proof-card-mismatch", message: "Proof card board or milestone link does not match.", hint: "Align the proof card's --board and --milestone fields." });
  if (milestone.state === "blocked" && !milestone.block_reason) warnings.push({ code: "blocked-no-reason", message: "Blocked milestone has no reason.", hint: "Add --block-reason or return it to active." });
  const terminalCol = terminals.get(milestone.board) ?? "done";
  // Non-proof children still open (not in the board terminal column).
  const incomplete = childStatuses.filter((child) => child.column !== terminalCol && child.slug !== milestone.proof_card);
  // Implementation children = any non-proof child. Empty milestone ≠ "implementation done".
  const implementationChildren = childStatuses.filter((child) => child.slug !== milestone.proof_card);
  const hasImplementationWork = implementationChildren.length > 0;
  const allImplementationDone = hasImplementationWork && incomplete.length === 0;
  const inFlight = incomplete.some((child) => child.column === "doing");
  if (milestone.state === "active" && incomplete.length > 0 && ready.length === 0 && !inFlight) warnings.push({ code: "active-no-ready-card", message: "Active milestone has implementation work but no ready or in-flight card frontier.", hint: "Resolve dependencies/holds or promote the next implementation card to todo." });
  // Only when real implementation work exists and is fully terminal, with proof still not PASS.
  // Zero children / proof-only milestones must NOT get this warning (false factory-fill poison).
  if (
    allImplementationDone
    && milestone.state !== "complete"
    && (!proof?.terminal || !proof.passingEvidence || milestone.proof_status !== "passing")
  ) {
    warnings.push({
      code: "implementation-done-proof-pending",
      message: "Implementation is done but terminal passing proof is still pending.",
      hint: "Run the proof, record `PROOF: PASS`, mark its status passing, then complete the milestone.",
    });
  }
  if (milestone.state === "complete" && childStatuses.some((child) => child.column !== terminalCol)) warnings.push({ code: "complete-has-active-cards", message: "Complete milestone still has non-terminal child cards.", hint: "Reopen the milestone or finish/abandon the remaining cards." });
  return { milestone, children: childStatuses, ready, proof, warnings };
}

function renderMilestoneReconcile(result: MilestoneReconcileResult): string {
  return [
    `${result.milestone.title} (${result.milestone.slug}) — ${result.milestone.state}`,
    `ready frontier: ${result.ready.length ? result.ready.map((card) => card.slug).join(", ") : "—"}`,
    `proof: ${result.proof ? `${result.proof.slug} · ${result.proof.terminal ? "terminal" : "not terminal"} · ${result.proof.passingEvidence ? "PASS" : "no PASS"}` : "—"}`,
    ...(result.warnings.length ? ["warnings:", ...result.warnings.map((warning) => `- ${warning.code}: ${warning.message} ${warning.hint}`)] : ["warnings: none"]),
  ].join("\n");
}

async function milestonePortfolioSnapshot(opts: { cfg: Config; node: NodeClient; board?: string }): Promise<{ milestones: Milestone[]; cards: Card[]; reconciled: MilestoneReconcileResult[] }> {
  const milestones = (await listMilestones(opts.node, opts.cfg)).filter((milestone) => !opts.board || milestone.board === opts.board);
  const boards = await listBoards(opts.node, opts.cfg);
  const boardSlugs = [...new Set(milestones.map((milestone) => milestone.board))];
  const cards = (await Promise.all(boardSlugs.map((board) => listCardsOnBoard(opts.node, opts.cfg, board)))).flat();
  const statuses = await listDependencyStatusesForCards(opts.node, opts.cfg, cards);
  const proofs = new Map<string, Card | null>();
  await Promise.all(milestones.map(async (milestone) => {
    if (milestone.proof_card && !proofs.has(milestone.proof_card)) proofs.set(milestone.proof_card, await findCard(opts.node, opts.cfg, milestone.proof_card));
  }));
  return {
    milestones,
    cards,
    reconciled: milestones.map((milestone) => milestoneReconcileFromSnapshot(milestone, cards.filter((card) => card.board === milestone.board), statuses, boards, proofs.get(milestone.proof_card) ?? null)),
  };
}

export async function milestonePortfolioResult(opts: { cfg: Config; node: NodeClient; board?: string }): Promise<{ entries: MilestonePortfolioEntry[]; text: string }> {
  const snapshot = await milestonePortfolioSnapshot(opts);
  const entries = snapshot.reconciled.map((result): MilestonePortfolioEntry => ({
    slug: result.milestone.slug,
    title: result.milestone.title,
    north_star: result.milestone.north_star,
    state: result.milestone.state,
    driver: result.milestone.driver,
    proof_card: result.milestone.proof_card,
    proof_status: result.milestone.proof_status,
    ready: result.ready.map((card) => card.slug),
    blocker: result.milestone.state === "blocked" ? (result.milestone.block_reason || "blocked with no reason") : (result.warnings[0]?.message ?? ""),
    warning_count: result.warnings.length,
  }));
  const text = entries.length ? [
    "STATE      MILESTONE                         NORTH STAR              READY  PROOF       WARN  BLOCKER",
    ...entries.map((entry) => `${entry.state.padEnd(10)} ${entry.slug.slice(0, 32).padEnd(33)} ${(entry.north_star || "—").slice(0, 23).padEnd(24)} ${String(entry.ready.length).padEnd(6)} ${entry.proof_status.padEnd(11)} ${String(entry.warning_count).padEnd(5)} ${entry.blocker || "—"}`),
  ].join("\n") : "No milestones.";
  return { entries, text };
}

export async function milestoneDetailResult(opts: { cfg: Config; node: NodeClient; slug: string }): Promise<{ detail: MilestoneReconcileResult & { columns: Record<string, MilestoneChildStatus[]> }; text: string }> {
  const result = await milestoneReconcileResult(opts);
  const columns: Record<string, MilestoneChildStatus[]> = Object.fromEntries((await listBoards(opts.node, opts.cfg)).find((board) => board.slug === result.milestone.board)?.columns.map((column) => [column, result.children.filter((card) => card.column === column)]) ?? []);
  const detail = { milestone: result.milestone, children: result.children, ready: result.ready, proof: result.proof, warnings: result.warnings, columns };
  const columnText = Object.entries(columns).map(([column, cards]) => `${column.toUpperCase()} (${cards.length})\n${cards.length ? cards.map((card) => `  • ${card.blocked ? "🔒 " : ""}${card.title}  ${card.slug}`).join("\n") : "  —"}`).join("\n\n");
  return { detail, text: `${renderMilestone(result.milestone)}\n\n${columnText}\n\n${renderMilestoneReconcile(result)}` };
}

export async function milestoneGroomResult(opts: { cfg: Config; node: NodeClient; board?: string }): Promise<{ issues: MilestoneGroomIssue[]; text: string }> {
  const snapshot = await milestonePortfolioSnapshot(opts);
  const issues: MilestoneGroomIssue[] = snapshot.reconciled.flatMap((result) => result.warnings.map((warning) => ({ ...warning, milestone: result.milestone.slug })));
  const bySlug = new Map(snapshot.milestones.map((milestone) => [milestone.slug, milestone]));
  for (const card of snapshot.cards) {
    if (!card.milestone) {
      // Live Kind:pr without a milestone — factory coverage gap (backlog/todo/doing).
      if (
        normalizeKind(card.kind) === "pr" &&
        (card.column === "backlog" || card.column === "todo" || card.column === "doing") &&
        (!opts.board || card.board === opts.board)
      ) {
        issues.push({
          code: "live-pr-missing-milestone",
          message: `Live Kind:pr card "${card.slug}" in ${card.column} has no milestone.`,
          hint: "Attach with `fkanban add <slug> --milestone <ms>` or move to done if historical.",
          card: card.slug,
        });
      }
      continue;
    }
    const milestone = bySlug.get(card.milestone);
    if (!milestone) issues.push({ code: "missing-milestone", message: `Card links to missing milestone "${card.milestone}".`, hint: "Repair or clear the card milestone link.", card: card.slug });
    else if (card.board !== milestone.board || (card.north_star && milestone.north_star && card.north_star !== milestone.north_star)) issues.push({ code: "milestone-link-mismatch", message: "Card board or North Star does not match its milestone.", hint: "Align the card and milestone relationship.", milestone: milestone.slug, card: card.slug });
  }
  for (const milestone of snapshot.milestones) {
    // Ship/active coverage: planned+active outcomes should parent a North Star.
    // blocked/proving/complete/abandoned are allowed without re-nagging.
    if (!milestone.north_star && (milestone.state === "planned" || milestone.state === "active")) {
      issues.push({
        code: "milestone-missing-north-star",
        message: `Milestone "${milestone.slug}" has no north_star.`,
        hint: "Set --north-star on the milestone or abandon it with a reason.",
        milestone: milestone.slug,
      });
    }
  }
  const text = issues.length ? ["Milestone grooming warnings:", ...issues.map((issue) => `- ${issue.code} ${issue.milestone ? `[${issue.milestone}] ` : ""}${issue.card ? `[card:${issue.card}] ` : ""}${issue.message} ${issue.hint}`)].join("\n") : "Milestone grooming: healthy — no warnings.";
  return { issues, text };
}

/** Deterministic portfolio gap status for factory-fill / milestone-driver. */
export type MilestoneGapStatus =
  | "complete"
  | "abandoned"
  | "no_north_star"
  | "blocked"
  | "in_flight"
  | "idle_promoteable"
  | "idle_empty"
  | "idle_blocked"
  | "proof_pending"
  | "proof_ready";

export type MilestoneGapAction =
  | "skip"
  | "promote"
  | "decompose"
  | "await_proof"
  | "complete_proof";

export type MilestoneGapEntry = {
  slug: string;
  title: string;
  north_star: string;
  state: string;
  status: MilestoneGapStatus;
  action: MilestoneGapAction;
  pr_todo: number;
  pr_doing: number;
  pr_backlog: number;
  pr_done: number;
  pr_live: number;
  /** Unblocked Kind:pr in backlog with substantive brief + Repo — safe to move to todo. */
  promoteable: string[];
  /** Kind:pr in backlog that are dep-blocked, held, hollow, or body-stopped. */
  blocked_backlog: string[];
  has_proof_card: boolean;
  proof_passing: boolean;
  reason: string;
};

export type MilestoneGapReport = {
  generated_at: string;
  board?: string;
  counts: Record<MilestoneGapStatus, number>;
  action_counts: Record<MilestoneGapAction, number>;
  milestones: MilestoneGapEntry[];
  /** Ordered work queue for the driver: promote first, then decompose. */
  work_queue: Array<{ slug: string; action: "promote" | "decompose"; promoteable: string[] }>;
};

const BODY_STOP_RE = /STOPPED by Tom|resume only by explicit direction|resume only after explicit/i;

/**
 * Pure classifier: given one milestone + its board cards + dep-resolved child
 * statuses, decide gap status. Exported for unit tests.
 */
export function classifyMilestoneGap(
  milestone: Milestone,
  boardCards: Card[],
  childStatuses: MilestoneChildStatus[],
  proof: { slug: string; terminal: boolean; passingEvidence: boolean } | null,
): MilestoneGapEntry {
  const bySlug = new Map(boardCards.map((card) => [card.slug, card]));
  const prChildren = childStatuses.filter((child) => {
    if (child.slug === milestone.proof_card) return false;
    const card = bySlug.get(child.slug);
    return card ? normalizeKind(card.kind) === "pr" : false;
  });

  let pr_todo = 0;
  let pr_doing = 0;
  let pr_backlog = 0;
  const promoteable: string[] = [];
  const blocked_backlog: string[] = [];

  for (const child of prChildren) {
    const card = bySlug.get(child.slug)!;
    const col = child.column;
    if (col === "todo") pr_todo += 1;
    else if (col === "doing") pr_doing += 1;
    else if (col === "backlog") {
      pr_backlog += 1;
      const hold = normalizeBlockStatus(card.block_status) !== "none";
      const hollow = !isSubstantiveCardBody(card.body) || !hasPrWorkBrief(card.body);
      const stopped = BODY_STOP_RE.test(card.body ?? "");
      const noRepo = !(card.repo && String(card.repo).trim());
      if (!child.blocked && !hold && !hollow && !stopped && !noRepo) promoteable.push(child.slug);
      else blocked_backlog.push(child.slug);
    }
  }
  const pr_done = prChildren.filter((c) => c.column !== "todo" && c.column !== "doing" && c.column !== "backlog").length;
  const pr_live = pr_todo + pr_doing + pr_backlog;
  const has_proof_card = Boolean(milestone.proof_card);
  const proof_passing = Boolean(proof?.passingEvidence && (proof.terminal || milestone.proof_status === "passing"));

  const base = {
    slug: milestone.slug,
    title: milestone.title,
    north_star: milestone.north_star || "",
    state: milestone.state,
    pr_todo,
    pr_doing,
    pr_backlog,
    pr_done,
    pr_live,
    promoteable,
    blocked_backlog,
    has_proof_card,
    proof_passing,
  };

  if (milestone.state === "complete") {
    return { ...base, status: "complete", action: "skip", reason: "milestone is complete" };
  }
  if (milestone.state === "abandoned") {
    return { ...base, status: "abandoned", action: "skip", reason: "milestone is abandoned" };
  }
  if (!milestone.north_star?.trim()) {
    return { ...base, status: "no_north_star", action: "skip", reason: "no north_star set — out of gap-fill scope" };
  }
  if (milestone.state === "blocked") {
    return { ...base, status: "blocked", action: "skip", reason: milestone.block_reason || "milestone state is blocked" };
  }
  if (pr_todo > 0 || pr_doing > 0) {
    return {
      ...base,
      status: "in_flight",
      action: "skip",
      reason: `live Kind:pr in todo=${pr_todo} doing=${pr_doing}`,
    };
  }

  // No live todo/doing PRs.
  if (pr_live === 0 && pr_done > 0 && !proof_passing) {
    if (proof?.passingEvidence) {
      return { ...base, status: "proof_ready", action: "complete_proof", reason: "implementation done; proof body has PASS evidence" };
    }
    return { ...base, status: "proof_pending", action: "await_proof", reason: "implementation Kind:pr done; terminal proof still pending" };
  }
  if (pr_live === 0 && pr_done === 0) {
    return {
      ...base,
      status: "idle_empty",
      action: "decompose",
      reason: has_proof_card
        ? "no Kind:pr children — needs next-gate decomposition into PR cards"
        : "no Kind:pr children and no proof card — needs proof link + next-gate PRs",
    };
  }
  if (pr_backlog > 0 && promoteable.length > 0) {
    return {
      ...base,
      status: "idle_promoteable",
      action: "promote",
      reason: `${promoteable.length} promoteable Kind:pr in backlog (no todo/doing)`,
    };
  }
  if (pr_backlog > 0 && promoteable.length === 0) {
    return {
      ...base,
      status: "idle_blocked",
      action: "skip",
      reason: "backlog Kind:pr exist but all are held, hollow, missing Repo, or dep-blocked",
    };
  }

  return {
    ...base,
    status: "idle_empty",
    action: "decompose",
    reason: "no feedable live Kind:pr frontier",
  };
}

export function buildMilestoneGapReport(
  reconciled: MilestoneReconcileResult[],
  boardCards: Card[],
  opts?: { board?: string },
): MilestoneGapReport {
  const emptyCounts = (): Record<MilestoneGapStatus, number> => ({
    complete: 0,
    abandoned: 0,
    no_north_star: 0,
    blocked: 0,
    in_flight: 0,
    idle_promoteable: 0,
    idle_empty: 0,
    idle_blocked: 0,
    proof_pending: 0,
    proof_ready: 0,
  });
  const emptyActions = (): Record<MilestoneGapAction, number> => ({
    skip: 0,
    promote: 0,
    decompose: 0,
    await_proof: 0,
    complete_proof: 0,
  });
  const counts = emptyCounts();
  const action_counts = emptyActions();
  const milestones: MilestoneGapEntry[] = [];

  for (const result of reconciled) {
    const entry = classifyMilestoneGap(
      result.milestone,
      boardCards.filter((c) => c.board === result.milestone.board),
      result.children,
      result.proof,
    );
    counts[entry.status] += 1;
    action_counts[entry.action] += 1;
    milestones.push(entry);
  }

  // Work queue: promote before decompose; stable order = portfolio order already in reconciled
  const work_queue: MilestoneGapReport["work_queue"] = [];
  for (const entry of milestones) {
    if (entry.action === "promote") work_queue.push({ slug: entry.slug, action: "promote", promoteable: entry.promoteable });
  }
  for (const entry of milestones) {
    if (entry.action === "decompose") work_queue.push({ slug: entry.slug, action: "decompose", promoteable: [] });
  }

  return {
    generated_at: nowIso(),
    board: opts?.board,
    counts,
    action_counts,
    milestones,
    work_queue,
  };
}

export async function milestoneGapReportResult(opts: {
  cfg: Config;
  node: NodeClient;
  board?: string;
}): Promise<{ report: MilestoneGapReport; text: string }> {
  const snapshot = await milestonePortfolioSnapshot(opts);
  const report = buildMilestoneGapReport(snapshot.reconciled, snapshot.cards, { board: opts.board });
  const lines = [
    `Milestone gap-report  (generated ${report.generated_at})`,
    `counts: in_flight=${report.counts.in_flight} idle_promoteable=${report.counts.idle_promoteable} idle_empty=${report.counts.idle_empty} idle_blocked=${report.counts.idle_blocked} proof_pending=${report.counts.proof_pending} proof_ready=${report.counts.proof_ready} complete=${report.counts.complete} no_north_star=${report.counts.no_north_star} blocked=${report.counts.blocked}`,
    `actions: promote=${report.action_counts.promote} decompose=${report.action_counts.decompose} await_proof=${report.action_counts.await_proof} complete_proof=${report.action_counts.complete_proof} skip=${report.action_counts.skip}`,
    `work_queue (${report.work_queue.length}):`,
    ...(report.work_queue.length
      ? report.work_queue.map((w) => `  • ${w.action.padEnd(10)} ${w.slug}${w.promoteable.length ? `  [${w.promoteable.join(", ")}]` : ""}`)
      : ["  —"]),
    "",
    "STATUS            MILESTONE                         NSTAR                    TODO DOING BLOG DONE ACTION",
    ...report.milestones
      .filter((m) => m.state !== "complete" && m.state !== "abandoned")
      .map((m) =>
        `${m.status.padEnd(17)} ${m.slug.slice(0, 32).padEnd(33)} ${(m.north_star || "—").slice(0, 24).padEnd(25)} ${String(m.pr_todo).padEnd(4)} ${String(m.pr_doing).padEnd(5)} ${String(m.pr_backlog).padEnd(4)} ${String(m.pr_done).padEnd(4)} ${m.action}`,
      ),
  ];
  return { report, text: lines.join("\n") };
}
