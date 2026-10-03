import { expect,test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { followsMergeHandler } from '../src/modules/follows/merge-handler.ts';
import { itemCommandKey,mergeDigest,MergeUnavailable,type ItemOutcome,type RecordedItem } from '../src/modules/identity-merge/contract.ts';
import { resource,task } from './g-836-fixture.ts';

function fixture(revoke = false) {
  const wanted = { ...task(),handlers: [{ owner: 'follows',version: 'person-slot-v1' }] };
  const legacy = { principal_id: randomUUID(),target: wanted.plan.source.resource,kind: 'work',
    acting_subject: resource(9),following: true,revision: randomUUID() };
  const item = { key: legacy.principal_id,expectedHead: legacy.revision,before: { source: legacy,survivor: null } };
  const values = new Map([[legacy.target,{ ...legacy,level: 'all',source: 'explicit',pin_position: null }]]);
  const receipts = new Map<string,{ task_key: string; request_digest: string; result: ItemOutcome }>();
  let transaction = false,active = true,graphReads = 0;
  const client = { release() {},async query(sql: string,args: unknown[] = []) {
    if (sql.startsWith('BEGIN')) { transaction = true; return { rows: [] }; }
    if (sql==='COMMIT' || sql==='ROLLBACK') { transaction = false; return { rows: [] }; }
    if (sql.includes('access.recovery_fence')) return { rows: [{ open: true,generation: '1' }] };
    if (sql==='SELECT active') return { rows: [{ active }] };
    if (sql.includes('JOIN access.identity_merge_item')) return { rows: [{ result: [...receipts.values()][0]!.result,
      snapshot_digest: mergeDigest(item) }] };
    if (sql.includes('SELECT task_key,request_digest,result')) return { rows: receipts.has(String(args[0])) ? [receipts.get(String(args[0]))] : [] };
    if (sql.includes('FROM access.follow_inventory')) return { rows: [{}],rowCount: 1 };
    if (sql.includes('SELECT principal_id::text,target')) return { rows: [...values.values()].map(row => ({ ...row })) };
    if (sql.includes('INSERT INTO access.follow (')) {
      const [principal_id,target,kind,acting_subject,following,revision,level,source,pin_position] = args;
      values.set(String(target),{ principal_id,target,kind,acting_subject,following,revision,level,source,pin_position } as typeof values extends Map<string,infer Row> ? Row : never);
    }
    if (sql.includes('INSERT INTO access.follow_merge_receipt')) receipts.set(String(args[0]),{
      task_key: String(args[1]),request_digest: String(args[3]),result: JSON.parse(String(args[4])) });
    return { rows: [] };
  } };
  const graph = { query: async () => {
    expect(transaction).toBe(false);
    graphReads++;
    if (revoke) active = false;
    return { boolean: true };
  } };
  const dependencies = { accessPool: { connect: async () => client } as unknown as Pool,graph: graph as never,
    authority: async (connection,_task,prepared) => {
      if (!(await connection.query<{ active: boolean }>('SELECT active')).rows[0]!.active) throw new MergeUnavailable('authority revoked');
      if (!(await prepared.query('ASK public source',4096)).boolean) throw new MergeUnavailable('source hidden');
      return [];
    } } satisfies Parameters<typeof followsMergeHandler>[0];
  const handler = followsMergeHandler(dependencies);
  return { handler,dependencies,wanted,item,values,graphReads: () => graphReads };
}

test('G-938 legacy follow journals materialize defaults, compensate them, and replay without graph I/O', async () => {
  const f = fixture();
  const key = itemCommandKey(f.wanted.key,'follows',f.item.key);
  const result = await f.handler.apply(f.wanted,f.item,key,f.dependencies);
  expect(result.outcome).toBe('moved');
  expect(f.values.get(f.wanted.plan.survivor.resource)).toMatchObject({ following: true,level: 'all',source: 'explicit',pin_position: null });
  expect(await f.handler.apply(f.wanted,f.item,key,f.dependencies)).toEqual(result);
  expect(f.graphReads()).toBe(1);
  const undo = { ...task('unmerge',f.wanted),handlers: f.wanted.handlers };
  const recorded = { ...f.item,owner: 'follows',result } as RecordedItem & { result: ItemOutcome };
  expect((await f.handler.compensate(undo,recorded,itemCommandKey(undo.key,'follows',f.item.key),f.dependencies)).outcome).toBe('moved');
  expect(f.values.get(f.wanted.plan.source.resource)).toMatchObject({ following: true,level: 'all',source: 'explicit',pin_position: null });
  expect(f.values.get(f.wanted.plan.survivor.resource)?.following).toBe(false);
});
test('G-938 live SQL authority revoked during graph preflight prevents the native follow effect', async () => {
  const f = fixture(true);
  await expect(f.handler.apply(f.wanted,f.item,itemCommandKey(f.wanted.key,'follows',f.item.key),f.dependencies)).rejects.toThrow('authority revoked');
  expect(f.values.get(f.wanted.plan.source.resource)?.following).toBe(true);
  expect(f.values.has(f.wanted.plan.survivor.resource)).toBe(false);
});
