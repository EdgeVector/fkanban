import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, symlinkSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createFkanbanMcpServer } from "../src/mcp/server.ts";
import { expect, test } from "bun:test";
import { fakeNode } from "./fake-node.ts";
import { FkanbanError, newNodeClient } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { CARD_FIELDS, DEFAULT_COLUMNS } from "../src/schemas.ts";
import { boardToFields, cardToFields, emptyStructuredFields, type Card } from "../src/record.ts";
import { boardCardFieldsFromCard } from "../src/board-cards.ts";
import { captureSnapshot, captureSnapshots, COMPOUND_CARD_BUILD, parseSnapshot, serializeSnapshot, sha256, snapshotFileOptions, type GuardedReceipt } from "../src/guarded-snapshot.ts";
import { markCmd } from "../src/commands/mark.ts";
import { setCmd } from "../src/commands/set.ts";
import { moveCmd } from "../src/commands/move.ts";
import { pickupClaimV2Result } from "../src/commands/pickup_claim_v2.ts";

const allow = async () => ({ok:true});
function fixture(column="doing", owner="worker") {
  const cfg:Config={configVersion:1,nodeUrl:"http://unused.invalid",schemaServiceUrl:"http://unused.invalid",userHash:"synthetic",schemaHashes:{card:"card",board:"board",board_cards:"members"}};
  const node=fakeNode({dropIncompleteRows:false});
  const card:Card={...emptyStructuredFields(),slug:"guard",title:"fixture",body:"## GOAL\nTest the exact factory path.\n## END STATE\nPROOF: PASS.\nRepo: EdgeVector/fkanban\nBase: main\nKind: pr",board:"default",column,position:"100",assignee:owner,tags:["p1"],deps:[],surfaces:["src/guard.ts"],created_at:"2026-10-08T00:00:00Z",updated_at:"2026-10-08T00:00:00Z",repo:"EdgeVector/fkanban",base:"main",kind:"pr",block_status:"none",block_reason:""};
  node.seed({schemaHash:"card",keyHash:card.slug,fields:cardToFields(card)});
  node.seed({schemaHash:"board",keyHash:"default",fields:boardToFields({slug:"default",title:"fixture",body:"",columns:[...DEFAULT_COLUMNS],created_at:"test",updated_at:"test"})});
  node.nodeVersion=async()=>({handshake:true,build:COMPOUND_CARD_BUILD} as any);
  node.getSchema=async hash=>({name:hash,descriptive_name:"",owner_app_id:"",schema_type:"",key:{hash_field:hash==="card"?"slug":"board",range_field:hash==="card"?null:"sk"},fields:Object.keys(hash==="card"?cardToFields(card):boardCardFieldsFromCard(card))});
  const batches: Parameters<NonNullable<typeof node.updateRecords>>[0][]=[];
  let inject: ((n:number)=>void)|undefined;
  node.updateRecords=async rows=>{
    batches.push(rows); inject?.(batches.length);
    // Evaluate all expectations against the old state before any write.
    for(const row of rows) if(row.expected?.type==="value" && JSON.stringify(node.rowAt(row.schemaHash,row.keyHash,row.rangeKey)?.fields[row.expected.field])!==JSON.stringify(row.expected.value)) {
      throw new FkanbanError({code:"cas_conflict",message:`raw ${row.expected.field} changed`});
    }
    for(const row of rows) node.seed({schemaHash:row.schemaHash,keyHash:row.keyHash,rangeKey:row.rangeKey,fields:{...node.rowAt(row.schemaHash,row.keyHash,row.rangeKey)?.fields,...structuredClone(row.fields)}});
  };
  const change=(patch:Record<string,unknown>)=>node.seed({schemaHash:"card",keyHash:"guard",fields:{...node.rowAt("card","guard")!.fields,...patch}});
  const snapshot=async()=>{const json=serializeSnapshot(await captureSnapshot(node,cfg,"guard"));return {guardSnapshotJson:json,snapshotSha256:sha256(json)};};
  const receipt=(r:Partial<GuardedReceipt>)=>({guardSnapshotJson:r.next_snapshot_json!,snapshotSha256:r.next_snapshot_sha256!});
  return {cfg,node,batches,change,snapshot,receipt,inject:(fn:(n:number)=>void)=>{inject=fn;}};
}
const pick=(f:ReturnType<typeof fixture>,snapshot={})=>pickupClaimV2Result({cfg:f.cfg,node:f.node,onlyCard:"guard",worker:"worker",situationPreflight:allow,...snapshot});
const marker=(f:ReturnType<typeof fixture>,snapshot:{guardSnapshotJson:string;snapshotSha256:string})=>markCmd({cfg:f.cfg,node:f.node,slug:"guard",situationPreflight:allow,line:"PROOF: PASS exact-public",expectAssignee:"worker",...snapshot});

