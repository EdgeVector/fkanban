// Domain helpers: turn fold_db query rows into typed Card / Board records,
// list + find by slug, soft-delete (tombstone), slug + column validation.

import { FkanbanError, type NodeClient, type QueryRow } from "./client.ts";
import { schemaHashFor, type Config } from "./config.ts";
import {
  DEFAULT_COLUMNS,
  fieldsFor,
  isDefaultColumn,
  type Column,
  type RecordType,
} from "./schemas.ts";

export type Card = {
  slug: string;
  title: string;
  body: string;
  board: string;
  column: string;
  position: string;
  assignee: string;
  tags: string[];
  // Slugs of cards this card depends on (it is "blocked" until each reaches the
  // final column of its own board). Stored on the wire as `dep:<slug>` entries
  // in `tags` — see DEP_TAG_PREFIX — so deps needed no schema change / republish.
  deps: string[];
  created_at: string;
  updated_at: string;
};

export type Board = {
  slug: string;
  title: string;
  body: string;
  columns: string[];
  created_at: string;
  updated_at: string;
};

// Soft-delete sentinel — fold_db is append-only, so `fkanban rm` overwrites
// the record's fields and stamps this tag; every read path drops it.
export const TOMBSTONE_TAG = "__fkanban_deleted__";

export function isTombstoned(tags: string[]): boolean {
  return tags.includes(TOMBSTONE_TAG);
}

// Dependency edges piggyback on the existing `tags` array: a card that depends
// on `foo` carries the reserved tag `dep:foo`. rowToCard splits these out into
// `deps`, and cardToFields folds them back in, so dep tags never surface as
// user-facing labels (same trick as TOMBSTONE_TAG).
export const DEP_TAG_PREFIX = "dep:";

export function isDepTag(tag: string): boolean {
  return tag.startsWith(DEP_TAG_PREFIX);
}

export function depTag(slug: string): string {
  return `${DEP_TAG_PREFIX}${slug}`;
}

