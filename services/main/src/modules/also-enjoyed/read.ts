import { createHash } from 'node:crypto';
import type { Static } from 'typebox';
import { readAuthorNames } from '../source/author-name-read.ts';
import { namedDiscoveryCredits } from '../discovery/credits.ts';
import type { OwnedDiscoveryBasis } from '../discovery/contract.ts';
import { RecommendationUnavailable } from '../recommendation/derived-generation.ts';
import { searchPageCredits, searchPageSerial } from '../search/result-cards.ts';
import { searchPageRatings } from '../search/ratings.ts';
import { SearchSnapshotMoved } from '../work/search-readiness.ts';
import { canonicalChapterWorks } from '../structure/chapter-work.ts';
import { displayZoneCredits } from '../zone-modules/read.ts';
import { GRAPHS, iri, lit, WORK_SEMANTIC_TYPES } from '../work/activate.ts';
import { readWorkClassifications } from '../work/read-classifications.ts';
import { readWorkBasis } from '../work/read-header.ts';
import { readWorkPage } from '../work/read-pages.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, publicWork, WorkReadInvalid,
  WorkReadMissing, WorkReadMoved, WorkReadSession, WorkReadUnavailable } from '../work/read-session.ts';
import { alsoEnjoyedItem } from './contract.ts';
import type { AlsoEnjoyedStore } from './store.ts';

type Basis = Static<typeof alsoEnjoyedItem>['basis'];
interface Candidate { work: string; basis: Basis }
const candidateLimit = 64;
const hash = (items: unknown) => createHash('sha256').update(JSON.stringify(items)).digest('hex');

/** Nested source collections have their own cursor identity. */
function sourceSession(session: WorkReadSession) {
  const nested = new WorkReadSession(session.deps, session.request,
    { ...session.options, cursor: undefined, limit: 20 }, session.position);
  nested.principal = session.principal;
  return nested;
}

function creditIdentities(credits: Awaited<ReturnType<typeof searchPageCredits>>,
  work: string) {
  return new Set((credits.get(work) ?? []).map(credit => credit.agent
    ? `agent:${credit.agent}` : `external:${credit.provider}:${credit.key}`));
}

async function classCandidates(session: WorkReadSession, source: string): Promise<string[]> {
  const projection = session.deps.discovery;
  if (!projection) return [];
  const nested = sourceSession(session);
  const classifications = await readWorkClassifications(nested, source).catch(error => {
    if (!(error instanceof WorkReadMoved || error instanceof SearchSnapshotMoved)) throw error;
    session.stale = true;
    return null;
  });
  if (nested.stale) session.stale = true;
  if (!classifications) return [];
  if (!classifications.items.length) return [];
  const basis: OwnedDiscoveryBasis = { scope: 'global', realm: null, context: null, owner: null };
  let active;
  try { active = await projection.active(basis, session.position); }
  catch (error) { if (error instanceof RecommendationUnavailable) return []; throw error; }
  if (active.stale) { session.stale = true; return []; }
  const found: string[] = [];
  for (const sense of classifications.items.slice(0, 3)) {
    const rows = await projection.page(active, 'recent', '', sense.sense, 20);
    found.push(...rows.map(row => row.work));
  }
  const final = await projection.active(basis, session.position, active.generation_id);
  if (final.stale) { session.stale = true; return []; }
  return [...new Set(found)].slice(0, 24);
}

/** A type and selected-language relation is bounded to 64 Work identities.
 * This still works before Discovery has its first active generation. */
async function typeCandidates(session: WorkReadSession, source: Awaited<ReturnType<typeof readWorkBasis>>) {
  const typeValues = source.card.types.filter(type => WORK_SEMANTIC_TYPES.includes(type as typeof WORK_SEMANTIC_TYPES[number]));
  if (!typeValues.length) return [];
  const rows = await session.query(`SELECT DISTINCT ?work WHERE {
    VALUES ?type { ${typeValues.map(type => `<${type}>`).join(' ')} }
    ${publicWork('?work', '?main')}
    GRAPH ${iri(GRAPHS.current)} { ?work a ?type }
    ${source.selectedLanguage ? `GRAPH ${iri(GRAPHS.current)} { ?main rv:selectionHead ?selection }
      GRAPH ${iri(GRAPHS.revisions)} { ?selection rv:language ${lit(source.selectedLanguage)} }` : ''}
    FILTER(?work != ${iri(source.card.id)})
  } ORDER BY STR(?work) LIMIT 65`, 65);
  return rows.flatMap(row => row.work ? [row.work.value] : []).slice(0, 32);
}

