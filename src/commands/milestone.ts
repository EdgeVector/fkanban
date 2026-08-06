import { FkanbanError, type NodeClient } from "../client.ts";
import type { Config } from "../config.ts";
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
  findCardSummaryForReconcile,
  findMilestone,
  isMilestoneState,
  listBoards,
  listCardsOnBoard,
  listDependencyStatusesForCards,
  listMilestones,
  listMilestonesOnBoard,
  hasPrWorkBrief,
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
  type Board,
} from "../record.ts";
import { cardFromMilestoneCardFields, findMilestoneCardBySk, listMilestoneCardsPartition, listMilestoneCardsPartitionSpine, type MilestoneCardRow, milestoneCardFieldsFromCard, milestoneCardsHash, milestoneCardSk, removeMilestoneCard, upsertMilestoneCard } from "../milestone-cards.ts";

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

/**
 * THE machine-readable projection of a reconcile read — the one place that
 * decides which fields of {@link MilestoneReconcileResult} reach a consumer.
 *
 * `milestoneReconcileResult` returns the result fields plus three carriers that
 * are NOT payload (`text`, `repairs`, `boards`), so every surface has to select.
 * Four of them did, by hand, field by field: `milestone reconcile --json`, the
 * `fkanban_milestone_reconcile` MCP payload AND its output schema, and
 * `milestoneDetailResult`. A field added to the type therefore reached a surface
 * only if someone remembered it there — and `proof_verdict` /
 * `proof_verdict_reason` were remembered in three places and forgotten in the
 * fourth.
 *
 * Measured on the live primary 2026-08-06, one milestone claiming `passing`
 * with no proof card:
 *
 *     human   proof verdict: unproven (no-proof-card; recorded "passing")
 *     --json  {children, milestone, proof, ready, repairs, warnings}
 *             .milestone.proof_status = "passing"
 *
 * The prose half of the same invocation corrected the claim; the machine half
 * shipped the false one with nothing to contradict it. `milestone-driver.md`
 * step 1 runs exactly `milestone reconcile <slug> --json` on the proof path, and
 * the verdict exists (see its doc comment on the type) precisely so a driver
 * reads ONE field rather than pattern-matching prose out of `warnings[]`.
 *
 * Selecting here instead of at each call site makes the next added field reach
 * all four by construction; `test/milestone-reconcile-payload-parity.test.ts`
 * asserts this projection stays exhaustive over what the read actually returns.
 */
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

/**
 * What the MilestoneCards heal-on-read classified, and how much of it was
 * actually written.
 *
 * `upserts`/`removals` are the CLASSIFICATION — what drift exists — and are
 * reported whether or not anything was issued. `issued` and `deferred` describe
 * what this invocation did about it. That split is the point: it lets a caller
 * ask "what would you repair?" without repairing it.
 */
export type MilestoneRepairPlan = {
  /** Whether repair writes were issued at all (false under dry-run). */
  applied: boolean;
  /** Index rows needing a write, classified. */
  upserts: number;
  /** Index rows needing retirement, classified. */
  removals: number;
  /** Repairs actually issued this run. */
  issued: number;
  /** Classified but not issued — dry-run, or the budget ran out. */
  deferred: number;
  /** Repair budget in force; null when unlimited. */
  budget: number | null;
  /** True when destination MilestoneCards payload writes are explicit. */
  direct_payload_upsert: boolean;
  /**
   * Which MilestoneCards read the node refused, or `null` when both answered.
   *
   * The counts above are only a claim about the DATA when this is `null`. Every
   * other value means at least one read came back empty because it FAILED, and
   * the classification it fed is short by an unknown amount. See
   * {@link MilestoneIndexReadFailure}.
   */
  index_read_failed: MilestoneIndexReadFailure;
};

