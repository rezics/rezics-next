import { parseLanguage } from '../display-language/tag.ts';
import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { PUBLIC_SEARCH_GRAPH } from '../work/select-main.ts';
import { publicWork, unerased } from '../work/public-patterns.ts';
import { assertPublicTextReady, assertQuerySnapshotMoved, MAX_PHRASE_CANDIDATES,
  MAX_SEARCH_RESPONSE_BYTES } from '../work/search-readiness.ts';
import { PublicQueryUnavailable } from '../work/search-budget.ts';
import { InvalidPublicQuery, PublicRealmUnavailable } from '../work/search-public.ts';
import { SELECTION_POLICY } from '../space/create.ts';
import { InvalidSearchContinuation, SearchContinuationRestart, SEARCH_PAGE_TTL_MS } from '../work/search-continuation.ts';
import { decodeReadCursor, encodeReadCursor, WorkReadExpired, WorkReadInvalid } from '../work/read-session.ts';
import { FusekiReadBudgetExceeded, FusekiQueryResponseTooLarge, type SparqlResult } from '../../infrastructure/fuseki.ts';
import { observeSearchPhase } from './operation-evidence.ts';

/** Ranked retrieval has O(P) retained rows; refills consume at most 512
 * candidates, 8 native rank reads and 8 RDF joins, under the existing 72-call,
 * 8 MiB and 1,500ms enclosing budget. No limit admits the catalogue population. */
export const RANKED_CATALOGUE_COST = { pageSize: 64, candidates: MAX_PHRASE_CANDIDATES,
  rankReads: 8, responseBytes: MAX_SEARCH_RESPONSE_BYTES } as const;
export interface RankedCatalogueRequest { phrase: string; language: string | null;
  author?: string; realm?: string; pageSize: number; continuation?: string }
interface RankAfter { id: string | null; score: string; commit: string; document?: number }
interface RankHit { id: string; key: string | null; score: string; document?: number; unit?: string }
interface RankEnvelope { hits: RankHit[]; commit: string; more: boolean; restart?: boolean; expiresAt?: number }
export interface RankedCatalogueMatch { matchUnit: string; work: string; mainVersion: string;
  contribution: string; revision: string; selection: string; language: string; score: number; reason?: string }
