// Schema definitions for fkanban's record types.
//
// Two schemas back the board:
//
//   - **Card** — one card on a kanban board. Lives in a `column` (the
//     kanban status) and on a `board`. Moving a card = updating `column`.
//   - **Board** — a named board with an ordered list of `columns`.
//
// How the CLI gets the canonical hashes (the values every mutation/query MUST
// pin to): the `fkanban/*` schemas are app-private implementation schemas. At
// `init` time the Mini node declares them locally through
// `/api/apps/declare-schema` and returns deterministic app-namespaced canonical
// hashes. fkanban then write-probes those hashes before persisting them in
// config. The shared schema service is reserved for explicit publish/attach
// workflows, not ordinary private board storage. The `descriptive_name` /
// `purpose_statement` are for human display + the dual-signal canonicalization
// gate (so Card and Board never collapse onto one canonical hash, and
// `fkanban/*` never collides with another app).

// The app id that owns every fkanban schema. Under app_identity v3.1,
// `owner_app_id` folds into the schema's identity hash, so the
// local declaration stores these under canonical identities equivalent to
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

// A board's effective ordered column list: its own `columns` when it defines
// any, else the canonical `DEFAULT_COLUMNS`. Centralizes the
// `columns.length > 0 ? columns : [...DEFAULT_COLUMNS]` fallback that the board
// renderer and column validation otherwise each re-spell.
export function resolveColumns(boardColumns: readonly string[]): string[] {
  return boardColumns.length > 0 ? [...boardColumns] : [...DEFAULT_COLUMNS];
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
  "pr_url",
  "branch",
] as const;

// New fields that can be losslessly mirrored through legacy body headers while
// the published schema catches up. The resolver/doctor can treat a schema
// missing only these fields as operationally writable.
export const CARD_OPTIONAL_SCHEMA_FIELDS = ["surfaces", "db"] as const;

export const BOARD_FIELDS = [
  "slug",
  "title",
  "body",
  "columns",
  "created_at",
  "updated_at",
] as const;

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
      slug: "stable url-style id (board-unique card key)",
      title: "one-line card name",
      body: "markdown description / notes",
      board: "slug of the board this card belongs to",
      column: DEFAULT_COLUMNS.join("|"),
      position: "integer-as-string ordering within the column (lower = higher)",
      assignee: "who owns the card, empty string if unassigned",
      tags: "array of freeform labels",
      deps: "array of card slugs this card depends on; dependencies are satisfied when each referenced card reaches its board's terminal column",
      surfaces: "array of repo-relative path globs or subsystem names this card expects to touch",
      created_at: "RFC 3339 timestamp",
      updated_at: "RFC 3339 timestamp",
      db: "home LastDB locator for this card, e.g. lastdb://personal or lastdb://org/<slug>/<db>",
      repo: "owner/name of the repo a build agent clones (empty = not a code card)",
      base: "base branch a PR targets (default: main)",
      kind: "pr|registry|tracker|umbrella|meta|program|capstone|validation — pr drives to a merged PR; non-pr kinds are context/grouping cards and are never picked up",
      block_status: "none|needs_human|design_first|deferred — INTENTIONAL holds only (dependency-blocked stays derived from deps)",
      block_reason: "free-text why, when block_status != none",
      north_star: "fbrain North Star slug this card advances",
      pr_url: "URL/number of the PR driving this card, when in flight",
      branch: "worktree/feature branch a build agent works on",
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

// One entry per schema `kanban init` must register. Binds a config-key
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

// One candidate schema loaded on the node, as the resolver sees it: the
// canonical hash plus the field set the node reports for it. (Structurally a
// subset of client.ts's `LoadedSchema`, redeclared here so this pure module
// has no client dependency.)
export type LoadedSchemaCandidate = {
  name: string;
  descriptive_name: string;
  owner_app_id: string;
  fields: string[];
};

export type SchemaResolution =
  | { kind: "ok"; hash: string; ambiguous: boolean }
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
//   1. Filter to schemas matching this app's `owner_app_id` + `descriptive_name`.
//   2. Among those, PREFER a schema whose `fields` SUPERSET the local definition
//      (so a write of every local field is accepted). If several do, that's
//      benign ambiguity (they're all write-compatible) — pick the first and flag
//      `ambiguous` so the caller can warn.
//   3. If NONE supersets the local fields, the only candidates are narrower than
//      the app expects — return `narrower` with the missing fields so the caller
//      refuses to adopt it (rather than silently pinning a write-broken hash).
//   4. No match at all → `missing`.
//
// A node that omits `fields` (older nodes) yields empty `fields` for every
// candidate, so no candidate supersets a non-empty local set → `narrower`; the
// caller's write-probe (which exercises a real create) is the backstop there.
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
      s.name.length > 0,
  );
  if (candidates.length === 0) return { kind: "missing" };

  const superset = candidates.filter((s) =>
    localFields.every((f) => s.fields.includes(f)),
  );
  if (superset.length > 0) {
    return { kind: "ok", hash: superset[0]!.name, ambiguous: superset.length > 1 };
  }

  // No write-compatible candidate. Report the BEST (widest) narrower one and the
  // fields it's missing, so the caller's error is specific.
  const best = candidates
    .slice()
    .sort((a, b) => b.fields.length - a.fields.length)[0]!;
  const missingFields = localFields.filter((f) => !best.fields.includes(f));
  return { kind: "narrower", hash: best.name, missingFields };
}