/**
 * Which half of the MilestoneCards partition read was shed, if either.
 *
 * The reconcile wave issues two reads against the SAME partition — the wide
 * payload read (`listMilestoneCardsPartition`, what the rows SAY) and the
 * address enumeration (`listMilestoneCardsPartitionSpine`, which rows EXIST).
 * Both return `null` from a bare `catch {}`, and each failure produces a
 * different lie:
 *
 *  - `"payload"` — the classifier is skipped outright, `upserts`/`removals` are
 *    hard-coded to zero, and `renderRepairPlan` prints NOTHING because
 *    `classified === 0`. Measured on the live primary 2026-08-06
 *    (`scripts/probe-milestone-reconcile-read-shed-silence.ts`): milestone
 *    `lastdb-mutation-phase-observability` renders BYTE-IDENTICAL output shed
 *    and healthy, and `operation-trinity-m0-charter` loses a real orphan
 *    retirement (1 removal healthy, 0 shed) while still printing
 *    `warnings: none`.
 *  - `"addresses"` — `indexAddresses ?? []` makes every card look like it has
 *    no index row, so all of them classify stale and queue an upsert with
 *    `previous: null`, while every orphan removal is skipped because `rows[0]`
 *    is undefined. Same probe: `lastdb-0231-read-regression-fixes` goes from 7
 *    genuine upserts to 11 unverified ones, and `operation-trinity-m0-charter`
 *    again reports 0 removals instead of 1.
 *  - `"both"` — the payload branch wins; behaves as `"payload"`.
 *
 * `null` ALSO covers the case where `milestone_cards` is not bound in this
 * config at all, which is why the flag is derived from the schema hash rather
 * than from the `null` return alone: an unbound index has nothing to read and
 * is not a failure, and a run that reported one on every milestone would be
 * muted inside a week.
 */
export type MilestoneIndexReadFailure = null | "payload" | "addresses" | "both";

/**
 * The operator-facing name for each failure, used in the warning and the banner.
 */
const INDEX_READ_FAILURE_LABEL: Record<NonNullable<MilestoneIndexReadFailure>, string> = {
  payload: "the payload read (what the index rows say)",
  addresses: "the address enumeration (which index rows exist)",
  both: "both the payload read and the address enumeration",
};

/**
 * Default cap on repair writes issued by one `milestone reconcile`.
 *
 * A MilestoneCards mutation costs 2.4-8.3s idle on the primary and ~17s under
 * load, so an unbounded repair loop makes the command's worst case unbounded in
 * the drift — a 22-row gap measured 6m28s. Reconcile is convergent and
 * idempotent, so stopping early is safe and every run makes strict progress;
 * capping it trades "one command converges anything" for "no command runs for
 * an unbounded time", and reports the remainder either way.
 *
 * 25 is set just above the largest real drift observed on this fleet (22 rows),
 * so the ordinary case still converges in a single invocation.
 */
export const DEFAULT_MILESTONE_REPAIR_BUDGET = 25;

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
  // projects ~20 fields, and a LastDB keyed query returns a row only when EVERY
  // projected field has an atom on it — so one missing field makes a live card
  // read as ABSENT, indistinguishable from deleted. Gating a write on that
  // false-negative made a live-but-sparse proof card unlinkable, with an error
  // sending the operator to look for a card sitting right there. `cardExists`
  // projects `slug` alone and cannot false-negative.
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
  const allowed = [...(ALLOWED_TRANSITIONS[from] ?? [])];
  // not_required skips the proving phase (no harness to exercise).
  if (from === "active" && to === "complete" && milestone.proof_status === "not_required") {
    allowed.push("complete");
  }
  if (from !== to && !allowed.includes(to)) {
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
  await upsertMilestoneRecord(opts.node, opts.cfg, milestone, existing !== null, existing);
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
  const source = opts.board
    ? await listMilestonesOnBoard(opts.node, opts.cfg, opts.board)
    : await listMilestones(opts.node, opts.cfg);
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
    ...(written.driverHealed ? { driverHealed: written.driverHealed } : {}),
  };
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function milestoneCardSummaryMatchesTruth(summary: Card, truth: Card): boolean {
  return (
    summary.slug === truth.slug &&
    summary.title === truth.title &&
    (summary.board || "default") === (truth.board || "default") &&
    summary.column === truth.column &&
    String(summary.position) === String(truth.position) &&
    summary.assignee === truth.assignee &&
    arraysEqual(summary.tags, truth.tags) &&
    arraysEqual(summary.deps, truth.deps) &&
    arraysEqual(summary.surfaces, truth.surfaces) &&
    summary.created_at === truth.created_at &&
    (summary.created_by || "unknown") === (truth.created_by || "unknown") &&
    summary.updated_at === truth.updated_at &&
    summary.repo === truth.repo &&
    summary.base === truth.base &&
    summary.kind === truth.kind &&
    summary.block_status === truth.block_status &&
    summary.block_reason === truth.block_reason &&
    summary.north_star === truth.north_star &&
    (summary.milestone ?? "") === (truth.milestone ?? "") &&
    summary.pr_url === truth.pr_url &&
    summary.branch === truth.branch
  );
}