for(const field of CARD_FIELDS) {
  test(`raw23 isolated ${field} race has zero publication`,async()=>{
    const f=fixture(); const s=await f.snapshot(); const original=f.node.rowAt("card","guard")!.fields[field];
    const changed=Array.isArray(original)?[...original,"new-value"]:`${original}-human-edit`;
    f.inject(()=>f.change({[field]:changed}));
    let failure:unknown; try{await marker(f,s);}catch(e){failure=e;}
    expect(f.node.writes).toHaveLength(0); expect(f.node.rowsOf("members")).toHaveLength(0);
    expect(f.node.rowAt("card","guard")!.fields[field]).toEqual(changed);
    expect(failure).toMatchObject({code:"cas_conflict"});
  });
}
for(const stage of [1,2]) for(const field of ["assignee","column","block_status","block_reason","body","updated_at","tags","deps","surfaces"]) {
  test(`exact claim stage ${stage} isolated ${field} preserves human edit`,async()=>{
    const f=fixture("todo",""); const s=await f.snapshot();
    f.inject(n=>{if(n===stage){const v=f.node.rowAt("card","guard")!.fields[field];f.change({[field]:Array.isArray(v)?[...v,"human"]:`${v}-human`});}});
    let failure:unknown;try{await pick(f,s);}catch(e){failure=e;}
    expect(f.node.writes).toHaveLength(0);expect(f.batches).toHaveLength(stage);
    expect(f.node.rowsOf("members")).toHaveLength(stage===1?0:1);
    expect(JSON.stringify(f.node.rowAt("card","guard")!.fields[field])).toContain("human");
    expect(failure).toMatchObject(stage===1?{code:"cas_conflict"}:{code:"claim_recovery_pending",clearCode:"cas_conflict"});
  });
}
test("public claim append metadata terminal share exact next bytes",async()=>{
  const f=fixture("todo","");const admitted=await f.snapshot(); const claimed=await pick(f,admitted);
  expect(claimed.result).toBe("claimed"); if(claimed.result!=="claimed")throw Error("not claimed");
  const mark=await marker(f,f.receipt(claimed));
  expect(mark.guard_snapshot_sha256).toBe(claimed.next_snapshot_sha256!);
  const metadata=await setCmd({cfg:f.cfg,node:f.node,slug:"guard",situationPreflight:allow,prUrl:"https://github.com/EdgeVector/fkanban/pull/1",branch:"guarded",expectAssignee:"worker",...f.receipt(mark)});
  const done=await moveCmd({cfg:f.cfg,node:f.node,slug:"guard",situationPreflight:allow,column:"done",expectColumn:"doing",expectAssignee:"worker",...f.receipt(metadata)});
  expect(done.durability).toBe("durable");expect(done.next_snapshot_sha256).toBe(sha256(done.next_snapshot_json!));
  expect(f.node.rowAt("card","guard")!.fields.body).toContain("PROOF: PASS exact-public");
  expect(f.node.rowAt("card","guard")!.fields.tags).toEqual(expect.arrayContaining(["p1"]));
  const latest=f.node.rowsOf("members").find(r=>r.fields.column==="done")!;
  expect(latest.fields.tags).toEqual(f.node.rowAt("card","guard")!.fields.tags);
  expect(f.batches).toHaveLength(5);for(const batch of f.batches){expect(batch).toHaveLength(25);expect(batch.every(r=>r.durability==="durable")).toBe(true);}
  const retry=await markCmd({cfg:f.cfg,node:f.node,slug:"guard",situationPreflight:allow,line:"PROOF: PASS exact-public",expectAssignee:"worker",...f.receipt(done)});
  expect(retry.next_snapshot_sha256).toBe(done.next_snapshot_sha256!);
});
test("raw values survive normalizer defaults and arrays",async()=>{
  const f=fixture();f.change({created_by:"",db:"",tags:["p1","p1","done_at:old"],deps:[],surfaces:[],body:"## END STATE\nKeep raw fields.\nSurfaces: src/derived.ts\nCreated By: other"});
  const before=f.node.rowAt("card","guard")!.fields;const result=await marker(f,await f.snapshot());
  const next=JSON.parse(result.next_snapshot_json!).fields;
  for(const key of CARD_FIELDS.filter(k=>!["body","updated_at"].includes(k)))expect(next[key]).toEqual(before[key]);
});
test("sequential same-owner GOAL edit cannot replace prior proof witness",async()=>{
  const f=fixture();const mark=await marker(f,await f.snapshot());f.change({body:"## GOAL\nHuman changed the goal.\n## END STATE\nNeeds new proof."});const before=f.batches.length;
  let failure:unknown;try{await setCmd({cfg:f.cfg,node:f.node,slug:"guard",situationPreflight:allow,prUrl:"https://github.com/EdgeVector/fkanban/pull/1",expectAssignee:"worker",...f.receipt(mark)});}catch(e){failure=e;}
  expect(f.batches).toHaveLength(before);expect(f.node.writes).toHaveLength(0);expect(failure).toMatchObject({code:"guard_snapshot_conflict"});
});
test("stale accepted snapshot refuses retry before publication",async()=>{const f=fixture();const old=await f.snapshot();await marker(f,old);const n=f.batches.length;await expect(marker(f,old)).rejects.toMatchObject({code:"guard_snapshot_conflict"});expect(f.batches).toHaveLength(n);});
for(const malformed of ["missing-field","null","array","version","schema","key","extra","sha"])test(`malformed ${malformed} refuses with zero writes`,async()=>{
  const f=fixture();const s=await f.snapshot();const raw=JSON.parse(s.guardSnapshotJson);
  if(malformed==="missing-field")delete raw.fields.updated_at;
  if(malformed==="null")raw.fields.body=null;
  if(malformed==="array")raw.fields.tags=[3];
  if(malformed==="version")raw.version=2;
  if(malformed==="schema")raw.schema_hash="other";
  if(malformed==="key")raw.fields.slug="other";
  if(malformed==="extra")raw.fields.future="unreviewed";
  const json=JSON.stringify(raw);let failure:unknown;try{await marker(f,{guardSnapshotJson:json,snapshotSha256:malformed==="sha"?"0".repeat(64):sha256(json)});}catch(e){failure=e;}
  expect(f.batches).toHaveLength(0);expect(f.node.writes).toHaveLength(0);expect(failure).toBeInstanceOf(FkanbanError);
});
test("noncanonical byte SHA is retained",async()=>{const f=fixture();const s=await f.snapshot();const json=JSON.stringify(JSON.parse(s.guardSnapshotJson),null,2);const r=await marker(f,{guardSnapshotJson:json,snapshotSha256:sha256(json)});expect(r.guard_snapshot_sha256).toBe(sha256(json));});
test("unowned backlog surfaces correction and promotion are finite",async()=>{
  const f=fixture("backlog","");const before=f.node.rowAt("card","guard")!.fields;
  const scope=await setCmd({cfg:f.cfg,node:f.node,slug:"guard",situationPreflight:allow,surfaces:["src/guarded-*.ts"],expectAssignee:"",...await f.snapshot()});
  for(const key of CARD_FIELDS.filter(k=>!["surfaces","updated_at"].includes(k)))expect(JSON.parse(scope.next_snapshot_json!).fields[key]).toEqual(before[key]);
  const ready=await moveCmd({cfg:f.cfg,node:f.node,slug:"guard",situationPreflight:allow,column:"todo",expectColumn:"backlog",expectAssignee:"",...f.receipt(scope)});expect(ready.to).toBe("todo");
});
for(const path of ["/absolute/file","../src/file","src/../file","bare","src/","src//file","src/file\n", "*/file", "src/{a,b}"])test(`unsafe surface ${JSON.stringify(path)} refuses`,async()=>{const f=fixture("backlog","");await expect(setCmd({cfg:f.cfg,node:f.node,slug:"guard",situationPreflight:allow,surfaces:[path],expectAssignee:"",...await f.snapshot()})).rejects.toMatchObject({code:"guarded_surfaces_scope"});expect(f.batches).toHaveLength(0);});
test("missing Board refuses without create or repair",async()=>{const f=fixture();f.node.seed({schemaHash:"board",keyHash:"default",fields:{slug:"default",columns:["tombstone"]}});await expect(marker(f,await f.snapshot())).rejects.toMatchObject({code:"guarded_board_missing"});expect(f.batches).toHaveLength(0);expect(f.node.writes).toHaveLength(0);});
for(const build of ["unknown","0.23.3-2328-g369ad6cd6","0.23.3-2375-ga7bac36f1"])test(`unproved compound build ${build} refuses`,async()=>{const f=fixture();f.node.nodeVersion=async()=>({handshake:true,build}as any);await expect(marker(f,await f.snapshot())).rejects.toMatchObject({code:"guarded_batch_unsupported"});expect(f.batches).toHaveLength(0);});
test("finite guarded broad set refuses before publication",async()=>{const f=fixture();let e:any;try{await setCmd({cfg:f.cfg,node:f.node,slug:"guard",situationPreflight:allow,title:"human replace",prUrl:"https://github.com/EdgeVector/fkanban/pull/1",expectAssignee:"worker",...await f.snapshot()});}catch(error){e=error;}expect(f.batches).toHaveLength(0);expect(f.node.writes).toHaveLength(0);expect(e).toMatchObject({code:"guarded_set_scope"});});
test("finite guarded force move refuses before publication",async()=>{const f=fixture();let e:any;try{await moveCmd({cfg:f.cfg,node:f.node,slug:"guard",situationPreflight:allow,column:"done",expectColumn:"doing",expectAssignee:"worker",force:true,...await f.snapshot()});}catch(error){e=error;}expect(f.batches).toHaveLength(0);expect(f.node.writes).toHaveLength(0);expect(e).toMatchObject({code:"guarded_move_scope"});});
test("finite guarded wrong from refuses before publication",async()=>{const f=fixture();let e:any;try{await moveCmd({cfg:f.cfg,node:f.node,slug:"guard",situationPreflight:allow,column:"done",expectColumn:"backlog",expectAssignee:"worker",...await f.snapshot()});}catch(error){e=error;}expect(f.batches).toHaveLength(0);expect(f.node.writes).toHaveLength(0);expect(e).toMatchObject({code:"guarded_move_scope"});});
test("wrong owner and broad fields refuse without fallback",async()=>{const f=fixture();const s=await f.snapshot();await expect(setCmd({cfg:f.cfg,node:f.node,slug:"guard",situationPreflight:allow,blockStatus:"none",expectAssignee:"worker",...s})).rejects.toMatchObject({code:"guarded_set_scope"});await expect(moveCmd({cfg:f.cfg,node:f.node,slug:"guard",situationPreflight:allow,column:"done",expectColumn:"doing",expectAssignee:"worker",force:true,...s})).rejects.toMatchObject({code:"guarded_move_scope"});await expect(markCmd({cfg:f.cfg,node:f.node,slug:"guard",situationPreflight:allow,line:"x",expectAssignee:"other",...s})).rejects.toMatchObject({code:"owner_conflict"});expect(f.batches).toHaveLength(0);expect(f.node.writes).toHaveLength(0);});
test("native dependency keys batch and missing key refuses",async()=>{const f=fixture();f.change({deps:["dep-a","dep-b"]});let failure:unknown;try{await marker(f,await f.snapshot());}catch(e){failure=e;}const reads=f.node.reads.filter(r=>r.filter && "HashRangeKeys" in r.filter && r.fields.length===3);expect(reads).toHaveLength(1);expect((reads[0]!.filter as any).HashRangeKeys).toEqual([["dep-a",""],["dep-b",""]]);expect(f.batches).toHaveLength(0);expect(failure).toMatchObject({code:"card_blocked"});});
test("read failure and uncertain durable response have no fallback",async()=>{const f=fixture();const s=await f.snapshot();f.node.updateRecords=async()=>{throw new FkanbanError({code:"durability_not_confirmed",message:"injected memory-only ack"});};await expect(marker(f,s)).rejects.toMatchObject({code:"durability_not_confirmed"});expect(f.node.writes).toHaveLength(0);});
test("caller snapshot parser never normalizes raw fields",async()=>{const f=fixture();f.change({surfaces:[],tags:["p1","p1"]});const s=await f.snapshot();expect(parseSnapshot(s.guardSnapshotJson,s.snapshotSha256,f.cfg,"guard").fields.surfaces).toEqual([]);});

