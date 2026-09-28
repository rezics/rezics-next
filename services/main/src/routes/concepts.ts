import { Elysia, t } from 'elysia';
import { readProblems } from '../api-responses.ts';
import { conceptPage, conceptWorksPage, conceptWorksQuery } from '../modules/concept-page/contract.ts';
import { readConcept, readConceptWorks } from '../modules/concept-page/read.ts';
import { discoveryError } from '../modules/discovery/management.ts';
import { ConceptSearchInvalid, ConceptSearchUnavailable, searchConcepts } from '../modules/semantic/concept-search.ts';
import { readId, readLanguage, readUuid } from '../modules/work/read-contract.ts';
import { workRead, WorkReadUnavailable } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { workReadError, workReadProblems } from './work-reads.ts';

// Public reads: a bearer never widens what a Concept page shows.
export const openApiOperations = {
  '/v1/concepts/{id}': { get: { bearer: false } },
  '/v1/concepts/{id}/works': { get: { bearer: false } },
} as const;

const params = t.Object({ id: readUuid });
const headers = { 'cache-control': 'no-store' };

export function conceptRoutes(work: MainWorkDependencies) {
  return new Elysia().get('/v1/concepts', { query: t.Object({
    q: t.String({ minLength: 1, maxLength: 240 }), language: t.String({ minLength: 2, maxLength: 40 }),
    realm: t.Optional(readId), limit: t.Optional(t.Integer({ minimum: 1, maximum: 20 })),
    /** Replay lookup: also return isolated propositions the current scheme replaced. */
    isolated: t.Optional(t.Literal('true')),
  }, { additionalProperties: false }), response: { 200: t.Object({ items: t.Array(t.Object({
    concept: readId, label: t.String(), language: t.String(), realm: t.Nullable(readId),
  }), { maxItems: 20 }), hasMore: t.Boolean() }), ...readProblems } }, async ({ query }) => {
    try { return Response.json(await searchConcepts(work.environment, { ...query, isolated: query.isolated === 'true' }),
      { headers: { 'cache-control': 'no-store' } }); }
    catch (error) {
      if (error instanceof ConceptSearchInvalid) return problem(400, 'invalid_concept_search', error.message);
      if (error instanceof ConceptSearchUnavailable) return problem(503, 'concept_search_unavailable', error.message);
      return commandError(error);
    }
  }).get('/v1/concepts/:id', { params,
    query: t.Object({ language: t.Optional(readLanguage) }, { additionalProperties: false }),
    response: { 200: conceptPage, ...workReadProblems },
  }, async ({ request, params: path, query }) => {
    try {
      return Response.json(await workRead(work, new Request(request.url), { language: query.language },
        session => readConcept(session, `https://rezics.com/id/${path.id}`)), { headers });
    } catch (error) { return workReadError(error); }
  }).get('/v1/concepts/:id/works', { params, query: conceptWorksQuery,
    response: { 200: conceptWorksPage, ...workReadProblems },
  }, async ({ request, params: path, query }) => {
    try {
      if (!work.discovery) throw new WorkReadUnavailable('Discovery owner is unavailable');
      return Response.json(await workRead(work, new Request(request.url), { ...query,
        retainedBasis: true }, session => readConceptWorks(session, work.discovery!,
        `https://rezics.com/id/${path.id}`, query)), { headers });
    } catch (error) { return discoveryError(error); }
  });
}
