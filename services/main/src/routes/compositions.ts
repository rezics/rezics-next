import { Elysia, t } from 'elysia';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { ObjectIntegrityError, ObjectUnavailable } from '../infrastructure/immutable-objects.ts';
import { createAdmittedComposition, changeAdmittedComposition, sealAdmittedComposition,
  restoreAdmittedComposition, activateAdmittedCompositionStage }
  from '../modules/structure/change-admitted.ts';
import { cancelCompositionStage, CompositionConflict, CompositionExists, CompositionTooLarge,
  InvalidCompositionChange, StaleCompositionHead } from '../modules/structure/change.ts';
import { CompositionCorrupt, CompositionUnavailable, readCompositionHeader }
  from '../modules/structure/graph.ts';
import { readCompositionPage } from '../modules/structure/read.ts';
import { readCompositionSeal } from '../modules/structure/seal-read.ts';
import { canReadStructureTarget, structureProfileFor } from '../modules/structure/profiles.ts';
import { StructureObjectCorrupt, StructureObjectUnavailable } from '../modules/structure/tree.ts';
import { InvalidStructureObject, type OccurrenceRecord } from '../modules/structure/format.ts';
import { StructureStageConflict, StructureStageInvalid, StructureStageUnavailable }
  from '../modules/structure/stage.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import { pendingOperation, problemResult } from '../api-contract.ts';
import { authorizedReadProblems } from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { groupUuid } from './shared.ts';

const ref = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const selection = t.Union([t.Object({ mode: t.Literal('follow-context') }),
  t.Object({ mode: t.Literal('fixed-revision'), revision: t.String() })]);
const label = t.Object({ value: t.String({ minLength: 1, maxLength: 500 }),
  language: t.String() });
const position = t.Union([t.Literal('first'), t.Literal('last'),
  t.Object({ after: ref }, { additionalProperties: false })]);
const operation = t.Union([
  t.Object({ op: t.Literal('insert'), parent: ref, position,
    role: t.Union([t.Literal('group'), t.Literal('chapter')]),
    target: t.Optional(t.String({ format: 'uri' })),
    selection: t.Optional(selection), label: t.Optional(label), sourceKey: t.Optional(t.String()) },
  { additionalProperties: false }),
  t.Object({ op: t.Literal('move'), occurrence: ref, parent: ref, position },
    { additionalProperties: false }),
  t.Object({ op: t.Literal('remove'), occurrence: ref }, { additionalProperties: false }),
]);
const sourcePosition = t.Object({ datasetId: t.Literal('product'), dataEpoch: t.String(),
  sequence: t.String() });
const cost = t.Object({ pagesRead: t.Integer(), pagesWritten: t.Integer(),
  placementsWritten: t.Integer(), segmentsWritten: t.Integer(), rebalanced: t.Integer() });
const writeResult = t.Object({ structure: ref, owner: t.Optional(ref), component: t.Optional(ref),
  mainVersion: t.Optional(ref),
  revision: t.Optional(ref), expectedHead: t.Optional(ref), seal: t.Optional(ref),
  receipt: t.String(), replayed: t.Boolean(), occurrences: t.Optional(t.Array(ref)),
  cost: t.Optional(cost), sourcePosition });
const occurrence = t.Object({ occurrence: ref, state: t.Union([t.Literal('active'),
  t.Literal('removed')]), parent: ref,
  segmentKey: t.Optional(t.String()), orderKey: t.Optional(t.String()),
  removedBy: t.Optional(ref), role: t.Union([t.Literal('group'),
    t.Literal('chapter')]), target: t.Optional(t.String()), selection: t.Optional(selection),
  labels: t.Array(label), sourceKey: t.Optional(t.String()), introducedBy: ref });
const pageResult = t.Object({ structure: ref, owner: ref, component: ref, work: ref,
  mainVersion: ref, revision: ref,
  predecessor: t.Nullable(ref), placementCount: t.Integer(), occurrences: t.Array(occurrence),
  next: t.Nullable(t.String()), sourcePosition,
  cost: t.Object({ pagesRead: t.Integer(), pagesWritten: t.Integer() }) });
