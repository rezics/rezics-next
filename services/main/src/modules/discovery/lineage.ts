import { GRAPHS, iri, lit } from '../work/activate.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';

/** Restore resets sequence to zero while retaining revision anchors in prior epochs.
 * Rank the retained lineage explicitly so restored Works remain browsable. */
export async function readEpochOrder(session: WorkReadSession): Promise<string> {
  const rows = await session.query(`SELECT ?epoch ?prior WHERE { GRAPH ${iri(GRAPHS.control)} {
    ?cutover a rv:RestoreCutover ; rv:dataEpoch ?epoch ; rv:priorDataEpoch ?prior . } } LIMIT 33`, 32);
  const prior = new Map<string, string>();
  for (const row of rows) {
    if (!row.epoch || !row.prior || (prior.has(row.epoch.value) && prior.get(row.epoch.value) !== row.prior.value)) {
      throw new WorkReadUnavailable('Restore lineage is ambiguous');
    }
    prior.set(row.epoch.value, row.prior.value);
  }
  const epochs: string[] = [];
  let next: string | undefined = session.position.dataEpoch;
  while (next) {
    if (epochs.includes(next)) throw new WorkReadUnavailable('Restore lineage contains a cycle');
    epochs.push(next);
    next = prior.get(next);
  }
  return `VALUES (?revisionEpoch ?epochOrder) { ${epochs.map((epoch, order) => `(${lit(epoch)} ${order})`).join(' ')} }`;
}
