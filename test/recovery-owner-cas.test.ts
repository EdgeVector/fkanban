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

async function fixture(build: string = GUARDED_CARD_BATCH_BUILDS[0]) {
  const cfg: Config = {configVersion:1,nodeUrl:'http://unused.invalid',schemaServiceUrl:'http://unused.invalid',userHash:'synthetic',schemaHashes:{card:'card',board:'board'}};
  const node=fakeNode();
  node.seed({schemaHash:'board',keyHash:'default',fields:boardToFields({slug:'default',title:'test',body:'',columns:[...DEFAULT_COLUMNS],created_at:nowIso(),updated_at:nowIso()})});
  await addCmd({cfg,node,slug:'guard',column:'backlog',kind:'meta',assignee:'loom:original',body:'## END STATE\nSynthetic owner survives.'});
  const card=await requireCard(node,cfg,'guard');
  cfg.schemaHashes.board_cards='board_cards';
  node.nodeVersion=async()=>({handshake:true,build} as any);
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


describe('guarded current-build compatibility', () => {
  const currentBuild = '0.23.3-2588-g24334db75';

  test('current build accepts guarded quarantine and preserves the owner hold and body', async () => {
    const { node, cfg, batches, race } = await fixture(currentBuild);
    const hold = 'claim recovery pending for worker "loom:original": do not work this card until the claim completes';
    node.seed({ schemaHash: 'card', keyHash: 'guard', fields: {
      ...node.rowAt('card', 'guard')!.fields, column: 'doing',
      block_status: 'needs_human', block_reason: hold,
    } });
    race({ body: 'Concurrent CLAIM execution=same-owner' });
    const result = await moveCmd({ cfg, node, slug: 'guard', column: 'backlog',
      expectColumn: 'doing', expectAssignee: 'loom:original' });
    expect(result.membership_cleanup, 'current build accepts guarded quarantine').toBe('deferred');
    expect(node.rowAt('card', 'guard')!.fields.body, 'guarded quarantine preserves the concurrent body')
      .toBe('Concurrent CLAIM execution=same-owner');
    expect(node.rowAt('card', 'guard')!.fields).toMatchObject({
      column: 'backlog', assignee: 'loom:original', block_status: 'needs_human',
      block_reason: hold, body: 'Concurrent CLAIM execution=same-owner',
    });
    expect(batches).toHaveLength(1);
    expect(batches[0]![0]!.fields, 'guarded quarantine omits the execution body').not.toHaveProperty('body');
    expect(batches[0]![0]!.expected, 'guarded quarantine retains the atomic owner comparison')
      .toEqual({ type: 'value', field: 'assignee', value: 'loom:original' });
    expect(batches[0]!.every(row => row.durability === 'durable'),
      'all current-build recovery operations request durable receipts').toBe(true);
    expect(node.writes).toHaveLength(0);
  });

  test('a nearby unproved build refuses before any batch', async () => {
    const { node, cfg, batches } = await fixture('0.23.3-2589-g24334db75');
    await expect(setCmd({ cfg, node, slug: 'guard', blockStatus: 'none', expectAssignee: 'loom:original' }),
      'an unproved exact build refuses').rejects.toMatchObject({ code: 'guarded_batch_unsupported' });
    expect(batches).toHaveLength(0);
    expect(node.writes).toHaveLength(0);
  });

  test('the current build requires a successful handshake', async () => {
    const { node, cfg, batches } = await fixture(currentBuild);
    node.nodeVersion = async () => ({ handshake: false, build: currentBuild } as any);
    await expect(setCmd({ cfg, node, slug: 'guard', blockStatus: 'none', expectAssignee: 'loom:original' }),
      'the current build requires a successful handshake').rejects.toMatchObject({ code: 'guarded_batch_unsupported' });
    expect(batches).toHaveLength(0);
    expect(node.writes).toHaveLength(0);
  });

  test('all schema metadata reads start together before the durable batch', async () => {
    const { node, cfg, batches } = await fixture(currentBuild);
    const get = node.getSchema!;
    const reads: string[] = [];
    let firstRead!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { firstRead = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    node.getSchema = async hash => {
      reads.push(hash);
      firstRead();
      await gate;
      return get(hash);
    };
    const recovery = setCmd({ cfg, node, slug: 'guard', blockStatus: 'none', expectAssignee: 'loom:original' });
    await started;
    try {
      expect(reads, 'all recovery schema reads start before the first result').toEqual(['card', 'board_cards']);
      expect(batches, 'no recovery batch precedes schema metadata').toHaveLength(0);
    } finally {
      release();
      await recovery;
    }
    expect(batches).toHaveLength(1);
  });

  test('a schema metadata error refuses before any batch', async () => {
    const { node, cfg, batches } = await fixture(currentBuild);
    const get = node.getSchema!;
    node.getSchema = async hash => {
      if (hash === 'board_cards') throw new FkanbanError({ code: 'service_timeout', message: 'Synthetic schema timeout.' });
      return get(hash);
    };
    await expect(setCmd({ cfg, node, slug: 'guard', blockStatus: 'none', expectAssignee: 'loom:original' }),
      'schema metadata failure refuses the recovery batch').rejects.toMatchObject({ code: 'service_timeout' });
    expect(batches).toHaveLength(0);
    expect(node.writes).toHaveLength(0);
  });
});
