import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cardToFields, emptyStructuredFields, type Card } from "../src/record.ts";
import { boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";
import { SPAWN_TEST_TIMEOUT_MS } from "./helpers/spawn-test-timeout";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

async function runCli(args: string[], config: string, socket: string) {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    env: { ...process.env, KANBAN_CONFIG: config, FKANBAN_CONFIG: config, FOLDDB_SOCKET_PATH: socket },
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { stdout, stderr, code };
}

function fixtureCard(slug: string, position: string): Card {
  return {
    ...emptyStructuredFields(), slug, title: slug, body: "## GOAL\nrepair\n## END STATE\ndone\n",
    board: "default", column: "todo", position, assignee: "", tags: [], deps: [],
    repo: "EdgeVector/fkanban", base: "main", kind: "pr", surfaces: [`src/${slug}.ts`],
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
  };
}

test("CLI exact-card: forwards the selector to the isolated socket fixture", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kanban-only-card-cli-"));
  const config = join(dir, "config.json");
  const socket = join(dir, "folddb.sock");
  writeFileSync(config, JSON.stringify({ configVersion: 1, nodeUrl: "http://unused.invalid", schemaServiceUrl: "http://unused.invalid", userHash: "fixture", schemaHashes: { card: "cardhash", board_cards: "boardcardshash" }, enforceLivePrMilestone: false }));
  const cards = [fixtureCard("earlier", "1"), fixtureCard("authorized", "9")];
  const queries: Array<{ schema_name?: string; filter?: { HashKey?: string; HashRangeKeys?: [string,string][]; HashRangePrefix?: { prefix: string } } }> = [];
  let writes = 0;
  const server = Bun.serve({
    unix: socket,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/control/browser-pairing-code") return Response.json({ pairing_code: "fixture" });
      if (path === "/api/session/browser-pair") return Response.json({ session_token: "fixture" });
      if (path === "/api/query") {
        const query = await req.json() as typeof queries[number];
        queries.push(query);
        const selected = query.schema_name === "cardhash"
          ? cards.filter((card) => card.slug === query.filter?.HashKey || query.filter?.HashRangeKeys?.some(([slug,range])=>slug===card.slug && range===""))
          : query.filter?.HashRangePrefix?.prefix === "todo#" ? cards : [];
        const results = selected.map((card) => ({
          fields: query.schema_name === "cardhash" ? cardToFields(card) : boardCardFieldsFromCard(card),
          key: { hash: query.schema_name === "cardhash" ? card.slug : "default", range: query.schema_name === "cardhash" ? null : boardCardSk("todo", card.position, card.slug) },
        }));
        return Response.json({ ok: true, results, returned_count: results.length, total_count: results.length, has_more: false });
      }
      writes += 1;
      return Response.json({ error: "unexpected fixture route", path }, { status: 500 });
    },
  });
  try {
    const result = await runCli(["pickup", "claim-v2", "--only-card", "authorized", "--dry-run", "--json"], config, socket);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout), "CLI exact-card selector reaches the adapter").toMatchObject({ result: "claimed", card: { slug: "authorized" }, dry_run: true });
    expect(queries.some((q) => q.filter?.HashRangePrefix?.prefix === "todo#")).toBe(false);
    expect(queries.filter(q=>q.filter?.HashRangeKeys).map(q=>q.filter!.HashRangeKeys)).toEqual([[["authorized",""]]]);
    expect(writes).toBe(0);
  } finally {
    server.stop(true);
  }
}, SPAWN_TEST_TIMEOUT_MS);

test("CLI exact-card: rejects a blank selector before config access", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kanban-only-card-blank-"));
  const result = await runCli(["pickup", "claim-v2", "--only-card= "], join(dir, "absent.json"), join(dir, "absent.sock"));
  expect(result.code, "CLI blank selector has the usage-error status").toBe(2);
  expect(result.stderr).toContain("--only-card requires a non-empty card slug");
}, SPAWN_TEST_TIMEOUT_MS);

test("CLI exact-card: rejects the selector on another pickup subcommand", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kanban-only-card-wrong-sub-"));
  const result = await runCli(["pickup", "claim", "--only-card", "authorized"], join(dir, "absent.json"), join(dir, "absent.sock"));
  expect(result.code, "CLI wrong-subcommand selector has the usage-error status").toBe(2);
  expect(result.stderr).toContain("--only-card does not apply to pickup claim");
}, SPAWN_TEST_TIMEOUT_MS);
