#!/usr/bin/env bun
// fkanban CLI entrypoint — a kanban board over fold_db.
//
// `--verbose` (global) echoes each HTTP request + response.

import { parseArgs } from "node:util";

import pkg from "../package.json" with { type: "json" };
import { FkanbanError, type Verbose } from "./client.ts";
import { ConfigMissingError, ConfigInvalidError } from "./config.ts";
import { loadCtx } from "./context.ts";
import { runInit } from "./commands/init.ts";
import { addCmd } from "./commands/add.ts";
import { moveCmd } from "./commands/move.ts";
import { listCmd } from "./commands/list.ts";
import { searchCmd } from "./commands/search.ts";
import { showCmd } from "./commands/show.ts";
import { rmCmd } from "./commands/rm.ts";
import { boardCreateCmd, boardListCmd } from "./commands/board.ts";
import { depAddCmd, depRmCmd } from "./commands/dep.ts";
import { doctor } from "./commands/doctor.ts";
import {
  formatAdd,
  formatMove,
  formatDep,
  formatRm,
  formatBoardCreate,
} from "./format.ts";

export const TOP_HELP = `fkanban — a kanban board over fold_db

Usage:
  fkanban <command> [options]

Commands:
  init                 bootstrap a node + register schemas + seed default board
                       (--node-url --schema-service-url --node-socket-path --name)
  add <slug>           create/update a card (--title --board --column --assignee --tags --deps --body)
  move <slug> <col>    move a card to a column (--position N, --force past a block)
  dep add <slug> <dep> add a dependency edge (card <slug> depends on <dep>)
  dep rm <slug> <dep>  remove a dependency edge
  list                 render a board as columns of cards (--board --column --json --limit N --all)
  search <query>       find cards by text across slug/title/body/tags (--board --column --json)
  show <slug>          print one card in detail, incl. deps + blocked state (--json)
  rm <slug>            soft-delete a card
  board create <slug>  create/update a board (--title --columns a,b,c)
  board list           list boards (--json)
  doctor               health-check the local setup
  mcp                  start an MCP server over stdio
  help                 print this help

Global flags:
  --verbose            echo HTTP requests + responses
  --json               machine-readable output (add/move/dep/rm/board create
                       echo the write result as JSON; read commands too)
  --help, -h           print this help
  --version, -V        print the fkanban version and exit

Dependencies: a card with deps is 🔒 blocked until each dep card reaches
\`done\`. \`move\` into doing/review/done refuses a blocked card unless --force.

Columns (default board): backlog → todo → doing → review → done`;

const HELP_FOOTER = "Run `fkanban help` for all commands.";

function withFooter(body: string): string {
  return `${body}\n\n${HELP_FOOTER}`;
}

// Per-command usage. `fkanban <cmd> --help` (or `-h`) prints the matching
// entry instead of the global TOP_HELP firehose. Every command listed in
// TOP_HELP must have an entry here (a unit test enforces they can't drift).
export const COMMAND_HELP: Record<string, string> = {
  init: withFooter(`fkanban init — bootstrap a node + register schemas + seed the default board

Usage:
  fkanban init [options]

Options:
  --node-url <url>            base URL of the fold_db node (e.g. http://127.0.0.1:9001)
  --schema-service-url <url>  schema service to resolve fkanban schemas from
  --node-socket-path <path>   unix socket of the node, instead of --node-url
  --name <name>               display name to seed the default board with

Example:
  fkanban init --node-url http://127.0.0.1:9001 --name "Tom's board"`),

  add: withFooter(`fkanban add — create or update a card (idempotent by slug)

Usage:
  fkanban add <slug> [options]            # --body also reads stdin if piped

Options:
  --title <text>        card title
  --board <slug>        board to place the card on (default: default)
  --column <col>        column to place the card in (default: first column)
  --assignee <name>     who owns the card
  --tags a,b,c          comma-separated tags
  --deps a,b            comma-separated slugs this card depends on
  --body <text>         card body (Markdown); replaces the whole body
  --json                echo the write result as JSON

Example:
  fkanban add ship-login --title "Ship login" --column todo --tags auth,p1`),

  move: withFooter(`fkanban move — move a card to another column

Usage:
  fkanban move <slug> <column> [options]

Options:
  --position <N>        insert at position N within the column
  --force               move past a 🔒 dependency block
  --json                echo the write result as JSON

Example:
  fkanban move ship-login doing`),

  dep: withFooter(`fkanban dep — manage dependency edges between cards

Usage:
  fkanban dep add <slug> <dep>     # card <slug> depends on <dep>
  fkanban dep rm  <slug> <dep>     # remove the edge

Options:
  --json                echo the write result as JSON

A card with deps is 🔒 blocked until each dep card reaches \`done\`.

Example:
  fkanban dep add ui api`),

  list: withFooter(`fkanban list — render a board as columns of cards

Usage:
  fkanban list [options]

Options:
  --board <slug>        board to render (default: default)
  --column <col>        only show one column
  --limit <N>           cap cards shown per column
  --all                 show every card (no per-column cap)
  --json                machine-readable output

Example:
  fkanban list --board default --limit 10`),

  search: withFooter(`fkanban search — find cards by text across slug/title/body/tags/assignee

Usage:
  fkanban search <query> [options]        # multi-word queries are AND-matched

Options:
  --board <slug>        restrict to one board
  --column <col>        restrict to one column
  --json                machine-readable output

Example:
  fkanban search "auth p1"`),

  show: withFooter(`fkanban show — print one card in detail (deps + blocked state)

Usage:
  fkanban show <slug> [options]

Options:
  --json                machine-readable output

Example:
  fkanban show ship-login`),

  rm: withFooter(`fkanban rm — soft-delete a card (tombstone; recoverable)

Usage:
  fkanban rm <slug> [options]

Options:
  --json                echo the write result as JSON

Example:
  fkanban rm ship-login`),

  board: withFooter(`fkanban board — create/update boards or list them

Usage:
  fkanban board create <slug> [options]
  fkanban board list [options]

Options:
  --title <text>        board title (create)
  --columns a,b,c       comma-separated column names (create)
  --body <text>         board body (create)
  --json                machine-readable output

Example:
  fkanban board create sprint --title "Sprint 1" --columns todo,doing,done`),

  doctor: withFooter(`fkanban doctor — health-check the local setup

Usage:
  fkanban doctor

Verifies config, node reachability, and resolved schemas. Exits non-zero on
any failed check.`),

  mcp: withFooter(`fkanban mcp — start an MCP server over stdio

Usage:
  fkanban mcp

Exposes the board to MCP clients (e.g. Claude). Speaks JSON-RPC on
stdin/stdout; not meant to be run interactively.`),
};

