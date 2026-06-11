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
import { showCmd } from "../commands/show.ts";
import { rmCmd } from "../commands/rm.ts";
import { boardCreateCmd, boardListCmd } from "../commands/board.ts";
import { depAddCmd, depRmCmd } from "../commands/dep.ts";

export const FKANBAN_MCP_NAME = "fkanban";
export const FKANBAN_MCP_VERSION = "0.1.0";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text: text.length > 0 ? text : "(no output)" }] };
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
        return textResult(`${res.action} card ${res.slug} → ${res.board}/${res.column}`);
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
    },
    async (args) => {
      try {
        const o: Parameters<typeof moveCmd>[0] = { cfg, node, slug: args.slug, column: args.column };
        if (args.position !== undefined) o.position = args.position;
        if (args.force !== undefined) o.force = args.force;
        const res = await moveCmd(o);
        return textResult(`moved ${res.slug}: ${res.from} → ${res.to}`);
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
    },
    async (args) => {
      try {
        const res = await depAddCmd({ cfg, node, slug: args.slug, dep: args.dep });
        return textResult(`${res.slug} now depends on ${res.dep} (deps: ${res.deps.join(", ") || "none"})`);
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
    },
    async (args) => {
      try {
        const res = await depRmCmd({ cfg, node, slug: args.slug, dep: args.dep });
        return textResult(`${res.slug} no longer depends on ${res.dep} (deps: ${res.deps.join(", ") || "none"})`);
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
    },
    async (args) => {
      try {
        const res = await rmCmd({ cfg, node, slug: args.slug });
        return textResult(`removed card ${res.slug}`);
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
    },
    async (args) => {
      try {
        const o: Parameters<typeof boardCreateCmd>[0] = { cfg, node, slug: args.slug };
        if (args.title !== undefined) o.title = args.title;
        if (args.columns !== undefined) o.columns = args.columns;
        if (args.body !== undefined) o.body = args.body;
        const res = await boardCreateCmd(o);
        return textResult(`${res.action} board ${res.slug}`);
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

  return server;
}

// Used by `fkanban mcp` (the CLI subcommand). Reads the same config as the CLI.
export async function startMcpServer(opts: { verbose?: Verbose } = {}): Promise<void> {
  const cfg = readConfig();
  const node = newNodeClient({ baseUrl: cfg.nodeUrl, userHash: cfg.userHash, verbose: opts.verbose, socketPath: resolveSocketPath(cfg) });
  const server = createFkanbanMcpServer({ cfg, node });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
