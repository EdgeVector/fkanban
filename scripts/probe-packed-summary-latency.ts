#!/usr/bin/env bun
/**
 * Warm read latency for three shapes of the same 20-row payload.
 *
 * Isolated node only. Declares BoardCards and BoardCardsPackedSummary, writes
 * 20 durable rows, and times three partition reads. The packed schemas stay
 * out of EXTRA_SCHEMAS. This probe does not flip a read and does not call
 * protein control routes.
 *
 *   bun scripts/probe-packed-summary-latency.ts
 *
 * Exit 0 is a completed measurement.
 * Exit 2 is a primary-home refusal.
 * Exit 1 is a boot, declare, write, or count failure.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { newNodeClient, type NodeClient } from "../src/client.ts";
import {
  LATENCY_COMPARE_SUBSET,
  boardPackedSummarySk,
  medianMs,
  packEqualFieldMap,
} from "../src/packed-summary.ts";
import {
  BOARD_CARDS_FIELDS,
  BOARD_CARDS_LAYOUT,
  OWNER_APP_ID,
  boardCardsPackedSummarySchema,
  boardCardsSchema,
} from "../src/schemas.ts";

const PRIMARY_HOMES = [".lastdb", ".folddb"] as const;
const MAX_DATA_DIR_BYTES = 82;
const BOOT_TIMEOUT_MS = 45_000;
const READ_WAIT_MS = 20_000;
const ROW_COUNT = 20;
const WARM_SAMPLES = 9;
const BOARD = "lat-board";
const MILESTONE = "lat-milestone";
const COMMAND = "bun scripts/probe-packed-summary-latency.ts";

type Shape = "wide" | "subset" | "packed_s";

type Result = {
  rows: number;
  warm_samples: number;
  cold_ms: Record<Shape, number>;
  warm_median_ms: Record<Shape, number>;
  warm_samples_ms: Record<Shape, number[]>;
  payload_chars: Record<Shape, number>;
  subset: readonly string[];
  command: string;
  lastdbd: string;
  data_dir: string;
  socket: string;
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

function primaryHit(path: string): string | null {
  for (const root of primaryRoots()) {
    if (path === root || path.startsWith(`${root}/`)) return root;
  }
  return null;
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

function roundMs(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}

function wideFields(index: number): Record<string, unknown> {
  const slug = `lat-${String(index).padStart(2, "0")}`;
  const column = "todo";
  const position = String(index + 1);
  return {
    board: BOARD,
    sk: boardPackedSummarySk(column, position, slug),
    slug,
    title: `Latency row ${index + 1}`,
    column,
    position,
    assignee: "probe",
    tags: ["latency"],
    deps: [] as string[],
    surfaces: ["probe"],
    created_at: "2026-10-01T00:00:00Z",
    created_by: "probe",
    updated_at: "2026-10-01T00:00:01Z",
    db: "none",
    repo: "EdgeVector/fkanban",
    base: "main",
    kind: "pr",
    block_status: "none",
    block_reason: "",
    north_star: "north-star-lastdb-storage-simplification",
    milestone: MILESTONE,
    pr_url: "",
    branch: "",
    layout: BOARD_CARDS_LAYOUT,
  };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

type ReadRow = { sk: string; fields: Record<string, unknown> };

async function readPartition(
  node: NodeClient,
  schemaHash: string,
  fields: readonly string[],
): Promise<ReadRow[]> {
  const res = await node.queryAll({
    schemaHash,
    fields: [...fields],
    filter: { HashKey: BOARD },
  });
  return res.results.map((row) => ({
    // Field `s` is the packed projection. The range key still identifies the row.
    sk: row.key.range ?? String(row.fields.sk ?? ""),
    fields: row.fields,
  }));
}

async function firstFullRead(
  node: NodeClient,
  schemaHash: string,
  fields: readonly string[],
  label: string,
): Promise<{ ms: number; rows: ReadRow[] }> {
  const deadline = Date.now() + READ_WAIT_MS;
  let seen = 0;
  while (Date.now() < deadline) {
    const start = performance.now();
    const rows = await readPartition(node, schemaHash, fields);
    const ms = performance.now() - start;
    seen = rows.length;
    if (seen === ROW_COUNT) return { ms, rows };
    await sleep(200);
  }
  throw new Error(`${label} returned ${seen} rows, want ${ROW_COUNT}`);
}

async function timeRead(
  node: NodeClient,
  schemaHash: string,
  fields: readonly string[],
  label: string,
): Promise<{ ms: number; rows: ReadRow[] }> {
  const start = performance.now();
  const rows = await readPartition(node, schemaHash, fields);
  const ms = performance.now() - start;
  if (rows.length !== ROW_COUNT) {
    throw new Error(`${label} returned ${rows.length} rows, want ${ROW_COUNT}`);
  }
  return { ms, rows };
}

function payloadChars(rows: ReadRow[]): number {
  return JSON.stringify(rows.map((row) => row.fields)).length;
}

function valuesMatch(
  written: Array<Record<string, unknown>>,
  wideRows: ReadRow[],
  packedRows: ReadRow[],
): string | null {
  const wideBySk = new Map(wideRows.map((row) => [row.sk, row.fields]));
  const packedBySk = new Map(packedRows.map((row) => [row.sk, row.fields]));
  for (const fields of written) {
    const sk = String(fields.sk);
    const wide = wideBySk.get(sk);
    const packed = packedBySk.get(sk);
    if (!wide || !packed) return `missing sk ${sk}`;
    for (const key of BOARD_CARDS_FIELDS) {
      if (!sameJson(wide[key], fields[key])) {
        return `wide ${key} on ${sk} is ${JSON.stringify(wide[key])}`;
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(packed.s));
    } catch {
      return `field s on ${sk} is not JSON`;
    }
    if (!sameJson(parsed, fields)) return `field s on ${sk} does not match the wide row`;
  }
  return null;
}

async function main(): Promise<number> {
  const bin = lastdbdBin();
  // macOS sockaddr_un rejects a socket under the long TMPDIR real path.
  // lastdbd requires the data dir itself to be at most 82 bytes.
  const scratch = join(homedir(), ".cache");
  mkdirSync(scratch, { recursive: true });
  let dataDir = "";
  let child: ChildProcess | undefined;
  const stderrTail: string[] = [];

  try {
    dataDir = realpathSync(mkdtempSync(join(scratch, "psl-")));
    if (Buffer.byteLength(dataDir) > MAX_DATA_DIR_BYTES) {
      console.error(
        `REFUSING: data dir is ${Buffer.byteLength(dataDir)} bytes; lastdbd allows ${MAX_DATA_DIR_BYTES}`,
      );
      return 1;
    }
    const hit = primaryHit(dataDir);
    if (hit) {
      console.error(`REFUSING: data dir ${dataDir} is under primary home ${hit}`);
      return 2;
    }
    mkdirSync(join(dataDir, "data"), { recursive: true });
    const socketPath = join(dataDir, "data", "folddb.sock");
    const fullSocketPath = join(dataDir, "data", "folddb-full.sock");
    const socketHit = primaryHit(socketPath);
    if (socketHit) {
      console.error(`REFUSING: socket ${socketPath} is under primary home ${socketHit}`);
      return 2;
    }

    child = spawn(bin, ["--data-dir", dataDir], {
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

    const sockReady = await waitForPath(socketPath, BOOT_TIMEOUT_MS);
    if (!sockReady) {
      console.error("lastdbd did not create the data socket");
      console.error(stderrTail.join("\n"));
      return 1;
    }
    await waitForPath(fullSocketPath, 5_000);
    const clientSocket = pathExists(fullSocketPath) ? fullSocketPath : socketPath;
    const clientHit = primaryHit(clientSocket);
    if (clientHit || clientSocket === join(homedir(), ".lastdb", "data", "folddb.sock")) {
      console.error(`REFUSING: client socket ${clientSocket} is a primary home`);
      return 2;
    }

    const probe = newNodeClient({
      baseUrl: "http://127.0.0.1",
      userHash: "packed-summary-latency",
      socketPath: clientSocket,
      opsLabel: "probe-packed-summary-latency",
    });
    const identity = await probe.autoIdentity();
    const userHash = identity.provisioned
      ? identity.userHash
      : (await probe.bootstrap("packed-summary-latency")).userHash;
    const node = newNodeClient({
      baseUrl: "http://127.0.0.1",
      userHash,
      socketPath: clientSocket,
      opsLabel: "probe-packed-summary-latency",
    });
    if (!node.declareAppSchema || !node.getSchema) {
      console.error("node client has no declareAppSchema or getSchema");
      return 1;
    }

    const boardDeclared = await node.declareAppSchema(
      OWNER_APP_ID,
      boardCardsSchema.schema as unknown as Record<string, unknown>,
    );
    const packedDeclared = await node.declareAppSchema(
      OWNER_APP_ID,
      boardCardsPackedSummarySchema.schema as unknown as Record<string, unknown>,
    );
    const boardLoaded = await node.getSchema(boardDeclared.canonical);
    const packedLoaded = await node.getSchema(packedDeclared.canonical);
    if (boardLoaded.key.hash_field !== "board" || packedLoaded.key.hash_field !== "board") {
      console.error("declared schema hash field is not board");
      return 1;
    }
    if (!packedLoaded.fields.includes("s")) {
      console.error("packed schema has no field s");
      return 1;
    }

    const written: Array<Record<string, unknown>> = [];
    for (let index = 0; index < ROW_COUNT; index += 1) {
      const fields = wideFields(index);
      const packedS = packEqualFieldMap(fields);
      written.push(fields);
      await node.createRecord({
        schemaHash: boardDeclared.canonical,
        keyHash: BOARD,
        rangeKey: String(fields.sk),
        durability: "durable",
        fields,
      });
      await node.createRecord({
        schemaHash: packedDeclared.canonical,
        keyHash: BOARD,
        rangeKey: String(fields.sk),
        durability: "durable",
        fields: {
          board: BOARD,
          sk: fields.sk,
          milestone: MILESTONE,
          s: packedS,
        },
      });
    }

    const coldWide = await firstFullRead(node, boardDeclared.canonical, BOARD_CARDS_FIELDS, "wide");
    const coldSubset = await firstFullRead(
      node,
      boardDeclared.canonical,
      LATENCY_COMPARE_SUBSET,
      "subset",
    );
    const coldPacked = await firstFullRead(node, packedDeclared.canonical, ["s"], "packed_s");
    const mismatch = valuesMatch(written, coldWide.rows, coldPacked.rows);
    if (mismatch) {
      console.error(`payload mismatch: ${mismatch}`);
      return 1;
    }
    if (coldSubset.rows.length !== ROW_COUNT) {
      console.error(`subset returned ${coldSubset.rows.length} rows`);
      return 1;
    }

    const warm: Record<Shape, number[]> = { wide: [], subset: [], packed_s: [] };
    const shapes: Array<{ shape: Shape; schemaHash: string; fields: readonly string[] }> = [
      { shape: "wide", schemaHash: boardDeclared.canonical, fields: BOARD_CARDS_FIELDS },
      { shape: "subset", schemaHash: boardDeclared.canonical, fields: LATENCY_COMPARE_SUBSET },
      { shape: "packed_s", schemaHash: packedDeclared.canonical, fields: ["s"] },
    ];
    for (let sample = 0; sample < WARM_SAMPLES; sample += 1) {
      for (let step = 0; step < shapes.length; step += 1) {
        const item = shapes[(sample + step) % shapes.length]!;
        const timed = await timeRead(node, item.schemaHash, item.fields, item.shape);
        warm[item.shape].push(timed.ms);
      }
    }

    const result: Result = {
      rows: ROW_COUNT,
      warm_samples: WARM_SAMPLES,
      cold_ms: {
        wide: roundMs(coldWide.ms),
        subset: roundMs(coldSubset.ms),
        packed_s: roundMs(coldPacked.ms),
      },
      warm_median_ms: {
        wide: roundMs(medianMs(warm.wide)),
        subset: roundMs(medianMs(warm.subset)),
        packed_s: roundMs(medianMs(warm.packed_s)),
      },
      warm_samples_ms: {
        wide: warm.wide.map(roundMs),
        subset: warm.subset.map(roundMs),
        packed_s: warm.packed_s.map(roundMs),
      },
      payload_chars: {
        wide: payloadChars(coldWide.rows),
        subset: payloadChars(coldSubset.rows),
        packed_s: payloadChars(coldPacked.rows),
      },
      subset: LATENCY_COMPARE_SUBSET,
      command: COMMAND,
      lastdbd: bin,
      data_dir: dataDir,
      socket: clientSocket,
    };
    console.log(`RESULT ${JSON.stringify(result)}`);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`probe failed: ${message}`);
    console.error(stderrTail.join("\n"));
    return 1;
  } finally {
    if (child) {
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
    if (dataDir.includes("/.cache/psl-")) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* the measurement already printed */
      }
    }
  }
}

const code = await main();
process.exit(code);
