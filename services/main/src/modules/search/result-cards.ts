import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { namedDiscoveryCredits } from '../discovery/credits.ts';
import { DISCOVERY_COST, type DiscoveryCredit, type ProjectedCredit } from '../discovery/contract.ts';
import { MAX_SUMMARY_BATCH, type ResourceSummary } from '../media/summary.ts';
import { WorkReadUnavailable, workRead, type WorkReadSession } from '../work/read-session.ts';
import { currentDisclosureViewer } from '../disclosure/viewer.ts';
import { publicLanguageRequest } from '../display-language/public-request.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { metadataComponent, METADATA_PROFILE, type SerialStatus } from '../work/metadata-schema.ts';
import { parsedMetadataState, selectedMetadata } from '../work/metadata-read.ts';
import { SearchSnapshotMoved } from '../work/search-readiness.ts';
import { readAuthorNames, sourceReportedCredits } from '../source/author-name-read.ts';
import { WorkReadMoved } from '../work/read-session.ts';
import { searchPageRatings } from './ratings.ts';
import { searchCardReadDependencies } from './card-reads.ts';
import { optionalPreview } from '../query/optional-preview.ts';
import { EMPTY_SERIAL_SUMMARY } from '../work/summary-serial.ts';
import { RatingAggregateBudgetExceeded } from '../rating/aggregate.ts';
import { WorkReadLimit } from '../work/read-session.ts';
import { Value } from 'typebox/value';
import { discoveryItem } from '../discovery/contract.ts';
import { PublicQueryBudgetExceeded, PublicQueryUnavailable } from '../work/search-budget.ts';

export const SEARCH_CARD_COST = { works: 64, creditsPerWork: 3,
  summaryBatches: 2, serialQueries: 1, creditQueries: 1, creditRows: 192,
  sourceNameQueries: 4, sourceAttributionQueries: 2, ratingContextQueries: 1, ratingQueries: 1,
  factBatches: 1, agentNameQueries: 1,
  graphCallsWithoutAgentNames: 2, graphCallsWithAgentNames: 3 } as const;

/** Exact current metadata heads, one graph query plus the existing serial
 * stats owner batch. Nest the revision OPTIONAL under its owning head: two
 * independent OPTIONALs can bind another Work's metadata to a headless Work.
 * Missing metadata is an explicit null card state. */
export async function searchPageSerial(session: WorkReadSession, works: readonly string[], preview = false) {
  if (works.length > SEARCH_CARD_COST.works) throw new WorkReadUnavailable('Search serial page exceeds its bound');
  const result = new Map<string, { tagline: ReturnType<typeof selectedMetadata>['tagline'];
    completionStatus: SerialStatus | null;
    chapterCount: number | null; wordCount: number | null; lastUpdatedAt: string | null;
    unavailablePreviews?: ['serial'] }>();
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
  const stats = preview ? await optionalPreview(session, async () => session.deps.serialStats?.batch(works, session.position.sequence))
    : await session.deps.serialStats?.batch(works, session.position.sequence);
  for (const row of rows) {
    const work = row.work!.value;
    const readHeader = async () => {
      if (row.head && (!row.component || !row.state
        || row.component.value !== metadataComponent(work,
          { kind: 'header', originalTitle: null, localized: [] }))) {
        throw new WorkReadUnavailable('Search metadata head is incomplete');
      }
      const state = row.state ? parsedMetadataState(row.state.value) : null;
      if (state && state.kind !== 'header') throw new WorkReadUnavailable('Search metadata head is not a header');
      return { tagline: state ? selectedMetadata(state, session.options.language).tagline : null,
        completionStatus: state?.completionStatus ?? null };
    };
    const header = preview ? await optionalPreview(session, readHeader) : await readHeader();
    if (!header) continue;
    result.set(work, { ...header, ...(preview && stats !== undefined && !stats?.has(work) ? { unavailablePreviews: ['serial'] } : {}),
      chapterCount: stats?.get(work)?.chapterCount ?? null,
      wordCount: stats?.get(work)?.wordCount ?? null,
      lastUpdatedAt: stats?.get(work)?.lastUpdatedAt ?? null });
  }
  return result;
}

