import type { Static } from 'typebox';
import { namedDiscoveryCredits } from '../discovery/credits.ts';
import { shelfWorks } from '../profiles/read.ts';
import { searchPageRatings } from '../search/ratings.ts';
import { readAuthorNames, sourceReportedAuthorWorks, sourceReportedCredits } from '../source/author-name-read.ts';
import { SourceIntakeUnavailable } from '../source/intake.ts';
import { GRAPHS, WORK_SEMANTIC_TYPES, iri, lit } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, publicWork, WorkReadInvalid, WorkReadMissing,
  WorkReadMoved, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { readSerialSummaries } from '../work/summary-serial.ts';
import type { ProjectedWork } from '../discovery/contract.ts';
import { AUTHOR_PAGE_COST, type authorCredit, type authorTotals, type authorWork,
  type externalAuthorRead } from './contract.ts';

type Credit = Static<typeof authorCredit>;
type Work = Static<typeof authorWork>;
type Rating = NonNullable<ProjectedWork['rating']>;
interface Listed { id: string; main: string; rating: Rating | null }

const AUTHOR_KEY = /^\/authors\/OL[1-9][0-9]{0,11}A$/;
const openLibraryId = (key: string) => key.slice('/authors/'.length);

function field(row: Record<string, { value: string } | undefined>, key: string): string {
  const value = row[key]?.value;
  if (!value) throw new WorkReadUnavailable('Author read field is unavailable');
  return value;
}

/**
 * Every public Work crediting the author: human-confirmed graph credits and
 * the retained adoptions that report them, joined in one graph query that
 * admits only current public selections and no chapter. Most rated first, as
 * Goodreads lists an author's books; then by mean, then by identifier.
 */
async function listedWorks(session: WorkReadSession, key: string) {
  const reported = await sourceReportedAuthorWorks(session, key);
  const rows = await session.query(`SELECT DISTINCT ?id ?main WHERE {
    { GRAPH ${iri(GRAPHS.current)} { ?credit a rv:AuthorCredit ; rv:work ?id ; rv:creditRevision ?creditHead ;
        schema:roleName "author" ; rv:externalProvider "open-library" ; rv:externalNamespace "author" ;
        rv:externalKey ${lit(key)} ; rv:editControl rv:HumanConfirmed . }
      GRAPH ${iri(GRAPHS.revisions)} { ?creditHead a rv:AuthorCreditRevision ; rv:component ?credit ;
        rv:work ?id ; rv:externalKey ${lit(key)} . FILTER NOT EXISTS { ?creditHead a rv:ErasedRevision } } }
    ${reported.works.length ? `UNION { VALUES ?id { ${reported.works.map(iri).join(' ')} } }` : ''}
    ${publicWork('?id', '?main')}
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?id schema:isPartOf ?parentWork } }
  } ORDER BY STR(?id) LIMIT ${AUTHOR_PAGE_COST.works + 1}`, AUTHOR_PAGE_COST.works + 1);
  const works = rows.slice(0, AUTHOR_PAGE_COST.works).map(row => ({ id: field(row, 'id'), main: field(row, 'main') }));
  if (new Set(works.map(work => work.id)).size !== works.length) throw new WorkReadUnavailable('Author Works are ambiguous');
  const rated = works.length ? await searchPageRatings(session, works.map(work => ({ work: work.id, mainVersion: work.main })))
    : { values: new Map<string, Rating | null>(), status: 'no-context' as const };
  const listed: Listed[] = works.map(work => ({ ...work, rating: rated.values.get(work.id) ?? null }));
  listed.sort((a, b) => (b.rating?.count ?? 0) - (a.rating?.count ?? 0) || (b.rating?.mean ?? 0) - (a.rating?.mean ?? 0)
    || a.id.localeCompare(b.id));
  return { works: listed, complete: rows.length <= AUTHOR_PAGE_COST.works && reported.complete };
}

async function workTypes(session: WorkReadSession, works: readonly string[]) {
  const rows = works.length ? await session.query(`SELECT ?work ?type WHERE {
    VALUES ?work { ${works.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?work a ?type .
      VALUES ?type { ${WORK_SEMANTIC_TYPES.map(type => `<${type}>`).join(' ')} } }
  } LIMIT ${works.length * WORK_SEMANTIC_TYPES.length + 1}`, works.length * WORK_SEMANTIC_TYPES.length) : [];
  const types = new Map(works.map(work => [work, [] as string[]]));
  for (const row of rows) types.get(field(row, 'work'))?.push(field(row, 'type'));
  return types;
}

