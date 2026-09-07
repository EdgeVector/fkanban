// Schema definitions for fkanban's record types.
//
// Two schemas back the board:
//
//   - **Card** — one card on a kanban board. Lives in a `column` (the
//     kanban status) and on a `board`. Moving a card = updating `column`.
//   - **Board** — a named board with an ordered list of `columns`.
//
// How the CLI gets the canonical hashes (the values every mutation/query MUST
// pin to): the `fkanban/*` schemas are private in visibility, but their
// identities must still be registered with Schema Service. At `init` time the
// CLI submits them through Mini's `/api/apps/declare-schema` orchestration
// route; Mini must resolve/register the proposal and return the catalog hash.
// fkanban then write-probes those hashes before persisting them in config.
// Shared-surface publication is optional governance; catalog registration is
// not. The `descriptive_name` /
// `purpose_statement` are for human display + the dual-signal canonicalization
// gate (so Card and Board never collapse onto one canonical hash, and
// `fkanban/*` never collides with another app).

// The app id that owns every fkanban schema. Under app_identity v3.1,
// `owner_app_id` folds into the schema's identity hash, so the
// registered declaration stores these under canonical identities equivalent to
// `fkanban/Card` and `fkanban/Board` — distinct from `fbrain/*` or any other
// app's schemas even when the field shape matches.
export const OWNER_APP_ID = "fkanban";

/** Prefix a short schema name with the owning app id → `fkanban/<Name>`. */
export function namespacedSchemaName(shortName: string): string {
  return `${OWNER_APP_ID}/${shortName}`;
}

export type FieldType = "String" | { Array: "String" };

export type SchemaDefinition = {
  name: string;
  owner_app_id: string;
  descriptive_name: string;
  purpose_statement?: string;
  // "HashRange" backs CardIndex: a partition (hash_field) plus a range_field
  // that makes each row unique within its partition. Card/Board stay "Hash"
  // (point read by a single key field).
  schema_type: "Hash" | "HashRange";
  key: { hash_field: string; range_field?: string };
  fields: string[];
  field_types: Record<string, FieldType>;
  field_descriptions: Record<string, string>;
  field_classifications?: Record<string, string[]>;
  field_data_classifications: Record<
    string,
    { sensitivity_level: number; data_domain: string }
  >;
};

// `membership_schema_guard.ts` is import-free, so this stays acyclic and this
// module stays pure.
import { MEMBERSHIP_KEY_EXPECTATIONS } from "./membership_schema_guard.ts";

export type AddSchemaRequest = {
  schema: SchemaDefinition;
  mutation_mappers: Record<string, string>;
};

// The kanban columns a card moves through. FIXED set (Tom 2026-07-16):
// backlog → todo → doing → done. No review lane, no custom column names.
// Incomplete work is todo/doing; complete is done; intentional holds use
// block_status (needs_human/deferred/design_first), not extra columns.
// Boards cannot redefine columns — `board create --columns` only accepts
// this exact list (or omits it and gets the same).
export const DEFAULT_COLUMNS = [
  "backlog",
  "todo",
  "doing",
  "done",
] as const;
export type Column = (typeof DEFAULT_COLUMNS)[number];

export const DEFAULT_BOARD_SLUG = "default";

/** Exact fixed column list as a mutable string[] (for board records / APIs). */
export function fixedColumns(): string[] {
  return [...DEFAULT_COLUMNS];
}

/**
 * Whether `columns` is exactly the fixed kanban layout (same names, same order).
 * Empty / omitted lists are treated as "use fixed" (not a mismatch).
 */
export function isFixedColumnList(columns: readonly string[] | undefined | null): boolean {
  if (!columns || columns.length === 0) return true;
  if (columns.length !== DEFAULT_COLUMNS.length) return false;
  return columns.every((c, i) => c === DEFAULT_COLUMNS[i]);
}

/**
 * Always the fixed column set. `boardColumns` is ignored so a stale board
 * record (or an old custom layout) cannot reopen arbitrary column names for
 * move/add/list validation. Kept as a function so call sites stay stable.
 */
export function resolveColumns(_boardColumns?: readonly string[]): string[] {
  return fixedColumns();
}

const GENERAL = { sensitivity_level: 0, data_domain: "general" };

export const CARD_FIELDS = [
  "slug",
  "title",
  "body",
  "board",
  "column",
  "position",
  "assignee",
  "tags",
  "deps",
  "surfaces",
  "created_at",
  "created_by",
  "updated_at",
  "db",
  // Structured pickup-decision + reconcile fields (see fbrain design
  // `fkanban-card-structured-fields`). Promote signals a fresh agent needs
  // to decide "what do I pick up?" out of body prose into real fields, so
  // every routine reads them the same way. `priority` is intentionally
  // ABSENT — it's owned by a parallel design and added later (cheap, per
  // LastDB's read-through field-mapper republish).
  "repo",
  "base",
  "kind",
  "block_status",
  "block_reason",
  "north_star",
  "milestone",
  "pr_url",
  "branch",
] as const;

// New fields that can be losslessly mirrored through legacy body headers while
// the published schema catches up. The resolver/doctor can treat a schema
// missing only these fields as operationally writable.
export const CARD_OPTIONAL_SCHEMA_FIELDS = ["surfaces", "db", "created_by", "milestone"] as const;

/**
 * Field descriptions shared by Card and its thin keyed membership projections.
 *
 * LastDB protein bind uses field identity H(name, description, type, version).
 * Shared Card/BoardCards values must therefore use byte-identical descriptions.
 * Key-local fields such as `sk`/`layout` and Card-only fields such as `body`
 * stay out of this set.
 */