test("legitimate empty unheld status stays empty on metadata update",async()=>{const f=fixture("backlog","");f.change({block_status:""});const r=await setCmd({cfg:f.cfg,node:f.node,slug:"guard",surfaces:["src/factory.ts"],expectAssignee:"",...await f.snapshot()});expect(JSON.parse(r.next_snapshot_json!).fields.block_status).toBe("");});
test("initial exact claim refuses same-worker owned todo",async()=>{const f=fixture("todo","worker");await expect(pick(f,await f.snapshot())).rejects.toMatchObject({code:"owner_conflict"});expect(f.batches).toHaveLength(0);});
test("intended doing Situation refuses claim without publication",async()=>{const f=fixture("todo","");let e:any;try{await pickupClaimV2Result({cfg:f.cfg,node:f.node,onlyCard:"guard",worker:"worker",situationPreflight:async()=>({ok:false,blocks:[{action:"claim-card",message:"synthetic hold",situation:{slug:"synthetic"}}]}),...await f.snapshot()});}catch(error){e=error;}expect(f.batches).toHaveLength(0);expect(f.node.writes).toHaveLength(0);expect(e).toMatchObject({code:"situation_fenced"});});

test("durable accepted hold resumes only from the supplied receipt",async()=>{
  const f=fixture("todo","");const base=f.node.updateRecords!;let n=0;f.node.updateRecords=async rows=>{if(++n===2)throw new FkanbanError({code:"service_timeout",message:"before clear"});return base(rows);};
  let error:any;try{await pick(f,await f.snapshot());}catch(e){error=e;}
  expect(error).toMatchObject({code:"claim_recovery_pending",acceptedHeld:{stage:"accepted-held",durability:"durable"}});
  const absent=await pick(f);expect(absent.result).toBe("none");expect(n).toBe(2);
  f.node.updateRecords=base;const r=await pick(f,{guardSnapshotJson:error.acceptedHeld.snapshot_json,snapshotSha256:error.acceptedHeld.snapshot_sha256});expect(r.result).toBe("claimed");expect(f.node.rowAt("card","guard")!.fields.block_status).toBe("none");
});
for(const field of ["block_status","block_reason","body","updated_at"])test(`accepted-held resume ${field} edit refuses`,async()=>{
  const f=fixture("todo","");const base=f.node.updateRecords!;let n=0;f.node.updateRecords=async rows=>{if(++n===2)throw new FkanbanError({code:"service_timeout",message:"before clear"});return base(rows);};let error:any;try{await pick(f,await f.snapshot());}catch(e){error=e;}
  f.node.updateRecords=base;f.change({[field]:`human ${field}`});const before=f.batches.length;
  await expect(pick(f,{guardSnapshotJson:error.acceptedHeld.snapshot_json,snapshotSha256:error.acceptedHeld.snapshot_sha256})).rejects.toMatchObject({code:"guard_snapshot_conflict"});expect(f.batches).toHaveLength(before);expect(f.node.rowAt("card","guard")!.fields[field]).toBe(`human ${field}`);
});
test("unknown initial durability exposes no accepted-held or next snapshot",async()=>{const f=fixture("todo","");f.node.updateRecords=async()=>{throw new FkanbanError({code:"durability_not_confirmed",message:"unknown"});};let e:any;try{await pick(f,await f.snapshot());}catch(error){e=error;}expect(e.code).toBe("durability_not_confirmed");expect(e.acceptedHeld).toBeUndefined();expect(e.next_snapshot_json).toBeUndefined();});

