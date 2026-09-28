import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { namedDiscoveryCredits } from '../discovery/credits.ts';
import { DISCOVERY_COST, type DiscoveryCredit, type ProjectedCredit } from '../discovery/contract.ts';
import { MAX_SUMMARY_BATCH, type ResourceSummary } from '../media/summary.ts';
import { WorkReadUnavailable, workRead, type WorkReadSession } from '../work/read-session.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { metadataComponent, METADATA_PROFILE } from '../work/metadata-schema.ts';
import { parsedMetadataState, selectedMetadata } from '../work/metadata-read.ts';
import { SearchSnapshotMoved } from '../work/search-readiness.ts';
import { readAuthorNames, sourceReportedCredits } from '../source/author-name-read.ts';
import { WorkReadMoved } from '../work/read-session.ts';
import { searchPageRatings } from './ratings.ts';

export const SEARCH_CARD_COST = { works: 64, creditsPerWork: 3,
  summaryBatches: 2, serialQueries: 1, creditQueries: 1, creditRows: 192,
  sourceNameQueries: 2, ratingContextQueries: 1, ratingQueriesPerWork: 1,
  agentNameQueries: 1, graphCallsWithoutAgentNames: 7, graphCallsWithAgentNames: 8 } as const;

/** Exact current metadata heads, one graph query plus the existing serial
 * stats owner batch. Nest the revision OPTIONAL under its owning head: two
 * independent OPTIONALs can bind another Work's metadata to a headless Work.
 * Missing metadata is an explicit null card state. */
export async function searchPageSerial(session: WorkReadSession, works: readonly string[]) {
  if (works.length > SEARCH_CARD_COST.works) throw new WorkReadUnavailable('Search serial page exceeds its bound');
  const result = new Map<string, { tagline: ReturnType<typeof selectedMetadata>['tagline'];
    completionStatus: 'ongoing' | 'completed' | 'hiatus' | null;
    chapterCount: number | null; wordCount: number | null; lastUpdatedAt: string | null }>();
  if (!works.length) return result;
  const rows = await session.query(`SELECT ?work ?head ?component ?state WHERE {
    VALUES ?work { ${works.map(iri).join(' ')} }
    OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?work rv:descriptiveMetadataHead ?head }
      OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:WorkMetadataRevision ;
        rv:component ?component ; rv:modelRevision ${iri(METADATA_PROFILE)} ;
        rv:shapeRevision ${iri(METADATA_PROFILE)} ; rv:metadataState ?state } } }
  } LIMIT ${works.length + 1}`, works.length + 1);
  if (rows.length !== works.length || new Set(rows.map(row => row.work?.value)).size !== works.length
    || rows.some(row => !row.work || !works.includes(row.work.value))) {
    throw new WorkReadUnavailable('Search serial heads are ambiguous');
  }
  const stats = await session.deps.serialStats?.batch(works, session.position.sequence);
  for (const row of rows) {
    const work = row.work!.value;
    if (row.head && (!row.component || !row.state
      || row.component.value !== metadataComponent(work,
        { kind: 'header', originalTitle: null, localized: [] }))) {
      throw new WorkReadUnavailable('Search metadata head is incomplete');
    }
    const state = row.state ? parsedMetadataState(row.state.value) : null;
    if (state && state.kind !== 'header') throw new WorkReadUnavailable('Search metadata head is not a header');
    const selected = state ? selectedMetadata(state, session.options.language) : null;
    result.set(work, { tagline: selected?.tagline ?? null,
      completionStatus: state?.completionStatus ?? null,
      chapterCount: stats?.get(work)?.chapterCount ?? null,
      wordCount: stats?.get(work)?.wordCount ?? null,
      lastUpdatedAt: stats?.get(work)?.lastUpdatedAt ?? null });
  }
  return result;
}

/** One graph relation for all candidate credits. A pathological fanout fails
 * closed before it can make search page cost grow with the corpus. */
