import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import type { Static } from 'typebox';
import type { readName, readAvatar } from '../work/read-contract.ts';
import type { discoveryCredit } from '../discovery/contract.ts';
import { FusekiPrefixWalkRestart, FusekiPrefixWalkUnavailable } from '../../infrastructure/fuseki.ts';
import type { SourceAuthorNameStore } from '../source/author-name.ts';
import { readAuthorNames } from '../source/author-name-read.ts';
import { GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { PUBLIC_SEARCH_GRAPH } from '../work/select-main.ts';
import { publicAgent } from '../profiles/read.ts';
import { parsedMetadataState } from '../work/metadata-read.ts';
import { PublicQueryBudgetExceeded, PublicQueryUnavailable } from '../work/search-budget.ts';
import { SearchSnapshotMoved } from '../work/search-readiness.ts';
import { phraseWorkTypes } from '../work/search-facets.ts';
import { WorkReadMoved, workRead, type WorkReadSession } from '../work/read-session.ts';
import { currentDisclosureViewer } from '../disclosure/viewer.ts';
import { captureDisclosure, resolveDisclosureSelections, DISCLOSURE_COST,
  type DisclosureDecision, type DisclosureTarget } from '../disclosure/read.ts';
import { publicLanguageRequest } from '../display-language/public-request.ts';
import { optionalPreview } from '../query/optional-preview.ts';
import { searchPageAuthors } from './result-cards.ts';
import { matchesSearchText, SEARCH_FIELD_COST, type FieldMatch } from './fields.ts';
import { prefixWalkRequest, prefixWalkExaminedLimit, prefixWalkCursor, validatePrefixWalkResponse, type PrefixWalkEntry,
  type PrefixWalkRequest, type PrefixWalkResponse } from './prefix-walk.ts';
import { withSearchGraphSnapshot } from './snapshot.ts';

/** Resolve only the native page's exact identities. Bind Work subjects before
 * opening names so field hydration cannot become another population scan. */
export async function queryTypeaheadCandidates(env: WorkActivationEnvironment, prefix: string,
  entries: readonly PrefixWalkEntry[], sourceNames?: SourceAuthorNameStore,
  session?: WorkReadSession): Promise<FieldMatch[]> {
  const candidates = entries.filter(entry => !entry.rejected);
  if (!candidates.length) return [];
  const units = [...new Set(candidates.map(entry => entry.matchUnit))];
  const query = async (body: string, maxBytes: number, limit: number) => session
    ? session.query(body, limit, undefined, maxBytes) : (await env.fuseki.query(body, maxBytes)).results?.bindings ?? [];
  const identities = await query(`PREFIX rv: <${RV}>
    SELECT ?unit ?work ?head ?main ?contribution ?revision ?selection ?language ?resultWork ?resultHead ?resultMain ?chapterTitle WHERE {
      VALUES ?unit { ${units.map(iri).join(' ')} }
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit a rv:MatchUnit ; rv:disclosure rv:Public ;
        rv:work ?work ; rv:mainVersion ?main ; rv:contribution ?contribution ;
        rv:revision ?revision ; rv:selection ?selection ; rv:language ?language .
        OPTIONAL { ?unit rv:searchResultWork ?resultWork ; rv:searchResultMain ?resultMain ;
          rv:searchChapterTitle ?chapterTitle . } }
      GRAPH ${iri(GRAPHS.current)} { ?work rv:mainVersion ?main ; rv:head ?head . ?main rv:selectionHead ?selection
        OPTIONAL { FILTER(BOUND(?resultMain)) ?resultWork rv:head ?resultHead } }
      FILTER(!BOUND(?resultWork) || EXISTS {
        GRAPH ${iri(GRAPHS.current)} { ?resultWork rv:mainVersion ?resultMain } })
    } LIMIT ${units.length + 1}`, 65_536, units.length + 1);
  if (identities.length > units.length || new Set(identities.map(row => row.unit?.value)).size !== identities.length) {
    throw new PublicQueryUnavailable('Typeahead candidate identity is ambiguous');
  }
  for (const row of identities) {
    if (!row.unit || !units.includes(row.unit.value) || !row.work || !row.head || !row.main || !row.contribution
      || !row.revision || !row.selection || !row.language
      || row.resultWork && (!row.resultHead || !row.resultMain || !row.chapterTitle)) {
      throw new PublicQueryUnavailable('Typeahead candidate selection is incomplete');
    }
  }
  const admitted = candidates.flatMap(entry => {
    const row = identities.find(row => row.unit!.value === entry.matchUnit);
    return row && (row.resultMain?.value ?? row.main!.value) === entry.mainVersion ? [{ entry, row }] : [];
  });
  if (!admitted.length) return [];
  const rows = await query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
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
    } LIMIT ${SEARCH_FIELD_COST.candidates + 1}`, SEARCH_FIELD_COST.responseBytes, SEARCH_FIELD_COST.candidates + 1);
  if (rows.length > SEARCH_FIELD_COST.candidates) throw new PublicQueryBudgetExceeded('Typeahead field hydration exceeds its bound');
  const keys = [...new Set(rows.flatMap(row => row.key ? [row.key.value] : []))];
  const names = keys.length ? session ? await readAuthorNames(session, keys)
    : await sourceNames?.batch(keys) : undefined;
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
  const heads = new Map(identities.flatMap(row => [[row.work!.value, row.head!.value] as const,
    ...(row.resultWork ? [[row.resultWork.value, row.resultHead!.value] as const] : [])]));
  const readDisclosed = () => discloseTypeaheadMatches(env, matches, heads);
  const disclosed = await readDisclosed();
  session?.observeDependency(`typeahead-disclosure:${JSON.stringify(units)}`, disclosed, readDisclosed);
  const seen = new Set<string>();
  return disclosed.filter(row => {
    const key = `${row.mainVersion}\n${row.matchUnit}\n${row.matchedField}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Names are selected graph units. Their owners establish Work/Realm ancestry
 * before capture; expanded chapter witnesses retain their original ordinals. */
export async function discloseTypeaheadMatches(environment: WorkActivationEnvironment,
  matches: readonly FieldMatch[], heads: ReadonlyMap<string, string>): Promise<FieldMatch[]> {
  const targets: DisclosureTarget[] = [], ranges: number[][] = [];
  for (const match of matches) {
    const selected = [{ owner: 'graph' as const, resource: match.work, component: 'name' as const,
      revision: heads.get(match.work), work: match.work, workRevision: heads.get(match.work), nameOwner: match.nameOwner },
      ...(match.matchedChapter ? [{ owner: 'graph' as const, resource: match.matchedChapter.post,
        component: 'name' as const, revision: heads.get(match.matchedChapter.post),
        work: match.matchedChapter.post, workRevision: heads.get(match.matchedChapter.post) }] : [])];
    ranges.push(selected.map((_, index) => targets.length + index)); targets.push(...selected);
  }
  const decisions: DisclosureDecision[] = [];
  for (let offset = 0; offset < targets.length; offset += DISCLOSURE_COST.batch) {
    const selections = await resolveDisclosureSelections(environment, targets.slice(offset, offset + DISCLOSURE_COST.batch));
    const cuts = await captureDisclosure(environment, selections, currentDisclosureViewer(), 'typeahead');
    decisions.push(...cuts.map(cut => cut.decision));
  }
  return matches.filter((_, index) => ranges[index]!.every(ordinal => decisions[ordinal] === 'visible'));
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

/** Readiness is this public request returning 200. A never-qualified native
 * index may answer 503 search_index_unavailable; clients wait at most 120
 * seconds for readiness, then report failure. Each request retains the search
 * wall deadline. A qualified published cut remains readable during replay. */
export async function readPublicTypeahead(work: MainWorkDependencies, request: Request,
  input: { prefix: string; language?: string },
  present: (relation: TypeaheadRelation) => Promise<TypeaheadRelation>) {
  const env = work.environment;
  if (!(await env.fuseki.commandHealth()).prefixWalkAvailable) {
    throw new PublicQueryUnavailable('Native prefix directory is unavailable');
  }
  return withSearchGraphSnapshot(env, () => workRead(work, publicLanguageRequest(request),
    { language: input.language, publicViewer: currentDisclosureViewer() }, async session => {
    const position = session.position;
    let accepted = new Map<string, TypeaheadItem>();
    const deliveredMainVersions = new Set<string>();
    let generation: string | undefined;
    const walks: Array<{ request: PrefixWalkRequest; response: PrefixWalkResponse }> = [];
    // Language selects card presentation, as before; matching spans all selected languages.
    const initial = prefixWalkRequest({ prefix: input.prefix, language: null,
      pageSize: SEARCH_FIELD_COST.typeaheadItems });
    const cap = prefixWalkExaminedLimit(initial.pageSize);
    const entries: PrefixWalkEntry[] = [];
    let cursor = initial.cursor, more = false;
    do {
      const walkRequest = { ...initial, cursor, pageSize: Math.min(initial.pageSize, cap - entries.length) };
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
      walks.push({ request: walkRequest, response });
      generation = response.generation;
      const batchEntries = response.entries;
      entries.push(...batchEntries);
      cursor = response.cursor; more = response.more;
      // Candidate identities, their matched fields, facets and all cards share
      // one selected dependency set, including across native walk batches.
      const previouslyDelivered = new Set([...accepted.values()].map(item => item.mainVersion));
      const visible = await session.selection(`typeahead-presentation:${JSON.stringify(batchEntries)}`, async probe => {
        const candidates = await queryTypeaheadCandidates(env, input.prefix, batchEntries, work.sourceAuthorNames, probe);
        const relation = await present({ context: 'main-version-default' as const, sourcePosition: position,
          total: candidates.length, results: candidates });
        const seen = new Set(previouslyDelivered);
        return { ...relation, results: batchEntries.flatMap(entry => {
          if (seen.has(entry.mainVersion)) return [];
          const row = relation.results.find(match => match.mainVersion === entry.mainVersion
            && match.matchUnit === entry.matchUnit && match.matchedField === entry.matchedField);
          if (!row) return [];
          seen.add(entry.mainVersion);
          return [row];
        }) };
      }, relation => relation.results);
      if (visible.results.length) {
        const types = await phraseWorkTypes(env, visible.results.map(row => ({ work: row.work, language: '' })), position, session);
        const summaries = await session.summaries(visible.results.map(row => row.work), true);
        const authorWorks = [...new Set(visible.results.map(row => row.work))];
        const readAuthors = () => optionalPreview(session, () => searchPageAuthors(session, authorWorks, true));
        const authors = await readAuthors();
        session.observeDependency(`typeahead-authors:${JSON.stringify(authorWorks)}`, authors, readAuthors);
        const after = await session.summaries(visible.results.map(row => row.work), true);
        if (summaries.some((summary, i) => JSON.stringify({ ...summary, avatar: undefined })
          !== JSON.stringify({ ...after[i], avatar: undefined }))) {
          throw new SearchSnapshotMoved('Typeahead disclosure changed during hydration');
        }
        accepted = new Map<string, TypeaheadItem>([...accepted, ...visible.results.flatMap<[string, TypeaheadItem]>((row, i) => {
          const summary = summaries[i], final = after[i];
          return summary?.status === 'available' && summary.type === 'work' && summary.disclosure === 'public'
            ? [[`${row.mainVersion}\n${row.matchUnit}\n${row.matchedField}`, {
              work: row.work, mainVersion: row.mainVersion, title: summary.name,
              cover: final?.status === 'available' ? final.avatar : summary.avatar,
              types: types.get(row.work) ?? [], authors: authors?.get(row.work) ?? [],
              matchedField: row.matchedField as 'title' | 'credit', matchedText: row.matchedText,
              matchedLanguage: row.matchedLanguage }]] : [];
        })]);
      }
    } while (more && entries.length < cap && accepted.size < initial.pageSize);
    const items: TypeaheadItem[] = [];
    let examined = 0;
    for (const entry of entries) {
      examined++;
      if (entry.rejected || deliveredMainVersions.has(entry.mainVersion)) continue;
      const item = accepted.get(`${entry.mainVersion}\n${entry.matchUnit}\n${entry.matchedField}`);
      if (!item) continue;
      deliveredMainVersions.add(entry.mainVersion); items.push(item);
      if (items.length === initial.pageSize) break;
    }
    const hasMore = examined < entries.length || more;
    // A filled page consumes only through its tenth accepted entry. The native
    // tail already hydrated here remains available to a subsequent walk.
    cursor = hasMore ? prefixWalkCursor(initial, generation!, entries[examined - 1]!.key) : null;
    const page = { items, hasMore, cursor };
    // Reopen this exact bounded prefix traversal, including its empty/tail
    // relation. Native commit generations and cursors can advance after an
    // unrelated writer; the selected entries and continuation presence cannot.
    const selectedWalk = (response: PrefixWalkResponse) => ({ entries: response.entries,
      examined: response.examined, rejected: response.rejected, more: response.more });
    session.observeDependency('typeahead-prefix-selection', walks.map(walk => selectedWalk(walk.response)), async () => {
      let cursor: PrefixWalkRequest['cursor'] = null;
      const fresh: ReturnType<typeof selectedWalk>[] = [];
      for (const walk of walks) {
        const query = { ...walk.request, cursor };
        let native: unknown;
        try { native = await env.fuseki.prefixWalk(query); }
        catch (error) {
          if (error instanceof FusekiPrefixWalkRestart) throw new SearchSnapshotMoved(error.message, { cause: error });
          if (error instanceof FusekiPrefixWalkUnavailable) throw new PublicQueryUnavailable(error.message, { cause: error });
          throw error;
        }
        const response = validatePrefixWalkResponse(native, query);
        fresh.push(selectedWalk(response)); cursor = response.cursor;
        if (!response.more) break;
      }
      return fresh;
    });
    return { profile: 'public-work-typeahead-v1' as const, items: page.items, hasMore: page.hasMore,
      sourcePosition: { dataEpoch: position.dataEpoch, sequence: position.sequence } };
  }), 'selected-units').catch((error: unknown) => {
    if (error instanceof WorkReadMoved) {
      throw new SearchSnapshotMoved(error.message, { cause: error });
    }
    throw error;
  });
}
