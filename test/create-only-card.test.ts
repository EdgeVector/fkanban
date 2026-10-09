import { expect, test } from "bun:test";
import { addCmd } from "../src/commands/add.ts";
import { markCmd } from "../src/commands/mark.ts";
import { fakeNode } from "./fake-node.ts";
import { FkanbanError } from "../src/client.ts";
import { type Config } from "../src/config.ts";
import { CARD_FIELDS, DEFAULT_COLUMNS } from "../src/schemas.ts";
import { boardCardFieldsFromCard } from "../src/board-cards.ts";
import { boardToFields, cardToFields, emptyStructuredFields, type Card } from "../src/record.ts";
import { COMPOUND_CARD_BUILD, serializeSnapshot, captureSnapshot, sha256 } from "../src/guarded-snapshot.ts";
import { CREATE_ONLY_CONTRACT, CREATE_ONLY_CONTRACT_SHA256 } from "../src/create-only-card.ts";

const body="## GOAL\nKeep the late human Card.\n## END STATE\nThe exact public creation is durable.\nRepo: EdgeVector/fkanban\nBase: main\nKind: pr";
function fixture() {
  const cfg:Config={configVersion:1,nodeUrl:"http://unused.invalid",schemaServiceUrl:"http://unused.invalid",userHash:"synthetic",schemaHashes:{card:"card",board:"board",board_cards:"members"}};
  const node=fakeNode({dropIncompleteRows:false});
  const card:Card={...emptyStructuredFields(),slug:"create-test",title:"exact fixture",body,board:"default",column:"backlog",position:"100",assignee:"",tags:["p1"],deps:[],surfaces:["src/guard.ts"],created_at:"2026-10-09T00:00:00Z",updated_at:"2026-10-09T00:00:00Z",repo:"EdgeVector/fkanban",base:"main",kind:"pr",block_status:"none",block_reason:""};
  node.seed({schemaHash:"board",keyHash:"default",fields:boardToFields({slug:"default",title:"fixture",body:"",columns:[...DEFAULT_COLUMNS],created_at:"test",updated_at:"test"})});
  node.nodeVersion=async()=>({handshake:true,build:COMPOUND_CARD_BUILD} as any);
  node.getSchema=async hash=>({name:hash,descriptive_name:"",owner_app_id:"",schema_type:"",key:{hash_field:hash==="card"?"slug":"board",range_field:hash==="card"?null:"sk"},fields:Object.keys(hash==="card"?cardToFields(card):boardCardFieldsFromCard(card))});
  const batches:Parameters<NonNullable<typeof node.updateRecords>>[0][]=[];
  let beforeFilter:(()=>void)|undefined, afterFilter:(()=>void)|undefined;
  node.updateRecords=async rows=>{
    batches.push(structuredClone(rows));beforeFilter?.();
    const surviving=rows; // Public writes receive a fresh native author clock before filtering.
    afterFilter?.();
    for(const row of surviving) {
      const v=node.rowAt(row.schemaHash,row.keyHash,row.rangeKey)?.fields[row.expected?.field??""];
      if(row.expected && ((row.expected.type==="absent" && v!==undefined) ||
         (row.expected.type==="value" && JSON.stringify(v)!==JSON.stringify(row.expected.value)))) {
        throw new FkanbanError({code:"cas_conflict",message:`guard ${row.expected.field} rejected`});
      }
    }
    // Opt-in native field dedupe examines the PRE-batch tips and excludes CAS payloads.
    const effective=surviving.map(row=>row.expected?row:{...row,fields:Object.fromEntries(Object.entries(row.fields).filter(([key,value])=>
      JSON.stringify(node.rowAt(row.schemaHash,row.keyHash,row.rangeKey)?.fields[key])!==JSON.stringify(value)))});
    for(const row of effective) {
      if(Object.keys(row.fields).length)node.seed({schemaHash:row.schemaHash,keyHash:row.keyHash,rangeKey:row.rangeKey,fields:{...node.rowAt(row.schemaHash,row.keyHash,row.rangeKey)?.fields,...structuredClone(row.fields)}});
    }
  };
  const seed=(fields:Record<string,unknown>)=>node.seed({schemaHash:"card",keyHash:card.slug,fields});
  const opts={cfg,node,slug:card.slug,title:card.title,body,kind:"pr",repo:card.repo,base:"main",column:"backlog",createOnly:true,situationPreflight:async()=>({ok:true})};
  return {cfg,node,card,batches,seed,opts,
    before:(fn:()=>void)=>{beforeFilter=fn;},after:(fn:()=>void)=>{afterFilter=fn;}};
}

