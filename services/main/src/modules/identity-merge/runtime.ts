import type { Pool } from 'pg';
import type { EditorialRuntime } from '../editorial-review/runtime.ts';
import { EditorialBlocked, EditorialInvalid } from '../editorial-review/contract.ts';
import { workRead } from '../work/read-session.ts';
import { resolveTargets } from '../target/resolve.ts';
import { GRAPHS, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { commandWorkMerge, readMergeIdentityReceipt } from '../work/merge-command.ts';
import { redirectOf } from './resolution.ts';
import { MERGE_COST, MergeUnavailable, type IdentityHeader, type MergeTask } from './contract.ts';
import type { MergePreflightOwner } from './preflight.ts';
import type { MergeTaskRuntime } from './engine.ts';

export interface MergeDependencies { accessPool: Pool; contentPool: Pool; graph: WorkActivationEnvironment['fuseki'] }
export function mergeDependencies(runtime: EditorialRuntime): MergeDependencies {
  const pools = runtime.work.identityMerge;
  if (!pools) throw new EditorialBlocked({ code: 'owner_unavailable' });
  return { ...pools,graph: runtime.work.environment.fuseki };
}
export function mergePreflightOwner(runtime: EditorialRuntime, actingSubject: string): MergePreflightOwner {
  return { redirectOf: redirectOf(runtime.work.environment),
    read: resource => workRead(runtime.work,runtime.request,{ actingSubject },async session => {
      const target = (await resolveTargets(session,[resource],'discussion',() => null))[0]!;
      if (target.base !== 'work') throw new EditorialInvalid('Duplicate merge requires two Works');
      const rows = await session.query(`SELECT ?kind ?value WHERE { GRAPH ${iri(GRAPHS.current)} {
        { ${iri(resource)} <http://www.w3.org/2000/01/rdf-schema#label> ?value . BIND("title" AS ?kind) }
        UNION { ${iri(resource)} <https://schema.org/datePublished> ?value . BIND("date" AS ?kind) }
        UNION { ${iri(resource)} <https://schema.org/identifier> ?value . BIND("identifier" AS ?kind) }
        UNION { ${iri(resource)} <https://schema.org/creator> ?value . BIND("creator" AS ?kind) }
      } } LIMIT 129`,128);
      const header: IdentityHeader = { resource,revision: target.revision,grain: 'work',
        titles: rows.filter(row => row.kind?.value === 'title').map(row => ({ language: row.value!['xml:lang'] ?? 'und',value: row.value!.value })),
        creators: rows.filter(row => row.kind?.value === 'creator' && /^https:\/\/rezics.com\/id\//.test(row.value!.value))
          .map(row => ({ resource: row.value!.value,names: [] })),
        dates: rows.filter(row => row.kind?.value === 'date').map(row => row.value!.value),
        identifiers: rows.filter(row => row.kind?.value === 'identifier').map(row => row.value!.value) };
      return { header,accountControlled: false };
    }) };
}
export function mergeTaskRuntime(runtime: EditorialRuntime): MergeTaskRuntime<MergeDependencies> {
  const dependencies = mergeDependencies(runtime), env = runtime.work.environment, deadline = Date.now() + MERGE_COST.deadlineMs;
  return { dependencies,dataEpoch: env.lineage.dataEpoch,
    // At most two native effects plus their bounded planning fit G-846's
    // 64 graph reads per command. Pending stages resume through that kernel.
    itemsPerRun: 2,
    identityReceipt: task => readMergeIdentityReceipt(env,task),
    begin: async task => { await commandWorkMerge(env,dependencies.accessPool,task); },
    async finish(task: MergeTask,commandKey: string) {
      const receipt = await readMergeIdentityReceipt(env,task);
      if (!receipt) throw new MergeUnavailable('Identity effect is unavailable');
      const rows = (await dependencies.accessPool.query<{ outcome: string; count: string }>(`SELECT outcome,count(*)::text AS count
        FROM access.identity_merge_item_outcome WHERE task_key=$1 GROUP BY outcome`,[task.key])).rows;
      return { receipt,commandKey,result: { operation: task.plan.operation,source: task.plan.source.resource,
        survivor: task.plan.survivor.resource,outcomes: Object.fromEntries(rows.map(row => [row.outcome,Number(row.count)])) } };
    },
    checkDeadline() { if (Date.now() >= deadline) throw new MergeUnavailable('Merge delivery deadline exceeded'); },
  };
}
