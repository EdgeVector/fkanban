#!/usr/bin/env bun
/**
 * Does field `s` fold from the board packed summary onto the milestone packed
 * summary when both schemas are declared on an empty node?
 *
 * Isolated node only. This probe registers schemas and writes one row. It
 * refuses a socket or data dir under ~/.lastdb or ~/.folddb. It does not call
 * protein control routes. Bind and fold stay the node's job.
 *
 *   bun scripts/probe-packed-summary-protein-fold.ts
 *
 * Exit 0 is a completed measurement (`fold` yes, no, or collapsed).
 * Exit 2 is a primary-home refusal. Exit 1 is a boot, declare, or write failure.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { newNodeClient, type NodeClient } from "../src/client.ts";
import { boardPackedSummarySk, packListSummary } from "../src/packed-summary.ts";
import {
  OWNER_APP_ID,
  boardCardsPackedSummarySchema,
  milestoneCardsPackedSummarySchema,
} from "../src/schemas.ts";

const PRIMARY_HOMES = [".lastdb", ".folddb"] as const;
const MAX_DATA_DIR_BYTES = 82;
const BOOT_TIMEOUT_MS = 45_000;
const FOLD_WAIT_MS = 20_000;
const POLL_MS = 500;

type Verdict = "yes" | "no" | "collapsed";

type Result = {
  verdict: Verdict;
  data_dir: string;
  socket: string;
  lastdbd: string;
  board_canonical: string;
  board_resolution: string;
  board_hash_field: string;
  board_fields: string[];
  milestone_canonical: string;
  milestone_resolution: string;
  milestone_hash_field: string;
  milestone_fields: string[];
  board: string;
  milestone: string;
  sk: string;
  wrote_s: string;
  sibling_rows: number;
  negative_rows: number;
  sibling_sample: unknown;
};

function primaryRoots(): string[] {
  const roots: string[] = [];
  for (const name of PRIMARY_HOMES) {
    const candidate = join(homedir(), name);
    if (!existsSync(candidate)) continue;
    roots.push(realpathSync(candidate));
  }
  return roots;
}

function pathExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err
      ? String((err as { code: unknown }).code)
      : "";
    // Bun lstat on a Unix socket can raise EOPNOTSUPP. The path is present.
    if (code === "EOPNOTSUPP" || code === "ENOTSUP") return true;
    throw err;
  }
}

function assertOutsidePrimary(path: string, label: string): void {
  // Do not realpath a socket. macOS and Bun reject lstat on a Unix socket.
  for (const root of primaryRoots()) {
    if (path === root || path.startsWith(`${root}/`)) {
      console.error(`REFUSING: ${label} ${path} is under primary home ${root}`);
      process.exit(2);
    }
  }
}

function lastdbdBin(): string {
  const fromEnv = process.env.LASTDBD_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const candidates = [
    join(homedir(), ".local/bin/lastdbd"),
    join(homedir(), ".lastdb/current/lastdbd"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  console.error("REFUSING: lastdbd binary not found. Set LASTDBD_BIN.");
  process.exit(1);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPath(path: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pathExists(path)) return true;
    await sleep(200);
  }
  return pathExists(path);
}

function stopDaemon(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

async function rowsFor(
  node: NodeClient,
  schemaHash: string,
  hash: string,
): Promise<Array<{ key: { hash: string | null; range: string | null }; fields: Record<string, unknown> }>> {
  const res = await node.queryAll({
    schemaHash,
    fields: ["board", "sk", "milestone", "s"],
    filter: { HashKey: hash },
  });
  return res.results.map((row) => ({
    key: row.key,
    fields: (row.fields ?? {}) as Record<string, unknown>,
  }));
}

async function main(): Promise<number> {
  const bin = lastdbdBin();
  // macOS sockaddr_un rejects a socket under the long TMPDIR real path.
  // lastdbd requires the data dir itself to be at most 82 bytes.
  const scratch = join(homedir(), ".cache");
  mkdirSync(scratch, { recursive: true });
  const dataDir = realpathSync(mkdtempSync(join(scratch, "psp-")));
  if (Buffer.byteLength(dataDir) > MAX_DATA_DIR_BYTES) {
    console.error(
      `REFUSING: data dir is ${Buffer.byteLength(dataDir)} bytes; lastdbd allows ${MAX_DATA_DIR_BYTES}`,
    );
    process.exit(1);
  }
  assertOutsidePrimary(dataDir, "data dir");
  mkdirSync(join(dataDir, "data"), { recursive: true });
  const socketPath = join(dataDir, "data", "folddb.sock");
  const fullSocketPath = join(dataDir, "data", "folddb-full.sock");
  assertOutsidePrimary(socketPath, "socket");

  const stderrTail: string[] = [];
  const child = spawn(bin, ["--data-dir", dataDir], {
    detached: true,
    env: {
      ...process.env,
      LASTDB_HOME: dataDir,
      FOLDDB_HOME: dataDir,
      FOLDDB_DISABLE_KEYCHAIN: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const keepTail = (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.length === 0) continue;
      stderrTail.push(line);
      if (stderrTail.length > 40) stderrTail.shift();
    }
  };
  child.stdout?.on("data", keepTail);
  child.stderr?.on("data", keepTail);
  child.on("error", (err) => {
    stderrTail.push(`spawn error: ${err.message}`);
  });

  try {
    const sockReady = await waitForPath(socketPath, BOOT_TIMEOUT_MS);
    if (!sockReady) {
      console.error("lastdbd did not create the data socket");
      console.error(stderrTail.join("\n"));
      return 1;
    }
    await waitForPath(fullSocketPath, 5_000);
    const clientSocket = pathExists(fullSocketPath) ? fullSocketPath : socketPath;
    assertOutsidePrimary(clientSocket, "client socket");
    if (clientSocket === join(homedir(), ".lastdb", "data", "folddb.sock")) {
      console.error(`REFUSING: client socket is the primary brain (${clientSocket})`);
      return 2;
    }

    const probe = newNodeClient({
      baseUrl: "http://127.0.0.1",
      userHash: "packed-summary-probe",
      socketPath: clientSocket,
      opsLabel: "probe-packed-summary",
    });
    const identity = await probe.autoIdentity();
    const userHash = identity.provisioned
      ? identity.userHash
      : (await probe.bootstrap("packed-summary-probe")).userHash;
    const node = newNodeClient({
      baseUrl: "http://127.0.0.1",
      userHash,
      socketPath: clientSocket,
      opsLabel: "probe-packed-summary",
    });
    if (!node.declareAppSchema || !node.getSchema) {
      console.error("node client has no declareAppSchema or getSchema");
      return 1;
    }

    const boardDeclared = await node.declareAppSchema(
      OWNER_APP_ID,
      boardCardsPackedSummarySchema.schema as unknown as Record<string, unknown>,
    );
    const milestoneDeclared = await node.declareAppSchema(
      OWNER_APP_ID,
      milestoneCardsPackedSummarySchema.schema as unknown as Record<string, unknown>,
    );
    const boardLoaded = await node.getSchema(boardDeclared.canonical);
    const milestoneLoaded = await node.getSchema(milestoneDeclared.canonical);

    const board = "probe-board";
    const milestone = "probe-milestone";
    const absentMilestone = "probe-milestone-absent";
    const sk = boardPackedSummarySk("todo", 1, "probe-card");
    const wroteS = packListSummary({
      slug: "probe-card",
      title: "probe",
      column: "todo",
      position: "1",
    });

    const shapeOk =
      boardLoaded.key.hash_field === "board" &&
      boardLoaded.fields.includes("s") &&
      milestoneLoaded.key.hash_field === "milestone" &&
      milestoneLoaded.fields.includes("s") &&
      boardDeclared.canonical !== milestoneDeclared.canonical;

    const result: Result = {
      verdict: shapeOk ? "no" : "collapsed",
      data_dir: dataDir,
      socket: clientSocket,
      lastdbd: bin,
      board_canonical: boardDeclared.canonical,
      board_resolution: boardDeclared.resolution,
      board_hash_field: boardLoaded.key.hash_field,
      board_fields: boardLoaded.fields,
      milestone_canonical: milestoneDeclared.canonical,
      milestone_resolution: milestoneDeclared.resolution,
      milestone_hash_field: milestoneLoaded.key.hash_field,
      milestone_fields: milestoneLoaded.fields,
      board,
      milestone,
      sk,
      wrote_s: wroteS,
      sibling_rows: 0,
      negative_rows: 0,
      sibling_sample: null,
    };

    if (!shapeOk) {
      console.log(`RESULT ${JSON.stringify(result)}`);
      return 0;
    }

    await node.createRecord({
      schemaHash: boardDeclared.canonical,
      keyHash: board,
      rangeKey: sk,
      durability: "durable",
      fields: { board, sk, milestone, s: wroteS },
    });

    const deadline = Date.now() + FOLD_WAIT_MS;
    let sibling: Awaited<ReturnType<typeof rowsFor>> = [];
    do {
      sibling = await rowsFor(node, milestoneDeclared.canonical, milestone);
      if (sibling.some((row) => row.fields.s === wroteS)) break;
      if (Date.now() >= deadline) break;
      await sleep(POLL_MS);
    } while (Date.now() < deadline);

    const negative = await rowsFor(node, milestoneDeclared.canonical, absentMilestone);
    const folded = sibling.some((row) => row.fields.s === wroteS);
    result.verdict = folded ? "yes" : "no";
    result.sibling_rows = sibling.length;
    result.negative_rows = negative.length;
    result.sibling_sample = sibling[0] ?? null;
    console.log(`RESULT ${JSON.stringify(result)}`);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`probe failed: ${message}`);
    console.error(stderrTail.join("\n"));
    return 1;
  } finally {
    stopDaemon(child);
    await sleep(300);
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  }
}

const code = await main();
process.exit(code);
