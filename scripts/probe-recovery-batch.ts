/** Fresh synthetic-home proof. Never accepts the primary socket or a copied home. */
import {readConfig} from '../src/config.ts';
import {newNodeClient} from '../src/client.ts';
import {addCmd} from '../src/commands/add.ts';
import {moveCmd} from '../src/commands/move.ts';
import {setCmd} from '../src/commands/set.ts';
import {requireCard,cardToFields,type Card} from '../src/record.ts';
import {boardCardFieldsFromCard,boardCardSk,listBoardCardsPartition} from '../src/board-cards.ts';
import {guardedCardUpdate} from '../src/guarded-card-update.ts';
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const cfg=readConfig();
if(!cfg.nodeSocketPath?.startsWith('/tmp/fkanban-owner-probe-'))throw Error('fresh synthetic home only');
const node=newNodeClient({baseUrl:cfg.nodeUrl,userHash:cfg.userHash,socketPath:cfg.nodeSocketPath});
const expected={type:'value' as const,field:'assignee',value:'loom:original'};
const evidencePath=process.env.PROBE_EVIDENCE!;
if(!evidencePath?.startsWith('/tmp/fkanban-owner-probe-'))throw Error('explicit synthetic evidence path required');
if(process.argv.includes('--verify-restart')) {
 const prior=JSON.parse(readFileSync(evidencePath,'utf8'));
 const states=[];
 for(const entry of prior.persisted) {
  const now=await requireCard(node,cfg,entry.slug);
  for(const field of ['assignee','column','body','block_status','block_reason','tags']) assert.deepEqual((now as any)[field],entry[field],`${entry.slug} ${field}`);
  states.push(now);
 }
 console.log(JSON.stringify({restart:'passed',version:await node.nodeVersion?.(),states}));
 process.exit(0);
}
const evidence:any={version:await node.nodeVersion?.(),schema:[],cases:[],persisted:[]};
for(const hash of [cfg.schemaHashes.card!,cfg.schemaHashes.board_cards!]) evidence.schema.push(await node.getSchema!(hash));
const fresh=async(label:string)=>{
 const slug=`batch-${process.pid}-${label}`;
 await addCmd({cfg,node,slug,column:'backlog',kind:'meta',assignee:'loom:original',body:'## END STATE\nCLAIM original execution=synthetic'});
 return requireCard(node,cfg,slug);
};
const placement=await fresh('cli');
const moved=await moveCmd({cfg,node,slug:placement.slug,column:'doing',expectColumn:'backlog',expectAssignee:'loom:original'});
assert.equal(moved.membership_cleanup,'deferred');
const list=async()=>{
 const out:any={};
 for(const column of [undefined,'backlog','doing']) out[column??'all']=(await listBoardCardsPartition(node,cfg,'default',{column}))?.filter(c=>c.slug===placement.slug);
 return out;
};
evidence.cases.push({name:'move-list',lists:await list()});
await setCmd({cfg,node,slug:placement.slug,blockStatus:'needs_human',blockReason:'synthetic park',expectAssignee:'loom:original'});
await moveCmd({cfg,node,slug:placement.slug,column:'backlog',expectColumn:'doing',expectAssignee:'loom:original'});
evidence.cases.push({name:'park-list',lists:await list()});
await moveCmd({cfg,node,slug:placement.slug,column:'backlog',expectColumn:'backlog',expectAssignee:'loom:original'});
evidence.cases.push({name:'retry-list',lists:await list()});
evidence.persisted.push(await requireCard(node,cfg,placement.slug));
const bodyCard=await fresh('body');
const batch=node.updateRecords!.bind(node);
let bodyInjected=false;
node.updateRecords=async rows=>{
 if(!bodyInjected){bodyInjected=true;await node.updateRecord({schemaHash:cfg.schemaHashes.card!,keyHash:bodyCard.slug,fields:{body:'## END STATE\nCLAIM new execution=same-owner'},durability:'durable'});}
 return batch(rows);
};
await setCmd({cfg,node,slug:bodyCard.slug,blockStatus:'none',expectAssignee:'loom:original'});
node.updateRecords=batch;
const bodyResult=await requireCard(node,cfg,bodyCard.slug);assert.match(bodyResult.body,/execution=same-owner/);
evidence.cases.push({name:'body-preserved',card:bodyResult});evidence.persisted.push(bodyResult);
for(let index=0;index<8;index++) {
 const old=await fresh(`race-${index}`);
 const target:Card={...old,column:'doing',position:String(990000+index),block_status:'none',block_reason:'',updated_at:new Date().toISOString()};
 const foreign={assignee:'loom:foreign',column:'backlog',tags:['execution:foreign'],body:'## END STATE\nCLAIM foreign execution=new',block_status:'needs_human',block_reason:'foreign hold'};
 const foreignWrite=()=>node.updateRecord({schemaHash:cfg.schemaHashes.card!,keyHash:old.slug,fields:foreign,durability:'durable'});
 let guarded:any;
 if(index===0) {await foreignWrite();guarded=await Promise.allSettled([guardedCardUpdate({node,cfg},target,expected)]);}
 else {
  // Cross preflight first, then race the actual batch request against takeover.
  node.updateRecords=async rows=>{
    const outcomes=await Promise.allSettled([batch(rows),(async()=>{
      await new Promise(resolve=>setTimeout(resolve,[0,1,10,50,100,0,10][index-1]));
      await foreignWrite();
    })()]);
    if(outcomes[1]!.status==='rejected')throw outcomes[1]!.reason;
    if(outcomes[0]!.status==='rejected')throw outcomes[0]!.reason;
  };
  guarded=await Promise.allSettled([guardedCardUpdate({node,cfg},target,expected)]);
  node.updateRecords=batch;
 }
 const now=await requireCard(node,cfg,old.slug);
 for(const [key,value]of Object.entries(foreign))assert.deepEqual((now as any)[key],value,`${index}:${key}`);
 const destination=await node.queryAll({schemaHash:cfg.schemaHashes.board_cards!,fields:['board','slug','column','assignee','tags','block_status','block_reason'],filter:{HashRangeKey:{hash:'default',range:boardCardSk('doing',target.position,old.slug)}}});
 if(guarded[0].status==='rejected')assert.equal(destination.results.length,0,'rejected target remains absent');
 evidence.cases.push({name:`race-${index}`,guarded:guarded.map((r:any)=>({status:r.status,code:r.reason?.code})),card:now,target:destination.results});
 evidence.persisted.push(now);
}
assert(evidence.cases.some((c:any)=>c.name.startsWith('race-') && c.guarded[0].status==='fulfilled'),'at least one batch commits before takeover');
writeFileSync(evidencePath,JSON.stringify(evidence,null,2));
console.log(JSON.stringify({result:'passed',version:evidence.version,cases:evidence.cases.length,persisted:evidence.persisted.length,evidencePath}));
