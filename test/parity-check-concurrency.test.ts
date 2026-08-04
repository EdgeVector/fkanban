// In-flight ceiling for `parity-check` — the one path `concurrency.ts` is most
// explicit about bounding, and the one that was silently running 12x over.
//
// Why this file exists: `PARTITION_READ_CONCURRENCY` is 12, `test/concurrency.test.ts`
// pins that it is 12, and the constant's docstring rejects a width of 24 as
// "unbounded for this call site". None of that was true of the code. The
// milestone loop in `parity_check.ts` pooled PARTITIONS at 12, and
// `sweepMilestoneCardsPartition` pools its 24 LEADS at 12 inside each one.
// Nested pools multiply, so the real ceiling was 144 — measured on the live
// primary 2026-08-04 with `scripts/probe-parity-nested-pool-width.ts`, which
// gauged MAX IN FLIGHT = 144 on a 26-partition, 637-read run.
//
// A test that reads the constant back cannot catch this: the constant was
// always right. Only counting reads that are ACTUALLY OVERLAPPING can, so this
// counts in-flight requests at the socket and holds each one open long enough
// for overlap to be observable. That also means the assertion survives someone
// re-introducing a pool anywhere in the tree, not just at the line that had one.
//
// The fixture is a real HTTP-over-unix-socket node for the same reason the
// read-amplification family uses one: what is counted is genuine round trips.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parityCheckResult } from "../src/commands/parity_check.ts";
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { PARTITION_READ_CONCURRENCY } from "../src/concurrency.ts";
import { fieldsFor } from "../src/schemas.ts";
import { BOARD_LIST_INDEX_KEY, CARD_LIST_INDEX_KEY } from "../src/card-list-index.ts";

const CARD_HASH = "parcardhash";
const BOARD_HASH = "parboardhash";
const MILESTONE_HASH = "parmilestonehash";
const BOARD_CARDS_HASH = "parboardcardshash";
const BOARD_MILESTONES_HASH = "parboardmilestoneshash";
const MILESTONE_CARDS_HASH = "parmilestonecardshash";
const CARD_LIST_INDEX_HASH = "parcardlistindexhash";

/** Long enough that any genuine overlap is observed, short enough to stay fast. */
const HOLD_MS = 12;

/**
 * A socket node that reports the high-water mark of CONCURRENT queries.
 *
 * Every query is held open for `HOLD_MS`, so requests that are actually in
 * flight together are counted together. Without the hold, a fast fixture can
 * answer each request before the next is issued and report a ceiling of 1 for
 * code that fans out arbitrarily wide.
 */
