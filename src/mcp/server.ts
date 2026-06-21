// MCP server for fkanban — exposes the board as tools to MCP clients
// (Claude Code, Codex, etc.) over stdio. Each handler calls the in-process
// command function, so an agent sees the same result as the matching
// `fkanban` subcommand.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { FkanbanError, newNodeClient, type NodeClient, type Verbose } from "../client.ts";
import { readConfig, resolveSocketPath, ConfigMissingError, ConfigInvalidError, type Config } from "../config.ts";
import { addCmd } from "../commands/add.ts";
import { moveCmd } from "../commands/move.ts";
import { listResult } from "../commands/list.ts";
import { searchResult } from "../commands/search.ts";
import { showResult } from "../commands/show.ts";
import { rmCmd } from "../commands/rm.ts";
import { boardCreateCmd, boardListResult, boardRmCmd } from "../commands/board.ts";
import { depAddCmd, depRmCmd } from "../commands/dep.ts";
import { tagAddCmd, tagRmCmd } from "../commands/tag.ts";
import { runDoctorStructured } from "../commands/doctor.ts";
import { orphanedDependentsWarning, type Card } from "../record.ts";
import { capFlat, DEFAULT_SEARCH_LIMIT } from "../board.ts";

export const FKANBAN_MCP_NAME = "fkanban";
export const FKANBAN_MCP_VERSION = "0.1.0";

// Server-level orientation surfaced to the model in the `initialize` result.
// Keep this SHORT — hosts inject it into context every session, so verbosity
// costs tokens for every user. Point at the tools; don't restate each one.
export const FKANBAN_MCP_INSTRUCTIONS = [
  "fkanban is a kanban board over fold_db. 14 tools: read tools",
  "(fkanban_list, fkanban_search, fkanban_show, fkanban_board_list, fkanban_doctor)",
  "never mutate; the rest (add, move, rm, dep_add, dep_rm, tag_add, tag_rm, board_create, board_rm) write.",
  "",
  "Board model: a card lives on a board, in one column, at a position. Columns flow",
  "backlog → todo → doing → review → done.",
  "",
  "Blocking: a card with an unfinished dependency cannot enter doing/review/done",
  "unless `force:true` is passed.",
  "",
  "Token economy (read this before fetching): fkanban_list and fkanban_search default-cap",
  "structuredContent.cards to 20 (the `total`/`truncated` fields signal there are more —",
  "widen with `limit` or `all:true`), and return each `body` as a ~200-char single-line",
  "preview (`bodyTruncated`). Pass `full_body:true` for complete bodies, or call",
  "fkanban_show <slug> for one card's full body. Prefer fkanban_show over full_body when",
  "you only need one card — it's cheaper.",
  "",
  "Discovery: if anything seems misconfigured, start with fkanban_doctor.",
].join("\n");

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

// Write tools return BOTH a machine-readable result object (structuredContent,
// matching the tool's declared outputSchema — the same shape the CLI emits
// under `--json`) AND a human-readable text block, so MCP clients that don't
// read structuredContent still get a useful rendering.
function writeResult(text: string, structured: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: text.length > 0 ? text : "(no output)" }], structuredContent: structured };
}

// Read tools mirror the write-tool precedent: alongside the unchanged
// human-readable text block, return `structuredContent` (the same shape the CLI
// emits under `--json`, validated against the tool's declared outputSchema).
// MCP requires structuredContent to be an object, so list/search/board_list
// wrap their arrays as `{ cards }` / `{ boards }`; show returns the card object.
function readResult(text: string, structured: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: text.length > 0 ? text : "(no output)" }], structuredContent: structured };
}