export const CARD_THIN_SHARED_FIELD_DESCRIPTIONS: Record<string, string> = {
  slug: "card slug",
  title: "one-line card name",
  board: "board slug",
  column: DEFAULT_COLUMNS.join("|"),
  position: "integer-as-string ordering within the column",
  assignee: "who owns the card",
  tags: "array of freeform labels",
  deps: "array of dependency card slugs",
  surfaces: "array of path globs / subsystem names",
  created_at: "RFC 3339 timestamp",
  created_by: "creator identity",
  updated_at: "RFC 3339 timestamp",
  db: "home LastDB locator",
  repo: "owner/name of the code repo",
  base: "PR base branch",
  kind: "pr|registry|tracker|...",
  block_status: "none|needs_human|design_first|deferred",
  block_reason: "free-text when blocked",
  north_star: "North Star slug",
  milestone: "Milestone slug",
  pr_url: "PR URL when in flight",
  branch: "feature branch",
};

const CARD_THIN_SHARED_FIELD_DESCRIPTIONS_EXCEPT_BOARD = Object.fromEntries(
  Object.entries(CARD_THIN_SHARED_FIELD_DESCRIPTIONS).filter(([field]) => field !== "board"),
) as Record<string, string>;

export const BOARD_FIELDS = [
  "slug",
  "title",
  "body",
  "columns",
  "created_at",
  "updated_at",
] as const;

export const MILESTONE_FIELDS = [
  "slug", "title", "body", "board", "state", "position", "north_star",
  "driver", "deps", "proof_card", "proof_status", "block_reason",
  "created_at", "updated_at", "completed_at",
] as const;

/**
 * Shared by Milestone (hash=slug) and BoardMilestones (hash=board, range=sk).
 * Byte-identical field descriptions let Mini treat the common payload fields
 * as one product under different keys; `sk` and `layout` remain index-only.
 */
export const MILESTONE_SHARED_FIELD_DESCRIPTIONS: Record<string, string> = {
  slug: "milestone slug",
  title: "one-line outcome name",
  body: "markdown outcome, acceptance criteria, and rationale",
  board: "board whose cards this milestone groups",
  state: "planned|active|blocked|proving|complete|abandoned",
  position: "integer-as-string portfolio ordering",
  north_star: "fbrain North Star slug this outcome advances",
  driver: "person, agent, or routine responsible for reconciliation",
  deps: "array of milestone slugs that must complete first",
  proof_card: "terminal validation card slug",
  proof_status: "pending|passing|failing|not_required",
  block_reason: "why the milestone is blocked",
  created_at: "RFC 3339 timestamp",
  updated_at: "RFC 3339 timestamp",
  completed_at: "RFC 3339 completion timestamp, empty until complete",
};

function defaultStringFieldTypes(
  fields: readonly string[],
  arrayFields: readonly string[],
): Record<string, FieldType> {
  const arrays = new Set(arrayFields);
  return Object.fromEntries(
    fields.map((field) => [
      field,
      arrays.has(field) ? { Array: "String" } : "String",
    ]),
  ) as Record<string, FieldType>;
}

function generalDataClassifications(
  fields: readonly string[],
): SchemaDefinition["field_data_classifications"] {
  return Object.fromEntries(fields.map((field) => [field, GENERAL]));
}

export const cardSchema: AddSchemaRequest = {
  schema: {
    name: "Card",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "Card",
    purpose_statement:
      "A single work item on a kanban board, moved through columns over its lifecycle",
    schema_type: "Hash",
    key: { hash_field: "slug" },
    fields: [...CARD_FIELDS],
    field_types: defaultStringFieldTypes(CARD_FIELDS, ["tags", "deps", "surfaces"]),
    field_descriptions: {
      ...CARD_THIN_SHARED_FIELD_DESCRIPTIONS,
      body: "markdown description / notes",
    },
    field_classifications: { title: ["word"], body: ["word"] },
    field_data_classifications: generalDataClassifications(CARD_FIELDS),
  },
  mutation_mappers: {},
};


export const boardSchema: AddSchemaRequest = {
  schema: {
    name: "Board",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "Board",
    purpose_statement:
      "A named kanban board defining an ordered set of columns cards flow through",
    schema_type: "Hash",
    key: { hash_field: "slug" },
    fields: [...BOARD_FIELDS],
    field_types: defaultStringFieldTypes(BOARD_FIELDS, ["columns"]),
    field_descriptions: {
      slug: "stable url-style id",
      title: "one-line board name",
      body: "markdown description",
      columns: "ordered list of column names cards move through",
      created_at: "RFC 3339 timestamp",
      updated_at: "RFC 3339 timestamp",
    },
    field_classifications: { title: ["word"], body: ["word"] },
    field_data_classifications: generalDataClassifications(BOARD_FIELDS),
  },
  mutation_mappers: {},
};

export const milestoneSchema: AddSchemaRequest = {
  schema: {
    name: "Milestone",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "Milestone",
    purpose_statement: "A bounded, multi-card outcome managed and completed through terminal proof",
    schema_type: "Hash",
    key: { hash_field: "slug" },
    fields: [...MILESTONE_FIELDS],
    field_types: defaultStringFieldTypes(MILESTONE_FIELDS, ["deps"]),
    field_descriptions: { ...MILESTONE_SHARED_FIELD_DESCRIPTIONS },
    field_classifications: { title: ["word"], body: ["word"] },
    field_data_classifications: generalDataClassifications(MILESTONE_FIELDS),
  },
  mutation_mappers: {},
};

export const RECORD_TYPES = ["card", "board", "milestone"] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export type RecordTypeDef = {
  type: RecordType;
  schema: AddSchemaRequest;
};

export const RECORDS: Record<RecordType, RecordTypeDef> = {
  card: { type: "card", schema: cardSchema },
  board: { type: "board", schema: boardSchema },
  milestone: { type: "milestone", schema: milestoneSchema },
};