/**
 * A MilestoneCards row rebuilt from its ADDRESS alone, for the repair calls
 * that only need to name a row rather than describe it.
 *
 * `removeMilestoneCard` recomputes the sk from `column`/`position`/`slug`, all
 * three of which the spine parses out of the real range key — so this addresses
 * the same row the enumeration found. If the sk could not be parsed, the
 * recomputed key addresses nothing, and the removal still lands: the purge that
 * follows it sweeps every row for the slug by address, keeping none.
 */
function cardForRemoval(milestone: string, row: MilestoneCardRow): Card {
  return cardFromMilestoneCardFields({
    milestone,
    slug: row.slug,
    column: row.column,
    position: row.position,
  });
}

/**
 * Verify every child of a milestone against Card truth and repair MilestoneCards.
 *
 * The two inputs play different roles and conflating them is how this function
 * went wrong. `indexRows` are the actual MilestoneCards rows — the only rows
 * this function may write, and the only evidence of drift. `boardRows` are
 * board membership, unioned in purely to DISCOVER slugs the index missed; a
 * board row is not a MilestoneCards row and its presence says nothing about
 * whether the index is stale.
 *
 * Previously both arrived as one merged list and staleness was `rows.length !==
 * 1`. The union guarantees two rows for every correctly-indexed card, so a
 * fully converged milestone classified *every* child as stale and rewrote it —
 * while a card present on the board but missing from the index had exactly one
 * row, compared equal to truth, and was skipped. The command did the inverse of
 * its job in both directions. Measured on `lastdb-0231-read-regression-fixes`
 * (`scripts/probe-milestone-reconcile-shape.ts`): 47 needless upserts, 0 real
 * drift, and 22 genuinely missing rows never written — at 2.4-8.3s per mutation
 * that is the reported 10-minute timeout.
 */