/** One graph relation for all candidate credits. A pathological fanout fails
 * closed before it can make search page cost grow with the corpus. */
export async function searchPageCredits(session: WorkReadSession, works: readonly string[], preview = false,
  unavailable = new Set<string>()) {
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
  const seen = new Map<string, string>();
  const damaged = new Set<string>();
  // A UNION of independently bounded fact subqueries does not retain their order.
  rows.sort((a, b) => (a.work?.value ?? '').localeCompare(b.work?.value ?? '')
    || Number(a.ordinal?.value ?? -1) - Number(b.ordinal?.value ?? -1)
    || (a.id?.value ?? '').localeCompare(b.id?.value ?? ''));
  for (const row of rows) {
    const own = result.get(row.work?.value ?? '');
    if (!own || !row.id || seen.has(row.id.value) || (row.agent && (row.key || row.ordinal))
      || (!row.agent && (!row.key || !/^\d+$/.test(row.ordinal?.value ?? '')
        || !Number.isSafeInteger(Number(row.ordinal?.value))))) {
      if (!preview) throw new WorkReadUnavailable('Search credits are ambiguous');
      if (!row.work || !works.includes(row.work.value)) throw new WorkReadUnavailable('Search credits have no owner');
      damaged.add(row.work.value);
      const prior = row.id && seen.get(row.id.value);
      if (prior) damaged.add(prior);
      continue;
    }
    seen.set(row.id.value, row.work!.value);
    if (own.length >= DISCOVERY_COST.primaryCredits) continue;
    own.push(row.agent ? { id: row.id.value, role: 'author', participantKind: 'agent',
      provider: null, key: null, ordinal: null, agent: row.agent.value,
      displayName: null, handle: null } : { id: row.id.value, role: 'author',
      participantKind: 'external-reference', provider: 'open-library', key: row.key!.value,
      ordinal: Number(row.ordinal!.value), agent: null, displayName: null, handle: null });
  }
  const reported = preview ? await optionalPreview(session, () => sourceReportedCredits(session, works, 3, true))
    : await sourceReportedCredits(session, works);
  if (reported === null) for (const work of works) unavailable.add(work);
  for (const [work, candidates] of reported ?? []) {
    const confirmed = result.get(work)!;
    const confirmedKeys = new Set(confirmed.flatMap(credit => credit.key !== null ? [credit.key] : []));
    result.set(work, [...confirmed, ...candidates.filter(credit => !confirmedKeys.has(credit.key))]
      .sort((a, b) => (a.ordinal ?? -1) - (b.ordinal ?? -1) || a.id.localeCompare(b.id))
      .slice(0, DISCOVERY_COST.primaryCredits));
  }
  for (const work of damaged) { result.delete(work); unavailable.add(work); }
  return result;
}

/** Named primary authors for a page of Works: native Agents by their public
 * name and handle, source-reported authors by their recorded name. One credit
 * relation, one Agent name batch and the source name reads, as search cards. */
