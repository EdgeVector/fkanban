// Keyed feature-flow events. The access pattern is milestone HashRange only:
// one exact event/current read, one card-prefix history, or one milestone
// partition. No board scan and no Card scan exists in this module.

import { FkanbanError, type NodeClient, type QueryFilter, type QueryRow } from "./client.ts";
import { type Config } from "./config.ts";
import { type Card } from "./record.ts";
import { FEATURE_FLOW_EVENTS_FIELDS } from "./schemas.ts";

export const FEATURE_FLOW_SCHEMA_KEY = "feature_flow_events";
export const FEATURE_FLOW_CURRENT_EVENT = "current";
export const FEATURE_FLOW_EVENTS = ["create", "claim", "review", "done", "reopen"] as const;

export type FeatureFlowEventName = (typeof FEATURE_FLOW_EVENTS)[number];

export type FeatureFlowRow = {
  milestone: string;
  event_key: string;
  card_slug: string;
  north_star: string;
  generation: number;
  event: FeatureFlowEventName | typeof FEATURE_FLOW_CURRENT_EVENT;
  stage: FeatureFlowEventName;
  event_at: string;
  created_at: string;
  updated_at: string;
};

export type FeatureFlowMutationResult = {
  configured: boolean;
  milestone: string;
  card_slug: string;
  generation: number | null;
  recorded: FeatureFlowEventName[];
};

export type FeatureFlowCardSummary = {
  card_slug: string;
  north_star: string;
  generation: number;
  stage: FeatureFlowEventName;
  stage_at: string;
  elapsed_seconds: number;
  timestamps: Partial<Record<FeatureFlowEventName, string>>;
  events: Array<{ event: FeatureFlowEventName; event_at: string }>;
};

export type FeatureFlowReport = {
  milestone: string;
  generated_at: string;
  cards: FeatureFlowCardSummary[];
  oldest_wait: null | {
    card_slug: string;
    stage: FeatureFlowEventName;
    stage_at: string;
    elapsed_seconds: number;
  };
};

const EVENT_ORDER: Record<FeatureFlowEventName, number> = {
  create: 0,
  reopen: 1,
  claim: 2,
  review: 3,
  done: 4,
};

function stringField(fields: Record<string, unknown>, name: string): string {
  const value = fields[name];
  return typeof value === "string" ? value : "";
}

