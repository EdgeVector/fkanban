// Logical pickup lanes on the default board's shared `todo` queue.
//
// Hard todo ranker (Tom 2026-08-01 — factory graph todo_ranker):
//   1. p0-now              — always first among ready cards (true interrupts)
//   2. fair-share(program) — each program:* lane competes by fewest doing /
//                            oldest last-claim (starvation); never unlaned
//   3. unlaned             — real work without NS/lane tags (after all programs)
//   4. papercut            — hygiene / routine-error fill only
//
// Within a lane: active|proving milestone frontier → Priority P0→P3 → age.
// Lane *annotation* (lane:program:… tags) is optional. Until annotations are
// ubiquitous we derive lanes from priority, north_star, and papercut heuristics.
// Claim order uses live board state so concurrent workers share a coherent
// starvation signal without a perfect shared cursor.

import { priorityOf, priorityRank, rankCards, type Card } from "./record.ts";

export type LaneKind = "p0-now" | "program" | "papercut" | "unlaned";

/**
 * Hard todo ranker (Tom factory graph — todo_ranker).
 *
 * Claim + board `position` must drain the same hard tiers:
 *   0. p0-now          — true interrupts (non-papercut P0 / pipeline)
 *   1. program:*       — North Star / milestone frontier work
 *   2. unlaned         — real work without NS/lane tags (after all programs)
 *   3. papercut        — hygiene / routine-error fill only
 *
 * Within a tier: active|proving milestone children first, then Priority P0→P3,
 * then oldest created_at. Papercuts never outrank program frontier solely by
 * being older or P0-tagged.
 */
export type HardTodoRankContext = {
  /** Milestone slugs in state active or proving (frontier boost). */
  frontierMilestones?: ReadonlySet<string>;
};

/** Lane hard tier — lower drains first. */
export function hardLaneTier(lane: LaneId): number {
  const kind = laneKind(lane);
  if (kind === "p0-now") return 0;
  if (kind === "program") return 1;
  if (kind === "unlaned") return 2;
  return 3; // papercut
}

/**
 * 0 = child of active/proving milestone (frontier)
 * 1 = has a milestone but not frontier
 * 2 = no milestone
 */
export function frontierBoost(card: Card, ctx?: HardTodoRankContext): number {
  const ms = (card.milestone || "").trim();
  if (!ms) return 2;
  if (ctx?.frontierMilestones?.has(ms)) return 0;
  return 1;
}

/** Pure total order for hard todo ranking (stable for equal keys via slug). */
export function compareHardTodo(a: Card, b: Card, ctx?: HardTodoRankContext): number {
  const ta = hardLaneTier(laneOf(a));
  const tb = hardLaneTier(laneOf(b));
  if (ta !== tb) return ta - tb;

  const fa = frontierBoost(a, ctx);
  const fb = frontierBoost(b, ctx);
  if (fa !== fb) return fa - fb;

  const pa = priorityRank(priorityOf(a));
  const pb = priorityRank(priorityOf(b));
  if (pa !== pb) return pa - pb;

  const ca = a.created_at.localeCompare(b.created_at);
  if (ca !== 0) return ca;
  return a.slug.localeCompare(b.slug);
}

/** Order cards by hard todo tiers (for `kanban rank` position rewrite). */
export function rankCardsHardTodo<T extends Card>(cards: T[], ctx?: HardTodoRankContext): T[] {
  return cards.slice().sort((a, b) => compareHardTodo(a, b, ctx));
}

export function isFrontierMilestoneState(state: string): boolean {
  const s = (state || "").trim().toLowerCase();
  return s === "active" || s === "proving";
}

export type LaneId =
  | "p0-now"
  | "papercut"
  | "unlaned"
  | `program:${string}`;

export type PickupLaneState = {
  version: 1;
  /** Monotonic claim counter for diagnostics / round-robin ties. */
  sequence: number;
  /** ISO timestamp of last successful claim (any lane). */
  last_claim_at?: string;
  last_claim_slug?: string;
  last_claim_lane?: LaneId;
  /** Per-lane last successful claim times (ISO). */
  lane_last_claim_at: Record<string, string>;
};

export const PICKUP_LANE_STATE_FENCE_START = "<!-- fkanban-pickup-lane-state:v1";
export const PICKUP_LANE_STATE_FENCE_END = "-->";

const PIPELINE_RE =
  /\b(?:pipeline|deploy[-_ ]?pipeline|merge[-_ ]?queue|ci[-_ ]?red|deploy[-_ ]?red|blocked[-_ ]?merge)\b/i;