// Body-free rollup of all live cards (slug+metadata, no body), one Hash-keyed
// row (`all_cards`). Declared at init as fkanban/CardListIndex.
//
// RETIRED as a write target wherever `board_cards` is bound (2026-07-28).
// BoardCards (HashRange, hash=board) already holds the same body-free summary
// one row per card and is the primary read path, so `all_cards` was a redundant
// second copy rewritten IN FULL on every card mutation — 272 KB per write,
// growing ~1.9 KB/h toward the atom-size ceiling, never dropping deleted cards,
// and losing updates under concurrency (no CAS on the read-modify-write).
// Full autopsy: src/card-list-index.ts.
//
// Reads still dual-read it while it holds entries; `groom card-list-index-retire`
// clears the payload once BoardCards coverage is proven. The `all_boards` row on
// this same schema is NOT retired — it is bounded by board count.
export const CARD_LIST_INDEX_KEY = "all_cards";
export const CARD_LIST_INDEX_FIELDS = ["key", "payload_json", "updated_at"] as const;

export const cardListIndexSchema: AddSchemaRequest = {
  schema: {
    name: "CardListIndex",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "CardListIndex",
    purpose_statement:
      "Single-row body-free index of every live card so list/pickup never full-scan Card",
    schema_type: "Hash",
    key: { hash_field: "key" },
    fields: [...CARD_LIST_INDEX_FIELDS],
    field_types: defaultStringFieldTypes(CARD_LIST_INDEX_FIELDS, []),
    field_descriptions: {
      key: "index row id (always all_cards)",
      payload_json: "JSON array of body-free card summaries",
      updated_at: "RFC 3339 timestamp",
    },
    field_classifications: {},
    field_data_classifications: generalDataClassifications(CARD_LIST_INDEX_FIELDS),
  },
  mutation_mappers: {},
};

// Dynamo-style board membership: partition = board, sort key = column#pos#slug.
// Thin projection only (no body). List/pickup query one board partition;
// show still point-reads Card by slug for body.
export const BOARD_CARDS_LAYOUT = "hashrange_v1_board_partition";
export const BOARD_CARDS_FIELDS = [
  "board",
  "sk",
  "slug",
  "title",
  "column",
  "position",
  "assignee",
  "tags",
  "deps",
  "surfaces",
  "created_at",
  "created_by",
  "updated_at",
  "db",
  "repo",
  "base",
  "kind",
  "block_status",
  "block_reason",
  "north_star",
  "milestone",
  "pr_url",
  "branch",
  "layout",
] as const;

/**
 * Field descriptions shared by BoardCards and MilestoneCards for every field
 * that is *not* the partition identity marker.
 *
 * LastDB protein bind uses field identity H(name, description, type, version).
 * Shared payload fields must use **byte-identical** descriptions so the two
 * multi-key layouts co-identity and Mini can fold a BoardCards write onto
 * MilestoneCards tips (docs/app-developers-multi-key-proteins.md).
 *
 * `layout` is intentionally **not** shared — distinct partition markers must
 * not fold (board vs milestone membership).
 */
export const CARD_MEMBERSHIP_SHARED_FIELD_DESCRIPTIONS: Record<string, string> = {
  board: CARD_THIN_SHARED_FIELD_DESCRIPTIONS.board!,
  sk: "sort key column#position(8)#slug",
  ...CARD_THIN_SHARED_FIELD_DESCRIPTIONS_EXCEPT_BOARD,
};

export const boardCardsSchema: AddSchemaRequest = {
  schema: {
    name: "BoardCards",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "BoardCards_hashrange_v1",
    purpose_statement:
      "Thin per-board card membership (HashRange) so list/pickup never full-scan Card or hydrate bodies",
    schema_type: "HashRange",
    key: { hash_field: "board", range_field: "sk" },
    fields: [...BOARD_CARDS_FIELDS],
    field_types: defaultStringFieldTypes(BOARD_CARDS_FIELDS, ["tags", "deps", "surfaces"]),
    field_descriptions: {
      ...CARD_MEMBERSHIP_SHARED_FIELD_DESCRIPTIONS,
      // Distinct from MilestoneCards.layout so partition markers never co-identity.
      layout:
        "identity marker for HashRange board membership partition (do not change without new schema)",
    },
    field_classifications: { title: ["word"] },
    field_data_classifications: generalDataClassifications(BOARD_CARDS_FIELDS),
  },
  mutation_mappers: {},
};

// Dynamo-style board → milestones: partition = board, sort key = state#pos#slug.
// Thin enough for portfolio/gap-report without scanning the Milestone schema.
export const BOARD_MILESTONES_LAYOUT = "hashrange_v1_board_milestones";
export const BOARD_MILESTONES_FIELDS = [
  "board",
  "sk",
  "slug",
  "title",
  "body",
  "state",
  "position",
  "north_star",
  "driver",
  "deps",
  "proof_card",
  "proof_status",
  "block_reason",
  "created_at",
  "updated_at",
  "completed_at",
  "layout",
] as const;

