// Finite public factory mutations. Raw Card guards precede every destination upsert.
import { FkanbanError, type NodeClient } from "./client.ts";
import type { Config } from "./config.ts";
import { CARD_FIELDS } from "./schemas.ts";
import { boardCardFieldsFromCard, boardCardsWriteHashes } from "./board-cards.ts";
import {
  appendPosition, assertDefaultTodoWriteGuard, assertDbLocatorMatchesCard,
  claimHoldReason, depStatus, doneAtForColumnTransition, doneAtTag, ensureColumn,
  findBoard, findCardsWithFields, findMilestone, listCardsByColumn, firstDoingAtForColumnTransition,
  firstDoingAtTag, isSubstantiveCardBody, nowIso, terminalColumn, type Card,
} from "./record.ts";
import { assertSituationPreflightAllowed, type SituationPreflight } from "./situations.ts";
import { doingPeerFencesCandidate, PICKUP_V2_PEER_FIELDS } from "./pickup_v2.ts";
import { assertLifecycleMoveAllowed } from "./pipeline_status.ts";
import {
  boundSnapshot, captureSnapshot, COMPOUND_CARD_BUILDS, GUARDED_CONTRACT, GUARDED_CONTRACT_SHA256,
  guardError, rawEqual, serializeSnapshot, sha256, snapshotByteSha, snapshotCard, validateRawFields,
  type FreshClaimChain, type GuardOptions, type GuardSnapshot, type GuardedReceipt, type RawFields,
} from "./guarded-snapshot.ts";

