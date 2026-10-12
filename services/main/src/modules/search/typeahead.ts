import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import type { Static } from 'typebox';
import type { readName, readAvatar } from '../work/read-contract.ts';
import type { discoveryCredit } from '../discovery/contract.ts';
import { FusekiPrefixWalkRestart, FusekiPrefixWalkUnavailable } from '../../infrastructure/fuseki.ts';
import type { SourceAuthorNameStore } from '../source/author-name.ts';
import { GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { PUBLIC_SEARCH_GRAPH } from '../work/select-main.ts';
import { publicAgent } from '../profiles/read.ts';
import { parsedMetadataState } from '../work/metadata-read.ts';
import { PublicQueryBudgetExceeded, PublicQueryUnavailable } from '../work/search-budget.ts';
import { SearchSnapshotMoved } from '../work/search-readiness.ts';
import { phraseWorkTypes } from '../work/search-facets.ts';
import { workRead } from '../work/read-session.ts';
import { currentDisclosureViewer } from '../disclosure/viewer.ts';
import { discloseSearchMatches } from '../disclosure/search.ts';
import { publicLanguageRequest } from '../display-language/public-request.ts';
import { optionalPreview } from '../query/optional-preview.ts';
import { searchPageAuthors } from './result-cards.ts';
import { matchesSearchText, SEARCH_FIELD_COST, type FieldMatch } from './fields.ts';
import { fillPrefixWalkPage, validatePrefixWalkResponse, type PrefixWalkEntry } from './prefix-walk.ts';
import { withSearchGraphSnapshot } from './snapshot.ts';
import { knownSearchPosition } from './snapshot-state.ts';

/** Resolve only the native page's exact identities. Bind Work subjects before
 * opening names so field hydration cannot become another population scan. */
export async function queryTypeaheadCandidates(env: WorkActivationEnvironment, prefix: string,
  entries: readonly PrefixWalkEntry[], sourceNames?: SourceAuthorNameStore): Promise<FieldMatch[]> {
  const candidates = entries.filter(entry => !entry.rejected);
  if (!candidates.length) return [];
  const units = [...new Set(candidates.map(entry => entry.matchUnit))];
  const identities = (await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?unit ?work ?main ?contribution ?revision ?selection ?language ?resultWork ?resultMain ?chapterTitle WHERE {
      VALUES ?unit { ${units.map(iri).join(' ')} }
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit a rv:MatchUnit ; rv:disclosure rv:Public ;
        rv:work ?work ; rv:mainVersion ?main ; rv:contribution ?contribution ;
        rv:revision ?revision ; rv:selection ?selection ; rv:language ?language .
        OPTIONAL { ?unit rv:searchResultWork ?resultWork ; rv:searchResultMain ?resultMain ;
          rv:searchChapterTitle ?chapterTitle . } }
      GRAPH ${iri(GRAPHS.current)} { ?work rv:mainVersion ?main . ?main rv:selectionHead ?selection }
    } LIMIT ${units.length + 1}`, 65_536)).results?.bindings ?? [];
  if (identities.length > units.length || new Set(identities.map(row => row.unit?.value)).size !== identities.length) {
    throw new PublicQueryUnavailable('Typeahead candidate identity is ambiguous');
  }
  for (const row of identities) {
    if (!row.unit || !units.includes(row.unit.value) || !row.work || !row.main || !row.contribution
      || !row.revision || !row.selection || !row.language
      || row.resultWork && (!row.resultMain || !row.chapterTitle)) {
      throw new PublicQueryUnavailable('Typeahead candidate selection is incomplete');
    }
  }
  const admitted = candidates.flatMap(entry => {
    const row = identities.find(row => row.unit!.value === entry.matchUnit);
    return row && (row.resultMain?.value ?? row.main!.value) === entry.mainVersion ? [{ entry, row }] : [];
  });
  if (!admitted.length) return [];
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT DISTINCT ?work ?field ?kind ?text ?state ?key ?agent WHERE {
      VALUES (?work ?field) { ${admitted.map(({ entry, row }) => `(${iri(row.work!.value)} ${lit(entry.matchedField)})`).join(' ')} }
      { { BIND("title" AS ?field) GRAPH ${iri(GRAPHS.current)} { ?work rdfs:label ?text }
          BIND("label" AS ?kind) }
        UNION { BIND("title" AS ?field) GRAPH ${iri(GRAPHS.current)} { ?work rv:descriptiveMetadataHead ?metadata }
          GRAPH ${iri(GRAPHS.revisions)} { ?metadata a rv:WorkMetadataRevision ; rv:metadataState ?state .
            FILTER NOT EXISTS { ?metadata a rv:ErasedRevision } } BIND("metadata" AS ?kind) }
        UNION { BIND("credit" AS ?field) GRAPH ${iri(GRAPHS.current)} {
            ?credit a rv:NativeAgentCredit ; rv:work ?work ; rv:creditRevision ?creditRevision ;
              rv:agent ?agent ; schema:roleName "author" . }
          GRAPH ${iri(GRAPHS.revisions)} { ?creditRevision a rv:NativeAgentCreditRevision ;
            rv:component ?credit ; rv:agent ?agent . FILTER NOT EXISTS { ?creditRevision a rv:ErasedRevision } }
          ${publicAgent('?agent')} BIND(?displayName AS ?text) BIND("label" AS ?kind) }
        UNION { BIND("credit" AS ?field) GRAPH ${iri(GRAPHS.current)} {
            ?credit a rv:AuthorCredit ; rv:work ?work ; rv:creditRevision ?creditRevision ;
              rv:externalProvider "open-library" ; rv:externalNamespace "author" ;
              rv:externalKey ?key ; schema:roleName "author" . }
          GRAPH ${iri(GRAPHS.revisions)} { ?creditRevision a rv:AuthorCreditRevision ;
            rv:component ?credit ; rv:externalKey ?key . FILTER NOT EXISTS { ?creditRevision a rv:ErasedRevision } }
          BIND("source" AS ?kind) }
      }
    } LIMIT ${SEARCH_FIELD_COST.candidates + 1}`, SEARCH_FIELD_COST.responseBytes)).results?.bindings ?? [];
  if (rows.length > SEARCH_FIELD_COST.candidates) throw new PublicQueryBudgetExceeded('Typeahead field hydration exceeds its bound');
  const keys = [...new Set(rows.flatMap(row => row.key ? [row.key.value] : []))];
  const names = keys.length ? await sourceNames?.batch(keys) : undefined;
  const matches: FieldMatch[] = [];
  for (const { entry, row: identity } of admitted) {
    for (const row of rows.filter(row => row.work?.value === identity.work!.value && row.field?.value === entry.matchedField)) {
      const values: Array<{ text: string; language: string | null }> = [];
      if (row.kind?.value === 'metadata') {
        const state = parsedMetadataState(row.state?.value ?? '');
        if (state.kind !== 'header') throw new PublicQueryUnavailable('Typeahead metadata is not a header');
        if (state.originalTitle) values.push({ text: state.originalTitle.value, language: state.originalTitle.language });
        values.push(...state.localized.flatMap(value => value.title ? [{ text: value.title, language: value.language }] : []));
      } else {
        const text = row.key ? names?.get(row.key.value)?.displayName : row.text?.value;
        if (text) values.push({ text, language: row.text?.['xml:lang'] ?? null });
      }
      const value = values.find(value => matchesSearchText(value.text, prefix, true));
      if (!value) continue;
      matches.push({ work: identity.resultWork?.value ?? identity.work!.value,
        mainVersion: entry.mainVersion, matchUnit: entry.matchUnit,
        contribution: identity.contribution!.value, revision: identity.revision!.value,
        selection: identity.selection!.value, language: identity.language!.value,
        score: 1, matchedField: entry.matchedField, matchedText: value.text, matchedLanguage: value.language,
        ...(row.agent ? { nameOwner: row.agent.value } : {}),
        ...(identity.resultWork ? { matchedChapter: { post: identity.work!.value,
          book: identity.resultWork.value, title: identity.chapterTitle!.value } } : {}) });
    }
  }
  // Keep alternate credited-name witnesses until their own disclosure is known.
  const disclosed = await discloseSearchMatches(env, matches, 'typeahead');
  const seen = new Set<string>();
  return disclosed.filter(row => {
    const key = `${row.mainVersion}\n${row.matchUnit}\n${row.matchedField}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface TypeaheadRelation {
  results: FieldMatch[];
  total: number;
  context: 'main-version-default';
  sourcePosition: { dataEpoch: string; sequence: string };
}
interface TypeaheadItem {
  work: string; mainVersion: string; title: Static<typeof readName>; cover: Static<typeof readAvatar>;
  types: string[]; authors: Static<typeof discoveryCredit>[];
  matchedField: 'title' | 'credit'; matchedText: string; matchedLanguage: string | null;
}

export async function readPublicTypeahead(work: MainWorkDependencies, request: Request,
  input: { prefix: string; language?: string },
  present: (relation: TypeaheadRelation) => Promise<TypeaheadRelation>) {
  const env = work.environment;
  if (!(await env.fuseki.commandHealth()).prefixWalkAvailable) {
    throw new PublicQueryUnavailable('Native prefix directory is unavailable');
  }
  return withSearchGraphSnapshot(env, async () => {
    const sourceGeneration = await work.sourceAuthorNames?.searchGeneration();
    const position = knownSearchPosition(env.fuseki, env.lineage);
    if (!position) throw new PublicQueryUnavailable('Typeahead graph snapshot is unavailable');
    let accepted = new Map<string, TypeaheadItem>();
    let generation: string | undefined;
    // Language selects card presentation, as before; matching spans all selected languages.
    const page = await fillPrefixWalkPage({ prefix: input.prefix, language: null,
      pageSize: SEARCH_FIELD_COST.typeaheadItems }, async walkRequest => {
      let native: unknown;
      try { native = await env.fuseki.prefixWalk(walkRequest); }
      catch (error) {
        if (error instanceof FusekiPrefixWalkRestart) throw new SearchSnapshotMoved(error.message, { cause: error });
        if (error instanceof FusekiPrefixWalkUnavailable) throw new PublicQueryUnavailable(error.message, { cause: error });
        throw error;
      }
      if (generation !== undefined && native && typeof native === 'object'
        && 'generation' in native && typeof native.generation === 'string' && generation !== native.generation) {
        throw new SearchSnapshotMoved('Prefix directory generation changed during matching');
      }
      const response = validatePrefixWalkResponse(native, walkRequest);
      generation = response.generation;
      const candidates = await queryTypeaheadCandidates(env, input.prefix, response.entries, work.sourceAuthorNames);
      const visible = await present({ context: 'main-version-default', sourcePosition: position,
        total: candidates.length, results: candidates });
      if (!visible.results.length) {
        accepted.clear();
        return response;
      }
      const types = await phraseWorkTypes(env, visible.results.map(row => ({ work: row.work, language: '' })), position);
      accepted = await workRead(work, publicLanguageRequest(request),
        { language: input.language, publicViewer: currentDisclosureViewer() }, async session => {
          if (session.position.dataEpoch !== position.dataEpoch || session.position.sequence !== position.sequence) {
            throw new SearchSnapshotMoved('Typeahead moved during hydration');
          }
          const summaries = await session.summaries(visible.results.map(row => row.work), true);
          const authors = await optionalPreview(session,
            () => searchPageAuthors(session, [...new Set(visible.results.map(row => row.work))], true));
          const after = await session.summaries(visible.results.map(row => row.work), true);
          if (summaries.some((summary, i) => JSON.stringify({ ...summary, avatar: undefined })
            !== JSON.stringify({ ...after[i], avatar: undefined }))) {
            throw new SearchSnapshotMoved('Typeahead disclosure changed during hydration');
          }
          return new Map<string, TypeaheadItem>(visible.results.flatMap((row, i) => {
            const summary = summaries[i], final = after[i];
            return summary?.status === 'available' && summary.type === 'work' && summary.disclosure === 'public'
              ? [[`${row.mainVersion}\n${row.matchUnit}\n${row.matchedField}`, {
                work: row.work, mainVersion: row.mainVersion, title: summary.name,
                cover: final?.status === 'available' ? final.avatar : summary.avatar,
                types: types.get(row.work) ?? [], authors: authors?.get(row.work) ?? [],
                matchedField: row.matchedField as 'title' | 'credit', matchedText: row.matchedText,
                matchedLanguage: row.matchedLanguage }]] : [];
          }));
        });
      return response;
    }, async entry => accepted.get(`${entry.mainVersion}\n${entry.matchUnit}\n${entry.matchedField}`) ?? null);
    if (work.sourceAuthorNames && sourceGeneration !== await work.sourceAuthorNames.searchGeneration()) {
      throw new SearchSnapshotMoved('Source author names changed during matching');
    }
    return { profile: 'public-work-typeahead-v1' as const, items: page.items, hasMore: page.hasMore,
      sourcePosition: { dataEpoch: position.dataEpoch, sequence: position.sequence } };
  });
}
