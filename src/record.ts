// Domain helpers: turn fold_db query rows into typed Card / Board records,
// list + find by slug, soft-delete (tombstone), slug + column validation.

import { FkanbanError, type CasExpectation, type NodeClient, type QueryFilter, type QueryRow } from "./client.ts";
import { mapWithConcurrency } from "./concurrency.ts";
import {
  patchCardListIndex,
  readCardListIndex,
  writeCardListIndex,
  cardListIndexIsSuperseded,
  toCardSummary,
  readBoardListIndex,
  writeBoardListIndex,
  type BoardSummary,
} from "./card-list-index.ts";
import {
  BOARD_CARDS_FOOTER_FIELDS,
  BOARD_CARDS_LIST_FIELDS,
  boardCardsProjectionForCardFields,
  listAllBoardCards,
  listBoardCardsPartition,
  preferFresherBoardCard,
  removeBoardCard,
  upsertBoardCard,
  upsertBoardCardsBatch,
  type BoardCardWriteOptions,
} from "./board-cards.ts";
import {
  boardMilestonesHash,
  ensureBoardMilestoneMembership,
  listAllBoardMilestones,
  listBoardMilestonesPartition,
  removeBoardMilestone,
  retireBoardMilestoneMembership,
  upsertBoardMilestone,
} from "./board-milestones.ts";
import {
  removeMilestoneCard,
  retireMilestoneCardMembership,
} from "./milestone-cards.ts";
import { rememberCardLegacyWriteHash, schemaHashFor, type Config } from "./config.ts";
import {
  DEFAULT_BOARD_SLUG,
  DEFAULT_COLUMNS,
  CARD_FIELDS,
  CARD_OPTIONAL_SCHEMA_FIELDS,
  fieldsFor,
  fixedColumns,
  isDefaultColumn,
  resolveColumns,
  schemaFor,
  type Column,
  type RecordType,
} from "./schemas.ts";

/** See `Card[BODY_OMITTED]`. */
export const BODY_OMITTED: unique symbol = Symbol("kanban.card.bodyOmitted");

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
  // ── Projection provenance (in-process only) ─────────────────────────────
  // Set when this Card came back through a BODY-FREE projection (BoardCards
  // partitions, the CardListIndex rollup, or any field list that omitted
  // `body`). Such a card carries `body: ""` because the body was never READ —
  // not because the stored card is empty, and the two are otherwise
  // indistinguishable by value. Policy code that judges the body and the card
  // write path must both refuse it: judging produces a confident wrong
  // verdict, and writing blanks the stored brief (`cardToFields` writes the
  // whole record). Read it with `isBodyOmitted`, clear it with
  // `withLoadedBody`.
  //
  // A SYMBOL key on purpose: object spread carries it (so `{...card}` inside a
  // groom/heal pass stays honest about its provenance), while JSON.stringify
  // ignores it (so the `--json` / MCP card shape stays exactly what it was).
  [BODY_OMITTED]?: true;
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

type HeaderDerivation =
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

// Lines that are ownership headers, provenance, or routine annotations — not
// a work brief. Agents keep wiping specs by `add --body` with only HANDOFF /
// CARD REAP / Created By; treat those as non-substance.
const NON_SPEC_BODY_LINE =
  /^(?:repo|base|kind|branch|pr|priority|tags|surfaces|north\s*star|milestone|db|created\s*by)\s*:/i;
const ANNOTATION_BODY_LINE =
  /^(?:handoff|watch-handoff|watch\s+recheck|needs-human|parked-work\s+salvage)\s*:/i;
const ANNOTATION_SECTION_HEADING =
  /^#{1,6}\s*(?:card\s+reap|handoff|result|proof|live\s+proof\s+gap|parked-work\s+salvage)\b/i;

/**
 * True when the body still has agent-usable work prose (GOAL/STEPS/… or plain
 * text beyond headers/annotations). Empty bodies and annotation-only bodies
 * (e.g. sole `HANDOFF: worktree=…`) fail.
 */
export function isSubstantiveCardBody(body: string): boolean {
  if (!body.trim()) return false;
  if (/^##\s+(GOAL|CONTEXT|STEPS|VERIFY|DONE\s+WHEN|END\s+STATE)\b/im.test(body)) return true;
  if (/^DONE-WHEN:\s+\S+/im.test(body)) return true;

  const prose: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (NON_SPEC_BODY_LINE.test(line)) continue;
    if (ANNOTATION_BODY_LINE.test(line)) continue;
    if (ANNOTATION_SECTION_HEADING.test(line)) continue;
    // Skip pure markdown rules / list bullets that only restate annotations.
    if (/^[-*_]{3,}$/.test(line)) continue;
    prose.push(line);
  }
  // Match existing test fixtures ("Test fixture work.") while rejecting
  // header-only / HANDOFF-only stubs.
  return prose.join(" ").replace(/\s+/g, " ").trim().length >= 12;
}

const BODY_TOKEN_STOPWORDS = new Set([
  "the", "and", "for", "that", "with", "this", "from", "into", "card", "body",
  "repo", "base", "kind", "goal", "state", "steps", "verify", "done", "when",
  "context", "end", "edgevector", "fkanban", "main",
]);

function bodyTokens(body: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of body.toLowerCase().matchAll(/[a-z][a-z0-9_-]{2,}/g)) {
    const token = match[0]!.replace(/^[-_]+|[-_]+$/g, "");
    if (token.length < 3 || BODY_TOKEN_STOPWORDS.has(token)) continue;
    tokens.add(token);
  }
  return tokens;
}