const PAPERCUT_RE =
  /\b(?:papercut|routine-error|hygiene|lint|stale[-_ ]?worktree|disk[-_ ]?reclaim)\b/i;

export function emptyPickupLaneState(): PickupLaneState {
  return { version: 1, sequence: 0, lane_last_claim_at: {} };
}

export function parsePickupLaneState(boardBody: string): PickupLaneState {
  const start = boardBody.indexOf(PICKUP_LANE_STATE_FENCE_START);
  if (start < 0) return emptyPickupLaneState();
  const after = start + PICKUP_LANE_STATE_FENCE_START.length;
  const end = boardBody.indexOf(PICKUP_LANE_STATE_FENCE_END, after);
  if (end < 0) return emptyPickupLaneState();
  const raw = boardBody.slice(after, end).trim();
  try {
    const parsed = JSON.parse(raw) as Partial<PickupLaneState>;
    if (parsed && parsed.version === 1 && typeof parsed.sequence === "number") {
      return {
        version: 1,
        sequence: parsed.sequence,
        last_claim_at: parsed.last_claim_at,
        last_claim_slug: parsed.last_claim_slug,
        last_claim_lane: parsed.last_claim_lane as LaneId | undefined,
        lane_last_claim_at: parsed.lane_last_claim_at ?? {},
      };
    }
  } catch {
    // fall through
  }
  return emptyPickupLaneState();
}

export function serializePickupLaneState(state: PickupLaneState): string {
  return (
    `${PICKUP_LANE_STATE_FENCE_START}\n` +
    `${JSON.stringify(state, null, 2)}\n` +
    `${PICKUP_LANE_STATE_FENCE_END}`
  );
}

/** Upsert the fence block into a board body (preserves surrounding prose). */
export function upsertPickupLaneStateInBody(boardBody: string, state: PickupLaneState): string {
  const block = serializePickupLaneState(state);
  const start = boardBody.indexOf(PICKUP_LANE_STATE_FENCE_START);
  if (start < 0) {
    const base = boardBody.trimEnd();
    return base ? `${base}\n\n${block}\n` : `${block}\n`;
  }
  const end = boardBody.indexOf(PICKUP_LANE_STATE_FENCE_END, start);
  if (end < 0) {
    return `${boardBody.trimEnd()}\n\n${block}\n`;
  }
  const afterEnd = end + PICKUP_LANE_STATE_FENCE_END.length;
  return boardBody.slice(0, start) + block + boardBody.slice(afterEnd);
}

export function recordLaneClaim(
  state: PickupLaneState,
  lane: LaneId,
  slug: string,
  atIso: string,
): PickupLaneState {
  return {
    version: 1,
    sequence: state.sequence + 1,
    last_claim_at: atIso,
    last_claim_slug: slug,
    last_claim_lane: lane,
    lane_last_claim_at: {
      ...state.lane_last_claim_at,
      [lane]: atIso,
    },
  };
}

