// Independent compiled public proof on one fresh private Mini. No primary writes.
import assert from "node:assert/strict";
import { closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readConfig } from "../src/config.ts";
import { allPinnedSchemas, CARD_FIELDS, DEFAULT_COLUMNS } from "../src/schemas.ts";
import { boardCardFieldsFromCard } from "../src/board-cards.ts";
import { COMPOUND_CARD_BUILD, COMPOUND_CARD_BUILDS, sha256 } from "../src/guarded-snapshot.ts";
import { CREATE_ONLY_CONTRACT, CREATE_ONLY_CONTRACT_SHA256 } from "../src/create-only-card.ts";

const { values } = parseArgs({ args: process.argv.slice(2), strict: true, allowPositionals: false,
  options: { "artifact-root": { type: "string" }, "mini-bin": { type: "string" }, "mini-build": { type: "string", default: COMPOUND_CARD_BUILD },
    "dedupe-mode": { type: "string", default: "off" }, help: { type: "boolean" } } });
if (values.help) {
  console.log("Usage: bun scripts/probe-create-only-public.ts [--artifact-root PATH] [--mini-bin PATH] [--mini-build EXACT] [--dedupe-mode off|on]");
  process.exit(0);
}
assert(["off", "on"].includes(values["dedupe-mode"]!), "dedupe-mode must be off or on");
const expectedBuild = values["mini-build"]!;
assert(COMPOUND_CARD_BUILDS.includes(expectedBuild), "mini-build is outside the exact reviewed source allowlist");
const source = new URL("../", import.meta.url).pathname;
const artifactRoot = realpathSync(resolve(values["artifact-root"] ?? join(source, "dist"))) + "/";
const binary = realpathSync(resolve(values["mini-bin"] ?? join(homedir(), ".lastdb/current/lastdbd")));
const root = mkdtempSync("/tmp/fkanban-create-public-"), home = join(root, "mini"), proxyDir = join(root, "proxy");
mkdirSync(join(home, "data"), { recursive: true }); mkdirSync(proxyDir); mkdirSync(join(root, "logs"));
assert(realpathSync(root).startsWith(realpathSync("/tmp") + "/fkanban-create-public-"));
const socket = join(home, "data/folddb.sock"), full = join(home, "data/folddb-full.sock");
const proxy = join(proxyDir, "folddb.sock"), proxyFull = join(proxyDir, "folddb-full.sock");
const configPath = join(root, "config.json"), evidencePath = join(root, "evidence.json"), started = Date.now();
const artifact = JSON.parse(readFileSync(artifactRoot + "guarded-contract.json", "utf8"));
assert.equal(artifact.version, 1);
const sourceSha = () => sha256(JSON.stringify(artifact.source_manifest.map((file: any) => ({ path: file.path, sha256: sha256(readFileSync(source + file.path)) }))));
const sourceBefore = sourceSha();
assert.equal(sourceBefore, artifact.source_manifest_sha256);
assert.equal(sha256(readFileSync(artifactRoot + "kanban")), artifact.cli_sha256);
assert.equal(sha256(readFileSync(artifactRoot + "kanban-mcp")), artifact.mcp_sha256);
assert.deepEqual(artifact.contract.compound_builds, [...COMPOUND_CARD_BUILDS]);
const binaryVersionResult = Bun.spawnSync([binary, "--version"], { stdout: "pipe", stderr: "pipe" });
assert.equal(binaryVersionResult.exitCode, 0);
const binaryVersion = new TextDecoder().decode(binaryVersionResult.stdout).trim();
assert.equal(binaryVersion, "lastdbd " + expectedBuild, "binary version differs from exact requested private proof build");
const pins = readConfig().schemaHashes;
const schemas = { card: pins.card!, board: pins.board!, board_cards: pins.board_cards! };
assert(Object.values(schemas).every(hash => /^[0-9a-f]{64}$/.test(hash)));
const evidence: any = { version: 1, result: "pending", root, artifact_root: artifactRoot, artifact,
  build: expectedBuild, mini_binary: binary, mini_binary_version: binaryVersion, mini_binary_sha256: sha256(readFileSync(binary)),
  dedupe_mode: values["dedupe-mode"], program_sha256: sha256(readFileSync(import.meta.path)),
  started_at: new Date().toISOString(), requests: 0, cases: [], public_batches: [], barriers: [], source_unchanged: false,
  key_identity_limit: "Query key-derived slug identity is not an absent-atom proof; human packet, native409 and source atomic publication establish the rejected-create boundary.",
  schedule_limit: "Human writes occur after the final client read and before the real atomic request. The internal native filter-to-prepare guarantee is source-derived." };
