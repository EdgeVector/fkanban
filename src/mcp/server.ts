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
import { runDoctorStructured } from "../commands/doctor.ts";
import { orphanedDependentsWarning } from "../record.ts";

export const FKANBAN_MCP_NAME = "fkanban";
export const FKANBAN_MCP_VERSION = "0.1.0";

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
  const server = new McpServer({ name: FKANBAN_MCP_NAME, version: FKANBAN_MCP_VERSION });

  server.registerTool(
    "fkanban_list",
    {
      title: "Show kanban board",
      description:
        "Render a kanban board as columns of cards. Cards are grouped under their column (backlog → todo → doing → review → done) in position order.",
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
      },
      outputSchema: { cards: z.array(cardSchema).describe("Matching cards, in column + position order.") },
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
        return readResult(text, { cards });
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
        "Find cards by a case-insensitive substring match across slug, title, body, assignee, and tags. Multi-word queries are AND-matched (every term must appear). Results span columns/boards; each is annotated with its `[board/column]`.",
      annotations: { title: "Search cards", readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        query: z.string().min(1).describe("Search text. Space-separated terms are all required (AND)."),
        board: z.string().optional().describe("Restrict to one board."),
        column: z.string().optional().describe("Restrict to one column."),
      },
      outputSchema: { cards: z.array(cardSchema).describe("Matching cards across boards/columns.") },
    },
    async (args) => {
      try {
        const { cfg, node } = requireConfig();
        const o: Parameters<typeof searchResult>[0] = { cfg, node, query: args.query };
        if (args.board) o.board = args.board;
        if (args.column) o.column = args.column;
        const { text, cards } = await searchResult(o);
        return readResult(text, { cards });
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
        slug: z.string().min(1).describe("Stable card id (lowercase [a-z0-9-_])."),
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
        const { cfg, node } = requireConfig();
        const o: Parameters<typeof addCmd>[0] = { cfg, node, slug: args.slug };
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
        slug: z.string().min(1).describe("Card slug."),
        column: z.string().min(1).describe("Target column."),
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
        const { cfg, node } = requireConfig();
        const o: Parameters<typeof moveCmd>[0] = { cfg, node, slug: args.slug, column: args.column };
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
        slug: z.string().min(1).describe("The dependent card."),
        dep: z.string().min(1).describe("The card it depends on (must reach `done` first)."),
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
        const { cfg, node } = requireConfig();
        const res = await depAddCmd({ cfg, node, slug: args.slug, dep: args.dep });
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
        slug: z.string().min(1).describe("The dependent card."),
        dep: z.string().min(1).describe("The dependency to remove."),
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
        const { cfg, node } = requireConfig();
        const res = await depRmCmd({ cfg, node, slug: args.slug, dep: args.dep });
        return writeResult(`${res.slug} no longer depends on ${res.dep} (deps: ${res.deps.join(", ") || "none"})`, res);
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
      inputSchema: { slug: z.string().min(1).describe("Card slug.") },
      outputSchema: cardDetailSchema.shape,
    },
    async (args) => {
      try {
        const { cfg, node } = requireConfig();
        const { text, card } = await showResult({ cfg, node, slug: args.slug });
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
      inputSchema: { slug: z.string().min(1).describe("Card slug.") },
      outputSchema: {
        slug: z.string(),
        orphanedDependents: z
          .array(z.string())
          .describe("Live cards that still depend on the deleted card — now dangling."),
      },
    },
    async (args) => {
      try {
        const { cfg, node } = requireConfig();
        const res = await rmCmd({ cfg, node, slug: args.slug });
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
        slug: z.string().min(1).describe("Board slug."),
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
        const { cfg, node } = requireConfig();
        const o: Parameters<typeof boardCreateCmd>[0] = { cfg, node, slug: args.slug };
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
        slug: z.string().min(1).describe("Board slug."),
        force: z.boolean().optional().describe("Remove even if the board still has live cards."),
      },
      outputSchema: { slug: z.string() },
    },
    async (args) => {
      try {
        const { cfg, node } = requireConfig();
        const res = await boardRmCmd({ cfg, node, slug: args.slug, force: args.force });
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
