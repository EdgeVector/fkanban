// Proof for the one-head column list. Runs on an empty node. The dev schema
// service is the node's FOLD_SCHEMA_SERVICE_URL. This file is a live proof,
// not a test suite.
//
// write: store the wide cards, then one head atom.
// read <wide20|wideall|head>: one query per board. Restart the node before
// the call when the number must be the first read of that board. A second
// query in the same process is a follow-up read, so this command refuses
// to run more than one shape.
import { newNodeClient, type NodeClient, type RawResponse } from "../src/client.ts";
import {
  BOARD_CARDS_FIELDS,
  BOARD_CARDS_LAYOUT,
  OWNER_APP_ID,
  boardCardsSchema,
  kanbanListHeadSchema,
} from "../src/schemas.ts";
import { headCardFrom, readColumnHead, writeColumnHead, LIST_HEAD_CAP } from "../src/list-head.ts";

const BENCH_HOME = process.env.BENCH_HOME ?? "/tmp/kbnhead";
const SOCKET = process.env.BENCH_SOCKET ?? `${BENCH_HOME}/data/folddb.sock`;
const HASH_FILE = process.env.BENCH_HASH_FILE ?? `${BENCH_HOME}/hashes.json`;
const COUNTS = [20, 100, 400];
const BOARD = "bench";
const READ_SHAPES = ["wide20", "wideall", "head"] as const;

type ReadShape = (typeof READ_SHAPES)[number];

type Hashes = { wide: string; head: string };

function boardFor(count: number): string {
  return `${BOARD}${count}`;
}

function pad(n: number): string {
  return String(n).padStart(8, "0");
}

function receipt(res: RawResponse): Record<string, number | string> {
  const raw = res.headers.get("x-lastdb-read-receipt");
  if (!raw) return { requested_keys: -1, file_opens: -1, group_opens: -1, elapsed_ms: -1 };
  const parsed = JSON.parse(raw) as Record<string, number>;
  return {
    requested_keys: parsed.requested_keys ?? -1,
    file_opens: parsed.file_opens ?? -1,
    group_opens: parsed.group_opens ?? -1,
    elapsed_ms: Math.round((parsed.query_storage_elapsed_nanos ?? 0) / 1e6),
  };
}

function isReadShape(value: string): value is ReadShape {
  return (READ_SHAPES as readonly string[]).includes(value);
}

function returnedCount(res: RawResponse): number {
  const body = res.json as { results?: unknown[]; returned_count?: number } | null;
  if (!body) return -1;
  if (typeof body.returned_count === "number") return body.returned_count;
  return Array.isArray(body.results) ? body.results.length : -1;
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "write";
  process.env.LASTDB_READ_RECEIPT = "1";
  const node = newNodeClient({
    baseUrl: "http://127.0.0.1",
    userHash: "list-head-bench",
    socketPath: SOCKET,
    opsLabel: "kanban-list-head-bench",
    timeoutMs: 120000,
    warn: (line) => console.error(line),
  });

  if (mode === "write") {
    const identity = await node.autoIdentity();
    if (!identity.provisioned) await node.bootstrap("list-head-bench");
    const wideDecl = await node.declareAppSchema!(OWNER_APP_ID, boardCardsSchema.schema);
    const headDecl = await node.declareAppSchema!(OWNER_APP_ID, kanbanListHeadSchema.schema);
    const wideDetail = await node.getSchema!(wideDecl.canonical);
    const headDetail = await node.getSchema!(headDecl.canonical);
    if (wideDetail.key.hash_field !== "board" || wideDetail.key.range_field !== "sk") {
      throw new Error(`wide key changed: ${JSON.stringify(wideDetail.key)}`);
    }
    if (headDetail.key.hash_field !== "klh_h" || headDetail.key.range_field !== "klh_r") {
      throw new Error(`head key changed: ${JSON.stringify(headDetail.key)}`);
    }
    const hashes: Hashes = { wide: wideDecl.canonical, head: headDecl.canonical };
    await Bun.write(HASH_FILE, JSON.stringify(hashes));
    console.log(`wide ${wideDecl.resolution} ${wideDecl.canonical}`);
    console.log(`head ${headDecl.resolution} ${headDecl.canonical}`);

    for (const count of COUNTS) {
      const board = boardFor(count);
      const rows = [];
      for (let i = 0; i < count; i++) {
        const slug = `c${i}`;
        const fields: Record<string, unknown> = {};
        for (const name of BOARD_CARDS_FIELDS) fields[name] = "";
        fields.tags = [];
        fields.deps = [];
        fields.surfaces = [];
        fields.board = board;
        fields.sk = `todo#${pad(i)}#${slug}`;
        fields.slug = slug;
        fields.title = `title ${i}`;
        fields.column = "todo";
        fields.position = pad(i);
        fields.layout = BOARD_CARDS_LAYOUT;
        rows.push({
          schemaHash: hashes.wide,
          keyHash: board,
          rangeKey: fields.sk as string,
          fields,
        });
      }
      const started = Date.now();
      for (let i = 0; i < rows.length; i += 64) {
        await node.updateRecords(rows.slice(i, i + 64));
      }
      const wideMs = Date.now() - started;
      const cards = rows.map((row) => headCardFrom({
        slug: String(row.fields.slug),
        title: String(row.fields.title),
        board,
        column: "todo",
        position: String(row.fields.position),
      }));
      const headStarted = Date.now();
      const atom = await writeColumnHead(node, hashes.head, board, "todo", cards);
      const headMs = Date.now() - headStarted;
      console.log(
        `write count=${count} card_write_ms=${wideMs} head_atom_ms=${headMs} head_titles=${atom.cards.length} partial=${atom.partial}`,
      );
    }
    return;
  }

  if (mode !== "read" || !isReadShape(process.argv[3] ?? "")) {
    throw new Error("use write, or read wide20, or read wideall, or read head");
  }
  const shape = process.argv[3] as ReadShape;
  const hashes = JSON.parse(await Bun.file(HASH_FILE).text()) as Hashes;
  for (const count of COUNTS) {
    const board = boardFor(count);
    const res = await readShape(node, hashes, board, shape);
    const got = receipt(res);
    console.log(
      `read shape=${shape} count=${count} board_query=1 returned=${returnedCount(res)} keys=${got.requested_keys} files=${got.file_opens} groups=${got.group_opens} ms=${got.elapsed_ms} cap=${LIST_HEAD_CAP}`,
    );
  }
}

function readShape(
  node: NodeClient,
  hashes: Hashes,
  board: string,
  shape: ReadShape,
): Promise<RawResponse> {
  if (shape === "head") return readColumnHead(node, hashes.head, board, "todo");
  return node.rawCall("POST", "/api/query", {
    schema_name: hashes.wide,
    fields: ["slug", "title"],
    filter: { HashRangePrefix: { hash: board, prefix: "todo#" } },
    limit: shape === "wide20" ? 20 : 1000,
    offset: 0,
  });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