export const boardMilestonesSchema: AddSchemaRequest = {
  schema: {
    name: "BoardMilestones",
    owner_app_id: OWNER_APP_ID,
    // descriptive_name must NOT share card/board-index vocabulary with
    // `BoardCards_hashrange_v1`. Mini's declare resolver embeds the
    // descriptive_name and expands/reuses the closest catalog schema; the old
    // `BoardMilestones_hashrange_v1_portfolio_20260723` still embedded next to
    // `BoardCards_hashrange_v1` and collapsed onto it — a composite MISSING
    // `completed_at` (the 2026-07-23 expand bug; live pin was
    // 1ef2e7a3…, descriptive_name "BoardCards_hashrange_v1"). Only a card-free,
    // milestone-flavoured name resolves to a clean own-schema: declaring this
    // exact name against the live node returned resolution=register with the
    // proposal's OWN identity hash (verified 2026-07-24), because this schema's
    // milestone fields (state/driver/proof_card/proof_status/completed_at) are
    // not field-covered by any card composite.
    //   NOTE: the sibling `milestone_cards` index can't be fixed this way — its
    //   field set is card-shaped, so the resolver expands a card predecessor
    //   onto it regardless of name. It stays a superset composite (functional:
    //   right key + all fields) pending a structural field change.
    descriptive_name: "FkanbanMilestonePortfolioByBoardIndex",
    purpose_statement:
      "Per-board index of milestone outcomes and their proof/completion lifecycle; partitioned by board so the milestone portfolio and gap report load without a full Milestone scan",
    schema_type: "HashRange",
    key: { hash_field: "board", range_field: "sk" },
    fields: [...BOARD_MILESTONES_FIELDS],
    field_types: defaultStringFieldTypes(BOARD_MILESTONES_FIELDS, ["deps"]),
    field_descriptions: {
      ...MILESTONE_SHARED_FIELD_DESCRIPTIONS,
      sk: "sort key state#position(8)#slug for ordered portfolio lists",
      layout: "identity marker for HashRange layout",
    },
    field_classifications: { title: ["word"], body: ["word"] },
    field_data_classifications: generalDataClassifications(BOARD_MILESTONES_FIELDS),
  },
  mutation_mappers: {},
};

// Dynamo-style milestone → cards: partition = milestone, sort key = column#pos#slug.
// Reverse membership so detail/reconcile never filter the whole board.
export const MILESTONE_CARDS_LAYOUT = "hashrange_v1_milestone_cards";
export const MILESTONE_CARDS_FIELDS = [
  "milestone",
  "sk",
  "slug",
  "title",
  "board",
  "column",
  "position",
  "assignee",
  "tags",
  "deps",
  "surfaces",
  "created_at",
  "created_by",
  "updated_at",
  "db",
  "repo",
  "base",
  "kind",
  "block_status",
  "block_reason",
  "north_star",
  "pr_url",
  "branch",
  "layout",
] as const;

export const milestoneCardsSchema: AddSchemaRequest = {
  schema: {
    name: "MilestoneCards",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "MilestoneCards_hashrange_v1_children_20260723",
    purpose_statement:
      "Thin per-milestone card membership (HashRange) so detail/reconcile never filter all board cards",
    schema_type: "HashRange",
    key: { hash_field: "milestone", range_field: "sk" },
    fields: [...MILESTONE_CARDS_FIELDS],
    field_types: defaultStringFieldTypes(MILESTONE_CARDS_FIELDS, ["tags", "deps", "surfaces"]),
    field_descriptions: {
      // Shared payload/key fields MUST match BoardCards (protein field identity).
      ...CARD_MEMBERSHIP_SHARED_FIELD_DESCRIPTIONS,
      // Distinct from BoardCards.layout so partition markers never co-identity.
      layout:
        "identity marker for HashRange milestone membership partition (do not change without new schema)",
    },
    field_classifications: { title: ["word"] },
    field_data_classifications: generalDataClassifications(MILESTONE_CARDS_FIELDS),
  },
  mutation_mappers: {},
};

// Keyed feature-delivery history: partition = milestone, range = card event.
// One milestone read answers its complete flow report. One exact range key
// makes each transition idempotent. No board or Card enumeration is needed.
export const FEATURE_FLOW_EVENTS_FIELDS = [
  "milestone",
  "event_key",
  "card_slug",
  "north_star",
  "generation",
  "event",
  "stage",
  "event_at",
  "created_at",
  "updated_at",
] as const;

export const featureFlowEventsSchema: AddSchemaRequest = {
  schema: {
    name: "FeatureFlowEvents",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "FkanbanFeatureFlowEventsByMilestone",
    purpose_statement:
      "Keyed feature-card transition history by milestone and card, used to report current stage latency without a board scan",
    schema_type: "HashRange",
    key: { hash_field: "milestone", range_field: "event_key" },
    fields: [...FEATURE_FLOW_EVENTS_FIELDS],
    field_types: defaultStringFieldTypes(FEATURE_FLOW_EVENTS_FIELDS, []),
    field_descriptions: {
      milestone: "milestone partition that owns the feature card",
      event_key: "stable card#generation#event range key, or card#current",
      card_slug: "feature card slug",
      north_star: "Brain North Star slug that owns the feature outcome",
      generation: "zero-based reopen generation as a decimal string",
      event: "create|claim|review|done|reopen|current",
      stage: "current feature-delivery stage after this event",
      event_at: "RFC 3339 transition timestamp",
      created_at: "RFC 3339 first ledger-row timestamp",
      updated_at: "RFC 3339 last ledger-row update timestamp",
    },
    field_classifications: {},
    field_data_classifications: generalDataClassifications(FEATURE_FLOW_EVENTS_FIELDS),
  },
  mutation_mappers: {},
};

// One entry per schema `kanban init` must register. Binds a config-key
// (where init writes the canonical hash) to the AddSchemaRequest.
export const UNIQUE_SCHEMAS: Array<{ key: RecordType; schema: AddSchemaRequest }> = [
  { key: "card", schema: cardSchema },
  { key: "board", schema: boardSchema },
  { key: "milestone", schema: milestoneSchema },
];

/** Extra schemas declared at init (not RECORD_TYPES). */
export const EXTRA_SCHEMAS: Array<{ key: string; schema: AddSchemaRequest }> = [
  { key: "card_list_index", schema: cardListIndexSchema },
  { key: "board_cards", schema: boardCardsSchema },
  { key: "board_milestones", schema: boardMilestonesSchema },
  { key: "milestone_cards", schema: milestoneCardsSchema },
  { key: "feature_flow_events", schema: featureFlowEventsSchema },
];


export function isRecordType(s: string): s is RecordType {
  return (RECORD_TYPES as readonly string[]).includes(s);
}

export function fieldsFor(type: RecordType): string[] {
  return RECORDS[type].schema.schema.fields.slice();
}

