import type { SourceAuthorNameStore } from '../source/author-name.ts';
import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { PUBLIC_SEARCH_GRAPH } from '../work/select-main.ts';
import { fallbackLanguage, realmLanguage } from '../work/selection-heads.ts';
import { unerased } from '../work/public-patterns.ts';
import { publicAgent } from '../profiles/read.ts';
import { parsedMetadataState } from '../work/metadata-read.ts';
import { MAX_SEARCH_RESPONSE_BYTES, SearchSnapshotMoved } from '../work/search-readiness.ts';
import { PublicQueryBudgetExceeded, PublicQueryUnavailable } from '../work/search-budget.ts';
import { discloseSearchMatches } from '../disclosure/search.ts';
import { knownSearchPosition } from './snapshot-state.ts';
import { publicWork } from '../work/public-patterns.ts';

/** This live field join has no derived freshness gap: at most 513 candidate rows / 1 MiB,
 * one graph read plus one indexed source-name search and its final fence.
 * There is no population admission cap. The graph engine may scan the public
 * population and its metadata (O(U*F)); bounded output does not bound that work.
 * it remains subject to the same 1,500 ms deadline and 8 MiB request budget.
 * A field index can replace this scan when measured latency warrants it. */
export const SEARCH_FIELD_COST = { candidates: 512, graphQueries: 2, sourceQueries: 4,
  disclosureQueries: 32,
  responseBytes: MAX_SEARCH_RESPONSE_BYTES, typeaheadItems: 10 } as const;
export type SearchField = 'title' | 'credit' | 'tagline' | 'body';
export interface SearchFieldOwners { names?: SourceAuthorNameStore;
  restrictedTitles?: (heads: readonly { work: string; revision: string }[], context: string) => Promise<ReadonlySet<string>> }
const fieldReads = new WeakMap<SearchFieldOwners, { sourceGeneration: string | null }>();
export async function fenceSearchFields(owners: SearchFieldOwners) {
  const prior = fieldReads.get(owners);
  if (!prior) return;
  if (owners.names && prior.sourceGeneration !== await owners.names.searchGeneration()) {
    throw new SearchSnapshotMoved('Source author names changed during matching');
  }
}
export interface FieldMatch { work: string; mainVersion: string; matchUnit: string;
  contribution: string; revision: string; selection: string; language: string;
  score: number; matchedField: SearchField; matchedText: string;
  matchedLanguage: string | null; reason?: string;
  matchedChapter?: { work: string; title: string } }
export const normalizedSearchText = (value: string) => value.normalize('NFC').toLowerCase().trim().replace(/\s+/gu, ' ');
export function matchesSearchText(text: string, term: string, prefix: boolean) {
  const value = normalizedSearchText(text), query = normalizedSearchText(term);
  // A literal prefix at a word boundary works for Latin names; the beginning
  // of an unspaced CJK title is also a prefix, including a single ideograph.
  return prefix ? value.startsWith(query) || value.split(/[^\p{L}\p{N}]+/u).some(word => word.startsWith(query))
    : value.includes(query);
}
const tier = { title: 3, credit: 2, tagline: 1, body: 0 } as const;
export function rankedSearchMatches<T extends { work: string; mainVersion: string; matchUnit: string;
  score: number; matchedField?: SearchField }>(matches: readonly T[]): T[] {
  const sorted = [...matches].sort((a, b) => tier[b.matchedField ?? 'body'] - tier[a.matchedField ?? 'body']
    || b.score - a.score || a.mainVersion.localeCompare(b.mainVersion) || a.matchUnit.localeCompare(b.matchUnit));
  const seen = new Set<string>();
  return sorted.filter(row => { if (seen.has(row.mainVersion)) return false; seen.add(row.mainVersion); return true; });
}

/** Current selection and disclosure precede matching, counting and ranking.
 * No historical metadata, biography, private Agent or retired credit qualifies. */
