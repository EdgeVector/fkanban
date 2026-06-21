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
import { boardCreateCmd, boardListCmd, boardRmCmd } from "./commands/board.ts";
import { depAddCmd, depRmCmd } from "./commands/dep.ts";
import { orphanedDependentsWarning } from "./record.ts";
import { doctor, runDoctorStructured } from "./commands/doctor.ts";
import {
  formatAdd,
  formatMove,
  formatDep,
  formatRm,
  formatBoardCreate,
  formatBoardRm,
  formatError,
} from "./format.ts";

export const TOP_HELP = `fkanban — a kanban board over fold_db

Usage:
  fkanban <command> [options]

Commands:
  init                 bootstrap a node + register schemas + seed default board
                       (--node-url --schema-service-url --node-socket-path --name)
  add <slug>           create/update a card (--title --board --column --assignee --tags --deps --body, --force past a block)
  move <slug> <col>    move a card to a column (--position N, --force past a block)
  dep add <slug> <dep> add a dependency edge (card <slug> depends on <dep>)
  dep rm <slug> <dep>  remove a dependency edge
  list                 render a board as columns of cards (--board --column --tag --assignee --json --limit N --all)
  search <query>       find cards by text across slug/title/body/tags/assignee (--board --column --json)
  show <slug>          print one card in detail, incl. deps + blocked state (--json)
  rm <slug>            soft-delete a card
  board create <slug>  create/update a board (--title --columns a,b,c)
  board list           list boards (--json)
  board rm <slug>      soft-delete a board (refuses the default board or a
                       board with live cards unless --force)
  doctor               health-check the local setup (--json)
  mcp                  start an MCP server over stdio
  version              print the fkanban version and exit (alias of --version)
  help                 print this help

Run \`fkanban help <command>\` or \`fkanban <command> --help\` for command details.

Global flags:
  --verbose            echo HTTP requests + responses
  --json               machine-readable output (add/move/dep/rm/board create/
                       board rm echo the write result as JSON; read commands too)
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
                        (an edge that would form a cycle is rejected, exit 2)
  --body <text>         card body (Markdown); replaces the whole body
  --force               add even past a 🔒 dependency block
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
Edges that would form a cycle (direct or transitive) are rejected (exit 2).

Example:
  fkanban dep add ui api`),

  list: withFooter(`fkanban list — render a board as columns of cards

Usage:
  fkanban list [options]

Options:
  --board <slug>        board to render (default: default)
  --column <col>        only show one column
  --tag <tag>           only cards carrying this tag (EXACT membership, not
                        the fuzzy text match of \`search\`)
  --assignee <name>     only cards assigned to this person (exact match)
  --limit <N>           cap cards per column (applies to text AND --json)
  --all                 show every card (no per-column cap; --json default)
  --json                machine-readable output (unlimited unless --limit set)

Example:
  fkanban list --board default --limit 10
  fkanban list --tag fkanban --column doing`),

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
  fkanban doctor [--json]

Verifies config, node reachability, and resolved schemas. Exits non-zero on
any failed check.

Flags:
  --json               machine-readable { ok, checks } report`),

  mcp: withFooter(`fkanban mcp — start an MCP server over stdio

Usage:
  fkanban mcp

Exposes the board to MCP clients (e.g. Claude). Speaks JSON-RPC on
stdin/stdout; not meant to be run interactively.`),

  version: withFooter(`fkanban version — print the fkanban version and exit

Usage:
  fkanban version

An alias of the \`--version\`/\`-V\` flag: prints just the version (from
package.json) to stdout and exits 0.

Example:
  fkanban version`),
};

// Resolve which help text to print for the parsed argv. `cmd` is positionals[0],
// `topic` is positionals[1] (only consulted for `fkanban help <topic>`).
//
// Routing, in order:
//   - `fkanban help <command>` → that command's per-command help (byte-identical
//     to `fkanban <command> --help`). An unknown topic falls back to TOP_HELP;
//     the caller is responsible for the "unknown command" note on stderr (this
//     stays a pure text->text function so the unit suite can assert it directly).
//   - `fkanban help` / `fkanban --help` / no command / unknown command → TOP_HELP.
//   - `fkanban <command> --help` → that command's per-command help.
export function resolveHelp(
  cmd: string | undefined,
  help: boolean,
  topic?: string,
): string | undefined {
  if (cmd === "help") {
    if (topic !== undefined && topic in COMMAND_HELP) return COMMAND_HELP[topic];
    return TOP_HELP; // bare `help`, or `help <unknown-topic>` (caller notes it)
  }
  if (!cmd) return TOP_HELP;
  if (help) {
    return cmd in COMMAND_HELP ? COMMAND_HELP[cmd] : TOP_HELP;
  }
  return undefined;
}

