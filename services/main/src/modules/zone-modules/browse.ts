import { zoneCards } from './cards.ts';
import { zoneAdoption } from './adoption.ts';
import type { Static } from 'typebox';
import { primaryDiscoveryCreditBatch } from '../discovery/credits.ts';
import type { BrowseAfter, BrowseEntry } from '../zone-browse/store.ts';
import { readPublicHubCards } from '../hub/public-card.ts';
import { compileQuery, QueryRejected } from '../query/compile.ts';
import { publicationYearBoundsError } from '../query/year-fact.ts';
import { acceptedStatementPattern } from '../statement/subject-read.ts';
import { GLOBAL_CLASSIFICATION_CONTEXT } from '../classification/context.ts';
import { RecommendationUnavailable } from '../recommendation/derived-generation.ts';
import { readRealmBasis } from '../realm-reads/read-realm.ts';
import { GRAPHS, WORK_SEMANTIC_TYPES, iri } from '../work/activate.ts';
import { serialStatuses, type SerialStatus } from '../work/metadata-schema.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, publicWork, WorkReadExpired, WorkReadInvalid, WorkReadUnavailable,
  type WorkReadSession, type ReadRow } from '../work/read-session.ts';
import { readSerialSummaries, readSerialStatistics } from '../work/summary-serial.ts';
import { ZONE_BROWSE_COST, type zoneBrowseQuery, type ZoneBrowseSort, zoneLengthBands } from './contract.ts';
import { displayZoneCredits, zoneCreditNames } from './read.ts';

type Query = Static<typeof zoneBrowseQuery> & { excludeStatus?: Status[] };
type BrowseFacet = keyof Static<typeof import('./contract.ts').zoneBrowsePage>['facets'];
type Status = SerialStatus;

/** One batch candidate with what its Conditions and sorts read. */
export interface BrowseCandidate {
  work: string; order: number; title: string; types: string[];
  /** Accepted Concepts, or null when the Realm's Tags could not be read. */
  concepts: string[] | null;
  status: Status | null; words: number | null;
  updatedAt: string | null;
}

const fold = (text: string) => text.normalize('NFKC').toLocaleLowerCase('und').replace(/\s+/g, ' ').trim();

/** How well a title answers the text: whole title, its start, a word's start, anywhere; 0 is no match. */
export function textRelevance(text: string, title: string): number {
  const query = fold(text), name = fold(title);
  if (!query) return 0;
  if (name === query) return 4;
  if (name.startsWith(query)) return 3;
  if (name.split(/[\s\p{P}]+/u).some(word => word.startsWith(query))) return 2;
  return name.includes(query) ? 1 : 0;
}

/** A `min-max` length band (max optional) as inclusive bounds. */
export function lengthBand(value: string): { min: number; max: number | null } {
  const [min, max] = value.split('-');
  return { min: Number(min), max: max ? Number(max) : null };
}
const inBand = (words: number | null, value: string) => {
  const band = lengthBand(value);
  return words !== null && words >= band.min && (band.max === null || words <= band.max);
};

/** Each Facet's test for one candidate and the values it counts for; an empty selection holds for every candidate. */
const facets: Record<BrowseFacet, { test: (item: BrowseCandidate, value: string) => boolean;
  values: (item: BrowseCandidate) => readonly string[] }> = {
  type: { test: (item, value) => item.types.includes(value), values: item => item.types },
  concept: { test: (item, value) => item.concepts?.includes(value) ?? false, values: item => item.concepts ?? [] },
  status: { test: (item, value) => item.status === value, values: item => item.status ? [item.status] : [] },
  length: { test: (item, value) => inBand(item.words, value),
    values: item => zoneLengthBands.filter(band => inBand(item.words, band)) },
};

export interface BrowseFilter {
  type?: readonly string[]; concept?: readonly string[]; status?: readonly string[];
  length?: { min?: string; max?: string };
  publicationYear?: { min: string; max: string };
  conceptExclude?: readonly string[]; statusExclude?: readonly string[];
}

