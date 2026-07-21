import { FkanbanError, type NodeClient } from "../client.ts";
import type { Config } from "../config.ts";
import {
  MILESTONE_PROOF_STATUSES,
  MILESTONE_STATES,
  ensureBoardRecord,
  findCard,
  findMilestone,
  isMilestoneState,
  listMilestones,
  normalizeDeps,
  nowIso,
  requireMilestone,
  upsertMilestoneRecord,
  validateSlug,
  type Milestone,
} from "../record.ts";

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

export async function milestoneAddCmd(opts: MilestoneAddOptions): Promise<{ slug: string; action: "created" | "updated"; state: string }> {
  validateSlug(opts.slug);
  const existing = await findMilestone(opts.node, opts.cfg, opts.slug);
  const state = opts.state ?? existing?.state ?? "planned";
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
    driver: opts.driver ?? existing?.driver ?? "",
    deps,
    proof_card: opts.proofCard ?? existing?.proof_card ?? "",
    proof_status: proofStatus,
    block_reason: opts.blockReason ?? existing?.block_reason ?? "",
    created_at: existing?.created_at ?? now,
    updated_at: now,
    completed_at: state === "complete" ? (existing?.completed_at || now) : "",
  };
  await validateLinks(opts, milestone);
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

export async function milestoneStateCmd(opts: { cfg: Config; node: NodeClient; slug: string; state: string }): Promise<{ slug: string; from: string; to: string }> {
  validateState(opts.state);
  const existing = await requireMilestone(opts.node, opts.cfg, opts.slug);
  await milestoneAddCmd({ cfg: opts.cfg, node: opts.node, slug: opts.slug, state: opts.state });
  return { slug: opts.slug, from: existing.state, to: opts.state };
}