// Cap the structured card array the AGENT consumes. The human `text` block is
// already capped (#69's DEFAULT_SEARCH_LIMIT + "… N more" footer); the
// machine-readable `cards` array was NOT, so a single `fkanban_search`/
// `fkanban_list` on a real board (160+ cards, each with its full `body`) dumps
// ~160K tokens and evicts the caller's working context. Default to a sane cap
// (DEFAULT_SEARCH_LIMIT) reusing the existing `capFlat`, with an explicit
// opt-out, and ALWAYS report `total`/`truncated` so the cap is never silent
// (mirrors `fbrain_get`'s `bodyTruncated`/`bodyTotalChars` precedent).
//
// `limit`: undefined → default cap; an explicit value caps to it; `0` (like
// `all`) returns the complete set. `all` short-circuits to the complete set.
function capCards<T extends Card>(
  cards: T[],
  opts: { limit?: number; all?: boolean },
): { cards: T[]; total: number; truncated: boolean } {
  const total = cards.length;
  const cap = opts.all
    ? 0
    : Number.isFinite(opts.limit) && (opts.limit as number) >= 0
      ? (opts.limit as number)
      : DEFAULT_SEARCH_LIMIT;
  const capped = capFlat(cards, cap);
  return { cards: capped, total, truncated: capped.length < total };
}

// Even after #70's COUNT cap, the per-card `body` dominates a list/search
// payload — on the live 167-card board a default 20-card page was ~16.4K tokens,
// 87% of which was full card bodies (each multi-KB spec). The agent-facing
// multi-card read tools (`fkanban_list`/`fkanban_search`) don't need the full
// body to triage a board — they need to see WHICH cards exist and a hint of
// each. So by default we ship a short, single-lined `body` PREVIEW plus a
// `bodyTruncated` flag, and point the agent at `fkanban_show <slug>` for the
// full body (mirrors fbrain_search's snippet vs fbrain_get's full record).
// `full_body:true` opts back into the complete body per card for the rare agent
// that genuinely needs it inline. The single-card `fkanban_show` is unchanged
// (always full body). The CLI `list --json`/`search --json` are also unchanged
// (full bodies — they feed scripts, not a token budget).
const BODY_PREVIEW_CHARS = 200;

// Collapse newlines/runs of whitespace to single spaces (so a preview is one
// line) and truncate to BODY_PREVIEW_CHARS. Returns the (possibly) shortened
// body plus whether it was truncated against the ORIGINAL untouched body.
function previewBody(body: string): { body: string; bodyTruncated: boolean } {
  const flattened = body.replace(/\s+/g, " ").trim();
  if (flattened.length <= BODY_PREVIEW_CHARS) {
    // Note: when the only change was whitespace-collapsing (no length cut), the
    // body still wasn't dropped, so this is not "truncated" content-wise. Flag
    // truncation strictly on a length cut against the flattened single-line form.
    return { body: flattened, bodyTruncated: false };
  }
  return { body: flattened.slice(0, BODY_PREVIEW_CHARS), bodyTruncated: true };
}

// Apply the body-preview transform to each card unless `full_body` is set. Each
// previewed card gains a `bodyTruncated: boolean`; a full-body card sets it
// false (the field is always present so the shape is stable for the schema).
function previewBodies<T extends Card>(cards: T[], fullBody: boolean): Array<T & { bodyTruncated: boolean }> {
  if (fullBody) return cards.map((c) => ({ ...c, bodyTruncated: false }));
  return cards.map((c) => {
    const { body, bodyTruncated } = previewBody(c.body);
    return { ...c, body, bodyTruncated };
  });
}

// Card shape the CLI `--json` emits (mirrors the `Card` type in record.ts).
const cardShape = {
  slug: z.string(),
  title: z.string(),
  body: z.string(),
  board: z.string(),
  column: z.string(),
  position: z.string(),
  assignee: z.string(),
  tags: z.array(z.string()),
  deps: z.array(z.string()),
  created_at: z.string(),
  updated_at: z.string(),
} as const;
const cardSchema = z.object(cardShape);

// `show --json` adds resolved dependency status to the card.
const cardDetailSchema = cardSchema.extend({
  blocked: z.boolean(),
  blockedBy: z.array(z.string()),
  missingDeps: z.array(z.string()),
});