export function browseFilter(query: Query): BrowseFilter {
  const [min, max] = query.length?.split('-') ?? [];
  const [from, to = from] = query.publicationYear?.split('-') ?? [];
  return { type: query.type, concept: query.concept, conceptExclude: query.excludeConcept,
    publicationYear: from === undefined ? undefined : { min: from, max: to! },
    status: query.status, statusExclude: query.excludeStatus,
    length: query.length === undefined ? undefined : { ...(min ? { min } : {}), ...(max ? { max } : {}) } };
}

type Condition = { facet: 'type' | 'concept' | 'status'; any: string[] }
  | { facet: 'concept' | 'status'; none: string[] }
  | { facet: 'length' | 'publicationYear'; range: { min?: string; max?: string } };

/** The applied Conditions, including exclusions, never depend on count buckets. */
export function filterDocument(filter: BrowseFilter): { all: Condition[] } {
  const all: Condition[] = [];
  for (const facet of ['type', 'concept', 'status'] as const) {
    if (filter[facet]?.length) all.push({ facet, any: [...filter[facet]!] });
  }
  if (filter.length) all.push({ facet: 'length', range: { ...filter.length } });
  if (filter.publicationYear) all.push({ facet: 'publicationYear', range: { ...filter.publicationYear } });
  if (filter.conceptExclude?.length) all.push({ facet: 'concept', none: [...filter.conceptExclude] });
  if (filter.statusExclude?.length) all.push({ facet: 'status', none: [...filter.statusExclude] });
  return { all };
}

/** GET is an adapter to the same admission as POST /v1/query, before any read session exists. */
export function compileZoneBrowse(realm: string, query: Query): ReturnType<typeof compileQuery> {
  const controls = ['language', 'limit', 'cursor', 'q', 'sort', 'type', 'concept', 'excludeConcept',
    'status', 'excludeStatus', 'length', 'publicationYear'];
  if (Object.keys(query).some(key => !controls.includes(key))) {
    throw new QueryRejected('unsupported_query_shape', 'Zone browse parameter has no admitted Facet');
  }
  if (query.publicationYear !== undefined) {
    const [from, to = from] = query.publicationYear.split('-').map(Number);
    const error = publicationYearBoundsError(from, to);
    if (!/^[1-9][0-9]{0,3}(-[1-9][0-9]{0,3})?$/.test(query.publicationYear) || error) {
      throw new QueryRejected('invalid_query', error ?? 'Publication year range is invalid');
    }
  }
  const text = query.q?.trim();
  return compileQuery({ profile: 'filter-document-v2', context: { realm }, scope: { kind: 'realm', realm },
    filter: filterDocument(browseFilter(query)), ...(text ? { text: { phrase: text } } : {}),
    sort: query.sort ?? (text ? 'relevance' : 'newest'),
    page: { size: query.limit ?? ZONE_BROWSE_COST.pageSize, continuation: query.cursor } });
}

/** Kernel's canonical acceptance for active, globally accepted date-published facts.
 * EXISTS keeps multiple Statements for a Work from duplicating its browse row. */
function publicationYearFilter(value: string | undefined): string {
  if (value === undefined) return '';
  const [from, to = from] = value.split('-').map(Number);
  // Bind the helper's Statement and meaningKey before either acceptance branch.
  // Namespace all aliases so they cannot correlate with the Realm adoption.
  const accepted = acceptedStatementPattern(GLOBAL_CLASSIFICATION_CONTEXT, false)
    .replace(/\?([A-Za-z]\w*)/g, (_, variable: string) => `?year${variable}`);
  return `FILTER EXISTS {
    GRAPH ${iri(GRAPHS.current)} {
      ?yearstatement a rdf:Statement ; rdf:subject ?work ; rdf:predicate schema:datePublished ;
        rdf:object ?published ; rv:statementState rv:Active ; rv:head ?yearHead ; rv:meaningKey ?yearkey .
    }
    ${accepted}
    FILTER(DATATYPE(?published) IN (<http://www.w3.org/2001/XMLSchema#gYear>,
      <http://www.w3.org/2001/XMLSchema#date>, <http://www.w3.org/2001/XMLSchema#dateTime>))
    FILTER(YEAR(?published) >= ${from} && YEAR(?published) <= ${to})
  }`;
}

