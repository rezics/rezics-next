import { GRAPHS, iri } from './activate.ts';
import { WorkReadMissing, WorkReadUnavailable, type WorkReadSession } from './read-session.ts';

/** Revision anchors prove ownership, never audience. Public provenance has the
 * same current target/source disclosure and final fence as other Work reads.
 * The raw readers remain available to reconciliation inside the owner. */
export async function readPublicMainProvenance<T extends { targetWork: string; sourceWork: string }>(
  session: WorkReadSession, mainVersion: string, revision: string, load: () => Promise<T[]>,
): Promise<T[]> {
  const rows = await session.query(`SELECT ?work WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(mainVersion)} a rv:MainVersion ; rv:work ?work }
    GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(revision)} a rv:RevisionAnchor ; rv:component ${iri(mainVersion)} .
      FILTER NOT EXISTS { ${iri(revision)} a rv:ErasedRevision }
    }
  } LIMIT 2`, 2);
  if (!rows.length) throw new WorkReadMissing('Revision is unavailable');
  if (rows.length !== 1 || !rows[0]?.work) throw new WorkReadUnavailable('Revision owner is ambiguous');
  const work = rows[0].work.value;
  const [target] = await session.summaries([work]);
  if (target?.status !== 'available') throw new WorkReadMissing('Revision is unavailable');
  const relations = await load();
  if (relations.some(relation => relation.targetWork !== work)) {
    throw new WorkReadUnavailable('Provenance owner differs from revision owner');
  }
  const sources = [...new Set(relations.map(relation => relation.sourceWork))];
  const summaries = await session.summaries(sources);
  const visible = new Set(sources.filter((_, index) => summaries[index]?.status === 'available'));
  return relations.filter(relation => visible.has(relation.sourceWork));
}
