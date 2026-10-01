import type { PoolClient } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { checkEditorialApplication } from '../editorial-review/admission.ts';
import { DATASET, GRAPHS, RV, iri, lit } from '../work/activate.ts';
import { itemCommandKey, mergeDigest, MergeUnavailable, type MergeTask } from './contract.ts';
import { checkedTask } from './journal.ts';

/** Called inside the native effect's Access authority transaction. A valid
 * proposal alone cannot deliver an unretained task, another epoch or different
 * installed owner versions. Current approval policy remains entirely G-865's. */
export async function checkMergeAuthority(client: PoolClient, task: MergeTask, graph: Pick<FusekiClient, 'query'>,
  owner?: string) {
  checkedTask(task);
  const row = (await client.query<MergeTask>(`SELECT task_key AS key,application::text,candidate_digest AS "candidateDigest",
    plan,data_epoch AS "dataEpoch",handlers FROM access.identity_merge_task WHERE task_key=$1`, [task.key])).rows[0];
  if (!row || mergeDigest(row) !== mergeDigest(task)) throw new MergeUnavailable('Native owner task binding differs');
  // Ordered applications bind a native owner's stage before delivery. Current
  // review authority alone cannot redirect a staged permit to another owner,
  // pair, candidate or command. Legacy applications retain their prior port.
  const ordered = (await client.query('SELECT 1 FROM access.editorial_application_command WHERE application=$1 LIMIT 1', [task.application])).rowCount;
  if (ordered) {
    if (!owner || !task.handlers.some(handler => handler.owner === owner) && owner !== 'identity-merge') {
      throw new MergeUnavailable('Native merge owner is not bound');
    }
    const binding = (await client.query<{ action: string; scope: string; request_digest: string }>(`
      SELECT b.action,b.scope,b.request_digest FROM access.editorial_application_command c
      JOIN access.editorial_command_binding b USING(application,position)
      WHERE c.application=$1 AND c.command_key=$2 AND c.candidate_digest=$3
        AND NOT EXISTS (SELECT 1 FROM access.editorial_command_outcome o WHERE o.application=c.application AND o.position=c.position)
        AND NOT EXISTS (SELECT 1 FROM access.editorial_application_command earlier WHERE earlier.application=c.application
          AND earlier.position<c.position AND NOT EXISTS (SELECT 1 FROM access.editorial_command_outcome o
            WHERE o.application=earlier.application AND o.position=earlier.position AND o.outcome->>'outcome'='applied'))`,
    [task.application, itemCommandKey(task.key, owner, '$stage'), task.candidateDigest])).rows[0];
    const expected = mergeOwnerBinding(task, owner);
    if (!binding || binding.action !== expected.action || binding.scope !== expected.scope || binding.request_digest !== expected.digest) {
      throw new MergeUnavailable('Native merge stage authority differs');
    }
  }
  const open = (await graph.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(task.dataEpoch)}
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
  }`, 4096)).boolean;
  if (open !== true) throw new MergeUnavailable('Native owner task epoch is unavailable');
  await checkEditorialApplication(client, task.application, { kind: 'merge',
    operationKey: task.key, candidateDigest: task.candidateDigest }, graph);
}

/** This owner action permits only mechanical reference reconciliation under
 * the retained pair and item CAS; it never grants a person's ordinary writes. */
export function mergeOwnerBinding(task: MergeTask, owner: string) {
  checkedTask(task);
  if (!task.handlers.some(handler => handler.owner === owner) && owner !== 'identity-merge') throw new MergeUnavailable('Unknown merge owner');
  return { action: `identity.merge.${owner}`, scope: `identity:merge:${task.plan.source.resource}`,
    digest: mergeDigest({ task, owner }) };
}
