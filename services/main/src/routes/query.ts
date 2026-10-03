import { Elysia, t } from 'elysia';
import { createHash } from 'node:crypto';
import { phraseMatch, problemResult, publicPhrasePageResult, sourcePosition } from '../api-contract.ts';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { readZoneBrowse } from '../modules/zone-modules/browse.ts';
import { zoneBrowsePage } from '../modules/zone-modules/contract.ts';
import { conceptWorksPage } from '../modules/concept-page/contract.ts';
import { readConceptWorks, readFilteredWorks } from '../modules/concept-page/read.ts';
import { discoveryError } from '../modules/discovery/management.ts';
import { publicWorkRead } from '../modules/work/read-session.ts';
import { WorkReadUnavailable } from '../modules/work/read-session.ts';
import { type AdmittedQuery, compileQuery, QUERY_COST, QueryRejected, type CompiledQuery }
  from '../modules/query/compile.ts';
import { interpretationForConcept } from '../modules/query/concept.ts';
import { combineConcepts, completeSearch, pageConcepts, type ConceptRelation }
  from '../modules/query/concept-set.ts';
import { enrichSearchCardPage } from '../modules/search/result-cards.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { searchRoutes } from './search.ts';
import { commandError, problem } from './problems.ts';
import { workReadError } from './work-reads.ts';
import { releaseWorksPage } from '../modules/facets/release-contract.ts';
import { readReleaseWorks, withReleaseQueryBudget } from '../modules/facets/release-read.ts';
import { resourceListQuery, resourceListPage, type ResourceListQuery } from '../modules/query/resource-contract.ts';
import { readResourceList } from '../modules/query/resources.ts';

const nativeId = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const closed = { additionalProperties: false } as const;
const context = t.Union([t.Literal('global'), t.Object({ realm: nativeId }, closed)]);
const scopeAll = t.Object({ kind: t.Literal('all') }, closed);
const scopeRealm = t.Object({ kind: t.Literal('realm'), realm: nativeId }, closed);
const scopeMine = t.Object({ kind: t.Literal('mine') }, closed);
const scopeV1 = t.Union([scopeAll, scopeRealm]);
const scope = t.Union([scopeAll, scopeRealm, scopeMine]);
const text = t.Union([t.Object({ phrase: t.String({ minLength: 2, maxLength: 80 }) }, closed),
  t.Object({ title: t.String({ minLength: 2, maxLength: 80 }),
    body: t.String({ minLength: 2, maxLength: 80 }) }, closed)]);
const page = t.Object({ size: t.Integer({ minimum: 1, maximum: QUERY_COST.searchPageSize }),
  continuation: t.Optional(t.Unknown()) }, closed);
const sortV1 = t.Union([t.Literal('relevance'), t.Literal('newest'), t.Literal('updated')]);
const sort = t.Union([t.Literal('relevance'), t.Literal('newest'), t.Literal('updated'),
  t.Literal('top-rated')]);
const documentFields = { context, filter: t.Optional(t.Unknown()), text: t.Optional(text), page,
  sourcePolicy: t.Optional(t.Unknown()), asOf: t.Optional(t.Unknown()) };
/** filter-document-v1 keeps the fields and values from before this revision. */
export const resourceQueryV1 = t.Object({ ...documentFields, scope: scopeV1, sort: sortV1 }, closed);
/** filter-document-v2 admits top-rated, Mine, and the rating Context and reader. */
export const resourceQueryV2 = t.Object({ profile: t.Literal('filter-document-v2'), ...documentFields,
  scope, sort, ratingContext: t.Optional(nativeId), actingSubject: t.Optional(nativeId) }, closed);
const body = t.Union([resourceQueryV1, resourceQueryV2, resourceListQuery]);
const digest = t.String({ pattern: '^[0-9a-f]{64}$' });
const conceptSetResult = t.Object({ profile: t.Literal('public-concept-set-phrase-v1'),
  resultGrain: t.Literal('mainVersion'),
  context: t.Union([t.Literal('main-version-default'),
    t.Object({ kind: t.Literal('realm-local'), id: nativeId })]),
  complete: t.Literal(true), population: t.Integer({ minimum: 0 }), total: t.Integer({ minimum: 0 }),
  sourcePosition, indexGeneration: t.String(),
  results: t.Array(phraseMatch, { maxItems: QUERY_COST.searchPageSize }),
  next: t.Nullable(t.Object({ queryDigest: digest, resultDigest: digest, sourcePosition,
    indexGeneration: t.String(), presentationDigest: digest,
    nextOffset: t.Integer({ minimum: 1, maximum: 512 }), expiresAt: t.Integer({ minimum: 0 }) })),
});
const selectionText = t.Union([text, t.Object({ phrase: t.String({ minLength: 1, maxLength: 80 }) }, closed)]);
const querySelection = t.Object({ context, scope, filter: t.Unknown(), text: t.Nullable(selectionText), sort,
  pageSize: t.Integer({ minimum: 1, maximum: QUERY_COST.searchPageSize }),
  facetRefs: t.Array(t.String(), { maxItems: QUERY_COST.nodes }),
  semanticRevisions: t.Array(nativeId, { maxItems: QUERY_COST.conceptReads }),
});