async function realmCandidates(session: WorkReadSession, source: string) {
  const adoptions = await readWorkPage(sourceSession(session), source, 'adoptions');
  const works: string[] = [];
  for (const adoption of adoptions.items.slice(0, 2)) {
    if (!('realm' in adoption)) continue;
    const rows = await session.query(`SELECT DISTINCT ?work WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?slot a rv:RealmPublicationSlot ;
        rv:realm ${iri(adoption.realm)} ; rv:work ?work ; rv:selectionHead ?selection . }
      GRAPH ${iri(GRAPHS.revisions)} { ?selection a rv:PublicationSelection ;
        rv:work ?work ; rv:publicationDecision ?decision . ?decision rv:disclosure rv:Public . }
      ${publicWork('?work', '?main')}
      FILTER(?work != ${iri(source)})
    } ORDER BY STR(?work) LIMIT 21`, 21);
    works.push(...rows.flatMap(row => row.work ? [row.work.value] : []));
  }
  return [...new Set(works)].slice(0, 24);
}

async function publicCandidates(session: WorkReadSession, candidates: Candidate[], source: string,
  sourceTypes: readonly string[]) {
  const ids = candidates.map(item => item.work);
  if (!ids.length || !sourceTypes.length) return [];
  const visible = new Set<string>();
  for (let offset = 0; offset < ids.length; offset += 20) {
    const batch = ids.slice(offset, offset + 20);
    const rows = await session.query(`SELECT DISTINCT ?work WHERE {
      VALUES ?work { ${batch.map(iri).join(' ')} }
      VALUES ?sourceType { ${sourceTypes.map(type => `<${type}>`).join(' ')} }
      ${publicWork('?work', '?main')}
      GRAPH ${iri(GRAPHS.current)} { ?work a ?sourceType }
    } LIMIT 21`, 20);
    for (const row of rows) if (row.work) visible.add(row.work.value);
  }
  const chapters = new Set<string>();
  for (let offset = 0; offset < ids.length; offset += 24) {
    for (const child of (await canonicalChapterWorks(session, ids.slice(offset, offset + 24))).keys()) {
      chapters.add(child);
    }
  }
  const credits = await searchPageCredits(session, ids);
  const sourceCredits = await searchPageCredits(session, [source]);
  const sourceAuthors = creditIdentities(sourceCredits, source);
  return candidates.filter(item => visible.has(item.work) && !chapters.has(item.work)
    && ![...creditIdentities(credits, item.work)].some(author => sourceAuthors.has(author)));
}

/** A read considers at most 64 candidate IDs and hydrates only its ≤20-page.
 * The source and every card retain current Work disclosure checks. */