// Drain piped stdin to source `add --body` when no `--body` flag is given.
// Returns "" for a TTY, an empty stream, or a pipe that delivers no data.
//
// This MUST NOT block on a stdin that never reaches EOF. Under Bun a pipe that
// a parent opens but never writes to or closes — the shape of a background- or
// agent-spawned `fkanban add` that inherits stdin without ever closing it —
// delivers no EOF, so draining it with `for await (...of process.stdin)` hangs
// forever. That is the bug behind "`add` never exits / silently failed to
// persist the card": the await never resolved, so the write below it never ran.
//
// Instead we wait a short grace for the first byte; if none arrives we give up
// and treat stdin as empty (no body). Once bytes do flow we assume a real
// producer (echo/cat/heredoc) that will close its end, and read through to
// `end`. The grace is overridable via FKANBAN_STDIN_IDLE_MS (ms).
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const raw = process.env.FKANBAN_STDIN_IDLE_MS;
  const parsed = raw === undefined ? NaN : parseInt(raw, 10);
  const firstByteMs = Number.isFinite(parsed) && parsed >= 0 ? parsed : 250;

  const stdin = process.stdin;
  const chunks: Uint8Array[] = [];
  await new Promise<void>((resolve) => {
    let gotData = false;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      stdin.off("data", onData);
      stdin.off("end", finish);
      stdin.off("error", finish);
      resolve();
    };
    const onData = (c: Uint8Array) => {
      gotData = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      chunks.push(c);
    };
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      // No first byte within the grace: a silent / never-EOF pipe. Give up.
      if (!gotData) finish();
    }, firstByteMs);
    stdin.on("data", onData);
    stdin.on("end", finish);
    stdin.on("error", finish);
  });
  return Buffer.concat(chunks).toString("utf8");
}

function parseTags(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

// Thrown when a numeric flag (`--limit`, `--position`) is given a value that
// isn't a clean integer at or above its minimum. The message is already
// printed to stderr by parseIntFlag; the dispatch catches this to return the
// exit-2 contract (matching the unknown-flag / list-validate-column handling).
class FlagValidationError extends Error {
  // Discriminant read by key, not by prototype identity. `instanceof` on an
  // Error subclass is unreliable across bun runtimes — it holds on macOS but
  // fails on the Linux CI runner, where the thrown error escaped the dispatch
  // `instanceof` check and hit the top-level catch (exit 1) instead of the
  // exit-2 contract. A tagged property is platform-stable.
  readonly isFlagValidationError = true;
}

function isFlagValidationError(err: unknown): err is FlagValidationError {
  return (
    err instanceof FlagValidationError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { isFlagValidationError?: boolean }).isFlagValidationError === true)
  );
}

// Coerce a numeric flag's raw value to an integer, rejecting non-numeric or
// out-of-range input LOUDLY (stderr + exit 2) instead of silently swallowing
// it into a default. `parseInt` would happily accept "12abc" (→ 12) and turn a
// pure typo into NaN, so we require the whole string to be a clean integer.
// Mirrors the unknown-flag contract: one-line reason + a per-command help hint.
function parseIntFlag(
  raw: string,
  flag: string,
  cmd: string,
  { min }: { min: number },
): number {
  const trimmed = raw.trim();
  const n = Number(trimmed);
  const want = min === 1 ? "a positive integer" : `an integer >= ${min}`;
  const help = cmd in COMMAND_HELP ? `${cmd} --help` : "help";
  if (trimmed.length === 0 || !Number.isInteger(n) || n < min) {
    let msg = `error: --${flag} must be ${want}, got "${raw}".`;
    // --limit 0 used to mean silent-unbounded; point at the documented flag.
    if (flag === "limit" && Number.isInteger(n) && n < 1) {
      msg = `error: --${flag} must be ${want}, got "${raw}". Use --all to show everything.`;
    }
    console.error(`${msg} Run \`fkanban ${help}\` to see this command's flags.`);
    throw new FlagValidationError(msg);
  }
  return n;
}

// Node's parseArgs error codes for malformed flags. With `strict: true`,
// an unknown `--flag`, a value handed to a boolean flag, or a missing value
// for a string flag all throw a TypeError carrying one of these codes. We
// turn them into the same clean error + exit-2 contract as an unknown command,
// instead of silently swallowing the typo (which produced wrong data).
const PARSE_ARGS_ERROR_CODES = new Set([
  "ERR_PARSE_ARGS_UNKNOWN_OPTION",
  "ERR_PARSE_ARGS_INVALID_OPTION_VALUE",
  "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL",
]);