for(const mode of ["mismatch","failure"])test(`stage1 durable readback ${mode} exposes no accepted-held receipt`,async()=>{
  const f=fixture("todo","");const s=await f.snapshot(),read=f.node.queryAll;let reached=false;
  f.node.queryAll=async opts=>{
    if(f.batches.length===1 && opts.schemaHash==="card" && (opts.filter as any)?.HashRangeKeys){
      reached=true;
      if(mode==="failure")throw new FkanbanError({code:"service_timeout",message:"stage1 readback failed"});
      const r=await read(opts);return {...r,results:r.results.map(row=>({...row,fields:{...row.fields,body:"different readback"}}))};
    }
    return read(opts);
  };
  let error:any,result:any;try{result=await pick(f,s);}catch(e){error=e;}
  expect(reached).toBe(true);expect(f.batches).toHaveLength(1);expect(result).toBeUndefined();
  expect(f.node.rowAt("card","guard")!.fields.block_status).toBe("needs_human");
  expect(f.node.rowAt("card","guard")!.fields.block_reason).toContain('claim recovery pending for worker "worker"');
  expect(error.code).toBe(mode==="failure"?"service_timeout":"guarded_readback_conflict");
  expect(error.acceptedHeld).toBeUndefined();expect(error.next_snapshot_json).toBeUndefined();
});