const holds = (item: BrowseCandidate, filter: BrowseFilter, except?: BrowseFacet) => {
  // Exclusions remain active while the counted Facet's included values are ignored.
  if (filter.conceptExclude?.some(value => item.concepts?.includes(value))) return false;
  if (filter.statusExclude?.some(value => item.status === value)) return false;
  if (except !== 'length' && filter.length && (item.words === null
    || (filter.length.min !== undefined && item.words < Number(filter.length.min))
    || (filter.length.max !== undefined && item.words > Number(filter.length.max)))) return false;
  return (['type', 'concept', 'status'] as const).every(facet => facet === except || !filter[facet]?.length
    || filter[facet]!.some(value => facets[facet].test(item, value)));
};

/**
 * The matching candidates in the requested order, and each Facet's value
 * counts with every other Facet's Conditions applied (so a reader sees what
 * choosing one more value would leave). Pure: the read's in-memory step.
 */
export function browseCandidates(candidates: readonly BrowseCandidate[], filter: BrowseFilter,
  text: string | null, sort: ZoneBrowseSort) {
  const relevance = new Map(candidates.map(item => [item.work, text ? textRelevance(text, item.title) : 1]));
  const found = candidates.filter(item => relevance.get(item.work)! > 0 && holds(item, filter));
  const newest = (a: BrowseCandidate, b: BrowseCandidate) => a.order - b.order;
  const time = (item: BrowseCandidate) => item.updatedAt ? Date.parse(item.updatedAt) : Number.NEGATIVE_INFINITY;
  found.sort(sort === 'relevance' ? (a, b) => relevance.get(b.work)! - relevance.get(a.work)! || newest(a, b)
    : sort === 'updated' ? (a, b) => time(b) - time(a) || newest(a, b) : newest);
  const counts = Object.fromEntries((Object.keys(facets) as BrowseFacet[]).map(facet => {
    const tally = new Map<string, number>();
    for (const item of candidates) {
      if (relevance.get(item.work)! > 0 && holds(item, filter, facet)) {
        for (const value of new Set(facets[facet].values(item))) {
          tally.set(value, (tally.get(value) ?? 0) + 1);
        }
      }
    }
    // Chosen values stay listed even when nothing matches them, so they can be cleared.
    for (const value of facet === 'length' ? [] : filter[facet] ?? []) if (!tally.has(value)) tally.set(value, 0);
    if (facet === 'concept') for (const value of filter.conceptExclude ?? []) {
      if (!tally.has(value)) tally.set(value, 0);
    }
    if (facet === 'status') for (const value of filter.statusExclude ?? []) {
      if (!tally.has(value)) tally.set(value, 0);
    }
    const listed = [...tally].map(([value, count]) => ({ value, count }));
    // Length bands keep their own order; other values list the most common first.
    return [facet, facet === 'length'
      ? listed.sort((a, b) => zoneLengthBands.indexOf(a.value as never) - zoneLengthBands.indexOf(b.value as never))
      : listed.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))];
  })) as Record<BrowseFacet, { value: string; count: number }[]>;
  return { found, facets: counts };
}

/** The window's accepted Concepts from the Realm's Discovery projection, as Discover's Realm scope reads them. */
async function readTags(session: WorkReadSession, realm: string, works: readonly string[]):
  Promise<{ state: 'current' | 'stale' | 'unavailable'; concepts: Map<string, string[]> }> {
  const projection = session.deps.discovery;
  if (!projection) return { state: 'unavailable', concepts: new Map() };
  try {
    const active = await projection.active({ scope: 'realm', realm, context: null, owner: null }, session.position);
    const concepts = new Map<string, string[]>();
    for (const row of await projection.workTerms(active, works)) {
      if (!works.includes(row.work) || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(row.concept ?? '')) {
        throw new WorkReadUnavailable('Zone browse Tags are inconsistent');
      }
      concepts.set(row.work, [...new Set([...concepts.get(row.work) ?? [], row.concept])]);
    }
    return { state: active.stale ? 'stale' : 'current', concepts };
  } catch (error) {
    if (error instanceof RecommendationUnavailable) return { state: 'unavailable', concepts: new Map() };
    throw error;
  }
}

