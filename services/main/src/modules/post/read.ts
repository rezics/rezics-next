import { GRAPHS, iri } from '../work/activate.ts';
import { WorkReadMissing, WorkReadMoved, WorkReadUnavailable, publicWork, unerased,
  type WorkReadSession } from '../work/read-session.ts';
import { postBookPlacement, publicPost } from './patterns.ts';

export const POST_READ_COST = { graphCalls: 6, ownGraphCalls: 1, accessCalls: 10, graphRows: 25, labels: 24,
  placements: 8 } as const;

/** The Books that use the Post, each with the Post's occurrence there: only Books this reader may read,
 * in Book then occurrence order, so a client picks one without guessing. A Post may sit in several Books
 * and twice in one; `truncated` says the list stopped at the bound. */
async function readPlacements(session: WorkReadSession, post: string) {
  const rows = await session.query(`SELECT DISTINCT ?book ?occurrence ?public WHERE {
    ${postBookPlacement(iri(post), '?book', '?bookMain', '?occurrence')}
    ${unerased('?book')}
    BIND(EXISTS { ${publicWork('?book', '?bookMain')} } AS ?public)
  } ORDER BY STR(?book) STR(?occurrence) LIMIT ${POST_READ_COST.placements * 2 + 1}`,
  POST_READ_COST.placements * 2 + 1);
  const readable = new Map<string, boolean>();
  const may = async (book: string, isPublic: boolean) => {
    if (isPublic) return true;
    if (!readable.has(book)) {
      readable.set(book, !!session.principal && !!session.options.actingSubject
        && await session.deps.access.canReadWork(session.principal, session.options.actingSubject, book));
    }
    return readable.get(book)!;
  };
  const placements: { book: string; occurrence: string }[] = [];
  let truncated = rows.length === POST_READ_COST.placements * 2 + 1;
  for (const row of rows) {
    if (!row.book || !row.occurrence) throw new WorkReadUnavailable('Post placement is incomplete');
    if (!await may(row.book.value, row.public?.value === 'true')) continue;
    if (placements.length === POST_READ_COST.placements) { truncated = true; break; }
    placements.push({ book: row.book.value, occurrence: row.occurrence.value });
  }
  return { placements, truncated };
}

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
  const { placements, truncated } = await readPlacements(session, post);
  if (!isPublic && !await allowed()) throw new WorkReadMoved('Post custody changed');
  return { profile: 'post-read-v2' as const, id: post, revision: rows[0]!.head!.value,
    publisher: rows[0]!.publisher!.value, title, labels, placements, placementsTruncated: truncated,
    disclosure: isPublic ? 'public' as const : 'restricted' as const, sourcePosition: session.position };
}