function isParseArgsError(err: unknown): err is Error & { code: string } {
  return (
    err instanceof Error &&
    typeof (err as { code?: unknown }).code === "string" &&
    PARSE_ARGS_ERROR_CODES.has((err as unknown as { code: string }).code)
  );
}

// Flags accepted by EVERY command. `parseArgs` runs globally (one options set
// spanning all commands), so it only rejects a flag NO command declares. A
// flag that's valid on some *other* command (`show --column`, `move --board`,
// `rm --tags`) slips through and gets silently ignored — contradicting the
// per-command "Run `fkanban <cmd> --help` to see this command's flags." hint.
// UNIVERSAL_FLAGS + COMMAND_FLAGS let us re-check each provided flag against
// the command it was actually given to, and reject the misapplied ones with
// the same exit-2 + per-command-help contract as a truly unknown flag.
const UNIVERSAL_FLAGS = new Set(["help", "version", "verbose", "json"]);

// Per-command allowed flags (beyond UNIVERSAL_FLAGS), keyed by the same command
// names as COMMAND_HELP. Derived from each command's `--help` text and the
// flags its dispatch branch actually reads. Commands absent here (e.g. `dep`,
// `show`, `rm`, `doctor`, `mcp`, `version`) accept only the universal flags.
const COMMAND_FLAGS: Record<string, Set<string>> = {
  init: new Set(["node-url", "schema-service-url", "node-socket-path", "name"]),
  add: new Set(["title", "board", "column", "assignee", "tags", "deps", "body", "force"]),
  // move ignores --board on purpose: slugs are global, so it can't scope a
  // lookup. Leaving it out makes `move <slug> doing --board X` an exit-2 error.
  move: new Set(["position", "force"]),
  list: new Set(["board", "column", "tag", "assignee", "limit", "all"]),
  search: new Set(["board", "column"]),
  // board's subcommands read title/columns/body (create) and force (rm).
  board: new Set(["title", "columns", "body", "force"]),
};

// Reject a flag that parseArgs accepted globally but that THIS command doesn't
// declare (e.g. `show --column`, `move --board`). Mirrors the unknown-flag
// contract exactly: same `Unknown option '--<flag>'.` wording + per-command
// help hint + exit 2. Only fires for commands we know; an unknown command
// falls through to its own "Unknown command" handling untouched.
function rejectMisappliedFlags(
  cmd: string,
  values: Record<string, unknown>,
): number | undefined {
  if (!(cmd in COMMAND_HELP)) return undefined;
  const allowed = COMMAND_FLAGS[cmd] ?? new Set<string>();
  for (const flag of Object.keys(values)) {
    if (UNIVERSAL_FLAGS.has(flag) || allowed.has(flag)) continue;
    // First disallowed flag wins — match parseArgs' single-error behavior.
    console.error(
      `fkanban: Unknown option '--${flag}'. Run \`fkanban ${cmd} --help\` to see this command's flags.`,
    );
    return 2;
  }
  return undefined;
}

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "V" },
        verbose: { type: "boolean" },
        json: { type: "boolean" },
        title: { type: "string" },
        board: { type: "string" },
        column: { type: "string" },
        tag: { type: "string" },
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
  } catch (err) {
    if (isParseArgsError(err)) {
      // Mirror the unknown-command contract: clean one-liner on stderr + exit 2.
      // parseArgs runs before we know the command, but the first arg that isn't
      // a flag is the command name — surface it in the hint when we have it.
      const cmd = argv.find((a) => !a.startsWith("-"));
      const helpCmd = cmd && cmd in COMMAND_HELP ? `${cmd} --help` : "help";
      // Node's default message leaks library internals: a multi-line "argument
      // is ambiguous … use '--flag=-XYZ'" advice for a missing/dash-leading
      // value, or a verbose `. To specify a positional …` clause for an unknown
      // option. Strip both so we emit one clean fkanban-styled line.
      let reason: string;
      // Missing value: parseArgs throws "Option '--x' argument is ambiguous"
      // when the next token is itself a flag (or a dash-leading value). Node's
      // own wording is jargon; write a purpose-built one-liner instead.
      const ambiguous = err.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE"
        && err.message.includes("is ambiguous");
      if (ambiguous) {
        const flag = err.message.match(/Option '([^']+)'/)?.[1] ?? "the option";
        reason = `Option '${flag}' is missing its value (the next token is another flag). `
          + `If the value must start with a dash, pass it as ${flag}=<value>`;
      } else {
        // Keep just the first line and first clause; drop Node's verbose advice.
        reason = (err.message.split("\n")[0] ?? err.message).split(". To specify")[0] ?? err.message;
      }
      // Never emit a double-period: strip any trailing `.` before our `. Run …`.
      reason = reason.replace(/\.+$/, "");
      console.error(`fkanban: ${reason}. Run \`fkanban ${helpCmd}\` to see this command's flags.`);
      return 2;
    }
    throw err;
  }
  const { values, positionals } = parsed;

  if (values.version) {
    console.log(pkg.version);
    return 0;
  }

  const cmd = positionals[0];
  const topic = positionals[1];
  const helpText = resolveHelp(cmd, values.help as boolean | undefined ?? false, topic);
  if (helpText !== undefined) {
    // `fkanban help <unknown-topic>` falls back to TOP_HELP but says so on
    // stderr first, so the topic isn't silently ignored (the whole point of
    // this command). `help` is not a usage error — keep exit 0, matching bare
    // `help`/no-arg. The exit-2 "Unknown command" path is for a bogus
    // *top-level* command, a distinct case.
    if (cmd === "help" && topic !== undefined && !(topic in COMMAND_HELP)) {
      console.error(`fkanban: Unknown command "${topic}".\n`);
    }
    console.log(helpText);
    return 0;
  }

  // Now that the command is known, reject any globally-valid flag that this
  // specific command doesn't accept (parseArgs only catches flags NO command
  // declares). Runs after the help short-circuit so `<cmd> --help` still works.
  if (cmd !== undefined) {
    const misapplied = rejectMisappliedFlags(cmd, values);
    if (misapplied !== undefined) return misapplied;
  }

  const verbose: Verbose | undefined = values.verbose ? (m) => console.error(m) : undefined;

  try {
    return await dispatch(cmd, values, positionals, verbose);
  } catch (err) {
    // A rejected numeric flag has already printed its reason to stderr;
    // surface the exit-2 contract here (matching the unknown-flag handling).
    if (isFlagValidationError(err)) return 2;
    throw err;
  }
}