function bodyTokenOverlapRatio(a: string, b: string): number {
  const left = bodyTokens(a);
  const right = bodyTokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

export function isScriptLikeCardBody(body: string): boolean {
  const normalized = body.replace(/\r\n/g, "\n");
  const trimmed = normalized.trimStart();
  if (trimmed.length === 0) return false;

  const firstLine = trimmed.split("\n", 1)[0] ?? "";
  return (
    /^#!\s*\//.test(firstLine) ||
    /^(?:from\s+[A-Za-z_][\w.]*\s+import\s+|import\s+[A-Za-z_][\w.]*)/.test(firstLine) ||
    /\bsubprocess\.check_output\b/.test(normalized) ||
    /^\s*def\s+[A-Za-z_]\w*\s*\(/m.test(normalized) ||
    /^\s*function\s+[A-Za-z_$][\w$]*\s*\(/m.test(normalized) ||
    /^\s*\/\*/m.test(normalized)
  );
}

export function bodyLooksLikeKnownClobber(body: string): boolean {
  return (
    isScriptLikeCardBody(body) ||
    /\bASSIGN\s*=\s*\{/m.test(body) ||
    /\bsubprocess\.check_output\b/.test(body)
  );
}

/**
 * Kind:pr work briefs need both a goal and a terminal acceptance section so
 * bulk "scaffold a North Star" sessions cannot park header-only shells that
 * later get false needs_human holds. Accepts markdown headings or plain
 * `GOAL:` / `END STATE:` / `DONE-WHEN:` lines used by older agents.
 */
export function hasPrWorkBrief(body: string): boolean {
  const hasGoal =
    /^#{1,6}[ \t]*GOAL\b/im.test(body) ||
    /^GOAL[ \t]*:/im.test(body);
  const hasEnd =
    /^#{1,6}[ \t]*END[ \t]+STATE\b/im.test(body) ||
    /^#{1,6}[ \t]*DONE[ \t]+WHEN\b/im.test(body) ||
    /^END[ \t]+STATE[ \t]*:/im.test(body) ||
    /^DONE-WHEN[ \t]*:/im.test(body);
  return hasGoal && hasEnd;
}

/**
 * Run a lane guard so it only fires on an ACTUAL lane entry.
 *
 * The guards below (`assertPrWorkBrief`, `assertLivePrMilestone`,
 * `assertDefaultTodoPickupReady`) all say "cannot enter" / "cannot be placed",
 * and that is what they are for: keeping a card out of a lane it does not
 * qualify for. Applied to every write they mean something stricter — an
 * already-live card that fails them can no longer be EDITED. On 2026-07-30 that
 * blocked the recovery of briefs the board itself had wiped: restoring a lost
 * brief onto a milestone-less todo card was rejected with "cannot enter todo",
 * for a card already sitting in todo, and `fkanban mark` (which appends through
 * `add`) was unusable on exactly the damaged cards it exists to protect — its
 * only offered escape, `--force`, is a flag `mark` does not have.
 *
 * So: run `assertNext`, and swallow its rejection only when this write is not
 * the one that caused it — the card stays in the same place AND `assertPrevious`
 * already failed identically. A move, a board change, or a write that
 * introduces a different violation is still rejected. Claim-time enforcement is
 * unaffected: a pickup claim moves todo -> doing, which is a real entry.
 */
export function assertUnlessAlreadyViolating(
  placementUnchanged: boolean,
  assertNext: () => void,
  assertPrevious: () => void,
): void {
  const nextErr = captureFkanbanError(assertNext);
  if (!nextErr) return;
  if (!placementUnchanged) throw nextErr;
  const prevErr = captureFkanbanError(assertPrevious);
  // Same code, same placement: the card was already in this state before the
  // write, so refusing the write only protects the damage.
  if (prevErr && prevErr.code === nextErr.code) return;
  throw nextErr;
}

// Run `fn` and return the FkanbanError it raised, or null when it passed.
// Anything that is not an FkanbanError is a real fault (node, transport, bug)
// and propagates untouched rather than being read as a policy rejection.
function captureFkanbanError(fn: () => void): FkanbanError | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (err instanceof FkanbanError) return err;
    throw err;
  }
}

/**
 * Refuse Kind:pr creates/updates into the pickup/work lanes without a real brief.
 *
 * - default/todo and default/doing: require a substantive body (not empty /
 *   HANDOFF/reap-only). This is the bulk North Star scaffold failure mode.
 * - GOAL + END STATE is the standing agent contract; `groomCard` flags missing
 *   sections without inventing a needs_human Tom gate. Write-path hard-reject
 *   of missing headings is limited to empty shells so routine fixtures and
 *   mid-flight metadata updates keep working.
 * - backlog: write allowed; groom flags hollow PR briefs.
 *
 * Non-pr kinds and --force are exempt.
 */
export function assertPrWorkBrief(
  slug: string,
  kind: string,
  body: string,
  force?: boolean,
  opts?: { board?: string; column?: string },
): void {
  if (force) return;
  if (normalizeKind(kind) !== "pr") return;
  const board = opts?.board ?? "default";
  const column = opts?.column ?? "";
  const workLane = board === "default" && (column === "todo" || column === "doing");
  if (!workLane) return;
  if (!isSubstantiveCardBody(body)) {
    throw new FkanbanError({
      code: "pr_body_missing_work_brief",
      message: `Card "${slug}" cannot enter default/${column} with an empty or annotation-only Kind: pr body.`,
      hint: "Pipe a real work brief with `## GOAL` and `## END STATE`. Do not bulk-scaffold empty PR shells into the pickup lane — use north-star-driver + milestone-driver. Pass --force only for an intentional exception.",
    });
  }
}

/**
 * Pickup-lane columns where Kind:pr must attach to a milestone.
 * Backlog may still hold unattached PRs (groom / live-pr-milestone hygiene
 * flags them); once they enter todo/doing the factory requires linkage.
 * Matches card VERIFY for fkanban-enforce-live-pr-milestone.
 */
export const LIVE_PR_PICKUP_COLUMNS = new Set(["todo", "doing"]);

/**
 * Refuse Kind:pr cards in the pickup lane without a milestone link.
 * Escape with --force for intentional Unassigned/Operational exceptions.
 * Callers that already resolved a milestone should also pass its state so
 * abandoned milestones cannot anchor live PR work.
 */
export function assertLivePrMilestone(
  card: Pick<Card, "slug" | "kind" | "column" | "milestone">,
  force?: boolean,
  opts?: { milestoneState?: string; enforce?: boolean },
): void {
  if (force) return;
  // Production loadConfig sets enforceLivePrMilestone: true. Unit-test Config
  // objects leave it undefined — pass enforce:false (or omit) to skip.
  if (opts?.enforce !== true) return;
  if (normalizeKind(card.kind) !== "pr") return;
  if (!LIVE_PR_PICKUP_COLUMNS.has(card.column)) return;
  const milestone = (card.milestone ?? "").trim();
  if (!milestone) {
    throw new FkanbanError({
      code: "live_pr_milestone_required",
      message: `Kind:pr card "${card.slug}" cannot enter ${card.column} without a milestone.`,
      hint: "Pass --milestone <slug> to attach a real outcome, or --force for an intentional Unassigned/Operational exception.",
    });
  }
  const state = (opts?.milestoneState ?? "").trim();
  if (state === "abandoned") {
    throw new FkanbanError({
      code: "live_pr_milestone_abandoned",
      message: `Kind:pr card "${card.slug}" cannot use abandoned milestone "${milestone}".`,
      hint: "Pick an active/planned milestone, reopen the outcome, or pass --force for an intentional exception.",
    });
  }
}

/** Default reconciliation driver for new milestones (hierarchical pipeline). */
export const DEFAULT_MILESTONE_DRIVER = "last-stack-milestone-driver";

/** Superseded drivers that must not be written on new/updated milestones. */
export const SUPERSEDED_MILESTONE_DRIVERS = new Set(["program-driver"]);

/**
 * Resolve the milestone driver field: default on create, auto-heal superseded
 * values on update, refuse explicit superseded names.
 */
export function resolveMilestoneDriver(
  requested: string | undefined,
  existing: string | undefined,
  isCreate: boolean,
): string {
  const raw = (requested ?? existing ?? "").trim();
  if (requested !== undefined && SUPERSEDED_MILESTONE_DRIVERS.has(requested.trim())) {
    throw new FkanbanError({
      code: "superseded_milestone_driver",
      message: `Milestone driver "${requested.trim()}" is superseded.`,
      hint: `Use --driver ${DEFAULT_MILESTONE_DRIVER} (north-star-driver creates milestones; milestone-driver creates cards). program-driver is paused compatibility-only.`,
    });
  }
  if (!raw || SUPERSEDED_MILESTONE_DRIVERS.has(raw)) {
    return DEFAULT_MILESTONE_DRIVER;
  }
  if (isCreate && requested === undefined) return DEFAULT_MILESTONE_DRIVER;
  return raw;
}

/**
 * Refuse full-body replaces that would destroy a real brief with only a
 * HANDOFF/reap/provenance stub. Recovery of an empty body is allowed; intentional
 * shrinks require `--force`.
 */
export function assertBodyReplaceSafe(
  slug: string,
  existingBody: string,
  nextBody: string,
  force?: boolean,
): void {
  if (force) return;
  if (existingBody === nextBody) return;
  if (!isSubstantiveCardBody(existingBody)) return;
  if (nextBody.includes(existingBody.trim())) return;
  if (bodyLooksLikeKnownClobber(nextBody)) {
    throw new FkanbanError({
      code: "destructive_body_replace",
      message: `Refusing to replace the body of "${slug}" with content that looks like generated source code.`,
      hint: "Use `fkanban mark <slug> \"...\"` for annotations, pipe the full recovered brief via stdin, or pass --force for an intentional audited full-body replacement.",
    });
  }
  if (
    hasPrWorkBrief(existingBody) &&
    hasPrWorkBrief(nextBody) &&
    existingBody.length >= 200 &&
    nextBody.length >= 200 &&
    bodyTokenOverlapRatio(existingBody, nextBody) < 0.08
  ) {
    throw new FkanbanError({
      code: "destructive_body_replace",
      message: `Refusing to replace the body of "${slug}" with an unrelated full brief.`,
      hint: "Use incremental metadata flags or `fkanban mark` when you are not rewriting the brief. Pass --force for an intentional audited full-body replacement.",
    });
  }
  if (isSubstantiveCardBody(nextBody)) return;
  throw new FkanbanError({
    code: "destructive_body_replace",
    message: `Refusing to replace the body of "${slug}" with an empty or annotation-only stub.`,
    hint: "Use `fkanban mark <slug> \"…\"` to append a HANDOFF/reap line, pipe the full recovered body via stdin, or pass --force for an intentional wipe.",
  });
}

export function assertDefaultTodoPickupReady(card: Card, force?: boolean, rawBody?: string): void {
  if (force) return;
  if (card.board !== DEFAULT_BOARD_SLUG || card.column !== "todo") return;

  // The brief checks below read the body. A caller that passes a body-free
  // projection gets a loud "hydrate first" instead of a confident "this card
  // is empty" about a body nobody fetched. `rawBody` only overrides when it
  // is a real body — the pre-derive text of a card being written — not the
  // same "" the projection already handed us.
  if (rawBody === undefined || rawBody === "") assertBodyLoaded(card, "pickup-readiness check");

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
  if (!isSubstantiveCardBody(bodyForHeaderCheck)) {
    throw new FkanbanError({
      code: "default_todo_not_pickup_ready",
      message: `Card "${card.slug}" cannot be placed in default/todo with an empty or annotation-only body.`,
      hint: "Pipe a real work brief (GOAL/CONTEXT/STEPS/VERIFY/DONE WHEN, or ≥12 chars of prose beyond Repo/Base headers). Use `fkanban mark` for HANDOFF lines; pass --force only for an intentional exception.",
    });
  }

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
    isSubstantiveCardBody(card.body) &&
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
  // pr_url: body `PR:` / `CR:` (and lastgit://… fallback). Agents often write
  // only the body header on handoff; without this backfill, board-closeout
  // treats the card as no-PR and rolls WIP back to todo.
  if (!card.pr_url) {
    const pr = extractPrUrlFromBody(card.body, card.repo);
    if (pr) out.pr_url = pr;
  }
  if (!card.db) {
    const db = normalizeDbLocator(parseBodyHeader(card.body, "Db"));
    if (db) out.db = db;
  }
  return out;
}

/**
 * Resolve a PR/CR locator from card body prose for structured-field backfill.
 * Prefers line headers `PR:` / `CR:`, then a bare `lastgit://…/cr/…` URL, then
 * a bare `cr-…` id combined with the card's repo slug.
 */
export function extractPrUrlFromBody(body: string, repo = ""): string {
  for (const name of ["PR", "CR"] as const) {
    const raw = parseBodyHeader(body, name).trim();
    if (!raw) continue;
    if (/^(https?:\/\/|lastgit:\/\/)/i.test(raw)) return raw;
    // Bare lastgit CR id — synthesize locator when repo is known.
    const cr = raw.match(/\b(cr-[A-Za-z0-9_-]+)\b/)?.[1];
    if (cr) {
      const slug = repo.includes("/") ? repo.split("/").pop()! : repo.trim();
      if (slug) return `lastgit://${slug}/cr/${cr}`;
      return cr;
    }
    // Forge/GitHub path fragments already look like URLs after first-token parse.
    if (/pulls?\/\d+/i.test(raw) || /\/pull\/\d+/i.test(raw)) return raw;
  }
  // Unfenced lastgit CR URL anywhere in the body (handoff notes).
  let inFence = false;
  for (const line of body.split("\n")) {
    if (/^[ \t]*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/\blastgit:\/\/[^\s)>\]]+/i);
    if (m?.[0]) return m[0].replace(/[.,;]+$/, "");
  }
  return "";
}

export type StructuredFieldRepairOptions = {
  repo?: boolean;
  base?: boolean;
  kind?: boolean;
  northStar?: boolean;
  branch?: boolean;
  surfaces?: boolean;
  db?: boolean;
  prUrl?: boolean;
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
  if (!explicit.prUrl) {
    const pr = extractPrUrlFromBody(card.body, card.repo);
    if (pr) card.pr_url = pr;
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

/**
 * True when a milestone query row is field-sparse (e.g. full-scan returned only
 * `slug`). Point-read by HashKey still returns the full field set on Mini after
 * 0.22.10-class cutovers; list/gap-report must hydrate those rows or every
 * milestone classifies as `no_north_star`.
 *
 * A real write always persists more than slug (board/state/proof_status/timestamps
 * at minimum). Only-slug (or empty) rows are therefore a projection miss, not a
 * legitimate hollow milestone.
 */
export function milestoneQueryFieldsLookSparse(fields: Record<string, unknown> | null | undefined): boolean {
  if (!fields) return true;
  let nonEmptyNonSlug = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (key === "slug") continue;
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) nonEmptyNonSlug += 1;
      continue;
    }
    if (String(value).length > 0) nonEmptyNonSlug += 1;
  }
  return nonEmptyNonSlug === 0;
}

// ── Body-free projection provenance ────────────────────────────────────────
// See `Card[BODY_OMITTED]`. These three helpers are the whole contract: list
// paths MARK, hydration paths CLEAR, and policy/write paths ASSERT.

function markBodyOmitted(cards: Card[]): Card[] {
  for (const card of cards) {
    card[BODY_OMITTED] = true;
    // Drop any body atom that leaked through a partial projection or a
    // test double that ignores `fields`. BODY_OMITTED means "unread" —
    // a non-empty body would skip hydrate (body.length > 0) and make
    // isRegistryCard(isBodyOmitted ? "" : body) see a lie.
    card.body = "";
  }
  return cards;
}