for(const ack of ["queued","memory","missing","malformed"])test(`real NodeClient ${ack} acknowledgement exposes no receipt`,async()=>{
  const f=fixture();let calls=0;
  const server=Bun.serve({port:0,fetch:async req=>{if(new URL(req.url).pathname==="/api/mutations/batch"){calls++;const rows=await req.json() as any[];for(const row of rows)f.node.seed({schemaHash:row.schema,keyHash:row.key_value.hash,rangeKey:row.key_value.range,fields:{...f.node.rowAt(row.schema,row.key_value.hash,row.key_value.range)?.fields,...row.fields_and_values}});return ack==="malformed"?new Response("not JSON"):Response.json(ack==="missing"?{}:{durability:ack});}return Response.json({ok:true});}});
  try {const wire=newNodeClient({baseUrl:`http://127.0.0.1:${server.port}`,userHash:"synthetic"});f.node.updateRecords=wire.updateRecords;let result:any,failure:any;try{result=await marker(f,await f.snapshot());}catch(e){failure=e;}
    expect(calls).toBe(1);expect(f.node.writes).toHaveLength(0);expect(result).toBeUndefined();expect(failure).toMatchObject({code:"durability_not_confirmed"});
  }finally{server.stop(true);}
});
test("FIFO snapshot file refuses within a bounded time",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"fkanban-fifo-fixture-"));const path=dir+"/snapshot";
  const made=Bun.spawnSync(["/usr/bin/mkfifo",path]);expect(made.exitCode).toBe(0);
  const proc=Bun.spawn([process.execPath,"-e",`import {snapshotFileOptions} from ${JSON.stringify(new URL("../src/guarded-snapshot.ts",import.meta.url).pathname)};try{await snapshotFileOptions(process.argv[1],"0".repeat(64));process.exit(1)}catch{process.exit(0)}`,path],{stdout:"pipe",stderr:"pipe"});
  const timeout=setTimeout(()=>proc.kill(),1500);try{expect(await proc.exited).toBe(0);}finally{clearTimeout(timeout);}
},3000);
test("symlink and oversized snapshot files refuse",async()=>{const dir=mkdtempSync(join(tmpdir(),"fkanban-file-fixture-"));const path=dir+"/file";writeFileSync(path,"{}\n");symlinkSync(path,dir+"/link");await expect(snapshotFileOptions(dir+"/link",sha256("{}\n"))).rejects.toBeInstanceOf(Error);writeFileSync(path,"a".repeat(1048577));await expect(snapshotFileOptions(path,"0".repeat(64))).rejects.toMatchObject({code:"invalid_guard_snapshot"});});
test("guarded contract succeeds before unavailable config",async()=>{const proc=Bun.spawn([process.execPath,new URL("../src/cli.ts",import.meta.url).pathname,"guarded-contract","--json"],{env:{...process.env,KANBAN_CONFIG:"/not-a-config",FKANBAN_CONFIG:"/not-a-config"},stdout:"pipe",stderr:"pipe"});const out=await new Response(proc.stdout).text();expect(await proc.exited).toBe(0);expect(JSON.parse(out)).toMatchObject({name:"fkanban-raw23-guarded-card",compound_builds:[COMPOUND_CARD_BUILD]});},10000);
test("MCP exact snapshot and guarded closeout preserve declared receipts",async()=>{
  const f=fixture();const [ct,st]=InMemoryTransport.createLinkedPair();const server=createFkanbanMcpServer({cfg:f.cfg,node:f.node});const client=new Client({name:"guarded-test",version:"1"});await Promise.all([client.connect(ct),server.connect(st)]);
  try {const raw=await client.callTool({name:"fkanban_guarded_snapshot",arguments:{slug:"guard"}});const s=raw.structuredContent as any;expect(s.snapshot_sha256).toBe(sha256(s.snapshot_json));
    const marked=await client.callTool({name:"fkanban_mark",arguments:{slug:"guard",line:"PROOF: PASS mcp",expect_assignee:"worker",guard_snapshot_json:s.snapshot_json,snapshot_sha256:s.snapshot_sha256}});expect(marked.isError).not.toBe(true);const m=marked.structuredContent as any;expect(m.durability).toBe("durable");expect(m.next_snapshot_sha256).toBe(sha256(m.next_snapshot_json));
    const set=await client.callTool({name:"fkanban_set",arguments:{slug:"guard",pr_url:"https://github.com/EdgeVector/fkanban/pull/1",expect_assignee:"worker",guard_snapshot_json:m.next_snapshot_json,snapshot_sha256:m.next_snapshot_sha256}});expect(set.isError).not.toBe(true);const r=set.structuredContent as any;
    const done=await client.callTool({name:"fkanban_move",arguments:{slug:"guard",column:"done",from:"doing",expect_assignee:"worker",guard_snapshot_json:r.next_snapshot_json,snapshot_sha256:r.next_snapshot_sha256}});expect(done.isError).not.toBe(true);expect((done.structuredContent as any).durability).toBe("durable");
    const before=f.batches.length;const broad=await client.callTool({name:"fkanban_set",arguments:{slug:"guard",title:"wrong",expect_assignee:"worker",guard_snapshot_json:m.next_snapshot_json,snapshot_sha256:m.next_snapshot_sha256}});expect(f.batches).toHaveLength(before);expect(broad.isError).toBe(true);
  }finally{await client.close();await server.close();}
});
test("native dependency batch failure refuses without publication",async()=>{const f=fixture();f.change({deps:["dep"]});const original=f.node.queryAll;f.node.queryAll=async o=>{if(o.filter && "HashRangeKeys" in o.filter && o.fields.length===3)throw new FkanbanError({code:"service_timeout",message:"synthetic read failure"});return original(o);};await expect(marker(f,await f.snapshot())).rejects.toMatchObject({code:"service_timeout"});expect(f.batches).toHaveLength(0);});
test("terminal move has no unrelated dependent publication",async()=>{const f=fixture();const unrelated={...f.node.rowAt("card","guard")!.fields,slug:"dependent",column:"backlog",deps:["guard"]};f.node.seed({schemaHash:"card",keyHash:"dependent",fields:unrelated});await moveCmd({cfg:f.cfg,node:f.node,slug:"guard",column:"done",expectColumn:"doing",expectAssignee:"worker",...await f.snapshot()});expect(f.node.rowAt("card","dependent")!.fields).toEqual(unrelated);expect(f.node.writes).toHaveLength(0);expect(f.node.rowsOf("members").every(r=>r.fields.slug==="guard")).toBe(true);});
test("missing canonical Card never creates a destination",async()=>{const f=fixture();const json=serializeSnapshot({...await captureSnapshot(f.node,f.cfg,"guard"),fields:{...f.node.rowAt("card","guard")!.fields,slug:"missing"} as any});await expect(markCmd({cfg:f.cfg,node:f.node,slug:"missing",line:"proof",expectAssignee:"worker",guardSnapshotJson:json,snapshotSha256:sha256(json)})).rejects.toMatchObject({code:"card_not_found"});expect(f.batches).toHaveLength(0);expect(f.node.rowsOf("members")).toHaveLength(0);});

