import { FkanbanError, type NodeClient } from "../client.ts";
import type { Config } from "../config.ts";
import { keyRows, requireMultiKey } from "../multi-key.ts";
import { CARD_FIELDS } from "../schemas.ts";
import type { MilestoneAddResult, MilestoneStateResult } from "../format.ts";
import {
  PARTITION_READ_CONCURRENCY,
  POINT_READ_CONCURRENCY,
  mapWithConcurrency,
} from "../concurrency.ts";
import {
  hasPassingProofEvidence,
  milestoneProofVerdict,
  proofVerdictNote,
  type MilestoneProofVerdict,
  type MilestoneProofVerdictReason,
  type MilestoneProofVerdictResult,
} from "../milestone_proof.ts";
import {
  MILESTONE_PROOF_STATUSES,
  MILESTONE_STATES,
  ensureBoardRecord,
  TERMINAL_COLUMN,
  cardExists,
  depStatus,
  findCard,
  findProofCard,
  findMilestone,
  isMilestoneState,
  listBoards,
  listCardsOnBoard,
  listDependencyStatusesForCards,
  listMilestones,
  listMilestonesOnBoard,
  hasPrWorkBrief,
  includePointReadableReferencedMilestones,
  isBodyOmitted,
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
  rowToCard,
  BODY_OMITTED,
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

// The CLI and MCP return the same status and proof fields.
export function milestoneReconcilePayload(result: MilestoneReconcileResult): MilestoneReconcileResult {
  return {
    milestone: result.milestone,
    children: result.children,
    ready: result.ready,
    proof: result.proof,
    warnings: result.warnings,
    proof_verdict: result.proof_verdict,
    proof_verdict_reason: result.proof_verdict_reason,
  };
}

export type MilestoneReconcileResult = {
  milestone: Milestone;
  children: MilestoneChildStatus[];
  ready: MilestoneChildStatus[];
  proof: { slug: string; terminal: boolean; passingEvidence: boolean } | null;
  warnings: MilestoneWarning[];
  /**
   * The LIVE proof answer, re-derived from the proof card on this read —
   * `unproven` where `milestone.proof_status` claims `passing` and the evidence
   * no longer holds. Machine-readable on purpose: a consumer gating on proof
   * (the milestone-driver's completion check) needs one field to read, not a
   * prose `warnings[]` array to pattern-match. See `../milestone_proof.ts`.
   */
  proof_verdict: MilestoneProofVerdict;
  proof_verdict_reason: MilestoneProofVerdictReason;
};

export type MilestonePortfolioEntry = {
  slug: string;
  title: string;
  north_star: string;
  state: string;
  driver: string;
  proof_card: string;
  /** The operator's recorded claim, verbatim. */
  proof_status: string;
  /** The live re-derived answer — `unproven` when the claim has lost its evidence. */
  proof_verdict: MilestoneProofVerdict;
  proof_verdict_reason: MilestoneProofVerdictReason;
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

/** Lifecycle targets the state CLI will accept from `from` with this proof_status. */
export function allowedMilestoneTransitions(from: string, proofStatus: string): string[] {
  const allowed = [...(ALLOWED_TRANSITIONS[from] ?? [])];
  // not_required skips the proving phase (no harness to exercise).
  if (from === "active" && proofStatus === "not_required") {
    allowed.push("complete");
  }
  return allowed;
}

export function canMilestoneTransition(from: string, to: string, proofStatus: string): boolean {
  if (from === to) return true;
  return allowedMilestoneTransitions(from, proofStatus).includes(to);
}

// The terminal-proof EVIDENCE predicates moved to `../milestone_proof.ts`, next
// to the derived verdict that re-runs them on every read. They are re-exported
// here because this module was their published home — `proofGate` and the
// existing tests import them from this path.
export { doneWhenFileProofSatisfied, hasPassingProofEvidence } from "../milestone_proof.ts";

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

/**
 * Validate the links THIS WRITE SUPPLIES — never the ones it merely inherited.
 *
 * `milestoneAddCmd` rebuilds the whole record on every write, inheriting each
 * field the caller omitted. Validating that whole record made every write
 * re-litigate `proof_card` and `deps` values the caller never mentioned, so a
 * milestone whose proof card was later deleted became UNWRITABLE — not "cannot
 * enter complete", but unwritable, rejected by an error naming a card the
 * caller never supplied. `complete → active` is the only exit from `complete`,
 * and it was refused too, so the record was frozen precisely when it most
 * needed to be annotated as broken. Measured on the live primary 2026-08-03:
 * **20 of 41 milestones could not be moved to `active`**
 * (`scripts/probe-milestone-frozen-by-inherited-link.ts`, arm B).
 *
 * Skipping inherited links loses nothing, because a dangling link only MEANS
 * anything at the transitions that claim proof, and those are gated separately
 * and more strictly:
 *
 *   - `proofGate` runs on every `proving`/`complete` target and checks
 *     existence, ownership, `kind=validation`, terminal column, and a
 *     machine-readable `PROOF: PASS`. It is a superset of the check removed
 *     here, so the "you cannot claim proof without proof" rule is untouched.
 *   - Milestone `deps` gate no transition at all — they are validated on the
 *     write that supplies them and otherwise only rendered.
 *
 * So an inherited dangling link can now ride along on a `blocked`/`abandoned`/
 * `active` write, which is exactly right: those states claim no proof, and
 * refusing them is what stranded the record.
 */
async function validateLinks(opts: MilestoneAddOptions, milestone: Milestone): Promise<void> {
  // `undefined` means "caller omitted it, value inherited"; a supplied `[]` is a
  // deliberate clear and still goes through the loop (which then does nothing).
  if (opts.deps !== undefined) {
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
  }
  // Existence is a KEY-ONLY question, so ask it with a key-only read. `findCard`
  // projects ~20 fields. Under the measured HASH-ELSE-LEAD rule a sparse Card
  // (hash `slug` present, optional fields absent) still returns from a wide
  // read — the superseded `any_missing` model is not current node truth (see
  // {@link cardExists}). `cardExists` still projects `slug` alone so a
  // post-delete husk (hash key only) cannot false-negative as "gone" inside the
  // settle window; gating a write on a wide-only miss was the old bug path.
  //
  // Still checked whenever the caller NAMES a proof card — linking a card that
  // is not there is a typo worth catching at the moment it is made, and that is
  // the error's actual audience.
  if (opts.proofCard !== undefined && milestone.proof_card && !(await cardExists(opts.node, opts.cfg, milestone.proof_card))) {
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
  // Complete-without-harness path: all implementation PRs done and no product
  // proof card is the preferred alternative to minting hollow Kind:validation
  // shells (milestone-driver contract). proving always needs a real proof card.
  if (target === "complete" && milestone.proof_status === "not_required") {
    return;
  }
  if (!milestone.proof_card) {
    throw new FkanbanError({
      code: "milestone_proof_card_required",
      message: `Milestone "${milestone.slug}" cannot enter ${target} without a proof card.`,
      hint:
        target === "complete"
          ? "Link a validation card with --proof-card, or complete with --proof-status not_required when no executable harness exists."
          : "Link a live validation card with --proof-card, then retry.",
    });
  }
  // This one genuinely needs the fields (board/milestone/kind below), so it stays
  // a wide read — but a wide read that MISSES must not be reported as "not
  // found". Confirm absence with a key-only read first, so a sparse card gets an
  // error that names the real problem instead of sending the operator hunting for
  // a card that is right there.
  const proof = await findCard(opts.node, opts.cfg, milestone.proof_card);
  if (!proof) {
    if (await cardExists(opts.node, opts.cfg, milestone.proof_card)) {
      throw new FkanbanError({
        code: "milestone_proof_card_unreadable",
        message: `Proof card "${milestone.proof_card}" exists but could not be read in full.`,
        hint:
          "The card is missing one or more indexed fields, so the wide read that gates this" +
          " transition drops it. Repair it with `kanban show " +
          milestone.proof_card +
          "` then re-save the card, or run `kanban groom board-cards-heal --slug " +
          milestone.proof_card +
          " --apply`.",
      });
    }
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
  if (proof.column !== TERMINAL_COLUMN) {
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
      hint: "Set --proof-status passing and make the LAST verdict line on the terminal proof card a PASS (`PROOF: PASS`, `PROOF: passed — …`, `RESULT: PASS`, or `PROOF[pass…]: …`). A later FAIL line withdraws an earlier PASS.",
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
  const allowed = allowedMilestoneTransitions(from, milestone.proof_status);
  if (from !== to && !canMilestoneTransition(from, to, milestone.proof_status)) {
    throw new FkanbanError({
      code: "invalid_milestone_transition",
      message: `Milestone "${milestone.slug}" cannot transition ${from} → ${to}.`,
      hint: `Allowed from ${from}: ${allowed.join(", ") || "none"}.`,
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

export async function milestoneAddCmd(opts: MilestoneAddOptions): Promise<MilestoneAddResult> {
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
  // Report every field this write moved that the CALLER never named. Both of
  // these are deliberate rules, and both were invisible: the result type could
  // only say `state`, so a lifecycle move and a driver rewrite left the same
  // confirmation as a no-op rename. Sourced from the written object (`milestone`)
  // against the pre-write read (`existing`), never from the caller's intent.
  const stateCoerced = opts.state === undefined && existing !== null && existing.state !== milestone.state
    ? {
      from: existing.state,
      to: milestone.state,
      reason: "a failing proof must return the milestone to active",
    }
    : undefined;
  const driverHealed = opts.driver === undefined && existing !== null
    && existing.driver !== "" && existing.driver !== milestone.driver
    ? { from: existing.driver, to: milestone.driver }
    : undefined;
  return {
    slug: milestone.slug,
    action: existing ? "updated" : "created",
    state: milestone.state,
    ...(stateCoerced ? { stateCoerced } : {}),
    ...(driverHealed ? { driverHealed } : {}),
  };
}

/**
 * `verdict` is optional because two callers render a milestone without having
 * re-read its proof card, and a MISSING verdict must not be silently rendered as
 * a passing one. When it is absent the proof line is unchanged; when it is
 * present and disagrees with the stored claim, the disagreement is printed
 * directly under the claim rather than left for the reader to notice.
 */
export function renderMilestone(milestone: Milestone, verdict?: MilestoneProofVerdictResult): string {
  const note = verdict ? proofVerdictNote(milestone, verdict) : null;
  return [
    `${milestone.title}  (${milestone.slug})`,
    `state: ${milestone.state}`,
    `board: ${milestone.board}`,
    `north star: ${milestone.north_star || "—"}`,
    `driver: ${milestone.driver || "—"}`,
    `proof: ${milestone.proof_status}${milestone.proof_card ? ` · ${milestone.proof_card}` : ""}`,
    ...(note ? [`  ${note}`] : []),
    `dependencies: ${milestone.deps.length ? milestone.deps.join(", ") : "—"}`,
    ...(milestone.block_reason ? [`blocked: ${milestone.block_reason}`] : []),
    ...(milestone.body ? ["", milestone.body] : []),
  ].join("\n");
}

export async function milestoneListResult(opts: { cfg: Config; node: NodeClient; board?: string; state?: string }): Promise<{ text: string; milestones: Milestone[] }> {
  if (opts.state) validateState(opts.state);
  let source: Milestone[];
  if (opts.board) {
    const [indexed, cards] = await Promise.all([
      listMilestonesOnBoard(opts.node, opts.cfg, opts.board),
      listCardsOnBoard(opts.node, opts.cfg, opts.board),
    ]);
    source = await includePointReadableReferencedMilestones(
      opts.node,
      opts.cfg,
      indexed,
      cards,
      { board: opts.board },
    );
  } else {
    const boards = await listBoards(opts.node, opts.cfg);
    const [indexed, cardParts] = await Promise.all([
      listMilestones(opts.node, opts.cfg, { boards }),
      mapWithConcurrency(
        boards,
        (board) => listCardsOnBoard(opts.node, opts.cfg, board.slug),
        PARTITION_READ_CONCURRENCY,
      ),
    ]);
    source = await includePointReadableReferencedMilestones(
      opts.node,
      opts.cfg,
      indexed,
      cardParts.flat(),
    );
  }
  const milestones = source.filter((m) => !opts.state || m.state === opts.state);
  const text = milestones.length
    ? milestones.map((m) => `${m.state.padEnd(9)} ${m.slug} — ${m.title}${m.proof_card ? ` [proof:${m.proof_status}]` : ""}`).join("\n")
    : "No milestones.";
  return { text, milestones };
}

/**
 * One milestone, with its proof claim RE-CHECKED against the card it names.
 *
 * This is the cheap single-milestone read — it deliberately does not reconcile
 * children, read the board, or touch MilestoneCards, and it must stay that way.
 * The one read it now pays for is `findProofCard` (~120ms, six fields), and only
 * when the milestone actually claims `passing`: `milestoneProofVerdict` returns
 * `not_required`/`not-claimed` without consulting the card at all, so the common
 * pending and not_required cases cost exactly what they used to.
 *
 * Paying it is not optional. `show` was the ONLY milestone read path that
 * recomputed nothing, which made it the only one that could not contradict a
 * stale `proof_status` — and it is the one an agent reaches for first, and the
 * one behind `fkanban_milestone_show`. A cheap read that answers wrong is not a
 * cheaper read.
 *
 * The key-only `cardExists` follow-up is paid only when the wide read came back
 * empty, mirroring the reconcile path: that is the sole case where "absent" and
 * "sparse" are in question, and telling them apart is the difference between
 * sending the operator to recreate a card and sending them to heal one.
 */
export async function milestoneShowResult(opts: { cfg: Config; node: NodeClient; slug: string }): Promise<{
  text: string;
  milestone: Milestone;
  proof_verdict: MilestoneProofVerdict;
  proof_verdict_reason: MilestoneProofVerdictReason;
}> {
  const milestone = await requireMilestone(opts.node, opts.cfg, opts.slug);
  const needsEvidence = milestone.proof_status === "passing" && Boolean(milestone.proof_card);
  const proofCard = needsEvidence ? await findProofCard(opts.node, opts.cfg, milestone.proof_card) : null;
  const proofCardSparse = needsEvidence && !proofCard
    && (await cardExists(opts.node, opts.cfg, milestone.proof_card));
  const verdict = milestoneProofVerdict(milestone, proofCard, proofCardSparse);
  return {
    text: renderMilestone(milestone, verdict),
    milestone,
    proof_verdict: verdict.verdict,
    proof_verdict_reason: verdict.reason,
  };
}

export async function milestoneStateCmd(opts: { cfg: Config; node: NodeClient; slug: string; state: string; proofStatus?: string }): Promise<MilestoneStateResult> {
  validateState(opts.state);
  if (opts.proofStatus) validateProofStatus(opts.proofStatus);
  const existing = await requireMilestone(opts.node, opts.cfg, opts.slug);
  // planned → complete in one guarded call. Nothing used to move a milestone
  // planned → active, so a planned milestone whose Kind:pr work all merged
  // could never close (brain
  // `papercut-milestone-complete-proof-skipped-state-planned-20260924`).
  // The hop is taken ONLY when `complete` is legal from `active` with the
  // effective proof status — today that is `not_required`, whose proof gate is
  // a no-op — so the intermediate `active` write can never strand a milestone
  // that the `complete` write then refuses. Any other planned → complete still
  // fails with the ordinary invalid_milestone_transition error.
  const effectiveProofStatus = opts.proofStatus ?? existing.proof_status;
  const hopViaActive = existing.state === "planned"
    && opts.state === "complete"
    && canMilestoneTransition("active", "complete", effectiveProofStatus);
  if (hopViaActive) {
    await milestoneAddCmd({ cfg: opts.cfg, node: opts.node, slug: opts.slug, state: "active", proofStatus: opts.proofStatus });
  }
  const written = await milestoneAddCmd({ cfg: opts.cfg, node: opts.node, slug: opts.slug, state: opts.state, proofStatus: opts.proofStatus });
  const updated = await requireMilestone(opts.node, opts.cfg, opts.slug);
  // `proof_status_from` comes from the pre-write read, so a transition whose
  // state is unchanged can still say what it changed. `driverHealed` is
  // forwarded rather than recomputed: the inner write is the one that healed it,
  // and re-deriving it here would be a second source of the same claim.
  return {
    slug: opts.slug,
    from: existing.state,
    to: updated.state,
    proof_status: updated.proof_status,
    proof_status_from: existing.proof_status,
    ...(hopViaActive ? { via: "active" } : {}),
    ...(written.driverHealed ? { driverHealed: written.driverHealed } : {}),
  };
}

// Membership belongs to the Card schema. Reconcile derives status and never repairs payload copies.
export async function milestoneReconcileResult(opts: {
  cfg: Config; node: NodeClient; slug: string;
}): Promise<MilestoneReconcileResult & { text: string; boards: Board[] }> {
  requireMultiKey(opts.cfg);
  const milestone = await requireMilestone(opts.node, opts.cfg, opts.slug);
  const [rows, boards, proofCard] = await Promise.all([
    keyRows(opts.node, opts.cfg.schemaHashes.card!, "by_milestone", { HashKey: milestone.slug },
      CARD_FIELDS.filter(field => field !== "body")),
    listBoards(opts.node, opts.cfg),
    milestone.proof_card ? findProofCard(opts.node, opts.cfg, milestone.proof_card) : Promise.resolve(null),
  ]);
  const children = rows.map(row => {
    const card = rowToCard(row);
    if (card.slug !== row.key.hash || card.milestone !== milestone.slug
      || card.board !== milestone.board || row.matched_key.hash !== milestone.slug) {
      throw new FkanbanError({ code: "multi_key_membership_mismatch",
        message: "The milestone key returned a record outside its declared membership." });
    }
    card[BODY_OMITTED] = true;
    return card;
  });
  // The empty-milestone warning needs other completed cards from the same board.
  // Read that key only when no implementation child exists.
  const [statuses, boardCards, proofCardSparse] = await Promise.all([
    listDependencyStatusesForCards(opts.node, opts.cfg, children),
    children.some(card => card.slug !== milestone.proof_card)
      ? Promise.resolve([]) : listCardsOnBoard(opts.node, opts.cfg, milestone.board),
    milestone.proof_card && !proofCard ? cardExists(opts.node, opts.cfg, milestone.proof_card) : Promise.resolve(false),
  ]);
  const result = milestoneReconcileFromSnapshot(milestone, children, statuses, proofCard,
    proofCardSparse, northStarOnlyDoneCards(milestone, boardCards));
  return { ...result, boards, text: renderMilestoneReconcile(result) };
}

export function milestoneReconcileFromSnapshot(
  milestone: Milestone,
  boardCards: Card[],
  statuses: Card[],
  proofCard: Card | null,
  // The proof card exists (key-only read found it) but the wide read that
  // produced `proofCard` dropped it — a sparse record, not a missing one. The
  // two need different warnings, or the report sends the operator to recreate a
  // card that is sitting right there. Defaults false so a caller that hasn't
  // checked keeps the old, conservative "missing" wording.
  proofCardSparse = false,
  // Done Kind:pr under the same North Star that no milestone claims — see
  // `northStarOnlyDoneCards`. Callers pass only the milestone's own children as
  // `boardCards`, so this evidence has to arrive separately. Defaults empty so
  // a caller that has not looked keeps the old read.
  nsOnlyDone: Card[] = [],
): MilestoneReconcileResult {
  const children = boardCards.filter((card) => card.milestone === milestone.slug);
  const childStatuses = children.map((card): MilestoneChildStatus => {
    const dep = depStatus(card, statuses);
    return { slug: card.slug, title: card.title, column: card.column, blocked: dep.blocked, blockedBy: dep.blockedBy };
  });
  const bySlug = new Map(children.map((card) => [card.slug, card]));
  const ready = childStatuses.filter((status) => {
    const card = bySlug.get(status.slug)!;
    return status.column === "todo" && !status.blocked && normalizeKind(card.kind) === "pr" && normalizeBlockStatus(card.block_status) === "none";
  });
  const proof = proofCard ? {
    slug: proofCard.slug,
    terminal: proofCard.column === TERMINAL_COLUMN,
    passingEvidence: hasPassingProofEvidence(proofCard.body),
  } : null;
  const warnings: MilestoneWarning[] = [];
  if (!milestone.driver) warnings.push({ code: "no-driver", message: "Milestone has no reconciliation driver.", hint: "Assign --driver to a person, agent, or routine." });
  if (!milestone.proof_card) {
    if (milestone.proof_status !== "not_required") {
      warnings.push({
        code: "no-proof-card",
        message: "Milestone has no terminal proof card.",
        hint: "Create and link a validation card with --proof-card, or set --proof-status not_required when no harness exists.",
      });
    }
  } else if (!proofCard && proofCardSparse) warnings.push({ code: "unreadable-proof-card", message: `Linked proof card "${milestone.proof_card}" exists but could not be read in full.`, hint: `The card is missing one or more indexed fields, so wide reads drop it. Re-save it, or run \`kanban groom board-cards-heal --slug ${milestone.proof_card} --apply\`.` });
  else if (!proofCard) warnings.push({ code: "missing-proof-card", message: `Linked proof card "${milestone.proof_card}" is missing.`, hint: "Repair the proof link before proving." });
  else if (proofCard.board !== milestone.board || proofCard.milestone !== milestone.slug) warnings.push({ code: "proof-card-mismatch", message: "Proof card board or milestone link does not match.", hint: "Align the proof card's --board and --milestone fields." });
  if (milestone.state === "blocked" && !milestone.block_reason) warnings.push({ code: "blocked-no-reason", message: "Blocked milestone has no reason.", hint: "Add --block-reason or return it to active." });
  const terminalCol = TERMINAL_COLUMN;
  // Non-proof children still open (not in the board terminal column).
  const incomplete = childStatuses.filter((child) => child.column !== terminalCol && child.slug !== milestone.proof_card);
  // Implementation children = any non-proof child. Empty milestone ≠ "implementation done".
  const implementationChildren = childStatuses.filter((child) => child.slug !== milestone.proof_card);
  const hasImplementationWork = implementationChildren.length > 0;
  const allImplementationDone = hasImplementationWork && incomplete.length === 0;
  const inFlight = incomplete.some((child) => child.column === "doing");
  // A `children=[]` read that disagrees with the board: done Kind:pr sit under
  // this North Star with no milestone link. Said here, on the read the driver
  // actually runs (`milestone detail` → this snapshot), so the evidence is on
  // the same screen as the empty column list instead of one brain get away.
  if (!hasImplementationWork && nsOnlyDone.length > 0 && milestone.state !== "complete" && milestone.state !== "abandoned") {
    warnings.push({
      code: "ns-only-done-evidence",
      message: `No child cards link this milestone, but ${nsOnlyDone.length} done Kind:pr under north_star=${milestone.north_star} set no milestone: ${nsOnlyDone.map((card) => card.slug).join(", ")}.`,
      hint: `Check them against the acceptance before decomposing; relink each that applies with \`kanban set <slug> --milestone ${milestone.slug}\`.`,
    });
  }
  if (milestone.state === "active" && incomplete.length > 0 && ready.length === 0 && !inFlight) warnings.push({ code: "active-no-ready-card", message: "Active milestone has implementation work but no ready or in-flight card frontier.", hint: "Resolve dependencies/holds or promote the next implementation card to todo." });
  // Only when real implementation work exists and is fully terminal, with proof still not PASS.
  // Zero children / proof-only milestones must NOT get this warning (false factory-fill poison).
  // not_required is an intentional complete path — do not keep this as a hang signal.
  if (
    allImplementationDone
    && milestone.state !== "complete"
    && milestone.proof_status !== "not_required"
    && (!proof?.terminal || !proof.passingEvidence || milestone.proof_status !== "passing")
  ) {
    warnings.push({
      code: "implementation-done-proof-pending",
      message: "Implementation is done but terminal passing proof is still pending.",
      hint: "Run the proof, record a PASS verdict line (`PROOF: PASS` / `PROOF: passed — …`), mark its status passing, then complete the milestone — or complete with --proof-status not_required when no harness exists.",
    });
  }
  if (milestone.state === "complete" && childStatuses.some((child) => child.column !== terminalCol)) warnings.push({ code: "complete-has-active-cards", message: "Complete milestone still has non-terminal child cards.", hint: "Reopen the milestone or finish/abandon the remaining cards." });
  // Derived from the SAME `proofCard`/`proofCardSparse` the warnings above were
  // built from, so the verdict and the warning list can never disagree about
  // what was read. The warnings say it in prose for a human; this says it in one
  // field for a driver.
  const verdict = milestoneProofVerdict(milestone, proofCard, proofCardSparse);
  return {
    milestone,
    children: childStatuses,
    ready,
    proof,
    warnings,
    proof_verdict: verdict.verdict,
    proof_verdict_reason: verdict.reason,
  };
}

function renderMilestoneReconcile(result: MilestoneReconcileResult): string {
  return [
    `${result.milestone.title} (${result.milestone.slug}) — ${result.milestone.state}`,
    `ready frontier: ${result.ready.length ? result.ready.map((card) => card.slug).join(", ") : "—"}`,
    `proof: ${result.proof ? `${result.proof.slug} · ${result.proof.terminal ? "terminal" : "not terminal"} · ${result.proof.passingEvidence ? "PASS" : "no PASS"}` : "—"}`,
    `proof verdict: ${result.proof_verdict}${result.proof_verdict === result.milestone.proof_status ? "" : ` (${result.proof_verdict_reason}; recorded "${result.milestone.proof_status}")`}`,
    ...(result.warnings.length ? ["warnings:", ...result.warnings.map((warning) => `- ${warning.code}: ${warning.message} ${warning.hint}`)] : ["warnings: none"]),
  ].join("\n");
}

async function milestonePortfolioSnapshot(opts: { cfg: Config; node: NodeClient; board?: string }): Promise<{
  milestones: Milestone[];
  /** Cards linked to some listed milestone by their `milestone` field. */
  cards: Card[];
  /** Every card on every board read — the superset `cards` was cut from. */
  board_cards: Card[];
  reconciled: MilestoneReconcileResult[];
}> {
  // ONE board list, then the milestone list and the card partitions run
  // CONCURRENTLY.
  //
  // `listBoards` used to run twice — once inside `listMilestones`, once here —
  // and the card read then waited on the milestone list purely to learn which
  // boards to ask for. That serialised boards → milestones → cards, and the
  // card partition is the single most expensive read in the command (789ms
  // measured), so it landed squarely on the critical path: this command got
  // 15-20% SLOWER in wall clock when it started reading the board, even as its
  // node time fell 32-40%.
  //
  // `listBoards` already names every board, so which partitions to FETCH is
  // knowable before the milestone list comes back — the milestone list only
  // decides which rows to KEEP. Fetching them in parallel with it takes the
  // 789ms off the critical path entirely.
  //
  // The cost is honest and bounded: without a `--board` filter this reads the
  // card partition of every board, including boards no milestone lives on. That
  // is one keyed partition read each (on this fleet: `default` 318 cards,
  // `agent-dogfood-scratch` 53), against the 31 keyed reads this path used to
  // issue. With `--board` there is no speculation at all.
  const boards = await listBoards(opts.node, opts.cfg);
  const boardSlugs = opts.board ? [opts.board] : boards.map((board) => board.slug);
  //
  // POOLED, not `Promise.all`. Each of these is a whole-partition read — the
  // heavy class — and this is the one board fan-out in the codebase that had no
  // width at all: `listAllBoardCards` pools the identical shape at
  // `PARTITION_READ_CONCURRENCY` precisely because Mini sheds with "too many
  // concurrent reads". Inert at the two boards this node carries today, which is
  // exactly why it survived; the comment above already contemplates reading
  // "the card partition of every board", and `board-cards.ts` records this node
  // having carried 34 Board slugs at once. A width's job is to still be right
  // when that count grows, and here there was none.
  //
  // Started-not-awaited is preserved deliberately: `mapWithConcurrency` runs
  // synchronously up to its internal `await`, so the first `width` reads are
  // already in flight when this returns. Wrapping it in a lazy thunk would put
  // the board read back on the critical path the comment above took it off.
  const boardCardsPending = mapWithConcurrency(
    boardSlugs,
    async (slug): Promise<[string, Card[]]> =>
      [slug, await listCardsOnBoard(opts.node, opts.cfg, slug)],
    PARTITION_READ_CONCURRENCY,
  );

  let milestones = opts.board
    ? await listMilestonesOnBoard(opts.node, opts.cfg, opts.board)
    : await listMilestones(opts.node, opts.cfg, { boards });
  // One board key supplies current Card records for every milestone on that board.
  // Dedupe the proof slugs BEFORE the fan-out. The previous
  // `if (!proofs.has(slug)) proofs.set(slug, await findCard(...))` inside a
  // `Promise.all` was a check-then-act race: the `has` guard runs before any
  // `set` lands, so two milestones sharing one proof card both point-read it.
  // Live on this board today — `search-as-app-ns-terminal-verification` is the
  // proof card for two milestones, and cost 29 reads for 28 distinct slugs.
  //
  // Started before the board read is awaited: proof cards are keyed by slug off
  // the milestone list alone, so they have no reason to queue behind board
  // membership. Left sequential, the board read would simply be added to the
  // command's critical path.
  const boardCards = new Map<string, Card[]>(await boardCardsPending);
  const knownCards = [...boardCards.values()].flat();
  milestones = await includePointReadableReferencedMilestones(
    opts.node,
    opts.cfg,
    milestones,
    knownCards,
    opts.board ? { board: opts.board } : {},
  );
  const proofSlugs = [...new Set(milestones.map((milestone) => milestone.proof_card).filter((slug) => slug))];
  //
  // Pooled for the same reason, at the POINT width rather than the partition
  // one: these are keyed single-row reads. Width buys little now that the
  // per-request floor has collapsed (see `POINT_READ_CONCURRENCY` — ~6ms across
  // an 18-slug fan-out), so this is a shed guard, not a speedup. 28 distinct
  // proof slugs are live on this board today and nothing bounds that number.
  const proofsPending = mapWithConcurrency(
    proofSlugs,
    async (slug): Promise<[string, Card | null]> =>
      [slug, await findProofCard(opts.node, opts.cfg, slug)],
    POINT_READ_CONCURRENCY,
  );

  const childLists = milestones.map((milestone) =>
    (boardCards.get(milestone.board) ?? []).filter((card) => card.milestone === milestone.slug));
  const cards = childLists.flat();
  // Every board card is already in hand, so a dep edge pointing at a same-board
  // card costs no point read.
  const statuses = await listDependencyStatusesForCards(opts.node, opts.cfg, cards, knownCards);
  const proofs = new Map<string, Card | null>(await proofsPending);
  // Slugs whose wide read missed but whose key-only read found them: sparse, not
  // absent. The key-only read is only issued for the slugs actually in question.
  const sparseProofs = new Set<string>();
  // Pooled: worst case this is one `cardExists` per proof slug — the whole map,
  // when every wide read missed, which is the live shape on this board (19 of 22
  // proof refs dangle). So the unbounded arm was widest exactly when the board
  // was in its worst state.
  await mapWithConcurrency(
    [...proofs.entries()],
    async ([slug, card]) => {
      if (!card && (await cardExists(opts.node, opts.cfg, slug))) sparseProofs.add(slug);
    },
    POINT_READ_CONCURRENCY,
  );
  return {
    milestones,
    cards,
    board_cards: knownCards,
    reconciled: milestones.map((milestone, i) =>
      milestoneReconcileFromSnapshot(
        milestone,
        childLists[i] ?? [],
        statuses,
        proofs.get(milestone.proof_card) ?? null,
        sparseProofs.has(milestone.proof_card),
        northStarOnlyDoneCards(milestone, boardCards.get(milestone.board) ?? []),
      )),
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
    proof_verdict: result.proof_verdict,
    proof_verdict_reason: result.proof_verdict_reason,
    ready: result.ready.map((card) => card.slug),
    blocker: result.milestone.state === "blocked" ? (result.milestone.block_reason || "blocked with no reason") : (result.warnings[0]?.message ?? ""),
    warning_count: result.warnings.length,
  }));
  // The PROOF column shows the VERDICT, not the recorded claim. A status table
  // exists to answer "where does this actually stand", and printing `passing`
  // for 14 milestones whose evidence is gone made this table the single largest
  // source of that false answer on the board. The recorded claim is not lost —
  // it stays in `--json` as `proof_status`, and the BLOCKER column already names
  // why the verdict differs.
  const text = entries.length ? [
    "STATE      MILESTONE                         NORTH STAR              READY  PROOF       WARN  BLOCKER",
    ...entries.map((entry) => `${entry.state.padEnd(10)} ${entry.slug.slice(0, 32).padEnd(33)} ${(entry.north_star || "—").slice(0, 23).padEnd(24)} ${String(entry.ready.length).padEnd(6)} ${entry.proof_verdict.padEnd(11)} ${String(entry.warning_count).padEnd(5)} ${entry.blocker || "—"}`),
  ].join("\n") : "No milestones.";
  return { entries, text };
}

// Detail uses the same read and derives the fixed-column display.
export async function milestoneDetailResult(opts: { cfg: Config; node: NodeClient; slug: string }): Promise<{ detail: MilestoneReconcileResult & { columns: Record<string, MilestoneChildStatus[]> }; text: string }> {
  const result = await milestoneReconcileResult(opts);
  // Reconcile already read the board list (it needs terminal columns to decide
  // done-ness), so re-reading it here bought nothing and cost a whole extra
  // wave — ~190ms on an idle node — for bytes that were already in memory.
  const columns: Record<string, MilestoneChildStatus[]> = Object.fromEntries(result.boards.find((board) => board.slug === result.milestone.board)?.columns.map((column) => [column, result.children.filter((card) => card.column === column)]) ?? []);
  const detail = { ...milestoneReconcilePayload(result), columns };
  const columnText = Object.entries(columns).map(([column, cards]) => `${column.toUpperCase()} (${cards.length})\n${cards.length ? cards.map((card) => `  • ${card.blocked ? "🔒 " : ""}${card.title}  ${card.slug}`).join("\n") : "  —"}`).join("\n\n");
  return { detail, text: `${renderMilestone(result.milestone, { verdict: result.proof_verdict, reason: result.proof_verdict_reason })}\n\n${columnText}\n\n${renderMilestoneReconcile(result)}` };
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
  | "idle_ns_evidence"
  | "idle_blocked"
  | "proof_pending"
  | "proof_ready"
  | "needs_next_slice";

export type MilestoneGapAction =
  | "skip"
  | "promote"
  | "decompose"
  | "await_proof"
  | "complete_proof";

/**
 * Gap-report actions the milestone-driver will attempt. `complete_proof` is
 * the driver calling `milestone state complete --proof-status not_required`.
 * Operational actions (promote / decompose / await_proof) are not transitions,
 * but they are never legal on a terminal milestone.
 */
export function isMilestoneGapActionLegal(
  state: string,
  action: MilestoneGapAction,
): boolean {
  if (action === "skip") return true;
  if (state === "complete" || state === "abandoned") return false;
  if (action === "complete_proof") {
    // `milestone state <slug> complete --proof-status not_required` hops a
    // planned milestone through active in one guarded call (milestoneStateCmd).
    const from = state === "planned" ? "active" : state;
    return canMilestoneTransition(from, "complete", "not_required");
  }
  return true;
}

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
  /**
   * Done Kind:pr on the same board that set `north_star` to this milestone's
   * North Star but never set `milestone` at all. See
   * {@link northStarOnlyDoneCards} — these are the completion checkpoints a
   * `children=[]` read cannot see.
   */
  ns_only_done: string[];
  has_proof_card: boolean;
  proof_passing: boolean;
  /**
   * The milestone is `planned` and the action implies work has started. The
   * driver needs no extra call: card claims move a planned milestone to active,
   * and `milestone state <slug> complete --proof-status not_required` hops
   * planned → active → complete itself. The flag says the hop will happen.
   */
  activate_first?: boolean;
  /**
   * `decompose` because implementation slices merged but the acceptance is not
   * proven — file the NEXT slice or the proof card, not a first decomposition.
   */
  next_slice?: boolean;
  reason: string;
};

export type MilestoneGapReport = {
  generated_at: string;
  board?: string;
  counts: Record<MilestoneGapStatus, number>;
  action_counts: Record<MilestoneGapAction, number>;
  milestones: MilestoneGapEntry[];
  /** Ordered work queue for the driver: promote first, then decompose. */
  work_queue: MilestoneGapWorkItem[];
};

/**
 * One driver work item. `status`, `next_slice` and `activate_first` are copied
 * from the item's `milestones[]` row: a driver that reads only `work_queue`
 * must still tell a first decomposition from a next slice, and must know the
 * planned → active hop will happen
 * (papercut-fkanban-gap-report-work-queue-drops-next-slice-flag-20260926).
 */
export type MilestoneGapWorkItem = {
  slug: string;
  action: "promote" | "decompose" | "complete_proof";
  promoteable: string[];
  status: MilestoneGapStatus;
  next_slice?: boolean;
  activate_first?: boolean;
};

function gapWorkItem(entry: MilestoneGapEntry, action: MilestoneGapWorkItem["action"], promoteable: string[]): MilestoneGapWorkItem {
  const item: MilestoneGapWorkItem = { slug: entry.slug, action, promoteable, status: entry.status };
  if (entry.next_slice) item.next_slice = true;
  if (entry.activate_first) item.activate_first = true;
  return item;
}

const BODY_STOP_RE = /STOPPED by Tom|resume only by explicit direction|resume only after explicit/i;

function legalizeGapEntry(milestone: Milestone, entry: MilestoneGapEntry): MilestoneGapEntry {
  if (isMilestoneGapActionLegal(milestone.state, entry.action)) {
    return milestone.state === "planned" && entry.action !== "skip" && entry.pr_done > 0
      ? { ...entry, activate_first: true }
      : entry;
  }
  return {
    ...entry,
    action: "skip",
    reason: `${entry.reason} (skipped: ${entry.action} is not legal from state=${milestone.state})`,
  };
}

/**
 * Done Kind:pr cards under this milestone's North Star that no milestone
 * claims.
 *
 * A Kind:pr card is filed with `north_star` and, when a live milestone exists,
 * `milestone`. In practice the second field is often missing: the card was
 * filed before the milestone existed (exemem-cloud-account, milestone created
 * 2026-08-26 weeks after the PRs merged), or the filer only stamped the North
 * Star (project-zeus, ms-fold-gate-back-under-10-minutes). Both reconcile and
 * gap-report key children on `milestone`, so such a milestone reads
 * `children=[]` while the North Star's brain record already carries completion
 * checkpoints for the very PRs its acceptance bullets describe. gap-report
 * then scored it `idle_empty` → `decompose`, and `last-stack-milestone-driver`
 * spent a slot per hour re-discovering that every nameable slice had already
 * merged — 8+ recorded runs across 3+ milestones, 2026-08-29 through
 * 2026-09-13 (brain
 * `papercut-milestone-gap-report-idle-empty-ignores-ns-only-completion-checkpoints`).
 *
 * The board already holds the evidence the driver went to the brain for: a
 * done Kind:pr with a matching `north_star` and an EMPTY `milestone`. Cards
 * linked to a DIFFERENT milestone are that milestone's business and are not
 * returned. The proof card is excluded for the same reason it is excluded from
 * the `pr_*` tally. Pure and exported for unit tests.
 */
export function northStarOnlyDoneCards(milestone: Milestone, boardCards: Card[]): Card[] {
  const northStar = String(milestone.north_star ?? "").trim();
  if (!northStar) return [];
  return boardCards.filter((card) =>
    card.board === milestone.board
    && card.slug !== milestone.proof_card
    && String(card.north_star ?? "").trim() === northStar
    && !String(card.milestone ?? "").trim()
    && normalizeKind(card.kind) === "pr"
    && card.column === TERMINAL_COLUMN);
}

/**
 * Pure classifier: given one milestone + its board cards + dep-resolved child
 * statuses, decide gap status. Exported for unit tests.
 *
 * `boardCards` may be the whole board (the gap-report passes it so that
 * {@link northStarOnlyDoneCards} can see cards no milestone claims) or only the
 * milestone's own children; the tallies below only ever look up the slugs in
 * `childStatuses`, so a wider set changes nothing but the NS cross-check.
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
      // Body-free BoardCards projections must not be treated as hollow/stopped —
      // we have not read the brief, so "empty body" is unread, not empty.
      const hollow = isBodyOmitted(card)
        ? false
        : !isSubstantiveCardBody(card.body) || !hasPrWorkBrief(card.body);
      const stopped = isBodyOmitted(card) ? false : BODY_STOP_RE.test(card.body ?? "");
      const noRepo = !(card.repo && String(card.repo).trim());
      if (!child.blocked && !hold && !hollow && !stopped && !noRepo) promoteable.push(child.slug);
      else blocked_backlog.push(child.slug);
    }
  }
  const pr_done = prChildren.filter((c) => c.column !== "todo" && c.column !== "doing" && c.column !== "backlog").length;
  const pr_live = pr_todo + pr_doing + pr_backlog;
  const has_proof_card = Boolean(milestone.proof_card);
  const proof_passing = Boolean(proof?.passingEvidence && (proof.terminal || milestone.proof_status === "passing"));
  const ns_only_done = northStarOnlyDoneCards(milestone, boardCards).map((card) => card.slug);

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
    ns_only_done,
    has_proof_card,
    proof_passing,
  };

  let classified: MilestoneGapEntry;
  if (milestone.state === "complete") {
    classified = { ...base, status: "complete", action: "skip", reason: "milestone is complete" };
  } else if (milestone.state === "abandoned") {
    classified = { ...base, status: "abandoned", action: "skip", reason: "milestone is abandoned" };
  } else if (!milestone.north_star?.trim()) {
    classified = { ...base, status: "no_north_star", action: "skip", reason: "no north_star set — out of gap-fill scope" };
  } else if (milestone.state === "blocked") {
    classified = { ...base, status: "blocked", action: "skip", reason: milestone.block_reason || "milestone state is blocked" };
  } else if (pr_todo > 0 || pr_doing > 0) {
    classified = {
      ...base,
      status: "in_flight",
      action: "skip",
      reason: `live Kind:pr in todo=${pr_todo} doing=${pr_doing}`,
    };
  } else if (pr_live === 0 && proof_passing) {
    // The linked proof card's LAST verdict line is PASS and no Kind:pr is
    // live: the acceptance is proven, so complete it. Before this branch a
    // proof that FAILED and then re-ran PASS (proof_status still `failing`)
    // fell through every `!proof_passing` test to the final `idle_empty` →
    // `decompose`, and the driver filed new slices for a proven milestone
    // (papercut-fkanban-gap-report-proof-passing-scored-idle-empty-decompose-20260926).
    // `in_flight` above still wins: a live PR means the proof may be stale.
    classified = {
      ...base,
      status: "proof_ready",
      action: "complete_proof",
      reason: `linked proof card ${milestone.proof_card} last verdict is PASS; no live Kind:pr — complete the milestone`,
    };
  } else if (pr_live === 0 && pr_done > 0) {
    // No live todo/doing PRs.
    if (proof?.passingEvidence) {
      classified = { ...base, status: "proof_ready", action: "complete_proof", reason: "implementation done; proof body has PASS evidence" };
    } else if (milestone.proof_status === "not_required") {
      // The operator declared there is no harness: close without one rather
      // than hang forever or mint a hollow validation shell
      // (last-stack-milestone-driver contract).
      classified = {
        ...base,
        status: "proof_ready",
        action: "complete_proof",
        reason: "implementation Kind:pr done; proof_status=not_required — complete without harness",
      };
    } else if (!String(milestone.proof_card ?? "").trim()) {
      // Merged slices are not met acceptance. This branch used to close the
      // milestone as `not_required` whenever no proof card was linked, so a
      // milestone with 2 of 3 PR units merged and a pending proof
      // (lastdb-codec-reseal-safety-20260923) was queued for completion. The
      // action stays `decompose`: the milestone-driver guard authorizes Kind:pr
      // filings by matching action=decompose. `next_slice` says it is not a
      // first decomposition.
      classified = {
        ...base,
        status: "needs_next_slice",
        action: "decompose",
        next_slice: true,
        reason: `implementation slices done so far: ${pr_done}; acceptance not proven — file the next slice or the proof card`,
      };
    } else {
      classified = { ...base, status: "proof_pending", action: "await_proof", reason: "implementation Kind:pr done; terminal proof still pending" };
    }
  } else if (pr_live === 0 && pr_done === 0 && ns_only_done.length > 0) {
    // `children=[]` by the `milestone` key, but the board holds done Kind:pr
    // under the same North Star that nothing claims. That is evidence the
    // acceptance may already be met, not a gap to decompose: routing this to
    // `decompose` is how the driver came to re-verify the same merged PRs every
    // hour. `skip` keeps it out of `work_queue`; the reason names the repair
    // (relink) that turns this into an ordinary `pr_done>0` read.
    classified = {
      ...base,
      status: "idle_ns_evidence",
      action: "skip",
      reason: `no Kind:pr children by milestone link, but ${ns_only_done.length} done Kind:pr under north_star=${milestone.north_star} with no milestone set: ${ns_only_done.join(", ")} — verify against acceptance before decomposing; relink with \`kanban set <slug> --milestone ${milestone.slug}\``,
    };
  } else if (pr_live === 0 && pr_done === 0) {
    classified = {
      ...base,
      status: "idle_empty",
      action: "decompose",
      reason: has_proof_card
        ? "no Kind:pr children — needs next-gate decomposition into PR cards"
        : "no Kind:pr children and no proof card — needs proof link + next-gate PRs",
    };
  } else if (pr_backlog > 0 && promoteable.length > 0) {
    classified = {
      ...base,
      status: "idle_promoteable",
      action: "promote",
      reason: `${promoteable.length} promoteable Kind:pr in backlog (no todo/doing)`,
    };
  } else if (pr_backlog > 0 && promoteable.length === 0) {
    classified = {
      ...base,
      status: "idle_blocked",
      action: "skip",
      reason: "backlog Kind:pr exist but all are held, hollow, missing Repo, or dep-blocked",
    };
  } else {
    classified = {
      ...base,
      status: "idle_empty",
      action: "decompose",
      reason: "no feedable live Kind:pr frontier",
    };
  }
  return legalizeGapEntry(milestone, classified);
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
    idle_ns_evidence: 0,
    idle_blocked: 0,
    proof_pending: 0,
    proof_ready: 0,
    needs_next_slice: 0,
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

  // Work queue: promote → decompose → complete_proof; stable order = portfolio order
  const work_queue: MilestoneGapReport["work_queue"] = [];
  for (const entry of milestones) {
    if (entry.action === "promote") work_queue.push(gapWorkItem(entry, "promote", entry.promoteable));
  }
  for (const entry of milestones) {
    if (entry.action === "decompose") work_queue.push(gapWorkItem(entry, "decompose", []));
  }
  for (const entry of milestones) {
    if (entry.action === "complete_proof") {
      work_queue.push(gapWorkItem(entry, "complete_proof", []));
    }
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
  // The WHOLE board, not only milestone-linked cards: `classifyMilestoneGap`
  // tallies by `childStatuses` either way, and the NS cross-check needs to see
  // the cards no milestone claims.
  const report = buildMilestoneGapReport(snapshot.reconciled, snapshot.board_cards, { board: opts.board });
  const lines = [
    `Milestone gap-report  (generated ${report.generated_at})`,
    `counts: in_flight=${report.counts.in_flight} idle_promoteable=${report.counts.idle_promoteable} idle_empty=${report.counts.idle_empty} idle_ns_evidence=${report.counts.idle_ns_evidence} idle_blocked=${report.counts.idle_blocked} proof_pending=${report.counts.proof_pending} proof_ready=${report.counts.proof_ready} needs_next_slice=${report.counts.needs_next_slice} complete=${report.counts.complete} no_north_star=${report.counts.no_north_star} blocked=${report.counts.blocked}`,
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
