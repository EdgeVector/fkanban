// Schema definitions for fkanban's record types.
//
// Two schemas are registered against the schema_service:
//
//   - **Card** — one card on a kanban board. Lives in a `column` (the
//     kanban status) and on a `board`. Moving a card = updating `column`.
//   - **Board** — a named board with an ordered list of `columns`.
//
// `POST /v1/schemas` accepts these bodies; the response's `schema.name`
// IS THE CANONICAL HASH every subsequent mutation/query MUST pin to. The
// `descriptive_name` / `purpose_statement` are for human display + the
// dual-signal canonicalization gate (so Card and Board never collapse onto
// one canonical hash, and `fkanban/*` never collides with another app).

// The app id that owns every fkanban schema. Under app_identity v3.1,
// `owner_app_id` folds into the schema's identity hash, so the
// schema_service stores these under the canonical names `fkanban/Card` and
// `fkanban/Board` — distinct from `fbrain/*` or any other app's schemas
// even when the field shape matches.
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
  schema_type: "Hash";
  key: { hash_field: string };
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

// The kanban columns a card moves through. `column` is the live kanban
// status; a card's whole lifecycle is moving left→right across these.
// A Board may override this ordered list with its own `columns`, but every
// fresh board and every Card validates against this default set.
export const DEFAULT_COLUMNS = [
  "backlog",
  "todo",
  "doing",
  "review",
  "done",
] as const;
export type Column = (typeof DEFAULT_COLUMNS)[number];

export const DEFAULT_BOARD_SLUG = "default";

const GENERAL = { sensitivity_level: 0, data_domain: "general" };

export const cardSchema: AddSchemaRequest = {
  schema: {
    name: "Card",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "Card",
    purpose_statement:
      "A single work item on a kanban board, moved through columns over its lifecycle",
    schema_type: "Hash",
    key: { hash_field: "slug" },
    fields: [
      "slug",
      "title",
      "body",
      "board",
      "column",
      "position",
      "assignee",
      "tags",
      "created_at",
      "updated_at",
    ],
    field_types: {
      slug: "String",
      title: "String",
      body: "String",
      board: "String",
      column: "String",
      position: "String",
      assignee: "String",
      tags: { Array: "String" },
      created_at: "String",
      updated_at: "String",
    },
    field_descriptions: {
      slug: "stable url-style id (board-unique card key)",
      title: "one-line card name",
      body: "markdown description / notes",
      board: "slug of the board this card belongs to",
      column: DEFAULT_COLUMNS.join("|"),
      position: "integer-as-string ordering within the column (lower = higher)",
      assignee: "who owns the card, empty string if unassigned",
      tags: "array of freeform labels",
      created_at: "RFC 3339 timestamp",
      updated_at: "RFC 3339 timestamp",
    },
    field_classifications: { title: ["word"], body: ["word"] },
    field_data_classifications: {
      slug: GENERAL,
      title: GENERAL,
      body: GENERAL,
      board: GENERAL,
      column: GENERAL,
      position: GENERAL,
      assignee: GENERAL,
      tags: GENERAL,
      created_at: GENERAL,
      updated_at: GENERAL,
    },
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
    fields: ["slug", "title", "body", "columns", "created_at", "updated_at"],
    field_types: {
      slug: "String",
      title: "String",
      body: "String",
      columns: { Array: "String" },
      created_at: "String",
      updated_at: "String",
    },
    field_descriptions: {
      slug: "stable url-style id",
      title: "one-line board name",
      body: "markdown description",
      columns: "ordered list of column names cards move through",
      created_at: "RFC 3339 timestamp",
      updated_at: "RFC 3339 timestamp",
    },
    field_classifications: { title: ["word"], body: ["word"] },
    field_data_classifications: {
      slug: GENERAL,
      title: GENERAL,
      body: GENERAL,
      columns: GENERAL,
      created_at: GENERAL,
      updated_at: GENERAL,
    },
  },
  mutation_mappers: {},
};

export const RECORD_TYPES = ["card", "board"] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export type RecordTypeDef = {
  type: RecordType;
  schema: AddSchemaRequest;
};

export const RECORDS: Record<RecordType, RecordTypeDef> = {
  card: { type: "card", schema: cardSchema },
  board: { type: "board", schema: boardSchema },
};

// One entry per schema `fkanban init` must register. Binds a config-key
// (where init writes the canonical hash) to the AddSchemaRequest.
export const UNIQUE_SCHEMAS: Array<{ key: RecordType; schema: AddSchemaRequest }> = [
  { key: "card", schema: cardSchema },
  { key: "board", schema: boardSchema },
];

export function isRecordType(s: string): s is RecordType {
  return (RECORD_TYPES as readonly string[]).includes(s);
}

export function fieldsFor(type: RecordType): string[] {
  return RECORDS[type].schema.schema.fields.slice();
}

export function schemaFor(type: RecordType): AddSchemaRequest {
  return RECORDS[type].schema;
}

export function isDefaultColumn(s: string): s is Column {
  return (DEFAULT_COLUMNS as readonly string[]).includes(s);
}