export async function searchPageAuthors(session: WorkReadSession, works: readonly string[], preview = false,
  unavailable = new Set<string>()) {
  const credits = await searchPageCredits(session, works, preview, unavailable);
  const readNames = () => namedDiscoveryCredits(session, [...credits.values()].flat(), SEARCH_CARD_COST.works, preview);
  const names = preview ? await optionalPreview(session, readNames) : await readNames();
  const readSources = () => readAuthorNames(session, [...credits.values()].flat()
    .flatMap(credit => credit.participantKind === 'external-reference' ? [credit.key] : []), preview);
  const sourceNames = preview ? await optionalPreview(session, readSources) : await readSources();
  for (const [work, own] of credits) {
    if (own.some(credit => credit.agent && !names?.has(credit.agent))
      || !sourceNames && own.some(credit => credit.key)) unavailable.add(work);
  }
  const values = new Map(works.filter(work => credits.has(work))
    .map(work => [work, (credits.get(work) ?? []).flatMap((credit): DiscoveryCredit[] => {
    if (credit.participantKind === 'external-reference') return [{ ...credit,
      ...(preview ? { displayName: null, nameSource: undefined } : {}), ...sourceNames?.get(credit.key) }];
    const name = names?.get(credit.agent);
    return name ? [{ ...credit, ...name }] : [];
  })]));
  if (preview) for (const [work, own] of values) {
    if (!Value.Check(discoveryItem.properties.primaryCredits, own)) { values.delete(work); unavailable.add(work); }
  }
  return values;
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
  const cards = await workRead(searchCardReadDependencies(deps), publicLanguageRequest(request),
    { language: language ?? undefined, publicViewer: currentDisclosureViewer() }, async session => {
    if (session.position.dataEpoch !== page.sourcePosition!.dataEpoch
      || session.position.sequence !== page.sourcePosition!.sequence) {
      throw new SearchSnapshotMoved('Search card graph position changed');
    }
    const unavailableCredits = new Set<string>();
    const [summaries, serial, authors, ratings] = await Promise.all([
      session.summaries(ids, true), optionalPreview(session, () => searchPageSerial(session, ids, true)),
      optionalPreview(session, () => searchPageAuthors(session, ids, true, unavailableCredits)),
      optionalPreview(session, async () => {
        try { return await searchPageRatings(session, matches, page.context); }
        catch (error) {
          if (error instanceof RatingAggregateBudgetExceeded) throw new WorkReadLimit('Search rating budget exceeded');
          throw error;
        }
      }),
    ]);
    const publicCard = (summary: ResourceSummary) => summary.status === 'available'
      && summary.type === 'work' && summary.disclosure === 'public';
    // A Realm may select a public contribution without adopting it globally.
    // Keep that search result, but do not attach the Work's private metadata.
    if (typeof page.context !== 'object' && summaries.some(summary => !publicCard(summary))) {
      throw new SearchSnapshotMoved('Search card disclosure changed');
    }
    const fenced: ResourceSummary[] = [];
    for (let i = 0; i < ids.length; i += MAX_SUMMARY_BATCH) {
      fenced.push(...await session.summaries(ids.slice(i, i + MAX_SUMMARY_BATCH), true));
    }
    if (summaries.some((summary, index) => JSON.stringify({ ...summary, avatar: undefined })
      !== JSON.stringify({ ...fenced[index], avatar: undefined }))) {
      throw new SearchSnapshotMoved('Search card disclosure changed during hydration');
    }
    return new Map(ids.flatMap((id, index) => {
      const summary = summaries[index]!;
      if (!publicCard(summary)) return [];
      const value = serial?.get(id);
      if (summary.status !== 'available') throw new WorkReadUnavailable('Search card is incomplete');
      const ratedMatch = matches.some(match => match.work === id && match.rating);
      const ratingUnavailable = !ratedMatch && (!ratings || ratings.unavailable.has(id));
      const unavailablePreviews = [...(!value ? ['serial'] : value.unavailablePreviews ?? []),
        ...(!authors?.has(id) || unavailableCredits.has(id) ? ['credits'] : []),
        ...(ratingUnavailable ? ['rating'] : [])];
      const current = fenced[index]!;
      return [[id, { title: summary.name, cover: current.status === 'available' ? current.avatar : summary.avatar,
        rating: ratings?.values.get(id) ?? null,
        ratingStatus: ratings?.values.has(id) || ratedMatch
          ? 'available' : ratingUnavailable ? 'unavailable' : ratings!.status === 'selected' ? 'unrated' : ratings!.status,
        ...(value ?? EMPTY_SERIAL_SUMMARY),
        ...(unavailablePreviews.length ? { unavailablePreviews } : {}),
        primaryCredits: authors?.get(id) ?? [] }] as const];
    }));
  }).catch((error: unknown) => {
    if (error instanceof WorkReadMoved) throw new SearchSnapshotMoved(error.message);
    if (error instanceof WorkReadLimit) throw new PublicQueryBudgetExceeded(error.message);
    if (error instanceof WorkReadUnavailable) throw new PublicQueryUnavailable(error.message);
    throw error;
  });
  return { ...page, results: matches.map(match => ({ ...match, ...cards.get(match.work),
    ...(match.rating ? { rating: match.rating } : {}) })) } as T;
}
