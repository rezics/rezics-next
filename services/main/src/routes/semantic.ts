import { transportResponses } from '../transport-responses.ts';
import { Elysia, t } from 'elysia';
import { ProjectionParticipantRefused } from '../modules/relation/change.ts';
import { discloseInventory } from '../modules/disclosure/read.ts';
import { disclosureViewer } from '../modules/disclosure/viewer.ts';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { admittedSemanticChange, SEMANTIC_READ_SCOPE } from '../modules/semantic/admitted.ts';
import { SemanticChangeRejected, SemanticTargetUnavailable, StaleSemanticHead,
  UnavailableSemanticReference } from '../modules/semantic/command.ts';
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
import { readResourceSummaries } from '../modules/media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../modules/media/store.ts';
import { readingPositionRead } from '../modules/reading-position/read.ts';
import { referenceDisclosure } from '../modules/target/disclosed-references.ts';
import { readingPositionQuery } from './reading-positions.ts';
import { workReadError } from './work-reads.ts';
import { WorkReadInvalid, WorkReadMissing, WorkReadMoved, WorkReadUnavailable } from '../modules/work/read-session.ts';

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
const unavailableReferenceProblem = t.Object({
  type: t.Literal('https://rezics.com/problems/unavailable_reference'),
  title: t.Literal('Semantic change is not admitted'), status: t.Literal(422), code: t.Literal('unavailable_reference'),
  itemIndex: t.Integer({ minimum: 0, description: 'Zero-based position in items; 0 for a single change state.' }),
  pointer: t.String({ pattern: '^/', description: 'JSON pointer inside the submitted item, before canonical sorting.' }),
  reference: { ...native, description: 'Exact reference value supplied by the caller at pointer.' },
}, { additionalProperties: false,
  description: 'First unavailable reference in submitted item and field order. Echoes caller input only; hidden and absent targets have identical responses for identical input.' });
export const semanticChangeProblem = t.Union([unavailableReferenceProblem, problemResult(422)]);