function selection(input: AdmittedQuery, compiled: CompiledQuery, resolvedRevisions?: string[]) {
  return { context: input.context, scope: input.scope, filter: input.filter ?? { all: [] },
    text: input.text ?? null, sort: input.sort, pageSize: input.page.size,
    facetRefs: compiled.facets,
    semanticRevisions: resolvedRevisions ?? (compiled.template === 'search-concepts'
      ? compiled.concepts.flatMap(concept => concept.revision ? [concept.revision] : [])
      : compiled.template === 'search' && compiled.concept?.revision ? [compiled.concept.revision] : []) };
}

export const openApiOperations = { '/v1/query': { post: { bearer: false } } } as const;

async function presentationDigest(work: MainWorkDependencies, request: Request): Promise<string> {
  if (!request.headers.has('authorization')) return createHash('sha256').update('public').digest('hex');
  if (!work.accessPolicy) throw new QueryRejected('unsupported_query_shape', 'Presentation policy is unavailable');
  const principal = await work.account.verify(request, ['work:read']);
  const rows = await work.accessPolicy.interactions.listMutes(principal);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

/** One Query input; each successful result carries the bounded template's existing result contract. */
export function queryRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  const search = searchRoutes(fuseki, work);
  return new Elysia().post('/v1/query', { body, response: {
    200: t.Object({ profile: t.Literal('query-v1'), template: t.String(), selection: querySelection,
      result: t.Union([publicPhrasePageResult, zoneBrowsePage, conceptSetResult, conceptWorksPage, releaseWorksPage, resourceListPage]) }),
    400: problemResult(400), 404: problemResult(404), 409: problemResult(409),
    422: problemResult(422), 500: problemResult(500), 503: problemResult(503),
  } }, async ({ body: input, request }) => {
    try {
      const compiled = compileQuery(input as AdmittedQuery | ResourceListQuery);
      if (compiled.template === 'resource-list') {
        const query = compiled.request.input;
        let result;
        try {
          result = await publicWorkRead(work, request, { limit: query.limit, cursor: query.cursor },
            session => readResourceList(session, compiled.request));
        } catch (error) { return discoveryError(error); }
        return Response.json({ profile: 'query-v1', template: 'resource-list-v1',
          selection: { context: query.context, scope: query.scope, filter: query.filter ?? { all: [] },
            text: query.q?.trim() ? { phrase: query.q } : null, sort: query.sort,
            pageSize: query.limit ?? 20, facetRefs: compiled.facets, semanticRevisions: [] }, result },
          { headers: { 'cache-control': 'private, no-store' } });
      }
      if (compiled.template === 'release-works') {
        try {
          const result = await publicWorkRead(work, request, {
            limit: compiled.request.limit, cursor: compiled.request.cursor,
          }, session => withReleaseQueryBudget(() => readReleaseWorks(session, compiled.request)));
          return Response.json({ profile: 'query-v1', template: 'release-works-v1',
            selection: selection(input as AdmittedQuery, compiled), result },
            { headers: { 'cache-control': 'private, no-store' } });
        } catch (error) { return workReadError(error); }
      }
      if (compiled.template === 'concept-works') {
        try {
          if (!work.discovery) throw new WorkReadUnavailable('Discovery owner is unavailable');
          const result = await publicWorkRead(work, request, { ...compiled.request,
            language: undefined, retainedBasis: true }, session => 'role' in compiled.request
            ? readFilteredWorks(session, work.discovery!, compiled.request)
            : readConceptWorks(session, work.discovery!, compiled.concept, compiled.request));
          return Response.json({ profile: 'query-v1', template: 'concept-works-v1',
            selection: selection(input as AdmittedQuery, compiled), result },
            { headers: { 'cache-control': 'no-store' } });
        } catch (error) { return discoveryError(error); }
      }
      if (compiled.template === 'zone-browse') {
        const url = new URL(`/v1/realms/${compiled.realm.slice(-36)}/modules/browse`, request.url);
        const result = await publicWorkRead(work, request, {
          language: compiled.request.language, limit: compiled.request.limit, cursor: compiled.request.cursor,
        }, session => readZoneBrowse(session, compiled.realm, compiled.request), url);
        return Response.json({ profile: 'query-v1', template: 'zone-browse-v1',
          selection: selection(input as AdmittedQuery, compiled), result },
          { headers: { 'cache-control': 'no-store' } });
      }
      if (compiled.template === 'search-concepts') {
        const expiresAt = Date.now() + QUERY_COST.deadlineMs;
        const withinBudget = () => {
          if (Date.now() >= expiresAt) throw new QueryRejected('query_budget_exceeded', 'Query deadline exceeded');
        };
        const before = await presentationDigest(work, request);
        const senses = [] as string[], revisions = [] as string[];
        for (const concept of compiled.concepts) {
          withinBudget();
          const resolved = await interpretationForConcept(work.environment, concept);
          senses.push(resolved.sense);
          revisions.push(resolved.revision);
        }
        const headers = new Headers({ 'content-type': 'application/json' });
        if (request.headers.has('authorization')) headers.set('authorization', request.headers.get('authorization')!);
        if (request.headers.has('accept-language')) headers.set('accept-language', request.headers.get('accept-language')!);
        if (request.headers.has('x-rezics-display-languages')) {
          headers.set('x-rezics-display-languages', request.headers.get('x-rezics-display-languages')!);
        }
        const legacy = (payload: object) => search.handle(new Request(new URL('/v1/queries', request.url), {
          method: 'POST', headers, body: JSON.stringify(payload),
        }));
        const baseResponse = await legacy(compiled.request);
        withinBudget();
        if (!baseResponse.ok) return baseResponse;
        const base = completeSearch(await baseResponse.json());
        const conditions: ConceptRelation[] = [];
        for (const [index, concept] of compiled.concepts.entries()) {
          withinBudget();
          const classified = await legacy({ ...compiled.request,
            profile: compiled.request.context ? 'public-realm-classified-phrase-v1'
              : 'public-main-classified-phrase-v1', sense: senses[index] });
          if (!classified.ok) return classified;
          conditions.push({ operator: concept.operator, relation: completeSearch(await classified.json()) });
          withinBudget();
        }
        for (const [index, concept] of compiled.concepts.entries()) {
          withinBudget();
          const current = await interpretationForConcept(work.environment, concept);
          if (current.sense !== senses[index] || current.revision !== revisions[index]) {
            throw new QueryRejected('stale_query_meaning', 'Concept interpretation changed during Query');
          }
        }
        const after = await presentationDigest(work, request);
        withinBudget();
        if (after !== before) throw new QueryRejected('stale_query_result', 'Presentation policy changed during Query');
        const selected = combineConcepts(base, conditions, compiled.includeMatch);
        const page = pageConcepts(input as AdmittedQuery, base, selected, senses, after);
        const hydrated = await enrichSearchCardPage(work, request, page, compiled.request.language);
        withinBudget();
        if (await presentationDigest(work, request) !== before) {
          throw new QueryRejected('stale_query_result', 'Presentation policy changed during Query');
        }
        return Response.json({ profile: 'query-v1', template: 'public-concept-set-phrase-v1',
          selection: selection(input as AdmittedQuery, compiled, revisions), result: hydrated },
          { headers: { 'cache-control': 'no-store' } });
      }
      const interpretation = compiled.concept
        ? await interpretationForConcept(work.environment, compiled.concept) : undefined;
      if (interpretation) compiled.request.sense = interpretation.sense;
      const headers = new Headers({ 'content-type': 'application/json' });
      if (request.headers.has('authorization')) headers.set('authorization', request.headers.get('authorization')!);
      if (request.headers.has('accept-language')) headers.set('accept-language', request.headers.get('accept-language')!);
      if (request.headers.has('x-rezics-display-languages')) {
        headers.set('x-rezics-display-languages', request.headers.get('x-rezics-display-languages')!);
      }
      const legacy = new Request(new URL('/v1/queries/page', request.url), {
        method: 'POST', headers, body: JSON.stringify(compiled.request),
      });
      const response = await search.handle(legacy);
      if (!response.ok) return response;
      if (compiled.concept) {
        const current = await interpretationForConcept(work.environment, compiled.concept);
        if (current.sense !== interpretation?.sense || current.revision !== interpretation.revision) {
          throw new QueryRejected('stale_query_meaning', 'Concept interpretation changed during Query');
        }
      }
      const result: unknown = await response.json();
      if (Buffer.byteLength(JSON.stringify(result)) > QUERY_COST.responseBytes) {
        throw new QueryRejected('query_budget_exceeded', 'Query response exceeds its byte bound');
      }
      return Response.json({ profile: 'query-v1', template: compiled.request.profile,
        selection: selection(input as AdmittedQuery, compiled,
          interpretation ? [interpretation.revision] : []), result },
        { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      if (error instanceof QueryRejected) return problem(error.refusal.startsWith('stale_') ? 409 : 422,
        error.refusal, error.message);
      if (input.scope.kind === 'realm' || 'profile' in input && input.profile === 'resource-list-v1') return workReadError(error);
      return commandError(error);
    }
  });
}
