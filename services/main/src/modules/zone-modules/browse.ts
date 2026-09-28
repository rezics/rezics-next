import type { Static } from 'typebox';
import { primaryDiscoveryCredits } from '../discovery/credits.ts';
import { readEpochOrder } from '../discovery/lineage.ts';
import { readPublicHubCards } from '../hub/public-card.ts';
import { type ModBrowseRelease, type ModListing, type ModSelection, modReleaseChannel, selectModRelease }
  from '../package/mod-release.ts';
import { ModResolutionUnavailable } from '../package/mod-resolution.ts';
import { RecommendationUnavailable } from '../recommendation/derived-generation.ts';
import { readRealmBasis } from '../realm-reads/read-realm.ts';
import { GRAPHS, WORK_SEMANTIC_TYPES, iri } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, publicWork, WorkReadInvalid, WorkReadUnavailable,
  type WorkReadSession } from '../work/read-session.ts';
import { readSerialSummaries } from '../work/summary-serial.ts';
import { ZONE_BROWSE_COST, type ZoneBrowseFacet, zoneBrowseFacets, type zoneBrowseQuery, type ZoneBrowseSort,
  zoneLengthBands } from './contract.ts';
import { displayZoneCredits, zoneCreditNames } from './read.ts';

type Query = Static<typeof zoneBrowseQuery>;
type Status = 'ongoing' | 'completed' | 'hiatus';