const expected = new Map<string, any>(), destinations = new Map<string, any>(), absentDestinations = new Set<string>();
const lastCardRead = new Map<string, number>();
let userHash = "", sequence = 0, commandNumber = 0;
let child: ReturnType<typeof Bun.spawn> | undefined, mcp: Client | undefined;
let proxyServer: ReturnType<typeof Bun.serve> | undefined, proxyFullServer: ReturnType<typeof Bun.serve> | undefined;
const pause = (ms: number) => new Promise(resolvePause => setTimeout(resolvePause, ms));
function budget() { assert(++evidence.requests <= 1800, "private request cap"); assert(Date.now() - started < 600000, "private wall cap"); }
function save() { evidence.source_unchanged = sourceSha() === sourceBefore; writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n"); }
writeFileSync(join(root, "producer.ts"), readFileSync(import.meta.path));
function passed(name: string, facts: any = {}) { evidence.cases.push({ name, passed: true, ...facts }); save(); }
async function raw(path: string, body?: unknown) {
  budget();
  const response = await fetch("http://localhost" + path, { unix: full, method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "X-LastDB-Client": "fkanban-create-only-private-proof", ...(userHash ? { "X-User-Hash": userHash } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90000) } as any);
  const text = await response.text(); assert(Buffer.byteLength(text) <= 8388608, "private response cap");
  return { status: response.status, json: JSON.parse(text), text };
}
function op(schema: string, hash: string, range: string | null, fields: any, expectation?: any) {
  return { type: "mutation", schema, fields_and_values: fields, key_value: { hash, range }, mutation_type: "update",
    durability: "durable", ...(expectation ? { expected: expectation } : {}) };
}
async function batch(rows: any[]) {
  assert(rows.length <= 256);
  const response = await raw("/api/mutations/batch", rows);
  assert.equal(response.status, 200, response.text); assert.equal(response.json.durability, "durable");
  return response.json;
}
async function readKeys(schema: string, keys: [string, string][], fields: string[]) {
  assert(keys.length <= 256);
  const response = await raw("/api/query", { schema_name: schema, filter: { HashRangeKeys: keys }, fields, limit: 1000, offset: 0 });
  evidence.native_reads ??= []; evidence.native_reads.push({ schema, keys, fields, response });
  assert.equal(response.status, 200, response.text); assert.equal(response.json.ok, true);
  assert.equal(response.json.has_more, false); assert.equal(response.json.unresolved_rows, 0);
  assert.equal(response.json.tombstoned_rows, 0); assert.equal(response.json.truncated ?? false, false);
  assert.equal(response.json.next_cursor ?? null, null);
  assert(Array.isArray(response.json.results)); assert.equal(response.json.returned_count, response.json.results.length);
  if (response.json.total_count !== undefined && response.json.total_count !== null) assert.equal(response.json.total_count, response.json.results.length);
  for (const field of ["skipped_keys", "skipped", "skipped_rows", "truncated_rows", "failed", "failed_rows", "errors", "error", "unresolved", "unresolved_keys", "missing_keys"]) {
    const value = response.json[field];
    if (value !== undefined && value !== null) assert(value === 0 || (Array.isArray(value) && value.length === 0), "incomplete private metadata: " + field);
  }
  const allowed = new Set(keys.map(key => JSON.stringify(key))), seen = new Set<string>();
  for (const row of response.json.results) {
    assert.deepEqual(Object.keys(row.key).sort(), ["hash", "range"]);
    const key = JSON.stringify([row.key.hash, row.key.range ?? ""]);
    assert(allowed.has(key) && !seen.has(key), "foreign or duplicate private response key"); seen.add(key);
    assert(row.fields && typeof row.fields === "object" && !Array.isArray(row.fields));
    const hashField = schema === schemas.card ? "slug" : schema === schemas.board_cards ? "board" : "slug";
    assert(Object.keys(row.fields).every(field => fields.includes(field) || field === hashField), "unrequested private response field");
    if (hashField in row.fields) assert.equal(row.fields[hashField], row.key.hash, "native key field differs from key");
    for (const field of ["error", "errors", "unresolved", "skipped", "failed", "tombstoned"]) {
      const value = row[field];
      if (value !== undefined && value !== null) assert(value === 0 || (Array.isArray(value) && value.length === 0), "incomplete private record metadata: " + field);
    }
  }
  return response.json;
}
async function current(slug: string, fields: string[] = [...CARD_FIELDS]) {
  const response = await readKeys(schemas.card, [[slug, ""]], fields);
  return response.results[0]?.fields ?? null;
}
async function start() {
  assert(!child);
  const fd = openSync(join(root, "boot.log"), "a", 0o600);
  child = Bun.spawn([binary, "--data-dir", home, "--socket-path", socket, "--full-socket-path", full], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LASTDB_HOME: home, FOLDDB_HOME: home, TMPDIR: root,
      LASTDB_WRITE_DEDUPE: values["dedupe-mode"] === "on" ? "1" : "0", RUST_LOG: "warn" }, stdout: fd, stderr: fd });
  closeSync(fd); evidence.pids ??= []; evidence.pids.push(child.pid);
  for (let attempt = 0; attempt < 45; attempt++) {
    if (child.exitCode !== null) throw Error("private Mini exited before readiness");
    if (existsSync(full)) {
      try { const response = await raw("/api/version"); if (response.status === 200) {
        assert.equal(response.json.build, expectedBuild); evidence.versions ??= []; evidence.versions.push(response.json); return;
      } } catch (error) { if (String(error).includes("AssertionError")) throw error; }
    }
    await pause(1000);
  }
  throw Error("private Mini readiness timeout");
}
async function stop(signal: "SIGKILL" | "SIGTERM") {
  if (!child) return;
  if (child.exitCode !== null) { child = undefined; return; }
  const pid = child.pid, ps = Bun.spawnSync(["/bin/ps", "-o", "command=", "-p", String(pid)], { stdout: "pipe", stderr: "pipe" });
  const argv = new TextDecoder().decode(ps.stdout);
  assert(argv.includes(binary) && argv.includes("--data-dir " + home) && argv.includes("--socket-path " + socket));
  assert(!argv.includes(join(homedir(), ".lastdb/data")), "refuse primary process signal");
  child.kill(signal); await Promise.race([child.exited, pause(10000).then(() => { throw Error("private Mini stop timeout"); })]);
  child = undefined; evidence.stop_checks ??= []; evidence.stop_checks.push({ pid, signal, argv_verified: true });
}
type Arm = { slug: string; field?: string; fullCard?: boolean; ack?: "memory" | "missing" | "malformed"; readback?: boolean };
let arm: Arm | undefined;
const readbackPending = new Set<string>();
function packet(rows: any[]) {
  const finals = rows.filter(row => row.schema === schemas.card && Object.keys(row.fields_and_values ?? {}).length === CARD_FIELDS.length);
  assert.equal(finals.length, 1, "one final full Card payload");
  const final = finals[0], slug = final.key_value.hash;
  const guards = rows.filter(row => row.schema === schemas.card && row !== final);
  assert.equal(guards.length, 23); assert(rows.length >= 25 && rows.length <= 26);
  assert(rows.every(row => row.durability === "durable"));
  assert.deepEqual(guards.map(row => row.expected?.field), [...CARD_FIELDS]);
  const mode = guards[0].expected.type; assert(["absent", "value"].includes(mode));
  guards.forEach((row, index) => {
    assert.equal(row.key_value.hash, slug); assert.equal(row.key_value.range, null);
    assert.equal(row.expected.type, mode);
    assert.deepEqual(Object.keys(row.fields_and_values), [CARD_FIELDS[index]!], "each condition carries only its real target field");
    assert.deepEqual(row.fields_and_values[row.expected.field], mode === "absent" ? final.fields_and_values[row.expected.field] : row.expected.value);
  });
  assert.equal(rows.indexOf(final), 23, "final full Card follows all23 conditions");
  assert.equal(rows.filter(row => row.schema === schemas.card).at(-1), final);
  if (mode === "absent") assert.deepEqual(final.expected, { type: "absent", field: "updated_at" });
  else assert.equal(final.expected, undefined, "existing raw23 writer retains its original final payload");
  assert(!String(final.fields_and_values.updated_at).startsWith("guard:"));
  assert.equal(rows.filter(row => row.expected).length, mode === "absent" ? 24 : 23);
  return { final, guards, slug, mode, record: { slug, mode, operations: rows.length, conditions: rows.filter(row => row.expected).length,
    guard_payload_hashes: guards.map(row => sha256(JSON.stringify(row.fields_and_values))), final_payload_sha256: sha256(JSON.stringify(final.fields_and_values)),
    final_index: rows.indexOf(final), request: structuredClone(rows) } };
}
const forward = async (request: Request) => {
  budget();
  const path = new URL(request.url).pathname, body = request.method === "GET" ? undefined : await request.text();
  let parsed: any; try { parsed = body ? JSON.parse(body) : undefined; } catch { /* Native endpoint owns malformed request refusal. */ }
  const rows = path === "/api/mutations/batch" && Array.isArray(parsed) ? parsed : [];
  const info = rows.length ? packet(rows) : undefined;
  let active: Arm | undefined, barrier: any;
  if (info) {
    evidence.public_batches.push(info.record);
    if (arm?.slug === info.slug) {
      active = arm; arm = undefined;
      if (active.field || active.fullCard) {
        assert.equal(info.mode, "absent");
        const lastResponse = lastCardRead.get(info.slug); assert(lastResponse, "public race lacks a prior canonical response");
        const selected = active.fullCard ? [...CARD_FIELDS] : [active.field!];
        const before = await current(info.slug, selected); assert.equal(before, null, "race pre-state is not absent");
        const human = active.fullCard ? { ...info.final.fields_and_values, body: info.final.fields_and_values.body + "\nHUMAN: retain this goal.",
          assignee: "human-owner", block_status: "needs_human", block_reason: "Human hold after the public read.", column: "doing" }
          : { [active.field!]: info.final.fields_and_values[active.field!] };
        await batch([op(schemas.card, info.slug, null, human)]);
        const humanAck = ++sequence, actual = await current(info.slug, selected);
        assert.deepEqual(actual, human, "committed human bytes differ from race input");
        expected.set(info.slug, human);
        barrier = { slug: info.slug, fields: selected, prior: before, human, last_canonical_response_seq: lastResponse,
          human_durable_ack_seq: humanAck, after_final_read: humanAck > lastResponse! };
        evidence.barriers.push(barrier);
        for (const row of rows.filter(row => row.schema === schemas.board_cards)) absentDestinations.add(row.key_value.range);
      }
    }
  }
  const forwardSeq = rows.length ? ++sequence : undefined;
  if (barrier) { barrier.atomic_forward_seq = forwardSeq; barrier.before_atomic_forward = barrier.human_durable_ack_seq < forwardSeq!;
    assert(barrier.after_final_read && barrier.before_atomic_forward); }
  const response = await fetch("http://localhost" + path, { unix: full, method: request.method, headers: request.headers, body,
    signal: AbortSignal.timeout(90000) } as any);
  const text = await response.text();
  if (path === "/api/query" && parsed?.schema_name === schemas.card && response.status === 200) {
    const keys = parsed.filter?.HashRangeKeys ?? (parsed.filter?.HashKey ? [[parsed.filter.HashKey, ""]] : []);
    for (const [slug] of keys) lastCardRead.set(slug, ++sequence);
    for (const [slug] of keys) if (readbackPending.delete(slug)) {
      const changed = JSON.parse(text); assert.equal(changed.results[0].key.hash, slug); changed.results[0].fields.body = "private corrupted readback";
      evidence.readback_corruptions ??= []; evidence.readback_corruptions.push({ slug, after_real_durable_ack: true }); return Response.json(changed);
    }
  }
  if (info) {
    info.record.response_status = response.status; info.record.response = JSON.parse(text);
    if (response.status === 200) {
      assert.equal(info.record.response.durability, "durable");
      expected.set(info.slug, structuredClone(info.final.fields_and_values));
      for (const row of rows.filter(row => row.schema === schemas.board_cards)) destinations.set(row.key_value.range, structuredClone(row.fields_and_values));
      if (active?.readback) readbackPending.add(info.slug);
    }
    if (active?.ack) {
      assert.equal(response.status, 200, "unknown ACK fixture must first commit the real batch");
      info.record.ack_corruption = active.ack;
      return active.ack === "malformed" ? new Response("not JSON", { status: 200 }) : Response.json(active.ack === "missing" ? {} : { durability: "memory" });
    }
  }
  return new Response(text, { status: response.status, headers: { "Content-Type": response.headers.get("Content-Type") ?? "application/json" } });
};
const env = () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "user"), LASTDB_HOME: home, FOLDDB_HOME: home,
  FOLDDB_SOCKET_PATH: proxy, KANBAN_CONFIG: configPath, FKANBAN_CONFIG: configPath, TMPDIR: root, FKANBAN_FSITUATIONS_BIN: join(root, "situations") });