/**
 * Who else wrote each Work, in credit order and at most three, always naming
 * this author: Agents first, then Open Library authors by position, confirmed
 * credits replacing the adoption's report of the same author. A Work with more
 * than sixteen confirmed credits names only this author.
 */
async function workAuthors(session: WorkReadSession, key: string, works: readonly string[]) {
  const probe = works.length * 16;
  const rows = works.length ? await session.query(`SELECT ?work ?id ?key ?ordinal ?agent WHERE {
    VALUES ?work { ${works.map(iri).join(' ')} }
    { GRAPH ${iri(GRAPHS.current)} { ?id a rv:AuthorCredit ; rv:work ?work ; rv:creditRevision ?revision ;
        schema:roleName "author" ; rv:externalProvider "open-library" ; rv:externalNamespace "author" ;
        rv:externalKey ?key ; schema:position ?ordinal ; rv:editControl rv:HumanConfirmed . }
      GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:AuthorCreditRevision ; rv:component ?id ; rv:work ?work ;
        rv:externalKey ?key ; schema:position ?ordinal . FILTER NOT EXISTS { ?revision a rv:ErasedRevision } } }
    UNION
    { GRAPH ${iri(GRAPHS.current)} { ?id a rv:NativeAgentCredit ; rv:work ?work ; rv:creditRevision ?revision ;
        rv:agent ?agent ; schema:roleName "author" . }
      GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:NativeAgentCreditRevision ; rv:component ?id ; rv:work ?work ;
        rv:agent ?agent ; schema:roleName "author" . FILTER NOT EXISTS { ?revision a rv:ErasedRevision } } }
  } LIMIT ${probe + 1}`, probe + 1) : [];
  const reported = await sourceReportedCredits(session, works, AUTHOR_PAGE_COST.creditsPerWork);
  const self = { agent: null, key, ordinal: -1 };
  const chosen = new Map(works.map(work => {
    if (rows.length > probe) return [work, [self]];
    const confirmed = rows.filter(row => field(row, 'work') === work).map(row => ({
      agent: row.agent?.value ?? null, key: row.key?.value ?? null,
      ordinal: row.agent ? -1 : Number(field(row, 'ordinal')) }));
    if (confirmed.some(credit => credit.agent === null && (!credit.key || !Number.isSafeInteger(credit.ordinal)))) {
      throw new WorkReadUnavailable('Author credits are ambiguous');
    }
    const keys = new Set(confirmed.map(credit => credit.key));
    const all = [...confirmed, ...(reported.get(work) ?? []).filter(credit => !keys.has(credit.key))
      .map(credit => ({ agent: null, key: credit.key, ordinal: credit.ordinal }))]
      .sort((a, b) => a.ordinal - b.ordinal || (a.agent ?? a.key ?? '').localeCompare(b.agent ?? b.key ?? ''));
    const unique = all.filter((credit, index) => all.findIndex(other => other.agent === credit.agent
      && other.key === credit.key) === index);
    const top = unique.slice(0, AUTHOR_PAGE_COST.creditsPerWork);
    return [work, top.some(credit => credit.key === key) ? top
      : [...top.slice(0, AUTHOR_PAGE_COST.creditsPerWork - 1), self]];
  }));
  const credits = [...chosen.values()].flat();
  const names = await readAuthorNames(session, [...new Set(credits.flatMap(credit => credit.key ? [credit.key] : []))]);
  const agents = await namedDiscoveryCredits(session, credits.flatMap(credit => credit.agent ? [{ id: credit.agent,
    role: 'author' as const, participantKind: 'agent' as const, provider: null, key: null, ordinal: null,
    agent: credit.agent, displayName: null, handle: null }] : []), works.length);
  return new Map([...chosen].map(([work, list]) => [work, list.flatMap<Credit>(credit => {
    if (credit.key) return [{ kind: 'external', provider: 'open-library', key: credit.key,
      displayName: names.get(credit.key)?.displayName ?? null }];
    const agent = agents.get(credit.agent!);
    return agent ? [{ kind: 'agent', agent: credit.agent!, handle: agent.handle, displayName: agent.displayName }] : [];
  })]));
}

