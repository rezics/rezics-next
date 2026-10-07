import { Elysia, t } from 'elysia';
import { pendingOperation, problemResult } from '../api-contract.ts';
import { writeProblems } from '../api-responses.ts';
import { setWorkMetadata } from '../modules/work/metadata-command.ts';
import { stateWorkType } from '../modules/work/type-command.ts';
import { WorkTypeConflict, WORK_TYPE_OPTIONS_V2, WORK_TYPE_OPTIONS_V1 } from '../modules/work/type-schema.ts';
import { InvalidWorkSemanticTypes, MAX_WORK_SEMANTIC_TYPES } from '../modules/work/activate.ts';
import { readWorkEdition, readWorkEditions, readWorkMetadata } from '../modules/work/metadata-read.ts';
import { metadataWrite, metadataEditionState, metadataEditionStateV2, metadataHeaderState, InvalidWorkMetadata,
  StaleWorkMetadata, WorkMetadataUnavailable } from '../modules/work/metadata-schema.ts';
import { pageFields, pageQuery, readId, readLanguage, readPosition, readQuery, readUuid }
  from '../modules/work/read-contract.ts';
import { workRead } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { typeIri } from '../modules/types/contract.ts';
import { workReadError, workReadProblems } from './work-reads.ts';

const params = t.Object({ id: readUuid });
const headers = { 'cache-control': 'private, no-store' };
const detail: { security: Record<string, string[]>[] } = { security: [{}, { bearerAuth: [] }] };
export const openApiOperations = {
  '/v1/works/{id}/metadata': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false }, put: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/works/{id}/type': { put: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/works/{id}/editions': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } },
  '/v1/works/{id}/editions/{edition}': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } },
} as const;
function metadataError(error: unknown) {
  if (error instanceof InvalidWorkMetadata) return problem(400, 'invalid_work_metadata', error.message);
  if (error instanceof StaleWorkMetadata) return problem(409, 'metadata_basis_changed', 'Refresh metadata and retry with a new key');
  if (error instanceof WorkMetadataUnavailable) return problem(503, 'metadata_unavailable', 'Work metadata is unavailable');
  return workReadError(error);
}
export function workMetadataRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .put('/v1/works/:id/type', { params,
      body: t.Union([
        t.Object({ profile: t.Literal('work-type-v1'), expectedHead: readId,
          types: t.Array(t.String({ enum: WORK_TYPE_OPTIONS_V1 }),
            { maxItems: MAX_WORK_SEMANTIC_TYPES, uniqueItems: true }),
          actingSubject: readId }, { additionalProperties: false }),
        t.Object({ profile: t.Literal('work-type-v2'), expectedHead: readId,
          types: t.Array(t.String({ enum: WORK_TYPE_OPTIONS_V2 }),
            { maxItems: MAX_WORK_SEMANTIC_TYPES, uniqueItems: true }),
          actingSubject: readId }, { additionalProperties: false }),
        t.Object({ profile: t.Literal('work-type-v3'), expectedHead: readId,
          types: t.Array(typeIri, { maxItems: MAX_WORK_SEMANTIC_TYPES, uniqueItems: true }),
          actingSubject: readId }, { additionalProperties: false }),
      ]),
      response: { 200: t.Object({ profile: t.Union([t.Literal('work-type-v2'), t.Literal('work-type-v3')]), work: readId,
        revision: readId, predecessor: readId,
        types: t.Array(typeIri,
          { maxItems: MAX_WORK_SEMANTIC_TYPES }),
        receipt: t.String(), sourcePosition: readPosition, replayed: t.Boolean() }),
        202: pendingOperation, ...writeProblems },
    }, async ({ request, params: path, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const receipt = await stateWorkType(work.environment, work.account, work.access, request,
          { work: `https://rezics.com/id/${path.id}`, expectedHead: body.expectedHead,
            types: body.types, actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ profile: body.profile === 'work-type-v3' ? 'work-type-v3' : 'work-type-v2', work: receipt.work,
          revision: receipt.revision, predecessor: receipt.predecessor,
          types: [...body.types].sort(), receipt: receipt.receipt,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, { headers });
      } catch (error) {
        if (error instanceof InvalidWorkSemanticTypes) {
          return problem(400, 'invalid_work_semantic_types', 'Work types conflict');
        }
        if (error instanceof WorkTypeConflict) {
          return problem(409, 'work_type_conflict', error.message);
        }
        return commandError(error);
      }
    })
    .put('/v1/works/:id/metadata', { params, body: metadataWrite,
      response: { 200: t.Object({ work: readId, component: t.String(), revision: readId, receipt: t.String(),
        sourcePosition: readPosition, replayed: t.Boolean() }), 202: pendingOperation,
        ...writeProblems, 422: problemResult(422) },
    }, async ({ request, params: path, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try { return Response.json(await setWorkMetadata(work, request,
        { ...body, work: `https://rezics.com/id/${path.id}`, idempotencyKey }), { headers }); }
      catch (error) { return metadataError(error); }
    })
    .get('/v1/works/:id/metadata', { params, detail,
      query: t.Object(readQuery, { additionalProperties: false }),
      response: { 200: t.Object({ work: readId, revision: t.Nullable(readId),
        originalTitle: metadataHeaderState.properties.originalTitle,
        completionStatus: t.Nullable(metadataHeaderState.properties.completionStatus),
        localized: metadataHeaderState.properties.localized, sourcePosition: readPosition }), ...workReadProblems },
    }, async ({ request, params: path, query: options }) => {
      try { return Response.json(await workRead(work, request, options,
        session => readWorkMetadata(session, `https://rezics.com/id/${path.id}`)), { headers }); }
      catch (error) { return metadataError(error); }
    })
    .get('/v1/works/:id/editions/:edition', { params: t.Object({ id: readUuid, edition: readUuid }), detail,
      query: t.Object(readQuery, { additionalProperties: false }),
      response: { 200: t.Object({ id: readId, revision: readId, status: metadataEditionState.properties.status,
        record: t.Nullable(t.Union([metadataEditionState, metadataEditionStateV2])), sourcePosition: readPosition }),
        ...workReadProblems },
    }, async ({ request, params: path, query: options }) => {
      try { return Response.json(await workRead(work, request, options,
        session => readWorkEdition(session, `https://rezics.com/id/${path.id}`, `https://rezics.com/id/${path.edition}`)), { headers }); }
      catch (error) { return metadataError(error); }
    })
    .get('/v1/works/:id/editions', { params, detail,
      query: t.Object({ ...pageQuery, contentLanguage: t.Optional(readLanguage) }, { additionalProperties: false }),
      response: { 200: t.Object({ items: t.Array(t.Union([
        t.Object({ ...metadataEditionState.properties, revision: readId }),
        t.Object({ ...metadataEditionStateV2.properties, revision: readId })]),
        { maxItems: 20 }), ...pageFields }), ...workReadProblems },
    }, async ({ request, params: path, query: options }) => {
      try { return Response.json(await workRead(work, request, { ...options, localBasis: true,
        localProfiles: ['work-metadata-details-v1', 'work-metadata-details-v2'] },
        session => readWorkEditions(session, `https://rezics.com/id/${path.id}`, options.contentLanguage)), { headers }); }
      catch (error) { return metadataError(error); }
    });
}