test("snapshot batch keeps requested order and explicit missing with one native read",async()=>{const f=fixture();const before=f.node.reads.length;const result=await captureSnapshots(f.node,f.cfg,["missing","guard"]);expect(result.items[0]).toEqual({slug:"missing",missing:true});expect(result.items[1]).toMatchObject({slug:"guard"});expect(f.node.reads.slice(before)).toHaveLength(1);expect(f.node.reads.at(-1)!.filter).toEqual({HashRangeKeys:[["missing",""],["guard",""]]} as any);expect(f.node.writes).toHaveLength(0);});
for(const defect of ["duplicate","foreign","range","partial","key","failed"])test(`snapshot batch ${defect} refuses instead of missing truth`,async()=>{const f=fixture();const query=f.node.queryAll;f.node.queryAll=async o=>{if(defect==="failed")throw new FkanbanError({code:"service_timeout",message:"failed"});const r=await query(o);const row=structuredClone(r.results[0]!);if(defect==="duplicate")r.results.push(row);if(defect==="foreign")row.key.hash="foreign";if(defect==="range")row.key.range="not-canonical";if(defect==="partial")delete row.fields.body;if(defect==="key")row.fields.slug="other";return defect==="duplicate"?r:{...r,results:[row]};};let result:any,error:any;try{result=await captureSnapshots(f.node,f.cfg,["guard","missing"]);}catch(e){error=e;}expect(f.node.writes).toHaveLength(0);expect(result).toBeUndefined();expect(error).toBeInstanceOf(FkanbanError);});