const writeResponses = { 200: writeResult, 201: writeResult, 202: pendingOperation,
  400: problemResult(400), 401: problemResult(401), 403: problemResult(403),
  404: problemResult(404), 409: problemResult(409), 500: problemResult(500),
  503: problemResult(503) };
const readResponses = { 200: pageResult, ...authorizedReadProblems };
export const openApiOperations = {
  '/v1/compositions': { post: { bearer: true, idempotencyKey: true } },
  '/v1/compositions/{id}/changes': { post: { bearer: true, idempotencyKey: true } },
  '/v1/compositions/{id}/seals': { post: { bearer: true, idempotencyKey: true } },
  '/v1/compositions/{id}/restorations': { post: { bearer: true, idempotencyKey: true } },
  '/v1/compositions/{id}/stages': { post: { bearer: true, idempotencyKey: true } },
  '/v1/compositions/{id}/stages/{stage}': { get: { bearer: true }, delete: { bearer: true } },
  '/v1/compositions/{id}/stages/{stage}/lease': { post: { bearer: true } },
  '/v1/compositions/{id}/stages/{stage}/pages/{ordinal}': { put: { bearer: true } },
  '/v1/compositions/{id}/stages/{stage}/seal': { post: { bearer: true } },
  '/v1/compositions/{id}/stages/{stage}/activate': { post: { bearer: true } },
} as const;
const sealPageResult = t.Object({ structure: ref, seal: ref, structureRevision: ref,
  coverage: t.Union([t.Literal('complete'), t.Literal('partial')]), unavailableCount: t.Integer(),
  pins: t.Array(t.Object({ occurrence: ref, target: t.Optional(t.String()),
    variant: t.Optional(t.String()), revision: t.Optional(t.String()),
    unavailable: t.Optional(t.Union([t.Literal('erased'), t.Literal('withdrawn'),
      t.Literal('undisclosed'), t.Literal('missing')])) })), next: t.Nullable(t.String()),
  sourcePosition, cost: t.Object({ pagesRead: t.Integer(), pagesWritten: t.Integer() }) });

function key(request: Request): string | null {
  const value = request.headers.get('idempotency-key');
  return value && /^[A-Za-z0-9:_./-]{1,128}$/.test(value) ? value : null;
}

function compositionError(error: unknown): Response {
  if (error instanceof StructureStageInvalid || error instanceof InvalidStructureObject) {
    return problem(400, 'invalid_structure_stage', error.message);
  }
  if (error instanceof StructureStageConflict) return problem(409, 'structure_stage_conflict', error.message);
  if (error instanceof StructureStageUnavailable) return problem(404, 'structure_stage_unavailable',
    'Structure stage is unavailable');
  if (error instanceof InvalidCompositionChange) return problem(400, 'invalid_composition', error.message);
  if (error instanceof CompositionUnavailable) return problem(404, 'composition_unavailable',
    'Composition is unavailable');
  if (error instanceof StaleCompositionHead) return problem(409, 'stale_composition_head', error.message);
  if (error instanceof CompositionConflict || error instanceof CompositionExists
    || error instanceof CompositionTooLarge) return problem(409, 'composition_conflict', error.message);
  if (error instanceof CompositionCorrupt || error instanceof StructureObjectCorrupt
    || error instanceof StructureObjectUnavailable || error instanceof ObjectUnavailable
    || error instanceof ObjectIntegrityError) return problem(503, 'composition_unavailable',
    'Composition history is unavailable');
  return commandError(error);
}

const writeBody = t.Object({ actingSubject: ref }, { additionalProperties: false });

