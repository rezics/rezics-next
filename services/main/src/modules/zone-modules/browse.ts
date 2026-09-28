import type { Static } from 'typebox';
import { primaryDiscoveryCredits } from '../discovery/credits.ts';
import { readEpochOrder } from '../discovery/lineage.ts';
import { readPublicHubCards } from '../hub/public-card.ts';
import type { ModListing } from '../package/mod-release.ts';
import { readRealmBasis } from '../realm-reads/read-realm.ts';
import { GRAPHS, WORK_SEMANTIC_TYPES, iri } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, publicWork, WorkReadInvalid, WorkReadUnavailable,
  type WorkReadSession } from '../work/read-session.ts';
import { readSerialSummaries } from '../work/summary-serial.ts';
import { ZONE_BROWSE_COST, type ZoneBrowseFacet, type zoneBrowseQuery, type ZoneBrowseSort }
  from './contract.ts';
import { displayZoneCredits, zoneCreditNames } from './read.ts';

type Query = Static<typeof zoneBrowseQuery>;

/** One window candidate with what its Conditions and sorts read. */
export interface BrowseCandidate {
  work: string; order: number; title: string; types: string[];
  listing: ModListing | null; updatedAt: string | null;
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

/** Each Facet's test for one candidate; an empty selection holds for every candidate. */
const tests: Record<ZoneBrowseFacet, (item: BrowseCandidate, value: string) => boolean> = {
  type: (item, value) => item.types.includes(value),
  'mod-loader': (item, value) => item.listing?.loaders.includes(value as never) ?? false,
  'mod-game-version': (item, value) => item.listing?.gameVersions.includes(value) ?? false,
  // A mod for both sides serves a reader filtering by either.
  'mod-environment': (item, value) => item.listing?.environment === value
    || item.listing?.environment === 'client-and-server',
};
const valuesOf: Record<ZoneBrowseFacet, (item: BrowseCandidate) => readonly string[]> = {
  type: item => item.types,
  'mod-loader': item => item.listing?.loaders ?? [],
  'mod-game-version': item => item.listing?.gameVersions ?? [],
  'mod-environment': item => !item.listing?.environment ? []
    : item.listing.environment === 'client-and-server' ? ['client', 'server'] : [item.listing.environment],
};

export type BrowseFilter = Partial<Record<ZoneBrowseFacet, readonly string[]>>;

export function browseFilter(query: Pick<Query, 'type' | 'loader' | 'gameVersion' | 'environment'>): BrowseFilter {
  return { type: query.type, 'mod-loader': query.loader, 'mod-game-version': query.gameVersion,
    'mod-environment': query.environment };
}

const holds = (item: BrowseCandidate, filter: BrowseFilter, except?: ZoneBrowseFacet) =>
  (Object.keys(tests) as ZoneBrowseFacet[]).every(facet => facet === except || !filter[facet]?.length
    || filter[facet]!.some(value => tests[facet](item, value)));

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
  const facets = Object.fromEntries((Object.keys(tests) as ZoneBrowseFacet[]).map(facet => {
    const counts = new Map<string, number>();
    for (const item of candidates) {
      if (relevance.get(item.work)! > 0 && holds(item, filter, facet)) {
        for (const value of new Set(valuesOf[facet](item))) counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
    // Chosen values stay listed even when nothing matches them, so they can be cleared.
    for (const value of filter[facet] ?? []) if (!counts.has(value)) counts.set(value, 0);
    return [facet, [...counts].map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))];
  })) as Record<ZoneBrowseFacet, { value: string; count: number }[]>;
  return { found, facets };
}

const later = (a: string | null | undefined, b: string | null | undefined) =>
  !a ? b ?? null : !b ? a : Date.parse(a) >= Date.parse(b) ? a : b;

/**
 * A Zone's browse page. One candidate query reads the Realm's newest
 * ZONE_BROWSE_COST.windowRows public adoptions (the graph sorts D Realm
 * decisions, O(D log D), as the other module reads do); one type query, one
 * summary batch, one listing batch and one serial statistics batch read the
 * window; one page of at most 20 is hydrated with its serial summaries,
 * credits, names and Hub cards, then fenced by a second summary batch.
 */
export async function readZoneBrowse(session: WorkReadSession, realm: string, query: Query) {
  await readRealmBasis(session, realm);
  const text = query.q?.trim() ? query.q.trim() : null;
  const sort: ZoneBrowseSort = query.sort ?? (text ? 'relevance' : 'newest');
  if (sort === 'relevance' && !text) throw new WorkReadInvalid('Relevance needs search text');
  const filter = browseFilter(query);
  const limit = session.options.limit ?? ZONE_BROWSE_COST.pageSize;
  const binding = ['zone-browse-v1', realm, text, sort, filter, session.options.language ?? null];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  const offset = cursor ? Number(cursor.after) : 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= ZONE_BROWSE_COST.windowRows) {
    throw new WorkReadInvalid('Zone browse cursor is invalid');
  }
  const epochs = await readEpochOrder(session);
  const rows = await session.query(`SELECT DISTINCT ?work ?head ?main ?evidence ?revisionEpoch
    ?sequence ?epochOrder WHERE {
    ${epochs}
    GRAPH ${iri(GRAPHS.current)} {
      ?slot a rv:RealmPublicationSlot ; rv:realm ${iri(realm)} ; rv:work ?work ;
        rv:mainVersion ?main ; rv:selectionHead ?evidence .
      ?work rv:head ?head .
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
    || !/^\d+$/.test(row.sequence?.value ?? '') || !/^\d+$/.test(row.epochOrder?.value ?? ''))
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
  const [summaries, listings, stats] = await Promise.all([session.summaries(ids),
    session.deps.packageModResolutions?.readListings(ids) ?? new Map<string, ModListing>(),
    session.deps.serialStats?.batch(ids, session.position.sequence)
      ?? new Map<string, { lastUpdatedAt: string | null }>()]);
  const candidates = window.flatMap((row, order): BrowseCandidate[] => {
    const summary = summaries[order], work = row.work!.value;
    if (summary?.status !== 'available' || summary.disclosure !== 'public') return [];
    const listing = listings.get(work) ?? null;
    return [{ work, order, title: summary.name.value, types: types.get(work) ?? [], listing,
      updatedAt: later(listing?.updatedAt, stats.get(work)?.lastUpdatedAt) }];
  });
  const { found, facets } = browseWindow(candidates, filter, text, sort);
  const page = found.slice(offset, offset + limit), pageIds = page.map(item => item.work);
  const serial = await readSerialSummaries(session, page.flatMap(item => {
    const summary = summaries[item.order];
    return summary?.status === 'available' && summary.type === 'work' ? [item.work] : [];
  }));
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
  const items = hydrated.map(item => ({ ...item,
    primaryCredits: displayZoneCredits(item.primaryCredits, names.agents, names.sources),
    mod: listings.get(item.id) ?? null, hub: hub.get(item.id) ?? null }));
  await readRealmBasis(session, realm);
  const complete = rows.length <= ZONE_BROWSE_COST.windowRows;
  const next = offset + limit < found.length ? encodeReadCursor(binding, session.position, String(offset + limit)) : null;
  return { profile: 'zone-browse-v1' as const, realm,
    query: { text, sort, filter: { all: (Object.keys(tests) as ZoneBrowseFacet[]).flatMap(facet =>
      filter[facet]?.length ? [{ facet, any: [...filter[facet]!] }] : []) } },
    facets, matches: { value: found.length, kind: complete ? 'exact' as const : 'lower-bound' as const },
    window: { scanned: window.length, complete }, ...pageResult(session, items, next) };
}
