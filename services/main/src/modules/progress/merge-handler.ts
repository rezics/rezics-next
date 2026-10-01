import type { Json } from '../editorial-review/contract.ts';
import type { MergeDependencies } from '../identity-merge/runtime.ts';
import { personMergeEffect } from '../identity-merge/person-effect.ts';
import { MERGE_COST, mergeDigest, InvalidMerge, type MergeHandler } from '../identity-merge/contract.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';

/** Progress belongs to an exact occurrence and selection, not a Work slot.
 * Keep those independent records; the route resolves only the library Work. */
export function progressMergeHandler(dependencies: MergeDependencies): MergeHandler<MergeDependencies> {
  const { accessPool,contentPool,graph } = dependencies, owner = 'progress';
  const inventory = async (work: string,after: string | null,limit: number) => {
    const rows = (await graph.query(`PREFIX rv: <${RV}> SELECT ?structure WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(work)} rv:mainVersion ?main . ?structure a rv:Structure ; rv:structureOf ?main ; rv:structureProfile rv:BookComposition
    } } LIMIT 2`,4096)).results?.bindings ?? [];
    if (rows.length > 1) throw new InvalidMerge('Book progress owner is ambiguous');
    if (!rows[0]?.structure) return [];
    return (await contentPool.query<{ key: string; version: string; row: Json }>(`SELECT lpad(merge_inventory_id::text,20,'0') AS key,
      version::text,to_jsonb(p)-'merge_inventory_id' AS row FROM structure.progress p WHERE structure=$1
      AND ($2::bigint IS NULL OR merge_inventory_id>$2::bigint) ORDER BY merge_inventory_id LIMIT $3`,[rows[0].structure.value,after,limit])).rows;
  };
  return { owner,version: 'exact-occurrence-retained-v1',references: ['table:structure.progress.structure'],
    cost: { page: MERGE_COST.page,callsPerItem: 8,bytesPerItem: MERGE_COST.itemBytes },
    async preview(plan) { const rows = await inventory(plan.source.resource,null,33); return { owner,count: Math.min(rows.length,32),complete: rows.length<=32 }; },
    async plan(task,after,limit) { const rows = await inventory(task.plan.source.resource,after,limit+1), kept = rows.slice(0,limit);
      return { items: kept.map(row => ({ key: row.key,expectedHead: row.version,before: row.row })),next: rows.length>limit ? kept.at(-1)!.key : null }; },
    apply: (task,item,key) => personMergeEffect(accessPool,graph,owner,task,item,key,async () =>
      ({ outcome: 'retained',afterHead: item.expectedHead,after: { policy: 'exact-occurrence',snapshotDigest: mergeDigest(item.before) } })),
    compensate: () => Promise.reject(new InvalidMerge('Retained progress never enters compensation')) };
}
export const mergeHandlerModule = { owner: 'progress',create: progressMergeHandler };