export async function querySearchFields(env: WorkActivationEnvironment,
  input: { phrase: string; language: string | null; author?: string;
    context?: { kind: 'realm-local'; id: string } },
  position: { dataEpoch: string; sequence: string }, owners: SearchFieldOwners = {}, prefix = false) {
  const sourceNames = owners.names;
  const term = normalizedSearchText(input.phrase);
  const sourceRead = await sourceNames?.search(term, prefix);
  const source = sourceRead?.names ?? new Map();
  const realm = input.context?.id;
  const sourceBranch = source.size ? `UNION {
    VALUES ?key { ${[...source.keys()].map(lit).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?credit a rv:AuthorCredit ; rv:work ?work ;
      rv:creditRevision ?creditRevision ; rv:externalProvider "open-library" ;
      rv:externalNamespace "author" ; rv:externalKey ?key ; schema:roleName "author" . }
    GRAPH ${iri(GRAPHS.revisions)} { ?creditRevision a rv:AuthorCreditRevision ; rv:component ?credit ;
      rv:externalKey ?key . FILTER NOT EXISTS { ?creditRevision a rv:ErasedRevision } }
    BIND("credit" AS ?field)
  }` : '';
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT DISTINCT ?epoch ?sequence ?work ?main ?unit ?contribution ?revision ?selection ?language
      ?field ?text ?state ?key ?reason ?head ?resultWork ?resultMain ?chapterTitle WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence .
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
    GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit a rv:MatchUnit ; rv:disclosure rv:Public ;
      rv:work ?work ; rv:mainVersion ?main ; rv:context ?unitContext ;
      rv:contribution ?contribution ; rv:revision ?revision ; rv:selection ?selection ; rv:language ?language .
      OPTIONAL { ?unit rv:searchResultWork ?resultWork ; rv:searchResultMain ?resultMain ;
        rv:searchChapterTitle ?chapterTitle . } }
    GRAPH ${iri(GRAPHS.current)} { ?work a schema:CreativeWork ; rv:mainVersion ?main .
      ?contribution rv:publicationHead ?publication .
      ${input.author ? `?contribution rv:author ${iri(input.author)} .` : ''} }
    BIND(COALESCE(?resultWork, ?work) AS ?targetWork)
    GRAPH ${iri(GRAPHS.current)} { ?targetWork rv:head ?head }
    FILTER(!BOUND(?resultWork) || EXISTS { ${publicWork('?resultWork', '?resultMain')} })
    FILTER(BOUND(?resultWork) || NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
      ?work schema:isPartOf ?parentWork } })
    GRAPH ${iri(GRAPHS.revisions)} { ?selection rv:publicationDecision ?publication ; rv:selectedDraft ?revision .
      ?publication rv:disclosure rv:Public . FILTER NOT EXISTS { ?revision a rv:ErasedRevision } }
    ${unerased('?work')}
    ${realm ? `OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?slot a rv:RealmPublicationSlot ;
      rv:realm ${iri(realm)} ; rv:mainVersion ?main ; rv:selectionHead ?local . }
      ${realmLanguage('?local', '?language')} }
      OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?main rv:selectionHead ?fallback }
        ${fallbackLanguage('?fallback', '?language')} }
      BIND(COALESCE(?local, ?fallback) AS ?effective)
      BIND(IF(BOUND(?local), ${iri(realm)}, ?main) AS ?effectiveContext)
      BIND(IF(BOUND(?local), "realm-adoption", "main-fallback") AS ?reason)
      FILTER(?selection = ?effective && ?unitContext = ?effectiveContext)`
    : `GRAPH ${iri(GRAPHS.current)} { ?main rv:selectionHead ?selection }
      FILTER(?unitContext = ?main)`}
    ${input.language ? `FILTER(LCASE(?language) = ${lit(input.language.toLowerCase())})` : ''}
    { { GRAPH ${iri(GRAPHS.current)} { ?work rdfs:label ?text }
        FILTER(CONTAINS(LCASE(STR(?text)), ${lit(term)})) BIND("title" AS ?field) }
      UNION { GRAPH ${iri(GRAPHS.current)} { ?work rv:descriptiveMetadataHead ?metadata }
        GRAPH ${iri(GRAPHS.revisions)} { ?metadata a rv:WorkMetadataRevision ; rv:metadataState ?state .
          FILTER NOT EXISTS { ?metadata a rv:ErasedRevision } }
        FILTER(CONTAINS(LCASE(STR(?state)), ${lit(term)})) BIND("metadata" AS ?field) }
      UNION { GRAPH ${iri(GRAPHS.current)} { ?credit a rv:NativeAgentCredit ; rv:work ?work ;
        rv:creditRevision ?creditRevision ; rv:agent ?agent ; schema:roleName "author" . }
        GRAPH ${iri(GRAPHS.revisions)} { ?creditRevision a rv:NativeAgentCreditRevision ;
          rv:component ?credit ; rv:agent ?agent . FILTER NOT EXISTS { ?creditRevision a rv:ErasedRevision } }
        ${publicAgent('?agent')} BIND(?displayName AS ?text)
        FILTER(CONTAINS(LCASE(STR(?text)), ${lit(term)})) BIND("credit" AS ?field) }
      ${sourceBranch}
    }
  } LIMIT ${SEARCH_FIELD_COST.candidates + 1}`, SEARCH_FIELD_COST.responseBytes)).results?.bindings ?? [];
  if (rows.length > SEARCH_FIELD_COST.candidates) throw new PublicQueryBudgetExceeded('Search field candidates exceed their bound');
  fieldReads.set(owners, { sourceGeneration: sourceRead?.generation ?? null });
  // Localized aliases share one MatchUnit and the same disclosure targets.
  // Retain its strongest field before applying the bounded audience batch.
  const matches = new Map<string, FieldMatch>();
  for (const row of rows) {
    if (row.epoch?.value !== position.dataEpoch || row.sequence?.value !== position.sequence) {
      throw new SearchSnapshotMoved('Search fields crossed graph positions');
    }
    if (!row.work || !row.main || !row.unit || !row.contribution || !row.revision || !row.selection || !row.language) {
      throw new PublicQueryUnavailable('Search field selection is incomplete');
    }
    if (row.resultWork && (!row.resultMain || !row.chapterTitle)) {
      throw new PublicQueryUnavailable('chapter search identity is incomplete');
    }
    const values: Array<{ field: SearchField; text: string; language: string | null }> = [];
    if (row.field?.value === 'metadata') {
      const state = parsedMetadataState(row.state?.value ?? '');
      if (state.kind !== 'header') throw new PublicQueryUnavailable('Search metadata is not a header');
      if (state.originalTitle) values.push({ field: 'title', text: state.originalTitle.value, language: state.originalTitle.language });
      for (const locale of state.localized) {
        if (locale.title) values.push({ field: 'title', text: locale.title, language: locale.language });
        if (!prefix && locale.tagline) values.push({ field: 'tagline', text: locale.tagline, language: locale.language });
      }
    } else {
      const text = row.key ? source.get(row.key.value)?.displayName : row.text?.value;
      if (!text || !['title', 'credit'].includes(row.field?.value ?? '')) throw new PublicQueryUnavailable('Search field is incomplete');
      values.push({ field: row.field!.value as 'title' | 'credit', text, language: row.text?.['xml:lang'] ?? null });
    }
    for (const value of values.filter(value => matchesSearchText(value.text, term, prefix))) {
      const match: FieldMatch = { work: row.resultWork?.value ?? row.work.value,
        mainVersion: row.resultMain?.value ?? row.main.value, matchUnit: row.unit.value,
        contribution: row.contribution.value, revision: row.revision.value, selection: row.selection.value,
        language: row.language.value, score: 1, matchedField: value.field,
        matchedText: value.text, matchedLanguage: value.language,
        ...(row.reason ? { reason: row.reason.value } : {}),
        ...(row.resultWork ? { matchedChapter: { work: row.work.value,
          title: row.chapterTitle!.value } } : {}) };
      const prior = matches.get(match.matchUnit);
      if (!prior || tier[match.matchedField] > tier[prior.matchedField]) matches.set(match.matchUnit, match);
    }
  }
  await fenceSearchFields(owners);
  // The route's final uncached fence covers matching, facets and card facts.
  const disclosed = await discloseSearchMatches(env, [...matches.values()], prefix ? 'typeahead' : 'search');
  if (knownSearchPosition(env.fuseki, env.lineage)) return rankedSearchMatches(disclosed);
  const after = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence .
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } } }`, 8192)).results?.bindings ?? [];
  if (after.length !== 1 || after[0]?.epoch?.value !== position.dataEpoch
    || after[0]?.sequence?.value !== position.sequence) throw new SearchSnapshotMoved('Search fields changed during matching');
  return rankedSearchMatches(disclosed);
}
