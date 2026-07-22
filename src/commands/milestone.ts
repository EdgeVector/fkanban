import { FkanbanError, type NodeClient } from "../client.ts";
import type { Config } from "../config.ts";
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

export function hasPassingProofEvidence(body: string): boolean {
  return /^[ \t]*(?:PROOF|RESULT):[ \t]*PASS[ \t]*$/im.test(body);
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
  const incomplete = childStatuses.filter((child) => child.column !== (terminals.get(milestone.board) ?? "done") && child.slug !== milestone.proof_card);
  const inFlight = incomplete.some((child) => child.column === "doing");
  if (milestone.state === "active" && incomplete.length > 0 && ready.length === 0 && !inFlight) warnings.push({ code: "active-no-ready-card", message: "Active milestone has implementation work but no ready or in-flight card frontier.", hint: "Resolve dependencies/holds or promote the next implementation card to todo." });
  if (incomplete.length === 0 && milestone.state !== "complete" && (!proof?.terminal || !proof.passingEvidence || milestone.proof_status !== "passing")) warnings.push({ code: "implementation-done-proof-pending", message: "Implementation is done but terminal passing proof is still pending.", hint: "Run the proof, record `PROOF: PASS`, mark its status passing, then complete the milestone." });
  if (milestone.state === "complete" && childStatuses.some((child) => child.column !== (terminals.get(milestone.board) ?? "done"))) warnings.push({ code: "complete-has-active-cards", message: "Complete milestone still has non-terminal child cards.", hint: "Reopen the milestone or finish/abandon the remaining cards." });
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
    if (!card.milestone) continue;
    const milestone = bySlug.get(card.milestone);
    if (!milestone) issues.push({ code: "missing-milestone", message: `Card links to missing milestone "${card.milestone}".`, hint: "Repair or clear the card milestone link.", card: card.slug });
    else if (card.board !== milestone.board || (card.north_star && milestone.north_star && card.north_star !== milestone.north_star)) issues.push({ code: "milestone-link-mismatch", message: "Card board or North Star does not match its milestone.", hint: "Align the card and milestone relationship.", milestone: milestone.slug, card: card.slug });
  }
  const text = issues.length ? ["Milestone grooming warnings:", ...issues.map((issue) => `- ${issue.code} ${issue.milestone ? `[${issue.milestone}] ` : ""}${issue.card ? `[card:${issue.card}] ` : ""}${issue.message} ${issue.hint}`)].join("\n") : "Milestone grooming: healthy — no warnings.";
  return { issues, text };
}