async function reconcileMilestoneCardChildren(
  opts: { cfg: Config; node: NodeClient },
  milestone: Milestone,
  indexRows: Card[],
  indexAddresses: MilestoneCardRow[],
  boardRows: Card[],
  repair: { apply: boolean; budget: number | null; directPayloadUpsert: boolean; indexReadFailed: MilestoneIndexReadFailure },
): Promise<{ children: Card[]; repairs: MilestoneRepairPlan }> {
  // WHICH ROWS EXIST comes from the address enumeration; WHAT THEY SAY comes
  // from the payload read. Conflating the two is what made this function blind
  // to the rows most likely to need repair — see the call site.
  //
  // A row present by address with no payload cannot be compared to truth, so it
  // is treated as stale rather than as absent. That is the conservative
  // direction: it costs a redundant upsert on a row that may already be
  // correct, and it buys the sibling purge arming on a partition that really
  // does hold duplicates.
  const payloadBySk = new Map<string, Card>();
  for (const row of indexRows) {
    payloadBySk.set(milestoneCardSk(row.column, row.position, row.slug), row);
  }
  const rowsBySlug = new Map<string, MilestoneCardRow[]>();
  for (const row of indexAddresses) {
    const rows = rowsBySlug.get(row.slug) ?? [];
    rows.push(row);
    rowsBySlug.set(row.slug, rows);
  }
  const slugs = [...new Set([...indexAddresses.map((row) => row.slug), ...boardRows.map((row) => row.slug)])];

  // Reads first, fanned out: they have no ordering dependency on each other and
  // a point read is ~190ms on the primary, so 69 of them serially is 13s.
  const truths = await mapWithConcurrency(
    slugs,
    (slug) => findCardSummaryForReconcile(opts.node, opts.cfg, slug).catch(() => null),
    POINT_READ_CONCURRENCY,
  );

  // Writes are collected, then issued serially. They must NOT fan out:
  // LastDB's convergence wait is a global cross-writer barrier, so concurrent
  // mutations inflate each other's latency rather than overlapping.
  const out: Card[] = [];
  const removals: Card[] = [];
  const upserts: Array<{ truth: Card; previous: Card | null; siblings: boolean }> = [];

  slugs.forEach((slug, i) => {
    const rows = rowsBySlug.get(slug) ?? [];
    const truth = truths[i] ?? null;

    // No such card, or it belongs to a different milestone/board now: retire
    // the index rows. One removal per slug is enough — removeMilestoneCard
    // purges every other row for that slug itself.
    //
    // `rows` is now the ADDRESS set, so a row whose payload the wide read
    // denied still queues its removal. That is the whole point: an orphan
    // nothing can see is an orphan nothing can delete, and this branch was
    // unreachable for precisely the rows that needed it.
    if (!truth || (truth.milestone ?? "") !== milestone.slug || (truth.board || "default") !== milestone.board) {
      if (rows[0]) removals.push(cardForRemoval(milestone.slug, rows[0]));
      return;
    }

    // rows.length === 0 is the missing-index-row case reconcile exists to fix.
    // A row present by address but absent from the payload read cannot be
    // compared, so it counts as stale — never as "matches truth".
    const payload = rows[0] ? payloadBySk.get(rows[0].sk) ?? null : null;
    const stale = rows.length !== 1 || payload === null || !milestoneCardSummaryMatchesTruth(payload, truth);
    // `previous` is rows[0], one of possibly several. Say so: the upsert's
    // orphan sweep is otherwise gated on rows[0] having a different sk, and
    // rows[0] is whichever row the partition read returned first, not whichever
    // one is wrong. See MilestoneCardUpsertOptions.purgeSiblings.
    if (stale) {
      upserts.push({
        truth,
        previous: rows[0] ? cardForRemoval(milestone.slug, rows[0]) : null,
        siblings: rows.length > 1,
      });
    }
    out.push(truth);
  });

  //
  // Both are bounded by ONE shared budget: they are the same scarce thing (a
  // write on the shared primary), so spending it on removals first and then
  // reporting the upserts as deferred is the honest accounting.
  let issued = 0;
  let fallbackDirectPayloadUpsert = false;
  const exhausted = () => repair.budget !== null && issued >= repair.budget;
  if (repair.apply) {
    for (const row of removals) {
      if (exhausted()) break;
      await removeMilestoneCard(opts.node, opts.cfg, row).catch(() => undefined);
      issued++;
    }
    for (const { truth, previous, siblings } of upserts) {
      if (exhausted()) break;
      if (repair.directPayloadUpsert) {
        await upsertMilestoneCard(opts.node, opts.cfg, truth, previous, {
          purgeSiblings: siblings,
          writePayload: true,
        })
          .catch(() => undefined);
      } else {
        await upsertMilestoneCard(opts.node, opts.cfg, truth, previous, {
          purgeSiblings: siblings,
          writePayload: false,
        })
          .catch(() => undefined);
        const expected = milestoneCardFieldsFromCard(truth);
        const folded = expected
          ? await findMilestoneCardBySk(opts.node, opts.cfg, String(expected.milestone), String(expected.sk))
          : null;
        if (!folded || !milestoneCardSummaryMatchesTruth(folded, truth)) {
          // Key regeneration is still the repair job's responsibility on nodes
          // whose protein fold accepted the source write but did not materialize
          // the sibling tip. Keep the hot card path BoardCards-only.
          fallbackDirectPayloadUpsert = true;
          await upsertMilestoneCard(opts.node, opts.cfg, truth, previous, {
            purgeSiblings: siblings,
            writePayload: true,
          })
            .catch(() => undefined);
        }
      }
      issued++;
    }
  }

  // `children` is built from `truth` — the freshly-read Card records — never
  // from the index rows, so it is byte-identical whether or not the repairs
  // above were issued. That is what makes dry-run safe for a read command:
  // skipping the writes changes what FUTURE reads cost, not this answer.
  return {
    children: out.sort((a, b) =>
      milestoneCardSk(a.column, a.position, a.slug).localeCompare(milestoneCardSk(b.column, b.position, b.slug)),
    ),
    repairs: {
      applied: repair.apply,
      upserts: upserts.length,
      removals: removals.length,
      issued,
      deferred: removals.length + upserts.length - issued,
      budget: repair.budget,
      direct_payload_upsert: repair.directPayloadUpsert || fallbackDirectPayloadUpsert,
      index_read_failed: repair.indexReadFailed,
    },
  };
}