export async function searchPageCredits(session: WorkReadSession, works: readonly string[]) {
  if (works.length > SEARCH_CARD_COST.works) throw new WorkReadUnavailable('Search credit page exceeds its bound');
  const result = new Map<string, ProjectedCredit[]>(works.map(work => [work, []]));
  if (!works.length) return result;
  const rows = await session.query(`SELECT ?work ?id ?key ?ordinal ?agent WHERE {
    VALUES ?work { ${works.map(iri).join(' ')} }
    { GRAPH ${iri(GRAPHS.current)} { ?id a rv:AuthorCredit ; rv:work ?work ;
        rv:creditRevision ?revision ; schema:roleName "author" ; rv:externalProvider "open-library" ;
        rv:externalNamespace "author" ; rv:externalKey ?key ; schema:position ?ordinal ; rv:editControl rv:HumanConfirmed . }
      GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:AuthorCreditRevision ; rv:component ?id ;
        rv:work ?work ; rv:externalKey ?key ; schema:position ?ordinal .
        FILTER NOT EXISTS { ?revision a rv:ErasedRevision } } }
    UNION
    { GRAPH ${iri(GRAPHS.current)} { ?id a rv:NativeAgentCredit ; rv:work ?work ;
        rv:creditRevision ?revision ; rv:agent ?agent ; schema:roleName "author" . }
      GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:NativeAgentCreditRevision ; rv:component ?id ;
        rv:work ?work ; rv:agent ?agent ; schema:roleName "author" .
        FILTER NOT EXISTS { ?revision a rv:ErasedRevision } } }
  } ORDER BY STR(?work) ?ordinal STR(?id) LIMIT ${SEARCH_CARD_COST.creditRows + 1}`,
  SEARCH_CARD_COST.creditRows);
  const seen = new Set<string>();
  for (const row of rows) {
    const own = result.get(row.work?.value ?? '');
    if (!own || !row.id || seen.has(row.id.value) || (row.agent && (row.key || row.ordinal))
      || (!row.agent && (!row.key || !/^\d+$/.test(row.ordinal?.value ?? '')
        || !Number.isSafeInteger(Number(row.ordinal?.value))))) {
      throw new WorkReadUnavailable('Search credits are ambiguous');
    }
    seen.add(row.id.value);
    if (own.length >= DISCOVERY_COST.primaryCredits) continue;
    own.push(row.agent ? { id: row.id.value, role: 'author', participantKind: 'agent',
      provider: null, key: null, ordinal: null, agent: row.agent.value,
      displayName: null, handle: null } : { id: row.id.value, role: 'author',
      participantKind: 'external-reference', provider: 'open-library', key: row.key!.value,
      ordinal: Number(row.ordinal!.value), agent: null, displayName: null, handle: null });
  }
  const reported = await sourceReportedCredits(session, works);
  for (const [work, candidates] of reported) {
    const confirmed = result.get(work)!;
    const confirmedKeys = new Set(confirmed.flatMap(credit => credit.key !== null ? [credit.key] : []));
    result.set(work, [...confirmed, ...candidates.filter(credit => !confirmedKeys.has(credit.key))]
      .sort((a, b) => (a.ordinal ?? -1) - (b.ordinal ?? -1) || a.id.localeCompare(b.id))
      .slice(0, DISCOVERY_COST.primaryCredits));
  }
  return result;
}

/** Hydrate only the selected page after the phrase relation is complete.
 * Its candidate set and continuation remain those of the search owner. */
export async function enrichSearchCardPage<T extends { resultGrain: string;
  sourcePosition?: { dataEpoch: string; sequence: string };
  context?: 'main-version-default' | { kind: 'realm-local'; id: string };
  results: Array<{ work: string; mainVersion?: string; rating?: unknown }> }>(
  deps: MainWorkDependencies, request: Request, page: T, language?: string | null): Promise<T> {
  if (page.resultGrain !== 'mainVersion' || !page.sourcePosition) return page;
  const matches = page.results;
  const ids = [...new Set(matches.map(match => match.work))];
  if (ids.length > SEARCH_CARD_COST.works) throw new WorkReadUnavailable('Search card page exceeds its bound');
  if (!ids.length) return page;
  const cards = await workRead(deps, new Request(request.url), { language: language ?? undefined }, async session => {
    if (session.position.dataEpoch !== page.sourcePosition!.dataEpoch
      || session.position.sequence !== page.sourcePosition!.sequence) {
      throw new SearchSnapshotMoved('Search card graph position changed');
    }
    const summaries: ResourceSummary[] = [];
    for (let i = 0; i < ids.length; i += MAX_SUMMARY_BATCH) {
      summaries.push(...await session.summaries(ids.slice(i, i + MAX_SUMMARY_BATCH)));
    }
    if (summaries.some(summary => summary.status !== 'available'
      || summary.type !== 'work' || summary.disclosure !== 'public')) {
      throw new SearchSnapshotMoved('Search card disclosure changed');
    }
    const serial = await searchPageSerial(session, ids);
    const credits = await searchPageCredits(session, ids);
    const names = await namedDiscoveryCredits(session, [...credits.values()].flat(), SEARCH_CARD_COST.works);
    const sourceNames = await readAuthorNames(session, [...credits.values()].flat()
      .flatMap(credit => credit.participantKind === 'external-reference' ? [credit.key] : []));
    const ratings = await searchPageRatings(session, matches, page.context);
    const fenced: ResourceSummary[] = [];
    for (let i = 0; i < ids.length; i += MAX_SUMMARY_BATCH) {
      fenced.push(...await session.summaries(ids.slice(i, i + MAX_SUMMARY_BATCH)));
    }
    if (summaries.some((summary, index) => JSON.stringify(summary) !== JSON.stringify(fenced[index]))) {
      throw new SearchSnapshotMoved('Search card disclosure changed during hydration');
    }
    return new Map(ids.map((id, index) => {
      const summary = summaries[index]!;
      const value = serial.get(id);
      if (summary.status !== 'available' || !value) throw new WorkReadUnavailable('Search card is incomplete');
      return [id, { title: summary.name, cover: summary.avatar,
        rating: ratings.values.get(id) ?? null,
        ratingStatus: ratings.values.has(id) || matches.some(match => match.work === id && match.rating)
          ? 'available' : ratings.status === 'selected' ? 'unrated' : ratings.status,
        tagline: value.tagline, completionStatus: value.completionStatus,
        chapterCount: value.chapterCount, wordCount: value.wordCount,
        lastUpdatedAt: value.lastUpdatedAt,
        primaryCredits: credits.get(id)!.flatMap((credit): DiscoveryCredit[] => {
          if (credit.participantKind === 'external-reference') return [{ ...credit, ...sourceNames.get(credit.key) }];
          const name = names.get(credit.agent);
          return name ? [{ ...credit, ...name }] : [];
        }) }];
    }));
  }).catch((error: unknown) => {
    if (error instanceof WorkReadMoved) throw new SearchSnapshotMoved(error.message);
    throw error;
  });
  return { ...page, results: matches.map(match => ({ ...match, ...cards.get(match.work),
    ...(match.rating ? { rating: match.rating } : {}) })) } as T;
}
