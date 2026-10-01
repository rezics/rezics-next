import type { PoolClient } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { checkEditorialApplication } from '../editorial-review/admission.ts';
import { DATASET, GRAPHS, RV, iri, lit } from '../work/activate.ts';
import { mergeDigest, MergeUnavailable, type MergeTask } from './contract.ts';
import { checkedTask } from './journal.ts';

/** Called inside the native effect's Access authority transaction. A valid
 * proposal alone cannot deliver an unretained task, another epoch or different
 * installed owner versions. Current approval policy remains entirely G-865's. */
export async function checkMergeAuthority(client: PoolClient, task: MergeTask, graph: Pick<FusekiClient, 'query'>) {
  checkedTask(task);
  const row = (await client.query<MergeTask>(`SELECT task_key AS key,application::text,candidate_digest AS "candidateDigest",
    plan,data_epoch AS "dataEpoch",handlers FROM access.identity_merge_task WHERE task_key=$1`, [task.key])).rows[0];
  if (!row || mergeDigest(row) !== mergeDigest(task)) throw new MergeUnavailable('Native owner task binding differs');
  const open = (await graph.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(task.dataEpoch)}
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
  }`, 4096)).boolean;
  if (open !== true) throw new MergeUnavailable('Native owner task epoch is unavailable');
  await checkEditorialApplication(client, task.application, { kind: 'merge',
    operationKey: task.key, candidateDigest: task.candidateDigest }, graph);
}