test("create-only exact public payload has all23 absent guards and final restoration",async()=>{
  const f=fixture();const result=await addCmd(f.opts);
  expect(result.action).toBe("created");expect(result.contract_sha256).toBe(CREATE_ONLY_CONTRACT_SHA256);
  expect(result.absence_guard).toBe("all23-absent");expect(result.durability).toBe("durable");
  expect(result.next_snapshot_sha256).toBe(sha256(result.next_snapshot_json!));
  expect(f.batches).toHaveLength(1);const rows=f.batches[0]!;expect(rows).toHaveLength(25);
  expect(rows.every(r=>r.durability==="durable")).toBe(true);
  expect(rows.slice(0,23).map(r=>r.expected)).toEqual(CARD_FIELDS.map(field=>({type:"absent",field})));
  const intended=JSON.parse(result.next_snapshot_json!).fields;
  expect(f.node.rowAt("card",f.card.slug)?.fields).toEqual(intended);
  expect(f.node.rowsOf("members")).toHaveLength(1);expect(f.node.rowsOf("members")[0]!.fields.updated_at).toBe(intended.updated_at);
  expect(f.node.writes).toHaveLength(0);
});

test("create-only initial human Card refuses body owner hold and column replacement",async()=>{
  const f=fixture();const human={...cardToFields(f.card),body:body+"\nHuman clause.",column:"doing",assignee:"human",block_status:"needs_human",block_reason:"Human hold"};
  f.seed(human);await expect(addCmd(f.opts)).rejects.toMatchObject({code:"card_exists"});
  expect(f.node.rowAt("card",f.card.slug)!.fields).toEqual(human);expect(f.batches).toHaveLength(0);expect(f.node.writes).toHaveLength(0);
});
for(const field of CARD_FIELDS)test(`create-only late partial ${field} refuses all publication`,async()=>{
  const f=fixture();const human={[field]:["tags","deps","surfaces"].includes(field)?["human"]:"human-value"};
  f.before(()=>f.seed(human));await expect(addCmd(f.opts)).rejects.toMatchObject({code:"cas_conflict"});
  expect(f.node.rowAt("card",f.card.slug)!.fields).toEqual(human);expect(f.node.rowsOf("members")).toHaveLength(0);
  expect(f.batches).toHaveLength(1);expect(f.node.writes).toHaveLength(0);
});

test("repeated mark preserves exact raw23 bytes with native field dedupe",async()=>{
  const f=fixture();f.seed({...cardToFields(f.card),column:"doing",assignee:"worker"});
  const run=async()=>{const json=serializeSnapshot(await captureSnapshot(f.node,f.cfg,f.card.slug));return markCmd({...f.opts,line:"PROOF: PASS exact",expectAssignee:"worker",guardSnapshotJson:json,snapshotSha256:sha256(json)});};
  const first=await run();const raw=JSON.parse(first.next_snapshot_json!).fields;
  const second=await run();expect(second.next_snapshot_sha256).toBe(first.next_snapshot_sha256);
  expect(f.node.rowAt("card",f.card.slug)!.fields).toEqual(raw);
});

for(const [name,patch] of [
  ["force",{force:true}],["todo",{column:"todo"}],["owner",{assignee:"human"}],
  ["hold",{blockStatus:"needs_human",blockReason:"human"}],["branch",{branch:"human"}],
  ["PR",{prUrl:"https://github.com/EdgeVector/fkanban/pull/1"}],
] as const)test(`create-only ${name} refuses before publication`,async()=>{
  const f=fixture();await expect(addCmd({...f.opts,...patch})).rejects.toBeInstanceOf(FkanbanError);
  expect(f.batches).toHaveLength(0);expect(f.node.writes).toHaveLength(0);expect(f.node.rowsOf("members")).toHaveLength(0);
});
test("create-only missing Board sends no repair",async()=>{
  const f=fixture();await expect(addCmd({...f.opts,board:"missing"})).rejects.toMatchObject({code:"create_only_board_missing"});
  expect(f.node.writes).toHaveLength(0);expect(f.batches).toHaveLength(0);
});
test("create-only unsupported node refuses without fallback",async()=>{
  const f=fixture();f.node.nodeVersion=async()=>({handshake:true,build:"wrong"} as any);
  await expect(addCmd(f.opts)).rejects.toMatchObject({code:"create_only_unsupported"});expect(f.node.writes).toHaveLength(0);expect(f.batches).toHaveLength(0);
});
test("create-only durable unknown ack never retries or publishes a second destination",async()=>{
  const f=fixture();f.node.updateRecords=async rows=>{f.batches.push(rows);throw new FkanbanError({code:"service_timeout",message:"unknown accepted write"});};
  await expect(addCmd(f.opts)).rejects.toMatchObject({code:"service_timeout"});expect(f.batches).toHaveLength(1);
  expect(f.node.writes).toHaveLength(0);expect(f.node.rowsOf("members")).toHaveLength(0);
});
test("creation contract pins native live identity and no retry",()=>{
  expect(CREATE_ONLY_CONTRACT.guard_payload_identity).toBe("native-live-author-clock-before-filter");
  expect(CREATE_ONLY_CONTRACT.card_fields).toEqual([...CARD_FIELDS]);expect(CREATE_ONLY_CONTRACT.retries).toBe(0);
});