const stageResult = t.Object({ id: groupUuid, structure: ref, generation: ref,
  baseHead: ref, revision: ref, status: t.Union([t.Literal('staging'), t.Literal('sealed'),
    t.Literal('activated'), t.Literal('cancelled'), t.Literal('failed')]),
  holder: t.Nullable(groupUuid), fence: t.String(), pages: t.Integer(), records: t.Integer(),
  bytes: t.Integer(), manifest: t.Nullable(t.String()), graphStarted: t.Boolean(),
  projectionBatches: t.Integer(), placementCount: t.Nullable(t.Integer()),
  graphReceipt: t.Nullable(t.String()), graphDataEpoch: t.Nullable(t.String()),
  graphSequence: t.Nullable(t.String()), cost: t.Optional(cost) });
const stageResponses = { 200: stageResult, 201: stageResult, 400: problemResult(400),
  401: problemResult(401), 403: problemResult(403), 404: problemResult(404),
  409: problemResult(409), 500: problemResult(500), 503: problemResult(503) };
const stageParams = t.Object({ id: groupUuid, stage: groupUuid });

function compositionStageRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  const context = async (request: Request, structure: string, actingSubject: string) => {
    await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
    const principal = await work.account.verify(request, ['work:edit', 'work:read']);
    const header = await readCompositionHeader(work.environment, structure);
    if (!header || header.profile !== 'book-composition') {
      throw new CompositionUnavailable('composition is unavailable');
    }
    if (!work.access.withWorkEditAuthority) {
      throw new ObjectUnavailable('Structure staging authority is unavailable');
    }
    const proof = await work.access.withWorkEditAuthority(principal, actingSubject, header.work,
      async authority => authority);
    return { principal, header, proof };
  };
  const store = () => {
    if (!work.structureStages) throw new ObjectUnavailable('Structure stage owner is unavailable');
    return work.structureStages;
  };
  return new Elysia()
    .post('/v1/compositions/:id/stages', {
      params: t.Object({ id: groupUuid }),
      body: t.Object({ expectedHead: ref, actingSubject: ref }, { additionalProperties: false }),
      response: stageResponses,
    }, async ({ request, params, body }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      try {
        const structure = `https://rezics.com/id/${params.id}`;
        const { header, proof } = await context(request, structure, body.actingSubject);
        if (header.head !== body.expectedHead) throw new StaleCompositionHead('stage basis is stale');
        const stage = await store().create({ principalId: proof.principalId, idempotencyKey,
          scope: proof.scope, structure, baseHead: body.expectedHead });
        return Response.json(stage, { status: 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) { return compositionError(error); }
    })
    .get('/v1/compositions/:id/stages/:stage', {
      params: stageParams, query: t.Object({ actingSubject: ref }, { additionalProperties: false }),
      response: stageResponses,
    }, async ({ request, params, query }) => {
      try {
        const structure = `https://rezics.com/id/${params.id}`;
        const { proof } = await context(request, structure, query.actingSubject);
        return Response.json(await store().read(params.stage, proof.principalId, structure),
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return compositionError(error); }
    })
    .post('/v1/compositions/:id/stages/:stage/lease', {
      params: stageParams, body: writeBody, response: stageResponses,
    }, async ({ request, params, body }) => {
      try {
        const structure = `https://rezics.com/id/${params.id}`;
        const { proof } = await context(request, structure, body.actingSubject);
        return Response.json(await store().renew(params.stage, proof.principalId, structure),
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return compositionError(error); }
    })
    .put('/v1/compositions/:id/stages/:stage/pages/:ordinal', {
      params: t.Object({ id: groupUuid, stage: groupUuid,
        ordinal: t.Numeric({ minimum: 0, maximum: 16383 }) }),
      body: t.Object({ actingSubject: ref, holder: groupUuid, fence: t.String(),
        entries: t.Array(t.Unknown(), { minItems: 1, maxItems: 256 }) },
      { additionalProperties: false }), response: stageResponses,
    }, async ({ request, params, body }) => {
      try {
        const structure = `https://rezics.com/id/${params.id}`;
        const { proof } = await context(request, structure, body.actingSubject);
        return Response.json(await store().upload({ id: params.stage, principalId: proof.principalId,
          structure, holder: body.holder, fence: body.fence, ordinal: params.ordinal,
          entries: body.entries as OccurrenceRecord[] }),
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return compositionError(error); }
    })
    .post('/v1/compositions/:id/stages/:stage/seal', {
      params: stageParams,
      body: t.Object({ actingSubject: ref, holder: groupUuid, fence: t.String() },
        { additionalProperties: false }), response: stageResponses,
    }, async ({ request, params, body }) => {
      try {
        const structure = `https://rezics.com/id/${params.id}`;
        const { header, proof, principal } = await context(request, structure, body.actingSubject);
        return Response.json(await store().seal({ id: params.stage, principalId: proof.principalId,
          structure, mainVersion: header.mainVersion, holder: body.holder, fence: body.fence,
          canReadTarget: target => canReadStructureTarget(structureProfileFor(header.profile), {
            access: work.access, principal, actingSubject: body.actingSubject, target }) }),
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return compositionError(error); }
    })
    .post('/v1/compositions/:id/stages/:stage/activate', {
      params: stageParams, body: writeBody, response: { ...stageResponses, 202: pendingOperation },
    }, async ({ request, params, body }) => {
      try {
        const structure = `https://rezics.com/id/${params.id}`;
        const { proof } = await context(request, structure, body.actingSubject);
        const stage = await store().read(params.stage, proof.principalId, structure);
        if (stage.status === 'activated') {
          return Response.json(stage, { headers: { 'cache-control': 'no-store' } });
        }
        if (stage.status !== 'sealed' || !stage.manifest) {
          throw new StructureStageConflict('stage is not sealed for activation');
        }
        const result = await activateAdmittedCompositionStage(work.environment, work.account,
          work.access, request, { structure, expectedHead: stage.baseHead, stageId: stage.id,
            generation: stage.generation, revision: stage.revision, manifestDigest: stage.manifest,
            actingSubject: body.actingSubject, idempotencyKey: `structure-stage-${stage.id}`,
            onGraphStart: () => store().beginActivation(stage.id, proof.principalId, structure),
            onProjectionBatch: previous => store().advanceProjectionBatch(stage.id,
              proof.principalId, structure, previous) });
        if (result.outcome === 'cancelled') {
          await store().fail(stage.id, proof.principalId, structure, {
            receipt: result.receipt, dataEpoch: result.dataEpoch, sequence: result.sequence,
            reason: result.reason ?? 'graph-cancelled' });
          if (result.reason === 'stale-head') throw new StaleCompositionHead('stage basis is stale');
          throw new CompositionConflict('stage activation was rejected by the graph');
        }
        if (!result.revision) throw new StructureStageConflict('stage activation lacks a revision');
        const activated = await store().activate(stage.id, proof.principalId, structure,
          { receipt: result.receipt, dataEpoch: result.dataEpoch, sequence: result.sequence,
            revision: result.revision });
        return Response.json({ ...activated, ...(result.cost ? { cost: result.cost } : {}) },
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return compositionError(error); }
    })
    .delete('/v1/compositions/:id/stages/:stage', {
      params: stageParams, body: writeBody, response: stageResponses,
    }, async ({ request, params, body }) => {
      try {
        const structure = `https://rezics.com/id/${params.id}`;
        const { proof } = await context(request, structure, body.actingSubject);
        const stage = await store().read(params.stage, proof.principalId, structure);
        if (stage.status === 'cancelled') return Response.json(stage,
          { headers: { 'cache-control': 'no-store' } });
        if (!['staging', 'sealed'].includes(stage.status)) {
          throw new StructureStageConflict('settled stage cannot be cancelled');
        }
        const receipt = stage.graphStarted
          ? await cancelCompositionStage(work.environment, stage) : undefined;
        return Response.json(await store().cancel(params.stage, proof.principalId, structure, receipt),
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return compositionError(error); }
    });
}

/** Book Composition is the first Structure write/read template. */
export function compositionRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  if (work.structureObjects) {
    (work.environment as typeof work.environment & { structureObjects?: typeof work.structureObjects })
      .structureObjects = work.structureObjects;
  }
  return new Elysia()
    .post('/v1/compositions', {
      body: t.Object({ profile: t.Literal('book-composition'), work: ref,
        mainVersion: ref, ...writeBody.properties }, { additionalProperties: false }),
      response: writeResponses,
    }, async ({ request, body }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      try {
        const result = await createAdmittedComposition(work.environment, work.account, work.access,
          request, { work: body.work, mainVersion: body.mainVersion,
            actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ structure: result.structure, mainVersion: result.mainVersion,
          revision: result.revision, receipt: result.receipt, replayed: result.replayed,
          sourcePosition: { datasetId: 'product', dataEpoch: result.dataEpoch,
            sequence: result.sequence } }, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return compositionError(error); }
    })
    .post('/v1/compositions/:id/changes', {
      params: t.Object({ id: groupUuid }),
      body: t.Object({ profile: t.Literal('book-composition'), expectedHead: ref,
        operations: t.Array(operation, { minItems: 1, maxItems: 16 }),
        ...writeBody.properties }, { additionalProperties: false }),
      response: writeResponses,
    }, async ({ request, params, body }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      try {
        const result = await changeAdmittedComposition(work.environment, work.account, work.access,
          request, { structure: `https://rezics.com/id/${params.id}`, expectedHead: body.expectedHead,
            operations: body.operations, actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ structure: result.structure, revision: result.revision,
          expectedHead: result.expectedHead, receipt: result.receipt, replayed: result.replayed,
          occurrences: result.occurrences ?? [], ...(result.cost ? { cost: result.cost } : {}),
          sourcePosition: { datasetId: 'product', dataEpoch: result.dataEpoch,
            sequence: result.sequence } }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return compositionError(error); }
    })
    .post('/v1/compositions/:id/seals', {
      params: t.Object({ id: groupUuid }),
      body: t.Object({ expectedHead: ref, ...writeBody.properties },
        { additionalProperties: false }), response: writeResponses,
    }, async ({ request, params, body }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      try {
        const result = await sealAdmittedComposition(work.environment, work.account, work.access,
          request, { structure: `https://rezics.com/id/${params.id}`, expectedHead: body.expectedHead,
            actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ structure: result.structure, revision: result.revision,
          expectedHead: result.expectedHead, seal: result.seal, receipt: result.receipt,
          replayed: result.replayed, sourcePosition: { datasetId: 'product',
            dataEpoch: result.dataEpoch, sequence: result.sequence } },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return compositionError(error); }
    })
    .post('/v1/compositions/:id/restorations', {
      params: t.Object({ id: groupUuid }),
      body: t.Object({ expectedHead: ref, restoredFrom: ref, ...writeBody.properties },
        { additionalProperties: false }), response: writeResponses,
    }, async ({ request, params, body }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      try {
        const result = await restoreAdmittedComposition(work.environment, work.account, work.access,
          request, { structure: `https://rezics.com/id/${params.id}`,
            expectedHead: body.expectedHead, restoredFrom: body.restoredFrom,
            actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ structure: result.structure, revision: result.revision,
          expectedHead: result.expectedHead, receipt: result.receipt, replayed: result.replayed,
          ...(result.cost ? { cost: result.cost } : {}), sourcePosition: { datasetId: 'product',
            dataEpoch: result.dataEpoch, sequence: result.sequence } },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return compositionError(error); }
    })
    .get('/v1/compositions/:id', {
      params: t.Object({ id: groupUuid }),
      query: t.Object({ actingSubject: ref, parent: t.Optional(ref),
        after: t.Optional(t.String({ maxLength: 512 })), limit: t.Optional(t.Numeric({
          minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
      response: readResponses,
    }, async ({ request, params, query }) => {
      try {
        const structure = `https://rezics.com/id/${params.id}`;
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const principal = await work.account.verify(request, ['work:read']);
        const header = await readCompositionHeader(work.environment, structure);
        if (!header || !await work.access.canReadWork(principal, query.actingSubject, header.work)) {
          return problem(404, 'composition_unavailable', 'Composition is unavailable');
        }
        const page = await readCompositionPage(work.environment, { structure,
          ...(query.parent ? { parent: query.parent } : {}), ...(query.after ? { after: query.after } : {}),
          limit: query.limit ?? 50,
          canReadTarget: target => canReadStructureTarget(structureProfileFor(header.profile), {
            access: work.access, principal, actingSubject: query.actingSubject, target }) });
        return Response.json(page, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return compositionError(error); }
    })
    .get('/v1/compositions/:id/revisions/:revision', {
      params: t.Object({ id: groupUuid, revision: groupUuid }),
      query: t.Object({ actingSubject: ref, parent: t.Optional(ref),
        after: t.Optional(t.String({ maxLength: 512 })), limit: t.Optional(t.Numeric({
          minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
      response: readResponses,
    }, async ({ request, params, query }) => {
      try {
        const structure = `https://rezics.com/id/${params.id}`;
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const principal = await work.account.verify(request, ['work:read']);
        const header = await readCompositionHeader(work.environment, structure);
        if (!header || !await work.access.canReadWork(principal, query.actingSubject, header.work)) {
          return problem(404, 'composition_unavailable', 'Composition is unavailable');
        }
        const page = await readCompositionPage(work.environment, { structure,
          revision: `https://rezics.com/id/${params.revision}`,
          ...(query.parent ? { parent: query.parent } : {}), ...(query.after ? { after: query.after } : {}),
          limit: query.limit ?? 50,
          canReadTarget: target => canReadStructureTarget(structureProfileFor(header.profile), {
            access: work.access, principal, actingSubject: query.actingSubject, target }) });
        return Response.json(page, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return compositionError(error); }
    })
    .get('/v1/compositions/:id/seals/:seal', {
      params: t.Object({ id: groupUuid, seal: groupUuid }),
      query: t.Object({ actingSubject: ref, after: t.Optional(t.String({ maxLength: 512 })),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })) },
      { additionalProperties: false }),
      response: { 200: sealPageResult, ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        const structure = `https://rezics.com/id/${params.id}`;
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const principal = await work.account.verify(request, ['work:read']);
        const header = await readCompositionHeader(work.environment, structure);
        if (!header || !await work.access.canReadWork(principal, query.actingSubject, header.work)) {
          return problem(404, 'composition_unavailable', 'Composition is unavailable');
        }
        const page = await readCompositionSeal(work.environment, { structure,
          seal: `https://rezics.com/id/${params.seal}`,
          ...(query.after ? { after: query.after } : {}), limit: query.limit ?? 50,
          canReadTarget: target => canReadStructureTarget(structureProfileFor(header.profile), {
            access: work.access, principal, actingSubject: query.actingSubject, target }) });
        return Response.json(page, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return compositionError(error); }
    })
    .get('/v1/compositions/:id/occurrences/:occurrence', {
      params: t.Object({ id: groupUuid, occurrence: groupUuid }),
      query: t.Object({ actingSubject: ref, revision: t.Optional(ref) },
        { additionalProperties: false }), response: readResponses,
    }, async ({ request, params, query }) => {
      try {
        const structure = `https://rezics.com/id/${params.id}`;
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const principal = await work.account.verify(request, ['work:read']);
        const header = await readCompositionHeader(work.environment, structure);
        if (!header || !await work.access.canReadWork(principal, query.actingSubject, header.work)) {
          return problem(404, 'composition_unavailable', 'Composition is unavailable');
        }
        const page = await readCompositionPage(work.environment, { structure,
          occurrence: `https://rezics.com/id/${params.occurrence}`,
          ...(query.revision ? { revision: query.revision } : {}), limit: 1,
          canReadTarget: target => canReadStructureTarget(structureProfileFor(header.profile), {
            access: work.access, principal, actingSubject: query.actingSubject, target }) });
        return Response.json(page, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return compositionError(error); }
    })
    .use(compositionStageRoutes(fuseki, work));
}
