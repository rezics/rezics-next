import type { PoolClient } from 'pg';
import type { Json } from '../editorial-review/contract.ts';
import type { MergeDependencies } from '../identity-merge/runtime.ts';
import { personMergeEffect } from '../identity-merge/person-effect.ts';
import { MERGE_COST, mergeDigest, MergeConflict, InvalidMerge, type MergeHandler, type MergeItem, type MergeTask, type RecordedItem, type ItemOutcome } from '../identity-merge/contract.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import { RATING_STANDING_CADENCE } from './context.ts';

type Row = Record<string,Json>;
interface Slot { head: Row | null; selection: Row | null }
interface Snapshot { source: Slot; survivor: Slot }
interface Exact { policy: 'exact-rating-grain'; context: string }
const owner = 'rating';
export const RATING_MERGE_NATIVE_INVENTORY_SQL = `
  SELECT principal_id::text AS principal,context FROM access.rating_aggregate_head
  WHERE work=$1 AND target_release IS NULL
    AND (principal_id,context COLLATE "C") > ($2::uuid,$3::text COLLATE "C")
  ORDER BY principal_id,context COLLATE "C" LIMIT $4`;
export const RATING_MERGE_SELECTION_INVENTORY_SQL = `
  SELECT principal_id::text AS principal,context FROM access.rating_merge_selection
  WHERE work=$1
    AND (principal_id,context COLLATE "C") > ($2::uuid,$3::text COLLATE "C")
  ORDER BY principal_id,context COLLATE "C" LIMIT $4`;