/** One window candidate with what its Conditions and sorts read. */
export interface BrowseCandidate {
  work: string; order: number; title: string; types: string[];
  /** Accepted Concepts, or null when the Realm's Tags could not be read. */
  concepts: string[] | null;
  status: Status | null; words: number | null;
  listing: ModListing | null; updatedAt: string | null;
  /** Newest first, bounded by the package owner; each row is one exact release. */
  releases?: readonly ModBrowseRelease[];
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
const facets: Record<ZoneBrowseFacet, { test: (item: BrowseCandidate, value: string) => boolean;
  values: (item: BrowseCandidate) => readonly string[] }> = {
  type: { test: (item, value) => item.types.includes(value), values: item => item.types },
  concept: { test: (item, value) => item.concepts?.includes(value) ?? false, values: item => item.concepts ?? [] },
  status: { test: (item, value) => item.status === value, values: item => item.status ? [item.status] : [] },
  length: { test: (item, value) => inBand(item.words, value),
    values: item => zoneLengthBands.filter(band => inBand(item.words, band)) },
  modLoader: { test: (item, value) => item.listing?.loaders.includes(value as never) ?? false,
    values: item => item.releases ? [...new Set(item.releases.flatMap(release => release.loaders))]
      : item.listing?.loaders ?? [] },
  modGameVersion: { test: (item, value) => item.listing?.gameVersions.includes(value) ?? false,
    values: item => item.releases ? [...new Set(item.releases.flatMap(release => release.gameVersions))]
      : item.listing?.gameVersions ?? [] },
  // A mod for both sides serves a reader filtering by either.
  modEnvironment: { test: (item, value) => item.listing?.environment === value
    || item.listing?.environment === 'client-and-server',
  values: item => item.releases ? [...new Set(item.releases.flatMap(release =>
    release.environment === 'client-and-server' ? ['client', 'server'] : release.environment ? [release.environment] : []))]
    : !item.listing?.environment ? []
      : item.listing.environment === 'client-and-server' ? ['client', 'server'] : [item.listing.environment] },
  modRequiredDependency: { test: (item, value) => item.releases?.some(release =>
    release.dependencies?.some(dependency => dependency.requirement === 'required' && dependency.id === value)) ?? false,
  values: item => [...new Set(item.releases?.flatMap(release => release.dependencies?.filter(dependency =>
    dependency.requirement === 'required').map(dependency => dependency.id) ?? []) ?? [])] },
};

export type BrowseFilter = Partial<Record<ZoneBrowseFacet, readonly string[]>> & {
  /** None of these Concepts may be accepted for a matching Work. */
  conceptExclude?: readonly string[];
};

export function browseFilter(query: Omit<Query, 'q' | 'sort' | 'limit' | 'cursor' | 'language'>): BrowseFilter {
  return { type: query.type, concept: query.concept, conceptExclude: query.excludeConcept,
    status: query.status,
    length: query.length ? [query.length] : undefined, modLoader: query.loader,
    modGameVersion: query.gameVersion, modEnvironment: query.environment,
    modRequiredDependency: query.requiredDependency };
}

/** The Filter as a FilterDocument: one Condition per chosen Facet, a length as its range. */
type Condition = { facet: Exclude<ZoneBrowseFacet, 'length'>; any: string[] }
  | { facet: 'concept'; none: string[] }
  | { facet: 'length'; range: { min: string; max?: string } };

export function filterDocument(filter: BrowseFilter): { all: Condition[] } {
  const all = zoneBrowseFacets.flatMap((facet): Condition[] => {
    const chosen = filter[facet];
    if (!chosen?.length) return [];
    if (facet !== 'length') return [{ facet, any: [...chosen] }];
    const band = lengthBand(chosen[0]!);
    return [{ facet, range: { min: String(band.min), ...band.max === null ? {} : { max: String(band.max) } } }];
  });
  if (filter.conceptExclude?.length) all.push({ facet: 'concept', none: [...filter.conceptExclude] });
  return { all };
}

const modFacets = ['modLoader', 'modGameVersion', 'modEnvironment', 'modRequiredDependency'] as const;
function modSelection(filter: BrowseFilter, except?: ZoneBrowseFacet): ModSelection {
  return { loaders: except === 'modLoader' ? undefined : filter.modLoader as ModSelection['loaders'],
    gameVersions: except === 'modGameVersion' ? undefined : filter.modGameVersion,
    environments: except === 'modEnvironment' ? undefined : filter.modEnvironment as ModSelection['environments'],
    requiredDependencies: except === 'modRequiredDependency' ? undefined : filter.modRequiredDependency };
}

const holds = (item: BrowseCandidate, filter: BrowseFilter, except?: ZoneBrowseFacet) => {
  if (filter.conceptExclude?.some(value => item.concepts?.includes(value))) return false;
  if (!zoneBrowseFacets.every(facet => modFacets.includes(facet as typeof modFacets[number])
    || facet === except || !filter[facet]?.length
    || filter[facet]!.some(value => facets[facet].test(item, value)))) return false;
  const selection = modSelection(filter, except);
  if (!selection.loaders?.length && !selection.gameVersions?.length && !selection.environments?.length
    && !selection.requiredDependencies?.length) return true;
  return item.releases ? selectModRelease(item.releases, selection) !== null
    : modFacets.every(facet => facet === except || !filter[facet]?.length
      || filter[facet]!.some(value => facets[facet].test(item, value)));
};

/**
 * The matching candidates in the requested order, and each Facet's value
 * counts with every other Facet's Conditions applied (so a reader sees what
 * choosing one more value would leave). Pure: the read's in-memory step.
 */
export function browseWindow(candidates: readonly BrowseCandidate[], filter: BrowseFilter,
  text: string | null, sort: ZoneBrowseSort) {
  const relevance = new Map(candidates.map(item => [item.work, text ? textRelevance(text, item.title) : 1]));
  const found = candidates.filter(item => relevance.get(item.work)! > 0 && holds(item, filter));
  const newest = (a: BrowseCandidate, b: BrowseCandidate) => a.order - b.order;
  const time = (item: BrowseCandidate) => item.updatedAt ? Date.parse(item.updatedAt) : Number.NEGATIVE_INFINITY;
  found.sort(sort === 'relevance' ? (a, b) => relevance.get(b.work)! - relevance.get(a.work)! || newest(a, b)
    : sort === 'updated' ? (a, b) => time(b) - time(a) || newest(a, b) : newest);
  const counts = Object.fromEntries(zoneBrowseFacets.map(facet => {
    const tally = new Map<string, number>();
    for (const item of candidates) {
      if (relevance.get(item.work)! > 0 && holds(item, filter, facet)) {
        for (const value of new Set(facets[facet].values(item))) {
          if (modFacets.includes(facet as typeof modFacets[number])
            && !holds(item, { ...filter, [facet]: [value] })) continue;
          tally.set(value, (tally.get(value) ?? 0) + 1);
        }
      }
    }
    // Chosen values stay listed even when nothing matches them, so they can be cleared.
    for (const value of filter[facet] ?? []) if (!tally.has(value)) tally.set(value, 0);
    if (facet === 'concept') for (const value of filter.conceptExclude ?? []) {
      if (!tally.has(value)) tally.set(value, 0);
    }
    const listed = [...tally].map(([value, count]) => ({ value, count }));
    // Length bands keep their own order; other values list the most common first.
    return [facet, facet === 'length'
      ? listed.sort((a, b) => zoneLengthBands.indexOf(a.value as never) - zoneLengthBands.indexOf(b.value as never))
      : listed.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))];
  })) as Record<ZoneBrowseFacet, { value: string; count: number }[]>;
  return { found, facets: counts };
}