export function isDefaultColumn(s: string): s is Column {
  return (DEFAULT_COLUMNS as readonly string[]).includes(s);
}

// One candidate schema loaded on the node, as the resolver sees it: the
// canonical hash plus the field set the node reports for it. (Structurally a
// subset of client.ts's `LoadedSchema`, redeclared here so this pure module
// has no client dependency.)
export type LoadedSchemaCandidate = {
  name: string;
  descriptive_name: string;
  owner_app_id: string;
  fields: string[];
  // Key layout as the node reports it, or `null`/absent when the node omits it.
  // See `resolveLoadedSchema` step 2 for why fields alone cannot separate an
  // entity from its own membership index.
  key?: { hash_field: string; range_field: string | null } | null;
  // Catalog lifecycle state as `/api/schemas` reports it. Only an `Available`
  // schema answers a name resolution or accepts a write, so every claimant
  // count in this file is scoped to that state. Absent/empty means the node did
  // not report one — treated as `Available`, because a node that lists a schema
  // at all has it loaded, and reading silence as "not available" would make an
  // older node's catalog look empty rather than unknown.
  state?: string | null;
};

/** Does this loaded schema answer name resolutions and accept writes? */
export function isAvailableSchema(s: { state?: string | null }): boolean {
  return s.state == null || s.state === "" || s.state === "Available";
}

export type SchemaResolution =
  // `hash` is the RANKED-BEST write target; `compatible` is every write target,
  // so a caller holding a pinned hash can ask "is mine acceptable?" instead of
  // "is mine the one you picked?". Those are different questions and only the
  // first one has a stable answer — see `resolveLoadedSchema` step 2.
  | { kind: "ok"; hash: string; ambiguous: boolean; compatible: string[] }
  | { kind: "missing" }
  | { kind: "narrower"; hash: string; missingFields: string[] };

// Resolve which loaded schema fkanban should pin its config to for `type`.
//
// The node can have MORE THAN ONE schema sharing an `owner_app_id` +
// `descriptive_name` — a stale, narrower version lingering beside the current
// one (fkanban #94: a 10-field `fkanban/Card` alongside the live 18-field one).
// Picking the first descriptive_name match (the old behavior) can pin config to
// the narrower version, and then EVERY write 400s because fkanban always emits
// its full field set. So:
//
//   1. Filter to schemas matching this app's `owner_app_id` + `descriptive_name`,
//      AND — when the node reports a key layout — whose layout matches the local
//      definition's. `descriptive_name` is NOT unique per record type: the
//      2026-07-23 multi-key expand registered the `MilestoneCards` membership
//      index under descriptive_name `Milestone`, so the node carries a HashRange
//      `milestone/sk` schema and the Hash `slug` entity under one name.
//   2. Among those, PREFER a schema whose `fields` SUPERSET the local definition
//      (so a write of every local field is accepted). If several do, return them
//      ALL in `compatible`, rank them deterministically, and flag `ambiguous` so
//      the caller can warn. The ranking is widest field set first, then hash
//      ascending — never the node's listing order (see below).
//   3. If NONE supersets the local fields, the only candidates are narrower than
//      the app expects — return `narrower` with the missing fields so the caller
//      refuses to adopt it (rather than silently pinning a write-broken hash).
//   4. No match at all → `missing`.
//
// Step 1's layout filter is load-bearing, and step 2 CANNOT substitute for it. A
// membership index projects the entity's fields and adds its own, so it is a
// strict field superset of the entity BY CONSTRUCTION — it always wins step 2's
// "widest superset" contest against the entity it indexes. Live proof on the
// primary: `Milestone` resolved to `69e7…` (HashRange `milestone/sk`, 30 fields,
// the MilestoneCards index) over the real `614c…` (Hash `slug`, 15 fields),
// because the index's fields are a strict superset and it sorts earlier in the
// node's listing. `doctor` then reported the correctly-pinned config as wrong
// and told the operator to `kanban init` — a remedy that cannot change the
// outcome, because `init` declares by definition and gets `614c…` back.
//
// A schema with a different key layout is not a narrower or staler version of
// this record type; it is a DIFFERENT record type that happens to share a name,
// and it can never be a write target for these keys. So it is excluded from the
// candidate set entirely rather than ranked within it.
//
// Step 2's tiebreak must NOT be the node's listing order, because that order is
// not stable across restarts. Measured on the primary: six `fkanban/Card`
// schemas are loaded (10/18/19/21/22/23 fields), all Hash/`slug`, and the
// required Card field set is 19 of 23 (four are optional), so FOUR of them are
// write-compatible. Before the 2026-07-30T21:58Z restart the configured 23-field
// `bc941d…` happened to sort first and `superset[0]` was right by luck; after the
// restart the 19-field `eacad7…` sorted first (position 450 vs 576) and `doctor`
// hard-FAILED (exit 1) on a board whose writes were never broken for a moment —
// gating the Factory LaunchAgents on a coin flip that a restart re-tossed.
// Ranking widest-first, then hash ascending, gives the same answer on every node
// with the same schema set, and prefers the most capable write target.
//
// When the node omits `key` (older nodes) every candidate has `key == null` and
// the layout filter admits everything — preserving the pre-existing behavior
// rather than resolving to `missing` on a node that simply doesn't report
// layouts. The caller's write-probe remains the backstop there.
//
// A node that omits `fields` (older nodes) yields empty `fields` for every
// candidate, so no candidate supersets a non-empty local set → `narrower`; the
// caller's write-probe (which exercises a real create) is the backstop there.
// Does a loaded schema's key layout match the local definition's?
//
// `loadedKey == null` means the node did not report a layout — unknown, not
// mismatched — so it is admitted (older nodes keep the pre-layout behavior).
// A REPORTED layout must agree on both components: `hash_field` identifies the
// partition and `range_field` separates a Hash entity from a HashRange index
// over that same entity, which is exactly the pair this filter exists to split.
function keyLayoutMatches(
  local: { hash_field: string; range_field?: string },
  loadedKey: { hash_field: string; range_field: string | null } | null | undefined,
): boolean {
  if (!loadedKey) return true;
  return (
    loadedKey.hash_field === local.hash_field &&
    loadedKey.range_field === (local.range_field ?? null)
  );
}