function generationField(fields: Record<string, unknown>): number {
  const value = Number.parseInt(stringField(fields, "generation"), 10);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function isEventName(value: string): value is FeatureFlowEventName {
  return (FEATURE_FLOW_EVENTS as readonly string[]).includes(value);
}

function rowFromQuery(row: QueryRow, milestone: string): FeatureFlowRow | null {
  const fields = (row.fields ?? {}) as Record<string, unknown>;
  const eventKey = typeof row.key?.range === "string"
    ? row.key.range
    : stringField(fields, "event_key");
  const cardSlug = stringField(fields, "card_slug");
  const event = stringField(fields, "event");
  const stage = stringField(fields, "stage");
  if (!eventKey || !cardSlug || (!isEventName(event) && event !== FEATURE_FLOW_CURRENT_EVENT)) return null;
  if (!isEventName(stage)) return null;
  return {
    milestone,
    event_key: eventKey,
    card_slug: cardSlug,
    north_star: stringField(fields, "north_star"),
    generation: generationField(fields),
    event,
    stage,
    event_at: stringField(fields, "event_at"),
    created_at: stringField(fields, "created_at"),
    updated_at: stringField(fields, "updated_at"),
  };
}

export function featureFlowSchemaHash(cfg: Config): string | null {
  const value = cfg.schemaHashes?.[FEATURE_FLOW_SCHEMA_KEY];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function isFeatureFlowCard(card: Pick<Card, "north_star" | "milestone">): boolean {
  return Boolean(card.north_star?.trim() && card.milestone?.trim());
}

export function featureFlowCurrentKey(cardSlug: string): string {
  return `${cardSlug}#current`;
}

export function featureFlowEventKey(
  cardSlug: string,
  generation: number,
  event: FeatureFlowEventName,
): string {
  return `${cardSlug}#g${Math.max(0, generation).toString().padStart(8, "0")}#${event}`;
}

async function readExact(
  node: NodeClient,
  schemaHash: string,
  milestone: string,
  eventKey: string,
): Promise<FeatureFlowRow | null> {
  const filter = {
    HashRangeKey: { hash: milestone, range: eventKey },
  } as unknown as QueryFilter;
  const response = await node.queryAll({
    schemaHash,
    fields: [...FEATURE_FLOW_EVENTS_FIELDS],
    filter,
  });
  for (const queryRow of response.results) {
    if (queryRow.key?.range !== eventKey) continue;
    const row = rowFromQuery(queryRow, milestone);
    if (row) return row;
  }
  return null;
}

function rowFields(row: FeatureFlowRow): Record<string, unknown> {
  return {
    milestone: row.milestone,
    event_key: row.event_key,
    card_slug: row.card_slug,
    north_star: row.north_star,
    generation: String(row.generation),
    event: row.event,
    stage: row.stage,
    event_at: row.event_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function writeRow(
  node: NodeClient,
  schemaHash: string,
  row: FeatureFlowRow,
): Promise<void> {
  await node.updateRecord({
    schemaHash,
    keyHash: row.milestone,
    rangeKey: row.event_key,
    fields: rowFields(row),
  });
}

async function ensureEvent(opts: {
  node: NodeClient;
  schemaHash: string;
  milestone: string;
  card: Card;
  generation: number;
  event: FeatureFlowEventName;
  eventAt: string;
  now: string;
}): Promise<{ created: boolean; row: FeatureFlowRow }> {
  const eventKey = featureFlowEventKey(opts.card.slug, opts.generation, opts.event);
  const existing = await readExact(opts.node, opts.schemaHash, opts.milestone, eventKey);
  if (existing) return { created: false, row: existing };
  const row: FeatureFlowRow = {
    milestone: opts.milestone,
    event_key: eventKey,
    card_slug: opts.card.slug,
    north_star: opts.card.north_star,
    generation: opts.generation,
    event: opts.event,
    stage: opts.event,
    event_at: opts.eventAt || opts.now,
    created_at: opts.now,
    updated_at: opts.now,
  };
  await writeRow(opts.node, opts.schemaHash, row);
  return { created: true, row };
}

async function writeCurrent(opts: {
  node: NodeClient;
  schemaHash: string;
  milestone: string;
  card: Card;
  generation: number;
  stage: FeatureFlowEventName;
  stageAt: string;
  createdAt: string;
  now: string;
}): Promise<void> {
  await writeRow(opts.node, opts.schemaHash, {
    milestone: opts.milestone,
    event_key: featureFlowCurrentKey(opts.card.slug),
    card_slug: opts.card.slug,
    north_star: opts.card.north_star,
    generation: opts.generation,
    event: FEATURE_FLOW_CURRENT_EVENT,
    stage: opts.stage,
    event_at: opts.stageAt,
    created_at: opts.createdAt,
    updated_at: opts.now,
  });
}

/**
 * Converge one feature card's flow rows after its authoritative card write.
 *
 * The schema is optional during rollout. Once `kanban init` binds it, a flow
 * write failure is explicit: the card write already landed, so the caller gets
 * `feature_flow_partial_write` and can retry an idempotent card mutation.
 */
export async function recordFeatureFlowMutation(opts: {
  node: NodeClient;
  cfg: Config;
  previous: Card | null;
  next: Card;
  terminalColumn?: string;
  now?: string;
}): Promise<FeatureFlowMutationResult> {
  const milestone = opts.next.milestone?.trim() ?? "";
  const base: FeatureFlowMutationResult = {
    configured: false,
    milestone,
    card_slug: opts.next.slug,
    generation: null,
    recorded: [],
  };
  if (!isFeatureFlowCard(opts.next)) return base;
  const schemaHash = featureFlowSchemaHash(opts.cfg);
  if (!schemaHash) return base;
  base.configured = true;

  const now = opts.now ?? new Date().toISOString();
  const terminal = opts.terminalColumn ?? "done";

  try {
    let current = await readExact(
      opts.node,
      schemaHash,
      milestone,
      featureFlowCurrentKey(opts.next.slug),
    );
    let generation = current?.generation ?? 0;
    const createdAt = current?.created_at || opts.next.created_at || now;

    const record = async (event: FeatureFlowEventName, eventAt: string): Promise<void> => {
      const ensured = await ensureEvent({
        node: opts.node,
        schemaHash,
        milestone,
        card: opts.next,
        generation,
        event,
        eventAt,
        now,
      });
      if (ensured.created) base.recorded.push(event);
      await writeCurrent({
        node: opts.node,
        schemaHash,
        milestone,
        card: opts.next,
        generation,
        stage: event,
        stageAt: ensured.row.event_at,
        createdAt,
        now,
      });
      current = {
        milestone,
        event_key: featureFlowCurrentKey(opts.next.slug),
        card_slug: opts.next.slug,
        north_star: opts.next.north_star,
        generation,
        event: FEATURE_FLOW_CURRENT_EVENT,
        stage: event,
        event_at: ensured.row.event_at,
        created_at: createdAt,
        updated_at: now,
      };
    };

    if (!current) await record("create", opts.next.created_at || now);

    const shouldReopen = opts.next.column !== terminal && (
      opts.previous?.column === terminal || current?.stage === "done"
    );
    if (shouldReopen) {
      generation += 1;
      await record("reopen", opts.next.updated_at || now);
    }

    const enteredDoing = opts.next.column === "doing" && opts.previous?.column !== "doing";
    const missedClaim = opts.next.column === "doing" && Boolean(opts.next.assignee) && current?.stage === "create";
    if (Boolean(opts.next.assignee) && (enteredDoing || missedClaim)) {
      await record("claim", opts.next.updated_at || now);
    }

    const reviewChanged = Boolean(opts.next.pr_url) && opts.previous?.pr_url !== opts.next.pr_url;
    const reviewEventExists = Boolean(opts.next.pr_url) && !reviewChanged && current?.stage !== "review" &&
      current?.stage !== "done" && Boolean(await readExact(
        opts.node,
        schemaHash,
        milestone,
        featureFlowEventKey(opts.next.slug, generation, "review"),
      ));
    if (reviewChanged || reviewEventExists) {
      await record("review", opts.next.updated_at || now);
    }

    if (opts.next.column === terminal && current?.stage !== "done") {
      await record("done", opts.next.done_at || opts.next.updated_at || now);
    }

    base.generation = generation;
    return base;
  } catch (cause) {
    throw new FkanbanError({
      code: "feature_flow_partial_write",
      message:
        `Card "${opts.next.slug}" was written, but its keyed feature-flow ledger did not converge.`,
      hint:
        `Re-run an idempotent metadata write for the card after the node recovers. ` +
        `The ledger uses stable event keys, so the retry cannot duplicate history.`,
      cause,
    });
  }
}

function epochMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stageCompare(a: FeatureFlowRow, b: FeatureFlowRow): number {
  return epochMs(a.event_at) - epochMs(b.event_at) ||
    EVENT_ORDER[a.stage] - EVENT_ORDER[b.stage];
}

/** One bounded HashRange partition read. */
export async function featureFlowReport(opts: {
  node: NodeClient;
  cfg: Config;
  milestone: string;
  now?: string;
}): Promise<FeatureFlowReport> {
  const milestone = opts.milestone.trim();
  if (!milestone) {
    throw new FkanbanError({ code: "flow_milestone_required", message: "Flow needs a milestone slug." });
  }
  const schemaHash = featureFlowSchemaHash(opts.cfg);
  if (!schemaHash) {
    throw new FkanbanError({
      code: "feature_flow_schema_unbound",
      message: "The feature-flow schema is not bound in the F-Kanban config.",
      hint: "Run `kanban init` after the FeatureFlowEvents schema is published.",
    });
  }

  const response = await opts.node.queryAll({
    schemaHash,
    fields: [...FEATURE_FLOW_EVENTS_FIELDS],
    filter: { HashKey: milestone },
  });
  const rows = response.results
    .map((row) => rowFromQuery(row, milestone))
    .filter((row): row is FeatureFlowRow => row !== null && row.event !== FEATURE_FLOW_CURRENT_EVENT);

  const byCard = new Map<string, FeatureFlowRow[]>();
  for (const row of rows) {
    const bucket = byCard.get(row.card_slug) ?? [];
    bucket.push(row);
    byCard.set(row.card_slug, bucket);
  }

  const generatedAt = opts.now ?? new Date().toISOString();
  const generatedMs = epochMs(generatedAt);
  const cards: FeatureFlowCardSummary[] = [];
  for (const [cardSlug, cardRows] of byCard) {
    const generation = Math.max(...cardRows.map((row) => row.generation));
    const events = cardRows
      .filter((row) => row.generation === generation && row.event !== FEATURE_FLOW_CURRENT_EVENT)
      .sort(stageCompare);
    const latest = events.at(-1);
    if (!latest || !isEventName(latest.event)) continue;
    const timestamps: Partial<Record<FeatureFlowEventName, string>> = {};
    for (const row of events) {
      if (isEventName(row.event)) timestamps[row.event] = row.event_at;
    }
    cards.push({
      card_slug: cardSlug,
      north_star: latest.north_star,
      generation,
      stage: latest.stage,
      stage_at: latest.event_at,
      elapsed_seconds: Math.max(0, Math.floor((generatedMs - epochMs(latest.event_at)) / 1000)),
      timestamps,
      events: events.map((row) => ({ event: row.event as FeatureFlowEventName, event_at: row.event_at })),
    });
  }
  cards.sort((a, b) => b.elapsed_seconds - a.elapsed_seconds || a.card_slug.localeCompare(b.card_slug));
  const oldest = cards.find((card) => card.stage !== "done");
  return {
    milestone,
    generated_at: generatedAt,
    cards,
    oldest_wait: oldest
      ? {
          card_slug: oldest.card_slug,
          stage: oldest.stage,
          stage_at: oldest.stage_at,
          elapsed_seconds: oldest.elapsed_seconds,
        }
      : null,
  };
}

export function formatFeatureFlowReport(report: FeatureFlowReport, json?: boolean): string {
  if (json) return JSON.stringify(report, null, 2);
  if (report.cards.length === 0) return `flow ${report.milestone}: no feature events`;
  const lines = [`flow ${report.milestone}: ${report.cards.length} card(s)`];
  for (const card of report.cards) {
    lines.push(
      `  ${card.card_slug}  generation=${card.generation}  stage=${card.stage}  wait=${card.elapsed_seconds}s`,
    );
  }
  if (report.oldest_wait) {
    lines.push(
      `oldest: ${report.oldest_wait.card_slug} stage=${report.oldest_wait.stage} wait=${report.oldest_wait.elapsed_seconds}s`,
    );
  }
  return lines.join("\n");
}
