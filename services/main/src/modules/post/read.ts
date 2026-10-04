import { GRAPHS, iri } from '../work/activate.ts';
import { WorkReadMissing, WorkReadMoved, WorkReadUnavailable, unerased,
  type WorkReadSession } from '../work/read-session.ts';
import { publicPost } from './patterns.ts';

export const POST_READ_COST = { graphCalls: 5, ownGraphCalls: 1, accessCalls: 2, graphRows: 25, labels: 24 } as const;

/** Custody and public text admission belong to the Post, never to a placing Book. */
export async function readPost(session: WorkReadSession, post: string) {
  const allowed = async () => !!session.principal && !!session.options.actingSubject
    && await session.deps.access.canReadWork(session.principal, session.options.actingSubject, post);
  const privateAdmission = await allowed();
  const rows = await session.query(`SELECT ?head ?publisher ?label ?public WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(post)} a rv:Post ; rv:head ?head ;
      rv:publisher ?publisher ; rdfs:label ?label . }
    ${unerased(iri(post))}
    BIND(EXISTS { ${publicPost(iri(post))} } AS ?public)
  } LIMIT ${POST_READ_COST.graphRows}`, POST_READ_COST.graphRows);
  if (!rows.length) throw new WorkReadMissing('Post is unavailable');
  if (rows.length > POST_READ_COST.labels || rows.some(row => !row.head || !row.publisher || !row.label
    || row.head.value !== rows[0]!.head!.value || row.publisher.value !== rows[0]!.publisher!.value)) {
    throw new WorkReadUnavailable('Post labels or head exceed the read contract');
  }
  const isPublic = rows[0]!.public?.value === 'true';
  if (!isPublic && !privateAdmission) throw new WorkReadMissing('Post is unavailable');
  const labels = rows.map(row => ({ value: row.label!.value, language: row.label!['xml:lang'] ?? 'und' }));
  const title = labels.find(label => label.language.toLowerCase() === session.options.language?.toLowerCase())
    ?? labels.find(label => label.language === 'en') ?? labels[0]!;
  if (!isPublic && !await allowed()) throw new WorkReadMoved('Post custody changed');
  return { profile: 'post-read-v1' as const, id: post, revision: rows[0]!.head!.value,
    publisher: rows[0]!.publisher!.value, title, labels,
    disclosure: isPublic ? 'public' as const : 'restricted' as const, sourcePosition: session.position };
}
