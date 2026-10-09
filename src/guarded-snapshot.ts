// A caller-owned raw Card witness. Normalized Card values are policy inputs only.
import { constants, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { FkanbanError, type NodeClient } from "./client.ts";
import { type Config, schemaHashFor } from "./config.ts";
import { CARD_FIELDS } from "./schemas.ts";
import { rowToCard, type Card } from "./record.ts";

export const COMPOUND_CARD_BUILD = "0.23.3-2588-g24334db75";
export const COMPOUND_CARD_BUILDS: readonly string[] = Object.freeze([COMPOUND_CARD_BUILD, "0.23.3-2693-gb70418967"]);
export const GUARDED_CONTRACT = Object.freeze({
  version: 1, name: "fkanban-raw23-guarded-card", snapshot_version: 1,
  card_fields: [...CARD_FIELDS], compound_builds: [...COMPOUND_CARD_BUILDS],
  max_snapshot_keys:256, max_snapshot_result_bytes:8388608, snapshot_batch_shape:"ordered-items-with-explicit-missing", max_dependency_keys: 256, max_peer_dependency_keys: 512, max_snapshot_bytes: 1048576, max_marker_bytes: 16384, max_batch_operations: 26,
  cli_snapshot_flags: ["--guard-snapshot", "--snapshot-sha256"],
  cli_owner_flag: "--expect-assignee", mcp_snapshot_fields: ["guard_snapshot_json", "snapshot_sha256"],
  operations: ["mark", "set-pr-branch", "set-unowned-surfaces", "backlog-to-todo", "doing-to-terminal", "exact-claim-v2"],
  snapshot_sha: "sha256-exact-utf8-bytes", next_snapshot_json: "string",
  snapshot_batch_cli_flag:"--slugs-file", snapshot_batch_mcp_tool:"fkanban_guarded_snapshots",
  accepted_held:Object.freeze({version:1,stage:"accepted-held",result:"error",resume:"supplied-snapshot-and-exact-worker",drive:false}),
  durability: "durable", membership_cleanup: "deferred",
});
export function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export const GUARDED_CONTRACT_SHA256 = sha256(JSON.stringify(GUARDED_CONTRACT) + "\n");
export type RawFields = Record<string, string | string[]>;
export type GuardSnapshot = { version: 1; schema_hash: string; fields: RawFields };
export type GuardOptions = { guardSnapshotJson?: string; snapshotSha256?: string };
export type GuardedReceipt = {
  next_snapshot_json: string; next_snapshot_sha256: string; durability: "durable";
  guard_snapshot_sha256: string; contract_sha256: string; membership_cleanup: "deferred";
};
export function guardError(code: string, message: string): never {
  throw new FkanbanError({ code, message });
}
export function validateRawFields(value: unknown, slug: string): RawFields {
  if (!value || typeof value !== "object" || Array.isArray(value)) guardError("invalid_guard_snapshot", "Snapshot fields must be an object.");
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).length !== CARD_FIELDS.length || Object.keys(fields).some(k => !(CARD_FIELDS as readonly string[]).includes(k))) {
    guardError("invalid_guard_snapshot", "Snapshot must contain exactly the 23 raw Card fields.");
  }
  for (const field of CARD_FIELDS) {
    const v = fields[field];
    if (["tags", "deps", "surfaces"].includes(field)) {
      if (!Array.isArray(v) || v.some(x => typeof x !== "string")) guardError("invalid_guard_snapshot", `Raw ${field} must be an array of strings.`);
    } else if (typeof v !== "string") guardError("invalid_guard_snapshot", `Raw ${field} must be a string.`);
  }
  if (!slug || fields.slug !== slug) guardError("guard_snapshot_key", "Snapshot slug differs from the requested canonical key.");
  return JSON.parse(JSON.stringify(fields)) as RawFields;
}
const suppliedByteHashes = new WeakMap<GuardSnapshot, string>();
export function snapshotByteSha(snapshot: GuardSnapshot): string { return suppliedByteHashes.get(snapshot) ?? sha256(serializeSnapshot(snapshot)); }
export function serializeSnapshot(snapshot: GuardSnapshot): string {
  const bytes = JSON.stringify({version:snapshot.version,schema_hash:snapshot.schema_hash,fields:snapshot.fields}) + "\n";
  if (Buffer.byteLength(bytes) > GUARDED_CONTRACT.max_snapshot_bytes) guardError("invalid_guard_snapshot", "Snapshot exceeds the byte cap.");
  return bytes;
}
export function snapshotCard(snapshot: GuardSnapshot): Card {
  return rowToCard({ fields: snapshot.fields, key: { hash: String(snapshot.fields.slug), range: null } });
}
export function parseSnapshot(json: string, hash: string | undefined, cfg: Config, slug: string): GuardSnapshot {
  if (Buffer.byteLength(json) > GUARDED_CONTRACT.max_snapshot_bytes || !hash || !/^[a-f0-9]{64}$/.test(hash) || sha256(json) !== hash) {
    guardError("guard_snapshot_sha", "Snapshot byte size or exact byte SHA is invalid.");
  }
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { guardError("invalid_guard_snapshot", "Snapshot JSON is invalid."); }
  const v = raw as Record<string, unknown>;
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join(",") !== "fields,schema_hash,version" || v.version !== 1) {
    guardError("invalid_guard_snapshot", "Snapshot envelope must contain version 1, schema_hash and fields.");
  }
  if (v.schema_hash !== schemaHashFor("card", cfg)) guardError("guard_snapshot_schema", "Snapshot does not name the configured canonical Card schema.");
  const fields = validateRawFields(v.fields, slug);
  for (const value of Object.values(fields)) if (Array.isArray(value)) Object.freeze(value);
  const snapshot = Object.freeze({ version: 1 as const, schema_hash: String(v.schema_hash), fields: Object.freeze(fields) });
  suppliedByteHashes.set(snapshot, hash);
  return snapshot;
}
export async function snapshotFileOptions(path: string | undefined, hash: string | undefined): Promise<GuardOptions> {
  if (path === undefined && hash === undefined) return {};
  if (!path || !hash) guardError("guard_snapshot_flags", "Both snapshot file and byte SHA are required.");
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > GUARDED_CONTRACT.max_snapshot_bytes) guardError("invalid_guard_snapshot", "Snapshot must be a bounded regular file.");
    // Read at most cap+1 even if the file grows after stat.
    const bytes = Buffer.alloc(GUARDED_CONTRACT.max_snapshot_bytes + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > GUARDED_CONTRACT.max_snapshot_bytes) guardError("invalid_guard_snapshot", "Snapshot exceeds the byte cap.");
    const data = bytes.subarray(0, bytesRead);
    const json = new TextDecoder("utf-8", { fatal: true }).decode(data);
    if (sha256(data) !== hash) guardError("guard_snapshot_sha", "Snapshot exact byte SHA differs.");
    return { guardSnapshotJson: json, snapshotSha256: hash };
  } finally { await file.close(); }
}
export async function captureSnapshot(node: NodeClient, cfg: Config, slug: string): Promise<GuardSnapshot> {
  const schema_hash = schemaHashFor("card", cfg);
  const res = await node.queryAll({ schemaHash: schema_hash, fields: [...CARD_FIELDS], filter: { HashRangeKeys: [[slug, ""]] } as any, rawKeyEvidence: true });
  const rows = res.results.filter(r => r.key.hash === slug && r.key.range === null);
  if (rows.length !== 1) guardError("card_not_found", "An exact canonical Card is required. No mutation was sent.");
  const fields = validateRawFields(rows[0]!.fields, slug);
  for (const value of Object.values(fields)) if (Array.isArray(value)) Object.freeze(value);
  const snapshot: GuardSnapshot = Object.freeze({ version: 1, schema_hash, fields: Object.freeze(fields) });
  serializeSnapshot(snapshot);
  return snapshot;
}
export async function boundSnapshot(opts: { node: NodeClient; cfg: Config; slug: string } & GuardOptions): Promise<GuardSnapshot> {
  if (opts.guardSnapshotJson === undefined || opts.snapshotSha256 === undefined) guardError("guard_snapshot_flags", "A complete caller snapshot and byte SHA are required.");
  const supplied = parseSnapshot(opts.guardSnapshotJson, opts.snapshotSha256, opts.cfg, opts.slug);
  const current = await captureSnapshot(opts.node, opts.cfg, opts.slug);
  if (!rawEqual(supplied.fields, current.fields)) guardError("guard_snapshot_conflict", "Canonical Card differs from the caller snapshot. No mutation was sent.");
  return supplied;
}
export function rawEqual(a: RawFields, b: RawFields): boolean {
  return CARD_FIELDS.every(k => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}
export function hasSnapshot(opts: GuardOptions): boolean {
  return opts.guardSnapshotJson !== undefined || opts.snapshotSha256 !== undefined;
}

export function validateSnapshotSlugs(value: unknown): string[] {
  if(!Array.isArray(value) || !value.length || value.length>GUARDED_CONTRACT.max_snapshot_keys || value.some(s=>typeof s!=="string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(s)) || new Set(value).size!==value.length) {
    guardError("guarded_read_scope","Snapshot batch requires at most256 unique nonempty slug tokens.");
  }
  return value as string[];
}
export async function snapshotSlugsFile(path:string):Promise<string[]> {
  const file=await fs.open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const stat=await file.stat();if(!stat.isFile() || stat.size>65536)guardError("guarded_read_scope","Slugs must be a bounded regular JSON file.");
    const data=Buffer.alloc(65537);const {bytesRead}=await file.read(data,0,data.length,0);if(bytesRead>65536)guardError("guarded_read_scope","Slugs file exceeds64KiB.");
    let raw:unknown;try{raw=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(data.subarray(0,bytesRead)));}catch{guardError("guarded_read_scope","Slugs file JSON is invalid.");}
    return validateSnapshotSlugs(raw);
  }finally{await file.close();}
}
export type SnapshotBatch = {version:1;schema_hash:string;items:Array<{slug:string;missing:true}|{slug:string;snapshot_json:string;snapshot_sha256:string}>};
export async function captureSnapshots(node:NodeClient,cfg:Config,input:unknown):Promise<SnapshotBatch> {
  const slugs=validateSnapshotSlugs(input),schema_hash=schemaHashFor("card",cfg);
  const res=await node.queryAll({schemaHash:schema_hash,fields:[...CARD_FIELDS],filter:{HashRangeKeys:slugs.map(s=>[s,""])} as any,rawKeyEvidence:true});
  if(res.ok!==true || !Array.isArray(res.results))guardError("guarded_read_malformed","Native snapshot batch failed.");
  const bySlug=new Map<string,GuardSnapshot>();const requested=new Set(slugs);
  for(const row of res.results) {
    const slug=row?.key?.hash;
    if(typeof slug!=="string" || row.key.range!==null || !requested.has(slug) || bySlug.has(slug))guardError("guarded_read_malformed","Native snapshot batch returned a foreign, duplicate, or malformed key.");
    const fields=validateRawFields(row.fields,slug);const snapshot:GuardSnapshot={version:1,schema_hash,fields};serializeSnapshot(snapshot);bySlug.set(slug,snapshot);
  }
  const result:SnapshotBatch={version:1,schema_hash,items:slugs.map(slug=>{const snapshot=bySlug.get(slug);if(!snapshot)return {slug,missing:true};const json=serializeSnapshot(snapshot);return {slug,snapshot_json:json,snapshot_sha256:sha256(json)};})};
  if(Buffer.byteLength(JSON.stringify(result))>GUARDED_CONTRACT.max_snapshot_result_bytes)guardError("guarded_read_budget","Snapshot batch result exceeds8MiB.");
  return result;
}