/** The shown Works as cards: title and cover, type, pitch, serial state, rating and authors. */
async function hydrate(session: WorkReadSession, key: string, page: readonly Listed[]): Promise<Work[]> {
  const cards = await shelfWorks(session, page.map(work => work.id));
  const visible = page.filter(work => cards.has(work.id)).map(work => work.id);
  const serial = await readSerialSummaries(session, visible);
  const types = await workTypes(session, visible);
  const authors = await workAuthors(session, key, visible);
  return page.flatMap(work => {
    const card = cards.get(work.id);
    return card ? [{ ...card, types: (types.get(work.id) ?? []).sort(), tagline: serial.get(work.id)?.tagline ?? null,
      completionStatus: serial.get(work.id)?.completionStatus ?? null, rating: work.rating,
      authors: authors.get(work.id) ?? [] }] : [];
  });
}

function totals(session: WorkReadSession, listed: Awaited<ReturnType<typeof listedWorks>>,
  readers: Static<typeof authorTotals>['readers']): Static<typeof authorTotals> {
  const kind = listed.complete ? 'exact' as const : 'lower-bound' as const;
  const rated = listed.works.flatMap(work => work.rating ? [work.rating] : []);
  const count = rated.reduce((total, rating) => total + rating.count, 0);
  const scale = rated[0]?.scale;
  if (rated.some(rating => rating.context !== rated[0]!.context || rating.scale.max !== scale!.max)) {
    throw new WorkReadUnavailable('Author ratings answer different questions');
  }
  session.checkDeadline();
  return { works: { value: listed.works.length, kind },
    ratings: count && scale ? { context: rated[0]!.context, count: { value: count, kind },
      mean: rated.reduce((total, rating) => total + rating.sum, 0) / count, scale: { min: 1, max: scale.max } } : null,
    readers: readers && !listed.complete ? { ...readers, kind: 'lower-bound' } : readers };
}

const binding = (session: WorkReadSession, key: string) => ['author-works-v1', key, session.options.language ?? null];

/**
 * `/v1/authors/open-library/{id}`: the author, their facts, totals and first
 * Works. Missing when no public Work on REZICS credits them, whatever Open
 * Library knows. Facts come from the same head as the name the read fences;
 * a capture that cannot be read leaves them out rather than the page.
 */
export async function readExternalAuthor(session: WorkReadSession, key: string,
  limit: number = AUTHOR_PAGE_COST.pageSize): Promise<Static<typeof externalAuthorRead>> {
  if (!AUTHOR_KEY.test(key)) throw new WorkReadInvalid('Invalid author key');
  const listed = await listedWorks(session, key);
  if (!listed.works.length) throw new WorkReadMissing('No public Work credits this author');
  const name = (await readAuthorNames(session, [key])).get(key) ?? null;
  let facts = null;
  try { facts = await session.deps.sourceAuthorNames?.facts(key) ?? null; }
  catch (error) { if (!(error instanceof SourceIntakeUnavailable)) throw error; }
  if (facts && facts.name.nameSource.revision !== name?.nameSource.revision) {
    throw new WorkReadMoved('Author facts changed during the read');
  }
  const readers = await session.deps.authorReaders?.count(listed.works.map(work => work.id)) ?? null;
  const page = listed.works.slice(0, limit);
  const id = openLibraryId(key);
  return { profile: 'external-author-read-v1', provider: 'open-library', key,
    name: name && { displayName: name.displayName, nameSource: name.nameSource }, facts: facts?.facts ?? null,
    record: `https://openlibrary.org${key}`, totals: totals(session, listed, readers),
    works: { items: await hydrate(session, key, page), nextCursor: listed.works.length > limit
      ? encodeReadCursor(binding(session, key), session.position, page.at(-1)!.id) : null },
    sourcePosition: session.position,
    links: { page: `/authors/open-library/${id}`, works: `/v1/authors/open-library/${id}/works` } };
}

/** `/v1/authors/open-library/{id}/works`: the author's Works in page order, twenty at most. */
export async function readExternalAuthorWorks(session: WorkReadSession, key: string) {
  if (!AUTHOR_KEY.test(key)) throw new WorkReadInvalid('Invalid author key');
  const limit = session.options.limit ?? AUTHOR_PAGE_COST.pageSize;
  const cursor = decodeReadCursor(session.options.cursor, binding(session, key), session.position);
  const listed = await listedWorks(session, key);
  if (!listed.works.length) throw new WorkReadMissing('No public Work credits this author');
  const start = cursor ? listed.works.findIndex(work => work.id === cursor.after) + 1 : 0;
  if (cursor && !start) throw new WorkReadMoved('Author Works changed; restart from the first page');
  const page = listed.works.slice(start, start + limit);
  return pageResult(session, await hydrate(session, key, page), listed.works.length > start + limit
    ? encodeReadCursor(binding(session, key), session.position, page.at(-1)!.id) : null);
}
