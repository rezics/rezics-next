import { Elysia, t } from 'elysia';
import { identificationEvidence, identificationInput, InvalidPostIdentification,
  PostIdentificationConflict, PostIdentificationUnavailable } from '../modules/post/identification-schema.ts';
import { identifyPost } from '../modules/post/identification.ts';
import { readPostIdentification, readPostIdentifications } from '../modules/post/identification-read.ts';
import { pageFields, readId, readLanguage, readName, readUuid } from '../modules/work/read-contract.ts';
import { workRead } from '../modules/work/read-session.ts';
import { pendingOperation } from '../api-contract.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { workReadError, workReadProblems } from './work-reads.ts';
import { compositionError } from './compositions.ts';
import { problem } from './problems.ts';
import { SemanticChangeRejected, SemanticTargetUnavailable, StaleSemanticHead } from '../modules/semantic/command.ts';
import { semanticError } from './semantic.ts';
import { StaleWorkMetadata } from '../modules/work/metadata-schema.ts';
import { WorkReadMissing } from '../modules/work/read-session.ts';

const result = t.Object({ profile: t.Literal('post-identification-v1'), identification: readId,
  post: readId, work: readId, mainVersion: readId, structure: readId, occurrence: readId,
  relation: readId, relationRevision: readId, evidence: identificationEvidence, receipt: t.String(),
  receipts: t.Object({ work: t.Nullable(t.String()), metadata: t.Nullable(t.String()), structure: t.String(),
    placement: t.String(), relation: t.String() }),
  sourcePosition: t.Object({ datasetId: t.Literal('product'), dataEpoch: t.String(), sequence: t.String() }) });
const item = t.Object({ ...result.properties, title: readName });
const link = t.Object({ identification: readId, work: readId, mainVersion: readId,
  structure: readId, occurrence: readId, title: item.properties.title, receipt: t.String() });
const query = { actingSubject: t.Optional(readId), language: t.Optional(readLanguage) };
const headers = { 'cache-control': 'private, no-store' };
export const openApiOperations = {
  '/v1/posts/{id}/identifications': { post: { bearer: true, idempotencyKey: true }, get: { bearer: false } },
  '/v1/post-identifications/{id}': { get: { bearer: false } },
} as const;

export function postIdentificationRoutes(deps: MainWorkDependencies) {
  return new Elysia().post('/v1/posts/:id/identifications', {
    params: t.Object({ id: readUuid }), body: identificationInput,
    response: { 200: t.Object({ ...result.properties, replayed: t.Boolean() }),
      202: pendingOperation, ...workReadProblems },
  }, async ({ request, params, body }) => {
    const key = request.headers.get('idempotency-key');
    if (!key || !/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
    try { return Response.json(await identifyPost(deps, request, `https://rezics.com/id/${params.id}`, body, key), { headers }); }
    catch (error) {
      if (error instanceof InvalidPostIdentification) return problem(400, 'invalid_post_identification', error.message);
      if (error instanceof PostIdentificationConflict) return problem(409, 'post_identification_conflict', error.message);
      if (error instanceof PostIdentificationUnavailable) return problem(503, 'post_identification_unavailable', error.message);
      if (error instanceof WorkReadMissing) return workReadError(error);
      if (error instanceof SemanticChangeRejected || error instanceof SemanticTargetUnavailable || error instanceof StaleSemanticHead) return semanticError(error);
      if (error instanceof StaleWorkMetadata) return problem(409, 'post_identification_metadata_changed', error.message);
      return compositionError(error);
    }
  }).get('/v1/posts/:id/identifications', {
    params: t.Object({ id: readUuid }), query: t.Object({ ...query,
      limit: t.Optional(t.Integer({ minimum: 1, maximum: 20 })), cursor: t.Optional(t.String({ minLength: 1, maxLength: 2048 })) },
    { additionalProperties: false }),
    response: { 200: t.Object({ profile: t.Literal('post-identifications-v1'), post: readId,
      items: t.Array(link, { maxItems: 20 }), ...pageFields }), ...workReadProblems },
  }, async ({ request, params, query: options }) => {
    try { return Response.json(await workRead(deps, request, options,
      session => readPostIdentifications(session, `https://rezics.com/id/${params.id}`)), { headers }); }
    catch (error) { return workReadError(error); }
  }).get('/v1/post-identifications/:id', {
    params: t.Object({ id: readUuid }), query: t.Object(query, { additionalProperties: false }),
    response: { 200: item, ...workReadProblems },
  }, async ({ request, params, query: options }) => {
    try { return Response.json(await workRead(deps, request, options,
      session => readPostIdentification(session, params.id)), { headers }); }
    catch (error) { return workReadError(error); }
  });
}