// Resolve which help text to print for the parsed argv. `cmd` is positionals[0].
// Per-command help only when --help/-h is set AND cmd names a known command;
// otherwise the global help (covers `--help`, `help`, no command, unknown cmd).
export function resolveHelp(cmd: string | undefined, help: boolean): string | undefined {
  if (!cmd || cmd === "help") return TOP_HELP;
  if (help) {
    return cmd in COMMAND_HELP ? COMMAND_HELP[cmd] : TOP_HELP;
  }
  return undefined;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Uint8Array);
  return Buffer.concat(chunks).toString("utf8");
}

function parseTags(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "V" },
      verbose: { type: "boolean" },
      json: { type: "boolean" },
      title: { type: "string" },
      board: { type: "string" },
      column: { type: "string" },
      assignee: { type: "string" },
      tags: { type: "string" },
      deps: { type: "string" },
      force: { type: "boolean" },
      body: { type: "string" },
      columns: { type: "string" },
      position: { type: "string" },
      limit: { type: "string" },
      all: { type: "boolean" },
      "node-url": { type: "string" },
      "schema-service-url": { type: "string" },
      "node-socket-path": { type: "string" },
      name: { type: "string" },
    },
  });

  if (values.version) {
    console.log(pkg.version);
    return 0;
  }

  const cmd = positionals[0];
  const helpText = resolveHelp(cmd, values.help as boolean | undefined ?? false);
  if (helpText !== undefined) {
    console.log(helpText);
    return 0;
  }

  const verbose: Verbose | undefined = values.verbose ? (m) => console.error(m) : undefined;

  switch (cmd) {
    case "init": {
      await runInit({
        nodeUrl: values["node-url"] as string | undefined,
        schemaServiceUrl: values["schema-service-url"] as string | undefined,
        nodeSocketPath: values["node-socket-path"] as string | undefined,
        bootstrapName: values.name as string | undefined,
        verbose,
      });
      return 0;
    }

    case "mcp": {
      // Defer the MCP import so the heavyweight SDK only loads for `mcp`.
      const { startMcpServer } = await import("./mcp/server.ts");
      await startMcpServer({ verbose });
      return 0;
    }

    case "doctor": {
      const ok = await doctor({ verbose });
      return ok ? 0 : 1;
    }

    case "add": {
      const slug = requirePositional(positionals[1], "add <slug>");
      const ctx = loadCtx({ verbose });
      const stdinBody = await readStdin();
      const body = (values.body as string | undefined) ?? (stdinBody.trim().length > 0 ? stdinBody : undefined);
      const res = await addCmd({
        cfg: ctx.cfg,
        node: ctx.node,
        slug,
        title: values.title as string | undefined,
        board: values.board as string | undefined,
        column: values.column as string | undefined,
        assignee: values.assignee as string | undefined,
        tags: parseTags(values.tags as string | undefined),
        deps: parseTags(values.deps as string | undefined),
        body,
      });
      console.log(formatAdd(res, values.json as boolean | undefined));
      return 0;
    }

    case "move": {
      const slug = requirePositional(positionals[1], "move <slug> <column>");
      const column = requirePositional(positionals[2], "move <slug> <column>");
      const ctx = loadCtx({ verbose });
      const position = values.position !== undefined ? parseInt(values.position as string, 10) : undefined;
      const res = await moveCmd({
        cfg: ctx.cfg,
        node: ctx.node,
        slug,
        column,
        position,
        force: values.force as boolean | undefined,
      });
      console.log(formatMove(res, values.json as boolean | undefined));
      return 0;
    }

    case "dep": {
      const sub = positionals[1];
      const slug = requirePositional(positionals[2], "dep <add|rm> <slug> <dep>");
      const dep = requirePositional(positionals[3], "dep <add|rm> <slug> <dep>");
      const ctx = loadCtx({ verbose });
      if (sub === "add") {
        const res = await depAddCmd({ cfg: ctx.cfg, node: ctx.node, slug, dep });
        console.log(formatDep(res, values.json as boolean | undefined));
        return 0;
      }
      if (sub === "rm" || sub === "remove") {
        const res = await depRmCmd({ cfg: ctx.cfg, node: ctx.node, slug, dep });
        console.log(formatDep(res, values.json as boolean | undefined));
        return 0;
      }
      console.error(`Unknown dep subcommand "${sub ?? ""}". Try: dep add | dep rm`);
      return 2;
    }

    case "list": {
      const ctx = loadCtx({ verbose });
      const limitRaw = values.limit !== undefined ? parseInt(values.limit as string, 10) : undefined;
      const out = await listCmd({
        cfg: ctx.cfg,
        node: ctx.node,
        board: values.board as string | undefined,
        column: values.column as string | undefined,
        json: values.json as boolean | undefined,
        limit: limitRaw !== undefined && Number.isFinite(limitRaw) ? limitRaw : undefined,
        all: values.all as boolean | undefined,
      });
      console.log(out);
      return 0;
    }

    case "search": {
      const query = requirePositional(positionals[1], "search <query>");
      const ctx = loadCtx({ verbose });
      const out = await searchCmd({
        cfg: ctx.cfg,
        node: ctx.node,
        query,
        board: values.board as string | undefined,
        column: values.column as string | undefined,
        json: values.json as boolean | undefined,
      });
      console.log(out);
      return 0;
    }

    case "show": {
      const slug = requirePositional(positionals[1], "show <slug>");
      const ctx = loadCtx({ verbose });
      const out = await showCmd({ cfg: ctx.cfg, node: ctx.node, slug, json: values.json as boolean | undefined });
      console.log(out);
      return 0;
    }

    case "rm": {
      const slug = requirePositional(positionals[1], "rm <slug>");
      const ctx = loadCtx({ verbose });
      const res = await rmCmd({ cfg: ctx.cfg, node: ctx.node, slug });
      console.log(formatRm(res, values.json as boolean | undefined));
      return 0;
    }

    case "board": {
      const sub = positionals[1];
      const ctx = loadCtx({ verbose });
      if (sub === "create") {
        const slug = requirePositional(positionals[2], "board create <slug>");
        const res = await boardCreateCmd({
          cfg: ctx.cfg,
          node: ctx.node,
          slug,
          title: values.title as string | undefined,
          columns: parseTags(values.columns as string | undefined),
          body: values.body as string | undefined,
        });
        console.log(formatBoardCreate(res, values.json as boolean | undefined));
        return 0;
      }
      if (sub === "list" || sub === undefined) {
        const out = await boardListCmd({ cfg: ctx.cfg, node: ctx.node, json: values.json as boolean | undefined });
        console.log(out);
        return 0;
      }
      console.error(`Unknown board subcommand "${sub}". Try: board create | board list`);
      return 2;
    }

    default:
      console.error(`Unknown command "${cmd}".\n`);
      console.log(TOP_HELP);
      return 2;
  }
}

function requirePositional(value: string | undefined, usage: string): string {
  if (!value || value.length === 0) {
    throw new FkanbanError({ code: "missing_arg", message: `Missing argument — usage: fkanban ${usage}` });
  }
  return value;
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      if (err instanceof ConfigMissingError || err instanceof ConfigInvalidError) {
        console.error(`fkanban: ${err.message}`);
      } else if (err instanceof FkanbanError) {
        console.error(`fkanban: ${err.message}`);
        if (err.hint) console.error(`  hint: ${err.hint}`);
      } else {
        console.error(`fkanban: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(1);
    });
}