async function cli(args: string[], witness?: string) {
  const flags: string[] = [], label = String(++commandNumber).padStart(3, "0");
  if (witness !== undefined) { const file = join(root, "witness-" + label + ".json"); writeFileSync(file, witness);
    flags.push("--guard-snapshot", file, "--snapshot-sha256", sha256(witness)); }
  const processHandle = Bun.spawn([artifactRoot + "kanban", ...args, ...flags, "--json"], { env: env(), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => processHandle.kill("SIGKILL"), 90000);
  const [stdout, stderr, exit] = await Promise.all([new Response(processHandle.stdout).text(), new Response(processHandle.stderr).text(), processHandle.exited]);
  clearTimeout(timer); let json: any; try { json = JSON.parse(stdout); } catch { /* Keep exact public failure bytes. */ }
  writeFileSync(join(root, "logs/" + label + ".stdout"), stdout); writeFileSync(join(root, "logs/" + label + ".stderr"), stderr);
  writeFileSync(join(root, "logs/" + label + ".result.json"), JSON.stringify({ args, exit }) + "\n");
  return { exit, stdout, stderr, json };
}
async function tool(name: string, args: any, witness?: string) {
  const response = await mcp!.callTool({ name, arguments: { ...args, ...(witness === undefined ? {} : { guard_snapshot_json: witness, snapshot_sha256: sha256(witness) }) } });
  const text = (response.content as any[]).filter(item => item.type === "text").map(item => item.text).join("\n");
  const json = response.structuredContent ?? (response.isError ? undefined : JSON.parse(text));
  const label = String(++commandNumber).padStart(3, "0");
  writeFileSync(join(root, "logs/" + label + ".mcp.json"), JSON.stringify({ name, args, response }, null, 2) + "\n");
  return { isError: response.isError === true, json, text };
}
function receipt(result: any, create = false) {
  assert.equal(result.durability, "durable"); assert.equal(typeof result.next_snapshot_json, "string");
  assert.equal(sha256(result.next_snapshot_json), result.next_snapshot_sha256); assert(result.next_snapshot_json.endsWith("\n"));
  if (create) { assert.equal(result.absence_guard, "all23-absent"); assert.equal(result.action, "created"); }
  return result.next_snapshot_json as string;
}
const body = "## GOAL\nTest the public atomic Card creation contract.\n## END STATE\nPROOF: PASS exact private fixture.\nRepo: EdgeVector/fkanban\nBase: main\nKind: pr";
const addArgs = (slug: string) => ["add", slug, "--create-only", "--title", "Public private create-only fixture", "--column", "backlog", "--body", body, "--surfaces", `src/${slug}.ts`, "--repo", "EdgeVector/fkanban", "--base", "main", "--kind", "pr"];
const addTool = (slug: string) => ({ slug, create_only: true, title: "Public private create-only fixture", column: "backlog", body,
  surfaces: [`src/${slug}.ts`], repo: "EdgeVector/fkanban", base: "main", kind: "pr" });
async function verifyPartialCards(stage: "before-restart" | "after-restart") {
  const partial = [...expected].filter(([, fields]) => Object.keys(fields).length !== 23);
  const keyOnly = partial.filter(([, fields]) => "slug" in fields), other = partial.filter(([, fields]) => !("slug" in fields));
  const keyResponse = await readKeys(schemas.card, keyOnly.map(([slug]) => [slug, ""] as [string, string]), [...CARD_FIELDS]);
  assert.equal(keyResponse.results.length, keyOnly.length);
  for (const row of keyResponse.results) assert.deepEqual(row.fields, expected.get(row.key.hash), stage + " key-only human record changed");
  const keys = other.map(([slug]) => [slug, ""] as [string, string]);
  // Native co-key reads prefer the slug spine; its absence allows the requested-field fallback.
  // Keep the known slug-only human keys separate so they cannot hide these collected keys.
  const reads = await Promise.all(CARD_FIELDS.filter(field => field !== "slug").map(async field => ({ field, response: await readKeys(schemas.card, keys, [field]) })));
  for (const item of reads) {
    const wanted = other.filter(([, fields]) => item.field in fields);
    const observed = item.response.results.filter((row: any) => item.field in row.fields);
    assert.equal(observed.length, wanted.length, stage + " partial key omissions or extra non-key fields: " + item.field);
    for (const row of observed) {
      assert(item.field in expected.get(row.key.hash), stage + " extra canonical non-key field: " + item.field);
      assert.deepEqual(row.fields[item.field], expected.get(row.key.hash)[item.field]);
    }
  }
  evidence.partial_field_batches ??= [];
  evidence.partial_field_batches.push({ stage, key_only_keys: keyOnly.map(([slug]) => slug), key_only_response: keyResponse,
    requested_nonkey_keys: keys, batches: reads.map(item => ({ field: item.field, response: item.response })),
    observation_limit: "Key-derived slug identity does not prove an absent slug atom. Captured human mutation, native409, no accepted factory batch, no destination, and source atomic publication protect that claim." });
  return { cards: partial.length, batches: reads.length + 1 };
}
function seededCard(slug: string, column: string, owner: string) {
  return Object.fromEntries(CARD_FIELDS.map(field => [field, field === "tags" ? ["p1", "raw", "raw"] : field === "deps" ? [] : field === "surfaces" ? [`src/${slug}.ts`] :
    ({ slug, title: "Public guard freshness fixture", body, board: "default", column, position: "100", assignee: owner,
      created_at: "2026-10-08T00:00:00Z", updated_at: "2026-10-08T00:00:00Z", created_by: "", repo: "EdgeVector/fkanban", base: "main", kind: "pr", block_status: "none" } as any)[field] ?? ""]));
}
try {
  console.log(JSON.stringify({ stage: "start", root, dedupe_mode: values["dedupe-mode"] }));
  await start(); let identity = await raw("/api/system/auto-identity");
  if (identity.status === 503) identity = await raw("/api/setup/bootstrap", { name: "fkanban-create-only-private-proof" });
  assert.equal(identity.status, 200); userHash = identity.json.user_hash; assert.equal(typeof userHash, "string");
  const loaded = await raw("/api/schemas/load", { schemas: Object.values(schemas) });
  assert.equal(loaded.status, 200, loaded.text); assert.deepEqual(loaded.json.failed_schemas ?? [], []);
  const metadata = await Promise.all(Object.values(schemas).map(hash => raw("/api/schema/" + hash)));
  assert(metadata.every(response => response.status === 200)); evidence.native_schemas = metadata.map(response => response.json);
  writeFileSync(configPath, JSON.stringify({ configVersion: 1, nodeUrl: "http://localhost", nodeSocketPath: proxy,
    schemaServiceUrl: "http://unused.invalid", userHash, schemaHashes: schemas, enforceLivePrMilestone: false }));
  const bunPath = new TextDecoder().decode(Bun.spawnSync(["which", "bun"], { stdout: "pipe" }).stdout).trim();
  writeFileSync(join(root, "situations"), `#!${bunPath}\nconsole.log(JSON.stringify({ok:true}));\n`, { mode: 0o700 });
  const markCard = seededCard("repeated-mark", "doing", "worker"), claimCard = seededCard("two-stage-claim", "todo", "");
  await batch([op(schemas.board, "default", null, { slug: "default", title: "Private proof", body: "", columns: [...DEFAULT_COLUMNS], created_at: "test", updated_at: "test" }),
    op(schemas.card, markCard.slug, null, markCard), op(schemas.card, claimCard.slug, null, claimCard)]);
  expected.set(markCard.slug, markCard); expected.set(claimCard.slug, claimCard);
  proxyServer = Bun.serve({ unix: proxy, fetch: forward }); proxyFullServer = Bun.serve({ unix: proxyFull, fetch: forward });
  const transport = new StdioClientTransport({ command: artifactRoot + "kanban-mcp", env: env(), stderr: "pipe" });
  mcp = new Client({ name: "create-only-private-proof", version: "1" }, { capabilities: {} }); await mcp.connect(transport);
  const contract = await cli(["create-only-contract"]); assert.equal(contract.exit, 0, contract.stderr);
  assert.deepEqual(contract.json, { ...CREATE_ONLY_CONTRACT, contract_sha256: CREATE_ONLY_CONTRACT_SHA256 }, "compiled creation contract differs from reviewed source");
  evidence.create_contract = contract.json;
  passed("compiled-create-only-contract");

  const nativeSlug = "native-historical-absence", original = op(schemas.card, nativeSlug, null, { body: "same historical body" }, { type: "absent", field: "body" });
  const first = await batch([original]), duplicate = await raw("/api/mutations/batch", [original]);
  assert.equal(duplicate.status, 409, "identical public absent replay must check current state");
  assert(/cas_conflict/.test(duplicate.text), duplicate.text);
  assert.equal((await current(nativeSlug, ["body"])).body, "same historical body");
  evidence.native_historical_baseline = { first, duplicate, request: original, existing_key_refused: true,
    guarantee: "The live public route assigns a new author clock before the conditional mutation filter." };
  const forged = await raw("/api/mutations/batch", [{ ...original, logical_counter: first.revision }]);
  assert.equal(forged.status, 400, "public wire must not accept a supplied author clock");
  evidence.native_historical_baseline.forged_clock_refusal = forged;
  expected.set(nativeSlug, { body: "same historical body" }); passed("real-native-identical-absent-replay-refuses-current-value");

  const created = await cli(addArgs("created-cli")); assert.equal(created.exit, 0, created.stderr); receipt(created.json, true);
  assert.deepEqual(await current("created-cli"), JSON.parse(created.json.next_snapshot_json).fields); passed("compiled-cli-create-only-positive");
  const createdMcp = await tool("fkanban_add", addTool("created-mcp")); assert(!createdMcp.isError, JSON.stringify(createdMcp)); receipt(createdMcp.json, true);
  assert.deepEqual(await current("created-mcp"), JSON.parse(createdMcp.json.next_snapshot_json).fields); passed("compiled-mcp-create-only-positive");
  const existsBefore = expected.get("created-cli"), countBefore = evidence.public_batches.length;
  const exists = await cli(addArgs("created-cli")); assert.notEqual(exists.exit, 0); assert.equal(exists.stdout.trim(), ""); assert(/already exists/.test(exists.stderr));
  assert.equal(evidence.public_batches.length, countBefore); assert.deepEqual(await current("created-cli"), existsBefore); passed("compiled-cli-existing-zero-batches");
  const mcpBefore = evidence.public_batches.length, existsMcp = await tool("fkanban_add", addTool("created-mcp"));
  assert(existsMcp.isError); assert.equal(existsMcp.json, undefined); assert(/already exists/.test(existsMcp.text)); assert.equal(evidence.public_batches.length, mcpBefore); passed("compiled-mcp-existing-zero-batches");
  for (const field of CARD_FIELDS) {
    const slug = "late-" + field, before = evidence.public_batches.length; arm = { slug, field };
    const refused = await cli(addArgs(slug)); assert.notEqual(refused.exit, 0, "late " + field + " accepted");
    assert.equal(arm, undefined, "late " + field + " barrier did not run");
    assert.equal(refused.stdout.trim(), "", "late partial refusal emitted a success receipt");
    assert.equal(evidence.public_batches.at(-1).response_status, 409);
    assert(/cas_conflict/.test(JSON.stringify(evidence.public_batches.at(-1).response))); assert.equal(evidence.public_batches.length, before + 1, "no retry after late " + field);
    assert.deepEqual(await current(slug, [field]), expected.get(slug), "partial refusal changed the committed human field");
    passed("compiled-cli-late-partial-" + field, { no_receipt: true, attempted_batches: 1 });
  }
  for (const channel of ["cli", "mcp"]) {
    const slug = "late-full-" + channel, before = evidence.public_batches.length; arm = { slug, fullCard: true };
    const refused = channel === "cli" ? await cli(addArgs(slug)) : await tool("fkanban_add", addTool(slug));
    if (channel === "cli") { assert.notEqual((refused as any).exit, 0); assert.equal((refused as any).stdout.trim(), ""); }
    else { assert((refused as any).isError); assert.equal(refused.json, undefined, "MCP late refusal emitted a success receipt"); }
    assert.equal(evidence.public_batches.at(-1).response_status, 409);
    assert(/cas_conflict/.test(JSON.stringify(evidence.public_batches.at(-1).response)));
    assert.equal(arm, undefined); assert.equal(evidence.public_batches.length, before + 1);
    assert.deepEqual(await current(slug), expected.get(slug)); passed("compiled-" + channel + "-late-body-owner-hold-column-preserved");
  }
  for (const channel of ["cli", "mcp"]) for (const mode of ["memory", "missing", "malformed", "readback"] as const) {
    const slug = "uncertain-" + mode + "-" + channel, before = evidence.public_batches.length;
    arm = mode === "readback" ? { slug, readback: true } : { slug, ack: mode };
    const refused = channel === "cli" ? await cli(addArgs(slug)) : await tool("fkanban_add", addTool(slug));
    if (channel === "cli") { assert.notEqual((refused as any).exit, 0); assert.equal((refused as any).stdout.trim(), "", "uncertain create emitted a success receipt"); }
    else { assert((refused as any).isError); assert.equal(refused.json, undefined, "uncertain MCP create emitted a success receipt"); }
    assert.equal(evidence.public_batches.length, before + 1); assert.equal(arm, undefined);
    assert.deepEqual(await current(slug), expected.get(slug));
    passed("compiled-" + channel + "-create-" + mode + "-unknown-no-receipt-no-retry", { public_result: channel === "cli" ? "nonzero-empty-stdout" : "isError-no-structured-receipt", real_commit_preserved: true });
  }
  const initial = await cli(["guarded-snapshot", markCard.slug]); assert.equal(initial.exit, 0, initial.stderr);
  const firstMark = await cli(["mark", markCard.slug, "PROOF: PASS repeated public mark", "--expect-assignee", "worker"], initial.stdout);
  assert.equal(firstMark.exit, 0, firstMark.stderr); const firstWitness = receipt(firstMark.json);
  const firstPacket = evidence.public_batches.at(-1), again = await cli(["mark", markCard.slug, "PROOF: PASS repeated public mark", "--expect-assignee", "worker"], firstWitness);
  assert.equal(again.exit, 0, again.stderr); const sameWitness = receipt(again.json), againPacket = evidence.public_batches.at(-1);
  assert.equal(sameWitness, firstWitness, "repeated mark changes raw bytes or timestamp");
  assert.equal(again.json.next_snapshot_sha256, firstMark.json.next_snapshot_sha256);
  const repeated = await cli(["mark", markCard.slug, "PROOF: PASS repeated public mark", "--expect-assignee", "worker"], sameWitness);
  assert.equal(repeated.exit, 0, repeated.stderr); assert.equal(receipt(repeated.json), sameWitness);
  const repeatedPacket = evidence.public_batches.at(-1);
  assert.deepEqual(againPacket.guard_payload_hashes, repeatedPacket.guard_payload_hashes, "same-key guard replay did not repeat all23 actual field payloads");
  assert.equal(againPacket.final_payload_sha256, repeatedPacket.final_payload_sha256);
  assert(firstPacket.response.revision < againPacket.response.revision && againPacket.response.revision < repeatedPacket.response.revision,
    "public repeat did not allocate a fresh native author clock");
  assert.deepEqual(await current(markCard.slug), JSON.parse(firstWitness).fields);
  passed("compiled-repeated-mark-identical-payloads-fresh-native-clock-and-exact-bytes", { exact_snapshot_sha256: again.json.next_snapshot_sha256,
    guard_payloads_identical: true, final_payload_identical: true, native_revisions: [firstPacket.response.revision, againPacket.response.revision, repeatedPacket.response.revision] });
  const claimInitial = await cli(["guarded-snapshot", claimCard.slug]); assert.equal(claimInitial.exit, 0, claimInitial.stderr);
  const claimBefore = evidence.public_batches.length, claim = await cli(["pickup", "claim-v2", "--only-card", claimCard.slug, "--worker", "worker"], claimInitial.stdout);
  assert.equal(claim.exit, 0, claim.stderr); assert.equal(claim.json.result, "claimed"); receipt(claim.json);
  assert.equal(evidence.public_batches.length, claimBefore + 2); const stages = evidence.public_batches.slice(-2);
  assert(stages[0].response.revision < stages[1].response.revision); assert.equal(stages[0].request[23].fields_and_values.block_status, "needs_human");
  assert.equal(stages[1].request[23].fields_and_values.block_status, "none"); assert.deepEqual(await current(claimCard.slug), JSON.parse(claim.json.next_snapshot_json).fields);
  passed("compiled-two-stage-claim-native-clock-and-raw23-restoration");

  await verifyPartialCards("before-restart"); passed("real-native-partial-nonkey-fields-preserved-and-extra-nonkey-fields-absent");
  await mcp.close(); mcp = undefined; save(); await stop("SIGKILL"); await start();
  const fullKeys = [...expected].filter(([, fields]) => Object.keys(fields).length === 23).map(([slug]) => [slug, ""] as [string, string]);
  const fullRecords = await readKeys(schemas.card, fullKeys, [...CARD_FIELDS]); const byHash = new Map(fullRecords.results.map((row: any) => [row.key.hash, row.fields]));
  for (const [slug, fields] of expected) if (Object.keys(fields).length === 23) assert.deepEqual(byHash.get(slug), fields, "restart full Card " + slug);
  const partialRead = await verifyPartialCards("after-restart");
  const projectionFields = allPinnedSchemas().find(schema => schema.key === "board_cards")!.schema.schema.fields;
  const projection = await readKeys(schemas.board_cards, [...new Set([...destinations.keys(), ...absentDestinations])].map(sk => ["default", sk]), projectionFields);
  const byRange = new Map(projection.results.map((row: any) => [row.key.range, row.fields]));
  for (const [sk, fields] of destinations) assert.deepEqual(byRange.get(sk), fields, "restart accepted destination " + sk);
  for (const sk of absentDestinations) assert.equal(byRange.has(sk), false, "restart rejected destination exists " + sk);
  evidence.restart = { passed: true, full_cards: fullKeys.length, partial_cards: partialRead.cards, destinations: destinations.size, absent_destinations: absentDestinations.size,
    partial_read_batches: partialRead.batches }; passed("real-private-restart-durable-canonical-and-destinations"); evidence.result = "passed";
} catch (error) {
  evidence.result = "failed"; evidence.error = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
  console.error(evidence.error); process.exitCode = 1;
} finally {
  try { await mcp?.close(); await stop("SIGTERM"); } catch (error) { evidence.stop_error = String(error); evidence.result = "failed"; process.exitCode = 1; }
  proxyServer?.stop(true); proxyFullServer?.stop(true); save(); assert(evidence.source_unchanged);
  console.log(JSON.stringify({ result: evidence.result, root, evidencePath, dedupe_mode: values["dedupe-mode"], cases: evidence.cases.length,
    requests: evidence.requests, restart: evidence.restart ?? null }));
}
