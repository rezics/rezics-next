import { Elysia, t } from 'elysia';
import { pendingOperation } from '../api-contract.ts';
import { writeProblems } from '../api-responses.ts';
import { setRealization } from '../modules/realization/command.ts';
import { readWorkRealization, readWorkRealizations } from '../modules/realization/read.ts';
import { InvalidRealization, StaleRealization, RealizationUnavailable, realizationWrite,
  realizationSource } from '../modules/realization/schema.ts';
import { pageFields, pageQuery, readId, readLanguage, readPosition, readUuid } from '../modules/work/read-contract.ts';
import { workRead } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { problem } from './problems.ts';
import { workReadError, workReadProblems } from './work-reads.ts';

const headers = { 'cache-control': 'private, no-store' };
const native = 'https://rezics.com/id/';
const { expectedHead: ignoredHead, actingSubject: ignoredActor, ...facts } = realizationWrite.properties;
const view = t.Object({ ...facts, work: readId, revision: readId, source: realizationSource,
  legacy: t.Nullable(t.Object({ link: readId, targetWork: readId, targetMainVersion: readId,
    targetMainRevision: readId, sourceWork: readId, sourceMainVersion: readId,
    sourceMainRevision: t.Nullable(readId), sourceVersionStatus: t.String(), status: t.String(),
    contentLanguage: t.String(), translator: readId, publisher: readId, evidence: t.String(),
    authorizingParty: t.Nullable(readId), authorizationScope: t.Nullable(t.String()),
    authorizationEpoch: t.Nullable(t.String()) })) });

export const openApiOperations = {
  '/v1/works/{id}/realizations': { get: { exposure: 'public', bearer: false } },
  '/v1/works/{id}/realizations/{realization}': { get: { exposure: 'public', bearer: false }, put: { exposure: 'public', bearer: true, idempotencyKey: true } },
} as const;

function realizationError(error: unknown) {
  if (error instanceof InvalidRealization) return problem(400, 'invalid_realization', error.message);
  if (error instanceof StaleRealization) return problem(409, 'realization_basis_changed', 'Refresh the realization and retry with a new key');
  if (error instanceof RealizationUnavailable) return problem(503, 'realization_unavailable', 'Realization is unavailable');
  return workReadError(error);
}

export function realizationRoutes(deps: MainWorkDependencies) {
  return new Elysia()
    .put('/v1/works/:id/realizations/:realization', {
      params: t.Object({ id: readUuid, realization: readUuid }), body: realizationWrite,
      response: { 200: t.Object({ work: readId, realization: readId, revision: readId, receipt: t.String(),
        sourcePosition: readPosition, replayed: t.Boolean() }), 202: pendingOperation, ...writeProblems },
    }, async ({ request, params, body }) => {
      const key = request.headers.get('idempotency-key');
      if (!key || !/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      if (body.id !== native + params.realization) return problem(400, 'invalid_realization', 'Realization identity differs from its path');
      try { return Response.json(await setRealization(deps, request, { ...body, work: native + params.id, idempotencyKey: key }), { headers }); }
      catch (error) { return realizationError(error); }
    })
    .get('/v1/works/:id/realizations/:realization', {
      params: t.Object({ id: readUuid, realization: readUuid }),
      query: t.Object({ language: t.Optional(readLanguage), actingSubject: t.Optional(readId), revision: t.Optional(readId) },
        { additionalProperties: false }),
      response: { 200: t.Object({ ...view.properties, sourcePosition: readPosition }), ...workReadProblems },
    }, async ({ request, params, query }) => {
      try { return Response.json(await workRead(deps, request, query, session => readWorkRealization(session,
        native + params.id, native + params.realization, query.revision)), { headers }); }
      catch (error) { return realizationError(error); }
    })
    .get('/v1/works/:id/realizations', { params: t.Object({ id: readUuid }), query: t.Object(pageQuery, { additionalProperties: false }),
      response: { 200: t.Object({ items: t.Array(view, { maxItems: 20 }), ...pageFields }), ...workReadProblems },
    }, async ({ request, params, query }) => {
      try { return Response.json(await workRead(deps, request, query, session => readWorkRealizations(session,
        native + params.id)), { headers }); }
      catch (error) { return realizationError(error); }
    });
}