const later = (a: string | null | undefined, b: string | null | undefined) =>
  !a ? b ?? null : !b ? a : Date.parse(a) >= Date.parse(b) ? a : b;

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

/**
 * A Zone's browse page. One candidate query reads the Realm's newest
 * ZONE_BROWSE_COST.windowRows public adoptions with their completion status
 * (the graph sorts D Realm decisions, O(D log D), as the other module reads
 * do); one type query, one summary batch, one listing batch, one serial
 * statistics batch and one Tags batch read the window; one page of at most 20
 * is hydrated with its serial summaries, credits, names and Hub cards, then
 * fenced by a second summary batch. A third names at most 60 Concepts.
 */
export async function readZoneBrowse(session: WorkReadSession, realm: string, query: Query) {
  await readRealmBasis(session, realm);
  const text = query.q?.trim() ? query.q.trim() : null;
  const sort: ZoneBrowseSort = query.sort ?? (text ? 'relevance' : 'newest');
  if (sort === 'relevance' && !text) throw new WorkReadInvalid('Relevance needs search text');
  if (query.type?.some(type => !(WORK_SEMANTIC_TYPES as readonly string[]).includes(type))) {
    throw new WorkReadInvalid('Work type is not admitted');
  }
  const filter = browseFilter(query);
  if (!session.deps.packageModResolutions && (filter.modGameVersion?.length || filter.modLoader?.length
    || filter.modEnvironment?.length || filter.modRequiredDependency?.length)) {
    throw new WorkReadUnavailable('Mod compatibility owner is unavailable');
  }
  if (query.length) {
    const band = lengthBand(query.length);
    if (band.max !== null && band.max < band.min) throw new WorkReadInvalid('Length range is empty');
  }
  const limit = session.options.limit ?? ZONE_BROWSE_COST.pageSize;
  const binding = ['zone-browse-v1', realm, text, sort, filterDocument(filter), session.options.language ?? null];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  const offset = cursor ? Number(cursor.after) : 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= ZONE_BROWSE_COST.windowRows) {
    throw new WorkReadInvalid('Zone browse cursor is invalid');
  }
  const epochs = await readEpochOrder(session);
  const rows = await session.query(`SELECT DISTINCT ?work ?head ?main ?evidence ?revisionEpoch
    ?sequence ?epochOrder ?status WHERE {
    ${epochs}
    GRAPH ${iri(GRAPHS.current)} {
      ?slot a rv:RealmPublicationSlot ; rv:realm ${iri(realm)} ; rv:work ?work ;
        rv:mainVersion ?main ; rv:selectionHead ?evidence .
      ?work rv:head ?head .
      OPTIONAL { ?work rv:completionStatus ?status }
      ?contribution rv:publicationHead ?decision . }
    GRAPH ${iri(GRAPHS.revisions)} { ?evidence a rv:PublicationSelection ;
      rv:component ?slot ; rv:context ${iri(realm)} ; rv:work ?work ;
      rv:mainVersion ?main ; rv:contribution ?contribution ;
      rv:publicationDecision ?decision ; rv:selectedDraft ?draft ;
      rv:dataEpoch ?revisionEpoch ; rv:sequence ?sequence .
      ?decision rv:disclosure rv:Public .
      FILTER NOT EXISTS { ?draft a rv:ErasedRevision } }
    ${publicWork('?work', '?main')}
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?work schema:isPartOf ?book } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
      ?chapterStructure a rv:Structure ; rv:structureProfile rv:BookComposition ;
        rv:selectedGeneration ?chapterGeneration .
      ?chapterPlacement a rv:OccurrencePlacement ; rv:generation ?chapterGeneration ;
        rv:occurrenceRole rv:ChapterRole ; schema:item ?work .
      FILTER NOT EXISTS { ?chapterPlacement rv:removedBy ?chapterRemoval }
    } }
  } ORDER BY ?epochOrder DESC(?sequence) STR(?evidence) LIMIT ${ZONE_BROWSE_COST.windowRows + 1}`,
  ZONE_BROWSE_COST.windowRows + 1);
  if (rows.some(row => !row.work || !row.head || !row.main || !row.evidence || !row.revisionEpoch
    || !/^\d+$/.test(row.sequence?.value ?? '') || !/^\d+$/.test(row.epochOrder?.value ?? '')
    || row.status && !['ongoing', 'completed', 'hiatus'].includes(row.status.value))
    || new Set(rows.map(row => row.work!.value)).size !== rows.length) {
    throw new WorkReadUnavailable('Zone browse candidates are ambiguous');
  }
  const window = rows.slice(0, ZONE_BROWSE_COST.windowRows), ids = window.map(row => row.work!.value);
  const typeRows = ids.length ? await session.query(`SELECT ?work ?type WHERE {
    VALUES ?work { ${ids.map(iri).join(' ')} }
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
  const [summaries, listings, stats, tags] = await Promise.all([session.summaries(ids),
    session.deps.packageModResolutions?.readBrowseListings(ids).catch(error => {
      if (error instanceof ModResolutionUnavailable) throw new WorkReadUnavailable(error.message);
      throw error;
    }) ?? new Map(),
    session.deps.serialStats?.batch(ids, session.position.sequence)
      ?? new Map<string, { wordCount: number | null; lastUpdatedAt: string | null }>(),
    readTags(session, realm, ids)]);
  if ((filter.concept?.length || filter.conceptExclude?.length) && tags.state === 'unavailable') {
    throw new WorkReadUnavailable('Zone Tags are unavailable');
  }
  const candidates = window.flatMap((row, order): BrowseCandidate[] => {
    const summary = summaries[order], work = row.work!.value;
    if (summary?.status !== 'available' || summary.disclosure !== 'public') return [];
    const mod = listings.get(work), listing = mod?.listing ?? null, stat = stats.get(work);
    return [{ work, order, title: summary.name.value, types: types.get(work) ?? [],
      concepts: tags.state === 'unavailable' ? null : tags.concepts.get(work) ?? [],
      status: (row.status?.value ?? null) as Status | null, words: stat?.wordCount ?? null, listing,
      releases: mod?.releases ?? [],
      updatedAt: later(listing?.updatedAt, stat?.lastUpdatedAt) }];
  });
  const { found: matched, facets: counts } = browseWindow(candidates, filter, text, sort);
  // Tags built before the latest change are not applied, as Discover withholds its term matches.
  const found = (filter.concept?.length || filter.conceptExclude?.length) && tags.state !== 'current' ? [] : matched;
  const page = found.slice(offset, offset + limit), pageIds = page.map(item => item.work);
  const conceptIds = [...new Set([...(filter.concept ?? []), ...(filter.conceptExclude ?? []),
    ...counts.concept.map(item => item.value)])].slice(0, ZONE_BROWSE_COST.windowRows);
  const [serial, conceptNames] = await Promise.all([readSerialSummaries(session, page.flatMap(item => {
    const summary = summaries[item.order];
    return summary?.status === 'available' && summary.type === 'work' ? [item.work] : [];
  })), session.summaries(conceptIds)]);
  const hydrated = await Promise.all(page.map(async item => {
    const row = window[item.order]!, summary = summaries[item.order]!;
    if (summary.status !== 'available') throw new WorkReadUnavailable('Zone browse summary moved');
    const facts = serial.get(item.work);
    if (!facts) throw new WorkReadUnavailable('Zone browse Work metadata is incomplete');
    return { id: item.work, revision: row.head!.value, mainVersion: row.main!.value, title: summary.name,
      cover: summary.avatar, types: item.types, ...facts,
      primaryCredits: await primaryDiscoveryCredits(session, item.work), evidence: row.evidence!.value,
      dataEpoch: row.revisionEpoch!.value, sequence: row.sequence!.value };
  }));
  const [hub, names, fenced] = await Promise.all([
    session.deps.hub && session.deps.content ? readPublicHubCards(session, pageIds) : new Map(),
    zoneCreditNames(session, hydrated.flatMap(item => item.primaryCredits)),
    session.summaries(pageIds)]);
  if (fenced.some(summary => summary?.status !== 'available' || summary.disclosure !== 'public')) {
    throw new WorkReadUnavailable('Zone browse Work changed disclosure during the read');
  }
  const candidatesByWork = new Map(page.map(item => [item.work, item] as const));
  const items = hydrated.map(item => ({ ...item,
    primaryCredits: displayZoneCredits(item.primaryCredits, names.agents, names.sources),
    mod: candidatesByWork.get(item.id)?.listing ? { ...candidatesByWork.get(item.id)!.listing!, selected: (() => {
      const releases = candidatesByWork.get(item.id)?.releases ?? [];
      if (filter.modGameVersion?.length !== 1 || filter.modLoader?.length !== 1
        || filter.modEnvironment?.length !== 1) return null;
      const selected = selectModRelease(releases, modSelection(filter));
      return selected ? { version: selected.version, gameVersions: selected.gameVersions,
        loaders: selected.loaders, environment: selected.environment,
        side: filter.modEnvironment![0] as 'client' | 'server', publishedAt: selected.publishedAt,
        channel: modReleaseChannel(selected.version), dependencies: selected.dependencies,
        state: selected === releases[0] ? 'compatible' as const : 'stale' as const } : null;
    })() } : null, hub: hub.get(item.id) ?? null }));
  // A Concept shows under its public name only; one without is left out rather than shown as an IRI.
  const namedConcepts = new Map(conceptIds.map((concept, index) => [concept, conceptNames[index]] as const));
  const concept = counts.concept.flatMap(item => {
    const summary = namedConcepts.get(item.value);
    return summary?.status === 'available' && summary.disclosure === 'public' && summary.type === 'concept'
      ? [{ ...item, name: summary.name }] : [];
  });
  await readRealmBasis(session, realm);
  const complete = rows.length <= ZONE_BROWSE_COST.windowRows;
  const next = offset + limit < found.length ? encodeReadCursor(binding, session.position, String(offset + limit)) : null;
  return { profile: 'zone-browse-v1' as const, realm,
    query: { text, sort, filter: filterDocument(filter) }, facets: { ...counts, concept }, tags: tags.state,
    matches: { value: found.length, kind: complete ? 'exact' as const : 'lower-bound' as const },
    window: { scanned: window.length, complete }, ...pageResult(session, items, next) };
}