export const openApiOperations = {
  '/v1/semantic/changes': { post: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/semantic/changes/bulk': { post: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/semantic/resources/{id}/revisions/{revision}': { get: { exposure: 'public', rateLimitFamily: 'read' } },
  '/v1/semantic/resources/{id}': { get: { exposure: 'public', rateLimitFamily: 'read' } },
} as const;

/** Typed semantic outcomes; everything else uses the shared command problem map. */
export function semanticError(error: unknown): Response {
  if (error instanceof ProjectionParticipantRefused) return problem(422, error.problemCode, error.message);
  if (error instanceof WorkReadInvalid || error instanceof WorkReadMissing || error instanceof WorkReadMoved
    || error instanceof WorkReadUnavailable) return workReadError(error);
  if (error instanceof UnavailableSemanticReference) return problem(422, 'unavailable_reference',
    'Semantic change is not admitted', undefined,
    { itemIndex: error.itemIndex, pointer: error.pointer, reference: error.reference });
  if (error instanceof SemanticChangeRejected) {
    if (error.code === 'immutable-meaning' || error.code === 'unsupported-model-revision') {
      return problem(409, error.code.replaceAll('-', '_'), error.message);
    }
    if (error.code === 'invalid' || error.code === 'unsupported') {
      return problem(400, `${error.code}_semantic_change`, 'Semantic change does not match its profile');
    }
    return problem(422, error.code.replaceAll('-', '_'), 'Semantic change is not admitted');
  }
  if (error instanceof InvalidSemanticValue) return problem(400, 'invalid_semantic_value', 'Semantic value is invalid');
  if (error instanceof UnsupportedSemanticValue) return problem(400, 'unsupported_semantic_value', 'Semantic value is not admitted');
  if (error instanceof StaleSemanticHead) return problem(409, 'stale_head',
    'Expected semantic revision is stale', undefined, { currentHead: error.currentHead });
  if (error instanceof ModelGenerationChanged) return problem(409, 'generation_changed', 'Model generation changed during preparation');
  if (error instanceof SemanticStageRejected) {
    return problem(error.reason === 'too-large' ? 413 : 422, `semantic_stage_${error.reason.replaceAll('-', '_')}`,
      'Semantic bulk stage is not admitted');
  }
  if (error instanceof SemanticStageConflict) return problem(409, 'semantic_stage_conflict', 'Semantic stage key conflicts');
  if (error instanceof SemanticStageUnavailable) return problem(503, 'semantic_stage_unavailable', 'Semantic stage is unavailable');
  // A hidden reference and an absent one share this refusal. Whether the key is
  // sealed is the module's decision, not the status.
  if (error instanceof SemanticTargetUnavailable) return problem(404, 'semantic_unavailable', 'Semantic resource is unavailable');
  return commandError(error);
}

export function readBody(read: SemanticRead) {
  return { profile: 'semantic-change-v1' as const, component: read.component, revision: read.revision,
    predecessor: read.predecessor, modelGeneration: read.modelGeneration, state: read.state,
    references: read.references, export: read.export, sourcePosition: read.sourcePosition };
}

export function semanticRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  const readable = async (request: Request, actingSubject: string | undefined, target: string, revision?: string) => {
    await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
    if (request.headers.get('authorization') && !actingSubject) throw new SemanticChangeRejected('invalid', 'actingSubject is required for an authenticated read');
    const principal = request.headers.get('authorization')
      ? await work.account.verify(request, [SEMANTIC_READ_SCOPE]) : null;
    const actor = principal ? actingSubject! : null;
    const viewer = disclosureViewer(principal);
    const disclosed = async (ref: string, revision?: string) =>
      (await discloseInventory(work.environment, [{ owner: 'graph', resource: ref,
        component: 'record', revision }], viewer, 'read'))[0] === 'visible';
    const canRead = async (ref: string) => {
      if (!await disclosed(ref)) return false;
      if (await work.access.canReadSemanticResource?.(principal, actor, ref, undefined, fuseki)) return true;
      const batch = await readResourceSummaries(work.environment, undefined, { viewer }, {
        resources: [ref], context: DEFAULT_MEDIA_CONTEXT, language: null });
      return batch.summaries[0]?.status === 'available'
        || !!principal && await work.access.canReadWork(principal, actor!, ref);
    };
    // Role members and property values may be typed coordinates (Concepts): one target-reader batch per read.
    const disclose = referenceDisclosure(work.environment,
      { access: work.access, principal, ...(actor ? { actingSubject: actor } : {}) }, canRead);
    return { allowed: (await work.access.canReadSemanticResource?.(principal, actor, target, revision, fuseki) ?? false)
      && await disclosed(target, revision), disclose, principal };
  };
  return new Elysia()
    .post('/v1/semantic/changes', {
      body: t.Object({ profile: t.Literal('semantic-change-v1'), target: t.Optional(native),
        expectedHead: t.Nullable(native), state: t.Record(t.String(), t.Unknown()), actingSubject: native },
      { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/semantic/changes"].post, { 200: semanticWrite, 201: semanticWrite, 202: pendingOperation, ...writeProblems,
        404: problemResult(404), 422: semanticChangeProblem }, 'POST'),
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const result = await admittedSemanticChange(work.environment, work.account, work.access, request, {
          ...(body.target ? { target: body.target } : {}), expectedHead: body.expectedHead, state: body.state,
          actingSubject: body.actingSubject, idempotencyKey }, work.platformAccess);
        return Response.json({ profile: 'semantic-change-v1', component: result.component, revision: result.revision,
          predecessor: result.predecessor, receipt: result.receipt, sourcePosition: { datasetId: 'product',
            dataEpoch: result.dataEpoch, sequence: result.sequence }, replayed: result.replayed },
        { status: body.target ? 200 : 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) { return semanticError(error); }
    })
    .post('/v1/semantic/changes/bulk', {
      body: t.Object({ profile: t.Literal(STAGE_PROFILE), items: t.Array(t.Unknown(),
        { minItems: 1, maxItems: STAGE_LIMITS.items }), actingSubject: native }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/semantic/changes/bulk"].post, { 200: semanticBulkWrite, 201: semanticBulkWrite, 202: pendingOperation,
        ...writeProblems, 404: problemResult(404), 413: problemResult(413), 422: semanticChangeProblem }, 'POST'),
    }, async ({ request, body }) => {
      if (!work.semanticStages) return problem(503, 'semantic_stage_unavailable', 'Semantic staging is unavailable');
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const result = await admittedSemanticBulkChange({ env: work.environment, account: work.account,
          platformAccess: work.platformAccess,
          access: work.access, store: work.semanticStages, request, actingSubject: body.actingSubject,
          idempotencyKey, states: body.items });
        return Response.json({ ...result, replayed: result.replayed },
          { status: result.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) { return semanticError(error); }
    })
    .get('/v1/semantic/resources/:id', {
      params: t.Object({ id: groupUuid }),
      query: t.Object({ actingSubject: t.Optional(native), position: readingPositionQuery }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/semantic/resources/{id}"].get, { 200: semanticRead, ...authorizedReadProblems }, 'GET'),
    }, async ({ request, params, query }) => {
      try {
        const target = `https://rezics.com/id/${params.id}`;
        const { allowed, disclose, principal } = await readable(request, query.actingSubject, target);
        if (!allowed) return problem(404, 'semantic_unavailable', 'Semantic resource is unavailable');
        const read = await readingPositionRead(work, request, principal, query.actingSubject,
          boundary => readSemanticCurrent(work.environment, target, disclose, records => boundary.visible(records)));
        if (!read) return problem(404, 'semantic_unavailable', 'Semantic resource is unavailable');
        if (!(await readable(request, query.actingSubject, target)).allowed) {
          return problem(404, 'semantic_unavailable', 'Semantic resource is unavailable');
        }
        return Response.json(readBody(read), { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return semanticError(error); }
    })
    .get('/v1/semantic/resources/:id/revisions/:revision', {
      params: t.Object({ id: groupUuid, revision: groupUuid }),
      query: t.Object({ actingSubject: t.Optional(native), position: readingPositionQuery }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/semantic/resources/{id}/revisions/{revision}"].get, { 200: semanticRead, ...authorizedReadProblems }, 'GET'),
    }, async ({ request, params, query }) => {
      try {
        const target = `https://rezics.com/id/${params.id}`;
        const { allowed, disclose, principal } = await readable(request, query.actingSubject, target,
          `https://rezics.com/id/${params.revision}`);
        if (!allowed) return problem(404, 'revision_unavailable', 'Revision is unavailable');
        const read = await readingPositionRead(work, request, principal, query.actingSubject,
          boundary => readSemanticRevision(work.environment, target,
            `https://rezics.com/id/${params.revision}`, disclose, records => boundary.visible(records)));
        if (!read) return problem(404, 'revision_unavailable', 'Revision is unavailable');
        if (!(await readable(request, query.actingSubject, target,
          `https://rezics.com/id/${params.revision}`)).allowed) {
          return problem(404, 'revision_unavailable', 'Revision is unavailable');
        }
        return Response.json(readBody(read), { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return semanticError(error); }
    });
}