for(const defect of ["duplicate","foreign","string-key","incomplete","unresolved","unresolved-type","count","malformed","oversize"])test(`real raw known-key ${defect} response refuses`,async()=>{
  const f=fixture();const original=f.node.rowAt("card","guard")!.fields;let calls=0;
  const server=Bun.serve({port:0,fetch:async req=>{calls++;const request=await req.json() as any;expect(request.filter).toEqual({HashRangeKeys:[["guard",""],["missing",""]]});let row:any={key:{hash:"guard",range:null},fields:original};let result:any={ok:true,results:[row],has_more:false,unresolved_rows:0};
    if(defect==="duplicate")result.results.push(structuredClone(row));if(defect==="foreign")row.key.hash="foreign";if(defect==="string-key")row.key="guard";if(defect==="incomplete")result.has_more=true;if(defect==="unresolved")result.unresolved_rows=1;if(defect==="unresolved-type")result.unresolved_rows="1";if(defect==="count")result.returned_count=2;if(defect==="malformed")delete row.fields;if(defect==="oversize")result.padding="x".repeat(8388609);return Response.json(result);}});
  try{const node=newNodeClient({baseUrl:`http://127.0.0.1:${server.port}`,userHash:"synthetic"});let result:any,error:any;try{result=await captureSnapshots(node,f.cfg,["guard","missing"]);}catch(e){error=e;}expect(calls).toBe(1);expect(result).toBeUndefined();expect(error).toBeInstanceOf(FkanbanError);}finally{server.stop(true);}
});