export async function readAlsoEnjoyed(session: WorkReadSession, source: string,
  store: AlsoEnjoyedStore) {
  const sourceBasis = await readWorkBasis(session, source);
  const sourceTypes = sourceBasis.card.types.filter(type =>
    WORK_SEMANTIC_TYPES.includes(type as typeof WORK_SEMANTIC_TYPES[number]));
  const binding = ['also-enjoyed-v1', source, session.options.language ?? null,
    session.options.actingSubject ?? null];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  const co = await store.candidates(source, 24);
  const projectionPosition = co.graphEpoch && co.graphSequence
    ? { dataEpoch: co.graphEpoch, sequence: co.graphSequence } : null;
  const candidates: Candidate[] = [];
  const seen = new Set([source]);
  const append = (ids: string[], basis: Basis) => {
    for (const work of ids) if (!seen.has(work) && candidates.length < candidateLimit) {
      seen.add(work); candidates.push({ work, basis });
    }
  };
  if (co.graphEpoch === session.position.dataEpoch && co.sourceReaders >= 4) {
    append(co.candidates.map(item => item.work), 'co-readers');
  }
  append(await classCandidates(session, source), 'similar');
  append(await typeCandidates(session, sourceBasis), 'similar');
  append(await realmCandidates(session, source), 'realm');
  const visible = await publicCandidates(session, candidates, source, sourceTypes);
  const fingerprint = hash([co.generation, visible]);
  if (cursor?.order && cursor.order !== fingerprint) throw new WorkReadMoved('Recommendations changed');
  const start = cursor ? Number(cursor.after) : 0;
  if (!Number.isSafeInteger(start) || start < 0 || start > visible.length) {
    throw new WorkReadInvalid('Recommendation cursor is invalid');
  }
  const limit = session.options.limit ?? 6;
  const selected = visible.slice(start, start + limit);
  const ids = selected.map(item => item.work);
  const rows = ids.length ? await session.query(`SELECT ?work ?head ?main ?type WHERE {
    VALUES ?work { ${ids.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?work rv:head ?head ; rv:mainVersion ?main .
      OPTIONAL { ?work a ?type . VALUES ?type { ${WORK_SEMANTIC_TYPES.map(type => `<${type}>`).join(' ')} } } }
    ${publicWork('?work', '?main')}
  } LIMIT 161`, 160) : [];
  const facts = new Map<string, { head: string; main: string; types: Set<string> }>();
  for (const row of rows) {
    if (!row.work || !row.head || !row.main || !ids.includes(row.work.value)) {
      throw new WorkReadUnavailable('Recommendation Work basis is ambiguous');
    }
    const current = facts.get(row.work.value) ?? { head: row.head.value, main: row.main.value,
      types: new Set<string>() };
    if (current.head !== row.head.value || current.main !== row.main.value) {
      throw new WorkReadUnavailable('Recommendation Work basis moved');
    }
    if (row.type) current.types.add(row.type.value);
    facts.set(row.work.value, current);
  }
  if (facts.size !== ids.length) session.stale = true;
  const live = selected.filter(item => facts.has(item.work));
  const liveIds = live.map(item => item.work);
  const summaries = await session.summaries(liveIds);
  const serial = await searchPageSerial(session, liveIds);
  const credits = await searchPageCredits(session, liveIds);
  const ratings = await searchPageRatings(session, liveIds.map(work => ({ work,
    mainVersion: facts.get(work)!.main }))).catch(error => {
    if (!(error instanceof SearchSnapshotMoved)) throw error;
    session.stale = true;
    return { values: new Map<string, null>() };
  });
  const names = await namedDiscoveryCredits(session, [...credits.values()].flat());
  const sourceNames = await readAuthorNames(session, [...credits.values()].flat()
    .flatMap(credit => credit.participantKind === 'external-reference' ? [credit.key] : []));
  const fenced = await session.summaries([source, ...liveIds]);
  const sourceFinal = fenced[0];
  if (sourceFinal?.status !== 'available' || sourceFinal.type !== 'work'
    || sourceBasis.disclosure === 'public' && sourceFinal.disclosure !== 'public') {
    throw new WorkReadMissing('Work is unavailable');
  }
  if (sourceFinal.disclosure !== 'public' && (!session.principal || !session.options.actingSubject
    || !await session.deps.access.canReadWork(session.principal, session.options.actingSubject, source))) {
    throw new WorkReadMissing('Work is unavailable');
  }
  const finalVisible = new Set((await publicCandidates(session, live, source, sourceTypes)).map(item => item.work));
  const items: Static<typeof alsoEnjoyedItem>[] = live.flatMap((item, index) => {
    const summary = summaries[index], final = fenced[index + 1], fact = facts.get(item.work)!,
      metadata = serial.get(item.work);
    if (summary?.status !== 'available' || summary.type !== 'work'
      || summary.disclosure !== 'public' || !finalVisible.has(item.work)
      || ![...fact.types].some(type => sourceTypes.includes(type))
      || !final || JSON.stringify(summary) !== JSON.stringify(final) || !metadata) {
      session.stale = true;
      return [];
    }
    return [{ id: item.work, revision: fact.head, mainVersion: fact.main,
      title: summary.name, cover: summary.avatar, types: [...fact.types].sort(),
      ...metadata, primaryCredits: displayZoneCredits(credits.get(item.work) ?? [], names, sourceNames),
      rating: ratings.values.get(item.work) ?? null, basis: item.basis }];
  });
  const end = start + selected.length;
  return { profile: 'also-enjoyed-v1' as const, projectionPosition,
    stale: co.stale || !!projectionPosition && (projectionPosition.dataEpoch !== session.position.dataEpoch
      || projectionPosition.sequence !== session.position.sequence) || session.stale,
    ...pageResult(session, items, end < visible.length
      ? encodeReadCursor(binding, session.position, String(end), fingerprint) : null) };
}