/** Did this card's body come from LastDB, or was it never read? */
export function isBodyOmitted(card: Card): boolean {
  return card[BODY_OMITTED] === true;
}

/** A hydrated copy of a body-free projection: real body in, marker off. */
export function withLoadedBody(card: Card, body: string): Card {
  const next: Card = { ...card, body };
  delete next[BODY_OMITTED];
  return next;
}

/**
 * Refuse to judge or persist a card whose body was never read. This is a
 * programming error at the call site (fetch the body first), not a data
 * problem with the card — hence a distinct code from the policy failures,
 * so callers that legitimately swallow `default_todo_not_pickup_ready`
 * (move's dependency auto-promotion) can never swallow this.
 */
export function assertBodyLoaded(card: Card, operation: string): void {
  if (!isBodyOmitted(card)) return;
  throw new FkanbanError({
    code: "card_body_not_loaded",
    message: `${operation} needs the body of "${card.slug}", which was read through a body-free projection.`,
    hint: "Hydrate first — findCard/requireCard for one card, listCardsWithBodies for a whole-board sweep — then re-run. Board lists (BoardCards/CardListIndex) never carry bodies.",
  });
}

/**
 * `boards` lets a caller that ALREADY read the board list hand it down instead
 * of paying `card_list_index HashKey(all_boards)` a second time. Every card list
 * needs the board set to know which BoardCards partitions to query, so a command
 * that fetches boards for itself and then calls a list helper reads it twice —
 * measured at 212ms of pure duplication per read on the live board, on `pickup`,
 * the fleet's hottest routine.
 *
 * Thread it EXPLICITLY; do not replace this with a process-level memo. `kanban
 * mcp` is a long-lived process, so a cached board list would go stale there and
 * a newly created board would stay invisible until restart — trading a 212ms
 * read for a correctness bug.
 */
type BoardListOpt = {
  boards?: Board[];
  /**
   * Read only the non-terminal columns of each board.
   *
   * ONLY for a caller that provably discards the terminal column anyway —
   * `pickup status` classifies `activeCards` and nothing else. It is a read
   * narrowing, not a filter: a caller that passes this and then looks for a
   * finished card will not find one, so it does not belong on `list`, `show`,
   * `search`, or any sweep that repairs or counts the archive.
   *
   * Best-effort by design. It applies only on the BoardCards partition path;
   * every fallback below (CardListIndex, the admin scan) still returns the
   * whole board, which is correct for these callers — they filter — and keeps
   * this option from turning a degraded read into a wrong one.
   */
  activeOnly?: boolean;
};

/**
 * Rebuild BoardCards membership from Card truth, after the scan fallback in
 * {@link listCardsWithFields} found no usable index.
 *
 * ## Why this is guarded on `boardCardsThrew`
 *
 * The caller reaches its scan fallback for two very different reasons, and the
 * `catch` that used to sit around the BoardCards query erased the difference:
 *
 *   - the index is genuinely ABSENT (fresh node, pre-backfill) — seeding is the
 *     whole point, or
 *   - the partition read THREW.
 *
 * On this node the ordinary cause of the second is `service_timeout` / "too
 * many concurrent reads" — the node saying it is already shedding load. Reading
 * that as "the index must be missing, rebuild it" made a plain `kanban list`
 * answer backpressure with hundreds more operations, which is precisely
 * backwards. A failed read is not evidence of an empty index — the same rule
 * the body and board scans already follow: **only a read that SUCCEEDED may
 * establish that something is absent.**
 *
 * ## Why it is not a serial loop any more
 *
 * As written (`for (const c of cards) await upsertBoardCard(node, cfg, c)`)
 * every card paid two full round trips — the wide keyed probe, and, because no
 * `previous` was passed, a whole-partition orphan scan. Measured on the live
 * primary 2026-07-31 (`scripts/probe-seed-storm-cost.ts`): 654ms + 657ms per
 * card over 331 live cards = **~7.2 minutes and ~1000 operations**, serial,
 * inside a command the user typed as `list`, silent the entire time.
 *
 * `skipOrphanPurge` is correct here for the same reason `board-cards-heal`
 * passes it: this writes every card's current truth, so a per-card partition
 * rescan can only rediscover drift that the same loop is already overwriting.
 * Residual multi-orphan drift is `groom board-cards-heal`'s job — reads stay
 * correct meanwhile because `listAllBoardCards` dedupes by slug through
 * `preferFresherBoardCard`.
 *
 * ## Why the try/catch moved inside
 *
 * It was outside the loop, so the FIRST card that failed to write abandoned the
 * seed for every card after it — under exactly the conditions that trigger the
 * seed. It paid the storm and did not finish the repair, silently. Per-item now.
 *
 * Deduped by slug, keeping the richest row: the Card scan returns more than one
 * row for some slugs (see {@link listCardsWithBodies}), and the extra row
 * carries only `slug` — no column, no position. Seeding from it would write a
 * junk membership sk for a card that already has a real one, i.e. the repair
 * would corrupt the index it exists to rebuild.
 */
async function seedBoardCards(
  node: NodeClient,
  cfg: Config,
  cards: Card[],
  boardCardsThrew: boolean,
): Promise<void> {
  if (boardCardsThrew) return;
  const bySlug = new Map<string, Card>();
  for (const card of cards) {
    if (!card.slug) continue;
    const seen = bySlug.get(card.slug);
    if (seen === undefined || cardFieldWeight(seen) < cardFieldWeight(card)) {
      bySlug.set(card.slug, card);
    }
  }
  // Batched, NOT fanned out. Every card seeded here lands in the same board
  // partition, and the node gates a write per `(molecule, hash)` — the range
  // half of a HashRange key is not in the lock key — so concurrent writers of
  // one board queue rather than overlap. Measured on the live primary
  // (`probe-boardcards-write-lock-contention.ts`), the fan-out this replaces
  // ran at **0.91x of serial**: it was paying for concurrency and getting less
  // than nothing back. One batch of the same 12 rows ran 2.10x, and at the
  // seed's own chunk size the per-write cost drops 1282ms -> 160ms.
  //
  // The per-card best-effort contract survives: `upsertBoardCardsBatch` retries
  // a rejected chunk one row at a time, so a single unseedable card still
  // cannot abandon the rest of the repair — which was the whole reason the
  // try/catch moved inside the loop in the first place.
  await upsertBoardCardsBatch(node, cfg, [...bySlug.values()]);
}

/**
 * How much membership truth a scanned row actually carries, for picking between
 * duplicate rows of one slug. A row with no `column` cannot state where the
 * card lives, so it must never displace one that can.
 */
function cardFieldWeight(card: Card): number {
  return (card.column ? 2 : 0) + (card.position ? 1 : 0) + (card.board ? 1 : 0);
}

