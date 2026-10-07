import { Elysia, t } from 'elysia';
import { candidateInput, checkedCandidates, CatalogueInvalid, CatalogueStale, CatalogueUnavailable } from '../modules/catalogue-intake/schema.ts';
import { searchCatalogue } from '../modules/catalogue-intake/search.ts';
import { verifyCatalogueWork } from '../modules/catalogue-intake/verification.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { pendingOperation, problemResult } from '../api-contract.ts';
import { readId, readPosition, readUuid } from '../modules/work/read-contract.ts';
import { commandError, problem } from './problems.ts';
import { writeProblems } from '../api-responses.ts';
import { workReadError } from './work-reads.ts';

export const openApiOperations = {
  '/v1/catalogue/candidates': { post: { exposure: 'public', rateLimitFamily: 'search', bearer: true } },
  '/v1/works/{id}/catalogue-verifications': { post: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
} as const;
const candidate = t.Object({ work: readId, mainVersion: readId, revision: readId,
  attributes: t.Array(t.Object({ field: t.String(), value: t.String(), language: t.Nullable(t.String()) })) });
const headers = { 'cache-control': 'private, no-store' };

function catalogueError(error: unknown) {
  if (error instanceof CatalogueInvalid) return problem(400, 'invalid_catalogue_intake', error.message);
  if (error instanceof CatalogueStale) return problem(409, 'catalogue_basis_changed', error.message);
  if (error instanceof CatalogueUnavailable) return problem(503, 'catalogue_unavailable', error.message);
  return workReadError(error);
}

export function catalogueCandidateRoutes(deps: MainWorkDependencies) {
  return new Elysia()
    .post('/v1/catalogue/candidates', { body: candidateInput,
      response: { 200: t.Object({ profile: t.Literal('catalogue-candidates-v1'), candidateReceipt: t.String(),
        complete: t.Literal(false), candidates: t.Array(candidate, { maxItems: 128 }), sourcePosition: readPosition }),
      ...writeProblems, 429: problemResult(429) },
    }, async ({ request, body }) => {
      if (!deps.catalogueIntake) return problem(503, 'catalogue_unavailable', 'Catalogue intake is unavailable');
      try {
        const input = checkedCandidates(body);
        const principal = await deps.account.verify(request, ['work:create']);
        const principalId = await deps.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'contributor_inactive', 'Contributor is inactive');
        const found = await searchCatalogue(deps, input);
        const candidateReceipt = await deps.catalogueIntake.recordSearch(principalId, input, found.candidates, found.sourcePosition);
        return Response.json({ profile: 'catalogue-candidates-v1', candidateReceipt,
          ...found }, { headers });
      } catch (error) { return catalogueError(error); }
    })
    .post('/v1/works/:id/catalogue-verifications', { params: t.Object({ id: readUuid }),
      body: t.Object({ expectedHead: readId, evidence: t.String({ minLength: 1, maxLength: 2000 }), actingSubject: readId },
        { additionalProperties: false }),
      response: { 200: t.Object({ work: readId, verification: t.Literal('verified'), receipt: t.String(),
        sourcePosition: readPosition, replayed: t.Boolean() }), 202: pendingOperation, ...writeProblems },
    }, async ({ request, params, body }) => {
      const key = request.headers.get('idempotency-key');
      if (!key || !/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      try { return Response.json(await verifyCatalogueWork(deps, request, { ...body,
        work: `https://rezics.com/id/${params.id}`, idempotencyKey: key }), { headers }); }
      catch (error) {
        if (error instanceof CatalogueInvalid || error instanceof CatalogueStale || error instanceof CatalogueUnavailable) return catalogueError(error);
        return commandError(error);
      }
    });
}
