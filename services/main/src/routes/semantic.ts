import { Elysia, t } from 'elysia';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { admittedSemanticChange, canReadSemantic, referenceReader, SEMANTIC_READ_SCOPE } from '../modules/semantic/admitted.ts';
import { SemanticChangeRejected, SemanticTargetUnavailable, StaleSemanticHead } from '../modules/semantic/command.ts';
import { readSemanticCurrent, readSemanticRevision, type SemanticRead } from '../modules/semantic/read.ts';
import { InvalidSemanticValue, UnsupportedSemanticValue } from '../modules/semantic/value.ts';
import { ModelGenerationChanged } from '../modules/semantic/generation-guard.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import { pendingOperation, problemResult } from '../api-contract.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { groupUuid } from './shared.ts';
import { STAGE_LIMITS, STAGE_PROFILE } from '../modules/semantic/stage-schema.ts';
import { admittedSemanticBulkChange, SemanticStageConflict, SemanticStageRejected,
  SemanticStageUnavailable } from '../modules/semantic/staging.ts';

const native = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const position = t.Object({ datasetId: t.Literal('product'), dataEpoch: t.String(), sequence: t.String() });
const semanticWrite = t.Object({ profile: t.Literal('semantic-change-v1'), component: t.String(),
  revision: t.String(), predecessor: t.Nullable(t.String()), receipt: t.String(), sourcePosition: position,
  replayed: t.Boolean() });
const semanticRead = t.Object({ profile: t.Literal('semantic-change-v1'), component: t.String(),
  revision: t.String(), predecessor: t.Nullable(t.String()), modelGeneration: t.String(), state: t.Unknown(),
  references: t.Record(t.String(), t.Object({ state: t.Union([t.Literal('available'), t.Literal('unavailable')]) })),
  export: t.Record(t.String(), t.Unknown()), sourcePosition: position });
const semanticBulkWrite = t.Object({ profile: t.Literal(STAGE_PROFILE), stageId: t.String(),
  modelGeneration: t.String(), receipt: t.String(), sourcePosition: position, itemCount: t.Number(),
  items: t.Array(t.Object({ component: native, revision: native })), replayed: t.Boolean() });

export const openApiOperations = {
  '/v1/semantic/changes': { post: { bearer: true, idempotencyKey: true } },
  '/v1/semantic/changes/bulk': { post: { bearer: true, idempotencyKey: true } },
  '/v1/semantic/resources/{id}': { get: { bearer: true } },
  '/v1/semantic/resources/{id}/revisions/{revision}': { get: { bearer: true } },
} as const;

/** Typed semantic outcomes; everything else uses the shared command problem map. */
export function semanticError(error: unknown): Response {
  if (error instanceof SemanticChangeRejected) {
    if (error.code === 'invalid' || error.code === 'unsupported') {
      return problem(400, `${error.code}_semantic_change`, 'Semantic change does not match its profile');
    }
    return problem(422, error.code.replaceAll('-', '_'), 'Semantic change is not admitted');
  }
  if (error instanceof InvalidSemanticValue) return problem(400, 'invalid_semantic_value', 'Semantic value is invalid');
  if (error instanceof UnsupportedSemanticValue) return problem(400, 'unsupported_semantic_value', 'Semantic value is not admitted');
  if (error instanceof StaleSemanticHead) return problem(409, 'stale_head', 'Expected semantic revision is stale');
  if (error instanceof ModelGenerationChanged) return problem(409, 'generation_changed', 'Model generation changed during preparation');
  if (error instanceof SemanticStageRejected) {
    return problem(error.reason === 'too-large' ? 413 : 422, `semantic_stage_${error.reason.replaceAll('-', '_')}`,
      'Semantic bulk stage is not admitted');
  }
  if (error instanceof SemanticStageConflict) return problem(409, 'semantic_stage_conflict', 'Semantic stage key conflicts');
  if (error instanceof SemanticStageUnavailable) return problem(503, 'semantic_stage_unavailable', 'Semantic stage is unavailable');
  if (error instanceof SemanticTargetUnavailable) return problem(404, 'semantic_unavailable', 'Semantic resource is unavailable');
  return commandError(error);
}