// ---------------------------------------------------------------------------
// Pinned-hash identity check (every config key, not just the three RecordTypes)
// ---------------------------------------------------------------------------
//
// `resolveLoadedSchema` and `probeSchemaWritable` are both keyed on `RecordType`
// — they read `RECORDS[type]` — so neither can be CALLED for the four
// `EXTRA_SCHEMAS` (`card_list_index`, `board_cards`, `board_milestones`,
// `milestone_cards`). That is not a scoping decision anyone made; the check was
// un-writable for those keys, so it was never written, and the membership
// indexes — the surface most of this seat's repair work has landed on — got no
// identity check at all.
//
// This asks the cheapest, most load-bearing half of that question, and asks it
// off the DECLARED DEFINITION rather than a record-type lookup, so it applies
// uniformly to all eight keys: **is the schema this config hash points at the
// one we declared?** Not "does it accept our fields" (that is the write probe,
// which for a HashRange index would deposit a throwaway row in a live
// partition), just "is it the same record type".
//
// Why identity alone is worth a check: a schema hash is the ADDRESS of a record
// type. A pin that points at a DIFFERENT type's schema does not error — it reads
// exactly like an empty index. Measured on the primary 2026-08-04: config pinned
// `milestone_cards` to a hash the node has registered under `descriptive_name:
// "Milestone"` (the Hash entity), so partition reads on a milestone slug
// returned the Milestone record with `range` coerced to `""` — the "phantom row"
// three runs spent time on. Field/key-layout parity checks cannot see it: they
// verify what the pinned schema looks like, never WHICH schema it is.
export type SchemaIdentityMismatch = {
  what: "owner_app_id" | "descriptive_name" | "key";
  expected: string;
  actual: string;
};

export type SchemaIdentityCheck =
  | { kind: "ok" }
  // The pinned hash is not in the node's loaded set at all. Distinct from a
  // mismatch: the caller already reports this for the three RecordTypes and the
  // remedy differs (re-init vs. investigate a crossed pin).
  | { kind: "not_loaded" }
  | { kind: "unset" }
  | { kind: "mismatch"; loadedDescriptiveName: string; mismatches: SchemaIdentityMismatch[] };

function formatKeyLayout(hash: string, range: string | null | undefined): string {
  return range == null ? `Hash(${hash})` : `HashRange(${hash}, ${range})`;
}

// Sibling hash fields the layout guard still admits (none after 2026-09-03).
// Named-layout HashKey uses catalog hash_field as the partition, so a
// board_cards pin with hash_field=milestone is a wrong identity, not a
// tolerated expand. Read off MEMBERSHIP_KEY_EXPECTATIONS so identity and
// layout cannot disagree.
function siblingHashFields(configKey: string): readonly string[] {
  return MEMBERSHIP_KEY_EXPECTATIONS.find((e) => e.configKey === configKey)?.alsoAccepts ?? [];
}

export function checkPinnedSchemaIdentity(
  // The catalog ENTRY, not just its schema: the multi-key allowance is keyed on
  // the config key, and a signature that took only the definition would push
  // that lookup onto every caller — a caller that forgets it reports a false red
  // about the live board.
  entry: { key: string; schema: AddSchemaRequest },
  configHash: string | undefined,
  loaded: LoadedSchemaCandidate[],
): SchemaIdentityCheck {
  if (!configHash) return { kind: "unset" };
  const match = loaded.find((s) => s.name === configHash);
  if (!match) return { kind: "not_loaded" };

  const def = entry.schema.schema;
  const mismatches: SchemaIdentityMismatch[] = [];
  if (match.owner_app_id !== def.owner_app_id) {
    mismatches.push({ what: "owner_app_id", expected: def.owner_app_id, actual: match.owner_app_id });
  }
  if (match.descriptive_name !== def.descriptive_name) {
    mismatches.push({
      what: "descriptive_name",
      expected: def.descriptive_name,
      actual: match.descriptive_name,
    });
  }
  // Key layout. `range_field` separates a Hash entity from a HashRange index.
  // `hash_field` must match the declared HashKey after named-layout HashKey
  // (fold #1893): a board_cards pin with catalog hash_field=milestone returns
  // 0 rows for HashKey(board).
  //
  // `loadedKey == null` means the node did not report a layout — unknown, not
  // mismatched — matching `keyLayoutMatches` so an older node does not turn
  // every pin red.
  const loadedKey = match.key;
  if (loadedKey) {
    const declaredRange = def.key.range_field ?? null;
    const hashOk =
      loadedKey.hash_field === def.key.hash_field ||
      siblingHashFields(entry.key).includes(loadedKey.hash_field);
    if (!hashOk || loadedKey.range_field !== declaredRange) {
      mismatches.push({
        what: "key",
        expected: formatKeyLayout(def.key.hash_field, declaredRange),
        actual: formatKeyLayout(loadedKey.hash_field, loadedKey.range_field),
      });
    }
  }

  if (mismatches.length === 0) return { kind: "ok" };
  return { kind: "mismatch", loadedDescriptiveName: match.descriptive_name, mismatches };
}

/**
 * Is this mismatch the one the operator already acknowledged for this key?
 *
 * Both the pinned hash AND the identity the node reports for it must match the
 * acknowledgement. Checking only the key would waive every future mismatch on
 * it; checking only the hash would keep waiving after the node re-registered
 * that hash as something else again. The pair is what was actually accepted.
 *
 * Deliberately NOT a wildcard and deliberately not inferred: nothing computes
 * an acknowledgement from the live node, because a check that acknowledges
 * whatever it finds is not a check.
 */
