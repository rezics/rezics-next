import type { Pool, PoolClient } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { controlTransaction } from '../access/topology-control.ts';
import { checkMergeAuthority } from './authority.ts';
import { checkedItem, checkedOutcome, InvalidMerge, itemCommandKey, mergeDigest, MergeConflict,
  type ItemOutcome, type MergeItem, type MergeTask, type RecordedItem } from './contract.ts';

/** Access-native person owners share receipt plumbing, not state semantics.
 * Each callback owns its locks, exact CAS, conflict policy and inverse. */
export async function personMergeEffect(pool: Pool, graph: Pick<FusekiClient,'query'>, owner: string,
  task: MergeTask, item: MergeItem, key: string,
  effect: (client: PoolClient) => Promise<Omit<ItemOutcome,'commandKey'|'receipt'>>,
  original?: RecordedItem & { result: ItemOutcome }): Promise<ItemOutcome> {
  checkedItem(item);
  if (key !== itemCommandKey(task.key,owner,item.key) || task.plan.operation !== (original ? 'unmerge' : 'merge')) throw new InvalidMerge('Person-state command differs');
  const clean = { key: item.key,expectedHead: item.expectedHead,before: item.before }, digest = mergeDigest({ task,item: clean,original: original ?? null });
  return controlTransaction(pool,async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
    const previous = (await client.query<{ request_digest: string; result: ItemOutcome }>(
      'SELECT request_digest,result FROM access.person_state_merge_receipt WHERE command_key=$1',[key])).rows[0];
    if (previous) {
      if (previous.request_digest !== digest) throw new MergeConflict('Person-state receipt differs');
      return checkedOutcome(previous.result,key);
    }
    await checkMergeAuthority(client,task,graph,owner);
    if (original && task.plan.operation === 'unmerge') {
      const retained = (await client.query<{ snapshot_digest: string; result: ItemOutcome }>(`SELECT i.snapshot_digest,r.result
        FROM access.person_state_merge_receipt r JOIN access.identity_merge_item i
          ON i.task_key=r.task_key AND i.owner=r.owner AND i.item_key=r.item_key
        WHERE r.task_key=$1 AND r.owner=$2 AND r.item_key=$3`,[task.plan.original,owner,item.key])).rows[0];
      if (!retained || retained.snapshot_digest !== mergeDigest(clean) || mergeDigest(retained.result) !== mergeDigest(original.result)) throw new InvalidMerge('Compensation is not retained');
    }
    const result = checkedOutcome({ ...await effect(client),commandKey: key,receipt: `urn:rezics:person-state:${key}` },key);
    await client.query(`INSERT INTO access.person_state_merge_receipt(command_key,task_key,owner,item_key,request_digest,result)
      VALUES ($1,$2,$3,$4,$5,$6)`,[key,task.key,owner,item.key,digest,result]);
    return result;
  });
}