export function readBody(read: SemanticRead) {
  return { profile: 'semantic-change-v1' as const, component: read.component, revision: read.revision,
    predecessor: read.predecessor, modelGeneration: read.modelGeneration, state: read.state,
    references: read.references, export: read.export, sourcePosition: read.sourcePosition };
}

export function semanticRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  const readable = async (request: Request, actingSubject: string, target: string) => {
    await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
    const principal = await work.account.verify(request, [SEMANTIC_READ_SCOPE]);
    const canRead = referenceReader(work.access, principal, actingSubject);
    return { allowed: await canReadSemantic(work.access, principal, actingSubject, target), canRead };
  };
  return new Elysia()
    .post('/v1/semantic/changes', {
      body: t.Object({ profile: t.Literal('semantic-change-v1'), target: t.Optional(native),
        expectedHead: t.Nullable(native), state: t.Record(t.String(), t.Unknown()), actingSubject: native },
      { additionalProperties: false }),
      response: { 200: semanticWrite, 201: semanticWrite, 202: pendingOperation, ...writeProblems,
        404: problemResult(404), 422: problemResult(422) },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const result = await admittedSemanticChange(work.environment, work.account, work.access, request, {
          ...(body.target ? { target: body.target } : {}), expectedHead: body.expectedHead, state: body.state,
          actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ profile: 'semantic-change-v1', component: result.component, revision: result.revision,
          predecessor: result.predecessor, receipt: result.receipt, sourcePosition: { datasetId: 'product',
            dataEpoch: result.dataEpoch, sequence: result.sequence }, replayed: result.replayed },
        { status: body.target ? 200 : 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) { return semanticError(error); }
    })
    .post('/v1/semantic/changes/bulk', {
      body: t.Object({ profile: t.Literal(STAGE_PROFILE), items: t.Array(t.Unknown(),
        { minItems: 1, maxItems: STAGE_LIMITS.items }), actingSubject: native }, { additionalProperties: false }),
      response: { 200: semanticBulkWrite, 201: semanticBulkWrite, 202: pendingOperation,
        ...writeProblems, 404: problemResult(404), 413: problemResult(413), 422: problemResult(422) },
    }, async ({ request, body }) => {
      if (!work.semanticStages) return problem(503, 'semantic_stage_unavailable', 'Semantic staging is unavailable');
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const result = await admittedSemanticBulkChange({ env: work.environment, account: work.account,
          access: work.access, store: work.semanticStages, request, actingSubject: body.actingSubject,
          idempotencyKey, states: body.items });
        return Response.json({ ...result, replayed: result.replayed },
          { status: result.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) { return semanticError(error); }
    })
    .get('/v1/semantic/resources/:id', {
      params: t.Object({ id: groupUuid }),
      query: t.Object({ actingSubject: native }, { additionalProperties: false }),
      response: { 200: semanticRead, ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        const target = `https://rezics.com/id/${params.id}`;
        const { allowed, canRead } = await readable(request, query.actingSubject, target);
        if (!allowed) return problem(404, 'semantic_unavailable', 'Semantic resource is unavailable');
        const read = await readSemanticCurrent(work.environment, target, canRead);
        if (!read) return problem(404, 'semantic_unavailable', 'Semantic resource is unavailable');
        return Response.json(readBody(read), { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return semanticError(error); }
    })
    .get('/v1/semantic/resources/:id/revisions/:revision', {
      params: t.Object({ id: groupUuid, revision: groupUuid }),
      query: t.Object({ actingSubject: native }, { additionalProperties: false }),
      response: { 200: semanticRead, ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        const target = `https://rezics.com/id/${params.id}`;
        const { allowed, canRead } = await readable(request, query.actingSubject, target);
        if (!allowed) return problem(404, 'revision_unavailable', 'Revision is unavailable');
        const read = await readSemanticRevision(work.environment, target,
          `https://rezics.com/id/${params.revision}`, canRead);
        if (!read) return problem(404, 'revision_unavailable', 'Revision is unavailable');
        return Response.json(readBody(read), { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return semanticError(error); }
    });
}