function hasTag(card: { tags: string[] }, exact: string): boolean {
  const want = exact.toLowerCase();
  return card.tags.some((t) => t.replace(/^#/, "").trim().toLowerCase() === want);
}

function tagPrefix(card: { tags: string[] }, prefix: string): string | undefined {
  const p = prefix.toLowerCase();
  for (const raw of card.tags) {
    const t = raw.replace(/^#/, "").trim();
    if (t.toLowerCase().startsWith(p)) return t.slice(prefix.length);
  }
  return undefined;
}

/** Explicit annotation wins: lane:p0-now | lane:papercut | lane:program:<slug> */
export function explicitLaneTag(card: { tags: string[] }): LaneId | undefined {
  if (hasTag(card, "lane:p0-now") || hasTag(card, "lane:p0")) return "p0-now";
  if (hasTag(card, "lane:papercut")) return "papercut";
  if (hasTag(card, "lane:unlaned")) return "unlaned";
  const prog = tagPrefix(card, "lane:program:");
  if (prog) return `program:${prog}`;
  return undefined;
}

export function isPipelineP0(card: { title: string; body: string; tags: string[] }): boolean {
  if (priorityOf(card) !== "P0") return false;
  const blob = `${card.title}\n${card.body}\n${card.tags.join(" ")}`;
  return PIPELINE_RE.test(blob) || hasTag(card, "pipeline") || hasTag(card, "deploy");
}

export function isPapercutHeuristic(card: { title: string; body: string; tags: string[]; slug: string }): boolean {
  if (hasTag(card, "papercut") || hasTag(card, "hygiene")) return true;
  if (card.slug.startsWith("routine-error-") || card.slug.startsWith("papercut-")) return true;
  return PAPERCUT_RE.test(`${card.slug} ${card.title} ${card.tags.join(" ")}`);
}

export function laneOf(card: Card): LaneId {
  const explicit = explicitLaneTag(card);
  if (explicit) return explicit;

  // Papercuts stay in the papercut lane even if mistagged P0 — otherwise a
  // flood of routine-error P0s starves every program lane.
  if (isPapercutHeuristic(card)) return "papercut";

  // True interrupt lane: explicit p0-now (above), pipeline P0, or generic P0
  // that is not a papercut.
  if (priorityOf(card) === "P0" || isPipelineP0(card)) return "p0-now";

  if (card.north_star && card.north_star.trim()) {
    return `program:${card.north_star.trim()}`;
  }
  const nsTag = tagPrefix(card, "north-star:");
  if (nsTag) return `program:${nsTag}`;

  return "unlaned";
}

export function laneKind(lane: LaneId): LaneKind {
  if (lane === "p0-now") return "p0-now";
  if (lane === "papercut") return "papercut";
  if (lane === "unlaned") return "unlaned";
  return "program";
}

export type LaneBuckets = {
  p0: Card[];
  /** program lane id → ready cards (already rankCards'd within) */
  programs: Map<string, Card[]>;
  papercut: Card[];
  unlaned: Card[];
};

export function bucketReadyCards(readyCards: Card[], ctx?: HardTodoRankContext): LaneBuckets {
  const p0: Card[] = [];
  const programs = new Map<string, Card[]>();
  const papercut: Card[] = [];
  const unlaned: Card[] = [];

  for (const c of readyCards) {
    const lane = laneOf(c);
    if (lane === "p0-now") p0.push(c);
    else if (lane === "papercut") papercut.push(c);
    else if (lane === "unlaned") unlaned.push(c);
    else {
      const list = programs.get(lane) ?? [];
      list.push(c);
      programs.set(lane, list);
    }
  }

  // Within each lane: frontier milestone → priority → age (not priority alone).
  const sortInLane = <T extends Card>(xs: T[]): T[] => rankCardsHardTodo(xs, ctx);

  return {
    p0: sortInLane(p0),
    programs: new Map(
      [...programs.entries()].map(([k, v]) => [k, sortInLane(v)] as const),
    ),
    papercut: sortInLane(papercut),
    unlaned: sortInLane(unlaned),
  };
}

/** Count doing cards per derived lane (starvation signal). */
export function doingCountsByLane(allCards: Card[], board = "default"): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of allCards) {
    if (c.board !== board || c.column !== "doing") continue;
    const lane = laneOf(c);
    counts.set(lane, (counts.get(lane) ?? 0) + 1);
  }
  return counts;
}

/**
 * Order program lanes for fair share:
 * 1. fewer doing in that lane (starved first)
 * 2. older lane_last_claim_at (or never claimed)
 * 3. older first ready card
 * 4. lane id stable
 */
export function orderProgramLanes(
  programs: Map<string, Card[]>,
  doingCounts: Map<string, number>,
  state: PickupLaneState,
): string[] {
  const lanes = [...programs.keys()].filter((k) => (programs.get(k)?.length ?? 0) > 0);
  lanes.sort((a, b) => {
    const da = doingCounts.get(a) ?? 0;
    const db = doingCounts.get(b) ?? 0;
    if (da !== db) return da - db;

    const ta = state.lane_last_claim_at[a] ?? "";
    const tb = state.lane_last_claim_at[b] ?? "";
    // Never claimed sorts first (empty string).
    if (ta !== tb) return ta.localeCompare(tb);

    const ca = programs.get(a)![0]!.created_at;
    const cb = programs.get(b)![0]!.created_at;
    if (ca !== cb) return ca.localeCompare(cb);

    return a.localeCompare(b);
  });
  return lanes;
}

/**
 * Full candidate order for pickup claim (hard todo ranker):
 * p0-now → fair-share(program:* only) → unlaned → papercut.
 *
 * Unlaned is **not** a fair-share peer of programs: program/MS frontier work
 * always drains before untagged cards; papercuts always last.
 * Within each lane, cards use frontier → priority → age.
 */
export function orderCandidatesByLanes(
  readyCards: Card[],
  allCards: Card[],
  state: PickupLaneState,
  board = "default",
  preferRepo: string[] = [],
  ctx?: HardTodoRankContext,
): Card[] {
  const buckets = bucketReadyCards(readyCards, ctx);
  const doingCounts = doingCountsByLane(allCards, board);

  // Fair-share among North Star program lanes only — never let unlaned or
  // papercut steal a slot while a program still has ready work.
  const fairOrder = orderProgramLanes(buckets.programs, doingCounts, state);

  const out: Card[] = [];
  out.push(...buckets.p0);
  for (const lane of fairOrder) {
    out.push(...(buckets.programs.get(lane) ?? []));
  }
  out.push(...buckets.unlaned);
  out.push(...buckets.papercut);

  if (preferRepo.length === 0) return out;

  // Soft prefer-repo still applies *within* the overall list: pull matching
  // repos forward but keep relative lane order among equals by only
  // reordering inside each contiguous priority band is hard — simpler:
  // stable partition prefer vs rest while preserving relative order.
  // Only boost prefer-repo among non-p0: p0 must stay first.
  // Hard tiers still apply: prefer-repo must not pull papercuts ahead of
  // program work — only reorder within the same hard lane tier.
  const prefer = new Set(preferRepo.map((r) => r.toLowerCase()));
  const p0Set = new Set(buckets.p0.map((c) => c.slug));
  const p0 = out.filter((c) => p0Set.has(c.slug));
  const rest = out.filter((c) => !p0Set.has(c.slug));

  const reorderWithinTier = (cards: Card[]): Card[] => {
    // Partition by hard lane tier, prefer-repo within each tier only.
    const byTier = new Map<number, Card[]>();
    for (const c of cards) {
      const t = hardLaneTier(laneOf(c));
      const list = byTier.get(t) ?? [];
      list.push(c);
      byTier.set(t, list);
    }
    const ordered: Card[] = [];
    for (const t of [...byTier.keys()].sort((a, b) => a - b)) {
      const tierCards = byTier.get(t) ?? [];
      const pref: Card[] = [];
      const other: Card[] = [];
      for (const c of tierCards) {
        const repo = (c.repo || "").toLowerCase();
        if (repo && prefer.has(repo)) pref.push(c);
        else other.push(c);
      }
      ordered.push(...pref, ...other);
    }
    return ordered;
  };

  return [...p0, ...reorderWithinTier(rest)];
}

export type LaneStatusRow = {
  lane: LaneId;
  kind: LaneKind;
  ready: number;
  doing: number;
  /** true when ready>0 and doing===0 (starved ready work) */
  starved: boolean;
  next_slug?: string;
  last_claim_at?: string;
};

export function buildLaneStatus(
  readyCards: Card[],
  allCards: Card[],
  state: PickupLaneState,
  board = "default",
  ctx?: HardTodoRankContext,
): LaneStatusRow[] {
  const buckets = bucketReadyCards(readyCards, ctx);
  const doingCounts = doingCountsByLane(allCards, board);
  const rows: LaneStatusRow[] = [];

  const push = (lane: LaneId, readyList: Card[]) => {
    const doing = doingCounts.get(lane) ?? 0;
    const ready = readyList.length;
    rows.push({
      lane,
      kind: laneKind(lane),
      ready,
      doing,
      starved: ready > 0 && doing === 0,
      next_slug: readyList[0]?.slug,
      last_claim_at: state.lane_last_claim_at[lane],
    });
  };

  push("p0-now", buckets.p0);

  // Display matches claim: programs (fair-share order) then unlaned then papercut.
  const fairOrder = orderProgramLanes(buckets.programs, doingCounts, state);
  for (const lane of fairOrder) {
    push(lane as LaneId, buckets.programs.get(lane) ?? []);
  }
  // program with only doing, no ready
  for (const [lane, n] of doingCounts) {
    const kind = laneKind(lane as LaneId);
    if (kind !== "program") continue;
    if (buckets.programs.has(lane)) continue;
    if (n > 0) {
      rows.push({
        lane: lane as LaneId,
        kind,
        ready: 0,
        doing: n,
        starved: false,
        last_claim_at: state.lane_last_claim_at[lane],
      });
    }
  }
  push("unlaned", buckets.unlaned);
  // unlaned doing-only
  {
    const n = doingCounts.get("unlaned") ?? 0;
    if (n > 0 && buckets.unlaned.length === 0) {
      rows.push({
        lane: "unlaned",
        kind: "unlaned",
        ready: 0,
        doing: n,
        starved: false,
        last_claim_at: state.lane_last_claim_at["unlaned"],
      });
    }
  }
  push("papercut", buckets.papercut);

  return rows;
}
