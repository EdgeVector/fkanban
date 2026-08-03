#!/usr/bin/env bun
/**
 * READ-ONLY probe: locate the ~194ms/call that `probe-client-overhead-vs-node-time.ts`
 * showed is spent OUTSIDE the node on every kanban read.
 *
 * Layers, outermost first:
 *   queryAll  -> queryAllPaged -> sdkTransport.send -> fetch(unix socket) -> node
 *
 * Timing each in the same process against the same socket says which boundary
 * the time is behind. A bare `fetch` to the same socket is the floor: whatever
 * it costs is the transport, and anything above it is ours.
 *
 * Writes nothing.
 *
 * Run: bun scripts/probe-where-the-194ms-goes.ts [reps]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { listBoards, listCards } from "../src/record.ts";
import { schemaHashFor } from "../src/config.ts";
import { fieldsFor } from "../src/schemas.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const REPS = Number(process.argv[2] ?? "15");
const cardHash = schemaHashFor("card", cfg);
const socketPath = cfg.nodeSocketPath;

const boards = await listBoards(node, cfg);
const cards = await listCards(node, cfg, { boards, activeOnly: true });
const slug = cards[0]?.slug;
if (!slug) throw new Error("no active card to probe");

const queryBody = {
  schema_name: cardHash,
  fields: fieldsFor("card"),
  limit: 1000,
  offset: 0,
  filter: { HashKey: slug },
};

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const time = async (fn: () => Promise<unknown>): Promise<number> => {
  const t = performance.now();
  await fn();
  return performance.now() - t;
};

// Layer 3 (floor): bare fetch over the same unix socket, no SDK, no client.
const bareFetch = async (path: string, body?: unknown): Promise<void> => {
  const res = await fetch(`http://localhost${path}`, {
    unix: socketPath,
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "X-LastDB-Client": "kanban" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  } as RequestInit & { unix: string });
  await res.text();
};

const arms: Record<string, number[]> = {
  "bare fetch GET /api/status": [],
  "bare fetch POST /api/query": [],
  "node.rawCall POST /api/query": [],
  "node.queryAll (full client)": [],
};

// Warm one of each first — a first-call handshake would otherwise land on
// whichever arm happens to run first and read as that layer's cost.
await bareFetch("/api/status");
await bareFetch("/api/query", queryBody);
await node.rawCall("POST", "/api/query", queryBody);
await node.queryAll({ schemaHash: cardHash, fields: fieldsFor("card"), filter: { HashKey: slug } as never });

// Interleaved: one rep of every arm per round, so drift hits all arms alike.
for (let i = 0; i < REPS; i++) {
  arms["bare fetch GET /api/status"]!.push(await time(() => bareFetch("/api/status")));
  arms["bare fetch POST /api/query"]!.push(await time(() => bareFetch("/api/query", queryBody)));
  arms["node.rawCall POST /api/query"]!.push(await time(() => node.rawCall("POST", "/api/query", queryBody)));
  arms["node.queryAll (full client)"]!.push(
    await time(() =>
      node.queryAll({ schemaHash: cardHash, fields: fieldsFor("card"), filter: { HashKey: slug } as never }),
    ),
  );
}

console.log(`${REPS} interleaved reps, same socket, same query, same process\n`);
let prev = 0;
for (const [label, xs] of Object.entries(arms)) {
  const m = median(xs);
  const delta = prev === 0 ? "" : `   (+${(m - prev).toFixed(1)}ms over the layer above)`;
  console.log(`  ${label.padEnd(30)} median ${m.toFixed(1).padStart(7)}ms${delta}`);
  prev = m;
}

console.log("\nA GET /api/status is ~176 KB of telemetry ring, so it is an upper bound on");
console.log("transport for a tiny response, not a like-for-like floor. The POST /api/query");
console.log("bare-fetch arm is the like-for-like one: identical bytes to the node's handler.");