test("chunked raw response byte cap refuses before its endless body ends",async()=>{let cancelled=false;
  const server=Bun.serve({port:0,fetch:()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(8388609));},cancel(){cancelled=true;}}))});
  try{const f=fixture();const wire=newNodeClient({baseUrl:`http://127.0.0.1:${server.port}`,userHash:"synthetic",timeoutMs:1000});const started=Date.now();await expect(captureSnapshots(wire,f.cfg,["guard"])).rejects.toMatchObject({code:"guarded_read_budget"});expect(Date.now()-started).toBeLessThan(900);await new Promise(resolve=>setTimeout(resolve,20));expect(cancelled).toBe(true);}finally{server.stop(true);}
},3000);

test("accepted-held resume current canonical peer overlap retains the hold",async()=>{const f=fixture("todo","");const base=f.node.updateRecords!;let n=0;f.node.updateRecords=async rows=>{if(++n===2)throw new FkanbanError({code:"service_timeout",message:"before clear"});return base(rows);};let error:any;try{await pick(f,await f.snapshot());}catch(e){error=e;}f.node.updateRecords=base;
  const peer={...f.node.rowAt("card","guard")!.fields,slug:"human-peer",block_status:"none",block_reason:"",assignee:"human"};f.node.seed({schemaHash:"card",keyHash:"human-peer",fields:peer});const card={...JSON.parse(error.acceptedHeld.snapshot_json).fields,slug:"human-peer",position:"200"};f.node.seed({schemaHash:"members",keyHash:"default",rangeKey:"doing#0000000000000200#human-peer",fields:boardCardFieldsFromCard({...card,done_at:"",first_doing_at:""} as any)});
  const before=f.batches.length;await expect(pick(f,{guardSnapshotJson:error.acceptedHeld.snapshot_json,snapshotSha256:error.acceptedHeld.snapshot_sha256})).rejects.toMatchObject({code:"guarded_peer_overlap"});expect(f.batches).toHaveLength(before);expect(f.node.rowAt("card","guard")!.fields.block_status).toBe("needs_human");
});
