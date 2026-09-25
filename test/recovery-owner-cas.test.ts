import { describe, expect, test } from 'bun:test';
import { fakeNode } from './fake-node.ts';
import { type Config } from '../src/config.ts';
import { FkanbanError } from '../src/client.ts';
import { addCmd } from '../src/commands/add.ts';
import { setCmd } from '../src/commands/set.ts';
import { moveCmd } from '../src/commands/move.ts';
import { boardToFields, nowIso, requireCard, cardToFields } from '../src/record.ts';
import { boardCardFieldsFromCard } from '../src/board-cards.ts';
import { DEFAULT_COLUMNS } from '../src/schemas.ts';
import { GUARDED_CARD_BATCH_BUILDS } from '../src/guarded-card-update.ts';

async function fixture() {
  const cfg: Config = {configVersion:1,nodeUrl:'http://unused.invalid',schemaServiceUrl:'http://unused.invalid',userHash:'synthetic',schemaHashes:{card:'card',board:'board'}};
  const node=fakeNode();
  node.seed({schemaHash:'board',keyHash:'default',fields:boardToFields({slug:'default',title:'test',body:'',columns:[...DEFAULT_COLUMNS],created_at:nowIso(),updated_at:nowIso()})});
  await addCmd({cfg,node,slug:'guard',column:'backlog',kind:'meta',assignee:'loom:original',body:'## END STATE\nSynthetic owner survives.'});
  const card=await requireCard(node,cfg,'guard');
  cfg.schemaHashes.board_cards='board_cards';
  node.nodeVersion=async()=>({handshake:true,build:GUARDED_CARD_BATCH_BUILDS[0]} as any);
  node.getSchema=async hash=>({name:hash,descriptive_name:'',owner_app_id:'',schema_type:'',key:{hash_field:hash==='card'?'slug':'board',range_field:hash==='card'?null:'sk'},fields:Object.keys(hash==='card'?cardToFields(card):boardCardFieldsFromCard(card))});
  let race: Record<string,unknown>|undefined;
  const batches: Parameters<NonNullable<typeof node.updateRecords>>[0][]=[];
  node.updateRecords=async rows=>{
    batches.push(rows);
    if(race) node.seed({schemaHash:'card',keyHash:'guard',fields:{...node.rowAt('card','guard')!.fields,...race}});
    for(const row of rows) {
      if(row.expected?.type==='value' && node.rowAt(row.schemaHash,row.keyHash!)?.fields[row.expected.field]!==row.expected.value) throw new FkanbanError({code:'cas_conflict',message:'owner changed'});
    }
    for(const row of rows) node.seed({schemaHash:row.schemaHash,keyHash:row.keyHash!,rangeKey:row.rangeKey,fields:{...node.rowAt(row.schemaHash,row.keyHash!,row.rangeKey)?.fields,...row.fields}});
  };
  node.writes.length=0;
  return {node,cfg,batches,race:(fields:Record<string,unknown>)=>{race=fields;}};
}
describe('atomic recovery owner guard',()=>{
  test('set submits one durable batch, preserves body and owner, performs no later writes',async()=>{
    const {node,cfg,batches,race}=await fixture();race({body:'Concurrent CLAIM execution=new'});
    const result=await setCmd({cfg,node,slug:'guard',blockStatus:'none',expectAssignee:'loom:original'});
    expect(result.membership_cleanup).toBe('deferred');
    expect(batches).toHaveLength(1);
    expect(batches[0]![0]!.expected).toEqual({type:'value',field:'assignee',value:'loom:original'});
    expect(batches[0]!.every(r=>r.durability==='durable')).toBe(true);
    expect(batches[0]![0]!.fields).not.toHaveProperty('body');
    expect(node.rowAt('card','guard')!.fields.body).toBe('Concurrent CLAIM execution=new');
    expect(node.writes).toHaveLength(0);
  });
  test('move creates absent target, retains owner, and defers every delete',async()=>{
    const {node,cfg,batches}=await fixture();
    const result=await moveCmd({cfg,node,slug:'guard',column:'doing',expectColumn:'backlog',expectAssignee:'loom:original'});
    expect(result.membership_cleanup).toBe('deferred');
    expect(node.rowAt('card','guard')!.fields.assignee).toBe('loom:original');
    expect(node.rowAt('card','guard')!.fields.column).toBe('doing');
    expect(batches).toHaveLength(1);expect(batches[0]).toHaveLength(2);
    const [card,board]=batches[0]!;
    for(const key of Object.keys(card!.fields)) if(key in board!.fields) expect(card!.fields[key]).toEqual(board!.fields[key]);
    expect(node.writes).toHaveLength(0);
  });
  for(const verb of ['set','move']) test(`${verb} rejects foreign owner atomically with no fallback`,async()=>{
    const {node,cfg,batches,race}=await fixture();race({assignee:'loom:foreign',tags:['execution:new'],body:'foreign execution',block_status:'needs_human'});
    const promise=verb==='set'?setCmd({cfg,node,slug:'guard',blockStatus:'none',expectAssignee:'loom:original'}):moveCmd({cfg,node,slug:'guard',column:'doing',expectColumn:'backlog',expectAssignee:'loom:original'});
    await expect(promise).rejects.toMatchObject({code:'cas_conflict'});
    expect(batches).toHaveLength(1);expect(node.writes).toHaveLength(0);
    expect(node.rowAt('card','guard')!.fields).toMatchObject({assignee:'loom:foreign',tags:['execution:new'],body:'foreign execution',column:'backlog',block_status:'needs_human'});
  });
  test('unknown build and absent batch fail before writes',async()=>{
    const {node,cfg,batches}=await fixture();node.nodeVersion=async()=>({handshake:true,build:'future'} as any);
    await expect(setCmd({cfg,node,slug:'guard',blockStatus:'none',expectAssignee:'loom:original'})).rejects.toMatchObject({code:'guarded_batch_unsupported'});
    expect(batches).toHaveLength(0);expect(node.writes).toHaveLength(0);
  });
  test('legacy undeclared optional fields refuse before any batch',async()=>{
    const {node,cfg,batches}=await fixture();const get=node.getSchema!;
    node.getSchema=async hash=>({...await get(hash),fields:(await get(hash)).fields.filter(f=>f!=='surfaces')});
    await expect(setCmd({cfg,node,slug:'guard',blockStatus:'none',expectAssignee:'loom:original'})).rejects.toMatchObject({code:'guarded_schema_unsupported'});
    expect(batches).toHaveLength(0);expect(node.writes).toHaveLength(0);
  });
  test('guard rejects broad moves and metadata edits',async()=>{
    const {node,cfg,batches}=await fixture();
    for(const changes of [{expectAssignee:''},{force:true},{column:'done'},{expectColumn:undefined}]) {
      await expect(moveCmd({cfg,node,slug:'guard',column:'doing',expectColumn:'backlog',expectAssignee:'loom:original',...changes})).rejects.toMatchObject({code:'guarded_move_scope'});
    }
    await expect(moveCmd({cfg,node,slug:'guard',column:'doing',expectColumn:'backlog',expectAssignee:'loom:original',worker:'foreign'})).rejects.toMatchObject({code:'guarded_owner_change'});
    await expect(setCmd({cfg,node,slug:'guard',title:'new',expectAssignee:'loom:original'})).rejects.toMatchObject({code:'guarded_set_scope'});
    expect(batches).toHaveLength(0);expect(node.writes).toHaveLength(0);
  });
});