// The exact length and the unique-field count both refuse an extra field.
// A mutation probe must remove both protections to reach this assertion.
test("create-only extra canonical Card field refuses all publication",async()=>{
  const f=fixture(),get=f.node.getSchema!;
  f.node.getSchema=async hash=>{const schema=await get(hash);return hash==="card"?{...schema,fields:[...schema.fields,"human_extra"]}:schema;};
  await expect(addCmd(f.opts)).rejects.toMatchObject({code:"create_only_schema"});expect(f.batches).toHaveLength(0);expect(f.node.writes).toHaveLength(0);
});
test("create-only canonical raw readback mismatch refuses a usable receipt",async()=>{
  const f=fixture(),run=f.node.updateRecords!;
  f.node.updateRecords=async rows=>{await run(rows);f.seed({...f.node.rowAt("card",f.card.slug)!.fields,body:body+"\nAfter ack human edit."});};
  await expect(addCmd(f.opts)).rejects.toMatchObject({code:"create_only_readback_conflict"});expect(f.batches).toHaveLength(1);
});

test("create-only full final payload is protected from field dedupe",async()=>{
  const f=fixture();await addCmd(f.opts);
  expect(f.batches[0]![23]!.expected).toEqual({type:"absent",field:"updated_at"});
});

for(const missing of ["updateRecords","getSchema","nodeVersion"] as const)test(`create-only missing ${missing} refuses without fallback`,async()=>{
  const f=fixture();f.node[missing]=undefined;
  await expect(addCmd(f.opts)).rejects.toMatchObject({code:"create_only_unsupported"});expect(f.batches).toHaveLength(0);expect(f.node.writes).toHaveLength(0);
});
// A duplicate omits one real payload field. Exact schema and payload validation both refuse it.
// The probe removes both protections to reach this assertion.
test("create-only duplicate canonical Card field refuses all publication",async()=>{
  const f=fixture(),get=f.node.getSchema!;
  f.node.getSchema=async hash=>{const schema=await get(hash);return hash==="card"?{...schema,fields:schema.fields.map((field,index)=>index===2?"title":field)}:schema;};
  await expect(addCmd(f.opts)).rejects.toMatchObject({code:"create_only_schema"});expect(f.batches).toHaveLength(0);expect(f.node.writes).toHaveLength(0);
});
test("create-only legitimate canonical field permutation succeeds",async()=>{
  const f=fixture(),get=f.node.getSchema!;
  f.node.getSchema=async hash=>{const schema=await get(hash);return hash==="card"?{...schema,fields:[...schema.fields].reverse()}:schema;};
  expect((await addCmd(f.opts)).action).toBe("created");
});

for(const build of ["0.23.3-2588-g24334db75","0.23.3-2693-gb70418967"])test(`create-only exact supported build ${build} succeeds`,async()=>{
  const f=fixture();f.node.nodeVersion=async()=>({handshake:true,build} as any);
  expect((await addCmd(f.opts)).durability).toBe("durable");
});
for(const build of ["0.23.3-2693-gb70418967-dirty","0.23.3-2694-gother"])test(`create-only unproved nearby build ${build} refuses`,async()=>{
  const f=fixture();f.node.nodeVersion=async()=>({handshake:true,build} as any);
  await expect(addCmd(f.opts)).rejects.toMatchObject({code:"create_only_unsupported"});expect(f.batches).toHaveLength(0);
});


for (const [name,hashPart,range] of [
  ["Card hash", "card", false], ["Card range", "card", true],
  ["BoardCards hash", "members", false], ["BoardCards range", "members", true],
] as const)test(`create-only wrong ${name} key refuses all publication`,async()=>{
  const f=fixture(),get=f.node.getSchema!;
  f.node.getSchema=async hash=>{const schema=await get(hash);return hash===hashPart?{...schema,key:{...schema.key,...(range?{range_field:"wrong_range"}:{hash_field:"wrong_hash"})}}:schema;};
  await expect(addCmd(f.opts)).rejects.toMatchObject({code:"create_only_schema"});
  expect(f.batches).toHaveLength(0);expect(f.node.writes).toHaveLength(0);expect(f.node.rowsOf("members")).toHaveLength(0);
});
test("create-only missing BoardCards payload field refuses all publication",async()=>{
  const f=fixture(),get=f.node.getSchema!;
  f.node.getSchema=async hash=>{const schema=await get(hash);return hash==="members"?{...schema,fields:schema.fields.filter(field=>field!=="title")}:schema;};
  await expect(addCmd(f.opts)).rejects.toMatchObject({code:"create_only_schema"});expect(f.batches).toHaveLength(0);expect(f.node.writes).toHaveLength(0);
});
test("create-only missing destination refuses without fallback",async()=>{
  const f=fixture();delete f.cfg.schemaHashes.board_cards;
  await expect(addCmd(f.opts)).rejects.toMatchObject({code:"create_only_unsupported"});expect(f.batches).toHaveLength(0);expect(f.node.writes).toHaveLength(0);
});
test("create-only legitimate second BoardCards destination stays in the same batch",async()=>{
  const f=fixture();f.cfg.schemaHashes.board_cards_rekey_target="members-target";
  expect((await addCmd(f.opts)).action).toBe("created");expect(f.batches).toHaveLength(1);expect(f.batches[0]).toHaveLength(26);
  expect(f.node.rowsOf("members")).toHaveLength(1);expect(f.node.rowsOf("members-target")).toHaveLength(1);expect(f.node.writes).toHaveLength(0);
});