export async function readBrowseBatch(session: WorkReadSession, realm: string, ids: string[],
  filter: BrowseFilter, entries?: Map<string, BrowseEntry>, publicationYear?: string) {
  if (!ids.length) return { candidates: [] as BrowseCandidate[], tags: 'unavailable' as const,
    rows: new Map<string, ReadRow>(), summaries: new Map<string, Awaited<ReturnType<WorkReadSession['summaries']>>[number]>() };
  const rows = await session.query(`SELECT DISTINCT ?work ?head ?main ?evidence ?revisionEpoch
    ?sequence ?status WHERE {
    VALUES ?work { ${ids.map(iri).join(" ")} }
    { ${zoneAdoption(realm, session.options.language)} }
    BIND(?selection AS ?evidence)
    GRAPH ${iri(GRAPHS.revisions)} { ?evidence rv:dataEpoch ?revisionEpoch ; rv:sequence ?sequence . }
    GRAPH ${iri(GRAPHS.current)} { ?work rv:head ?head . OPTIONAL { ?work rv:completionStatus ?status } }
    ${publicWork('?work', '?main')}
    ${publicationYearFilter(publicationYear)}
  } LIMIT ${ids.length + 1}`, ids.length);
  if (rows.some(row => !row.work || !row.head || !row.main || !row.evidence || !row.revisionEpoch
    || !/^\d+$/.test(row.sequence?.value ?? '')
    || row.status && !(serialStatuses as readonly string[]).includes(row.status.value))
    || new Set(rows.map(row => row.work!.value)).size !== rows.length) {
    throw new WorkReadUnavailable('Zone browse candidates are ambiguous');
  }
  const byWork = new Map(rows.map(row => [row.work!.value, row]));
  const visibleIds = ids.filter(work => byWork.has(work));
  const typeRows = visibleIds.length ? await session.query(`SELECT ?work ?type WHERE {
    VALUES ?work { ${visibleIds.map(iri).join(' ')} }
    VALUES ?type { ${WORK_SEMANTIC_TYPES.map(type => `<${type}>`).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?work a ?type }
  } LIMIT ${ZONE_BROWSE_COST.typeRows + 1}`, ZONE_BROWSE_COST.typeRows) : [];
  const types = new Map<string, string[]>();
  for (const row of typeRows) {
    if (!row.work || !row.type || !ids.includes(row.work.value)) {
      throw new WorkReadUnavailable('Zone browse type relation is incomplete');
    }
    types.set(row.work.value, [...types.get(row.work.value) ?? [], row.type.value].sort());
  }
  const [summaries, stats, tags] = await Promise.all([session.summaries(visibleIds),
    readSerialStatistics(session, visibleIds).then(stats =>
      stats ?? new Map<string, { wordCount: number | null; lastUpdatedAt: string | null }>()),
    readTags(session, realm, visibleIds)]);
  // An older classification cut cannot prove absence, including exclusions.
  // Keep the existing unavailable answer until the owner has current Tags.
  if ((filter.concept?.length || filter.conceptExclude?.length) && tags.state !== 'current') {
    throw new WorkReadUnavailable('Zone Tags are unavailable');
  }
  const candidates = visibleIds.flatMap((work, order): BrowseCandidate[] => {
    const summary = summaries[order], row = byWork.get(work)!;
    if (summary?.status !== 'available' || summary.disclosure !== 'public') return [];
    const stat = stats.get(work);
    const entry = entries?.get(work);
    return [{ work, order, title: summary.name.value, types: types.get(work) ?? [],
      concepts: tags.state === 'unavailable' ? null : tags.concepts.get(work) ?? [],
      status: (row.status?.value ?? null) as Status | null, words: entry ? entry.words : stat?.wordCount ?? null,
      updatedAt: entry ? entry.updatedAt : stat?.lastUpdatedAt ?? null }];
  });
  return { candidates, tags: tags.state, rows: byWork,
    summaries: new Map(visibleIds.map((work, index) => [work, summaries[index]!])) };
}

