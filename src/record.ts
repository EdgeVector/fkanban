// Domain helpers: turn fold_db query rows into typed Card / Board records,
// list + find by slug, soft-delete (tombstone), slug + column validation.

import { FkanbanError, type CasExpectation, type NodeClient, type QueryFilter, type QueryRow } from "./client.ts";
import {
  patchCardListIndex,
  readCardListIndex,
  writeCardListIndex,
  toCardSummary,
  readBoardListIndex,
  writeBoardListIndex,
} from "./card-list-index.ts";
import {
  listAllBoardCards,
  listBoardCardsPartition,
  removeBoardCard,
  upsertBoardCard,
} from "./board-cards.ts";
import { rememberCardLegacyWriteHash, schemaHashFor, type Config } from "./config.ts";
import {
  DEFAULT_BOARD_SLUG,
  DEFAULT_COLUMNS,
  CARD_OPTIONAL_SCHEMA_FIELDS,
  fieldsFor,
  fixedColumns,
  isDefaultColumn,
  resolveColumns,
  schemaFor,
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
  // final column of its own board). Canonical storage is the Card schema's
  // `deps` array field; legacy `dep:<slug>` tags are read only as a migration
  // fallback and are stripped on the next write.
  deps: string[];
  // Repo-relative path globs or bare subsystem names this card expects to
  // touch. Used by `overlap` as an advisory file-surface claim.
  surfaces: string[];
  created_at: string;
  // Immutable self-reported provenance captured when the card is first
  // created. Legacy cards read as "unknown"; updates must never infer or
  // replace it from the current process identity.
  created_by?: string;
  updated_at: string;
  // First time the card entered its board's terminal column. Empty for legacy
  // or not-yet-complete cards; immutable once set.
  done_at: string;
  // ── Structured pickup-decision + reconcile fields ───────────────────────
  // (fbrain design `fkanban-card-structured-fields`). Stored as plain String
  // schema fields; enum-valued ones (kind/block_status) are normalized on use
  // via normalizeKind/normalizeBlockStatus so a stale/legacy value never throws.
  // All default to "" for pre-migration cards (rowToCard).
  repo: string; // owner/name a build agent clones; "" = not a code card
  db: string; // lastdb://... locator for the DB this card belongs to
  base: string; // base branch a PR targets (default "main")
  kind: string; // CardKind: pr|registry|tracker|umbrella|meta|program|capstone|validation
  block_status: string; // BlockStatus: none|needs_human|design_first|deferred
  block_reason: string; // free-text why, when block_status != none
  north_star: string; // fbrain North Star slug this advances
  milestone?: string; // fkanban Milestone slug this card advances
  pr_url: string; // PR driving this card, when in flight
  branch: string; // worktree/feature branch
};

export type Board = {
  slug: string;
  title: string;
  body: string;
  columns: string[];
  created_at: string;
  updated_at: string;
};

export const MILESTONE_STATES = ["planned", "active", "blocked", "proving", "complete", "abandoned"] as const;
export type MilestoneState = (typeof MILESTONE_STATES)[number];
export const MILESTONE_PROOF_STATUSES = ["pending", "passing", "failing", "not_required"] as const;

export type Milestone = {
  slug: string;
  title: string;
  body: string;
  board: string;
  state: string;
  position: string;
  north_star: string;
  driver: string;
  deps: string[];
  proof_card: string;
  proof_status: string;
  block_reason: string;
  created_at: string;
  updated_at: string;
  completed_at: string;
};

export function isMilestoneState(value: string): value is MilestoneState {
  return (MILESTONE_STATES as readonly string[]).includes(value);
}

// Legacy soft-delete sentinel. Current `rm` uses the node's native delete
// mutation, so new tombstoned records are filtered before fkanban sees them.
// Keep this backstop so records deleted by older fkanban builds stay hidden.
export const TOMBSTONE_TAG = "__fkanban_deleted__";

// The reserved slug a write probe uses. Namespaced + obviously-throwaway so it
// never collides with a real card, and hidden from reads even if best-effort
// cleanup is shed by a busy node.
export const WRITE_PROBE_SLUG = "__fkanban_write_probe__";

export const UNKNOWN_CREATED_BY = "unknown";

/** Collapse a creator label to one safe, single-line operational identifier. */
export function normalizeCreatedBy(value: string | undefined | null): string {
  return (value ?? "").trim().replace(/\s+/g, " ").slice(0, 256);
}

/** Resolve creator provenance at CREATE time only. */
export function resolveCreatedBy(
  explicit?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const direct = [explicit, env.FKANBAN_CREATED_BY, env.LASTGIT_ACTOR]
    .map(normalizeCreatedBy)
    .find(Boolean);
  if (direct) return direct;

  const automationId = normalizeCreatedBy(env.AUTOMATION_ID);
  if (env.DRIVEN_BY === "routine" && automationId) return `routine:${automationId}`;

  const codexThread = normalizeCreatedBy(env.CODEX_THREAD_ID);
  if (codexThread) return `codex:${codexThread}`;

  const claudeSession = normalizeCreatedBy(env.CLAUDE_SESSION_ID ?? env.CLAUDE_CODE_SESSION_ID);
  if (claudeSession) return `claude:${claudeSession}`;

  const user = normalizeCreatedBy(env.USER);
  return user ? `user:${user}` : UNKNOWN_CREATED_BY;
}

export function isTombstoned(tags: string[]): boolean {
  return tags.includes(TOMBSTONE_TAG);
}

function isHiddenCard(card: Card): boolean {
  return card.slug === WRITE_PROBE_SLUG || isTombstoned(card.tags);
}

// Legacy dependency tag prefix. Dependency edges are now canonically stored in
// the Card schema's `deps` field. Keep the prefix reader so old rows are
// migrated in memory, but never write `dep:<slug>` tags for dependency edges.
export const DEP_TAG_PREFIX = "dep:";
export const DONE_AT_TAG_PREFIX = "done_at:";

export function isDepTag(tag: string): boolean {
  return tag.startsWith(DEP_TAG_PREFIX);
}

export function depTag(slug: string): string {
  return `${DEP_TAG_PREFIX}${slug}`;
}

export function isDoneAtTag(tag: string): boolean {
  return tag.startsWith(DONE_AT_TAG_PREFIX);
}

export function doneAtTag(doneAt: string): string {
  return `${DONE_AT_TAG_PREFIX}${doneAt}`;
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
// A dep list is a tag list that additionally rejects the card's own slug, so
// reuse normalizeTags for the trim/blank/dedupe pass and drop the self-edge.
export function normalizeDeps(deps: string[], selfSlug: string): string[] {
  return normalizeTags(deps).filter((d) => d !== selfSlug);
}

export function normalizeSurfaces(surfaces: string[]): string[] {
  return normalizeTags(surfaces);
}

// Shared dependency validation error. Dependency edges must point at live cards:
// forward/dangling deps otherwise look like structured data but cannot ever
// resolve without human archaeology.
export function missingDepError(dep: string): FkanbanError {
  return new FkanbanError({
    code: "missing_dependency",
    message: `Dependency card "${dep}" does not exist.`,
    hint: "Create the dependency card first, or depend on the existing card slug that proves the prerequisite.",
  });
}

// Legacy formatter for older result envelopes that reported dependent cards on
// delete. Current `rm` refuses before tombstoning when live dependents exist, so
// normal callers should see a `card_has_dependents` error instead of this text.
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
  return "Finish its dependencies first (move them to their board's final column), keep the dependent in default/backlog until then, or pass --force to override.";
}

// The columns at which dependencies actually gate work. A dependency is
// satisfied only once its card reaches its board's final column (see
// depStatus); entering one of these "started" columns while still blocked is
// what `move` refuses (unless --force). NOTE: this gate list is still the
// default-board column names — generalizing which columns count as "working" on
// an arbitrary board is tracked separately and intentionally out of scope here.
// Working columns that gate dependency enforcement on the default board.
// (No `review` — incomplete work stays todo/doing; terminal is done.)
export const WORKING_COLUMNS = ["doing", "done"] as const;

export function isWorkingColumn(column: string): boolean {
  return (WORKING_COLUMNS as readonly string[]).includes(column);
}

export function terminalColumn(columns: readonly string[]): string {
  const resolved = resolveColumns(columns);
  return resolved[resolved.length - 1] ?? FALLBACK_TERMINAL_COLUMN;
}