const boardSchema = z.object({
  slug: z.string(),
  title: z.string(),
  body: z.string(),
  columns: z.array(z.string()),
  created_at: z.string(),
  updated_at: z.string(),
});

// Required string args are declared `.optional()` (no Zod `.min(1)`) so an
// empty OR missing value reaches the handler instead of the SDK's pre-handler
// validation, which would dump a raw `MCP error -32602: Input validation
// error … (too_small | invalid_type … received undefined)` Zod blob. Each
// handler calls this at the top of its `try` to turn a missing or
// empty/whitespace-only required arg into a voiced FkanbanError — the same
// `error:`/`hint:` shape `errorResult` produces for every domain error, and
// matching the CLI's `Missing argument — usage: …` voice.
function requireArg(
  value: string | undefined,
  name: string,
  usage: string,
): string {
  if (value == null || value.trim().length === 0) {
    throw new FkanbanError({
      code: "missing_argument",
      message: `Missing ${name}.`,
      hint: usage,
    });
  }
  return value;
}

function errorResult(err: unknown): ToolResult {
  const msg =
    err instanceof FkanbanError
      ? err.message + (err.hint ? `\nhint: ${err.hint}` : "")
      : err instanceof Error
        ? err.message
        : String(err);
  return { content: [{ type: "text", text: `error: ${msg}` }], isError: true };
}