// Clean a tag list: trim, drop blanks, dedupe (order-stable). The label
// counterpart of normalizeDeps — used by the incremental `tag add`/`tag rm`
// editors so adding a present tag is idempotent and a blank/duplicate arg is a
// no-op. Reserved tags (dep:<slug>, the tombstone) are filtered out elsewhere.
export function normalizeTags(tags: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tags) {
    const s = t.trim();
    if (s.length === 0 || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// Clean a dep list: trim, drop blanks, drop self-references, dedupe (order-stable).
export function normalizeDeps(deps: string[], selfSlug: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of deps) {
    const s = d.trim();
    if (s.length === 0 || s === selfSlug || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// The stderr heads-up both `add --deps` and `dep add` emit when a dependency
// slug doesn't resolve to a live card. A missing dep is non-blocking by design
// (a forward/dangling dep just never reaches `done`), so this is a warning, not
// an error — the write still succeeds. Shared so the two authoring paths stay
// in sync.
export function forwardDepWarning(dep: string): string {
  return `fkanban: warning — no card "${dep}" yet; adding it as a forward dependency.`;
}

// The heads-up `rm` emits when the card being deleted is still listed in another
// live card's deps: deleting it leaves those edges dangling. The mirror of
// forwardDepWarning — adding a missing dep warns, and so does deleting a card to
// CREATE a missing dep. Like forwardDepWarning this is non-blocking (a dangling
// dep can't reach `done` but doesn't itself fail anything), so the rm still
// succeeds. Shared so the CLI + MCP messages stay in sync. `dependents` is
// non-empty by contract.
export function orphanedDependentsWarning(slug: string, dependents: string[]): string {
  return `  warning: ${dependents.length} card(s) still depend on "${slug}": ${dependents.join(", ")} — their dependency is now dangling.`;
}

// The message + hint emitted when the dependency soft-block refuses a card.
// Shared by `move` and `add` (CLI) so both — and the MCP surface, which voices
// the same FkanbanError — stay identical. The hint no longer hardcodes the
// literal word `done`: a dep is satisfied once it reaches ITS board's final
// column, which may not be named `done` on a custom board.
export function blockedByMessage(slug: string, blockedBy: string[]): string {
  return `Card "${slug}" is blocked by ${blockedBy.map((d) => `"${d}"`).join(", ")} (not yet done).`;
}

export function blockedByHint(): string {
  return "Finish its dependencies first (move them to their board's final column), or pass --force to override.";
}

// The columns at which dependencies actually gate work. A dependency is
// satisfied only once its card reaches its board's final column (see
// depStatus); entering one of these "started" columns while still blocked is
// what `move` refuses (unless --force). NOTE: this gate list is still the
// default-board column names — generalizing which columns count as "working" on
// an arbitrary board is tracked separately and intentionally out of scope here.
export const WORKING_COLUMNS = ["doing", "review", "done"] as const;

export function isWorkingColumn(column: string): boolean {
  return (WORKING_COLUMNS as readonly string[]).includes(column);
}

// ── Repo/Base header auto-derivation ────────────────────────────────────────
// `fkanban-pickup` only fans a card out to a build agent when its body carries
// both a `Repo:` and a `Base:` header — the fkanban-agent skill is told never to
// guess the repo. A card filed without them silently strands in `todo` forever
// (and starves pickup's non-fold slots). To make that impossible, `add` and
// `move` auto-derive the header from the card's subsystem tag whenever it can be
// done UNAMBIGUOUSLY. Every filer — CLI, MCP, scheduled routine, or human — goes
// through those two code paths, so this is the one durable chokepoint; the prose
// in the groom/program-driver routines is a backstop, not the guarantee.
// Ambiguous/unknown tags are NOT guessed — they're left alone and surfaced as a
// loud warning instead of disappearing silently.

// Single source of truth: subsystem tag → repo. A tag set that resolves to
// exactly one repo is stamped; zero or >1 distinct repos is "ambiguous".
export const TAG_TO_REPO: Readonly<Record<string, string>> = {
  fold: "EdgeVector/fold",
  fold_db: "EdgeVector/fold",
  fold_db_node: "EdgeVector/fold",
  "schema-service": "EdgeVector/fold",
  fold_dev_node: "EdgeVector/fold",
  wasm: "EdgeVector/fold",
  "vector-index": "EdgeVector/fold",
  fkanban: "EdgeVector/fkanban",
  exemem: "EdgeVector/exemem-infra",
  ci: "EdgeVector/exemem-infra",
  infra: "EdgeVector/exemem-infra",
  "schema-infra": "EdgeVector/schema-infra",
  fold_db_website: "EdgeVector/fold_db_website",
  "folddb-website": "EdgeVector/fold_db_website",
  website: "EdgeVector/fold_db_website",
};

export const DEFAULT_BASE = "main";

// True iff the body already carries both pickup headers (line-anchored so a
// passing mention in prose doesn't count). Idempotency guard for re-`add`s.
export function hasRepoHeaders(body: string): boolean {
  return /^[ \t]*Repo:/m.test(body) && /^[ \t]*Base:/m.test(body);
}

// Recipe/registry cards target an fbrain record, not a git repo — they are not
// meant for the pickup→PR flow and must never be stamped.
export function isRegistryCard(body: string, title: string): boolean {
  return (
    /Target:\s*fbrain record/i.test(body) ||
    /\bdogfood-registry\b/.test(body) ||
    /^fix dogfood recipe\b/i.test(title.trim())
  );
}

// The single repo a tag set unambiguously maps to, or null (zero or >1 match).
export function inferRepoFromTags(tags: string[]): string | null {
  const repos = new Set<string>();
  for (const t of tags) {
    const repo = TAG_TO_REPO[t.replace(/^#/, "").trim().toLowerCase()];
    if (repo) repos.add(repo);
  }
  return repos.size === 1 ? [...repos][0]! : null;
}

export type HeaderDerivation =
  | { kind: "present" } // already had Repo:/Base:
  | { kind: "skip-registry" } // recipe/registry card — never stamp
  | { kind: "ambiguous" } // tags don't map to a single repo — don't guess
  | { kind: "stamped"; repo: string; base: string; body: string };

// Pure decision + transform. Callers stamp the returned `body` when the result
// is "stamped", and emit `missingHeaderWarning` when it's "ambiguous".
export function deriveRepoHeaders(body: string, tags: string[], title: string): HeaderDerivation {
  if (hasRepoHeaders(body)) return { kind: "present" };
  if (isRegistryCard(body, title)) return { kind: "skip-registry" };
  const repo = inferRepoFromTags(tags);
  if (!repo) return { kind: "ambiguous" };
  return { kind: "stamped", repo, base: DEFAULT_BASE, body: `Repo: ${repo}\nBase: ${DEFAULT_BASE}\n\n${body}` };
}

export function missingHeaderWarning(slug: string): string {
  return (
    `warning: card "${slug}" is in todo with no Repo:/Base: header and its tags ` +
    `don't map to a single repo — fkanban-pickup will skip it. Add a "Repo: <owner>/<name>" ` +
    `and "Base: <branch>" header (or a single subsystem tag) to make it pickup-eligible.`
  );
}

// Orchestration shared by `add` and `move`: in a pre-execution column
// (backlog/todo) auto-stamp the header when derivable, and warn (only in `todo`,
// where it actually blocks pickup) when it's missing-and-ambiguous. Working
// columns (doing/review/done) are left untouched. Returns the (possibly
// header-prefixed) body. `warn` is injected so it's testable / silenceable.
export function applyHeaderDerivation(
  card: { slug: string; body: string; tags: string[]; title: string; column: string },
  warn: (msg: string) => void,
): string {
  if (isWorkingColumn(card.column)) return card.body;
  const d = deriveRepoHeaders(card.body, card.tags, card.title);
  if (d.kind === "stamped") return d.body;
  if (d.kind === "ambiguous" && card.column === "todo") warn(missingHeaderWarning(card.slug));
  return card.body;
}

export type DepStatus = {
  // Existing dep cards not yet in their board's terminal column — these block
  // this card.
  blockedBy: string[];
  // Dep slugs with no live card (deleted or forward-referenced) — surfaced as a
  // warning, but they do NOT block (a dangling dep can never reach `done`).
  missing: string[];
  blocked: boolean;
};

// Fallback terminal column used when a dep's board can't be resolved (deleted
// board, forward reference, or no board map supplied): the historical literal
// `done`, so nothing regresses when the board context is unavailable.
export const FALLBACK_TERMINAL_COLUMN = "done";

// Map of board slug → that board's terminal (last) column. A dependency is
// "done" once its card reaches this column on the dep card's OWN board, so a
// board whose final column isn't named `done` (e.g. `spec,build,ship`) can
// still unblock dependents. Built once per command from `listBoards`.
export function boardTerminalMap(boards: Board[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const b of boards) {
    const terminal = b.columns[b.columns.length - 1];
    if (terminal) m.set(b.slug, terminal);
  }
  return m;
}

// The column at which a dep card on `boardSlug` counts as done: its board's
// terminal column, or the literal `done` fallback when the board is unresolvable.
function terminalColumnFor(
  boardSlug: string,
  boardTerminal?: Map<string, string>,
): string {
  return boardTerminal?.get(boardSlug) ?? FALLBACK_TERMINAL_COLUMN;
}

// Whether moving a blocked card INTO `column` (on board `boardSlug`) is gated by
// the dependency soft-block. A blocked card may not enter a column that is a
// default-named working column (doing/review/done) OR that is `boardSlug`'s own
// terminal column — so on a custom board (e.g. `spec,build,ship`) a blocked card
// can't be *completed* into its terminal column (`ship`) without --force, even
// though that board has none of the default working columns. The default board's
// terminal column is `done`, which is already in WORKING_COLUMNS, so the gating
// set is unchanged there. This intentionally does NOT gate intermediate custom
// columns (e.g. `spec → build`) — that needs board-level intake metadata that
// doesn't exist yet, and is tracked separately.
export function isDepEnforcedColumn(
  column: string,
  boardSlug: string,
  boardTerminal?: Map<string, string>,
): boolean {
  return isWorkingColumn(column) || column === terminalColumnFor(boardSlug, boardTerminal);
}

// Resolve a card's deps against the full set of live cards. A dependency is
// satisfied once its dep card reaches the LAST column of the dep card's own
// board (resolved via `boardTerminal`), not only the literal `done` — so a
// board with a custom terminal column still unblocks its dependents. When
// `boardTerminal` is omitted or a dep's board can't be resolved, falls back to
// the literal `done` (preserving the default board's behavior exactly).
export function depStatus(
  card: Card,
  allCards: Card[],
  boardTerminal?: Map<string, string>,
): DepStatus {
  const bySlug = new Map(allCards.map((c) => [c.slug, c]));
  const blockedBy: string[] = [];
  const missing: string[] = [];
  for (const dep of card.deps) {
    const d = bySlug.get(dep);
    if (!d) {
      missing.push(dep);
    } else if (d.column !== terminalColumnFor(d.board, boardTerminal)) {
      blockedBy.push(dep);
    }
  }
  return { blockedBy, missing, blocked: blockedBy.length > 0 };
}

// Would adding the edge `fromSlug → toSlug` (fromSlug depends on toSlug) close a
// dependency cycle? It does iff `toSlug` can already reach `fromSlug` by walking
// existing `deps` edges (so the new edge would loop back). Returns the offending
// cycle path `toSlug → … → fromSlug → toSlug` (slugs in order) when it would, or
// null when the edge is safe. A dangling dep (no card) has no outgoing edges, so
// it can never be on a cycle. Direct mutual (a→b, b→a) and longer transitive
// (a→b→c→a) cycles are both caught.
export function wouldCreateCycle(
  allCards: Card[],
  fromSlug: string,
  toSlug: string,
): string[] | null {
  const depsBySlug = new Map(allCards.map((c) => [c.slug, c.deps]));
  // DFS from toSlug along deps edges, looking for fromSlug. Track the path so we
  // can report the cycle. visited guards against pre-existing cycles in the data.
  const visited = new Set<string>();
  const path: string[] = [];
  const walk = (node: string): boolean => {
    if (node === fromSlug) {
      path.push(node);
      return true;
    }
    if (visited.has(node)) return false;
    visited.add(node);
    path.push(node);
    for (const next of depsBySlug.get(node) ?? []) {
      if (walk(next)) return true;
    }
    path.pop();
    return false;
  };
  if (!walk(toSlug)) return null;
  // path is toSlug → … → fromSlug; the new edge fromSlug → toSlug closes it.
  return [...path, toSlug];
}

// Map of slug → blocked? across a set of cards, resolved against `allCards`.
// `boardTerminal` (board slug → terminal column) lets a dep on a custom board
// count as done at that board's last column; omit it to fall back to `done`.
export function blockedSlugSet(
  cards: Card[],
  allCards: Card[],
  boardTerminal?: Map<string, string>,
): Set<string> {
  const blocked = new Set<string>();
  for (const c of cards) {
    if (depStatus(c, allCards, boardTerminal).blocked) blocked.add(c.slug);
  }
  return blocked;
}

// Case-insensitive substring search over a card's user-facing content (slug,
// title, body, assignee, and visible tags — dep/tombstone tags never reach
// here). Multi-word queries are AND-matched: every whitespace-separated term
// must appear somewhere in the card, so `auth p1` finds cards mentioning both.
// Tokenize a search query into its effective lowercased terms: trim, split on
// whitespace, drop empties. A whitespace-only query yields `[]` — callers (see
// `searchResult`) treat zero terms as a usage error rather than match-all.
export function queryTerms(query: string): string[] {
  return query.toLowerCase().trim().split(/\s+/).filter((t) => t.length > 0);
}

export function cardMatchesQuery(card: Card, query: string): boolean {
  const terms = queryTerms(query);
  if (terms.length === 0) return true;
  const hay = [card.slug, card.title, card.body, card.assignee, ...card.tags]
    .join("\n")
    .toLowerCase();
  return terms.every((t) => hay.includes(t));
}

// Filter a card list to those matching `query` (see cardMatchesQuery).
export function searchCards(cards: Card[], query: string): Card[] {
  return cards.filter((c) => cardMatchesQuery(c, query));
}

export function nowIso(): string {
  return new Date().toISOString();
}

function stringField(f: Record<string, unknown>, key: string): string {
  const v = f[key];
  if (typeof v === "string") return v;
  if (v == null) return "";
  return String(v);
}

function arrayStringField(f: Record<string, unknown>, key: string): string[] {
  const v = f[key];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string" && v.length > 0) {
    return v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }
  return [];
}

export function rowToCard(row: QueryRow): Card {
  const f = (row.fields ?? {}) as Record<string, unknown>;
  const allTags = arrayStringField(f, "tags");
  const deps = allTags
    .filter(isDepTag)
    .map((t) => t.slice(DEP_TAG_PREFIX.length))
    .filter((s) => s.length > 0);
  return {
    slug: stringField(f, "slug"),
    title: stringField(f, "title"),
    body: stringField(f, "body"),
    board: stringField(f, "board"),
    column: stringField(f, "column"),
    position: stringField(f, "position"),
    assignee: stringField(f, "assignee"),
    // dep tags are split into `deps`; everything else (incl. the tombstone) stays.
    tags: allTags.filter((t) => !isDepTag(t)),
    deps,
    created_at: stringField(f, "created_at"),
    updated_at: stringField(f, "updated_at"),
  };
}

export function rowToBoard(row: QueryRow): Board {
  const f = (row.fields ?? {}) as Record<string, unknown>;
  return {
    slug: stringField(f, "slug"),
    title: stringField(f, "title"),
    body: stringField(f, "body"),
    columns: arrayStringField(f, "columns"),
    created_at: stringField(f, "created_at"),
    updated_at: stringField(f, "updated_at"),
  };
}

export async function listCards(node: NodeClient, cfg: Config): Promise<Card[]> {
  const hash = schemaHashFor("card", cfg);
  const res = await node.queryAll({ schemaHash: hash, fields: fieldsFor("card") });
  return res.results.map(rowToCard).filter((c) => !isTombstoned(c.tags));
}

export async function listBoards(node: NodeClient, cfg: Config): Promise<Board[]> {
  const hash = schemaHashFor("board", cfg);
  const res = await node.queryAll({ schemaHash: hash, fields: fieldsFor("board") });
  return res.results.map(rowToBoard).filter((b) => !isTombstoned(b.columns) && b.slug.length > 0);
}

// Fields sufficient to resolve dependency status / card existence — everything
// except the heavy spec `body` (and other display-only fields). Used by the
// read paths that fan out over the whole board so they don't re-download every
// card's multi-paragraph body.
export const CARD_STATUS_FIELDS = ["slug", "board", "column", "position", "tags", "created_at"];

// Like listCards but fetches only CARD_STATUS_FIELDS; absent fields come back
// as "" on the Card. Enough for depStatus / blockedSlugSet / existence checks.
export async function listCardStatuses(node: NodeClient, cfg: Config): Promise<Card[]> {
  const hash = schemaHashFor("card", cfg);
  const res = await node.queryAll({ schemaHash: hash, fields: CARD_STATUS_FIELDS });
  return res.results.map(rowToCard).filter((c) => !isTombstoned(c.tags));
}

// Fields the TEXT board render (`renderBoard`) + its filters actually display:
// everything in CARD_STATUS_FIELDS plus the human-visible `title` and the
// `assignee` filter target. Crucially this OMITS the heavy multi-paragraph
// `body`, which the text list path never renders — so a one-screen `fkanban list`
// no longer drags every card's full spec over the wire (the first thing to time
// out when the node is busy). `--json`/`search`/MCP still use the full-body
// `listCards` because they genuinely surface bodies.
export const CARD_DISPLAY_FIELDS = ["slug", "title", "board", "column", "position", "tags", "assignee", "created_at"];

// Like listCards but fetches only CARD_DISPLAY_FIELDS (body-free); absent fields
// (notably `body`) come back as "" on the Card. Enough for the text board render,
// the board/column/tag/assignee filters, and the dep/blocked fan-out — but NOT
// for any path that must show a card's body. Mirrors listCardStatuses.
export async function listCardsForDisplay(node: NodeClient, cfg: Config): Promise<Card[]> {
  const hash = schemaHashFor("card", cfg);
  const res = await node.queryAll({ schemaHash: hash, fields: CARD_DISPLAY_FIELDS });
  return res.results.map(rowToCard).filter((c) => !isTombstoned(c.tags));
}

// Point read by slug — the node resolves a HashKey filter as an indexed key
// lookup, so this never scans the board.
export async function findCard(node: NodeClient, cfg: Config, slug: string): Promise<Card | null> {
  const hash = schemaHashFor("card", cfg);
  const res = await node.queryAll({
    schemaHash: hash,
    fields: fieldsFor("card"),
    filter: { HashKey: slug },
  });
  const card = res.results.map(rowToCard).find((c) => c.slug === slug);
  return card !== undefined && !isTombstoned(card.tags) ? card : null;
}

export async function findBoard(node: NodeClient, cfg: Config, slug: string): Promise<Board | null> {
  const hash = schemaHashFor("board", cfg);
  const res = await node.queryAll({
    schemaHash: hash,
    fields: fieldsFor("board"),
    filter: { HashKey: slug },
  });
  const board = res.results.map(rowToBoard).find((b) => b.slug === slug);
  return board !== undefined && !isTombstoned(board.columns) && board.slug.length > 0
    ? board
    : null;
}

// Resolve a board by slug, throwing the canonical `board_not_found` error
// when it doesn't exist. Shared by `add`, `list`, and `search` so the message
// + hint stay identical in one place.
export async function requireBoard(node: NodeClient, cfg: Config, slug: string): Promise<Board> {
  const board = await findBoard(node, cfg, slug);
  if (!board) {
    throw new FkanbanError({
      code: "board_not_found",
      message: `Board "${slug}" does not exist.`,
      hint: `Create it first: \`fkanban board create ${slug}\` (or use the default board).`,
    });
  }
  return board;
}

export function cardToFields(c: Card): Record<string, unknown> {
  return {
    slug: c.slug,
    title: c.title,
    body: c.body,
    board: c.board,
    column: c.column,
    position: c.position,
    assignee: c.assignee,
    // Persist deps back as reserved `dep:<slug>` tags alongside the user tags.
    tags: [...c.tags.filter((t) => !isDepTag(t)), ...c.deps.map(depTag)],
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
}

export function boardToFields(b: Board): Record<string, unknown> {
  return {
    slug: b.slug,
    title: b.title,
    body: b.body,
    columns: b.columns,
    created_at: b.created_at,
    updated_at: b.updated_at,
  };
}

export function validateSlug(slug: string): void {
  if (slug.length === 0) {
    throw new FkanbanError({ code: "invalid_slug", message: "Slug must be non-empty." });
  }
  if (!/^[a-z0-9][a-z0-9-_]*$/.test(slug)) {
    throw new FkanbanError({
      code: "invalid_slug",
      message: `Slug "${slug}" is invalid.`,
      hint: "Slugs are lowercase, start with a letter or digit, and use [a-z0-9-_].",
    });
  }
}

// A card's column must be one of the board's columns (or, when the board has
// no explicit column list, one of the default columns).
export function ensureColumn(column: string, boardColumns: string[]): void {
  const valid = boardColumns.length > 0 ? boardColumns : [...DEFAULT_COLUMNS];
  if (!valid.includes(column)) {
    throw new FkanbanError({
      code: "invalid_column",
      message: `"${column}" is not a column on this board.`,
      hint: `Valid columns: ${valid.join(" | ")}`,
    });
  }
}

export function isColumn(s: string): s is Column {
  return isDefaultColumn(s);
}

// Position for a card appended to a column: current epoch millis. Positions
// only need to sort ascending, so a timestamp appends after everything already
// there (legacy hand-numbered positions are tiny by comparison) without ever
// reading the rest of the board. Same-millisecond appends fall back to the
// created_at tiebreak in sortCards.
export function appendPosition(): string {
  return String(Date.now());
}

// Order cards within a column: explicit integer `position` ascending, then
// created_at as a stable tiebreak. Non-numeric / empty positions sort last.
export function sortCards<T extends Card>(cards: T[]): T[] {
  return cards.slice().sort((a, b) => {
    const pa = parsePosition(a.position);
    const pb = parsePosition(b.position);
    if (pa !== pb) return pa - pb;
    return a.created_at.localeCompare(b.created_at);
  });
}

function parsePosition(p: string): number {
  const n = parseInt(p, 10);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

// ── Priority ranking ────────────────────────────────────────────────────────
// A card's priority is an optional signal that lets `rank` order a column so
// `fkanban-pickup` — which drains the LOWEST `position` first — works the most
// urgent cards first. `rank` is the step that turns this signal into the
// `position` field pickup/list/sortCards already order by; without it priority
// is inert. Priority is read, in precedence order, from:
//   1. a line-anchored `Priority: P<n>` body header (most explicit — a human or
//      generator wrote it into the spec), then
//   2. a `p0`..`p3` tag (the structured channel `add --priority` writes to),
//   3. else DEFAULT_PRIORITY.
// P0 = most urgent … P3 = least. Storing priority as a TAG (not a new schema
// field) keeps it republish-free, exactly like deps and the delete tombstone.
export const PRIORITY_TIERS = ["P0", "P1", "P2", "P3"] as const;
export type PriorityTier = (typeof PRIORITY_TIERS)[number];

// A card with no priority signal sorts as "normal" — below an explicit P0/P1
// and above an explicit P3 — so an un-prioritized backlog isn't shoved beneath
// one deliberately-deferred card.
export const DEFAULT_PRIORITY: PriorityTier = "P2";

// Line-anchored so a "Priority:" mention mid-prose doesn't count (mirrors
// hasRepoHeaders). Case-insensitive on both the label and the P<n> token.
const PRIORITY_HEADER_RE = /^[ \t]*Priority:[ \t]*(P[0-3])\b/im;
const PRIORITY_TAG_RE = /^p([0-3])$/i;

// Normalize any accepted spelling (`p1`, `P1`, ` p1 `) to the canonical `P1`,
// or null if it isn't a priority tier. Used by `add --priority` flag parsing.
export function normalizePriority(s: string): PriorityTier | null {
  const up = s.trim().toUpperCase();
  return (PRIORITY_TIERS as readonly string[]).includes(up) ? (up as PriorityTier) : null;
}

// The tag a `--priority P1` flag stores (lower-case `p1`) so it reads as an
// ordinary label and `priorityOf` picks it up.
export function priorityTag(tier: PriorityTier): string {
  return tier.toLowerCase();
}

// True for a `p0`..`p3` priority tag (leading `#` and surrounding space ok).
export function isPriorityTag(tag: string): boolean {
  return PRIORITY_TAG_RE.test(tag.replace(/^#/, "").trim());
}

// Resolve a card's priority tier from its body header (wins) or a p0..p3 tag,
// falling back to DEFAULT_PRIORITY. Pure — the core read used by rankCards.
export function priorityOf(card: { body: string; tags: string[] }): PriorityTier {
  const m = card.body.match(PRIORITY_HEADER_RE);
  if (m) return m[1]!.toUpperCase() as PriorityTier;
  for (const t of card.tags) {
    const tm = t.replace(/^#/, "").trim().match(PRIORITY_TAG_RE);
    if (tm) return `P${tm[1]}` as PriorityTier;
  }
  return DEFAULT_PRIORITY;
}

// 0-based urgency rank (P0 → 0 … P3 → 3) — lower sorts first.
export function priorityRank(tier: PriorityTier): number {
  return PRIORITY_TIERS.indexOf(tier);
}

// Gap left between adjacent ranked positions so a human can hand-insert a card
// between two without forcing a full re-rank (10, 20, 30, …).
export const RANK_POSITION_STEP = 10;

// Order a set of cards the way pickup should drain them: by priority ascending
// (P0 first), then created_at ascending (older first) — the same stable
// secondary key sortCards uses. Pure; does not mutate the input array.
export function rankCards<T extends Card>(cards: T[]): T[] {
  return cards.slice().sort((a, b) => {
    const ra = priorityRank(priorityOf(a));
    const rb = priorityRank(priorityOf(b));
    if (ra !== rb) return ra - rb;
    return a.created_at.localeCompare(b.created_at);
  });
}

// Set a card's priority tag: drop any existing p0..p3 tag and append the new
// one, preserving the order of the other tags. Returns a fresh array (input
// untouched). Used by `add --priority`.
export function withPriorityTag(tags: string[], tier: PriorityTier): string[] {
  return [...tags.filter((t) => !isPriorityTag(t)), priorityTag(tier)];
}

// Type guard for record-type-keyed config lookups used by the CLI.
export function recordTypeFields(type: RecordType): string[] {
  return fieldsFor(type);
}