export async function milestoneReconcileResult(opts: {
  cfg: Config;
  node: NodeClient;
  slug: string;
  /**
   * Issue the repair writes. Defaults TRUE — `reconcile` is a repair verb and
   * heal-on-read is its job. Read commands (`detail`) pass false so that
   * asking to LOOK at a milestone cannot write to the shared primary.
   */
  apply?: boolean;
  /** Cap on repair writes; null = unlimited. Defaults to the budget above. */
  maxRepairs?: number | null;
  /**
   * Emergency/operator override: repair MilestoneCards by direct payload upsert.
   * Normal reconcile/heal writes BoardCards and relies on protein fold.
   */
  directPayloadUpsert?: boolean;
}): Promise<MilestoneReconcileResult & { text: string; repairs: MilestoneRepairPlan; boards: Board[] }> {
  const apply = opts.apply ?? true;
  const budget = opts.maxRepairs === undefined ? DEFAULT_MILESTONE_REPAIR_BUDGET : opts.maxRepairs;
  const directPayloadUpsert = opts.directPayloadUpsert ?? false;
  const milestone = await requireMilestone(opts.node, opts.cfg, opts.slug);
  // ONE WAVE for everything keyed by the milestone alone.
  //
  // A request costs ~190ms on an idle node whatever it asks for, so this
  // command's wall time is its serial round-trip DEPTH, not its request count
  // (`scripts/probe-round-trip-depth.ts`). These four reads were four separate
  // awaits and therefore four waves, and only the first two have any reason to
  // be: `listBoards` needs nothing but the config, and the proof card is keyed
  // by `milestone.proof_card`, which wave 1 already returned. Measured on the
  // live board, `milestone detail` was 6 requests in 6 waves — the worst
  // depth-per-request of any command on the board — and this is four of them.
  //
  // Kept as one `Promise.all` rather than promises awaited later so a throw in
  // any branch cannot leave a sibling read dangling as an unhandled rejection.
  //
  // Prefer keyed partitions, but union MilestoneCards with current board
  // membership so a lagging/missing milestone-keyed fold cannot hide a live
  // Card whose board row already carries the milestone link.
  const [fromIndex, indexAddresses, boardCards, boards, proofCard] = await Promise.all([
    listMilestoneCardsPartition(opts.node, opts.cfg, milestone.slug),
    // The ADDRESS enumeration, in the same wave — this read decides which rows
    // exist, and the wide read above only decides what their payloads say.
    //
    // They cannot be the same read. The wide read leads with `milestone`, the
    // partition key, and a row whose payload copy of that key did not persist
    // is dropped from it with no error — while remaining addressable, and
    // remaining visible to `purgeOtherMilestoneCardRows`, which has always
    // enumerated by spine for exactly this reason. Classifying repairs from the
    // wide read therefore made the two halves of this command disagree about
    // which rows exist: the half that DECIDES could not see rows the half that
    // DELETES could.
    //
    // Measured on the live primary 2026-08-03, partition
    // `lastdb-0231-read-regression-fixes`: 7 rows by address, 4 under the wide
    // read. Of the 3 invisible rows, two were stale duplicates of a card that
    // had since moved (so `rows.length > 1` read as 0 and the sibling purge
    // never armed) and one belonged to a DELETED card (so `rows[0]` was
    // undefined and no removal was ever queued). Both are permanent: every
    // subsequent run re-derived the same blind classification and re-issued the
    // same non-repair.
    listMilestoneCardsPartitionSpine(opts.node, opts.cfg, milestone.slug),
    listCardsOnBoard(opts.node, opts.cfg, milestone.board),
    listBoards(opts.node, opts.cfg),
    milestone.proof_card
      ? findProofCard(opts.node, opts.cfg, milestone.proof_card)
      : Promise.resolve(null),
  ]);
  const fromBoard = boardCards.filter((card) => card.milestone === milestone.slug);
  // A `null` from either MilestoneCards read means one of two very different
  // things and neither helper can tell them apart: the index is not bound in
  // this config, or the node refused the query. Only the second is a failure,
  // so the discriminator is the schema hash — bound + null == shed.
  //
  // This runs BEFORE the branch below deliberately. The `fromIndex === null`
  // arm returns an all-zero repair plan, and without this flag that plan is
  // indistinguishable from a converged milestone — measured byte-identical on
  // the live primary, which is the defect this exists to close.
  const indexBound = milestoneCardsHash(opts.cfg) !== null;
  const indexReadFailed: MilestoneIndexReadFailure = !indexBound
    ? null
    : fromIndex === null && indexAddresses === null
    ? "both"
    : fromIndex === null
    ? "payload"
    : indexAddresses === null
    ? "addresses"
    : null;
  const reconciled = fromIndex !== null
    // `indexAddresses ?? []` still passes an empty address set on a shed spine
    // read, and that is deliberately NOT changed here: the resulting upserts
    // carry `previous: null`, which routes to `purgeOtherMilestoneCardRows` for
    // the SAME slug only, so they are wasteful and unverified but not
    // destructive. This repo's standing rule is that a heal which
    // under-repairs is safe and a heal that does not run is not — so the fix
    // is to REPORT the shed read, never to refuse the run. What the empty set
    // costs is now named in the plan rather than laundered into the counts.
    ? await reconcileMilestoneCardChildren(opts, milestone, fromIndex, indexAddresses ?? [], fromBoard, { apply, budget, directPayloadUpsert, indexReadFailed })
    : {
      // No MilestoneCards partition to reconcile against: membership came
      // straight from the board, so nothing was classified and nothing is
      // deferred — not "0 repairs because we chose to skip them".
      children: fromBoard,
      repairs: {
        applied: apply,
        upserts: 0,
        removals: 0,
        issued: 0,
        deferred: 0,
        budget,
        direct_payload_upsert: directPayloadUpsert,
        index_read_failed: indexReadFailed,
      } satisfies MilestoneRepairPlan,
    };
  const children = reconciled.children;
  // The whole board is already in hand from the wave above, so a dep edge
  // pointing at a same-board card resolves locally instead of costing a point
  // read — the same `knownCards` narrowing the portfolio path already uses.
  const statuses = await listDependencyStatusesForCards(opts.node, opts.cfg, children, boardCards);
  // Only pay for the extra key-only read when the wide read came back empty —
  // that is the only case where "absent" and "sparse" are in question.
  const proofCardSparse = Boolean(milestone.proof_card) && !proofCard
    && (await cardExists(opts.node, opts.cfg, milestone.proof_card!));
  const snapshot = milestoneReconcileFromSnapshot(milestone, children, statuses, proofCard, proofCardSparse);
  // A shed index read belongs in `warnings` as well as in the banner, because
  // the two surfaces have different readers. The banner is for the human
  // reading `reconcile`; `warnings` is the machine-readable array that
  // `milestone groom`, the portfolio row (`warning_count`) and every `--json`
  // consumer pattern-match on — and on a shed read every one of them was
  // otherwise told `warnings: none` about a milestone nobody had looked at.
  //
  // Appended after the snapshot's own warnings rather than pushed inside it:
  // this condition is a property of the READ, not of the milestone, and
  // `milestoneReconcileFromSnapshot` is deliberately pure over what it was given.
  const result: MilestoneReconcileResult = indexReadFailed === null ? snapshot : {
    ...snapshot,
    warnings: [...snapshot.warnings, {
      code: "unreadable-milestone-index",
      message: `The node refused ${INDEX_READ_FAILURE_LABEL[indexReadFailed]} for this milestone's MilestoneCards partition.`,
      hint: "Index repair counts on this run are short by an unknown amount and are not evidence the milestone is converged. Re-run under lighter load.",
    }],
  };
  // `boards` travels out so a caller that needs the board list too — `detail`
  // renders one column group per column — can thread it instead of paying the
  // same read a second time in a wave of its own.
  return { ...result, repairs: reconciled.repairs, boards, text: renderMilestoneReconcile(result, reconciled.repairs) };
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
      hint: "Run the proof, record `PROOF: PASS`, mark its status passing, then complete the milestone — or complete with --proof-status not_required when no harness exists.",
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

/**
 * Render the index-repair line, or nothing at all when the index is converged.
 *
 * Silence is the common case and the useful default — a converged milestone
 * classifies zero repairs, and a line saying so on every reconcile would train
 * the reader to skip the line that matters. Deferred work always names the
 * command that finishes it, because a report of drift the reader cannot act on
 * is just noise.
 */
/**
 * The shed-read banner, on its own lines ABOVE every count it qualifies.
 *
 * Placement is the whole point and is pinned by a test. A caveat appended to a
 * line that opens `index repair: 0 row(s) written` gets read as part of the
 * good news — that is exactly how `board_cards_heal_scheduled` came to print
 * the word `clean` for a run with no coverage. It also has to appear when
 * `renderRepairPlan` returns nothing at all, which is the silent case: an
 * all-zero plan from a shed read renders byte-identically to a converged
 * milestone, measured on the live primary.
 */
function renderIndexReadFailure(slug: string, repairs: MilestoneRepairPlan): string[] {
  if (repairs.index_read_failed === null) return [];
  const what = INDEX_READ_FAILURE_LABEL[repairs.index_read_failed];
  return [
    `⚠ INDEX READ INCOMPLETE — the node refused ${what} for this milestone's`,
    `  MilestoneCards partition. The repair counts below are NOT a claim about`,
    `  the data: they are short by an unknown amount. Re-run under lighter load`,
    `  before concluding this milestone is converged (\`kanban milestone reconcile ${slug}\`).`,
  ];
}

function renderRepairPlan(slug: string, repairs: MilestoneRepairPlan): string[] {
  const classified = repairs.upserts + repairs.removals;
  if (classified === 0) return [];
  const writeLabel = repairs.direct_payload_upsert ? "payload write" : "protein fold request";
  const shape = `${repairs.upserts} ${writeLabel}(s), ${repairs.removals} to retire`;
  if (!repairs.applied) {
    return [`index drift: ${classified} row(s) need repair (${shape}) — run \`kanban milestone reconcile ${slug}\` to fix`];
  }
  if (repairs.deferred > 0) {
    return [`index repair: ${repairs.issued} of ${classified} row(s) written (${shape}); ${repairs.deferred} deferred by --max-repairs ${repairs.budget} — run \`kanban milestone reconcile ${slug}\` again to continue`];
  }
  return [`index repair: ${repairs.issued} row(s) written (${shape})`];
}

function renderMilestoneReconcile(result: MilestoneReconcileResult, repairs?: MilestoneRepairPlan): string {
  return [
    `${result.milestone.title} (${result.milestone.slug}) — ${result.milestone.state}`,
    `ready frontier: ${result.ready.length ? result.ready.map((card) => card.slug).join(", ") : "—"}`,
    `proof: ${result.proof ? `${result.proof.slug} · ${result.proof.terminal ? "terminal" : "not terminal"} · ${result.proof.passingEvidence ? "PASS" : "no PASS"}` : "—"}`,
    `proof verdict: ${result.proof_verdict}${result.proof_verdict === result.milestone.proof_status ? "" : ` (${result.proof_verdict_reason}; recorded "${result.milestone.proof_status}")`}`,
    ...(repairs ? renderIndexReadFailure(result.milestone.slug, repairs) : []),
    ...(repairs ? renderRepairPlan(result.milestone.slug, repairs) : []),
    ...(result.warnings.length ? ["warnings:", ...result.warnings.map((warning) => `- ${warning.code}: ${warning.message} ${warning.hint}`)] : ["warnings: none"]),
  ].join("\n");
}

async function milestonePortfolioSnapshot(opts: { cfg: Config; node: NodeClient; board?: string }): Promise<{ milestones: Milestone[]; cards: Card[]; reconciled: MilestoneReconcileResult[] }> {
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

  const milestones = opts.board
    ? await listMilestonesOnBoard(opts.node, opts.cfg, opts.board)
    : await listMilestones(opts.node, opts.cfg, { boards });
  // Membership comes from the board, not from MilestoneCards.
  //
  // MilestoneCards is written by NOTHING in the card mutation path — not `add`,
  // `move`, `tag`, `rm`, or `archive-done`. Only `groom milestone-indexes-heal`
  // and `milestone reconcile`'s heal-on-read ever put a row there. Reading it as
  // the preferred source of truth therefore reports the board as it looked at
  // the last heal, and is wrong in BOTH directions. Measured on the live board
  // 2026-07-31, across 31 milestones: only 5 agreed with board membership, 107
  // index rows named cards that no longer exist at all (`ms-search-native-…`,
  // `milestone-lastdb-resident-primary-v1`, …), and 87 live board-linked cards
  // had no index row — `ms-sync-dataloss-teardown-p1` rendered as an EMPTY
  // milestone while 13 live cards pointed at it.
  //
  // `milestone reconcile` already refuses to trust the index alone: it unions it
  // with board membership and validates every slug against Card truth. The
  // portfolio never got that fix, so the two commands disagreed about the same
  // milestone. BoardCards is the index the write path does maintain, so one
  // partition read per distinct board answers membership for every milestone on
  // it — and agrees with `kanban list` and with reconcile by construction.
  //
  // Per-milestone partition reads are not merely wrong here, they were also the
  // most expensive thing this command did: 31 keyed reads, ~7.4s of node time,
  // replaced by one 0.8s board read. Index drift stays the business of
  // `groom milestone-indexes-heal`, which is the command that can fix it.
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

  const boardCards = new Map<string, Card[]>(await boardCardsPending);
  const childLists = milestones.map((milestone) =>
    (boardCards.get(milestone.board) ?? []).filter((card) => card.milestone === milestone.slug));
  const cards = childLists.flat();
  // Every board card is already in hand, so a dep edge pointing at a same-board
  // card costs no point read.
  const knownCards = [...boardCards.values()].flat();
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
    reconciled: milestones.map((milestone, i) =>
      milestoneReconcileFromSnapshot(
        milestone,
        childLists[i] ?? [],
        statuses,
        proofs.get(milestone.proof_card) ?? null,
        sparseProofs.has(milestone.proof_card),
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

/**
 * `detail` LOOKS at a milestone; it does not write to one.
 *
 * It shares reconcile's snapshot path, which repairs MilestoneCards as a side
 * effect — so `detail` on a drifted milestone used to issue one write per
 * missing row on the shared primary, ~17s each under load. A 22-row gap made a
 * `detail` take six minutes, and `fkanban_milestone_detail` advertises
 * `readOnlyHint: true` to every MCP host while doing it.
 *
 * `apply: false` costs the answer nothing: `children` is built from freshly-read
 * Card truth, not from the index rows, so the repair writes cannot change a
 * single byte of this output. Drift is reported instead, naming the command
 * that fixes it.
 */
export async function milestoneDetailResult(opts: { cfg: Config; node: NodeClient; slug: string }): Promise<{ detail: MilestoneReconcileResult & { columns: Record<string, MilestoneChildStatus[]> }; repairs: MilestoneRepairPlan; text: string }> {
  const result = await milestoneReconcileResult({ ...opts, apply: false });
  // Reconcile already read the board list (it needs terminal columns to decide
  // done-ness), so re-reading it here bought nothing and cost a whole extra
  // wave — ~190ms on an idle node — for bytes that were already in memory.
  const columns: Record<string, MilestoneChildStatus[]> = Object.fromEntries(result.boards.find((board) => board.slug === result.milestone.board)?.columns.map((column) => [column, result.children.filter((card) => card.column === column)]) ?? []);
  const detail = { ...milestoneReconcilePayload(result), columns };
  const columnText = Object.entries(columns).map(([column, cards]) => `${column.toUpperCase()} (${cards.length})\n${cards.length ? cards.map((card) => `  • ${card.blocked ? "🔒 " : ""}${card.title}  ${card.slug}`).join("\n") : "  —"}`).join("\n\n");
  return { detail, repairs: result.repairs, text: `${renderMilestone(result.milestone, { verdict: result.proof_verdict, reason: result.proof_verdict_reason })}\n\n${columnText}\n\n${renderMilestoneReconcile(result, result.repairs)}` };
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
  work_queue: Array<{
    slug: string;
    action: "promote" | "decompose" | "complete_proof";
    promoteable: string[];
  }>;
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
    // Prefer closing with not_required over hanging forever or minting hollow
    // validation shells (last-stack-milestone-driver contract).
    if (milestone.proof_status === "not_required" || !String(milestone.proof_card ?? "").trim()) {
      return {
        ...base,
        status: "proof_ready",
        action: "complete_proof",
        reason:
          milestone.proof_status === "not_required"
            ? "implementation Kind:pr done; proof_status=not_required — complete without harness"
            : "implementation Kind:pr done; no proof card — complete with not_required (no theater shell)",
      };
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

  // Work queue: promote → decompose → complete_proof; stable order = portfolio order
  const work_queue: MilestoneGapReport["work_queue"] = [];
  for (const entry of milestones) {
    if (entry.action === "promote") work_queue.push({ slug: entry.slug, action: "promote", promoteable: entry.promoteable });
  }
  for (const entry of milestones) {
    if (entry.action === "decompose") work_queue.push({ slug: entry.slug, action: "decompose", promoteable: [] });
  }
  for (const entry of milestones) {
    if (entry.action === "complete_proof") {
      work_queue.push({ slug: entry.slug, action: "complete_proof", promoteable: [] });
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