// Build the server in one of two states:
//   - configured:   `{ cfg, node? }` — full behavior (the steady state).
//   - not-yet-configured: `{ configError }` — the server still starts and
//     completes the MCP handshake so the client connects and can list tools,
//     but every config-dependent tool short-circuits to a clean `isError`
//     result carrying the "Run `fkanban init` first." hint. `fkanban_doctor`
//     stays usable in this state (it reads config itself via `tryReadConfig`),
//     so an agent can self-diagnose the missing config.
export function createFkanbanMcpServer(
  opts: { cfg: Config; node?: NodeClient; configError?: undefined } | { cfg?: undefined; node?: undefined; configError: Error },
): McpServer {
  const cfg = opts.cfg ?? null;
  const configError = opts.configError ?? null;
  const explicitNode = opts.cfg ? opts.node : undefined;
  // Lazily materialize the client only when a tool actually runs; when config
  // is unavailable, throw a FkanbanError that the handlers' catch turns into a
  // clean per-tool `isError` result.
  const requireConfig = (): { cfg: Config; node: NodeClient } => {
    if (!cfg) {
      throw new FkanbanError({
        code: "config_unavailable",
        message: configError ? configError.message : "config unavailable",
        hint: "Run `fkanban init` first.",
      });
    }
    const node = explicitNode ?? newNodeClient({ baseUrl: cfg.nodeUrl, userHash: cfg.userHash, socketPath: resolveSocketPath(cfg) });
    return { cfg, node };
  };
  const server = new McpServer(
    { name: FKANBAN_MCP_NAME, version: FKANBAN_MCP_VERSION },
    { instructions: FKANBAN_MCP_INSTRUCTIONS },
  );

  server.registerTool(
    "fkanban_list",
    {
      title: "Show kanban board",
      description:
        "Render a kanban board as columns of cards. Cards are grouped under their column (backlog → todo → doing → review → done) in position order. Each card carries its resolved dependency status (`blocked`, `blockedBy`, `missingDeps`) — the same fields `fkanban_show` returns — so a caller can pick the next *workable* card without a per-card show. To keep the payload small, each card's `body` is a short single-line PREVIEW (first ~200 chars) with a `bodyTruncated` flag; call `fkanban_show <slug>` for the full body, or pass `full_body:true` to inline complete bodies.",
      annotations: { title: "Show kanban board", readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        board: z.string().optional().describe("Board slug (default: `default`)."),
        column: z.string().optional().describe("Restrict to one column."),
        tag: z
          .string()
          .optional()
          .describe(
            "Restrict to cards carrying this exact tag (membership match, not the fuzzy text search of `fkanban_search`).",
          ),
        assignee: z.string().optional().describe("Restrict to cards assigned to this exact person."),
        limit: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Cap on returned cards (default 20). An unbounded board overflows context — `0` returns the complete set (same as `all`).",
          ),
        all: z.boolean().optional().describe("Return every matching card, uncapped (overrides `limit`)."),
        full_body: z
          .boolean()
          .optional()
          .describe(
            "Return each card's complete `body` instead of the default ~200-char single-line preview. Off by default — bodies are the bulk of a page's tokens; use `fkanban_show <slug>` for one full body.",
          ),
      },
      outputSchema: {
        cards: z
          .array(cardDetailSchema.extend({ bodyTruncated: z.boolean() }))
          .describe(
            "Matching cards, in column + position order, each with resolved dependency status (capped — see `total`/`truncated`). By default `body` is a single-line ~200-char preview and `bodyTruncated` says whether it was shortened; pass `full_body:true` for complete bodies (then `bodyTruncated` is always false). Use `fkanban_show <slug>` for one card's full body.",
          ),
        total: z.number().describe("Total matching cards before the cap."),
        truncated: z.boolean().describe("True when the cap dropped cards — re-call with a higher `limit` or `all` for the rest."),
      },
    },
    async (args) => {
      try {
        const { cfg, node } = requireConfig();
        const o: Parameters<typeof listResult>[0] = { cfg, node };
        if (args.board) o.board = args.board;
        if (args.column) o.column = args.column;
        if (args.tag) o.tag = args.tag;
        if (args.assignee) o.assignee = args.assignee;
        const { text, cards } = await listResult(o);
        // Cap the agent-facing structured array (cards already in column +
        // position order, so `capFlat` slicing keeps ordering intact). The
        // human `text` is independently capped already.
        const { cards: capped, total, truncated } = capCards(cards, { limit: args.limit, all: args.all });
        // Then preview each card's body (the bulk of the payload) unless the
        // caller opted into full bodies.
        const previewed = previewBodies(capped, args.full_body ?? false);
        return readResult(text, { cards: previewed, total, truncated });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "fkanban_search",
    {
      title: "Search cards",
      description:
        "Find cards by a case-insensitive substring match across slug, title, body, assignee, and tags. Multi-word queries are AND-matched (every term must appear). Results span columns/boards; each is annotated with its `[board/column]`. To keep the payload small, each match's `body` is a short single-line PREVIEW (first ~200 chars) with a `bodyTruncated` flag; call `fkanban_show <slug>` for the full body, or pass `full_body:true` to inline complete bodies.",
      annotations: { title: "Search cards", readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        query: z.string().optional().describe("Search text. Space-separated terms are all required (AND)."),
        board: z.string().optional().describe("Restrict to one board."),
        column: z.string().optional().describe("Restrict to one column."),
        limit: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Cap on returned matches (default 20). A broad query overflows context — `0` returns the complete set (same as `all`).",
          ),
        all: z.boolean().optional().describe("Return every match, uncapped (overrides `limit`)."),
        full_body: z
          .boolean()
          .optional()
          .describe(
            "Return each match's complete `body` instead of the default ~200-char single-line preview. Off by default — bodies are the bulk of a result's tokens; use `fkanban_show <slug>` for one full body.",
          ),
      },
      outputSchema: {
        cards: z
          .array(cardSchema.extend({ bodyTruncated: z.boolean() }))
          .describe(
            "Matching cards across boards/columns (capped — see `total`/`truncated`). By default `body` is a single-line ~200-char preview and `bodyTruncated` says whether it was shortened; pass `full_body:true` for complete bodies (then `bodyTruncated` is always false). Use `fkanban_show <slug>` for one card's full body.",
          ),
        total: z.number().describe("Total matches before the cap."),
        truncated: z.boolean().describe("True when the cap dropped matches — re-call with a higher `limit` or `all` for the rest."),
      },
    },
    async (args) => {
      try {
        const query = requireArg(args.query, "search query", "Pass a non-empty `query`.");
        const { cfg, node } = requireConfig();
        const o: Parameters<typeof searchResult>[0] = { cfg, node, query };
        if (args.board) o.board = args.board;
        if (args.column) o.column = args.column;
        const { text, cards } = await searchResult(o);
        // Cap the agent-facing structured array (matches already sorted); the
        // human `text` is independently capped already.
        const { cards: capped, total, truncated } = capCards(cards, { limit: args.limit, all: args.all });
        // Then preview each card's body (the bulk of the payload) unless the
        // caller opted into full bodies.
        const previewed = previewBodies(capped, args.full_body ?? false);
        return readResult(text, { cards: previewed, total, truncated });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "fkanban_add",
    {
      title: "Add or update a card",
      description:
        "Create a card (or update it if the slug exists). Defaults: board=`default`, column=the board's first column. A card blocked by an unfinished dependency cannot be placed in doing/review/done unless `force` is set.",
      annotations: { title: "Add or update a card", idempotentHint: true, openWorldHint: false },
      inputSchema: {
        slug: z.string().optional().describe("Stable card id (lowercase [a-z0-9-_])."),
        title: z.string().optional().describe("Card title."),
        body: z.string().optional().describe("Markdown description / notes."),
        board: z.string().optional().describe("Board slug (default: `default`)."),
        column: z.string().optional().describe("Column to place the card in."),
        assignee: z.string().optional().describe("Who owns the card."),
        tags: z.array(z.string()).optional().describe("Freeform labels."),
        deps: z
          .array(z.string())
          .optional()
          .describe(
            "Slugs this card depends on (replaces the existing dep list). It is blocked until each reaches `done`.",
          ),
        force: z.boolean().optional().describe("Place the card even if it is blocked by an unfinished dependency."),
      },
      outputSchema: {
        slug: z.string(),
        action: z.enum(["created", "updated"]),
        board: z.string(),
        column: z.string(),
      },
    },
    async (args) => {
      try {
        const slug = requireArg(args.slug, "card slug", "Pass a non-empty `slug`.");
        const { cfg, node } = requireConfig();
        const o: Parameters<typeof addCmd>[0] = { cfg, node, slug };
        if (args.title !== undefined) o.title = args.title;
        if (args.body !== undefined) o.body = args.body;
        if (args.board !== undefined) o.board = args.board;
        if (args.column !== undefined) o.column = args.column;
        if (args.assignee !== undefined) o.assignee = args.assignee;
        if (args.tags !== undefined) o.tags = args.tags;
        if (args.deps !== undefined) o.deps = args.deps;
        if (args.force !== undefined) o.force = args.force;
        const res = await addCmd(o);
        return writeResult(`${res.action} card ${res.slug} → ${res.board}/${res.column}`, res);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "fkanban_move",
    {
      title: "Move a card",
      description:
        "Move a card to a different column on its board. A card blocked by an unfinished dependency cannot move into doing/review/done unless `force` is set.",
      annotations: { title: "Move a card", idempotentHint: true, openWorldHint: false },
      inputSchema: {
        slug: z.string().optional().describe("Card slug."),
        column: z.string().optional().describe("Target column."),
        position: z.number().int().optional().describe("Explicit ordering within the column."),
        force: z.boolean().optional().describe("Move even if the card is blocked by an unfinished dependency."),
      },
      outputSchema: {
        slug: z.string(),
        from: z.string(),
        to: z.string(),
      },
    },
    async (args) => {
      try {
        const slug = requireArg(args.slug, "card slug", "Pass a non-empty `slug`.");
        const column = requireArg(args.column, "target column", "Pass a non-empty `column`.");
        const { cfg, node } = requireConfig();
        const o: Parameters<typeof moveCmd>[0] = { cfg, node, slug, column };
        if (args.position !== undefined) o.position = args.position;
        if (args.force !== undefined) o.force = args.force;
        const res = await moveCmd(o);
        return writeResult(`moved ${res.slug}: ${res.from} → ${res.to}`, res);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "fkanban_dep_add",
    {
      title: "Add a dependency",
      description:
        "Make `slug` depend on `dep`. `slug` is then blocked (cannot enter doing/review/done) until `dep` reaches the `done` column.",
      annotations: { title: "Add a dependency", idempotentHint: true, openWorldHint: false },
      inputSchema: {
        slug: z.string().optional().describe("The dependent card."),
        dep: z.string().optional().describe("The card it depends on (must reach `done` first)."),
      },
      outputSchema: {
        slug: z.string(),
        dep: z.string(),
        action: z.enum(["added", "removed"]),
        deps: z.array(z.string()),
      },
    },
    async (args) => {
      try {
        const slug = requireArg(args.slug, "dependent card slug", "Pass a non-empty `slug`.");
        const dep = requireArg(args.dep, "dependency slug", "Pass a non-empty `dep`.");
        const { cfg, node } = requireConfig();
        const res = await depAddCmd({ cfg, node, slug, dep });
        return writeResult(`${res.slug} now depends on ${res.dep} (deps: ${res.deps.join(", ") || "none"})`, res);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "fkanban_dep_rm",
    {
      title: "Remove a dependency",
      description: "Remove the dependency edge from `slug` to `dep`.",
      annotations: { title: "Remove a dependency", idempotentHint: true, openWorldHint: false },
      inputSchema: {
        slug: z.string().optional().describe("The dependent card."),
        dep: z.string().optional().describe("The dependency to remove."),
      },
      outputSchema: {
        slug: z.string(),
        dep: z.string(),
        action: z.enum(["added", "removed"]),
        deps: z.array(z.string()),
      },
    },
    async (args) => {
      try {
        const slug = requireArg(args.slug, "dependent card slug", "Pass a non-empty `slug`.");
        const dep = requireArg(args.dep, "dependency slug", "Pass a non-empty `dep`.");
        const { cfg, node } = requireConfig();
        const res = await depRmCmd({ cfg, node, slug, dep });
        return writeResult(`${res.slug} no longer depends on ${res.dep} (deps: ${res.deps.join(", ") || "none"})`, res);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "fkanban_tag_add",
    {
      title: "Add tags",
      description:
        "Add one or more tags to a card WITHOUT replacing its existing tags (the incremental counterpart to `fkanban_add`'s `tags`, which replaces the whole list — the same relationship `fkanban_dep_add` has to `add`'s `deps`). Adding a tag the card already carries is a no-op. Reserved tags (`dep:<slug>` dependency edges, the delete tombstone) are rejected — use `fkanban_dep_add`/`fkanban_rm` for those.",
      annotations: { title: "Add tags", idempotentHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        slug: z.string().optional().describe("The card to tag."),
        tags: z.array(z.string()).optional().describe("One or more tags to union into the card's tags."),
      },
      outputSchema: {
        slug: z.string(),
        tag: z.array(z.string()),
        action: z.enum(["added", "removed"]),
        tags: z.array(z.string()),
      },
    },
    async (args) => {
      try {
        const slug = requireArg(args.slug, "card slug", "Pass a non-empty `slug`.");
        if (args.tags == null || args.tags.length === 0) {
          throw new FkanbanError({ code: "missing_argument", message: "Missing tags.", hint: "Pass a non-empty `tags` array." });
        }
        const { cfg, node } = requireConfig();
        const res = await tagAddCmd({ cfg, node, slug, tag: args.tags });
        return writeResult(`tagged ${res.slug} ${res.tag.join(", ") || "nothing"} (tags: ${res.tags.join(", ") || "none"})`, res);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "fkanban_tag_rm",
    {
      title: "Remove tags",
      description:
        "Remove one or more tags from a card without disturbing the rest. Removing a tag the card doesn't carry is a no-op (it succeeds).",
      annotations: { title: "Remove tags", idempotentHint: true, destructiveHint: true, openWorldHint: false },
      inputSchema: {
        slug: z.string().optional().describe("The card to untag."),
        tags: z.array(z.string()).optional().describe("One or more tags to remove from the card's tags."),
      },
      outputSchema: {
        slug: z.string(),
        tag: z.array(z.string()),
        action: z.enum(["added", "removed"]),
        tags: z.array(z.string()),
      },
    },
    async (args) => {
      try {
        const slug = requireArg(args.slug, "card slug", "Pass a non-empty `slug`.");
        if (args.tags == null || args.tags.length === 0) {
          throw new FkanbanError({ code: "missing_argument", message: "Missing tags.", hint: "Pass a non-empty `tags` array." });
        }
        const { cfg, node } = requireConfig();
        const res = await tagRmCmd({ cfg, node, slug, tag: args.tags });
        return writeResult(`untagged ${res.slug} ${res.tag.join(", ") || "nothing"} (tags: ${res.tags.join(", ") || "none"})`, res);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "fkanban_show",
    {
      title: "Show a card",
      description: "Print one card in detail by slug, including its dependencies and blocked state.",
      annotations: { title: "Show a card", readOnlyHint: true, openWorldHint: false },
      inputSchema: { slug: z.string().optional().describe("Card slug.") },
      outputSchema: cardDetailSchema.shape,
    },
    async (args) => {
      try {
        const slug = requireArg(args.slug, "card slug", "Pass a non-empty `slug`.");
        const { cfg, node } = requireConfig();
        const { text, card } = await showResult({ cfg, node, slug });
        return readResult(text, card);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "fkanban_rm",
    {
      title: "Delete a card",
      description: "Soft-delete a card (fold_db is append-only; the card is tombstoned and hidden).",
      annotations: { title: "Delete a card", destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: { slug: z.string().optional().describe("Card slug.") },
      outputSchema: {
        slug: z.string(),
        orphanedDependents: z
          .array(z.string())
          .describe("Live cards that still depend on the deleted card — now dangling."),
      },
    },
    async (args) => {
      try {
        const slug = requireArg(args.slug, "card slug", "Pass a non-empty `slug`.");
        const { cfg, node } = requireConfig();
        const res = await rmCmd({ cfg, node, slug });
        const text =
          res.orphanedDependents.length > 0
            ? `removed card ${res.slug}\n${orphanedDependentsWarning(res.slug, res.orphanedDependents)}`
            : `removed card ${res.slug}`;
        return writeResult(text, res);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "fkanban_board_create",
    {
      title: "Create or update a board",
      description: "Create a board (or update it). Columns default to backlog → todo → doing → review → done.",
      annotations: { title: "Create or update a board", idempotentHint: true, openWorldHint: false },
      inputSchema: {
        slug: z.string().optional().describe("Board slug."),
        title: z.string().optional().describe("Board title."),
        columns: z.array(z.string()).optional().describe("Ordered column names."),
        body: z.string().optional().describe("Markdown description."),
      },
      outputSchema: {
        slug: z.string(),
        action: z.enum(["created", "updated"]),
      },
    },
    async (args) => {
      try {
        const slug = requireArg(args.slug, "board slug", "Pass a non-empty `slug`.");
        const { cfg, node } = requireConfig();
        const o: Parameters<typeof boardCreateCmd>[0] = { cfg, node, slug };
        if (args.title !== undefined) o.title = args.title;
        if (args.columns !== undefined) o.columns = args.columns;
        if (args.body !== undefined) o.body = args.body;
        const res = await boardCreateCmd(o);
        return writeResult(`${res.action} board ${res.slug}`, res);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "fkanban_board_list",
    {
      title: "List boards",
      description: "List every board with its columns.",
      annotations: { title: "List boards", readOnlyHint: true, openWorldHint: false },
      inputSchema: {},
      outputSchema: { boards: z.array(boardSchema).describe("Every live board with its columns.") },
    },
    async () => {
      try {
        const { cfg, node } = requireConfig();
        const { text, boards } = await boardListResult({ cfg, node });
        return readResult(text, { boards });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "fkanban_board_rm",
    {
      title: "Delete a board",
      description:
        "Soft-delete a board (fold_db is append-only; the board is tombstoned and hidden). " +
        "Refuses the default board, and refuses a board with live cards unless force is set.",
      annotations: { title: "Delete a board", destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        slug: z.string().optional().describe("Board slug."),
        force: z.boolean().optional().describe("Remove even if the board still has live cards."),
      },
      outputSchema: { slug: z.string() },
    },
    async (args) => {
      try {
        const slug = requireArg(args.slug, "board slug", "Pass a non-empty `slug`.");
        const { cfg, node } = requireConfig();
        const res = await boardRmCmd({ cfg, node, slug, force: args.force });
        return writeResult(`removed board ${res.slug}`, res);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "fkanban_doctor",
    {
      title: "Health-check fkanban",
      description:
        "Diagnose the fkanban setup the same way the `fkanban doctor` CLI does: config present, node reachable + provisioned, both schemas loaded + matching config, and a query round-trip. Returns the full check report; `isError` is set when any check fails. Run this first when other fkanban tools start erroring.",
      annotations: { title: "Health-check fkanban", readOnlyHint: true, openWorldHint: false },
      inputSchema: {},
      // Mirrors the doctor result: the overall boolean plus the ordered checks,
      // so a self-diagnosing agent can read *which* check failed instead of
      // regex-scraping the text report. `info` checks (e.g. the optional PATH
      // shim) are advisory and never flip `ok`.
      outputSchema: {
        ok: z.boolean(),
        version: z.string().describe("The installed fkanban CLI version (from package.json)."),
        checks: z.array(
          z.object({
            name: z.string(),
            status: z.enum(["pass", "fail", "info"]),
            detail: z.string().optional(),
          }),
        ),
      },
    },
    async () => {
      try {
        const { ok, version, checks, lines } = await runDoctorStructured();
        const report = lines.join("\n");
        return {
          content: [{ type: "text", text: report.length > 0 ? report : "(no output)" }],
          structuredContent: { ok, version, checks },
          isError: !ok,
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}

// The single MCP-server entrypoint for BOTH `fkanban mcp` (the CLI subcommand)
// and the `fkanban-mcp` bin (`runMcp` in main.ts delegates here), so the two
// can never diverge. Reads the same config as the CLI; on a missing/invalid
// config it starts in the not-yet-configured state — the handshake + listTools
// still succeed so the client connects, and each config-dependent tool degrades
// to a clean `isError` "Run `fkanban init` first." per call (see
// `createFkanbanMcpServer`), matching the bin's behavior.
//
// `server.connect` resolves as soon as the transport is wired up, so we must
// not let the caller return (and `process.exit`) before the server has served
// anything — keep the call pending until the stdio transport closes (client
// disconnects / stdin EOF).
export async function startMcpServer(opts: { verbose?: Verbose } = {}): Promise<void> {
  let server: McpServer;
  try {
    const cfg = readConfig();
    const node = newNodeClient({ baseUrl: cfg.nodeUrl, userHash: cfg.userHash, verbose: opts.verbose, socketPath: resolveSocketPath(cfg) });
    server = createFkanbanMcpServer({ cfg, node });
  } catch (err) {
    if (err instanceof ConfigMissingError || err instanceof ConfigInvalidError) {
      // Start anyway so the handshake succeeds and the client connects; tools
      // degrade per call to the "Run `fkanban init` first." hint.
      server = createFkanbanMcpServer({ configError: err });
    } else {
      throw err;
    }
  }
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
  await server.connect(transport);
  await closed;
}