type Context = { node: NodeClient; cfg: Config; slug: string; dbLocator?: string; situationPreflight?: SituationPreflight };
export async function exactBoard(opts: Context, snapshot: GuardSnapshot) {
  const card = snapshotCard(snapshot);
  assertDbLocatorMatchesCard(card, opts.dbLocator, "guarded mutation");
  const board = await findBoard(opts.node, opts.cfg, card.board);
  if (!board || board.slug !== card.board || !board.columns.includes(card.column)) guardError("guarded_board_missing", "The exact Board and current column must exist. No Board repair is allowed.");
  return board;
}
async function gates(opts: Context, next: Card, terminal: string, admission: Card = next) {
  const keys = [...new Set(next.deps)];
  if (keys.length > GUARDED_CONTRACT.max_dependency_keys) guardError("guarded_dependency_budget", "Dependency key count exceeds the guarded contract cap.");
  const [deps, milestone] = await Promise.all([
    findCardsWithFields(opts.node, opts.cfg, keys, ["slug", "board", "column"]),
    next.milestone ? findMilestone(opts.node, opts.cfg, next.milestone) : Promise.resolve(null),
  ]);
  const status = depStatus(next, deps.filter((c): c is Card => c !== null));
  if (status.blocked) guardError("card_blocked", `Card dependencies are unfinished or missing: ${status.blockedBy.join(", ")}.`);
  assertDefaultTodoWriteGuard(admission, false, admission.body, {
    milestoneState: milestone?.state ?? "", enforceLivePrMilestone: opts.cfg.enforceLivePrMilestone === true,
  });
  await assertSituationPreflightAllowed(next, opts.situationPreflight);
  await assertLifecycleMoveAllowed({ node: opts.node, card: next, targetColumn: next.column, terminalColumn: terminal, force: false });
}
function unheld(snapshot: GuardSnapshot, owner: string | undefined): Card {
  if (owner === undefined || snapshot.fields.assignee !== owner) guardError("owner_conflict", "The exact expected assignee is required.");
  const card = snapshotCard(snapshot);
  const hold = claimHoldReason(card);
  if (hold || !["", "none"].includes(String(snapshot.fields.block_status)) || snapshot.fields.block_reason !== "") guardError("claim_held", "The snapshot Card has a hold or hold reason.");
  return card;
}
function ownedCloseout(snapshot: GuardSnapshot, owner: string | undefined, terminal: string): Card {
  const card = unheld(snapshot, owner);
  if (!owner?.trim() || !["doing", terminal].includes(card.column)) guardError("guarded_closeout_scope", "Guarded closeout requires an owned doing or terminal Card.");
  return card;
}
export async function compoundUpdate(opts: Context, witness: GuardSnapshot, intended: RawFields, allowed: readonly string[]): Promise<GuardedReceipt> {
  validateRawFields(intended, opts.slug);
  serializeSnapshot({ ...witness, fields: intended });
  for (const field of CARD_FIELDS) if (!allowed.includes(field) && JSON.stringify(witness.fields[field]) !== JSON.stringify(intended[field])) {
    guardError("guarded_delta_scope", `The finite operation cannot change ${field}.`);
  }
  const version = await opts.node.nodeVersion?.();
  if (!version?.handshake || typeof version.build !== "string" || !COMPOUND_CARD_BUILDS.includes(version.build) || !opts.node.updateRecords || !opts.node.getSchema) {
    guardError("guarded_batch_unsupported", "The exact proved compound build and atomic durable batch are required.");
  }
  const hashes = boardCardsWriteHashes(opts.cfg);
  if (!hashes.length || hashes.length > 2) guardError("guarded_schema_unsupported", "One or two BoardCards destinations are required.");
  const card = snapshotCard({ ...witness, fields: intended });
  const boardFields = boardCardFieldsFromCard(card);
  // Card raw values are authoritative for every shared published field, including tags.
  for (const key of Object.keys(boardFields)) if (key in intended) boardFields[key] = intended[key];
  const payloads = [
    { hash: witness.schema_hash, fields: intended, hashField: "slug", rangeField: null },
    ...hashes.map(hash => ({ hash, fields: boardFields, hashField: "board", rangeField: "sk" })),
  ];
  const schemas = await Promise.all(payloads.map(p => opts.node.getSchema!(p.hash)));
  for (const [i, p] of payloads.entries()) {
    const schema = schemas[i]!;
    if (schema.key.hash_field !== p.hashField || schema.key.range_field !== p.rangeField || Object.keys(p.fields).some(f => !schema.fields.includes(f))) {
      guardError("guarded_schema_unsupported", "Live schema does not declare the exact key and finite published fields.");
    }
  }
  await opts.node.updateRecords([
    ...CARD_FIELDS.map(field => ({ schemaHash: witness.schema_hash, keyHash: opts.slug,
      fields: { [field]: witness.fields[field] },
      expected: { type: "value" as const, field, value: witness.fields[field]! }, durability: "durable" as const })),
    { schemaHash: witness.schema_hash, keyHash: opts.slug, fields: intended, durability: "durable" },
    ...hashes.map(schemaHash => ({ schemaHash, keyHash: String(boardFields.board), rangeKey: String(boardFields.sk), fields: boardFields, durability: "durable" as const })),
  ]);
  // A durable ack alone does not establish the final public Card result.
  const next: GuardSnapshot = { ...witness, fields: intended };
  const actual = await captureSnapshot(opts.node, opts.cfg, opts.slug);
  if (!rawEqual(actual.fields, intended)) guardError("guarded_readback_conflict", "A durable mutation completed, but its exact intended Card readback differs. Keep the slot held.");
  const json = serializeSnapshot(next);
  return { next_snapshot_json: json, next_snapshot_sha256: sha256(json), durability: "durable",
    guard_snapshot_sha256: snapshotByteSha(witness), contract_sha256: GUARDED_CONTRACT_SHA256, membership_cleanup: "deferred" };
}
function nextFields(witness: GuardSnapshot, patch: RawFields): RawFields { return { ...witness.fields, ...patch }; }
export async function guardedMark(opts: Context & GuardOptions & { expectAssignee?: string; line: string }) {
  if (!opts.line || /[\r\n]/.test(opts.line) || Buffer.byteLength(opts.line) > GUARDED_CONTRACT.max_marker_bytes) guardError("invalid_mark_line", "Guarded mark requires one bounded nonempty line.");
  const witness = await boundSnapshot(opts), board = await exactBoard(opts, witness);
  const card = ownedCloseout(witness, opts.expectAssignee, terminalColumn(board.columns));
  if (!isSubstantiveCardBody(card.body)) guardError("truncated_card_body", "A substantive exact Card body is required.");
  const original = String(witness.fields.body);
  const body = original.split(/\r?\n/).includes(opts.line) ? original : `${original}${original.endsWith("\n") ? "" : "\n"}${opts.line}`;
  const next = nextFields(witness, { body, updated_at: body === original ? String(witness.fields.updated_at) : nowIso() });
  await gates(opts, snapshotCard({ ...witness, fields: next }), terminalColumn(board.columns));
  return { slug: opts.slug, action: "updated" as const, board: card.board, column: card.column,
    ...await compoundUpdate(opts, witness, next, ["body", "updated_at"]) };
}
export function validateGuardedSurfaces(paths: string[]): void {
  if (!paths.length || paths.length > 128 || Buffer.byteLength(JSON.stringify(paths)) > 16384 || paths.some(p =>
    !p || p.length > 512 || !p.includes("/") || p.startsWith("/") || p.includes("\\") || /[\x00-\x20\x7f]/.test(p) ||
    p.split("/").some(part => !part || part === "." || part === "..") || /[!{}[\]]/.test(p) || /[?*]/.test(p.split("/")[0]!) || p.endsWith("/")
  )) guardError("guarded_surfaces_scope", "Surfaces must be bounded explicit repo-relative file paths or path globs without traversal or bare directory patterns.");
}
export async function guardedSet(opts: Context & GuardOptions & { expectAssignee?: string; prUrl?: string; branch?: string; surfaces?: string[] }) {
  const surfaceMode = opts.surfaces !== undefined;
  if (surfaceMode ? opts.prUrl !== undefined || opts.branch !== undefined : opts.prUrl === undefined && opts.branch === undefined) guardError("guarded_set_scope", "Choose only PR/branch or only unowned surfaces metadata.");
  if (surfaceMode) validateGuardedSurfaces(opts.surfaces!);
  if ([opts.prUrl, opts.branch].some(v => v !== undefined && (!v || Buffer.byteLength(v) > 4096 || /[\x00-\x20\x7f]/.test(v)))) guardError("guarded_set_scope", "PR/branch metadata must be bounded nonempty tokens.");
  const witness = await boundSnapshot(opts), board = await exactBoard(opts, witness);
  const terminal = terminalColumn(board.columns);
  const card = surfaceMode ? unheld(witness, opts.expectAssignee) : ownedCloseout(witness, opts.expectAssignee, terminal);
  if (surfaceMode && (opts.expectAssignee !== "" || !["backlog", "todo"].includes(card.column))) guardError("guarded_set_scope", "Surfaces correction requires an unowned backlog or todo Card.");
  const patch: RawFields = { updated_at: nowIso() };
  if (surfaceMode) patch.surfaces = opts.surfaces!;
  else { if (opts.prUrl !== undefined) patch.pr_url = opts.prUrl; if (opts.branch !== undefined) patch.branch = opts.branch; }
  const next = nextFields(witness, patch);
  await gates(opts, snapshotCard({ ...witness, fields: next }), terminal);
  return { slug: opts.slug, action: "updated" as const, board: card.board, column: card.column,
    ...await compoundUpdate(opts, witness, next, ["updated_at", ...(surfaceMode ? ["surfaces"] : ["pr_url", "branch"])]) };
}
export async function guardedMove(opts: Context & GuardOptions & { expectAssignee?: string; expectColumn?: string; column: string }) {
  const witness = await boundSnapshot(opts), board = await exactBoard(opts, witness);
  const card = unheld(witness, opts.expectAssignee), terminal = terminalColumn(board.columns);
  const promotion = card.column === "backlog" && opts.column === "todo" && opts.expectColumn === "backlog" && opts.expectAssignee === "";
  const completion = card.column === "doing" && opts.column === terminal && opts.expectColumn === "doing" && !!opts.expectAssignee?.trim();
  if (!promotion && !completion) guardError("guarded_move_scope", "Guarded move permits only unowned backlog-to-todo or owned doing-to-terminal with an exact from column.");
  ensureColumn(opts.column, board.columns);
  const now = nowIso();
  let tags = [...witness.fields.tags as string[]];
  if (completion) {
    tags = tags.filter(t => !t.startsWith("done_at:") && !t.startsWith("first_doing_at:"));
    const done = doneAtForColumnTransition(card, opts.column, board.columns, now);
    if (done) tags.push(doneAtTag(done));
  }
  const next = nextFields(witness, { column: opts.column, position: appendPosition(), updated_at: now, tags });
  await gates(opts, snapshotCard({ ...witness, fields: next }), terminal);
  return { slug: opts.slug, from: card.column, to: opts.column,
    ...await compoundUpdate(opts, witness, next, ["column", "position", "updated_at", "tags"]) };
}
export type AcceptedHeldReceipt = {
  version: 1; stage: "accepted-held"; snapshot_json: string; snapshot_sha256: string;
  durability: "durable"; contract_sha256: string; guard_snapshot_sha256: string;
};
export class ExactClaimRecoveryError extends FkanbanError {
  readonly acceptedHeld: AcceptedHeldReceipt;
  readonly clearCode: string;
  constructor(slug: string, receipt: GuardedReceipt, cause: unknown) {
    super({code:"claim_recovery_pending",message:`Exact claim for "${slug}" accepted its durable recovery hold, but its final clear failed. Keep the slot held.`,cause});
    this.clearCode = cause instanceof FkanbanError ? cause.code : "internal_error";
    this.acceptedHeld = { version:1, stage:"accepted-held", snapshot_json:receipt.next_snapshot_json,
      snapshot_sha256:receipt.next_snapshot_sha256, durability:"durable", contract_sha256:receipt.contract_sha256,
      guard_snapshot_sha256:receipt.guard_snapshot_sha256 };
  }
}
export function isExactRecoveryWitness(witness: GuardSnapshot, worker: string): boolean {
  return !!worker.trim() && witness.fields.column === "doing" && witness.fields.assignee === worker.trim() &&
    witness.fields.block_status === "needs_human" && witness.fields.block_reason === `claim recovery pending for worker "${worker.trim()}": do not work this card until the claim completes`;
}
// The clear asks the question selection asked (`doingPeerFencesCandidate`), so a
// peer that selection let past cannot hold the clear. Both reads carry every
// field that rule reads; a field left out reads as ""/[] and the peer fences.
const RECOVERY_PEER_FIELDS=["slug","board",...PICKUP_V2_PEER_FIELDS] as const;
async function assertRecoveryPeers(opts:Context,card:Card):Promise<void> {
  const rows=await listCardsByColumn(opts.node,opts.cfg,"doing",[...RECOVERY_PEER_FIELDS],card.board,{projection:[...RECOVERY_PEER_FIELDS]});
  const peers=rows.filter(p=>p.slug!==card.slug),keys=[...new Set(peers.map(p=>p.slug))];
  if(keys.length>GUARDED_CONTRACT.max_peer_dependency_keys)guardError("guarded_dependency_budget","Recovery peer key count exceeds its cap.");
  const truth=await findCardsWithFields(opts.node,opts.cfg,keys,[...RECOVERY_PEER_FIELDS]);
  const bySlug=new Map(truth.flatMap(p=>p?[[p.slug,p] as const]:[]));
  for(const row of peers) {
    const canonical=bySlug.get(row.slug);
    if(canonical?.board && canonical.column && (canonical.board!==card.board || canonical.column!=="doing"))continue;
    // This peer came from the doing list and the check above did not move it out, so it is in doing.
    // A sparse tip can carry column "", and doingPeerFencesCandidate treats a non-doing peer as no fence.
    const peer={...(canonical??row),column:"doing",repo:canonical?.repo.trim()?canonical.repo:row.repo};
    if(!peer.repo.trim())guardError("guarded_peer_unknown","An unresolved doing peer cannot free a recovery reservation.");
    if(doingPeerFencesCandidate(card,peer))guardError("guarded_peer_overlap",`Recovery overlaps current doing peer "${peer.slug}". Keep the synthetic hold.`);
  }
}
async function finishExactRecovery(opts: Context & {worker:string;witness:GuardSnapshot}) {
  const {witness} = opts, worker=opts.worker.trim();
  if (!isExactRecoveryWitness(witness,worker)) guardError("guarded_recovery_scope", "Only the exact supplied synthetic recovery hold may clear.");
  const next=nextFields(witness,{block_status:"none",block_reason:"",updated_at:nowIso()});
  const card=snapshotCard({...witness,fields:next}), board=await exactBoard(opts,witness);
  if (claimHoldReason(card)) guardError("claim_held", "A body-declared human hold prevents recovery clear.");
  await Promise.all([gates(opts,card,terminalColumn(board.columns)),assertRecoveryPeers(opts,card)]);
  const receipt=await compoundUpdate(opts,witness,next,["block_status","block_reason","updated_at"]);
  return {receipt,claim:{result:"claimed" as const,card,from:"todo" as const,to:"doing" as const,worker,...receipt}};
}
export async function guardedExactClaim(opts: Context & { worker: string; witness: GuardSnapshot; resume?: boolean }) {
  if (opts.resume) return (await finishExactRecovery(opts)).claim;
  const { witness } = opts, worker = opts.worker.trim();
  if (!worker) guardError("missing_worker", "Exact claim requires a worker.");
  const owner = String(witness.fields.assignee);
  if (owner !== "") guardError("owner_conflict", "Initial exact claim requires an empty owner.");
  const card = unheld(witness, owner), board = await exactBoard(opts, witness);
  if (card.column !== "todo") guardError("claim_conflict", "Exact claim requires the admitted todo Card.");
  const now = nowIso(), reason = `claim recovery pending for worker "${worker}": do not work this card until the claim completes`;
  const tags = (witness.fields.tags as string[]).filter(t => !t.startsWith("done_at:") && !t.startsWith("first_doing_at:"));
  const first = firstDoingAtForColumnTransition(card, "doing", now);
  if (first) tags.push(firstDoingAtTag(first));
  const held = nextFields(witness, { column: "doing", position: appendPosition(), assignee: worker, updated_at: now,
    tags, block_status: "needs_human", block_reason: reason });
  // Admission gates use the unheld admitted Card, before the recovery signal is added.
  await gates(opts, { ...snapshotCard({ ...witness, fields: held }), block_status: "none", block_reason: "" }, terminalColumn(board.columns), card);
  const accepted = await compoundUpdate(opts, witness, held, ["column", "position", "assignee", "updated_at", "tags", "block_status", "block_reason"]);
  const recoveryWitness: GuardSnapshot = { ...witness, fields: held };
  // An error carries this accepted hold only after durable ack AND exact readback.
  try {
    const cleared = await finishExactRecovery({...opts,witness:recoveryWitness});
    // Preserve both real durable/readback receipts. The outer receipt still
    // names the held input of the clear, not the original admission witness.
    const claim_chain: FreshClaimChain = {
      version:1, mode:"fresh", initial_snapshot_sha256:accepted.guard_snapshot_sha256,
      stages:[{stage:"accepted-held",receipt:accepted},{stage:"cleared",receipt:cleared.receipt}],
    };
    return {...cleared.claim,claim_chain};
  }
  catch(cause) { throw new ExactClaimRecoveryError(opts.slug,accepted,cause); }
}