export function isAcceptedPinDeviation(
  accepted: Record<string, { hash: string; registeredAs: string }> | undefined,
  key: string,
  configHash: string | undefined,
  check: SchemaIdentityCheck,
): boolean {
  if (!accepted || !configHash || check.kind !== "mismatch") return false;
  const entry = accepted[key];
  if (!entry) return false;
  return entry.hash === configHash && entry.registeredAs === check.loadedDescriptiveName;
}

/** One-line human rendering of every mismatch, for doctor/init diagnostics. */
export function formatSchemaIdentityMismatch(check: SchemaIdentityCheck): string {
  if (check.kind !== "mismatch") return "";
  return check.mismatches
    .map((m) => `${m.what}: declared ${m.expected}, pinned schema is ${m.actual}`)
    .join("; ");
}

/** Every config key fkanban pins, declared definition included. */
export function allPinnedSchemas(): Array<{ key: string; schema: AddSchemaRequest }> {
  return [...UNIQUE_SCHEMAS, ...EXTRA_SCHEMAS];
}

export function resolveLoadedSchema(
  type: RecordType,
  loaded: LoadedSchemaCandidate[],
): SchemaResolution {
  const def = RECORDS[type].schema.schema;
  const optionalFields =
    type === "card" ? new Set<string>(CARD_OPTIONAL_SCHEMA_FIELDS) : new Set<string>();
  const localFields = def.fields.filter((f) => !optionalFields.has(f));
  const candidates = loaded.filter(
    (s) =>
      s.owner_app_id === def.owner_app_id &&
      s.descriptive_name === def.descriptive_name &&
      s.name.length > 0 &&
      keyLayoutMatches(def.key, s.key),
  );
  if (candidates.length === 0) return { kind: "missing" };

  // Widest field set first, then hash ascending. Deterministic given the same
  // candidate set, regardless of the order the node listed them in.
  const superset = candidates
    .filter((s) => localFields.every((f) => s.fields.includes(f)))
    .sort((a, b) => b.fields.length - a.fields.length || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (superset.length > 0) {
    return {
      kind: "ok",
      hash: superset[0]!.name,
      ambiguous: superset.length > 1,
      compatible: superset.map((s) => s.name),
    };
  }

  // No write-compatible candidate. Report the BEST (widest) narrower one and the
  // fields it's missing, so the caller's error is specific.
  const best = candidates
    .slice()
    .sort((a, b) => b.fields.length - a.fields.length)[0]!;
  const missingFields = localFields.filter((f) => !best.fields.includes(f));
  return { kind: "narrower", hash: best.name, missingFields };
}

// ---------------------------------------------------------------------------
// Declared-name claimants: one name, several Available identities
// ---------------------------------------------------------------------------
//
// `descriptive_name` is what `POST /api/apps/declare-schema` resolves on, and
// the node returns ONE identity for it. Nothing makes that name unique in the
// catalog, so a rekey that mints a new identity leaves the predecessor holding
// the same name, and the resolution a FRESH machine gets is whichever of them
// the node picks. Measured on the primary 2026-09-07: `BoardCards_hashrange_v1`
// had FIVE Available fkanban schemas -
//
//     39a0424f  key=milestone/sk  24 fields   (rekey predecessor)
//     e2bc8e6d  key=board/sk      24 fields
//     595de0c7  key=board/sk      22 fields
//     ad3cf9d6  key=board/sk      23 fields
//     1ef2e7a3  key=board/sk      29 fields   (the decided product pin)
//
// - and a first install resolved the milestone-keyed predecessor, so
// `kanban init` refused with `board_cards (39a0424f...) is registered as
// "BoardCards_hashrange_v1" -- key: declared HashRange(board, sk), pinned schema
// is HashRange(milestone, sk)`. Every machine with a config was immune, because
// its pin names the identity by hash. Only the public first-install path from
// thelastdb.com/llms.txt took the resolve path, and it failed there twice
// (2026-09-04T20:35Z, 2026-09-06T20:15Z, same signature).
//
// The refusal is correct and stays. What was missing is that fkanban knew which
// identity it wanted and never said so: `resolveLoadedSchema` already ranks
// exactly this candidate set, but it is keyed on `RecordType`, so it structurally
// cannot be called for the five `EXTRA_SCHEMAS` - `board_cards` among them.

/**
 * The fields a loaded schema must carry for fkanban to write every field it
 * emits for `entryKey`.
 *
 * Keyed on the CONFIG KEY, not `RecordType`, so it answers for all eight pinned
 * keys. `card` is the one entry with optional fields: a Card row may omit them,
 * so a loaded schema missing them is still a usable write target.
 */
export function requiredDeclaredFields(entryKey: string, def: SchemaDefinition): string[] {
  const optional =
    entryKey === "card" ? new Set<string>(CARD_OPTIONAL_SCHEMA_FIELDS) : new Set<string>();
  return def.fields.filter((f) => !optional.has(f));
}

/**
 * Every Available loaded schema that IS the identity `entry` declares - same
 * owner app, same descriptive name, same key layout - and can take a write of
 * every field fkanban emits, ranked best-first.
 *
 * The ranking is `resolveLoadedSchema`'s, for the reason documented there:
 * widest field set first, then hash ascending, never the node's listing order,
 * which is not stable across restarts.
 *
 * The key-layout filter is strict here - `keyLayoutMatches`, not
 * `checkPinnedSchemaIdentity`'s sibling-hash allowance. A sibling layout is a
 * deviation an operator may ACCEPT on an existing pin; it is never something to
 * newly adopt when the exactly-declared identity is sitting in the same catalog.
 */
export function declaredIdentityCandidates(
  entry: { key: string; schema: AddSchemaRequest },
  loaded: LoadedSchemaCandidate[],
): string[] {
  const def = entry.schema.schema;
  const required = requiredDeclaredFields(entry.key, def);
  return loaded
    .filter(
      (s) =>
        s.name.length > 0 &&
        isAvailableSchema(s) &&
        s.owner_app_id === def.owner_app_id &&
        s.descriptive_name === def.descriptive_name &&
        keyLayoutMatches(def.key, s.key) &&
        required.every((f) => s.fields.includes(f)),
    )
    .sort(
      (a, b) =>
        b.fields.length - a.fields.length || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )
    .map((s) => s.name);
}

export type DeclaredIdentityChoice =
  // The node's resolution already IS the declared identity. Nothing to do.
  | { kind: "resolved-ok" }
  // The node resolved a different identity under this name, and the declared
  // one is loaded - adopt it and say so.
  | { kind: "corrected"; hash: string; from: string; compatible: string[]; ambiguous: boolean }
  // The node resolved something else and the declared identity is NOT in the
  // catalog. There is nothing to correct to; the caller's identity guard refuses.
  | { kind: "no-candidate"; from: string };

/**
 * Pick the identity fkanban DECLARED when the node's name resolution handed
 * back a different one.
 *
 * This does NOT relax `assertResolvedSchemaIdentities`. That guard still runs,
 * on the hash this function returns, and still refuses when no loaded schema is
 * the declared identity - which is the whole `no-candidate` arm. What changes is
 * that a catalog holding BOTH the right identity and a stale claimant on its
 * name now resolves to the right one deterministically, instead of to whichever
 * the node's resolver reached first.
 *
 * Existing installs are unaffected by construction: a correction that moved a
 * live pin surfaces as a pin MOVE in `schemaPinMoves`, and
 * `assertNoSilentSchemaRepin` refuses those without `--accept-schema-repin`.
 */
export function correctResolvedSchemaIdentity(
  entry: { key: string; schema: AddSchemaRequest },
  resolvedHash: string | undefined,
  loaded: LoadedSchemaCandidate[],
): DeclaredIdentityChoice {
  if (!resolvedHash) return { kind: "resolved-ok" };
  if (checkPinnedSchemaIdentity(entry, resolvedHash, loaded).kind === "ok") {
    return { kind: "resolved-ok" };
  }
  const ranked = declaredIdentityCandidates(entry, loaded);
  if (ranked.length === 0) return { kind: "no-candidate", from: resolvedHash };
  const best = ranked[0]!;
  if (best === resolvedHash) return { kind: "resolved-ok" };
  return {
    kind: "corrected",
    hash: best,
    from: resolvedHash,
    compatible: ranked,
    ambiguous: ranked.length > 1,
  };
}

/** One declared name that more than one Available schema answers to. */
export type DuplicateDeclaredName = {
  /** The config key that declares this name. */
  key: string;
  descriptive_name: string;
  owner_app_id: string;
  /** Available claimants whose key layout matches the declaration. */
  sameLayout: string[];
  /** Available claimants under the same name with a DIFFERENT key layout. */
  otherLayout: string[];
};

/**
 * Every name fkanban declares that more than one Available schema answers to.
 *
 * Scoped to fkanban's own declared names on purpose. The primary carries 93
 * names with more than one Available schema across all apps (1268 schemas, 1131
 * distinct names, measured 2026-09-07); reporting that whole class here would
 * make `kanban doctor` fail on other apps' catalog hygiene, which no fkanban
 * operator can act on. These eight names are the ones that decide what a fresh
 * `kanban init` pins.
 *
 * Both layout buckets are reported because they are different faults with
 * different remedies. A `sameLayout` duplicate is two addresses for ONE record
 * type - the shape a rekey leaves behind. An `otherLayout` duplicate is a
 * DIFFERENT record type wearing this name, which is what actually broke the
 * public install path: the resolver handed a fresh machine a milestone-keyed
 * schema for a board-keyed pin.
 */
export function duplicateDeclaredSchemaNames(
  loaded: LoadedSchemaCandidate[],
): DuplicateDeclaredName[] {
  const out: DuplicateDeclaredName[] = [];
  const seen = new Set<string>();
  const byHash = (a: LoadedSchemaCandidate, b: LoadedSchemaCandidate) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  for (const entry of allPinnedSchemas()) {
    const def = entry.schema.schema;
    const id = `${def.owner_app_id} ${def.descriptive_name}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const claimants = loaded.filter(
      (s) =>
        s.name.length > 0 &&
        isAvailableSchema(s) &&
        s.owner_app_id === def.owner_app_id &&
        s.descriptive_name === def.descriptive_name,
    );
    if (claimants.length < 2) continue;
    out.push({
      key: entry.key,
      descriptive_name: def.descriptive_name,
      owner_app_id: def.owner_app_id,
      sameLayout: claimants
        .filter((s) => keyLayoutMatches(def.key, s.key))
        .sort(byHash)
        .map((s) => s.name),
      otherLayout: claimants
        .filter((s) => !keyLayoutMatches(def.key, s.key))
        .sort(byHash)
        .map((s) => s.name),
    });
  }
  return out;
}

/** One-line human rendering of a duplicate-name finding, for doctor. */
export function formatDuplicateDeclaredName(d: DuplicateDeclaredName): string {
  const total = d.sameLayout.length + d.otherLayout.length;
  const parts = [
    `${total} Available schemas answer to "${d.descriptive_name}"`,
    `${d.sameLayout.length} with the declared key layout` +
      (d.sameLayout.length > 0 ? ` (${d.sameLayout.map((h) => h.slice(0, 12)).join(", ")})` : ""),
  ];
  if (d.otherLayout.length > 0) {
    parts.push(
      `${d.otherLayout.length} with a different one ` +
        `(${d.otherLayout.map((h) => h.slice(0, 12)).join(", ")})`,
    );
  }
  return parts.join("; ");
}
