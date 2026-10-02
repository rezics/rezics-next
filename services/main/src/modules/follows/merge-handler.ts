import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { t } from 'elysia';
import { Value } from 'typebox/value';
import type { Static } from 'typebox';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { controlTransaction } from '../access/topology-control.ts';
import { canonicalCandidate } from '../editorial-review/contract.ts';
import { checkMergeAuthority } from '../identity-merge/authority.ts';
import { checkedItem, checkedOutcome, InvalidMerge, itemCommandKey, MERGE_COST, mergeDigest,
  MergeConflict, type IdentityPlan, type ItemOutcome, type MergeHandler, type MergeItem,
  type MergeTask, type RecordedItem } from '../identity-merge/contract.ts';
import { checkedTask } from '../identity-merge/journal.ts';
import { targetRef } from '../target/contract.ts';
import { followKind, followLevel, followSource } from './contract.ts';

export interface FollowsMergeDependencies { accessPool: Pool; graph: Pick<FusekiClient, 'query'> }
const uuid = t.String({ pattern: '^[0-9a-f-]{36}$' });
const rowSchema = t.Object({ principal_id: uuid, target: targetRef, acting_subject: targetRef,
  kind: followKind, level: followLevel, source: followSource, pin_position: t.Nullable(t.Integer()),
  following: t.Boolean(), revision: uuid }, { additionalProperties: false });
type Row = Static<typeof rowSchema>;
const snapshotSchema = t.Object({ source: rowSchema, survivor: t.Nullable(rowSchema) }, { additionalProperties: false });
type Snapshot = Static<typeof snapshotSchema>;
const owner = 'follows';
const columns = 'principal_id::text,target,kind,acting_subject,following,revision::text,level,source,pin_position';
const json = (value: unknown) => canonicalCandidate(value).candidate;

function snapshot(source: Row, survivor: Row | null): MergeItem {
  return checkedItem({ key: source.principal_id, expectedHead: source.revision, before: json({ source, survivor }) });
}
function before(task: MergeTask, item: MergeItem): Snapshot {
  checkedTask(task); checkedItem(item);
  if (!Value.Check(snapshotSchema, item.before) || item.before.source.principal_id !== item.key
    || item.before.source.target !== task.plan.source.resource || !item.before.source.following
    || item.before.source.revision !== item.expectedHead || item.before.survivor
      && (item.before.survivor.principal_id !== item.key || item.before.survivor.target !== task.plan.survivor.resource
        || item.before.survivor.kind !== item.before.source.kind)) throw new InvalidMerge('Invalid follow merge item');
  return item.before;
}
async function read(client: PoolClient, principal: string, source: string, survivor: string): Promise<Snapshot> {
  const rows = (await client.query<Row>(`SELECT ${columns} FROM access.follow
    WHERE principal_id=$1 AND target=ANY($2::text[]) ORDER BY target COLLATE "C" FOR UPDATE`,
  [principal, [source, survivor]])).rows;
  return { source: rows.find(row => row.target === source)!, survivor: rows.find(row => row.target === survivor) ?? null };
}
async function put(client: PoolClient, row: Row) {
  await client.query(`INSERT INTO access.follow (principal_id,target,kind,acting_subject,following,revision,level,source,pin_position)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (principal_id,target) DO UPDATE SET
      kind=EXCLUDED.kind,acting_subject=EXCLUDED.acting_subject,following=EXCLUDED.following,revision=EXCLUDED.revision,
      level=EXCLUDED.level,source=EXCLUDED.source,pin_position=EXCLUDED.pin_position`,
  [row.principal_id,row.target,row.kind,row.acting_subject,row.following,row.revision,row.level,row.source,row.pin_position]);
}

/** The existing follow inventory lock serializes this native command with
 * ordinary follows. A survivor slot, including an explicit unfollow, wins;
 * source-only follows move. Source rows retain a tombstone and fresh revision.
 * Unmerge checks both exact post-merge slots and leaves later edits ambiguous. */