/** Each request seeks at most four 64-row batches and hydrates at most 20
 * Works. Filters may yield an empty page with a continuation: a request budget
 * never becomes a Realm population limit. Cursor keys address examined rows. */
export async function readZoneBrowse(session: WorkReadSession, realm: string, query: Query) {
  const plan = compileZoneBrowse(realm, query);
  if (plan.template !== 'zone-browse') throw new QueryRejected('unsupported_query_shape', 'Zone browse needs a Realm plan');
  await readRealmBasis(session, realm);
  const text = query.q?.trim() || null;
  const sort: ZoneBrowseSort = query.sort ?? (text ? 'relevance' : 'newest');
  // Ranked catalogue search indexes body text, not titles. Until a title
  // index exists, relevance requests traverse title matches in adoption order.
  const appliedSort = sort === 'relevance' ? 'newest' : sort;
  const filter = browseFilter(query);
  const limit = session.options.limit ?? ZONE_BROWSE_COST.pageSize;
  const binding = ['zone-browse-v3', realm, text, sort, filterDocument(filter), session.options.language ?? null];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position, appliedSort === 'newest');
  let prior: { after: BrowseAfter | null; current: boolean; visible: number } = { after: null, current: true, visible: 0 };
  if (cursor) {
    try {
      prior = JSON.parse(cursor.after) as typeof prior;
      if (!Number.isSafeInteger(prior.visible) || prior.visible < 0
        || prior.after && (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(prior.after.work)
          || prior.after.key !== null && typeof prior.after.key !== 'string')
        || typeof prior.current !== 'boolean') throw new Error('cursor');
    } catch { throw new WorkReadInvalid('Zone browse cursor is invalid'); }
  }
  const rows = new Map<string, ReadRow>();
  const summaries = new Map<string, Awaited<ReturnType<WorkReadSession['summaries']>>[number]>();
  const examined: BrowseCandidate[] = [], page: BrowseCandidate[] = [];
  let tags: 'current' | 'stale' | 'unavailable' = 'unavailable';
  let after = prior.after, more = false;
  const evaluate = async (ids: string[], entries?: Map<string, BrowseEntry>) => {
    const batch = await readBrowseBatch(session, realm, ids, filter, entries, plan.request.publicationYear);
    tags = batch.tags;
    for (const [work, row] of batch.rows) rows.set(work, row);
    for (const [work, summary] of batch.summaries) summaries.set(work, summary);
    const found = new Set(browseCandidates(batch.candidates, filter,
      text, appliedSort).found.map(item => item.work));
    return { candidates: batch.candidates, found };
  };
  const projection = session.deps.zoneBrowse;
  if (!projection) throw new WorkReadUnavailable('Zone browse projection is unavailable');
  if (!prior.current) throw new WorkReadExpired('Zone browse inventory changed; restart from a current projection');
  let current = prior.current && await projection.current(session.position);
  // A lagging index can omit an admitted selection ahead of the seek key.
  // First readers get an incomplete lower bound at the actual graph read
  // position; a continuation must restart rather than skip that missing prefix.
  if (!current && cursor) throw new WorkReadExpired('Zone browse inventory changed; restart from a current projection');
  for (let batchIndex = 0; current && batchIndex < ZONE_BROWSE_COST.batches; batchIndex++) {
    const entries = await projection.batch(realm, appliedSort, after, session.position);
    if (!entries.length) { more = false; break; }
    const batch = await evaluate(entries.map(item => item.work), new Map(entries.map(item => [item.work, item])));
    const candidates = new Map(batch.candidates.map(item => [item.work, item]));
    for (const [index, entry] of entries.entries()) {
      const candidate = candidates.get(entry.work);
      if (candidate && batch.found.has(entry.work) && page.length === limit) { more = true; break; }
      if (candidate) examined.push(candidate);
      if (candidate && batch.found.has(entry.work)) page.push(candidate);
      after = { work: entry.work, key: appliedSort === 'newest' ? entry.adoptedOrder : entry.updatedAt };
      more = index + 1 < entries.length || entries.length === ZONE_BROWSE_COST.batchRows;
    }
    if (!more || page.length === limit) break;
  }
  current = current && await projection.current(session.position);
  const counts = browseCandidates(examined, filter, text, appliedSort).facets;
  const pageIds = page.map(item => item.work);
  const conceptIds = [...new Set([...(filter.concept ?? []), ...(filter.conceptExclude ?? []),
    ...counts.concept.map(item => item.value)])].slice(0, ZONE_BROWSE_COST.batchRows);
  const [serial, conceptNames, credits] = await Promise.all([readSerialSummaries(session, page.flatMap(item => {
    const summary = summaries.get(item.work);
    return summary?.status === 'available' && summary.type === 'work' ? [item.work] : [];
  })), session.summaries(conceptIds), primaryDiscoveryCreditBatch(session, pageIds)]);
  const hydrated = page.map(item => {
    const row = rows.get(item.work)!, summary = summaries.get(item.work)!;
    if (summary.status !== 'available') throw new WorkReadUnavailable('Zone browse summary moved');
    const facts = serial.get(item.work);
    if (!facts) throw new WorkReadUnavailable('Zone browse Work metadata is incomplete');
    return { id: item.work, revision: row.head!.value, mainVersion: row.main!.value, title: summary.name,
      cover: summary.avatar, types: item.types, ...facts,
      primaryCredits: credits.get(item.work)!, evidence: row.evidence!.value,
      dataEpoch: row.revisionEpoch!.value, sequence: row.sequence!.value };
  });
  const [hub, names, fenced] = await Promise.all([
    session.deps.hub && session.deps.content ? readPublicHubCards(session, pageIds) : new Map(),
    zoneCreditNames(session, hydrated.flatMap(item => item.primaryCredits)),
    session.summaries(pageIds)]);
  if (fenced.some(summary => summary?.status !== 'available' || summary.disclosure !== 'public')) {
    throw new WorkReadUnavailable('Zone browse Work changed disclosure during the read');
  }
  const items = await zoneCards(session, { realm }, hydrated.map(item => ({ ...item,
    primaryCredits: displayZoneCredits(item.primaryCredits, names.agents, names.sources),
    hub: hub.get(item.id) ?? null })));
  // A Concept shows under its public name only; one without is left out rather than shown as an IRI.
  const namedConcepts = new Map(conceptIds.map((concept, index) => [concept, conceptNames[index]] as const));
  const concept = counts.concept.flatMap(item => {
    const summary = namedConcepts.get(item.value);
    return summary?.status === 'available' && summary.disclosure === 'public' && summary.type === 'concept'
      ? [{ ...item, name: summary.name }] : [];
  });
  await readRealmBasis(session, realm);
  const complete = !more && current;
  const visible = prior.visible + page.length;
  const next = more && current ? encodeReadCursor(binding, session.position,
    JSON.stringify({ after, current, visible }), '', cursor?.expiresAt ?? Date.now() + 300_000) : null;
  return { profile: 'zone-browse-v1' as const, realm,
    query: { text, sort, appliedSort, textMatch: text ? 'title' as const : 'none' as const,
      ...plan.request.publicationYear !== undefined ? { publicationYear: plan.request.publicationYear } : {},
      filter: filterDocument(filter) }, facets: { ...counts, concept }, tags,
    matches: { value: visible, kind: complete ? 'exact' as const : 'lower-bound' as const },
    window: { scanned: examined.length, complete }, ...pageResult(session, items, next) };
}
