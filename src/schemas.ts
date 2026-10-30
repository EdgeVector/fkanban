// Schema-owned app records. Canonical field descriptions stay separate from record ownership.

export const OWNER_APP_ID = "fkanban";

export function namespacedSchemaName(shortName: string): string {
  return `${OWNER_APP_ID}/${shortName}`;
}

export type FieldType = "String" | "DateTime" | { Array: "String" };

export type SchemaDefinition = {
  name: string;
  owner_app_id: string;
  descriptive_name: string;
  purpose_statement?: string;
  // Card, Board, and Milestone use Hash primary keys. Flow events use HashRange.
  schema_type: "Hash" | "HashRange";
  key: { hash_field: string; range_field?: string };
  /** Reuse canonical field definitions without sharing record values. */
  independent_fields?: boolean;
  alternate_keys?: Record<string, {
    hash_field?: string;
    hash_literal?: string;
    range_field?: string | null;
    range_parts?: Array<{ field: string; format?: "text" | "reverse_time_millis" | { padded_text: { width: number } } }>;
    range_separator?: string;
    omit_empty_hash?: boolean;
    missing?: "reject" | "omit";
  }>;
  fields: string[];
  field_types: Record<string, FieldType>;
  field_descriptions: Record<string, string>;
  field_classifications?: Record<string, string[]>;
  field_data_classifications: Record<
    string,
    { sensitivity_level: number; data_domain: string }
  >;
};

export type AddSchemaRequest = {
  schema: SchemaDefinition;
  mutation_mappers: Record<string, string>;
};

export const DEFAULT_COLUMNS = [
  "backlog",
  "todo",
  "doing",
  "done",
] as const;

export type Column = (typeof DEFAULT_COLUMNS)[number];

export const DEFAULT_BOARD_SLUG = "default";

export function fixedColumns(): string[] {
  return [...DEFAULT_COLUMNS];
}

export function isFixedColumnList(columns: readonly string[] | undefined | null): boolean {
  if (!columns || columns.length === 0) return true;
  if (columns.length !== DEFAULT_COLUMNS.length) return false;
  return columns.every((c, i) => c === DEFAULT_COLUMNS[i]);
}

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

export const CARD_FIELD_DESCRIPTIONS: Record<string, string> = {
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

export const MILESTONE_FIELD_DESCRIPTIONS: Record<string, string> = {
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
      ...CARD_FIELD_DESCRIPTIONS,
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
    field_descriptions: { ...MILESTONE_FIELD_DESCRIPTIONS },
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

export const UNIQUE_SCHEMAS: Array<{ key: RecordType; schema: AddSchemaRequest }> = [
  { key: "card", schema: cardSchema },
  { key: "board", schema: boardSchema },
  { key: "milestone", schema: milestoneSchema },
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

export const EXTRA_SCHEMAS: Array<{ key: string; schema: AddSchemaRequest }> = [
  { key: "feature_flow_events", schema: featureFlowEventsSchema },
];