export function ratingMergeHandler({ accessPool,graph }: MergeDependencies): MergeHandler<MergeDependencies> {
  const inventory = async (task: { plan: MergeTask['plan'] },after: string | null,limit: number) => {
    // UUID text order matches UUID index order. Empty context precedes every
    // admitted Context, including when its principal is the all-zero UUID.
    const [principal,context] = after?.split('|') ?? ['00000000-0000-0000-0000-000000000000',''];
    const windows = await Promise.all([RATING_MERGE_NATIVE_INVENTORY_SQL,RATING_MERGE_SELECTION_INVENTORY_SQL]
      .map(async sql => (await accessPool.query<{ principal: string; context: string }>(sql,
        [task.plan.source.resource,principal,context,limit+1])).rows.map(row => `${row.principal}|${row.context}`)));
    const compare = (left: string,right: string) => Buffer.compare(Buffer.from(left),Buffer.from(right));
    const frontiers = windows.filter(rows => rows.length === limit+1).map(rows => rows.at(-1)!).sort(compare);
    // A saturated raw window proves coverage only through its last grain.
    // Histories can fill the window with one grain: emit that grain once and
    // seek strictly beyond it, without reading all its retained duplicates.
    const frontier = frontiers[0];
    const keys = [...new Set(windows.flat().filter(key => frontier === undefined || compare(key,frontier) <= 0))].sort(compare);
    const kept = keys.slice(0,limit);
    return { keys: kept,next: frontiers.length > 0 || keys.length > limit ? kept.at(-1)! : null };
  };
  const main = async (work: string) => {
    const rows = (await graph.query(`PREFIX rv: <${RV}> SELECT ?main WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(work)} rv:mainVersion ?main } } LIMIT 2`,4096)).results?.bindings ?? [];
    if (rows.length !== 1 || !rows[0]?.main) throw new MergeConflict('Rating Work Main Version is ambiguous');
    return rows[0].main.value;
  };
  const standing = async (context: string) => (await graph.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.current)} {
    ${iri(context)} rv:contextState rv:Active ; rv:targetGrain rv:MainVersion ; rv:ratingCadence ${iri(RATING_STANDING_CADENCE)}
  } }`,4096)).boolean === true;
  const read = async (client: PoolClient,principal: string,context: string,work: string): Promise<Slot> => {
    const currentMain = await main(work);
    const selection = (await client.query<{ row: Row }>('SELECT to_jsonb(s) AS row FROM access.rating_merge_selection s WHERE context=$1 AND work=$2 AND principal_id=$3 AND main_version=$4 FOR UPDATE',[context,work,principal,currentMain])).rows[0]?.row ?? null;
    const native = (await client.query<{ row: Row }>(`SELECT to_jsonb(h) AS row FROM access.rating_aggregate_head h
      WHERE context=$1 AND work=$2 AND principal_id=$3 AND target_release IS NULL AND main_version=$4 FOR UPDATE`,[context,work,principal,currentMain])).rows;
    if (native.length > 1) throw new MergeConflict('Rating person slot is ambiguous');
    const head = native[0]?.row ?? (selection ? (await client.query<{ row: Row }>(`SELECT to_jsonb(h) AS row
      FROM access.rating_aggregate_head h WHERE context=$1 AND main_version=$2 AND slot=$3`,[context,selection.origin_main_version,selection.origin_slot])).rows[0]?.row ?? null : null);
    return { head,selection };
  };
  const pair = async (client: PoolClient,task: MergeTask,key: string): Promise<Snapshot> => {
    const [principal,context] = key.split('|');
    if (!/^[0-9a-f-]{36}$/.test(principal!) || !/^https:\/\/rezics.com\/id\/[0-9a-f-]{36}$/.test(context!)) throw new InvalidMerge('Rating item key differs');
    return { source: await read(client,principal!,context!,task.plan.source.resource),survivor: await read(client,principal!,context!,task.plan.survivor.resource) };
  };
  const deliver = (task: MergeTask,item: MergeItem,key: string,original?: RecordedItem & { result: ItemOutcome }) =>
    personMergeEffect(accessPool,graph,owner,task,item,key,async client => {
      if ((item.before as unknown as Exact).policy === 'exact-rating-grain') {
        if (original || item.expectedHead !== mergeDigest(item.before)) throw new InvalidMerge('Exact rating snapshot differs');
        return { outcome: 'retained',afterHead: item.expectedHead,after: item.before };
      }
      const saved = item.before as unknown as Snapshot, current = await pair(client,task,item.key), [principal,context] = item.key.split('|');
      if (!saved.source || item.expectedHead !== mergeDigest(saved)) throw new InvalidMerge('Rating snapshot differs');
      let outcome: ItemOutcome['outcome'];
      if (original) {
        const matches = mergeDigest(current) === original.result.afterHead;
        // Remove only the projection this item introduced. An ordinary later
        // survivor vote retains its own graph/Access receipt and always wins.
        if (!saved.survivor.head) await client.query(`DELETE FROM access.rating_merge_selection WHERE context=$1 AND work=$2
          AND principal_id=$3 AND task_key=$4`,[context,task.plan.survivor.resource,principal,task.plan.operation === 'unmerge' ? task.plan.original : '']);
        outcome = matches ? 'moved' : 'ambiguous';
      } else {
        if (mergeDigest(current) !== mergeDigest(saved) || !saved.source.head) return { outcome: 'retained',afterHead: mergeDigest(current),after: current as unknown as Json };
        if (!saved.survivor.head) {
          const rows = (await graph.query(`PREFIX rv: <${RV}> SELECT ?main WHERE { GRAPH ${iri(GRAPHS.current)} {
            ${iri(task.plan.survivor.resource)} rv:mainVersion ?main } } LIMIT 2`,4096)).results?.bindings ?? [];
          if (rows.length !== 1 || !rows[0]?.main) throw new MergeConflict('Survivor Main Version is ambiguous');
          await client.query(`INSERT INTO access.rating_merge_selection(context,work,main_version,principal_id,origin_main_version,origin_slot,task_key)
            VALUES ($1,$2,$3,$4,$5,$6,$7)`,[context,task.plan.survivor.resource,rows[0].main.value,principal,
          saved.source.head.main_version,saved.source.head.slot,task.key]);
        }
        outcome = saved.survivor.head ? 'history' : 'moved';
      }
      const after = await pair(client,task,item.key);
      return { outcome,afterHead: mergeDigest(after),after: after as unknown as Json };
    },original);
  return { owner,version: 'effective-person-vote-v3',references: ['table:access.rating_aggregate_head.work','table:access.rating_merge_selection.work'],
    cost: { page: MERGE_COST.page,callsPerItem: 24,bytesPerItem: MERGE_COST.itemBytes },
    async preview(plan) { const page = await inventory({ plan },null,32); return { owner,count: page.keys.length,complete: page.next === null }; },
    async plan(task,after,limit) {
      const page = await inventory(task,after,limit), client = await accessPool.connect();
      try {
        const items = [];
        for (const key of page.keys) { const context = key.split('|')[1]!;
          const before = await standing(context) ? await pair(client,task,key) : { policy: 'exact-rating-grain',context }; items.push({ key,expectedHead: mergeDigest(before),before: before as unknown as Json }); }
        return { items,next: page.next };
      } finally { client.release(); }
    },apply: (task,item,key) => deliver(task,item,key),compensate: (task,item,key) => deliver(task,item,key,item) };
}
export const mergeHandlerModule = { owner,create: ratingMergeHandler };
