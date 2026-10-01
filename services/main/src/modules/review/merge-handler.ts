import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Json } from '../editorial-review/contract.ts';
import type { MergeDependencies } from '../identity-merge/runtime.ts';
import { personMergeEffect } from '../identity-merge/person-effect.ts';
import { MERGE_COST, mergeDigest, MergeConflict, InvalidMerge, type MergeHandler, type MergeTask, type MergeItem, type RecordedItem, type ItemOutcome } from '../identity-merge/contract.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import { reviewVisibleSql } from './store.ts';

type Row = Record<string,Json>;
interface Snapshot { source: Row; survivor: Row | null; sourceSlot: Row | null }
const owner = 'review';
export function reviewMergeHandler({ accessPool,graph }: MergeDependencies): MergeHandler<MergeDependencies> {
  const inventory = async (work: string,after: string | null,limit: number) => (await accessPool.query<{ id: string }>(`
    SELECT id::text FROM access.reader_review WHERE work=$1 AND NOT deleted
      AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3`,[work,after,limit])).rows;
  const read = async (client: PoolClient,task: MergeTask,id: string): Promise<Snapshot | null> => {
    const source = (await client.query<{ row: Row }>('SELECT to_jsonb(r) AS row FROM access.reader_review r WHERE id=$1 FOR UPDATE',[id])).rows[0]?.row;
    if (!source) return null;
    const slots = (await client.query<{ row: Row }>(`SELECT to_jsonb(r) AS row FROM access.reader_review r
      WHERE principal_id=$1 AND context=$2 AND work=ANY($3::text[]) ORDER BY work COLLATE "C" FOR UPDATE`,
    [source.principal_id,source.context,[task.plan.source.resource,task.plan.survivor.resource]])).rows.map(row => row.row);
    return { source,survivor: slots.find(row => row.work === task.plan.survivor.resource && row.id !== id) ?? null,
      sourceSlot: slots.find(row => row.work === task.plan.source.resource && row.id !== id) ?? null };
  };
  const saveRevision = async (client: PoolClient,id: Json) => client.query(`INSERT INTO access.reader_review_revision
    (review_id,revision,acting_subject,rating_observation,rating_revision,rating,language,body,spoiler,started_on,finished_on,deleted)
    SELECT id,revision,acting_subject,rating_observation,rating_revision,rating,language,body,spoiler,started_on,finished_on,deleted
    FROM access.reader_review WHERE id=$1`,[id]);
  const deliver = (task: MergeTask,item: MergeItem,key: string,original?: RecordedItem & { result: ItemOutcome }) =>
    personMergeEffect(accessPool,graph,owner,task,item,key,async client => {
      const saved = item.before as unknown as Snapshot;
      if (!saved.source || saved.source.id !== item.key || saved.source.work !== task.plan.source.resource
        || item.expectedHead !== mergeDigest(saved)) throw new InvalidMerge('Review snapshot differs');
      for (const work of [task.plan.source.resource,task.plan.survivor.resource].sort()) await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['review-slot',saved.source.principal_id,saved.source.context,work])]);
      const current = await read(client,task,item.key), visible = (await client.query(`SELECT 1 FROM access.reader_review r
        WHERE r.id=$1 AND ${reviewVisibleSql}`,[item.key])).rowCount;
      if (!current) {
        return { outcome: original ? 'ambiguous' : 'retained',afterHead: null,after: { policy: 'withdrawn-person-state' } };
      }
      let outcome: ItemOutcome['outcome'];
      if (original) {
        if (!visible || current.sourceSlot || mergeDigest(current) !== original.result.afterHead) outcome = 'ambiguous';
        else {
          await client.query(`UPDATE access.reader_review SET work=$2,main_version=$3,deleted=$4,revision=$5,updated_at=clock_timestamp() WHERE id=$1`,
          [item.key,saved.source.work,saved.source.main_version,saved.source.deleted,randomUUID()]);
          await saveRevision(client,item.key); outcome = 'moved';
        }
      } else {
        if (mergeDigest(current) !== mergeDigest(saved) || !visible) outcome = 'retained';
        else {
          let main = saved.source.main_version;
          if (!saved.survivor) {
            const rows = (await graph.query(`PREFIX rv: <${RV}> SELECT ?main WHERE { GRAPH ${iri(GRAPHS.current)} {
              ${iri(task.plan.survivor.resource)} rv:mainVersion ?main } } LIMIT 2`,4096)).results?.bindings ?? [];
            if (rows.length !== 1 || !rows[0]?.main) throw new MergeConflict('Review survivor is ambiguous');
            main = rows[0].main.value;
          }
          await client.query(`UPDATE access.reader_review SET work=$2,main_version=$3,deleted=$4,revision=$5,updated_at=clock_timestamp() WHERE id=$1`,
          [item.key,saved.survivor ? task.plan.source.resource : task.plan.survivor.resource,main,!!saved.survivor,randomUUID()]);
          await saveRevision(client,item.key); outcome = saved.survivor ? 'history' : 'moved';
        }
      }
      if (outcome !== 'retained' && outcome !== 'ambiguous') for (const work of [task.plan.source.resource,task.plan.survivor.resource]) await client.query(`
        INSERT INTO access.reader_review_collection(context,work) VALUES ($1,$2)
        ON CONFLICT(context,work) DO UPDATE SET revision=gen_random_uuid()`,[saved.source.context,work]);
      const after = await read(client,task,item.key);
      return { outcome,afterHead: mergeDigest(after),after: after as unknown as Json };
    },original);
  return { owner,version: 'person-review-v2',references: ['table:access.reader_review.work'],
    cost: { page: MERGE_COST.page,callsPerItem: 24,bytesPerItem: MERGE_COST.itemBytes },
    async preview(plan) { const rows = await inventory(plan.source.resource,null,33); return { owner,count: Math.min(rows.length,32),complete: rows.length<=32 }; },
    async plan(task,after,limit) {
      const rows = await inventory(task.plan.source.resource,after,limit+1), kept = rows.slice(0,limit), client = await accessPool.connect();
      try {
        const items = [];
        for (const row of kept) { const before = await read(client,task,row.id); if (!before) throw new MergeConflict('Review disappeared'); items.push({ key: row.id,expectedHead: mergeDigest(before),before: before as unknown as Json }); }
        return { items,next: rows.length > limit ? kept.at(-1)!.id : null };
      } finally { client.release(); }
    },apply: (task,item,key) => deliver(task,item,key),compensate: (task,item,key) => deliver(task,item,key,item) };
}
export const mergeHandlerModule = { owner,create: reviewMergeHandler };