export function doneAtForColumnTransition(
  card: Pick<Card, "column" | "done_at"> | null,
  targetColumn: string,
  boardColumns: readonly string[],
  now: string,
): string {
  const terminal = terminalColumn(boardColumns);
  if (targetColumn !== terminal) return "";
  const existing = card?.done_at ?? "";
  if (existing) return existing;
  const fromColumn = card?.column ?? "";
  return fromColumn !== terminal ? now : "";
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
// A card whose tags map to TWO+ DIFFERENT repos is a real conflict we refuse to
// guess — it is surfaced LOUDLY (block_status=needs_human) so
// morning-sync/program-rollup see it, rather than disappearing silently. A card
// with NO subsystem signal at all is left headerless unless the caller supplies
// an explicit defaultRepo override.

// Single source of truth: subsystem tag → repo. A tag set that resolves to
// exactly one repo is stamped; >1 distinct repos is a "conflict"; zero matches
// is left ambiguous unless a caller explicitly supplies a default repo.
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

// Catch-all repo kept for callers that explicitly opt into defaulting. Ordinary
// grooming leaves no-signal cards headerless instead of guessing.
export const DEFAULT_REPO = "EdgeVector/fold";

// True iff the body already carries both pickup headers (line-anchored so a
// passing mention in prose doesn't count). Idempotency guard for re-`add`s.
export function hasRepoHeaders(body: string): boolean {
  return /^[ \t]*Repo:/m.test(body) && /^[ \t]*Base:/m.test(body);
}

export function stripTrailingInlineComment(value: string): string {
  return value.replace(/[ \t]+#.*$/, "").trim();
}

const MASHED_HEADER_RE = /\s+(Base|Branch|Kind):/gi;

function firstHeaderToken(value: string): string {
  const line = stripTrailingInlineComment(value.split("\\n")[0]!.split("\n")[0]!);
  return line.match(/^(\S+)/)?.[1]?.trim() ?? "";
}

export function sanitizeRepoValue(raw: string): string | null {
  let value = raw.trim();
  const escapedNewline = value.indexOf("\\n");
  if (escapedNewline >= 0) value = value.slice(0, escapedNewline);
  const realNewline = value.indexOf("\n");
  if (realNewline >= 0) value = value.slice(0, realNewline);
  value = stripTrailingInlineComment(value);

  MASHED_HEADER_RE.lastIndex = 0;
  const mashedHeader = MASHED_HEADER_RE.exec(value);
  if (mashedHeader) value = value.slice(0, mashedHeader.index);

  value = value.replace(/\s+\(.+$/u, "");
  value = value.replace(/\s+·.+$/u, "");
  const token = value.match(/^(\S+)/)?.[1]?.trim() ?? "";
  return token && token.toLowerCase() !== "none" ? token : null;
}

function mashedHeadersFromRepoTail(raw: string): string[] {
  MASHED_HEADER_RE.lastIndex = 0;
  const matches = [...raw.matchAll(MASHED_HEADER_RE)];
  MASHED_HEADER_RE.lastIndex = 0;
  const headers: string[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i]!;
    const name = match[1]!;
    const valueStart = match.index! + match[0].length;
    const valueEnd = matches[i + 1]?.index ?? raw.length;
    const value = firstHeaderToken(raw.slice(valueStart, valueEnd));
    if (value) headers.push(`${name}: ${value}`);
  }
  return headers;
}

function sanitizeRepoHeaderLine(line: string): string {
  const m = line.match(/^([ \t]*Repo:[ \t]*)(.*)$/i);
  if (!m) return line;
  const clean = sanitizeRepoValue(m[2]!);
  if (!clean) return line;
  const extraHeaders = mashedHeadersFromRepoTail(m[2]!);
  return [m[1]! + clean, ...extraHeaders].join("\n");
}

function sanitizeRepoHeadersInBody(body: string): string {
  return body.replace(/^[ \t]*Repo:[^\n]*(?:\n|$)/gim, (line) => {
    const hadNewline = line.endsWith("\n");
    const clean = sanitizeRepoHeaderLine(hadNewline ? line.slice(0, -1) : line);
    return hadNewline ? `${clean}\n` : clean;
  });
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

// The distinct repos a tag set maps to (deduped). size 0 = no signal; size 1 =
// unambiguous; size >1 = conflict.
export function repoMatchesFromTags(tags: string[]): Set<string> {
  const repos = new Set<string>();
  for (const t of tags) {
    const repo = TAG_TO_REPO[t.replace(/^#/, "").trim().toLowerCase()];
    if (repo) repos.add(repo);
  }
  return repos;
}

// The single repo a tag set unambiguously maps to, or null (zero or >1 match).
export function inferRepoFromTags(tags: string[]): string | null {
  const repos = repoMatchesFromTags(tags);
  return repos.size === 1 ? [...repos][0]! : null;
}

export type HeaderDerivation =
  | { kind: "present" } // already had Repo:/Base:
  | { kind: "skip-registry" } // recipe/registry card — never stamp
  | { kind: "conflict"; repos: string[] } // tags map to >1 repo — surface, don't guess
  | { kind: "ambiguous" } // no signal — surface, don't guess
  | { kind: "defaulted"; repo: string; base: string; body: string } // caller-supplied no-signal default
  | { kind: "stamped"; repo: string; base: string; body: string }; // unambiguous tag inference

function stampHeader(repo: string, base: string, body: string): string {
  return `Repo: ${repo}\nBase: ${base}\n\n${body}`;
}

// Pure decision + transform. Callers stamp the returned `body` for "stamped" /
// "defaulted"; surface "conflict" loudly (needs_human) and "ambiguous" as a
// warning. `defaultRepo` is an opt-in no-signal fallback. `forcedRepo` is an
// explicit caller-supplied repo (the `--repo` flag) that OVERRIDES tag inference
// — it stamps that repo's header even when the tags conflict, so resolving a
// conflict is a one-liner (`add <slug> --repo <owner/name>`).
export function deriveRepoHeaders(
  body: string,
  tags: string[],
  title: string,
  opts: { defaultRepo?: string; forcedRepo?: string } = {},
): HeaderDerivation {
  if (hasRepoHeaders(body)) return { kind: "present" };
  if (isRegistryCard(body, title)) return { kind: "skip-registry" };
  // An explicit --repo is authoritative: stamp it and skip tag inference entirely
  // (this is how the watcher's conflict-triage resolves a >1-repo card).
  const forcedRepo = opts.forcedRepo?.trim();
  if (forcedRepo) {
    return { kind: "stamped", repo: forcedRepo, base: DEFAULT_BASE, body: stampHeader(forcedRepo, DEFAULT_BASE, body) };
  }
  const repos = repoMatchesFromTags(tags);
  if (repos.size === 1) {
    const repo = [...repos][0]!;
    return { kind: "stamped", repo, base: DEFAULT_BASE, body: stampHeader(repo, DEFAULT_BASE, body) };
  }
  if (repos.size > 1) return { kind: "conflict", repos: [...repos].sort() };
  // size === 0: no subsystem signal at all. Leave the card headerless unless a
  // caller explicitly opts into a default repo.
  const defaultRepo = (opts.defaultRepo ?? "").trim();
  if (defaultRepo) {
    return { kind: "defaulted", repo: defaultRepo, base: DEFAULT_BASE, body: stampHeader(defaultRepo, DEFAULT_BASE, body) };
  }
  return { kind: "ambiguous" };
}

export function missingHeaderWarning(slug: string): string {
  return (
    `warning: card "${slug}" is in todo with no Repo:/Base: header and its tags ` +
    `don't map to a single repo — fkanban-pickup will skip it. Add a "Repo: <owner>/<name>" ` +
    `and "Base: <branch>" header (or a single subsystem tag) to make it pickup-eligible.`
  );
}

export function conflictRepoWarning(slug: string, repos: string[]): string {
  return (
    `warning: card "${slug}" is in todo but its tags map to ${repos.length} repos ` +
    `(${repos.join(", ")}) — refusing to guess. Marked block_status=needs_human; set a single ` +
    `"Repo: <owner>/<name>" header (or drop the cross-repo tag) to make it pickup-eligible.`
  );
}

export function defaultedRepoNotice(slug: string, repo: string): string {
  return (
    `note: card "${slug}" had no subsystem tag — defaulted Repo: ${repo}. ` +
    `Correct the Repo:/Base: header if that's wrong.`
  );
}

// Marker prefix for the auto-set cross-repo-conflict hold, so `applyDerivedHeader`
// can recognize (and self-heal) ITS OWN hold without clobbering a human's.
export const REPO_CONFLICT_BLOCK_PREFIX = "Repo ambiguous:";

// What `applyHeaderDerivation` decided: the (possibly header-prefixed) body, plus
// an optional intentional hold to set when we refuse to guess a conflicting repo.
export type HeaderDerivationResult = {
  body: string;
  blockStatus?: BlockStatus;
  blockReason?: string;
};

// Orchestration shared by `add` and `move`: in a pre-execution column
// (backlog/todo) auto-stamp the header when derivable, leave no-signal cards
// headerless, and — only in `todo`, where it blocks pickup — surface a real
// cross-repo conflict as a needs_human hold (so it's loud, not silently skipped).
// Working columns (doing/done) are left untouched. `warn` is injected so
// it's testable / silenceable.
export function applyHeaderDerivation(
  card: { slug: string; body: string; tags: string[]; title: string; column: string },
  warn: (msg: string) => void,
  opts: { defaultRepo?: string; forcedRepo?: string } = {},
): HeaderDerivationResult {
  const body = sanitizeRepoHeadersInBody(card.body);
  if (isWorkingColumn(card.column)) return { body };
  const d = deriveRepoHeaders(body, card.tags, card.title, opts);
  if (d.kind === "stamped") return { body: d.body };
  if (d.kind === "defaulted") {
    if (card.column === "todo") warn(defaultedRepoNotice(card.slug, d.repo));
    return { body: d.body };
  }
  if (d.kind === "conflict" && card.column === "todo") {
    warn(conflictRepoWarning(card.slug, d.repos));
    return {
      body,
      blockStatus: "needs_human",
      blockReason: `${REPO_CONFLICT_BLOCK_PREFIX} tags map to ${d.repos.join(" + ")}. Set a single Repo:/Base: header to unblock.`,
    };
  }
  if (d.kind === "ambiguous" && card.column === "todo") warn(missingHeaderWarning(card.slug));
  return { body };
}

// Apply a `HeaderDerivationResult` onto a card (mutates): always take the new
// body; set the auto needs_human hold ONLY when the card isn't already
// intentionally held (don't clobber a human's design_first/deferred); and
// self-heal — when a previously-conflicting card now resolves (stamped/defaulted),
// clear OUR OWN auto-hold (recognized by REPO_CONFLICT_BLOCK_PREFIX). Returns the
// card. Shared by `add` and `move` so both paths behave identically.
export function applyDerivedHeader(card: Card, result: HeaderDerivationResult): Card {
  card.body = result.body;
  const current = normalizeBlockStatus(card.block_status);
  if (result.blockStatus) {
    if (current === "none") {
      card.block_status = result.blockStatus;
      card.block_reason = result.blockReason ?? "";
    }
  } else if (current === "needs_human" && card.block_reason.startsWith(REPO_CONFLICT_BLOCK_PREFIX)) {
    card.block_status = "none";
    card.block_reason = "";
  }
  return card;
}

// ── Pickup-area overlap hints ───────────────────────────────────────────────
// File-overlap alone misses work that touches the same product/source region
// after an agent expands scope. Keep a schema-free coordination hint in tags:
// `area:<tool>-<command>` (for example `area:fbrain-list`) is derived from
// explicit Area:/Pickup Area: body lines, a fixed allowlist of real CLI/MCP
// command names in card specs (`fbrain list`, `fbrain_list`), and
// narrowly-known feature-area phrases that otherwise don't look like commands
// (`forge CI`, `.forgejo/workflows/*`).
// When a ready todo card shares a pickup area with another unblocked active card
// in the same repo, put the new card on a reversible needs_human hold so pickup
// serializes or re-grooms it.
export const PICKUP_AREA_TAG_PREFIX = "area:";
export const PICKUP_AREA_BLOCK_PREFIX = "Pickup area overlap:";
export const PICKUP_AREA_ACTIVE_COLUMNS = ["todo", "doing"] as const;
const PICKUP_AREA_ACTIVE_COLUMN_SET = new Set<string>(PICKUP_AREA_ACTIVE_COLUMNS);
export const PICKUP_AREA_PEER_FIELDS = [
  "slug",
  "title",
  "column",
  "position",
  "tags",
  "deps",
  "created_at",
  "repo",
  "kind",
  "block_status",
] as const;
const PICKUP_AREA_PEER_BODY_FIELDS = [...PICKUP_AREA_PEER_FIELDS, "body"] as const;
const FEATURE_AREA_PATTERNS: Array<{ area: string; pattern: RegExp }> = [
  // Path references only. The former prose patterns ("forge ci", "forge
  // required checks") matched the standard venue boilerplate every well-formed
  // Forgejo-repo card carries ("CI gate: `Forge CI / ci-required`"), minting
  // area:forge-ci on cards that merely ship THROUGH forge CI rather than cards
  // ABOUT it — the dominant source of false pickup-area needs_human holds.
  // Cards genuinely about CI infrastructure reference .forgejo/workflows paths
  // or declare an explicit `Area: forge-ci` line, both of which still match.
  { area: "forge-ci", pattern: /(?:^|[`"'([{\s])\.forgejo\/workflows(?:\/[A-Za-z0-9._/-]+)?/gim },
];

// Real command names only — NOT "any following word". A prose match on
// "fbrain got indexed" or the mandatory "Follow the fkanban-agent skill"
// boilerplate must not mint an area tag. Keep in sync with src/cli.ts
// commands (fkanban) and the fbrain MCP tool surface (fbrain).
const FKANBAN_COMMANDS = new Set([
  "init",
  "mcp",
  "version",
  "doctor",
  "add",
  "move",
  "dep",
  "tag",
  "list",
  "rank",
  "search",
  "show",
  "rm",
  "board",
]);
const FBRAIN_COMMANDS = new Set([
  "ask",
  "get",
  "put",
  "list",
  "search",
  "link",
  "append",
  "delete",
  "status",
  "backlinks",
]);

// An explicit `Area:` / `Feature Area:` / `Pickup Area:` declaration carries a
// short comma/space list of slug-like tag tokens (`fkanban-cards`,
// `fbrain-list, board`). A prose sentence that merely *begins* with "Area:"
// (`Area: lines short-circuit prose scraping).`) must NOT be treated as an
// authoritative declaration — it would scrape ordinary English words into
// bogus `area:*` tags. Distinguish the two structurally: accept only a small
// list whose every token is a bare slug (letters/digits joined by -, _ or /).
// Whitespace-only multi-token lists must be visibly slug-like, so a sentence
// such as `Area: lines short-circuit prose scraping` is not accepted just
// because each word can be slugified.
// Trailing sentence punctuation, internal apostrophes/parens, or too many
// tokens all mark the line as prose, not a declaration.
const MAX_EXPLICIT_AREA_TOKENS = 4;
const AREA_TOKEN_RE = /^(?:#|area:)?[a-z0-9]+(?:[-/_][a-z0-9]+)*$/i;
function isExplicitAreaDeclaration(value: string): boolean {
  const tokens = value.trim().split(/[,\s]+/).filter((t) => t.length > 0);
  if (tokens.length === 0 || tokens.length > MAX_EXPLICIT_AREA_TOKENS) return false;
  if (!tokens.every((t) => AREA_TOKEN_RE.test(t))) return false;
  if (!value.includes(",") && tokens.length > 1) {
    return tokens.every((t) => /[-/_0-9]/.test(t.replace(/^#/, "").replace(/^area:/i, "")));
  }
  return true;
}

// Blank out ``` / ~~~ fenced code blocks so command examples inside them
// (`fkanban tag rm <slug> area:<bogus-tag>`) can't be mistaken for explicit
// `Area:` declarations or real command mentions. Replaced with blank lines so
// line-anchored regexes keep their line geometry.
function stripFencedCodeBlocks(text: string): string {
  let inFence = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^[ \t]*(?:```|~~~)/.test(line)) {
        inFence = !inFence;
        return "";
      }
      return inFence ? "" : line;
    })
    .join("\n");
}

function normalizePickupArea(value: string): string | null {
  const raw = value
    .trim()
    .replace(/^#/, "")
    .replace(new RegExp(`^${PICKUP_AREA_TAG_PREFIX}`, "i"), "")
    .replace(/_/g, "-")
    .toLowerCase();
  const slug = raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length > 0 ? `${PICKUP_AREA_TAG_PREFIX}${slug}` : null;
}

export function isPickupAreaTag(tag: string): boolean {
  return tag.trim().replace(/^#/, "").toLowerCase().startsWith(PICKUP_AREA_TAG_PREFIX);
}

export function pickupAreaTagsForCard(card: Pick<Card, "title" | "body" | "tags">): string[] {
  const areas = new Set<string>();
  const add = (value: string) => {
    const normalized = normalizePickupArea(value);
    if (normalized) areas.add(normalized);
  };

  for (const tag of card.tags) {
    if (isPickupAreaTag(tag)) add(tag);
  }

  // Ignore fenced code blocks entirely: command examples inside them
  // (`fkanban tag rm <slug> area:<bogus-tag>`) are illustrative, not
  // declarations of the card's own pickup area.
  const text = stripFencedCodeBlocks(`${card.title}\n${card.body}`);
  const explicitAreaRe = /^(?:Feature[ \t]+Area|Pickup[ \t]+Area|Area):[ \t]*(.+)$/gm;
  let hasExplicitArea = false;
  for (const m of text.matchAll(explicitAreaRe)) {
    const value = m[1] ?? "";
    // Only a short slug-token list is an authoritative declaration; a prose
    // sentence that merely begins with "Area:" is not (it would scrape
    // ordinary words into bogus area tags).
    if (!isExplicitAreaDeclaration(value)) continue;
    hasExplicitArea = true;
    for (const part of value.split(/[,\s]+/)) add(part);
  }

  // Explicit signals are authoritative: once a card declares its area(s) via
  // Area:/Pickup Area: lines, skip prose scraping entirely rather than
  // layering on false positives from unrelated command-shaped mentions.
  if (!hasExplicitArea) {
    const commandRe = /\b(fbrain|fkanban)(?:[ \t]+|[_-]+)([a-z][a-z0-9-]*)\b/gi;
    for (const m of text.matchAll(commandRe)) {
      const tool = (m[1] ?? "").toLowerCase();
      const cmd = (m[2] ?? "").toLowerCase();
      const allowlist = tool === "fbrain" ? FBRAIN_COMMANDS : FKANBAN_COMMANDS;
      if (allowlist.has(cmd)) add(`${tool}-${cmd}`);
    }

    for (const { area, pattern } of FEATURE_AREA_PATTERNS) {
      if (pattern.test(text)) add(area);
      pattern.lastIndex = 0;
    }
  }

  return [...areas].sort();
}

export function withPickupAreaTags(tags: string[], card: Pick<Card, "title" | "body" | "tags">): string[] {
  const visibleTags = tags.filter((t) => !isPickupAreaTag(t));
  return normalizeTags([...visibleTags, ...pickupAreaTagsForCard({ ...card, tags: [] })]);
}

export type PickupAreaOverlap = {
  other: Card;
  areas: string[];
};

function pickupRepo(card: Pick<Card, "repo" | "body">): string {
  const resolved = resolvePickupRepo(card);
  return resolved.ok ? resolved.repo : "";
}

// Does `fromSlug` reach `toSlug` by following `deps` edges? (directed). A
// dangling dep (no live card) simply has no outgoing edges; `visited` guards
// against pre-existing cycles in the data.
function depsReaches(depsBySlug: Map<string, string[]>, fromSlug: string, toSlug: string): boolean {
  const visited = new Set<string>();
  const walk = (node: string): boolean => {
    if (node === toSlug) return true;
    if (visited.has(node)) return false;
    visited.add(node);
    for (const next of depsBySlug.get(node) ?? []) {
      if (walk(next)) return true;
    }
    return false;
  };
  for (const next of depsBySlug.get(fromSlug) ?? []) {
    if (walk(next)) return true;
  }
  return false;
}

// Are two cards connected by a dependency path in EITHER direction (a→…→b or
// b→…→a)? A dep edge already serializes pickup — the two cards can never be
// worked concurrently — which is the exact thing the pickup-area overlap block
// exists to force. So an area overlap between dep-connected cards is a false
// positive, and the block must be skipped.
export function depsPathConnects(allCards: Card[], slugA: string, slugB: string): boolean {
  if (slugA === slugB) return false;
  const depsBySlug = new Map(allCards.map((c) => [c.slug, c.deps]));
  return depsReaches(depsBySlug, slugA, slugB) || depsReaches(depsBySlug, slugB, slugA);
}

export function findPickupAreaOverlap(card: Card, allCards: Card[]): PickupAreaOverlap | null {
  if (card.column !== "todo") return null;
  if (normalizeKind(card.kind) !== "pr" || isRegistryCard(card.body, card.title)) return null;

  const repo = pickupRepo(card);
  if (!repo) return null;
  const areas = new Set(pickupAreaTagsForCard(card));
  if (areas.size === 0) return null;

  // The board list passed in may predate this card's write (create/update derive
  // BEFORE persisting), so its deps aren't in `allCards` yet — splice the live
  // card in so dep-path connectivity sees the edges it carries on THIS write.
  const cardsWithSelf = allCards.some((c) => c.slug === card.slug)
    ? allCards.map((c) => (c.slug === card.slug ? card : c))
    : [...allCards, card];

  for (const other of sortCards(allCards)) {
    if (other.slug === card.slug) continue;
    if (!PICKUP_AREA_ACTIVE_COLUMN_SET.has(other.column)) continue;
    if (normalizeKind(other.kind) !== "pr" || normalizeBlockStatus(other.block_status) !== "none") continue;
    if (pickupRepo(other) !== repo) continue;
    // A dep path (either direction) already serializes the two cards, so an area
    // overlap between them is a false positive — the dep edge provides exactly
    // the serialization this block would otherwise force. Check connectivity over
    // a graph that includes THIS card's own (possibly not-yet-persisted) deps:
    // on a create/update, `card` carries edges `allCards` doesn't have yet.
    if (depsPathConnects(cardsWithSelf, card.slug, other.slug)) continue;
    // Two cards advancing the SAME North Star are one program's lanes: the
    // program driver files them in dependency order on purpose, and file-level
    // collisions are already caught by declared-surfaces overlap at claim
    // time. An area hold here second-guesses the driver and has produced only
    // false positives (see papercut-groomer-area-forge-ci-false-human-gates).
    if (card.north_star && card.north_star === other.north_star) continue;
    const overlap = pickupAreaTagsForCard(other).filter((area) => areas.has(area));
    if (overlap.length > 0) return { other, areas: overlap };
  }
  return null;
}

// Apply pickup-area tag derivation, then set/clear the overlap soft-block.
// `explicitBlockStatus` is true when the caller passed `--block-status` on THIS
// write: an explicit set/clear is authoritative and must NOT be re-derived over
// on the same write. The hook may still re-evaluate on a FUTURE write — this
// only makes the human's explicit intent stick for the write that carried it,
// which is the sole escape hatch for a false-positive overlap block whose card
// body still cites the shared fbrain slug.
export function applyPickupAreaDerivation(
  card: Card,
  allCards: Card[],
  explicitBlockStatus = false,
): Card {
  card.tags = withPickupAreaTags(card.tags, card);
  // Honor an explicit --block-status on this write: derive tags but leave the
  // caller-set block untouched (don't re-block, don't self-heal-clear).
  if (explicitBlockStatus) return card;
  const current = normalizeBlockStatus(card.block_status);
  const overlap = findPickupAreaOverlap(card, allCards);

  if (overlap) {
    const reason =
      `${PICKUP_AREA_BLOCK_PREFIX} shares ${overlap.areas.join(", ")} with ` +
      `${overlap.other.slug} in ${overlap.other.column}; serialize or retag one card.`;
    if (current === "none" || (current === "needs_human" && card.block_reason.startsWith(PICKUP_AREA_BLOCK_PREFIX))) {
      card.block_status = "needs_human";
      card.block_reason = reason;
    }
  } else if (current === "needs_human" && card.block_reason.startsWith(PICKUP_AREA_BLOCK_PREFIX)) {
    card.block_status = "none";
    card.block_reason = "";
  }
  return card;
}

export async function stampCardForWrite(
  node: NodeClient,
  cfg: Config,
  card: Card,
  opts: {
    forcedRepo?: string;
    explicitBlockStatus?: boolean;
    explicitPriority?: boolean;
    explicitStructuredFields?: StructuredFieldRepairOptions;
    warn?: (msg: string) => void;
  } = {},
): Promise<Card> {
  applyDerivedHeader(
    card,
    applyHeaderDerivation(
      { slug: card.slug, body: card.body, tags: card.tags, title: card.title, column: card.column },
      opts.warn ?? console.error,
      { forcedRepo: opts.forcedRepo },
    ),
  );
  repairStructuredFieldsFromBody(card, opts.explicitStructuredFields);
  applyBodyPriorityTag(card, opts.explicitPriority === true);
  const explicitBlockStatus = opts.explicitBlockStatus === true;
  const areaPeers = card.column === "todo" && !explicitBlockStatus ? await listPickupAreaPeers(node, cfg, card) : [];
  return applyPickupAreaDerivation(card, areaPeers, explicitBlockStatus);
}

// ── Structured card fields: enums, normalizers, eligibility, backfill ───────
// (fbrain design `fkanban-card-structured-fields`.) These promote the signals a
// fresh agent needs to decide "what do I pick up?" out of body prose into real
// fields. Enum fields are stored as plain strings and normalized on use so a
// stale/legacy/empty value degrades to the safe default instead of throwing.

export const CARD_KINDS = ["pr", "registry", "tracker", "umbrella", "meta", "program", "capstone", "validation"] as const;
export type CardKind = (typeof CARD_KINDS)[number];
export const META_CARD_KINDS = ["registry", "tracker", "umbrella", "meta", "program", "capstone", "validation"] as const;
export type MetaCardKind = (typeof META_CARD_KINDS)[number];

export const BLOCK_STATUSES = ["none", "needs_human", "design_first", "deferred"] as const;
export type BlockStatus = (typeof BLOCK_STATUSES)[number];

export function isCardKind(s: string): s is CardKind {
  return (CARD_KINDS as readonly string[]).includes(s);
}

export function isBlockStatus(s: string): s is BlockStatus {
  return (BLOCK_STATUSES as readonly string[]).includes(s);
}

export function isMetaCardKind(kind: string): kind is MetaCardKind {
  return (META_CARD_KINDS as readonly string[]).includes(normalizeKind(kind));
}

// Empty/unknown kind → "pr" (the default flow). Backfill sets "registry"
// explicitly for fbrain-record cards; until then isPickupEligible also guards
// with isRegistryCard as a belt-and-suspenders for un-migrated cards.
export function normalizeKind(s: string): CardKind {
  return isCardKind(s) ? s : "pr";
}

// Empty/unknown block_status → "none" (not held).
export function normalizeBlockStatus(s: string): BlockStatus {
  return isBlockStatus(s) ? s : "none";
}

export const OWNER_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// Read a `Name: value` header from a card body, used to backfill the structured
// fields from the legacy body-header convention. All callers (repo/base/
// north_star) carry SINGLE-TOKEN values (an owner/name, a branch, a slug), so
// capture the first non-whitespace run after the colon — never the rest of the
// line. This is deliberately strict: some card bodies run the headers together
// on one physical line ("Repo: o/n   Base: main   Branch: x") or store them with
// escaped newlines, and a greedy `(.+)$` capture swallowed the following headers
// into the value (observed corrupting a backfill of existing cards). A trailing
// inline `# ...` comment is stripped before the token is read.
export function parseBodyHeader(body: string, name: string): string {
  const re = new RegExp(`^[ \\t]*${name}:[ \\t]*(.*)$`, "i");
  let m: RegExpMatchArray | null = null;
  let inFence = false;
  for (const line of body.split("\n")) {
    if (/^[ \t]*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    m = line.match(re);
    if (m) break;
  }
  if (!m) return "";
  // Cut at a literal escaped newline ("o/n\nBase:") for bodies stored that way,
  // remove an inline comment, then take the first token so space-joined headers
  // still don't bleed into one another.
  const line = stripTrailingInlineComment(m[1]!.split("\\n")[0]!);
  return line.match(/^(\S+)/)?.[1]?.trim() ?? "";
}

export const DB_LOCATOR_RE =
  /^lastdb:\/\/(?:personal|org\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?)(?:#[A-Za-z0-9_.\/-]+)?$/;

export function normalizeDbLocator(value: string | undefined): string {
  const locator = value?.trim() ?? "";
  return locator && DB_LOCATOR_RE.test(locator) ? locator : "";
}

export function dbLocatorProblem(value: string | undefined): string | null {
  const locator = value?.trim() ?? "";
  if (!locator) return null;
  return DB_LOCATOR_RE.test(locator)
    ? null
    : `DB locator must be lastdb://personal or lastdb://org/<slug>/<db>; got "${locator}".`;
}

export function writeBodyHeader(body: string, name: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return body;
  const re = new RegExp(`^[ \\t]*${name}:[^\\n]*(?:\\n|$)`, "im");
  if (re.test(body)) return body;
  return `${name}: ${trimmed}\n${body}`;
}

export function resolveCardDb(card: Pick<Card, "db" | "body">): string {
  return normalizeDbLocator(card.db) || normalizeDbLocator(parseBodyHeader(card.body, "Db"));
}

export function assertDbLocatorMatchesCard(
  card: Pick<Card, "slug" | "db" | "body">,
  ambientDbLocator: string | undefined,
  verb: string,
): void {
  const problem = dbLocatorProblem(ambientDbLocator);
  if (problem) {
    throw new FkanbanError({ code: "invalid_db_locator", message: problem });
  }
  const ambient = normalizeDbLocator(ambientDbLocator);
  if (!ambient) return;
  const home = resolveCardDb(card);
  if (!home || home === ambient) return;
  throw new FkanbanError({
    code: "db_locator_mismatch",
    message: `Card "${card.slug}" belongs to ${home}; refused ${verb} with ambient DB ${ambient}.`,
    hint: "Use the card's home DB locator, or use an explicit cross-DB operation once one exists.",
  });
}

export function applyDbLocatorForWrite(card: Card, ambientDbLocator: string | undefined, verb: string): void {
  assertDbLocatorMatchesCard(card, ambientDbLocator, verb);
  const home = resolveCardDb(card) || normalizeDbLocator(ambientDbLocator);
  if (!home) return;
  card.db = home;
  card.body = writeBodyHeader(card.body, "Db", home);
}

export function parseBodyListHeader(body: string, name: string): string[] {
  const re = new RegExp(`^[ \\t]*${name}:[ \\t]*(.*)$`, "i");
  let m: RegExpMatchArray | null = null;
  let inFence = false;
  for (const line of body.split("\n")) {
    if (/^[ \t]*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    m = line.match(re);
    if (m) break;
  }
  if (!m) return [];
  const line = stripTrailingInlineComment(m[1]!.split("\\n")[0]!);
  return normalizeSurfaces(line.split(","));
}

export function parseBodyTagsHeader(body: string): string[] {
  const re = /^[ \t]*Tags:[ \t]*(.*)$/im;
  const m = stripFencedCodeBlocks(body).match(re);
  if (!m) return [];
  const line = stripTrailingInlineComment(m[1]!.split("\\n")[0]!);
  return normalizeTags(line.split(/[,\s]+/));
}

export function writeBodyListHeader(body: string, name: string, values: string[]): string {
  const cleaned = normalizeSurfaces(values);
  const without = body.replace(new RegExp(`^[ \\t]*${name}:[^\\n]*(?:\\n|$)`, "gim"), "");
  if (cleaned.length === 0) return without.replace(/^\n+/, "");
  return `${name}: ${cleaned.join(", ")}\n${without}`.replace(/\n{3,}/, "\n\n");
}

export type PickupRepoResolution =
  | { ok: true; repo: string; source: "structured" | "body" }
  | { ok: false; reason: string };

export function resolvePickupRepo(card: Pick<Card, "repo" | "body">): PickupRepoResolution {
  const structured = stripTrailingInlineComment(card.repo);
  if (structured) {
    return OWNER_REPO_RE.test(structured)
      ? { ok: true, repo: structured, source: "structured" }
      : { ok: false, reason: `invalid structured repo: ${structured}` };
  }

  const fromBody = parseBodyHeader(card.body, "Repo");
  if (!fromBody) return { ok: false, reason: "missing Repo header" };
  return OWNER_REPO_RE.test(fromBody)
    ? { ok: true, repo: fromBody, source: "body" }
    : { ok: false, reason: `invalid Repo header: ${fromBody}` };
}

function rawBodyHeaderValue(body: string, name: string): string | null {
  const re = new RegExp(`^[ \\t]*${name}:[ \\t]*(.*)$`, "im");
  const m = body.match(re);
  return m ? m[1]!.trim() : null;
}

function strictBodyRepoProblem(body: string): string | null {
  const raw = rawBodyHeaderValue(body, "Repo");
  if (raw === null) return null;
  const clean = sanitizeRepoValue(raw);
  if (!clean) return "Repo header is empty or set to none.";
  if (raw !== clean) return "Repo header must be a bare owner/name token with no inline comments or extra text.";
  if (!OWNER_REPO_RE.test(clean)) return `Repo header must be owner/name; got "${clean}".`;
  return null;
}

function strictRepoProblem(card: Pick<Card, "repo" | "body">): string | null {
  const bodyProblem = strictBodyRepoProblem(card.body);
  if (bodyProblem) return bodyProblem;

  const structured = card.repo.trim();
  if (structured) {
    const clean = stripTrailingInlineComment(structured);
    if (structured !== clean) return "Repo field must be a bare owner/name token with no inline comments.";
    if (!OWNER_REPO_RE.test(clean)) return `Repo field must be owner/name; got "${clean}".`;
    return null;
  }

  if (rawBodyHeaderValue(card.body, "Repo") === null) return "Missing Repo header or --repo field.";
  return null;
}

function strictSingleTokenProblem(value: string, label: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return `Missing ${label} header or --${label.toLowerCase()} field.`;
  if (trimmed.includes("#") || /\s/.test(trimmed)) {
    return `${label} must be a single bare token with no inline comments or spaces.`;
  }
  return null;
}

function strictBaseProblem(card: Pick<Card, "base" | "body">): string | null {
  if (card.base.trim()) return strictSingleTokenProblem(card.base, "Base");
  const raw = rawBodyHeaderValue(card.body, "Base");
  if (raw === null) return "Missing Base header or --base field.";
  return strictSingleTokenProblem(raw, "Base");
}

/**
 * Default/todo is the **pickup claim lane**. In-flight PR/branch metadata and
 * unfinished deps must not live there — that stranded work for months
 * (agents filed `Branch: kanban/<slug>` or left `pr_url` after a partial claim,
 * and pickup classified the card as a collision so it was never claimed).
 *
 * Call after applying explicit structured fields. Mutates `card` in place.
 * Returns true when any field was cleared.
 */
export function sanitizeDefaultTodoLaneMetadata(card: Card): boolean {
  if (card.board !== DEFAULT_BOARD_SLUG || card.column !== "todo") return false;
  let changed = false;
  // Planned branch names belong in the body brief only until a PR is open AND
  // the card is in doing. Structured `branch` on todo blocks/collides pickup.
  if (card.branch.trim()) {
    card.branch = "";
    changed = true;
  }
  // An open PR on a *todo* card means requeue/incomplete reconcile — not a
  // claimable unit. Clear so the next pickup can own it (or watch can re-attach
  // after move to doing). Agents set pr_url after claiming into doing.
  if (card.pr_url.trim()) {
    card.pr_url = "";
    changed = true;
  }
  return changed;
}

export function assertDefaultTodoPickupReady(card: Card, force?: boolean, rawBody?: string): void {
  if (force) return;
  if (card.board !== DEFAULT_BOARD_SLUG || card.column !== "todo") return;

  // Defense in depth if a caller forgot sanitizeDefaultTodoLaneMetadata.
  sanitizeDefaultTodoLaneMetadata(card);

  const blockStatus = normalizeBlockStatus(card.block_status);
  const generatedPickupAreaHold =
    blockStatus === "needs_human" && card.block_reason.startsWith(PICKUP_AREA_BLOCK_PREFIX);
  if (blockStatus !== "none" && !generatedPickupAreaHold) {
    throw new FkanbanError({
      code: "default_todo_not_pickup_ready",
      message: `Card "${card.slug}" cannot be placed in default/todo with block_status=${blockStatus}.`,
      hint: "Default todo is the pickup lane. Move human-gated or deferred work to another board/column, clear the hold once runnable, or pass --force for an explicit operator override.",
    });
  }

  const kind = normalizeKind(card.kind);
  if (kind !== "pr") {
    throw new FkanbanError({
      code: "default_todo_not_pickup_ready",
      message: `Card "${card.slug}" cannot be placed in default/todo with non-pickup kind=${kind}.`,
      hint: "Use default/backlog or a parking board for tracker/program/capstone/validation work; split a concrete --kind pr card when code is ready, or pass --force.",
    });
  }
  // The registry/recipe classifier is a belt-and-suspenders FALLBACK for cards
  // whose `kind` field was never set (un-backfilled/legacy). An explicit kind is
  // authoritative and must win over keyword inference: a card filed with
  // `--kind pr` (raw `card.kind` is a real kind value) is never re-classified as
  // a registry card by body/title keywords — otherwise a legitimate PR card gets
  // the self-contradictory "non-pickup kind=pr" rejection. Note that by the time
  // this runs `deriveStructuredFields` has already stamped an empty-kind registry
  // card as kind="registry" (caught above), so this branch only fires for the
  // genuinely un-stamped empty-kind path.
  const kindExplicit = isCardKind(card.kind);
  if (!kindExplicit && isRegistryCard(card.body, card.title)) {
    throw new FkanbanError({
      code: "default_todo_not_pickup_ready",
      message: `Card "${card.slug}" cannot be placed in default/todo: it is classified as a registry/recipe card (targets an fbrain record, not a repo PR).`,
      hint: "Registry/recipe cards never enter the pickup flow. Use default/backlog or a parking board; if this really is a concrete code PR, file it with an explicit --kind pr, or pass --force.",
    });
  }

  const bodyForHeaderCheck = rawBody ?? card.body;
  const repoProblem = strictRepoProblem({ repo: card.repo, body: bodyForHeaderCheck });
  if (repoProblem) {
    throw new FkanbanError({
      code: "default_todo_not_pickup_ready",
      message: `Card "${card.slug}" is not pickup-ready: ${repoProblem}`,
      hint: "Set a clean standalone `Repo: owner/name` line or pass `--repo owner/name`; use another board/column for non-pickup work, or pass --force.",
    });
  }

  const baseProblem = strictBaseProblem({ base: card.base, body: bodyForHeaderCheck });
  if (baseProblem) {
    throw new FkanbanError({
      code: "default_todo_not_pickup_ready",
      message: `Card "${card.slug}" is not pickup-ready: ${baseProblem}`,
      hint: "Set a clean standalone `Base: branch` line or pass `--base branch`; use another board/column for non-pickup work, or pass --force.",
    });
  }
}

// The card-LOCAL half of "can a build agent pick this up?". Dependency
// satisfaction is NOT included here — it needs board context (depStatus); a
// caller ANDs this with `!depStatus(...).blocked`. Keeping the two separate
// mirrors how `move`'s soft-block and the pickup readiness check already split.
export function isPickupEligible(card: Card): boolean {
  return (
    normalizeKind(card.kind) === "pr" &&
    (isCardKind(card.kind) || !isRegistryCard(card.body, card.title)) && // fallback for un-backfilled cards
    resolvePickupRepo(card).ok &&
    card.base.trim().length > 0 &&
    normalizeBlockStatus(card.block_status) === "none"
  );
}

// Backfill the structured fields for a card from its legacy body/tags, WITHOUT
// overwriting a value already set. Reuses the #91 derivation (body `Repo:`/
// `Base:` headers, then the tag→repo map) plus the `North Star:` line and the
// registry-card classifier. Returns a partial of only the fields it filled, so
// callers can apply + report what changed. Pure.
export function deriveStructuredFields(card: Card): Partial<Card> {
  const out: Partial<Card> = {};

  // kind: classify registry/recipe cards so they never enter the pickup flow.
  // An explicit `--kind pr` is authoritative and suppresses the keyword-based
  // registry classification (both here and in the pickup gate) — a filer who
  // says "this is a PR card" is never overridden by a "dogfood-registry"/
  // "Target: fbrain record" keyword in the body, so its repo/base still derive.
  const explicitPr = card.kind === "pr";
  const registry = !explicitPr && isRegistryCard(card.body, card.title);
  if (!card.kind) out.kind = registry ? "registry" : "pr";

  // repo/base: registry cards target an fbrain record, not a repo — never give
  // them one (even if they carry a subsystem tag). For PR cards, an explicit
  // body header wins, else the unambiguous tag map; base defaults to main once
  // a repo is known.
  if (!registry) {
    if (!card.repo) {
      const fromHeader = parseBodyHeader(card.body, "Repo");
      out.repo = fromHeader || inferRepoFromTags(card.tags) || "";
    }
    if (!card.base) {
      const fromHeader = parseBodyHeader(card.body, "Base");
      const repo = out.repo ?? card.repo;
      out.base = fromHeader || (repo ? DEFAULT_BASE : "");
    }
  }
  // north_star: the `North Star:` body line.
  if (!card.north_star) {
    const ns = parseBodyHeader(card.body, "North Star");
    if (ns) out.north_star = ns;
  }
  if (card.surfaces.length === 0) {
    const surfaces = parseBodyListHeader(card.body, "Surfaces");
    if (surfaces.length > 0) out.surfaces = surfaces;
  }
  if (!card.branch) {
    const branch = parseBodyHeader(card.body, "Branch");
    if (branch) out.branch = branch;
  }
  if (!card.db) {
    const db = normalizeDbLocator(parseBodyHeader(card.body, "Db"));
    if (db) out.db = db;
  }
  return out;
}

export type StructuredFieldRepairOptions = {
  repo?: boolean;
  base?: boolean;
  kind?: boolean;
  northStar?: boolean;
  branch?: boolean;
  surfaces?: boolean;
  db?: boolean;
};

// Write-time body→field repair. `deriveStructuredFields` is intentionally
// conservative for read-time legacy backfill and never overwrites an existing
// value; this mutating helper is used only on explicit card writes, where a
// clear body header is the operator's current source of truth unless the same
// write passed the matching structured CLI flag.
export function repairStructuredFieldsFromBody(
  card: Card,
  explicit: StructuredFieldRepairOptions = {},
): Card {
  Object.assign(card, deriveStructuredFields(card));

  if (!explicit.repo) {
    const repo = parseBodyHeader(card.body, "Repo");
    if (repo) card.repo = repo;
  }
  if (!explicit.base) {
    const base = parseBodyHeader(card.body, "Base");
    if (base) card.base = base;
  }
  if (!explicit.kind) {
    const kind = parseBodyHeader(card.body, "Kind").toLowerCase();
    if (isCardKind(kind)) card.kind = kind;
  }
  if (!explicit.northStar) {
    const northStar = parseBodyHeader(card.body, "North Star");
    if (northStar) card.north_star = northStar;
  }
  if (!explicit.branch) {
    const branch = parseBodyHeader(card.body, "Branch");
    if (branch) card.branch = branch;
  }
  if (!explicit.surfaces) {
    const surfaces = parseBodyListHeader(card.body, "Surfaces");
    if (surfaces.length > 0) card.surfaces = surfaces;
  }
  if (!explicit.db) {
    const db = normalizeDbLocator(parseBodyHeader(card.body, "Db"));
    if (db) card.db = db;
  }
  return card;
}

// Fields that default empty on fresh/test Card literals.
export function emptyStructuredFields(): Pick<
  Card,
  "done_at" | "db" | "repo" | "base" | "kind" | "block_status" | "block_reason" | "north_star" | "milestone" | "pr_url" | "branch" | "surfaces"
> {
  return {
    done_at: "",
    db: "",
    repo: "",
    base: "",
    kind: "",
    block_status: "",
    block_reason: "",
    north_star: "",
    milestone: "",
    pr_url: "",
    branch: "",
    surfaces: [],
  };
}

export type DepStatus = {
  // Existing dep cards not yet in their board's terminal column — these block
  // this card.
  blockedBy: string[];
  // Dep slugs with no live card (legacy dangling data). These block because
  // they can never reach the terminal column until the edge is repaired.
  missing: string[];
  blocked: boolean;
};

// Fallback terminal column used when a dep's board can't be resolved (deleted
// board, forward reference, or no board map supplied): the historical literal
// `done`, so nothing regresses when the board context is unavailable.
export const FALLBACK_TERMINAL_COLUMN = "done";

// Map of board slug → that board's terminal column. Columns are fixed
// (backlog → todo → doing → done), so every board's terminal is `done`.
// Built once per command from `listBoards` for callers that still key by board.
export function boardTerminalMap(boards: Board[]): Map<string, string> {
  const m = new Map<string, string>();
  const terminal = terminalColumn(fixedColumns());
  for (const b of boards) {
    m.set(b.slug, terminal);
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
// default-named working column (doing/done) OR that is `boardSlug`'s own
// terminal column — so on a custom board (e.g. `spec,build,ship`) a blocked card
// can't be *completed* into its terminal column (`ship`) without --force, even
// though that board has none of the default working columns. The default board's
// terminal column is `done`, which is already in WORKING_COLUMNS, so the gating
// set is unchanged there.
//
// Default/`todo` is intentionally not gated: grooming may surface dependency
// state there, but the hard block starts when work enters `doing` or terminal.
//
// This intentionally does NOT gate intermediate custom columns (e.g. `spec →
// build`) — that needs board-level intake metadata that doesn't exist yet.
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
      blockedBy.push(dep);
    } else if (isMetaCardKind(d.kind)) {
      continue;
    } else if (d.column !== terminalColumnFor(d.board, boardTerminal)) {
      blockedBy.push(dep);
    }
  }
  return { blockedBy, missing, blocked: blockedBy.length > 0 };
}

export async function assertDepUnblocked(
  node: NodeClient,
  cfg: Config,
  card: Card,
  force?: boolean,
): Promise<void> {
  if (force) return;
  const boardTerminal = boardTerminalMap(await listBoards(node, cfg));
  if (!isDepEnforcedColumn(card.column, card.board, boardTerminal)) return;
  const status = depStatus(
    card,
    await listDependencyStatusesForCards(node, cfg, [card]),
    boardTerminal,
  );
  if (status.blocked) {
    throw new FkanbanError({
      code: "card_blocked",
      message: blockedByMessage(card.slug, status.blockedBy),
      hint: blockedByHint(),
    });
  }
}

export async function writeCardPatch(
  opts: { cfg: Config; node: NodeClient },
  card: Card,
  patch: Partial<Card>,
): Promise<void> {
  const updated: Card = { ...card, ...patch, updated_at: nowIso() };
  await updateCardRecord(opts, updated, undefined, card);
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

// Case-insensitive substring search over a card's user-facing content and
// structured dependency slugs. Multi-word queries are AND-matched: every whitespace-separated term
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
  const hay = [card.slug, card.title, card.body, card.assignee, ...card.tags, ...card.deps]
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
  const body = stringField(f, "body");
  const structuredSurfaces = normalizeSurfaces(arrayStringField(f, "surfaces"));
  const allTags = arrayStringField(f, "tags");
  const legacyTagDeps = allTags
    .filter(isDepTag)
    .map((t) => t.slice(DEP_TAG_PREFIX.length))
    .filter((s) => s.length > 0);
  const deps = arrayStringField(f, "deps");
  const slug = stringField(f, "slug");
  const doneAt =
    allTags
      .find(isDoneAtTag)
      ?.slice(DONE_AT_TAG_PREFIX.length) ?? "";
  return {
    slug,
    title: stringField(f, "title"),
    body,
    board: stringField(f, "board"),
    column: stringField(f, "column"),
    position: stringField(f, "position"),
    assignee: stringField(f, "assignee"),
    // Legacy dep tags are migrated into `deps`; everything else stays.
    tags: allTags.filter((t) => !isDepTag(t) && !isDoneAtTag(t)),
    deps: normalizeDeps([...deps, ...legacyTagDeps], slug),
    surfaces: structuredSurfaces.length > 0 ? structuredSurfaces : parseBodyListHeader(body, "Surfaces"),
    created_at: stringField(f, "created_at"),
    created_by:
      stringField(f, "created_by") ||
      parseBodyHeader(body, "Created By") ||
      UNKNOWN_CREATED_BY,
    updated_at: stringField(f, "updated_at"),
    done_at: doneAt,
    // New fields default to "" for cards written before the schema gained them.
    db: stringField(f, "db") || normalizeDbLocator(parseBodyHeader(body, "Db")),
    repo: stringField(f, "repo"),
    base: stringField(f, "base"),
    kind: stringField(f, "kind"),
    block_status: stringField(f, "block_status"),
    block_reason: stringField(f, "block_reason"),
    north_star: stringField(f, "north_star"),
    milestone: stringField(f, "milestone"),
    pr_url: stringField(f, "pr_url"),
    branch: stringField(f, "branch"),
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

export function rowToMilestone(row: QueryRow): Milestone {
  const f = (row.fields ?? {}) as Record<string, unknown>;
  return {
    slug: stringField(f, "slug"),
    title: stringField(f, "title"),
    body: stringField(f, "body"),
    board: stringField(f, "board") || DEFAULT_BOARD_SLUG,
    state: stringField(f, "state") || "planned",
    position: stringField(f, "position"),
    north_star: stringField(f, "north_star"),
    driver: stringField(f, "driver"),
    deps: arrayStringField(f, "deps"),
    proof_card: stringField(f, "proof_card"),
    proof_status: stringField(f, "proof_status") || "pending",
    block_reason: stringField(f, "block_reason"),
    created_at: stringField(f, "created_at"),
    updated_at: stringField(f, "updated_at"),
    completed_at: stringField(f, "completed_at"),
  };
}

// Shared body of the three card list paths below: query the card schema for the
// given field subset, map rows to Cards, and drop legacy tag-tombstoned cards.
// Native deletes are hidden by the node before this point.
async function listCardsWithFields(
  node: NodeClient,
  cfg: Config,
  fields: string[],
  filter?: QueryFilter,
  opts: { allowFullScanFallback?: boolean } = {},
): Promise<Card[]> {
  // Prefer BoardCards HashRange partitions (hash=board) — Dynamo-style list.
  // Never hydrate body for board-wide lists (that was the N+1 storm). Callers
  // that need body must findCard/show by slug.
  // HashKey filters still go to the Card schema (point reads).
  if (filter === undefined) {
    // BoardCards first: one partition query per board, thin projection.
    try {
      const boards = await listBoards(node, cfg);
      const partitioned = await listAllBoardCards(node, cfg, boards);
      if (partitioned !== null && partitioned.length > 0) {
        // BoardCards rows are already body-free; promote any structured fields.
        return partitioned
          .filter((c) => !isHiddenCard(c))
          .map((c) => Object.assign(c, deriveStructuredFields(c)));
      }
      // Empty partition may mean "no cards" OR "not dual-written yet".
      // Fall through to CardListIndex when partitions are empty so dual-read
      // still sees legacy boards until backfill.
      if (partitioned !== null && partitioned.length === 0) {
        const indexedEmpty = await readCardListIndex(node, cfg);
        if (indexedEmpty !== null && indexedEmpty.length === 0) {
          return [];
        }
        // indexed has data but BoardCards empty → legacy path below
      }
    } catch {
      // fall through
    }

    const indexed = await readCardListIndex(node, cfg);
    if (indexed !== null) {
      // CardListIndex is body-free by construction — never N+1 hydrate.
      return (indexed.filter((c) => !isHiddenCard(c as Card)) as Card[]).map((c) =>
        Object.assign({ ...c, body: "" }, deriveStructuredFields(c as Card)),
      );
    }
    if (opts.allowFullScanFallback === false) {
      return [];
    }
    // Index missing: one admin full scan seeds indexes (keeps body for this
    // rare path only — still not N+1). Prefer BoardCards after dual-write.
    const hash = schemaHashFor("card", cfg);
    let res;
    try {
      res = await node.queryAll({ schemaHash: hash, fields, allowFullScan: true });
    } catch (err) {
      if (!isOnlyOptionalFieldMiss(err, fields)) throw err;
      res = await node.queryAll({
        schemaHash: hash,
        fields: fields.filter((field) => !(CARD_OPTIONAL_SCHEMA_FIELDS as readonly string[]).includes(field)),
        allowFullScan: true,
      });
    }
    const cards = res.results.map(rowToCard).filter((c) => !isHiddenCard(c));
    try {
      await writeCardListIndex(node, cfg, cards.map(toCardSummary));
    } catch {
      // best-effort seed; list still returns
    }
    try {
      for (const c of cards) await upsertBoardCard(node, cfg, c);
    } catch {
      // best-effort BoardCards seed
    }
    return cards;
  }

  const hash = schemaHashFor("card", cfg);
  const query = (queryFields: string[]) =>
    node.queryAll({ schemaHash: hash, fields: queryFields, filter });
  let res;
  try {
    res = await query(fields);
  } catch (err) {
    if (!isOnlyOptionalFieldMiss(err, fields)) throw err;
    res = await query(fields.filter((field) => !(CARD_OPTIONAL_SCHEMA_FIELDS as readonly string[]).includes(field)));
  }
  return res.results.map(rowToCard).filter((c) => !isHiddenCard(c));
}

function isOnlyOptionalFieldMiss(err: unknown, fields: string[]): boolean {
  return (
    err instanceof FkanbanError &&
    err.code === "unknown_fields" &&
    fields.some((field) => (CARD_OPTIONAL_SCHEMA_FIELDS as readonly string[]).includes(field)) &&
    (CARD_OPTIONAL_SCHEMA_FIELDS as readonly string[]).some((field) => err.message.includes(field))
  );
}

// The node's /api/query `filter` is a fold_db HashRangeFilter (HashKey /
// range-key shapes only) — field-equality filters like `{column: "todo"}` are
// NOT a node capability and 400 on every call. All field filtering therefore
// happens CLIENT-SIDE. Before 2026-07-17 each filtered list sent the doomed
// filter anyway and only then fell back (one guaranteed 400 per list; ~21
// node queries per `list --column todo`; rows=1 Card point-read storms were
// the primary node's top load). Only `{HashKey: slug}` remains a real
// server-side filter (point reads).
function withRequiredFields(fields: string[], required: string[]): string[] {
  const missing = required.filter((f) => !fields.includes(f));
  return missing.length === 0 ? fields : [...fields, ...missing];
}

// Client-side field-equality list over BoardCards / index (no body N+1).
// Body is never board-wide hydrated — use findCard for full specs.
async function listCardsClientFiltered(
  node: NodeClient,
  cfg: Config,
  fields: string[],
  predicate: Record<string, string>,
  opts: { allowFullScanFallback?: boolean } = {},
): Promise<Card[]> {
  const required = Object.keys(predicate);
  const matches = (c: Card): boolean =>
    required.every((field) => {
      const actual = (c as unknown as Record<string, unknown>)[field];
      return typeof actual === "string" && actual === predicate[field];
    });
  // Prefer column-only path via full list then filter (partition already thin).
  const cards = await listCardsWithFields(
    node,
    cfg,
    withRequiredFields(
      fields.includes("body") ? fields.filter((f) => f !== "body") : fields,
      required,
    ),
    undefined,
    opts,
  );
  return cards.filter(matches);
}

export async function listCards(node: NodeClient, cfg: Config): Promise<Card[]> {
  // Thin board list — no bodies (BoardCards / index). Use findCard for one body,
  // or listCardsWithBodiesForSearch for complete-body search (one admin scan).
  return listCardsWithFields(node, cfg, fieldsFor("card"));
}

/**
 * Complete-body card set for free-text search only: ONE admin full-scan of Card
 * (allowFullScan), not N point-gets. Prefer native index / thin list for hot paths.
 */
export async function listCardsWithBodiesForSearch(
  node: NodeClient,
  cfg: Config,
): Promise<Card[]> {
  const hash = schemaHashFor("card", cfg);
  let res;
  try {
    res = await node.queryAll({
      schemaHash: hash,
      fields: fieldsFor("card"),
      allowFullScan: true,
    });
  } catch (err) {
    if (!isOnlyOptionalFieldMiss(err, fieldsFor("card"))) throw err;
    res = await node.queryAll({
      schemaHash: hash,
      fields: fieldsFor("card").filter(
        (field) => !(CARD_OPTIONAL_SCHEMA_FIELDS as readonly string[]).includes(field),
      ),
      allowFullScan: true,
    });
  }
  return res.results.map(rowToCard).filter((c) => !isHiddenCard(c));
}

type PickupPeerPlan = { action: "ready"; card: Card } | { action: "hydrate"; card: Card } | { action: "skip" };

function bodyFreeDerivedCard(card: Card): Card {
  const summary = { ...card, body: "" };
  Object.assign(summary, deriveStructuredFields(summary));
  return summary;
}

function pickupPeerOverlaps(card: Card, targetRepo: string, targetAreas: Set<string>): boolean {
  if (!PICKUP_AREA_ACTIVE_COLUMN_SET.has(card.column)) return false;
  if (normalizeKind(card.kind) !== "pr" || normalizeBlockStatus(card.block_status) !== "none") return false;
  if (pickupRepo(card) !== targetRepo) return false;
  return pickupAreaTagsForCard(card).some((area) => targetAreas.has(area));
}

function summarizePickupPeer(card: Card, targetRepo: string, targetAreas: Set<string>): PickupPeerPlan {
  if (!PICKUP_AREA_ACTIVE_COLUMN_SET.has(card.column)) return { action: "skip" };
  const summary = bodyFreeDerivedCard(card);
  if (normalizeKind(summary.kind) !== "pr" || normalizeBlockStatus(summary.block_status) !== "none") return { action: "skip" };

  const repo = summary.repo.trim();
  if (repo.length > 0 && repo !== targetRepo) return { action: "skip" };

  if (repo.length > 0 && pickupAreaTagsForCard(summary).some((area) => targetAreas.has(area))) {
    return { action: "ready", card: summary };
  }

  return { action: "hydrate", card: summary };
}

async function hydratePickupPeer(node: NodeClient, cfg: Config, card: Card): Promise<Card | null> {
  if (card.body.length > 0) return card;
  return findCardWithFields(node, cfg, card.slug, [...PICKUP_AREA_PEER_BODY_FIELDS]);
}

async function filterPickupAreaPeers(
  node: NodeClient,
  cfg: Config,
  cards: Card[],
  targetRepo: string,
  targetAreas: Set<string>,
): Promise<Card[]> {
  const out: Card[] = [];
  const seen = new Set<string>();
  for (const card of cards) {
    if (seen.has(card.slug)) continue;
    seen.add(card.slug);
    const plan = summarizePickupPeer(card, targetRepo, targetAreas);
    if (plan.action === "skip") continue;
    if (plan.action === "ready") {
      out.push(plan.card);
      continue;
    }
    const peer = await hydratePickupPeer(node, cfg, plan.card);
    if (!peer) continue;
    Object.assign(peer, deriveStructuredFields(peer));
    if (pickupPeerOverlaps(peer, targetRepo, targetAreas)) out.push(peer);
  }
  return out;
}

export async function listPickupAreaPeers(node: NodeClient, cfg: Config, card: Card): Promise<Card[]> {
  const targetRepo = pickupRepo(card);
  const targetAreas = new Set(pickupAreaTagsForCard(card));
  if (!targetRepo || targetAreas.size === 0) return [];

  // One bulk read; the previous per-column filtered reads sent the node an
  // unsupported field filter (three 400s per `add --column todo`) and then
  // disabled this advisory feature entirely on the live node.
  const fields = withRequiredFields([...PICKUP_AREA_PEER_FIELDS], ["column"]);
  const summaries = (await listCardsWithFields(node, cfg, fields)).filter((c) =>
    PICKUP_AREA_ACTIVE_COLUMN_SET.has(c.column),
  );
  return filterPickupAreaPeers(node, cfg, summaries, targetRepo, targetAreas);
}

/**
 * Cards in one column. Prefer BoardCards HashRangePrefix on a single board
 * (one keyed query). Without board, falls back to full thin list + client filter
 * (legacy multi-board column scan — avoid on the hot list path).
 */
export async function listCardsByColumn(
  node: NodeClient,
  cfg: Config,
  column: string,
  fields: string[],
  board?: string,
): Promise<Card[]> {
  if (board) {
    try {
      const part = await listBoardCardsPartition(node, cfg, board, { column });
      if (part !== null) {
        const reconciled = await reconcileBoardCardSummaries(node, cfg, part, fields);
        return reconciled
          .filter((c) => !isHiddenCard(c))
          .map((c) => Object.assign(c, deriveStructuredFields(c)));
      }
    } catch {
      // fall through
    }
  }
  return listCardsClientFiltered(node, cfg, fields, {
    column,
    ...(board ? { board } : {}),
  });
}

/**
 * Thin cards on one board only (one BoardCards partition — no empty-board fan-out).
 * `fields` is used only on the legacy CardListIndex / Card fallback path.
 */
export async function listCardsOnBoard(
  node: NodeClient,
  cfg: Config,
  board: string,
  fields: string[] = fieldsFor("card"),
): Promise<Card[]> {
  try {
    const part = await listBoardCardsPartition(node, cfg, board);
    if (part !== null && part.length > 0) {
      const reconciled = await reconcileBoardCardSummaries(node, cfg, part, fields);
      return reconciled
        .filter((c) => !isHiddenCard(c))
        .map((c) => Object.assign(c, deriveStructuredFields(c)));
    }
    if (part !== null && part.length === 0) {
      // Empty board vs not dual-written: check index for this board only.
      const indexed = await readCardListIndex(node, cfg);
      if (indexed !== null) {
        return (indexed.filter((c) => !isHiddenCard(c as Card) && c.board === board) as Card[]).map(
          (c) => Object.assign({ ...c, body: "" }, deriveStructuredFields(c as Card)),
        );
      }
      return [];
    }
  } catch {
    // fall through
  }
  // No BoardCards schema / query failed: field-projected multi-board list, filter client-side.
  const all = await listCardsWithFields(node, cfg, fields);
  return all.filter((c) => c.board === board);
}

export async function listCardsByFilter(
  node: NodeClient,
  cfg: Config,
  filter: QueryFilter,
  fields: string[],
  opts: { allowFullScanFallback?: boolean } = {},
): Promise<{ cards: Card[]; indexed: boolean }> {
  const entries = Object.entries(filter).filter(([, value]) => value.length > 0);
  if (entries.length === 0) {
    return { cards: await listCardsWithFields(node, cfg, fields, undefined, opts), indexed: false };
  }
  return {
    cards: await listCardsClientFiltered(node, cfg, fields, Object.fromEntries(entries), opts),
    indexed: false,
  };
}

export async function listBoards(node: NodeClient, cfg: Config): Promise<Board[]> {
  const live = (boards: Board[]) =>
    boards.filter((b) => !isTombstoned(b.columns) && b.slug.length > 0);

  const indexed = await readBoardListIndex(node, cfg);
  if (indexed !== null) {
    return live(
      indexed.map((b) => ({
        slug: b.slug,
        title: b.title,
        body: b.body,
        columns: b.columns,
        created_at: b.created_at,
        updated_at: b.updated_at,
      })),
    );
  }

  // Seed once via admin full scan when index not declared/seeded yet.
  const hash = schemaHashFor("board", cfg);
  const res = await node.queryAll({
    schemaHash: hash,
    fields: fieldsFor("board"),
    allowFullScan: true,
  });
  const boards = live(res.results.map(rowToBoard));
  try {
    await writeBoardListIndex(
      node,
      cfg,
      boards.map((b) => ({
        slug: b.slug,
        title: b.title,
        body: b.body,
        columns: b.columns,
        created_at: b.created_at,
        updated_at: b.updated_at,
      })),
    );
  } catch {
    // best-effort
  }
  return boards;
}

// Fields sufficient to resolve dependency status / card existence — everything
// except the heavy spec `body` (and other display-only fields). Used by the
// read paths that fan out over the whole board so they don't re-download every
// card's multi-paragraph body.
export const CARD_STATUS_FIELDS = ["slug", "board", "column", "position", "tags", "deps", "kind", "created_at"];

// Like listCards but fetches only CARD_STATUS_FIELDS; absent fields come back
// as "" on the Card. Enough for depStatus / blockedSlugSet / existence checks.
export async function listCardStatuses(node: NodeClient, cfg: Config): Promise<Card[]> {
  return listCardsWithFields(node, cfg, CARD_STATUS_FIELDS);
}

async function findCardWithFields(
  node: NodeClient,
  cfg: Config,
  slug: string,
  fields: string[],
): Promise<Card | null> {
  const cards = await listCardsWithFields(node, cfg, fields, { HashKey: slug });
  const card = cards.find((c) => c.slug === slug);
  return card ?? null;
}

export async function listDependencyStatusesForCards(
  node: NodeClient,
  cfg: Config,
  cards: Card[],
): Promise<Card[]> {
  const bySlug = new Map<string, Card>();
  for (const card of cards) bySlug.set(card.slug, card);

  const depSlugs = [...new Set(cards.flatMap((c) => c.deps))].filter((slug) => !bySlug.has(slug));
  const deps = await Promise.all(depSlugs.map((slug) => findCardWithFields(node, cfg, slug, CARD_STATUS_FIELDS)));
  for (const dep of deps) {
    if (dep) bySlug.set(dep.slug, dep);
  }
  return [...bySlug.values()];
}

// Fields the TEXT board render (`renderBoard`) + its filters actually display:
// everything in CARD_STATUS_FIELDS plus the human-visible `title` and the
// `assignee` filter target. Crucially this OMITS the heavy multi-paragraph
// `body`, which the text list path never renders — so a one-screen `fkanban list`
// no longer drags every card's full spec over the wire (the first thing to time
// out when the node is busy). `--json`/`--wide`/`search`/MCP still use the
// full-body `listCards` because they genuinely surface structured/body fields.
export const CARD_DISPLAY_FIELDS = ["slug", "title", "board", "column", "position", "tags", "deps", "surfaces", "assignee", "kind", "created_at", "created_by"];

// Like listCards but fetches only CARD_DISPLAY_FIELDS (body-free); absent fields
// (notably `body`) come back as "" on the Card. Enough for the text board render,
// the board/column/tag/assignee filters, and the dep/blocked fan-out — but NOT
// for any path that must show a card's body. Mirrors listCardStatuses.
export async function listCardsForDisplay(node: NodeClient, cfg: Config): Promise<Card[]> {
  return listCardsWithFields(node, cfg, CARD_DISPLAY_FIELDS);
}

// Point read by slug — the node resolves a HashKey filter as an indexed key
// lookup, so this never scans the board.
export async function findCard(node: NodeClient, cfg: Config, slug: string): Promise<Card | null> {
  return findCardWithFields(node, cfg, slug, fieldsFor("card"));
}

function cardListProjectionFields(fields: string[]): string[] {
  const bodyFree = fields.filter((field) => field !== "body");
  return withRequiredFields(bodyFree, [
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
    "repo",
    "base",
    "kind",
    "block_status",
    "block_reason",
    "north_star",
    "milestone",
    "pr_url",
    "branch",
  ]);
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function boardCardSummaryMatchesTruth(summary: Card, truth: Card): boolean {
  return (
    summary.slug === truth.slug &&
    summary.title === truth.title &&
    (summary.board || DEFAULT_BOARD_SLUG) === (truth.board || DEFAULT_BOARD_SLUG) &&
    summary.column === truth.column &&
    String(summary.position) === String(truth.position) &&
    summary.assignee === truth.assignee &&
    arraysEqual(summary.tags, truth.tags) &&
    arraysEqual(summary.deps, truth.deps) &&
    arraysEqual(summary.surfaces, truth.surfaces) &&
    summary.created_at === truth.created_at &&
    (summary.created_by || UNKNOWN_CREATED_BY) === (truth.created_by || UNKNOWN_CREATED_BY) &&
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

async function reconcileBoardCardSummaries(
  node: NodeClient,
  cfg: Config,
  cards: Card[],
  fields: string[],
): Promise<Card[]> {
  const projection = cardListProjectionFields(fields);
  const out: Card[] = [];
  const seen = new Set<string>();

  for (const card of cards) {
    if (seen.has(card.slug)) continue;
    seen.add(card.slug);
    const truth = await findCardWithFields(node, cfg, card.slug, projection);
    if (!truth) {
      try {
        await removeBoardCard(node, cfg, card);
      } catch {
        // best-effort read repair; omit the stale row either way
      }
      continue;
    }

    Object.assign(truth, deriveStructuredFields(truth));
    if (!boardCardSummaryMatchesTruth(card, truth)) {
      try {
        await upsertBoardCard(node, cfg, truth, card);
      } catch {
        // best-effort read repair; still return point-read truth
      }
    }
    out.push(truth);
  }

  return out;
}

/** Point-get bodies for a small capped set (MCP preview / list --full-body). */
export async function hydrateCardBodies(
  node: NodeClient,
  cfg: Config,
  cards: Card[],
): Promise<Card[]> {
  return Promise.all(
    cards.map(async (c) => {
      if (c.body.length > 0) return c;
      const full = await findCard(node, cfg, c.slug);
      return full ? { ...c, body: full.body } : c;
    }),
  );
}

// Resolve a card by slug, throwing the canonical `card_not_found` error when
// it doesn't exist (or is tombstoned). Shared by the card-editing commands
// (move, rm, tag, dep, show) so the message stays identical in one place —
// the card mirror of `requireBoard`.
export async function requireCard(node: NodeClient, cfg: Config, slug: string): Promise<Card> {
  const card = await findCard(node, cfg, slug);
  if (!card) {
    throw new FkanbanError({ code: "card_not_found", message: `No card with slug "${slug}".` });
  }
  return card;
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

function boardCreateHint(slug: string): string {
  return `Create it first: \`fkanban board create ${slug} --columns ${DEFAULT_COLUMNS.join(",")}\`.`;
}

function seededBoard(slug: string): Board {
  const now = nowIso();
  return {
    slug,
    title: slug === DEFAULT_BOARD_SLUG ? "Default board" : slug,
    body: "",
    columns: [...DEFAULT_COLUMNS],
    created_at: now,
    updated_at: now,
  };
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
      hint: boardCreateHint(slug),
    });
  }
  return board;
}

// Write paths can recover a missing board record when live cards still point at
// that board: the cards prove the board slug is real user state, so recreate the
// board metadata with default columns instead of stranding add/move.
export async function ensureBoardRecord(node: NodeClient, cfg: Config, slug: string): Promise<Board> {
  const board = await findBoard(node, cfg, slug);
  if (board) return board;

  const referenced = (await listCardStatuses(node, cfg)).some((c) => c.board === slug);
  if (!referenced) {
    throw new FkanbanError({
      code: "board_not_found",
      message: `Board "${slug}" does not exist.`,
      hint: boardCreateHint(slug),
    });
  }

  const healed = seededBoard(slug);
  await node.createRecord({
    schemaHash: schemaHashFor("board", cfg),
    fields: boardToFields(healed),
    keyHash: healed.slug,
  });
  return healed;
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
    tags: [
      ...c.tags.filter((t) => !isDepTag(t) && !isDoneAtTag(t)),
      ...(c.done_at ? [doneAtTag(c.done_at)] : []),
    ],
    deps: normalizeDeps(c.deps, c.slug),
    surfaces: normalizeSurfaces(c.surfaces ?? []),
    created_at: c.created_at,
    created_by: c.created_by ?? UNKNOWN_CREATED_BY,
    updated_at: c.updated_at,
    db: c.db ?? "",
    repo: c.repo ?? "",
    base: c.base ?? "",
    kind: c.kind ?? "",
    block_status: c.block_status ?? "",
    block_reason: c.block_reason ?? "",
    north_star: c.north_star ?? "",
    milestone: c.milestone ?? "",
    pr_url: c.pr_url ?? "",
    branch: c.branch ?? "",
  };
}

export function milestoneToFields(m: Milestone): Record<string, unknown> {
  return {
    slug: m.slug,
    title: m.title,
    body: m.body,
    board: m.board,
    state: m.state,
    position: m.position,
    north_star: m.north_star,
    driver: m.driver,
    deps: normalizeDeps(m.deps, m.slug),
    proof_card: m.proof_card,
    proof_status: m.proof_status,
    block_reason: m.block_reason,
    created_at: m.created_at,
    updated_at: m.updated_at,
    completed_at: m.completed_at,
  };
}

export async function listMilestones(node: NodeClient, cfg: Config): Promise<Milestone[]> {
  const res = await node.queryAll({
    schemaHash: schemaHashFor("milestone", cfg),
    fields: fieldsFor("milestone"),
    allowFullScan: true,
  });
  return res.results
    .map(rowToMilestone)
    .sort((a, b) => Number(a.position || 0) - Number(b.position || 0) || a.slug.localeCompare(b.slug));
}

export async function findMilestone(node: NodeClient, cfg: Config, slug: string): Promise<Milestone | null> {
  const res = await node.queryAll({
    schemaHash: schemaHashFor("milestone", cfg),
    fields: fieldsFor("milestone"),
    filter: { HashKey: slug },
  });
  return res.results[0] ? rowToMilestone(res.results[0]) : null;
}

export async function requireMilestone(node: NodeClient, cfg: Config, slug: string): Promise<Milestone> {
  const milestone = await findMilestone(node, cfg, slug);
  if (!milestone) {
    throw new FkanbanError({
      code: "milestone_not_found",
      message: `Milestone "${slug}" not found.`,
      hint: "Run `fkanban milestone list` to see milestones.",
    });
  }
  return milestone;
}

export async function upsertMilestoneRecord(
  node: NodeClient,
  cfg: Config,
  milestone: Milestone,
  exists: boolean,
): Promise<void> {
  await node[exists ? "updateRecord" : "createRecord"]({
    schemaHash: schemaHashFor("milestone", cfg),
    keyHash: milestone.slug,
    fields: milestoneToFields(milestone),
  });
}

function cardToLegacyOptionalFields(c: Card): Record<string, unknown> {
  const fields = cardToFields({
    ...c,
    body: writeBodyHeader(
      writeBodyHeader(writeBodyListHeader(c.body, "Surfaces", c.surfaces ?? []), "Db", c.db ?? ""),
      "Created By",
      c.created_by ?? UNKNOWN_CREATED_BY,
    ),
  });
  for (const field of CARD_OPTIONAL_SCHEMA_FIELDS) delete fields[field];
  return fields;
}

function isOptionalFieldWriteMiss(err: unknown): boolean {
  return err instanceof FkanbanError &&
    err.code === "unknown_fields" &&
    (CARD_OPTIONAL_SCHEMA_FIELDS as readonly string[]).some((field) => err.message.includes(field));
}

type CardWriteOp = "createRecord" | "updateRecord";

async function writeCardRecordWithOptionalFieldFallback(
  opts: { cfg: Config; node: NodeClient },
  card: Card,
  op: CardWriteOp,
  expected?: CasExpectation,
): Promise<void> {
  const hash = schemaHashFor("card", opts.cfg);
  // A hash already proven to reject the optional fields writes the legacy
  // shape directly — the full-shape attempt would fail the same way it did
  // when the memo was recorded (same hash ⇒ same field set).
  if (opts.cfg.cardLegacyWriteHash === hash) {
    await opts.node[op]({ schemaHash: hash, fields: cardToLegacyOptionalFields(card), keyHash: card.slug, expected });
    return;
  }
  try {
    await opts.node[op]({ schemaHash: hash, fields: cardToFields(card), keyHash: card.slug, expected });
  } catch (err) {
    if (!isOptionalFieldWriteMiss(err)) throw err;
    try {
      await opts.node[op]({ schemaHash: hash, fields: cardToLegacyOptionalFields(card), keyHash: card.slug, expected });
    } catch (retryErr) {
      // The retry uses the legacy body-header shape, so its error is more
      // informative than the original optional-field rejection.
      throw retryErr;
    }
    // Full shape failed AND the legacy shape succeeded on the same op — the
    // schema provably lacks the optional fields. Remember, so later processes
    // stop paying a failed mutation (and a polluted error tally) per write.
    rememberCardLegacyWriteHash(opts.cfg, hash);
  }
}

export async function createCardRecord(
  opts: { cfg: Config; node: NodeClient },
  card: Card,
): Promise<void> {
  await writeCardRecordWithOptionalFieldFallback(opts, card, "createRecord");
  await patchCardListIndex(opts.node, opts.cfg, card, "upsert");
  await upsertBoardCard(opts.node, opts.cfg, card);
}

export async function updateCardRecord(
  opts: { cfg: Config; node: NodeClient },
  card: Card,
  expected?: CasExpectation,
  /** Prior card state — required to delete old BoardCards sk on move. */
  previous?: Card,
): Promise<void> {
  await writeCardRecordWithOptionalFieldFallback(opts, card, "updateRecord", expected);
  await patchCardListIndex(opts.node, opts.cfg, card, "upsert");
  await upsertBoardCard(opts.node, opts.cfg, card, previous ?? null);
}

/** Remove Card + dual indexes (BoardCards + CardListIndex). */
export async function deleteCardRecord(
  opts: { cfg: Config; node: NodeClient },
  card: Card,
): Promise<void> {
  const hash = schemaHashFor("card", opts.cfg);
  await opts.node.deleteRecord({ schemaHash: hash, keyHash: card.slug });
  await patchCardListIndex(opts.node, opts.cfg, card, "remove");
  await removeBoardCard(opts.node, opts.cfg, card);
}

// The outcome of probing whether a schema hash actually accepts a write of
// EVERY field the app emits. `writable` means a create carrying all local
// fields succeeded (and the throwaway record was cleaned up). `not_writable`
// carries the node's rejection so the caller can refuse to adopt the hash and
// tell the user exactly which fields the node won't take.
export type WriteProbeResult =
  | { writable: true }
  | { writable: false; reason: string };

// Verify the node ACCEPTS a write carrying every field the app emits for `type`
// against `schemaHash`, by creating a throwaway record with all fields set to a
// probe value and then deleting it. Returns `{ writable: true }` on success, or
// `{ writable: false, reason }` carrying the node's rejection (e.g. the #94
// `unknown_fields` 400) on failure.
//
// This is the guard that closes the #94 footgun: `init` resolves a Card hash and
// `doctor` reads the configured one, but the node can have a stale, narrower
// schema version that RESOLVES fine yet rejects every write. A field-superset
// check (resolveLoadedSchema) catches that when the node reports `fields`; this
// probe is the runtime backstop that catches it regardless — a hash is only
// adopted/declared healthy once a real write of all fields round-trips.
//
// Best-effort cleanup: if the create succeeds but the delete fails, the probe
// still reports `writable: true` (the write path works). Card reads filter this
// reserved slug, so a leaked probe never surfaces on a board.
export async function probeSchemaWritable(
  node: NodeClient,
  schemaHash: string,
  type: RecordType,
): Promise<WriteProbeResult> {
  const fields: Record<string, unknown> = {};
  const schema = schemaFor(type).schema;
  const optionalFields = type === "card" ? new Set<string>(CARD_OPTIONAL_SCHEMA_FIELDS) : new Set<string>();
  for (const f of fieldsFor(type).filter((field) => !optionalFields.has(field))) {
    // A non-empty probe value per field exercises the write of EVERY field (an
    // all-empty write could be silently accepted by a node that drops unknown
    // empties), which is exactly the #94 failure we must catch.
    fields[f] = typeof schema.field_types[f] === "object" ? ["probe"] : `probe`;
  }
  // The key field must equal the key hash so the record is addressable for the
  // cleanup delete.
  fields[keyFieldFor(type)] = WRITE_PROBE_SLUG;

  try {
    await node.createRecord({ schemaHash, fields, keyHash: WRITE_PROBE_SLUG });
  } catch (err) {
    return {
      writable: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  // Clean up the throwaway. A delete failure does not flip the result — the
  // write path is proven writable, which is all the probe asserts.
  try {
    await node.deleteRecord({ schemaHash, keyHash: WRITE_PROBE_SLUG });
  } catch {
    // best-effort
  }
  return { writable: true };
}

// The hash_field (key) name for a record type, read from the schema definition
// so the probe never drifts if a key field is ever renamed.
function keyFieldFor(type: RecordType): string {
  return schemaFor(type).schema.key.hash_field;
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

// A card's column must be one of the FIXED kanban columns
// (backlog | todo | doing | done). `boardColumns` is ignored — boards cannot
// invent extra column names.
export function ensureColumn(column: string, boardColumns?: string[]): void {
  const valid = resolveColumns(boardColumns);
  if (!valid.includes(column)) {
    throw new FkanbanError({
      code: "invalid_column",
      message: `"${column}" is not a valid kanban column.`,
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

export function applyBodyPriorityTag(card: Pick<Card, "body" | "tags">, explicitPriority = false): void {
  if (explicitPriority) return;
  const tier = normalizePriority(parseBodyHeader(card.body, "Priority"));
  if (!tier) return;
  card.tags = withPriorityTag(card.tags, tier);
}

// Type guard for record-type-keyed config lookups used by the CLI.
export function recordTypeFields(type: RecordType): string[] {
  return fieldsFor(type);
}