async function dispatch(
  cmd: string | undefined,
  values: Record<string, unknown>,
  positionals: string[],
  verbose: Verbose | undefined,
): Promise<number> {
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

    case "version": {
      // Bare `version` subcommand — an alias for the `--version` flag (humans
      // and agents reflexively type `<tool> version`). Print just the version
      // from package.json (same source as `--version`/`-V`) and exit 0.
      console.log(pkg.version);
      return 0;
    }

    case "doctor": {
      if (values.json) {
        // Machine-readable: collect the structured report (no human ✓/✗ lines
        // leak to stdout) and emit the SAME { ok, version, checks } shape the
        // `fkanban_doctor` MCP tool returns as structuredContent.
        const { ok, version, checks } = await runDoctorStructured({ verbose });
        console.log(JSON.stringify({ ok, version, checks }));
        return ok ? 0 : 1;
      }
      const ok = await doctor({ verbose });
      return ok ? 0 : 1;
    }

    case "add": {
      const slug = requirePositional(positionals[1], "add <slug>");
      const ctx = loadCtx({ verbose });
      // `--body` as a flag wins, and when it's present we must NOT touch stdin
      // at all: draining a stdin that never reaches EOF (a background-/agent-
      // spawned `add` that inherits but never closes the pipe) used to block
      // here indefinitely, so the card never persisted. Only consult stdin to
      // source the body when no `--body` flag was given, and even then the read
      // is bounded (see readStdin) so it can't hang.
      let body = values.body as string | undefined;
      if (body === undefined) {
        const stdinBody = await readStdin();
        if (stdinBody.trim().length > 0) body = stdinBody;
      }
      try {
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
          force: values.force as boolean | undefined,
        });
        console.log(formatAdd(res, values.json as boolean | undefined));
        return 0;
      } catch (err) {
        // A `--deps` edge that would close a cycle is a bad-input error, not a
        // node failure: report it LOUDLY with the exit-2 contract (matching
        // `dep add`), and as a clean envelope under --json — never a half write.
        if (err instanceof FkanbanError && err.code === "dep_cycle") {
          if (values.json) {
            console.log(formatError(err));
          } else {
            console.error(`fkanban: ${err.message}`);
            if (err.hint) console.error(`  hint: ${err.hint}`);
          }
          return 2;
        }
        throw err;
      }
    }

    case "move": {
      const slug = requirePositional(positionals[1], "move <slug> <column>");
      const column = requirePositional(positionals[2], "move <slug> <column>");
      // Validate the numeric flag before touching config/node, so a bad
      // `--position` reports the exit-2 flag error rather than a config error.
      const position =
        values.position !== undefined
          ? parseIntFlag(values.position as string, "position", "move", { min: 0 })
          : undefined;
      const ctx = loadCtx({ verbose });
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
        try {
          const res = await depAddCmd({ cfg: ctx.cfg, node: ctx.node, slug, dep });
          console.log(formatDep(res, values.json as boolean | undefined));
          return 0;
        } catch (err) {
          // A rejected cycle is a bad-input error, not a node failure: report it
          // LOUDLY with the exit-2 contract (like an unknown flag), and as a
          // clean machine-readable envelope under --json — never a half write.
          if (err instanceof FkanbanError && err.code === "dep_cycle") {
            if (values.json) {
              console.log(formatError(err));
            } else {
              console.error(`fkanban: ${err.message}`);
              if (err.hint) console.error(`  hint: ${err.hint}`);
            }
            return 2;
          }
          throw err;
        }
      }
      if (sub === "rm" || sub === "remove") {
        const res = await depRmCmd({ cfg: ctx.cfg, node: ctx.node, slug, dep });
        console.log(formatDep(res, values.json as boolean | undefined));
        return 0;
      }
      console.error(`fkanban: Unknown dep subcommand "${sub ?? ""}". Try: dep add | dep rm`);
      return 2;
    }

    case "list": {
      // Validate the numeric flag before touching config/node, so a bad
      // `--limit` reports the exit-2 flag error rather than a config error.
      const limit =
        values.limit !== undefined
          ? parseIntFlag(values.limit as string, "limit", "list", { min: 1 })
          : undefined;
      const ctx = loadCtx({ verbose });
      const out = await listCmd({
        cfg: ctx.cfg,
        node: ctx.node,
        board: values.board as string | undefined,
        column: values.column as string | undefined,
        tag: values.tag as string | undefined,
        assignee: values.assignee as string | undefined,
        json: values.json as boolean | undefined,
        limit,
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
      // Deleting a card that other live cards still depend on leaves those edges
      // dangling — warn loudly (stderr), mirroring `add --deps <missing>`. Under
      // --json the dependents ride along in the result object, so suppress the
      // prose line (same convention as the rest of the CLI).
      if (!values.json && res.orphanedDependents.length > 0) {
        console.error(orphanedDependentsWarning(res.slug, res.orphanedDependents));
      }
      return 0;
    }

    case "board": {
      const sub = positionals[1];
      const ctx = loadCtx({ verbose });
      if (sub === "create") {
        const slug = requirePositional(positionals[2], "board create <slug>");
        try {
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
        } catch (err) {
          // A `--columns` list with a duplicate name is a bad-input error, not a
          // node failure: report it LOUDLY with the exit-2 contract (matching
          // `dep add` / `dep_cycle`), and as a clean envelope under --json —
          // never a half write.
          if (err instanceof FkanbanError && err.code === "dup_columns") {
            if (values.json) {
              console.log(formatError(err));
            } else {
              console.error(`fkanban: ${err.message}`);
              if (err.hint) console.error(`  hint: ${err.hint}`);
            }
            return 2;
          }
          throw err;
        }
      }
      if (sub === "list" || sub === undefined) {
        const out = await boardListCmd({ cfg: ctx.cfg, node: ctx.node, json: values.json as boolean | undefined });
        console.log(out);
        return 0;
      }
      if (sub === "rm") {
        const slug = requirePositional(positionals[2], "board rm <slug>");
        const res = await boardRmCmd({
          cfg: ctx.cfg,
          node: ctx.node,
          slug,
          force: values.force as boolean | undefined,
        });
        console.log(formatBoardRm(res, values.json as boolean | undefined));
        return 0;
      }
      console.error(`fkanban: Unknown board subcommand "${sub}". Try: board create | board list | board rm`);
      return 2;
    }

    default:
      console.error(`fkanban: Unknown command "${cmd}".\n`);
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
        // A missing required argument is a usage error, like an unknown
        // command or a bad flag — exit 2 ("bad invocation"). Every other
        // FkanbanError (card_not_found, service_unreachable, card_blocked, …)
        // is a genuine operational failure and stays exit 1.
        process.exit(err.code === "missing_arg" ? 2 : 1);
      } else {
        console.error(`fkanban: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(1);
    });
}
