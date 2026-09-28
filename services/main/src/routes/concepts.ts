import { Elysia, t } from 'elysia';
import { readProblems } from '../api-responses.ts';
import { ConceptSearchInvalid, ConceptSearchUnavailable, searchConcepts } from '../modules/semantic/concept-search.ts';
import { readId } from '../modules/work/read-contract.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

export function conceptRoutes(work: MainWorkDependencies) {
  return new Elysia().get('/v1/concepts', { query: t.Object({
    q: t.String({ minLength: 1, maxLength: 240 }), language: t.String({ minLength: 2, maxLength: 40 }),
    realm: t.Optional(readId), limit: t.Optional(t.Integer({ minimum: 1, maximum: 20 })),
  }, { additionalProperties: false }), response: { 200: t.Object({ items: t.Array(t.Object({
    concept: readId, label: t.String(), language: t.String(), realm: t.Nullable(readId),
  }), { maxItems: 20 }), hasMore: t.Boolean() }), ...readProblems } }, async ({ query }) => {
    try { return Response.json(await searchConcepts(work.environment, query),
      { headers: { 'cache-control': 'no-store' } }); }
    catch (error) {
      if (error instanceof ConceptSearchInvalid) return problem(400, 'invalid_concept_search', error.message);
      if (error instanceof ConceptSearchUnavailable) return problem(503, 'concept_search_unavailable', error.message);
      return commandError(error);
    }
  });
}