// Shared body of the three card list paths below: query the card schema for the
// given field subset, map rows to Cards, and drop legacy tag-tombstoned cards.
// Native deletes are hidden by the node before this point.
async function listCardsWithFields(
  node: NodeClient,
  cfg: Config,
  fields: string[],
  filter?: QueryFilter,
  opts: { allowFullScanFallback?: boolean } & BoardListOpt = {},
): Promise<Card[]> {
  // Prefer BoardCards HashRange partitions (hash=board) — Dynamo-style list.
  // Never hydrate body for board-wide lists (that was the N+1 storm). Callers
  // that need body must findCard/show by slug.
  // HashKey filters still go to the Card schema (point reads).
  if (filter === undefined) {
    // Did the BoardCards read FAIL, or was the index genuinely absent? The
    // seed below is only allowed to run for the second — see `seedBoardCards`.
    let boardCardsThrew = false;
    // BoardCards first: one partition query per board, thin projection.
    try {
      const boards = opts.boards ?? (await listBoards(node, cfg));
      const cardFields = fields.includes("body")
        ? fields.filter((f) => f !== "body")
        : fields;
      const projection =
        cardFields.length > 0
          ? boardCardsProjectionForCardFields(cardFields)
          : [...BOARD_CARDS_LIST_FIELDS];
      const partitioned = await listAllBoardCards(node, cfg, boards, {
        fields: projection,
        skipTerminalColumn: opts.activeOnly === true,
      });
      if (partitioned !== null && partitioned.length > 0) {
        // BoardCards rows are already body-free; promote any structured fields.
        return markBodyOmitted(
          partitioned
            .filter((c) => !isHiddenCard(c))
            .map((c) => Object.assign(c, deriveStructuredFields(c))),
        );
      }
      // Empty partition may mean "no cards" OR "not dual-written yet".
      // Fall through to CardListIndex when partitions are empty so dual-read
      // still sees legacy boards until backfill.
      //
      // EXCEPT under `activeOnly`, where empty legitimately means "every card
      // is finished" — a read that deliberately excluded the terminal column is
      // no evidence at all about dual-write coverage. Without this the moment
      // the board went all-`done` every `pickup status` would take the
      // fall-through below: an admin full scan of Card, an index rewrite and a
      // BoardCards reseed, i.e. a WRITE storm triggered by finishing the work.
      if (partitioned !== null && partitioned.length === 0 && opts.activeOnly === true) {
        return [];
      }
      if (partitioned !== null && partitioned.length === 0) {
        const indexedEmpty = await readCardListIndex(node, cfg);
        if (indexedEmpty !== null && indexedEmpty.length === 0) {
          return [];
        }
        // indexed has data but BoardCards empty → legacy path below
      }
    } catch {
      // The partition read failed. `list` still has to answer, so we fall
      // through to the scan — but the failure is recorded, because it is NOT
      // evidence that the index needs rebuilding.
      boardCardsThrew = true;
    }

    const indexed = await readCardListIndex(node, cfg);
    // A RETIRED rollup is never the answer — not when it is empty, and not when
    // it still holds its legacy payload.
    //
    // This fall-through is only reached when the BoardCards query THREW or the
    // schema is unbound, and the two cases want opposite things:
    //
    //   board_cards bound (superseded) — the write path has not maintained
    //     `all_cards` since 2026-07-28 (`patchCardListIndex` returns early on
    //     the same predicate), so whatever it holds is frozen at that date.
    //     Serving it answers a transient shed with stale membership: measured
    //     on the primary 2026-08-02, 721 entries of which 714 had no Card
    //     record at all. Seed from Card truth below instead — an empty payload
    //     is likewise absence of information, not proof of an empty board, and
    //     agents read an empty board as "no work".
    //
    //   board_cards unbound (legacy) — the rollup IS the card index on this
    //     node. Unchanged: it is served exactly as before.
    //
    // So the read path's trust now matches the write path's refusal. Widening
    // this to `length === 0` only, as it was, made the guard decline the rollup
    // precisely when it had nothing to give and accept it when it did.
    if (indexed !== null && !cardListIndexIsSuperseded(cfg)) {
      // CardListIndex is body-free by construction — never N+1 hydrate.
      return markBodyOmitted(
        (indexed.filter((c) => !isHiddenCard(c as Card)) as Card[]).map((c) =>
          Object.assign({ ...c, body: "" }, deriveStructuredFields(c as Card)),
        ),
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
    if (!fields.includes("body")) markBodyOmitted(cards);
    try {
      await writeCardListIndex(node, cfg, cards.map(toCardSummary));
    } catch {
      // best-effort seed; list still returns
    }
    await seedBoardCards(node, cfg, cards, boardCardsThrew);
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
  const cards = res.results.map(rowToCard).filter((c) => !isHiddenCard(c));
  return fields.includes("body") ? cards : markBodyOmitted(cards);
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

/** Body-free structured fields for list/pickup/MCP — never includes `body`. */
export const CARD_LIST_FIELDS: string[] = [
  "slug",
  "title",
  "board",
  "column",
  "position",
  "tags",
  "deps",
  "surfaces",
  "assignee",
  "kind",
  "created_at",
  "created_by",
  "updated_at",
  "repo",
  "base",
  "block_status",
  "block_reason",
  "north_star",
  "milestone",
  "pr_url",
  "branch",
];

export async function listCards(
  node: NodeClient,
  cfg: Config,
  opts: BoardListOpt = {},
): Promise<Card[]> {
  // Thin board list — no bodies (BoardCards / index). Use findCard for one body,
  // or listCardsWithBodies for complete-body search (one admin scan).
  // Prefer CARD_LIST_FIELDS over fieldsFor("card") so BoardCards never projects
  // for body (not stored) and drops write-only / rare list fields.
  return listCardsWithFields(node, cfg, CARD_LIST_FIELDS, undefined, opts);
}

/**
 * Complete-body card set: ONE admin full-scan of Card (allowFullScan), not N
 * point-gets. Prefer the native index / thin list for hot paths — this is for
 * free-text search and for whole-board sweeps that JUDGE or REWRITE bodies
 * (`groom stale-blockers`, `rank`, `migrate area-tags`), which cannot use the
 * body-free list without deciding on a body they never read.
 *
 * DEDUPED BY SLUG, keeping the longest body — the scan returns MORE THAN ONE
 * row for some slugs even though `Card` is a `Hash` schema keyed on `slug`.
 * Measured on the live primary 2026-07-31: 468 rows for 421 distinct slugs, 47
 * slugs duplicated, and in every duplicated pair one row carries the real body
 * and the other is EMPTY. The keyed read is authoritative and unaffected —
 * `HashKey(slug)` returns exactly ONE row, always the non-empty one (verified
 * over 12 affected slugs) — so the ghost rows are a scan-only artifact and the
 * scan, not the data, is what needs defending.
 *
 * Same keep-longest rule (and the same reasoning) as `listCardBodies`: an
 * empty row carries no text any caller could want, so it must never displace
 * one that does, and length is order-independent where last-write-wins is not.
 * Without this, callers saw one card twice — `search --complete` listed it
 * twice, and every body-judging sweep got a coin flip on which row it judged.
 */
export async function listCardsWithBodies(
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
  const bySlug = new Map<string, Card>();
  const unkeyed: Card[] = [];
  for (const card of res.results.map(rowToCard)) {
    if (isHiddenCard(card)) continue;
    // A row with no slug cannot be a duplicate OF anything (nothing addresses
    // it by key), so it is passed through rather than collapsed with its peers.
    if (card.slug.length === 0) {
      unkeyed.push(card);
      continue;
    }
    const seen = bySlug.get(card.slug);
    if (seen === undefined || seen.body.length < card.body.length) bySlug.set(card.slug, card);
  }
  return [...bySlug.values(), ...unkeyed];
}

/**
 * slug → body for every Card the node will return, in ONE narrow scan.
 *
 * `search`'s default path matches against a body-free display read, so on its
 * own it can only match body text for cards some *other* index happened to
 * surface. This is the cheapest read that can answer "whose body contains the
 * query" for the whole board, and it replaces a per-candidate point-read
 * fan-out. Measured on the live primary: slug+body over 647 rows is **413ms**,
 * against ~5.5s for the 50 wide point reads it replaces (~110ms each — on this
 * node a point read costs orders more per row than a scan amortizes).
 *
 * Projected narrow for CORRECTNESS as much as cost: LastDB returns a row only
 * when EVERY projected field has an atom on it, so each extra projected field
 * is another way for a live card to vanish from search results. Two fields is
 * the floor this match needs.
 *
 * Pairs with the `BODY_OMITTED` contract — callers hydrate a body-free card
 * through `withLoadedBody`, which is the marker-clearing path.
 */
export async function listCardBodies(
  node: NodeClient,
  cfg: Config,
): Promise<Map<string, string>> {
  const res = await node.queryAll({
    schemaHash: schemaHashFor("card", cfg),
    fields: ["slug", "body"],
    allowFullScan: true,
  });
  const bodies = new Map<string, string>();
  for (const row of res.results) {
    const f = (row.fields ?? {}) as Record<string, unknown>;
    const slug = stringField(f, "slug");
    if (slug.length === 0) continue;
    const body = stringField(f, "body");
    // A scan of Card returns MORE THAN ONE row for some slugs on the live
    // primary — measured 47 of 593 distinct slugs, of which 44 disagree about
    // the body and 33 carry the EMPTY one last. A plain last-write-wins
    // `set(slug, body)` therefore silently discards the real brief for those
    // cards and they stop matching on body text.
    //
    // Keep the longest, which is order-independent: an empty row carries no
    // text a substring search could match, so it must never displace one that
    // does. (Ordering by `updated_at` instead would mean projecting a third
    // field, and any card missing that atom would drop out of the read
    // entirely — a worse failure than picking the richer of two bodies.)
    const seen = bodies.get(slug);
    if (seen === undefined || seen.length < body.length) bodies.set(slug, body);
  }
  return bodies;
}

/**
 * The BOARD's cards with their bodies filled in — for whole-board sweeps that
 * judge or rewrite bodies (`groom stale-blockers`, `rank`, `migrate
 * area-tags`).
 *
 * Two reads, not N: `listCards` for the universe and ONE admin scan for the
 * bodies. Taking the universe from the board list rather than from the scan is
 * deliberate — the scan returns every Card record, including ones with no
 * BoardCards row, so sweeping it directly would silently widen a board command
 * to off-board records (522 rows vs the board's 245 on the primary,
 * 2026-07-30). Same cards as every other board command, now with bodies.
 *
 * A card the scan doesn't cover (BoardCards/Card drift) is point-read rather
 * than handed back as a false empty — the whole failure this guards against.
 *
 * ONLY A KEYED READ MAY ESTABLISH THAT A BODY IS EMPTY. The scan is allowed to
 * SUPPLY a body and never to DENY one: an empty scan body is treated as "not
 * covered", so the card keeps its `BODY_OMITTED` marker and `hydrateCardBodies`
 * point-reads it. Presence in the scan is not the same as coverage, and the
 * original `bodies.has(slug)` test conflated them — on the live primary that
 * handed 33 of 352 board cards a body of `""` while their real briefs (513–4389
 * chars) sat one keyed read away, because the duplicate EMPTY row landed last in
 * a last-write-wins map. Those cards then read as hollow to the very sweeps this
 * function exists to feed, and `hydrateCardBodies` could not rescue them: it
 * correctly refuses to re-read a body someone already claimed to have read, so
 * the false empty was laundered into a genuine one.
 *
 * The keyed read is authoritative here (see `listCardsWithBodies`), so this
 * costs one point read per genuinely-empty card and buys back every real body.
 */
export async function listBoardCardsWithBodies(
  node: NodeClient,
  cfg: Config,
  opts: BoardListOpt = {},
): Promise<Card[]> {
  const cards = await listCards(node, cfg, opts);
  if (cards.length === 0) return cards;
  if (!cards.some(isBodyOmitted)) return cards;

  // `listCardBodies`, not `listCardsWithBodies`: it projects two fields instead
  // of the full card, so it is both cheaper and STRICTLY WIDER in coverage —
  // LastDB returns a row only when every projected field has an atom, so the
  // wide scan silently drops cards the narrow one returns (421 slugs vs 595 on
  // the primary). This read wants bodies; asking for anything else only adds
  // ways for a live card to go missing.
  const bodies = await listCardBodies(node, cfg);
  const covered = cards.map((c) => {
    if (!isBodyOmitted(c)) return c;
    const body = bodies.get(c.slug);
    if (body === undefined || body.length === 0) return c;
    return withLoadedBody(c, body);
  });
  return hydrateCardBodies(node, cfg, covered);
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
  // `isBodyOmitted` — not `body.length` — is the discriminator: a card whose
  // stored body really is empty is already answered, and re-reading it pays a
  // point read per peer to learn nothing. See `Card[BODY_OMITTED]`.
  if (!isBodyOmitted(card)) return card;
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
 * Cards in one column via BoardCards HashRangePrefix only (one keyed query).
 *
 * No client-filter / CardListIndex secondary path: if the prefix query fails
 * or BoardCards is unconfigured, throw so we notice primary breakage.
 */
export async function listCardsByColumn(
  node: NodeClient,
  cfg: Config,
  column: string,
  fields: string[],
  board?: string,
  /**
   * `opts.projection` narrows what BoardCards is asked for. Use it only when the
   * rows are consumed by a *predicate* rather than rendered — the dependency
   * seed in `list --column` is the one such caller today
   * ({@link BOARD_CARDS_DEP_SEED_FIELDS}). `fields` is unrelated: it is the
   * Card-side projection, and only `reconcileBoardCardSummaries({verify:true})`
   * reads it.
   */
  opts?: { projection?: readonly string[] },
): Promise<Card[]> {
  if (!board) {
    throw new FkanbanError({
      code: "missing_argument",
      message: "listCardsByColumn requires a board slug (BoardCards HashRangePrefix primary path).",
      hint: "Pass the board id (e.g. default). Client-side multi-board column scan is removed.",
    });
  }
  const part = await listBoardCardsPartition(node, cfg, board, {
    column,
    fields: opts?.projection ?? boardCardsProjectionForCardFields(fields),
  });
  if (part === null) {
    throw new FkanbanError({
      code: "schema_not_configured",
      message: `BoardCards schema hash missing; cannot list column "${column}" on board "${board}".`,
      hint: "Run kanban init / ensure config.schemaHashes.board_cards is set. No secondary list path.",
    });
  }
  const reconciled = await reconcileBoardCardSummaries(node, cfg, part, fields);
  return reconciled
    .filter((c) => !isHiddenCard(c))
    .map((c) => Object.assign(c, deriveStructuredFields(c)));
}

/**
 * Every card slug the Card schema holds, body-free — the reconciler's discovery
 * source for membership that no index knows about.
 *
 * This is a deliberate `allowFullScan` and the no-scan contract permits it: the
 * contract bans scans on *hot read paths*, and repairs drift with an explicit
 * reconciler that reads the primary (`concepts-lastdb-agent-access-model`).
 * `groom board-cards-heal` is that reconciler — manual/scheduled, never a list.
 *
 * It replaces `readCardListIndex` as heal's discovery source, and is strictly
 * more capable: the `all_cards` rollup was a lost-update-prone copy, so a card
 * dropped from it by a concurrent write was invisible to heal forever. Card is
 * the source of truth, so a row missing from *both* indexes is now findable.
 *
 * SLUG ORACLE ONLY — do not trust the field values on the rows this returns.
 *
 * Measured against the primary 2026-07-28: it returned 1054 rows for 791
 * distinct slugs, and 843 of those rows carried a populated `slug` with every
 * other projected field blank (`column: ""`, `board: ""`, `title: ""`). 263
 * slugs came back TWICE — once populated, once as a blank shell — and 580 slugs
 * had no populated row at all despite point-reading fine, including a card
 * updated the same day. `column` IS in the projection
 * (`cardListProjectionFields`), so this is not a missing-field bug on our side.
 *
 * Every caller must therefore point-read Card truth at HashKey(slug) before
 * acting on a row, and must read a blank field as "unknown", never as a value.
 * A caller that treats `row.column` as authoritative will silently mis-handle
 * ~73% of the board.
 *
 * That rule used to live only in this comment, and the return type said the
 * opposite: a `Card[]`, every field a populated `string`. `board_cards_heal`
 * duly read `row.board` to decide which board a card belonged to. So the type
 * now carries the contract instead — see `ScannedCardRow`, where a field the
 * scan did not establish is `undefined` rather than `""` and cannot be
 * confused for a value.
 */
export async function scanCardSummariesForReconcile(
  node: NodeClient,
  cfg: Config,
): Promise<ScannedCardRow[]> {
  const hash = schemaHashFor("card", cfg);
  const projection = cardListProjectionFields(fieldsFor("card"));
  let res;
  try {
    res = await node.queryAll({ schemaHash: hash, fields: projection, allowFullScan: true });
  } catch (err) {
    if (!isOnlyOptionalFieldMiss(err, projection)) throw err;
    res = await node.queryAll({
      schemaHash: hash,
      fields: projection.filter(
        (field) => !(CARD_OPTIONAL_SCHEMA_FIELDS as readonly string[]).includes(field),
      ),
      allowFullScan: true,
    });
  }
  return res.results
    .map(rowToCard)
    .filter((c) => c.slug.length > 0 && !isHiddenCard(c))
    .map((c) => scannedCardRow(c));
}

/**
 * One row of the Card full scan, typed so it cannot be mistaken for truth.
 *
 * `slug` is the only field a scan establishes. Every other field is optional,
 * and `undefined` means THE SCAN DID NOT ESTABLISH THIS — it does not mean
 * "empty". The distinction is the whole point: a blank scan field is
 * indistinguishable from a real empty value in the wire rows (measured
 * 2026-07-28: 843 of 1054 rows carried `board: ""`, `column: ""`, `title: ""`
 * on records that point-read fine), so collapsing blank to `undefined` here is
 * what forces a caller to write down which one it meant.
 *
 * Only the fields a reconciler has an actual use for are carried. Adding one
 * back is a decision, not a convenience: whatever you add, a caller can then
 * read, and the scan cannot vouch for any of it.
 */
export type ScannedCardRow = {
  slug: string;
  /** `undefined` = not established by the scan. Never "the card has no board". */
  board?: string;
  /** `undefined` = not established by the scan. Never "the card has no column". */
  column?: string;
};

/** Project a scan row, collapsing "the scan said nothing" to `undefined`. */
function scannedCardRow(c: Card): ScannedCardRow {
  const row: ScannedCardRow = { slug: c.slug };
  if (c.board) row.board = c.board;
  if (c.column) row.column = c.column;
  return row;
}

/**
 * Point-read one card's reconcile truth, body-free.
 *
 * Same source of truth and same key as `findCard` — the Card record at
 * HashKey(slug) — so a reconciler keeps its "Card decides, indexes follow"
 * invariant. The only difference is the projection: `body` is dropped, because
 * BoardCards never stores one (`boardCardFieldsFromCard`) and every reconciler
 * blanks it on arrival. A reconciler makes one of these per card, so shipping
 * multi-KB bodies across the socket to decide a column#pos membership was the
 * dominant cost of `groom board-cards-heal`.
 *
 * `reconcileBoardCardSummaries` already reads truth this way; this is the same
 * projection, exported so heal stops being the one path that pays for bodies.
 */
export async function findCardSummaryForReconcile(
  node: NodeClient,
  cfg: Config,
  slug: string,
): Promise<Card | null> {
  return findCardWithFields(node, cfg, slug, cardListProjectionFields(fieldsFor("card")));
}

/**
 * Thin cards on one board only (one BoardCards partition — no empty-board fan-out).
 * `fields` is used only on the legacy CardListIndex / Card fallback path.
 */
export async function listCardsOnBoard(
  node: NodeClient,
  cfg: Config,
  board: string,
  fields: string[] = CARD_LIST_FIELDS,
): Promise<Card[]> {
  try {
    const part = await listBoardCardsPartition(node, cfg, board, {
      fields: boardCardsProjectionForCardFields(fields),
    });
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

  // Seed once via admin full scan when the index row is not declared/seeded yet.
  const boards = await scanBoardsForReconcile(node, cfg);
  try {
    await writeBoardListIndex(node, cfg, boards.map(toBoardSummary));
  } catch {
    // best-effort
  }
  return boards;
}

export function toBoardSummary(b: Board): BoardSummary {
  return {
    slug: b.slug,
    title: b.title,
    body: b.body,
    columns: b.columns,
    created_at: b.created_at,
    updated_at: b.updated_at,
  };
}

/**
 * Every live board this node can prove exists, read from Board truth rather than
 * from the `all_boards` rollup. Discovery source for the `listBoards` cold-seed
 * and for `groom board-list-heal`.
 *
 * A full scan here is a deliberate `allowFullScan` and the no-scan contract
 * permits it: boards are bounded (a handful), and this is a seed/reconciler path,
 * never a hot read (`concepts-lastdb-agent-access-model`).
 *
 * TWO RULES, BOTH LEARNED THE HARD WAY (measured read-only on the primary
 * 2026-07-28 — papercut-lastdb-full-scan-drops-fields-on-conflicted-records):
 *
 * 1. A SCAN ROW CARRIES ONLY ITS KEY FIELD. For any record whose key atom has
 *    `has_conflicts`, every other requested field is silently dropped — not
 *    nulled, not an error (25 of 26 Board rows came back slug-only). Trusting
 *    them would seed `all_boards` with `title:""`, `columns:[]`; since
 *    `isTombstoned([])` is false those hollow boards read as LIVE and
 *    `kanban list` would render a board with no columns. So the scan supplies
 *    slugs and nothing else, and every board is hydrated by a point read.
 *
 * 2. A SCAN IS NOT A CENSUS. It omits live records that a point read returns:
 *    the scan listed 34 Board slugs — `agent-dogfood-scratch2/3/4` among them —
 *    while `agent-dogfood-scratch` and eight `zz-kstress-*` boards were absent
 *    from it yet point-read fine, with real titles and columns. So **absence
 *    from a scan is not evidence of deletion.** Callers that must decide whether
 *    a record is gone (the reconciler deciding "ghost") pass those slugs in via
 *    `alsoConsider` and let the point read be the verdict. Without that, a heal
 *    would have deleted nine live boards' index entries and made every card on
 *    them invisible to `kanban list` — the exact failure it exists to prevent.
 */
export async function scanBoardsForReconcile(
  node: NodeClient,
  cfg: Config,
  /** Extra slugs to verify by point read even if the scan never listed them. */
  alsoConsider?: Iterable<string>,
): Promise<Board[]> {
  const hash = schemaHashFor("board", cfg);
  const res = await node.queryAll({
    schemaHash: hash,
    fields: fieldsFor("board"),
    allowFullScan: true,
  });

  // Slugs only — see rule 1.
  const slugs = new Set<string>();
  for (const row of res.results) {
    const slug = rowToBoard(row).slug;
    if (slug.length > 0) slugs.add(slug);
  }
  // Rule 2: candidates the scan cannot be trusted to have listed.
  for (const slug of alsoConsider ?? []) {
    if (slug.length > 0) slugs.add(slug);
  }

  const boards: Board[] = [];
  for (const slug of slugs) {
    // findBoard point-reads and already drops tombstoned/hollow boards.
    const board = await findBoard(node, cfg, slug);
    if (board) boards.push(board);
  }
  return boards.sort((a, b) => a.slug.localeCompare(b.slug));
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

/**
 * Resolve dep status for `cards` by merging them with optional `knownCards`
 * (e.g. the whole BoardCards board partition) and point-reading only slugs
 * still missing.
 *
 * Hot list path passes the full board partition as `knownCards` so same-board
 * deps never pay Card HashKey point-reads (measured multi-second under
 * HashGroup thrash). Cross-board / unknown deps still point-read.
 */
export async function listDependencyStatusesForCards(
  node: NodeClient,
  cfg: Config,
  cards: Card[],
  knownCards?: Card[],
): Promise<Card[]> {
  const bySlug = new Map<string, Card>();
  for (const card of knownCards ?? []) {
    if (card.slug) bySlug.set(card.slug, card);
  }
  for (const card of cards) {
    if (card.slug) bySlug.set(card.slug, card);
  }

  const depSlugs = [...new Set(cards.flatMap((c) => c.deps))].filter((slug) => !bySlug.has(slug));
  if (depSlugs.length === 0) return [...bySlug.values()];

  // Bounded: `depSlugs` is every dep edge that points OFF the input set, so it
  // scales with the board, not with a caller-chosen page. `pickup status` passes
  // the whole active board through here.
  const deps = await mapWithConcurrency(depSlugs, (slug) =>
    findCardWithFields(node, cfg, slug, CARD_STATUS_FIELDS),
  );
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
export const CARD_DISPLAY_FIELDS = [
  "slug",
  "title",
  "board",
  "column",
  "position",
  "tags",
  "deps",
  "surfaces",
  "assignee",
  "kind",
  "created_at",
  "created_by",
  "milestone",
];

// Like listCards but fetches only CARD_DISPLAY_FIELDS (body-free); absent fields
// (notably `body`) come back as "" on the Card. Enough for the text board render,
// the board/column/tag/assignee filters, and the dep/blocked fan-out — but NOT
// for any path that must show a card's body. Mirrors listCardStatuses.
export async function listCardsForDisplay(
  node: NodeClient,
  cfg: Config,
  opts: BoardListOpt = {},
): Promise<Card[]> {
  return listCardsWithFields(node, cfg, CARD_DISPLAY_FIELDS, undefined, opts);
}

/**
 * Live cards on every board EXCEPT `viewedBoard` — the `list` footer's read.
 *
 * The footer used to be fed by `listCardsForDisplay`, a cross-board read that
 * fans out over EVERY board partition including the one already on screen, at
 * the wide 24-field BoardCards projection. `otherBoardsFooter` then dropped all
 * of those rows on its first line (`if (c.board === viewedBoard) continue`).
 *
 * On the live board that is not a small waste: `default` holds 783 of the 829
 * rows, and re-reading it is the single most expensive query fkanban makes
 * (measured 2026-07-30: BoardCards `HashKey(default)` is the #1 consumer of
 * node wall time system-wide, avg 615ms/call). Bare `kanban list` issued THREE
 * partition reads where `list --json` — same board, same cards, no footer —
 * issued one. Two of the three existed to render a one-line navigation hint,
 * and the more expensive of those two was a verbatim re-read of the partition
 * the command had already fetched.
 *
 * So: skip the viewed board at the QUERY, not in the reducer, and project only
 * {@link BOARD_CARDS_FOOTER_FIELDS}. Returns `null` when BoardCards cannot
 * serve the read at all (unconfigured schema), so the caller can fall back to
 * the cross-board path rather than silently print no footer — an absent footer
 * is indistinguishable from "no other board has cards".
 *
 * ## Why a failed partition read does not propagate
 *
 * This read exists to render ONE LINE of navigation hint about boards the user
 * is not looking at. It is the last read `list` issues and the only one whose
 * absence costs nothing but the hint. Yet until 2026-08-01 a node error here
 * escaped and took the whole command down: bare `kanban list` exited 1 and
 * printed no board at all because the empty `agent-dogfood-scratch` partition
 * answered this projection with `HTTP 400 … laststore: corrupt: empty rec`,
 * while `default` — every card anyone cares about — had already been read back
 * intact three queries earlier.
 *
 * Three properties made that outage possible at once, and the fix targets the
 * only one that is fkanban's to own:
 *
 * 1. The corrupt marker is LastDB's
 *    ([[papercut-lastdb-corrupt-empty-rec-on-one-lead-field-agent-dogfood-scratch]]).
 * 2. It is reachable ONLY through a narrow projection — the same partition
 *    answers the wide 14- and 22-field reads with 0 rows, cleanly. Narrowing a
 *    projection is not purely a cost win; it changes which index structures the
 *    node must touch, so it can newly EXPOSE damage a wide read never sees.
 * 3. A decorative cross-board read could fail a command whose own board was
 *    fine. That is the bug fixed here.
 *
 * So a per-board failure is neither swallowed nor rethrown — the same contract
 * {@link sweepBoardCardsPartition} settled for `failedLeads`. The slug is
 * RETURNED in `unreadable` and the footer names it, because a board that could
 * not be read must never render as a board with no cards: those are different
 * facts and only one of them is worth acting on.
 */
export async function listOtherBoardCardsForFooter(
  node: NodeClient,
  cfg: Config,
  viewedBoard: string,
  boards: Array<{ slug: string }>,
): Promise<{ cards: Card[]; unreadable: string[] } | null> {
  // An EMPTY board list is "I don't know", not "there are no other boards".
  // The legacy shape (no `board_cards` hash, Board index unserved) discovers
  // other boards from the Card rows themselves, so returning [] here would
  // silently delete the footer for exactly those installs. Fall back instead.
  if (boards.length === 0) return null;
  const others = boards.filter((b) => b.slug !== viewedBoard);
  // A genuine single-board install has nothing to advertise, and the footer
  // renders "" for an empty set. Costs zero reads.
  if (others.length === 0) return { cards: [], unreadable: [] };
  const out: Card[] = [];
  const unreadable: string[] = [];
  for (const b of others) {
    let part: Card[] | null;
    try {
      part = await listBoardCardsPartition(node, cfg, b.slug, {
        fields: BOARD_CARDS_FOOTER_FIELDS,
      });
    } catch {
      // This board's partition is unreadable. Keep the boards that ARE
      // readable, name this one, and let `list` finish — see the note above.
      unreadable.push(b.slug);
      continue;
    }
    if (part === null) return null; // caller falls back to the cross-board read
    for (const c of part) {
      if (isHiddenCard(c)) continue;
      // `board` is the partition key, so it is authoritative here even though
      // the narrow projection carries no title/assignee for these rows. The
      // footer counts by board and renders nothing else.
      out.push(c.board ? c : { ...c, board: b.slug });
    }
  }
  return { cards: out, unreadable };
}

// Point read by slug — the node resolves a HashKey filter as an indexed key
// lookup, so this never scans the board.
export async function findCard(node: NodeClient, cfg: Config, slug: string): Promise<Card | null> {
  return findCardWithFields(node, cfg, slug, fieldsFor("card"));
}

/**
 * Fields a milestone proof-card verdict actually reads: `body` for the
 * `PROOF: PASS` / `DONE-WHEN` evidence, `column`+`board` for terminality,
 * `milestone` for the link-mismatch warning, and `slug`+`tags` because
 * `isHiddenCard` needs them (drop `tags` and a tombstoned card reads as a live
 * proof card).
 *
 * Deliberately narrow, and not only to save bytes: LastDB returns a row only
 * when EVERY projected field has an atom on it, so a 23-field projection makes
 * a card that is merely missing one field read as ABSENT — the exact false
 * negative `cardExists` exists to undo. Six fields is six chances to miss
 * instead of twenty-three. Measured on the live primary 2026-07-31: the wide
 * proof read cost ~236ms, a 6-field read ~120ms.
 */
export const PROOF_CARD_FIELDS = ["slug", "board", "column", "milestone", "tags", "body"];

/** Point-read a milestone's proof card with just the fields the verdict uses. */
export async function findProofCard(
  node: NodeClient,
  cfg: Config,
  slug: string,
): Promise<Card | null> {
  return findCardWithFields(node, cfg, slug, PROOF_CARD_FIELDS);
}

/**
 * Does a Card record exist for `slug`? Projects `slug` and nothing else.
 *
 * Every other card read projects ~20 fields, and LastDB returns a row only if
 * EVERY projected field has an atom on it — so a card missing one field reads
 * as ABSENT, with no error to distinguish it from a card that was deleted.
 * Anywhere that merely asks "does this exist?" that is a false negative, and
 * where the answer authorizes a DELETE it is a false negative that destroys
 * data: `board-cards-heal` treats a missed point-read as proof the card is
 * gone and reaps its board membership, which would silently drop a live card
 * off the board.
 *
 * `slug` is the hash key, so it is present on every row that exists at all.
 * This read cannot produce that false negative. Use it to CONFIRM absence
 * before acting on absence — never to fetch a card.
 */
export async function cardExists(
  node: NodeClient,
  cfg: Config,
  slug: string,
): Promise<boolean> {
  const cards = await listCardsWithFields(node, cfg, ["slug"], { HashKey: slug });
  return cards.some((c) => c.slug === slug);
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

/**
 * Collapse a BoardCards partition to one card per slug — pure, no node reads.
 *
 * Duplicate sks for a slug are an invariant violation (board-cards.ts keeps at
 * most one row per (board, slug)); when one slips through, prefer the fresher
 * `updated_at` rather than first-wins, which used to pin a stale `doing#` ghost
 * ahead of the real `done#` row forever.
 */
function dedupeBoardCardSummaries(cards: Card[]): Card[] {
  const bySlug = new Map<string, Card>();
  for (const card of cards) {
    const prev = bySlug.get(card.slug);
    bySlug.set(card.slug, prev ? preferFresherBoardCard(prev, card) : card);
  }
  return [...bySlug.values()].map((card) =>
    Object.assign({ ...card, body: card.body || "" }, deriveStructuredFields(card)),
  );
}

/**
 * Read model for board/column list previews.
 *
 * **Default: trust the projection.** BoardCards is an app-owned dual-written
 * secondary carrying CARD_FIELDS minus `body` (compare BOARD_CARDS_FIELDS with
 * CARD_FIELDS), and `cardListProjectionFields` strips `body` — so a per-row Card
 * point-read returns exactly the fields the BoardCards row already holds and
 * yields no new data on the happy path. Re-reading Card per row turned one keyed
 * partition query into 1+N serial point-reads: `list --column todo` rendering 10
 * cards cost 11 Card queries / 26.6s against the live node, and a drifted row
 * additionally triggered a full-partition purge scan inside `upsertBoardCard`.
 * Dynamo-shaped reads trust the GSI; drift is repaired by an explicit
 * reconciler, not by the hot read path (`concepts-lastdb-agent-access-model`).
 *
 * `verify: true` opts back into Card-authoritative reconciliation for paths that
 * are *about* drift rather than about rendering. It stays 1+N by construction,
 * so callers must bound the input.
 *
 * On Card miss under `verify`: **keep the BoardCards row and render the thin
 * summary** — never delete. A point-read miss can mean Mini degradation,
 * blind-key issues, or conflicted projection — not a true orphan. Destructive
 * orphan cleanup is only `groom board-cards-heal --apply` (explicit,
 * circuit-breakable). Incident 2026-07-23/24: list scrapers (Factory) deleted
 * ~1k BoardCards rows when Card multi-field reads failed after schema expand +
 * sync stress.
 */
async function reconcileBoardCardSummaries(
  node: NodeClient,
  cfg: Config,
  cards: Card[],
  fields: string[],
  opts: { verify?: boolean } = {},
): Promise<Card[]> {
  // BoardCards rows carry no body — mark them so nothing downstream mistakes
  // `body: ""` for an empty brief (see `Card[BODY_OMITTED]`).
  const deduped = markBodyOmitted(dedupeBoardCardSummaries(cards));
  if (!opts.verify) return deduped;

  const projection = cardListProjectionFields(fields);
  const bodyVerified = projection.includes("body");
  const out: Card[] = [];

  for (const card of deduped) {
    const truth = await findCardWithFields(node, cfg, card.slug, projection);
    if (!truth) {
      // Read-only on miss: surface the BoardCards thin row; do not removeBoardCard.
      out.push(card);
      continue;
    }

    Object.assign(truth, deriveStructuredFields(truth));
    if (!bodyVerified) truth[BODY_OMITTED] = true;
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

/**
 * Point-get bodies for a page of cards (MCP preview / list --full-body).
 *
 * The list read is body-free — BoardCards stores no body — so every card that
 * needs one costs a Card point-read. That is proportional to the page, but the
 * page is NOT always small: `--all` / `all:true` sets the cap to 0, and
 * `capFlat`/`capPerColumn` read 0 as "no cap", so this runs over the whole
 * board (552 cards on the primary as of 2026-07-28).
 *
 * Bounded-parallel for that reason. The previous unbounded `Promise.all` opened
 * one socket per card and tipped Mini into "too many concurrent reads" exactly
 * when the board was largest — the failure scaled with the board, so it stayed
 * invisible until it wasn't. `board_cards_heal` had already learned this and
 * capped itself at 6; this shares that pool rather than rediscovering it.
 */
export async function hydrateCardBodies(
  node: NodeClient,
  cfg: Config,
  cards: Card[],
): Promise<Card[]> {
  return mapWithConcurrency(cards, async (c) => {
    // Only a card whose body was never READ needs a point-read. A card already
    // carrying its stored body — including a stored body that really is empty —
    // is done, and re-reading it would pay N reads to learn nothing.
    if (!isBodyOmitted(c) || c.body.length > 0) return c;
    const full = await findCard(node, cfg, c.slug);
    return full ? withLoadedBody(c, full.body) : c;
  });
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
  // The self-heal below infers a board's existence from cards that point at it,
  // so it is only as trustworthy as those pointers. An EMPTY board slug is not
  // a pointer: a card storing `board: ""` is a card that was never placed —
  // the shape a deadline-truncated write leaves behind — and treating it as
  // evidence would mint a board whose slug is "" as this path's response to
  // data damage. Refuse before the read; nothing legitimate asks for it.
  if (slug.length === 0) {
    throw new FkanbanError({
      code: "board_not_found",
      message: `Board "" does not exist.`,
      hint:
        "An empty board slug means the card was never placed (a truncated write drops fields silently). " +
        "Re-run the write with an explicit --board.",
    });
  }
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

function sortMilestones(milestones: Milestone[]): Milestone[] {
  return milestones.sort(
    (a, b) => Number(a.position || 0) - Number(b.position || 0) || a.slug.localeCompare(b.slug),
  );
}

/**
 * Milestones on one board via BoardMilestones HashRange.
 *
 * When the index is bound and the partition query succeeds, an empty partition
 * is authoritative. The admin-only heal command owns legacy backfill; hot list,
 * portfolio, and gap-report paths must not product-scan Milestone just because
 * an indexed board currently has no rows.
 */
export async function listMilestonesOnBoard(node: NodeClient, cfg: Config, board: string): Promise<Milestone[]> {
  const fromIndex = await listBoardMilestonesPartition(node, cfg, board);
  if (fromIndex !== null) return sortMilestones(fromIndex);
  return (await listMilestones(node, cfg)).filter((m) => m.board === board);
}

/**
 * List milestones without product full-scan when BoardMilestones is bound:
 * one HashRange partition per board. Falls back to Milestone full-scan (+ sparse
 * HashKey hydrate) when the index is unbound or ANY partition query fails.
 *
 * "any", not "every": a board whose partition could not be read has an unknown
 * milestone set, and no other board's success can supply it. See
 * {@link listAllBoardMilestones}.
 */
export async function listMilestones(
  node: NodeClient,
  cfg: Config,
  opts: BoardListOpt = {},
): Promise<Milestone[]> {
  const boards = opts.boards ?? (await listBoards(node, cfg));
  const fromIndex = await listAllBoardMilestones(node, cfg, boards);
  if (fromIndex !== null) return sortMilestones(fromIndex);

  // `null` above means one of two very different things, and substituting the
  // product scan is only right for one of them — the same conflation that
  // `listCardsWithFields` had to unpick (a failed read is not evidence that an
  // index is missing).
  //
  // INDEX BOUND but unreadable => a partition threw. Do NOT fall through. On
  // Cards the product scan is a safe substitute (measured: no rows lost at any
  // projection width). On Milestone it is not, measured on the primary
  // 2026-07-31:
  //
  //   product Milestone scan   62 slugs
  //   BoardMilestones index    32 slugs, every one point-readable and real
  //   in both                   8
  //   index-only               24  <- live milestones the scan CANNOT see,
  //                                   including active ones
  //   scan-only                54  <- slug-only rows carrying no other atom,
  //                                   unreachable by any keyed read
  //
  // So the scan is wrong in BOTH directions here: it would drop 24 real
  // milestones and invent 54 phantoms that `milestone show` cannot open and
  // `requireMilestone` throws on. Answering a transient shed with that is worse
  // than saying we could not read — a caller can retry a failure; it cannot
  // detect a plausible wrong list.
  if (boardMilestonesHash(cfg)) {
    throw new Error(
      "BoardMilestones partition read failed — refusing to answer from the Milestone product scan, " +
        "which on this data misses live milestones and surfaces unreachable slug-only rows. " +
        "This is usually node backpressure (service_timeout / too many concurrent reads): retry. " +
        "If the index is genuinely stale, run `kanban groom milestone-indexes-heal`.",
    );
  }

  // Index UNBOUND (fresh node, pre-backfill) — the case this fallback was
  // written for. Full-scan + sparse hydrate.
  const res = await node.queryAll({
    schemaHash: schemaHashFor("milestone", cfg),
    fields: fieldsFor("milestone"),
    allowFullScan: true,
  });
  const sparse = res.results.some((row) =>
    milestoneQueryFieldsLookSparse((row.fields ?? {}) as Record<string, unknown>),
  );
  let milestones: Milestone[];
  if (!sparse) {
    milestones = res.results.map(rowToMilestone);
  } else {
    milestones = await mapWithConcurrency(res.results, async (row) => {
      const mapped = rowToMilestone(row);
      if (!milestoneQueryFieldsLookSparse((row.fields ?? {}) as Record<string, unknown>)) {
        return mapped;
      }
      const slug = mapped.slug || stringField((row.fields ?? {}) as Record<string, unknown>, "slug");
      if (!slug) return mapped;
      const full = await findMilestone(node, cfg, slug);
      return full ?? mapped;
    });
  }
  return sortMilestones(milestones);
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
  previous?: Milestone | null,
): Promise<void> {
  await node[exists ? "updateRecord" : "createRecord"]({
    schemaHash: schemaHashFor("milestone", cfg),
    keyHash: milestone.slug,
    fields: milestoneToFields(milestone),
  });
  if (boardMilestonesHash(cfg)) {
    // Protein-primary: Mini should fold BoardMilestones tips from the fat
    // Milestone write; we only retire obsolete keyed rows we can address.
    // List / portfolio / gap-report read BoardMilestones only — if fold did
    // not land a membership tip (unbound sibling, missing key fields, lag),
    // the milestone is invisible to factory drivers while still point-readable
    // via `milestone show`. Ensure the index row exists after retire.
    // Brain: papercut-milestone-portfolio-list-undercount.
    await retireBoardMilestoneMembership(node, cfg, milestone, previous ?? null);
    await ensureBoardMilestoneMembership(node, cfg, milestone, previous ?? null);
  } else {
    await upsertBoardMilestone(node, cfg, milestone, previous ?? null);
  }
}

/** Remove fat Milestone + BoardMilestones dual index. */
export async function deleteMilestoneRecord(
  node: NodeClient,
  cfg: Config,
  milestone: Milestone,
): Promise<void> {
  await node.deleteRecord({
    schemaHash: schemaHashFor("milestone", cfg),
    keyHash: milestone.slug,
  });
  await removeBoardMilestone(node, cfg, milestone);
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

/** The projection a legacy schema (one without the optional fields) can answer. */
const CARD_LEGACY_FIELDS: readonly string[] = CARD_FIELDS.filter(
  (f) => !(CARD_OPTIONAL_SCHEMA_FIELDS as readonly string[]).includes(f),
);

/**
 * Read the one Card row for `slug` at the WIDE projection — and treat
 * "not returned" as "not writable narrowly".
 *
 * Same safety gate, and the same reasoning, as
 * {@link readWholeBoardCardRow}: LastDB returns a row only when EVERY
 * projected field has an atom on it, so one wide read answers both questions a
 * narrow write must have answered — does the row exist (a narrow
 * `updateRecord` against a MISSING row does not fail; it silently stores just
 * the subset it was handed, leaving a row every wide reader then drops), and
 * is it whole (a hole must be repaired by a wide write, not patched around).
 *
 * `null` conflates the two deliberately: the caller's answer to both is
 * "write wide", which heals either.
 *
 * This does NOT reuse the `previous` card the callers already have. `previous`
 * is a Card object with no record of the projection it was read through —
 * `BODY_OMITTED` tracks that question for exactly one field, and the other 21
 * have no such marker. Inferring wholeness from an object that cannot state
 * its own provenance is how a thin read becomes silent data loss, so this pays
 * a fresh 214ms read (measured, `scripts/probe-card-write-cost.ts`) to buy an
 * answer it can actually justify.
 */
async function readWholeCardRow(
  node: NodeClient,
  cfg: Config,
  slug: string,
  projected: readonly string[],
): Promise<{ fields: Record<string, unknown>; projected: readonly string[] } | null> {
  const schemaHash = schemaHashFor("card", cfg);
  if (!schemaHash) return null;
  const res = await node.queryAll({
    schemaHash,
    fields: [...projected],
    filter: { HashKey: slug },
  });
  for (const r of res.results) {
    const fields = r.fields as Record<string, unknown>;
    if (fields.slug !== slug) continue;
    // Re-check wholeness rather than inferring it from the row having been
    // returned. The node's projection drop is what makes an incomplete row
    // invisible, but resting this contract on a behaviour nothing local
    // asserts means a node that started returning partial rows would silently
    // turn every narrow write into a hole-preserving patch.
    if (projected.some((f) => fields[f] === undefined || fields[f] === null)) return null;
    return { fields, projected };
  }
  return null;
}

function sameCardValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    const xs = Array.isArray(a) ? a : [];
    const ys = Array.isArray(b) ? b : [];
    return xs.length === ys.length && xs.every((x, i) => x === ys[i]);
  }
  return a === b;
}

/**
 * The subset of `next` that differs from what is stored.
 *
 * `slug` is not re-sent: it addresses the row (it travels as keyHash) and
 * cannot differ here — a slug change is a different record, not an update.
 */
function changedCardFields(
  stored: Record<string, unknown>,
  next: Record<string, unknown>,
  projected: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of projected) {
    if (field === "slug") continue;
    if (!(field in next)) continue;
    if (sameCardValue(stored[field], next[field])) continue;
    out[field] = next[field];
  }
  return out;
}

/**
 * Try to satisfy an update by sending only the fields that changed.
 * Returns `true` when the write is done, `false` to fall through to the wide
 * path (which heals a missing or incomplete row).
 *
 * ## Why this reads before it writes
 *
 * Write cost scales with the number of fields SENT, and `Card` has 22.
 * Measured on the live primary, one uncontended row
 * (`scripts/probe-card-write-cost.ts`):
 *
 * | update | ms |
 * |---|---|
 * | 22 fields, every value changed | 3677 |
 * | 22 fields sent, 2 actually changed (what every card mutation cost) | 3269 |
 * | 3 fields sent (key + 2 changed) | 989 |
 * | 22 fields, every value byte-identical | 148 |
 *
 * The dedupe in that last row is whole-record, not per-molecule
 * (`lastdb-unchanged-value-skip-is-whole-record-not-per-molecule`), so
 * re-sending 20 unchanged fields buys nothing and costs ~200ms each.
 *
 * The `body` is one atom like any other, not a byte cost: the same 2-field
 * update with a 40x larger body (32KB vs 1.3KB) measured 3578ms against
 * 3269ms. So the win here is field COUNT, and it is available to every card
 * mutation — including a move, whose key (`slug`) does not change.
 */
async function writeChangedCardFieldsOnly(
  opts: { cfg: Config; node: NodeClient },
  card: Card,
  schemaHash: string,
  next: Record<string, unknown>,
  projected: readonly string[],
): Promise<boolean> {
  let stored: { fields: Record<string, unknown>; projected: readonly string[] } | null;
  try {
    stored = await readWholeCardRow(opts.node, opts.cfg, card.slug, projected);
  } catch {
    // The probe is an optimization; its failure must never be the reason a
    // write fails. Fall through to the wide path, which either succeeds or
    // surfaces the same fault with its own well-worn fallback machinery.
    return false;
  }
  if (!stored) return false;
  const changed = changedCardFields(stored.fields, next, stored.projected);
  // Nothing changed: the node would no-op this in ~148ms, but a round trip we
  // can prove is pointless is a round trip not worth taking.
  if (Object.keys(changed).length === 0) return true;
  await opts.node.updateRecord({ schemaHash, fields: changed, keyHash: card.slug });
  return true;
}

async function writeCardRecordWithOptionalFieldFallback(
  opts: { cfg: Config; node: NodeClient },
  card: Card,
  op: CardWriteOp,
  expected?: CasExpectation,
): Promise<void> {
  // Single choke point for every card write. `cardToFields` emits the WHOLE
  // record, so persisting a body-free projection silently blanks the stored
  // brief — the failure mode `rank`, `migrate area-tags`, `groom --apply` and
  // `pickup claim` each had, invisibly, because a thin card and a genuinely
  // empty one look identical. Refuse here rather than at four call sites, so
  // no future caller can reintroduce it.
  assertBodyLoaded(card, `writing card "${card.slug}"`);
  const hash = schemaHashFor("card", opts.cfg);
  // A hash already proven to reject the optional fields writes the legacy
  // shape directly — the full-shape attempt would fail the same way it did
  // when the memo was recorded (same hash ⇒ same field set).
  const legacyShape = opts.cfg.cardLegacyWriteHash === hash;
  // Narrow path: send only what changed. Skipped for a create (the row does
  // not exist, so there is nothing to diff and the probe could only ever
  // return "absent") and whenever a CAS expectation is in play — the node
  // checks CAS against stored state rather than the payload, but no caller
  // passes `expected` today, so narrowing it would ship a behaviour nothing
  // exercises. Give it back its wide write until something needs otherwise.
  if (op === "updateRecord" && !expected) {
    const done = await writeChangedCardFieldsOnly(
      opts,
      card,
      hash,
      legacyShape ? cardToLegacyOptionalFields(card) : cardToFields(card),
      legacyShape ? CARD_LEGACY_FIELDS : CARD_FIELDS,
    );
    if (done) return;
  }
  if (legacyShape) {
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
  // wideWrite: this sk was just minted for a card that did not exist, so there
  // is nothing to diff against and the pre-write probe read would only cost a
  // round trip to learn "absent".
  await writeCardMembership(opts, card, null, { skipOrphanPurge: true, wideWrite: true });
}

/**
 * State the keyed membership rows this card should have.
 *
 * **Protein-primary multi-key path** (docs/app-developers-multi-key-proteins.md):
 *
 * 1. Write **BoardCards** with the full thin payload, including `milestone` and
 *    `sk`, so Mini can fold shared field tips onto MilestoneCards.
 * 2. **Retire** obsolete MilestoneCards tips (milestone cleared or sk moved) —
 *    delete only; do not dual-write the full MilestoneCards payload here.
 * 3. Never call protein control routes — bind/fold/backfill are the node's job.
 *
 * Heal commands may still call `upsertMilestoneCard` to rebuild drift.
 * test/no-protein-reach.test.ts and test/protein-primary-membership.test.ts
 * pin this arrangement.
 */
async function writeCardMembership(
  opts: { cfg: Config; node: NodeClient },
  card: Card,
  previous: Card | null,
  writeOpts: BoardCardWriteOptions = {},
): Promise<void> {
  await upsertBoardCard(opts.node, opts.cfg, card, previous, writeOpts);
  await retireMilestoneCardMembership(opts.node, opts.cfg, card, previous);
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
  await writeCardMembership(opts, card, previous ?? null);
}

/**
 * The fields a membership REMOVAL is keyed by, and nothing else.
 *
 * `board` and `column`/`position` are BoardCards spine fields, so a thin row
 * already carries them. `milestone` is the one that is not: it is the
 * MilestoneCards PARTITION KEY and it is absent from every thin projection in
 * this app. Read narrow — six fields is the whole question.
 */
const CARD_MEMBERSHIP_KEY_FIELDS = ["slug", "board", "column", "position", "milestone"] as const;

/**
 * Remove Card + BoardCards + MilestoneCards membership (payload indexes only).
 *
 * **Why this re-reads the card it was just handed.** The two index removals key
 * off different fields, and only one of them is guaranteed to be on the object:
 *
 *   removeBoardCard      partition = card.board       BoardCards SPINE, always projected
 *   removeMilestoneCard  partition = card.milestone   NOT in the spine
 *
 * and `removeMilestoneCard` opens with `if (!ms) return`. LastDB returns "" for
 * a field the caller did not project, so that guard cannot tell "no milestone"
 * from "you did not ask" — and two of this function's three callers hand it a
 * thin BoardCards row (`archive-done` via ARCHIVE_AGE_FIELDS, `board rm
 * --force` via listCards). Both projections omit `milestone`.
 *
 * The result was not a failure but silent permanent drift: the Card goes away
 * and its MilestoneCards row stays, and nothing can key its partition afterward
 * because the Card that named it is gone. Measured on the primary 2026-08-01,
 * `scripts/probe-archive-orphans-milestone-membership.ts`: 66 orphan rows, 63
 * of them in the terminal column archive-done sweeps.
 *
 * This is the same refusal `readWholeCardRow` already makes on the write path —
 * "inferring wholeness from an object that cannot state its own provenance is
 * how a thin read becomes silent data loss". A delete is rare (archive-done is
 * capped; `rm` is manual), so one narrow point-read is the cheapest honest
 * answer available. On a miss the caller's card stands: a Card that is already
 * gone cannot be re-derived, and refusing to clean up would be strictly worse.
 *
 * **Both milestones, not the better one.** The Card record is the authority on
 * where this card belongs, but the caller's object is still evidence of where
 * it USED to. Retiring a slug from a partition it does not occupy is a no-op,
 * and `removeMilestoneCard` only ever touches rows carrying this slug — so
 * there is no cost to honouring a stale hint and a permanent orphan to pay for
 * discarding one. The read exists to ADD the partition the caller could not
 * name, never to overrule one it did.
 */
export async function deleteCardRecord(
  opts: { cfg: Config; node: NodeClient },
  card: Card,
): Promise<void> {
  const hash = schemaHashFor("card", opts.cfg);
  const truth = await readCardMembershipKeys(opts.node, opts.cfg, card);
  await opts.node.deleteRecord({ schemaHash: hash, keyHash: card.slug });
  await patchCardListIndex(opts.node, opts.cfg, card, "remove");
  await removeBoardCard(opts.node, opts.cfg, truth);
  for (const milestone of membershipPartitionsToRetire(card, truth)) {
    await removeMilestoneCard(opts.node, opts.cfg, { ...truth, milestone });
  }
}

/** Every MilestoneCards partition that could hold a row for this slug. */
function membershipPartitionsToRetire(card: Card, truth: Card): string[] {
  const out: string[] = [];
  for (const ms of [truth.milestone, card.milestone]) {
    const trimmed = (ms ?? "").trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * The card's own membership keys, read from the Card record rather than trusted
 * from the caller's object. Falls back to `card` when the Card row is missing
 * or unreadable — a best-effort cleanup beats none.
 */
async function readCardMembershipKeys(
  node: NodeClient,
  cfg: Config,
  card: Card,
): Promise<Card> {
  const hash = schemaHashFor("card", cfg);
  if (!hash || !card.slug) return card;
  try {
    const res = await node.queryAll({
      schemaHash: hash,
      fields: [...CARD_MEMBERSHIP_KEY_FIELDS],
      filter: { HashKey: card.slug },
    });
    for (const row of res.results ?? []) {
      const f = (row.fields ?? {}) as Record<string, unknown>;
      if (String(f.slug ?? "") !== card.slug) continue;
      return {
        ...card,
        board: String(f.board ?? "") || card.board,
        column: String(f.column ?? "") || card.column,
        position: String(f.position ?? "") || card.position,
        // Deliberately NOT `|| card.milestone` — the caller's value is not lost,
        // it is carried separately by `membershipPartitionsToRetire`. Folding it
        // in here would make the two indistinguishable and the "retire both"
        // decision unstatable.
        milestone: String(f.milestone ?? ""),
      };
    }
  } catch {
    // Read-side failure must not strand the delete; fall through to the caller's
    // card, which is what this function did unconditionally before.
  }
  return card;
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