export function followsMergeHandler({ accessPool, graph }: FollowsMergeDependencies): MergeHandler<FollowsMergeDependencies> {
  const inventory = async (plan: IdentityPlan, after: string | null, limit: number) =>
    (await accessPool.query<Row>(`SELECT ${columns} FROM access.follow
      WHERE target=$1 AND following AND ($2::uuid IS NULL OR principal_id > $2::uuid)
      ORDER BY principal_id LIMIT $3`, [plan.source.resource, after, limit])).rows;
  const deliver = async (task: MergeTask, item: MergeItem, key: string,
    original?: RecordedItem & { result: ItemOutcome }): Promise<ItemOutcome> => {
    if (key !== itemCommandKey(task.key, owner, item.key)) throw new InvalidMerge('Follow command key differs');
    checkedTask(task); checkedItem(item);
    const cleanItem = { key: item.key, expectedHead: item.expectedHead, before: item.before };
    const digest = mergeDigest({ task, item: cleanItem, original: original ?? null });
    return controlTransaction(accessPool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
      const old = (await client.query<{ task_key: string; request_digest: string; result: ItemOutcome }>(
        'SELECT task_key,request_digest,result FROM access.follow_merge_receipt WHERE command_key=$1', [key])).rows[0];
      if (old) {
        if (old.task_key !== task.key || old.request_digest !== digest) throw new MergeConflict('Follow receipt differs');
        return checkedOutcome(old.result, key);
      }
      await checkMergeAuthority(client, task, graph, owner);
      const saved = before(task, item);
      if (task.plan.operation !== (original ? 'unmerge' : 'merge')) throw new InvalidMerge('Follow operation differs');
      if (original && task.plan.operation === 'unmerge') {
        const retained = (await client.query<{ result: ItemOutcome; snapshot_digest: string }>(`
          SELECT r.result,i.snapshot_digest FROM access.follow_merge_receipt r
          JOIN access.identity_merge_item i ON i.task_key=r.task_key AND i.owner='follows' AND i.item_key=r.principal_id::text
          WHERE r.task_key=$1 AND r.principal_id=$2 AND r.command_key=$3`,
        [task.plan.original, item.key, itemCommandKey(task.plan.original, owner, item.key)])).rows[0];
        if (!retained || retained.snapshot_digest !== mergeDigest(cleanItem)
          || mergeDigest(retained.result) !== mergeDigest(original.result)) throw new InvalidMerge('Follow compensation is not retained');
      }
      const inventoryPresent = (await client.query('SELECT 1 FROM access.follow_inventory WHERE principal_id=$1 FOR UPDATE', [item.key])).rowCount;
      const current = await read(client, item.key, task.plan.source.resource, task.plan.survivor.resource);
      let next: Snapshot | null = null;
      let outcome: ItemOutcome['outcome'];
      if (original) {
        const after = original.result.after;
        if (original.owner !== owner || original.key !== item.key || !Value.Check(snapshotSchema, after)
          || original.result.afterHead !== mergeDigest(after)) throw new InvalidMerge('Invalid follow compensation receipt');
        if (!inventoryPresent || !current.source || mergeDigest(current) !== original.result.afterHead) outcome = 'ambiguous';
        else {
          next = { source: { ...saved.source, revision: randomUUID() }, survivor: saved.survivor
            ? { ...saved.survivor, revision: randomUUID() }
            : { ...after.survivor!, following: false, revision: randomUUID() } };
          outcome = 'moved';
        }
      } else {
        if (!inventoryPresent || !current.source || mergeDigest(current) !== mergeDigest(saved)) outcome = 'retained';
        else {
          next = { source: { ...saved.source, following: false, revision: randomUUID() },
            survivor: saved.survivor ?? { ...saved.source, target: task.plan.survivor.resource, revision: randomUUID() } };
          outcome = saved.survivor ? 'history' : 'moved';
        }
      }
      if (next) {
        await put(client, next.source); await put(client, next.survivor!);
      }
      const result = checkedOutcome({ outcome, commandKey: key, receipt: `urn:rezics:follows:${key}`,
        afterHead: next ? mergeDigest(next) : null, after: next ? json(next) : { reason: 'follow-slots-edited' } }, key);
      await client.query(`INSERT INTO access.follow_merge_receipt
        (command_key,task_key,principal_id,request_digest,result) VALUES ($1,$2,$3,$4,$5)`,
      [key, task.key, item.key, digest, JSON.stringify(result)]);
      return result;
    });
  };
  return { owner, version: 'person-slot-v2', references: ['table:access.follow.target'],
    cost: { page: MERGE_COST.page, callsPerItem: 128, bytesPerItem: MERGE_COST.itemBytes },
    async preview(plan) {
      const rows = await inventory(plan, null, MERGE_COST.page + 1);
      return { owner, count: Math.min(rows.length, MERGE_COST.page), complete: rows.length <= MERGE_COST.page };
    },
    async plan(task, after, limit) {
      checkedTask(task);
      if (task.plan.operation !== 'merge' || limit < 1 || limit > MERGE_COST.page) throw new InvalidMerge('Invalid follow inventory page');
      const rows = await inventory(task.plan, after, limit + 1), kept = rows.slice(0, limit);
      const survivors = (await accessPool.query<Row>(`SELECT ${columns} FROM access.follow
        WHERE target=$1 AND principal_id=ANY($2::uuid[])`, [task.plan.survivor.resource, kept.map(row => row.principal_id)])).rows;
      return { items: kept.map(row => snapshot(row, survivors.find(survivor => survivor.principal_id === row.principal_id) ?? null)),
        next: rows.length > limit ? kept.at(-1)!.principal_id : null };
    },
    apply: (task, item, key) => deliver(task, item, key),
    compensate: (task, item, key) => deliver(task, item, key, item),
  };
}
export const mergeHandlerModule = { owner, create: followsMergeHandler };