interface Cursor { after: RankAfter | null; visible: number; generation: string; instance: string }
export interface RankedCataloguePage {
  profile: 'public-catalogue-ranked-v1'; resultGrain: 'mainVersion'; retrieval: 'ranked';
  context: 'main-version-default' | { kind: 'realm-local'; id: string };
  count: { value: number; precision: 'lower-bound' | 'exact' }; population: number;
  results: RankedCatalogueMatch[]; next: string | null; indexGeneration: string;
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
}
const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const decimal = /^(0|[1-9][0-9]*)$/;
const unitId = (value: unknown): value is string => typeof value === 'string' && value.length <= 2048
  && /^[a-z][a-z0-9+.-]*:/iu.test(value) && !/[\s<>"{}|\\^`]/u.test(value);

async function rankQuery(env: WorkActivationEnvironment, sparql: string): Promise<SparqlResult> {
  try { return await observeSearchPhase('catalogue-native-rank-read',
    () => env.fuseki.query(sparql, RANKED_CATALOGUE_COST.responseBytes)); }
  catch (cause) {
    if (cause instanceof FusekiReadBudgetExceeded || cause instanceof FusekiQueryResponseTooLarge) throw cause;
    throw new PublicQueryUnavailable('native ranked retrieval is unavailable', { cause });
  }
}

export async function readRankedCatalogue(env: WorkActivationEnvironment, input: RankedCatalogueRequest,
  filter: (rows: RankedCatalogueMatch[]) => Promise<RankedCatalogueMatch[]> = async rows => rows,
  hydrate?: (page: RankedCataloguePage) => Promise<RankedCataloguePage | null>): Promise<RankedCataloguePage> {
  const phrase = input.phrase.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (phrase.length < 2 || phrase.length > 80 || /[\u0000-\u001f\u007f]/u.test(phrase)
    || !Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > RANKED_CATALOGUE_COST.pageSize
    || input.author !== undefined && !native.test(input.author)
    || input.realm !== undefined && !native.test(input.realm)
    || input.language !== null && !parseLanguage(input.language)) {
    throw new InvalidPublicQuery('invalid ranked catalogue query');
  }
  const position = await assertPublicTextReady(env.fuseki, env.lineage);
  if (input.realm) {
    const realm = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?space WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?space a rv:Space ; rv:disclosure rv:Public ;
        rv:realmCapability ${iri(input.realm)} . ${iri(input.realm)} a rv:Realm ; rv:space ?space ;
        rv:realmState rv:Active ; rv:selectionPolicy ${iri(SELECTION_POLICY)} . }
    } LIMIT 2`, 8192)).results?.bindings ?? [];
    if (realm.length !== 1) throw new PublicRealmUnavailable('Realm is unavailable');
  }
  const binding = ['ranked-catalogue-names-v3', phrase, input.language, input.author ?? null,
    input.realm ?? null, input.pageSize];
  let prior: Cursor | undefined, expiresAt = Date.now() + SEARCH_PAGE_TTL_MS;
  try {
    const decoded = decodeReadCursor(input.continuation, binding, position, true);
    if (decoded) {
      prior = JSON.parse(decoded.after) as Cursor;
      if (decoded.expiresAt === undefined) throw new WorkReadExpired('rank basis has no lifetime');
      expiresAt = decoded.expiresAt;
      if (prior.after !== null && (!prior.after || prior.after.id !== null && !unitId(prior.after.id)
        || prior.after.id === null && (prior.after.score !== '0' || prior.after.document !== undefined)
        || typeof prior.after.score !== 'string' || !Number.isFinite(Number(prior.after.score))
        || typeof prior.after.commit !== 'string' || !decimal.test(prior.after.commit)
        || prior.after.document !== undefined && (!Number.isSafeInteger(prior.after.document) || prior.after.document < 0))
        || !Number.isSafeInteger(prior.visible) || prior.visible < 0) throw new WorkReadInvalid('rank cursor');
      if (prior.instance !== position.serverInstanceId) throw new WorkReadExpired('rank basis changed');
    }
  } catch (error) {
    if (error instanceof WorkReadExpired) throw new SearchContinuationRestart('ranked search changed; restart at page one');
    throw new InvalidSearchContinuation('ranked search continuation is invalid', { cause: error });
  }
  const scope = JSON.stringify({ catalogue: true, ...input.realm ? { realm: input.realm } : {},
    ...input.language ? { language: input.language } : {}, ...input.author ? { author: input.author } : {} });
  const results: RankedCatalogueMatch[] = [];
  const generation = prior?.generation ?? position.generation;
  let beginning = prior?.after ?? undefined;
  let after = prior?.after ?? undefined, scanned = 0, more = false;
  for (let read = 0; read < RANKED_CATALOGUE_COST.rankReads; read++) {
    // Audience and field disclosure run before pagination. Starting every
    // request at 64 made a one-item page assess the whole matching fixture.
    // Match the first index batch to its page; rejected candidates retain the
    // existing larger refill, cursor, call and candidate budgets.
    // One visible lookahead proves whether a filled page has a successor.
    // Drain rejected/grouped tail rows within the same existing refill budget
    // so an exhausted language duplicate does not manufacture a next page.
    const size = Math.min(read === 0 ? input.pageSize + 1 : RANKED_CATALOGUE_COST.pageSize,
      RANKED_CATALOGUE_COST.pageSize,
      RANKED_CATALOGUE_COST.candidates - scanned);
    if (size < 1) break;
    const rows = (await rankQuery(env, `PREFIX rv: <${RV}>
      SELECT ?epoch ?sequence ?generation ?page WHERE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence ;
          rv:textIndexGeneration ?generation . FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
        BIND(rv:rankedText(rv:searchBody, ${lit(phrase)}, ${size}, ${lit(after ? JSON.stringify(after) : '')},
          ${lit(scope)}) AS ?page)
      }`)).results?.bindings ?? [];
    if (rows.length !== 1 || rows[0]?.epoch?.value !== position.dataEpoch
      || rows[0]?.sequence?.value !== position.sequence || rows[0]?.generation?.value !== position.generation) {
      await assertQuerySnapshotMoved(env.fuseki, position, rows, 'generation');
      throw new PublicQueryUnavailable('ranked catalogue graph position is unavailable');
    }
    let page: RankEnvelope;
    try { page = JSON.parse(rows[0]?.page?.value ?? '') as RankEnvelope; }
    catch (cause) { throw new PublicQueryUnavailable('native rank envelope is unavailable', { cause }); }
    if (!page || typeof page !== 'object') throw new PublicQueryUnavailable('native rank envelope is invalid');
    if (page.restart === true) throw new SearchContinuationRestart('ranked index changed; restart at page one');
    if (!Array.isArray(page.hits) || page.hits.length > size || typeof page.more !== 'boolean'
      || page.expiresAt !== undefined && (!Number.isSafeInteger(page.expiresAt) || page.expiresAt <= 0)
      || page.more && !page.hits.length
      || typeof page.commit !== 'string' || !decimal.test(page.commit)
      || page.hits.some(hit => !hit || !unitId(hit.id)
        || hit.key !== null && !native.test(hit.key)
        || typeof hit.score !== 'string' || !Number.isFinite(Number(hit.score)) || hit.unit !== undefined && !unitId(hit.unit))
      || page.hits.some(hit => hit.document !== undefined && (!Number.isSafeInteger(hit.document) || hit.document < 0))
      || new Set(page.hits.filter(hit => hit.key !== null).map(hit => hit.id)).size
        !== page.hits.filter(hit => hit.key !== null).length
      || new Set(page.hits.filter(hit => hit.key !== null).map(hit => hit.key)).size
        !== page.hits.filter(hit => hit.key !== null).length) {
      throw new PublicQueryUnavailable('native rank envelope is invalid');
    }
    if (page.expiresAt !== undefined) expiresAt = Math.min(expiresAt, page.expiresAt);
    beginning ??= { id: null, score: '0', commit: page.commit };
    if (!page.hits.length) { more = false; break; }
    const candidates = page.hits.filter(hit => hit.key !== null);
    const matched = candidates.length ? (await observeSearchPhase('catalogue-candidate-identity-read',
      () => env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
      SELECT ?unit ?work ?main ?contribution ?revision ?selection ?language WHERE {
        VALUES ?unit { ${candidates.map(hit => iri(hit.unit ?? hit.id)).join(' ')} }
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit a rv:MatchUnit ; rv:disclosure rv:Public ;
          rv:work ?sourceWork ; rv:mainVersion ?sourceMain ; rv:contribution ?contribution ;
          rv:revision ?revision ; rv:selection ?selection ; rv:language ?language .
          OPTIONAL { ?unit rv:searchResultWork ?resultWork ; rv:searchResultMain ?resultMain . } }
        BIND(COALESCE(?resultWork, ?sourceWork) AS ?work)
        BIND(COALESCE(?resultMain, ?sourceMain) AS ?main)
        ${input.realm ? `GRAPH ${iri(GRAPHS.current)} {
          ?sourceWork a schema:CreativeWork ; rv:mainVersion ?sourceMain .
          ?sourceMain a rv:MainVersion ; rv:work ?sourceWork .
          ?slot a rv:RealmPublicationSlot ; rv:realm ${iri(input.realm)} ; rv:work ?sourceWork ;
            rv:mainVersion ?sourceMain ; rv:selectionHead ?selection . }
          ${unerased('?sourceWork')}
          FILTER(!BOUND(?resultWork) || EXISTS { ${publicWork('?resultWork', '?resultMain')} })`
          : `FILTER EXISTS { ${publicWork('?work', '?main')} }`}
      } LIMIT ${candidates.length + 1}`, RANKED_CATALOGUE_COST.responseBytes))).results?.bindings ?? [] : [];
    if (matched.length > page.hits.length || new Set(matched.map(row => row.unit?.value)).size !== matched.length) {
      throw new PublicQueryUnavailable('ranked result identity is ambiguous');
    }
    const byUnit = new Map(matched.map(row => {
      if (!row.unit || !row.work || !row.main || !row.contribution || !row.revision || !row.selection || !row.language) {
        throw new PublicQueryUnavailable('ranked result is incomplete');
      }
      const hit = candidates.find(hit => (hit.unit ?? hit.id) === row.unit!.value);
      if (!hit || hit.key !== row.main.value) throw new PublicQueryUnavailable('ranked group identity differs');
      return [hit.id, { matchUnit: row.unit.value, work: row.work.value, mainVersion: row.main.value,
        contribution: row.contribution.value, revision: row.revision.value, selection: row.selection.value,
        language: row.language.value, score: Number(hit.score),
        ...input.realm ? { reason: 'realm-adoption' } : {} }];
    }));
    const visible = await filter(candidates.flatMap(hit => byUnit.get(hit.id) ? [byUnit.get(hit.id)!] : []));
    const allowed = new Set(visible.map(row => row.matchUnit));
    if (visible.some(row => ![...byUnit.values()].some(candidate => candidate.matchUnit === row.matchUnit)) || allowed.size !== visible.length) {
      throw new PublicQueryUnavailable('ranked result filter changed identity');
    }
    let unconsumedVisible = false;
    for (const [offset, hit] of page.hits.entries()) {
      const row = hit.key !== null ? byUnit.get(hit.id) : undefined;
      if (row && allowed.has(row.matchUnit)) {
        // Preserve the first visible probe. Trailing rejected candidates can
        // still be consumed after filling the page, avoiding an empty terminal
        // page merely because a second language loses its group witness.
        if (results.length === input.pageSize) { more = true; unconsumedVisible = true; break; }
        results.push(row);
      }
      scanned++;
      after = { id: hit.id, score: hit.score, commit: page.commit,
        ...hit.document !== undefined ? { document: hit.document } : {} };
      more = offset + 1 < page.hits.length || page.more;
    }
    if (!more || unconsumedVisible) break;
  }
  const visibleCount = (prior?.visible ?? 0) + results.length;
  const continuation = more && after ? encodeReadCursor(binding, position, JSON.stringify({ after,
    visible: visibleCount, generation, instance: position.serverInstanceId } satisfies Cursor), '', expiresAt) : null;
  const page: RankedCataloguePage = { profile: 'public-catalogue-ranked-v1' as const, resultGrain: 'mainVersion' as const,
    context: input.realm ? { kind: 'realm-local' as const, id: input.realm } : 'main-version-default' as const,
    retrieval: 'ranked' as const, count: { value: visibleCount, precision: more ? 'lower-bound' as const : 'exact' as const },
    population: position.population, results, next: continuation,
    sourcePosition: { datasetId: 'product' as const, dataEpoch: position.dataEpoch, sequence: position.sequence },
    indexGeneration: generation };
  if (!hydrate || !results.length) return page;
  const hydrated = await hydrate(page);
  if (hydrated) return hydrated;
  // None of this page was delivered. Keep the preceding native anchor and
  // visible count, including a resumable first page and a deferred last page.
  return { ...page, results: [], count: { value: prior?.visible ?? 0, precision: 'lower-bound' },
    next: encodeReadCursor(binding, position, JSON.stringify({ after: beginning ?? null,
      visible: prior?.visible ?? 0, generation, instance: position.serverInstanceId } satisfies Cursor), '', expiresAt) };
}
