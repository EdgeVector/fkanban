// MCP server for fkanban — exposes the board as tools to MCP clients
// (Claude Code, Codex, etc.) over stdio. Each handler calls the in-process
// command function, so an agent sees the same result as the matching
// `fkanban` subcommand.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { FkanbanError, newNodeClient, type NodeClient, type Verbose } from "../client.ts";
import { readConfig, resolveSocketPath, type Config } from "../config.ts";
import { addCmd } from "../commands/add.ts";
import { moveCmd } from "../commands/move.ts";
import { listCmd } from "../commands/list.ts";
import { searchCmd } from "../commands/search.ts";
import { showCmd } from "../commands/show.ts";
import { rmCmd } from "../commands/rm.ts";
import { boardCreateCmd, boardListCmd, boardRmCmd } from "../commands/board.ts";
import { depAddCmd, depRmCmd } from "../commands/dep.ts";
import { doctor } from "../commands/doctor.ts";

export const FKANBAN_MCP_NAME = "fkanban";
export const FKANBAN_MCP_VERSION = "0.1.0";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text: text.length > 0 ? text : "(no output)" }] };
}

// Write tools return BOTH a machine-readable result object (structuredContent,
// matching the tool's declared outputSchema — the same shape the CLI emits
// under `--json`) AND a human-readable text block, so MCP clients that don't
// read structuredContent still get a useful rendering.
function writeResult(text: string, structured: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: text.length > 0 ? text : "(no output)" }], structuredContent: structured };
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

export function createFkanbanMcpServer(opts: { cfg: Config; node?: NodeClient }): McpServer {
  const { cfg } = opts;
  const node = opts.node ?? newNodeClient({ baseUrl: cfg.nodeUrl, userHash: cfg.userHash, socketPath: resolveSocketPath(cfg) });
  const server = new McpServer({ name: FKANBAN_MCP_NAME, version: FKANBAN_MCP_VERSION });

  server.registerTool(
    "fkanban_list",
    {
      title: "Show kanban board",
      description:
        "Render a kanban board as columns of cards. Cards are grouped under their column (backlog → todo → doing → review → done) in position order.",
      inputSchema: {
        board: z.string().optional().describe("Board slug (default: `default`)."),
        column: z.string().optional().describe("Restrict to one column."),
      },
    },
    async (args) => {
      try {
        const o: Parameters<typeof listCmd>[0] = { cfg, node };
        if (args.board) o.board = args.board;
        if (args.column) o.column = args.column;
        return textResult(await listCmd(o));
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
      inputSchema: {
        query: z.string().min(1).describe("Search text. Space-separated terms are all required (AND)."),
        board: z.string().optional().describe("Restrict to one board."),
        column: z.string().optional().describe("Restrict to one column."),
      },
    },
    async (args) => {
      try {
        const o: Parameters<typeof searchCmd>[0] = { cfg, node, query: args.query };
        if (args.board) o.board = args.board;
        if (args.column) o.column = args.column;
        return textResult(await searchCmd(o));
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
        "Create a card (or update it if the slug exists). Defaults: board=`default`, column=the board's first column.",
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
        const o: Parameters<typeof addCmd>[0] = { cfg, node, slug: args.slug };
        if (args.title !== undefined) o.title = args.title;
        if (args.body !== undefined) o.body = args.body;
        if (args.board !== undefined) o.board = args.board;
        if (args.column !== undefined) o.column = args.column;
        if (args.assignee !== undefined) o.assignee = args.assignee;
        if (args.tags !== undefined) o.tags = args.tags;
        if (args.deps !== undefined) o.deps = args.deps;
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
      inputSchema: { slug: z.string().min(1).describe("Card slug.") },
    },
    async (args) => {
      try {
        return textResult(await showCmd({ cfg, node, slug: args.slug }));
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
      inputSchema: { slug: z.string().min(1).describe("Card slug.") },
      outputSchema: { slug: z.string() },
    },
    async (args) => {
      try {
        const res = await rmCmd({ cfg, node, slug: args.slug });
        return writeResult(`removed card ${res.slug}`, res);
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
      inputSchema: {},
    },
    async () => {
      try {
        return textResult(await boardListCmd({ cfg, node }));
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
      inputSchema: {
        slug: z.string().min(1).describe("Board slug."),
        force: z.boolean().optional().describe("Remove even if the board still has live cards."),
      },
      outputSchema: { slug: z.string() },
    },
    async (args) => {
      try {
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
      inputSchema: {},
    },
    async () => {
      try {
        const lines: string[] = [];
        const ok = await doctor({ print: (l) => lines.push(l) });
        const report = lines.join("\n");
        return { content: [{ type: "text", text: report.length > 0 ? report : "(no output)" }], isError: !ok };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}

// Used by `fkanban mcp` (the CLI subcommand). Reads the same config as the CLI.
// `server.connect` resolves as soon as the transport is wired up, so we must
// not let the caller return (and `process.exit`) before the server has served
// anything — keep the call pending until the stdio transport closes (client
// disconnects / stdin EOF).
export async function startMcpServer(opts: { verbose?: Verbose } = {}): Promise<void> {
  const cfg = readConfig();
  const node = newNodeClient({ baseUrl: cfg.nodeUrl, userHash: cfg.userHash, verbose: opts.verbose, socketPath: resolveSocketPath(cfg) });
  const server = createFkanbanMcpServer({ cfg, node });
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
  await server.connect(transport);
  await closed;
}
