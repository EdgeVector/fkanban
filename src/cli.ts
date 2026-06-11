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
import { showCmd } from "./commands/show.ts";
import { rmCmd } from "./commands/rm.ts";
import { boardCreateCmd, boardListCmd } from "./commands/board.ts";
import { depAddCmd, depRmCmd } from "./commands/dep.ts";
import { doctor } from "./commands/doctor.ts";

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
  list                 render a board as columns of cards (--board --column --json)
  show <slug>          print one card in detail, incl. deps + blocked state (--json)
  rm <slug>            soft-delete a card
  board create <slug>  create/update a board (--title --columns a,b,c)
  board list           list boards (--json)
  doctor               health-check the local setup
  mcp                  start an MCP server over stdio
  help                 print this help

Global flags:
  --verbose            echo HTTP requests + responses
  --help, -h           print this help
  --version, -V        print the fkanban version and exit

Dependencies: a card with deps is 🔒 blocked until each dep card reaches
\`done\`. \`move\` into doing/review/done refuses a blocked card unless --force.

Columns (default board): backlog → todo → doing → review → done`;

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
  if (!cmd || cmd === "help" || values.help) {
    console.log(TOP_HELP);
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
      console.log(`${res.action} card ${res.slug} → ${res.board}/${res.column}`);
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
      console.log(`moved ${res.slug}: ${res.from} → ${res.to}`);
      return 0;
    }

    case "dep": {
      const sub = positionals[1];
      const slug = requirePositional(positionals[2], "dep <add|rm> <slug> <dep>");
      const dep = requirePositional(positionals[3], "dep <add|rm> <slug> <dep>");
      const ctx = loadCtx({ verbose });
      if (sub === "add") {
        const res = await depAddCmd({ cfg: ctx.cfg, node: ctx.node, slug, dep });
        console.log(`${res.slug} now depends on ${res.dep} (deps: ${res.deps.join(", ") || "none"})`);
        return 0;
      }
      if (sub === "rm" || sub === "remove") {
        const res = await depRmCmd({ cfg: ctx.cfg, node: ctx.node, slug, dep });
        console.log(`${res.slug} no longer depends on ${res.dep} (deps: ${res.deps.join(", ") || "none"})`);
        return 0;
      }
      console.error(`Unknown dep subcommand "${sub ?? ""}". Try: dep add | dep rm`);
      return 2;
    }

    case "list": {
      const ctx = loadCtx({ verbose });
      const out = await listCmd({
        cfg: ctx.cfg,
        node: ctx.node,
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
      console.log(`removed card ${res.slug}`);
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
        console.log(`${res.action} board ${res.slug}`);
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