function makeConcurrencyNode(opts: { milestones: number; cardsPerMilestone: number }) {
  const dir = mkdtempSync(join(tmpdir(), "fkanban-parity-conc-"));
  const socketPath = join(dir, "folddb.sock");

  let inFlight = 0;
  let maxInFlight = 0;
  let queries = 0;

  const boardSummaries = [
    {
      slug: "default",
      title: "default board",
      body: "",
      columns: ["backlog", "todo", "doing", "done"],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  ];

  const store = new Map<string, Record<string, unknown>>();
  store.set(`${CARD_LIST_INDEX_HASH}::${BOARD_LIST_INDEX_KEY}`, {
    key: BOARD_LIST_INDEX_KEY,
    payload_json: JSON.stringify(boardSummaries),
    updated_at: "2026-01-01T00:00:00.000Z",
  });
  store.set(`${CARD_LIST_INDEX_HASH}::${CARD_LIST_INDEX_KEY}`, {
    key: CARD_LIST_INDEX_KEY,
    payload_json: JSON.stringify([]),
    updated_at: "2026-01-01T00:00:00.000Z",
  });
  store.set(`${BOARD_HASH}::default`, { ...boardSummaries[0] });

  // One BoardCards row per card, each tagged with a milestone. The milestone
  // partitions parity sweeps are harvested from exactly this `milestone` field,
  // so the count here is what sets the OUTER fan-out width under test.
  const boardCardRows: Array<Record<string, unknown>> = [];
  const milestoneCardRows: Array<Record<string, unknown>> = [];
  for (let m = 0; m < opts.milestones; m += 1) {
    const milestone = `ms-${m}`;
    store.set(`${MILESTONE_HASH}::${milestone}`, {
      slug: milestone,
      title: `milestone ${m}`,
      body: "",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    for (let i = 0; i < opts.cardsPerMilestone; i += 1) {
      const slug = `${milestone}-card-${i}`;
      const common = {
        slug,
        title: `card ${i}`,
        column: "todo",
        position: String(i),
        assignee: "",
        tags: [],
        deps: [],
        surfaces: [],
        created_at: "2026-01-01T00:00:00.000Z",
        created_by: "",
        updated_at: "2026-01-01T00:00:00.000Z",
        db: "",
        repo: "",
        base: "",
        kind: "",
        block_status: "",
        block_reason: "",
        north_star: "",
        milestone,
      };
      boardCardRows.push({ ...common, board: "default", sk: `todo#0000${i}#${slug}` });
      milestoneCardRows.push({
        ...common,
        board: "default",
        milestone,
        sk: `todo#0000${i}#${slug}`,
        pr_url: "",
        branch: "",
        layout: "",
      });
    }
  }

  const server = Bun.serve({
    unix: socketPath,
    async fetch(req) {
      const url = new URL(req.url);
      let body: Record<string, unknown> | undefined;
      if (req.method === "POST") {
        const text = await req.text();
        body = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
      }
      if (url.pathname === "/api/system/auto-identity") return Response.json({ user_hash: "u" });
      if (url.pathname === "/api/schemas") {
        return Response.json({
          schemas: [
            { name: CARD_HASH, descriptive_name: "Card", owner_app_id: "fkanban", fields: fieldsFor("card") },
            { name: BOARD_HASH, descriptive_name: "Board", owner_app_id: "fkanban", fields: fieldsFor("board") },
            { name: MILESTONE_HASH, descriptive_name: "Milestone", owner_app_id: "fkanban", fields: fieldsFor("milestone") },
          ],
        });
      }
      if (url.pathname !== "/api/query") {
        return Response.json({ error: "unexpected", path: url.pathname }, { status: 500 });
      }

      inFlight += 1;
      queries += 1;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      try {
        await Bun.sleep(HOLD_MS);
        const schema = body!.schema_name as string;
        const filter = body!.filter as
          | { HashKey?: string; HashRange?: { hash?: string } }
          | undefined;
        const hashKey = filter?.HashKey ?? filter?.HashRange?.hash ?? null;

        if (schema === BOARD_CARDS_HASH) {
          const rows = boardCardRows
            .filter((r) => hashKey === null || r.board === hashKey)
            .map((r) => ({ fields: r, key: { hash: String(r.board), range: String(r.sk) } }));
          return Response.json({ ok: true, results: rows, has_more: false });
        }
        if (schema === MILESTONE_CARDS_HASH) {
          const rows = milestoneCardRows
            .filter((r) => hashKey === null || r.milestone === hashKey)
            .map((r) => ({ fields: r, key: { hash: String(r.milestone), range: String(r.sk) } }));
          return Response.json({ ok: true, results: rows, has_more: false });
        }
        if (schema === BOARD_MILESTONES_HASH) {
          return Response.json({ ok: true, results: [], has_more: false });
        }
        const rows = [...store.entries()]
          .filter(([key]) => key.startsWith(`${schema}::`))
          .map(([key, f]) => ({ fields: f, key: { hash: key.split("::")[1]!, range: null } }))
          .filter((r) => hashKey === null || r.key.hash === hashKey);
        return Response.json({ ok: true, results: rows, has_more: false });
      } finally {
        inFlight -= 1;
      }
    },
  });

  return {
    socketPath,
    stats: () => ({ maxInFlight, queries }),
    stop: () => {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const tmp = mkdtempSync(join(tmpdir(), "fkanban-parity-conc-cfg-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function closedTcpUrl(): string {
  const server = Bun.serve({ port: 0, fetch: () => Response.json({}) });
  const url = `http://127.0.0.1:${server.port}`;
  server.stop(true);
  return url;
}

function writeCfg(name: string, socketPath: string): string {
  const p = join(tmp, name);
  writeFileSync(
    p,
    JSON.stringify({
      configVersion: 1,
      nodeUrl: closedTcpUrl(),
      schemaServiceUrl: "http://unused.invalid",
      userHash: "u",
      schemaHashes: {
        card: CARD_HASH,
        board: BOARD_HASH,
        milestone: MILESTONE_HASH,
        board_cards: BOARD_CARDS_HASH,
        board_milestones: BOARD_MILESTONES_HASH,
        milestone_cards: MILESTONE_CARDS_HASH,
        card_list_index: CARD_LIST_INDEX_HASH,
      },
      nodeSocketPath: socketPath,
    }),
  );
  return p;
}

describe("parity-check in-flight ceiling", () => {
  test("never exceeds PARTITION_READ_CONCURRENCY, however the sweeps nest", async () => {
    // Six milestones is deliberately BELOW the pool width: the outer pool would
    // admit all six at once, and each one's lead sweep then opens up to 12 more.
    // So the bug shows as ~72 in flight, not as some width-12 boundary case, and
    // the test cannot be satisfied by merely lowering a constant somewhere.
    const node = makeConcurrencyNode({ milestones: 6, cardsPerMilestone: 2 });
    const cfgPath = writeCfg("ceiling.json", node.socketPath);
    try {
      const cfg = readConfig(cfgPath);
      const client = newNodeClient({
        baseUrl: cfg.nodeUrl,
        userHash: cfg.userHash,
        socketPath: cfg.nodeSocketPath,
        opsLabel: "kanban-parity",
      });
      const report = await parityCheckResult({ cfg, node: client });

      // The check must actually have run — a ceiling of 0 passes any bound.
      expect(report.partitions_checked).toBeGreaterThan(6);
      const { maxInFlight, queries } = node.stats();
      expect(queries).toBeGreaterThan(50);
      expect(maxInFlight).toBeGreaterThan(1); // the inner lead pool still fans out
      expect(maxInFlight).toBeLessThanOrEqual(PARTITION_READ_CONCURRENCY);
    } finally {
      node.stop();
    }
  });
});
