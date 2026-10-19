import { transportResponses } from '../transport-responses.ts';
import { logWorkerFault } from '@rezics/observability/log';
import { Elysia, t } from 'elysia';
import type { Static } from 'typebox';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { ObjectIntegrityError, ObjectUnavailable } from '../infrastructure/immutable-objects.ts';
import { createAdmittedComposition, changeAdmittedComposition, sealAdmittedComposition,
  restoreAdmittedComposition, activateAdmittedCompositionStage }
  from '../modules/structure/change-admitted.ts';
import { cancelCompositionStage, CompositionConflict, CompositionExists, CompositionTooLarge,
  InvalidCompositionChange, StaleCompositionHead, StructureSummaryRepairRequired, type CompositionOperation } from '../modules/structure/change.ts';
import { CompositionCorrupt, CompositionUnavailable, readCompositionHeader, derivedId }
  from '../modules/structure/graph.ts';
import { selectWorkCompositionRevision, type CompositionPage } from '../modules/structure/read.ts';
import { readVisibleCompositionPage } from '../modules/collection/visible-page.ts';
import { readCompositionSeal } from '../modules/structure/seal-read.ts';
import { canReadStructureTarget, structureProfileFor } from '../modules/structure/profiles.ts';
import { StructureObjectCorrupt, StructureObjectUnavailable } from '../modules/structure/tree.ts';
import { InvalidStructureObject, structureQualifierText, type OccurrenceRecord } from '../modules/structure/format.ts';
import { StructureStageConflict, StructureStageInvalid, StructureStageUnavailable }
  from '../modules/structure/stage.ts';
import { planStructureRefresh, readStructureSnapshot, StructureRefreshInvalid }
  from '../modules/structure/refresh.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import { pendingOperation, problemResult } from '../api-contract.ts';
import { authorizedReadProblems } from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { problem } from './problems.ts';
import { resourceTargetReader } from '../modules/target/resolve.ts';
import { canReadCompositionWork, canReadCompositionResource,
  compositionTargetReader, compositionTargetBatchReader } from '../modules/composition/disclosure-read.ts';
import { workRead, type WorkReadSession } from '../modules/work/read-session.ts';
import { WorkReadMoved } from '../modules/work/read-session.ts';
import { structureRevisionDisclosureVisible } from '../modules/work/read-header.ts';
import { workReadError, workReadProblems } from './work-reads.ts';
import { groupUuid } from './shared.ts';
import { readNativeExportPage, NATIVE_EXPORT_PAGE_SIZE } from '../modules/export/native-page.ts';
import { requireZoneEditor } from '../modules/zone/editor.ts';
import { ZoneUnavailable } from '../modules/zone/configuration.ts';

import { ingredientLine, recipeStep } from './recipe-qualifiers.ts';
import { ExactInstructionSelector } from '../modules/structure/selection.ts';
const ref = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const selection = t.Union([t.Object({ mode: t.Literal('follow-context') }),
  t.Object({ mode: t.Literal('fixed-revision'), revision: t.String(),
    selector: t.Optional(ExactInstructionSelector) })]);
const label = t.Object({ value: t.String({ minLength: 1, maxLength: 500 }),
  language: t.String() });
const position = t.Union([t.Literal('first'), t.Literal('last'),
  t.Object({ after: ref }, { additionalProperties: false })]);
/** How a group divides the Book: numbered volumes, titled parts, or unnumbered extras. */
const division = t.Union([t.Literal('volume'), t.Literal('part'), t.Literal('extras')]);
const profile = t.String({ minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' });
const roleName = t.String({ minLength: 1, maxLength: 32, pattern: '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' });
type DeclaredStructureQualifier = Extract<NonNullable<OccurrenceRecord['qualifier']>, { type: 'fields' }>;
// Keep the existing immutable field envelope at the transport boundary, including
// exact fractions. The selected owner still admits each field and its meaning.
export const declaredStructureQualifier = t.Unsafe<DeclaredStructureQualifier>(t.Object({
  type: t.Literal('fields'),
  id: t.String({ minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' }),
  values: t.Record(t.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z][A-Za-z0-9]*$' }), t.Union([
    t.String({ minLength: 1, maxLength: 4000 }), t.Boolean(),
    t.Object({ numerator: t.Integer({ minimum: 0, maximum: 1_000_000_000_000 }),
      denominator: t.Integer({ minimum: 1, maximum: 1_000_000_000_000 }) }, { additionalProperties: false }),
    structureQualifierText(4000),
    t.Array(t.String({ minLength: 1, maxLength: 2048 }), { maxItems: 64 }),
  ]), { additionalProperties: false }),
}, { additionalProperties: false }));
const declaredQualifier = declaredStructureQualifier;
const noteQualifier = t.Object({ note: t.String({ minLength: 1, maxLength: 4000 }) },
  { additionalProperties: false });
const inclusion = t.Union([t.Literal('required'), t.Literal('optional'), t.Literal('extra')]);
const completion = t.Object({ status: t.Union([t.Literal('concluded'), t.Literal('ongoing'), t.Literal('unknown')]),
  evidence: t.Array(t.String({ format: 'uri', maxLength: 2048 }), { maxItems: 16, uniqueItems: true }) }, { additionalProperties: false });
const operation = t.Union([
  t.Object({ op: t.Literal('completion'), completion }, { additionalProperties: false }),
  t.Object({
      op: t.Literal('insert'),
      parent: ref,
      position,
      role: roleName,
      target: t.Optional(t.String({ format: 'uri' })),
      qualifier: t.Optional(t.Union([ingredientLine, recipeStep, declaredQualifier, noteQualifier])),
      selection: t.Optional(selection),
      label: t.Optional(label),
      sourceKey: t.Optional(t.String()),
      division: t.Optional(division),
      displayLabel: t.Optional(t.String({ minLength: 1, maxLength: 500 })),
      inclusion: t.Optional(inclusion),
    },
  { additionalProperties: false }),
  t.Object({ op: t.Literal('move'), occurrence: ref, parent: ref, position },
    { additionalProperties: false }),
  t.Object({ op: t.Literal('remove'), occurrence: ref }, { additionalProperties: false }),
  t.Object({ op: t.Literal('update'), occurrence: ref, label: t.Optional(label),
    target: t.Optional(t.String({ format: 'uri' })), selection: t.Optional(selection),
    qualifier: t.Optional(t.Nullable(t.Union([ingredientLine, recipeStep, declaredQualifier, noteQualifier]))),
    division: t.Optional(division), displayLabel: t.Optional(t.String({ minLength: 1, maxLength: 500 })),
    inclusion: t.Optional(inclusion) }, { additionalProperties: false }),
]);
type BodyOperation = Static<typeof operation>;

/** A group's division travels as the Book group qualifier of the Structure command. */
function commandOperation(item: BodyOperation, profileId: string): CompositionOperation {
  if (item.op !== 'insert' && item.op !== 'update') return item;
  if (
    item.qualifier !== undefined &&
    (item.division !== undefined || item.displayLabel !== undefined || item.inclusion !== undefined)
  ) {
    throw new InvalidCompositionChange('an occurrence carries one qualifier');
  }
  const { division: groupDivision, displayLabel, inclusion: partInclusion, qualifier, ...rest } = item;
  if (qualifier === null) {
    if (item.op !== 'update') throw new InvalidCompositionChange('only an update can clear its qualifier');
    return { ...rest, op: 'update', occurrence: item.occurrence, qualifier: null };
  }
  if (displayLabel !== undefined || partInclusion !== undefined || item.op === 'insert' && item.role === 'part') {
    if (!displayLabel || !partInclusion || groupDivision || item.op === 'insert' && item.role !== 'part') {
      throw new InvalidCompositionChange('a Work part requires its display label and inclusion');
    }
    return { ...rest, qualifier: { type: 'work-part', displayLabel, inclusion: partInclusion } };
  }
  if (groupDivision && item.op === 'insert' && item.role !== 'group') {
    throw new InvalidCompositionChange('only a group has a division');
  }
  if (qualifier && !('type' in qualifier)) {
    const registration = structureProfileFor(profileId);
    const spec = item.op === 'insert' ? registration.qualifiers?.[item.role]
      : Object.values(registration.qualifiers ?? {}).find(candidate => candidate.textFields?.includes('note'));
    if (!spec || spec.type !== 'fields' || !spec.fieldId) {
      throw new InvalidCompositionChange('qualifier is not admitted by this Structure profile');
    }
    return { ...rest, qualifier: { type: 'fields' as const, id: spec.fieldId, values: { note: qualifier.note } } };
  }
  return { ...rest, ...(qualifier !== undefined ? { qualifier } : {}),
    ...(groupDivision ? { qualifier: { type: 'book-group' as const, division: groupDivision } } : {}) };
}
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
  removedBy: t.Optional(ref), role: roleName, target: t.Optional(t.String()), selection: t.Optional(selection),
  labels: t.Array(label), sourceKey: t.Optional(t.String()), introducedBy: ref,
  qualifier: t.Optional(t.Union([
      ingredientLine,
      recipeStep,
      declaredQualifier,
      t.Object({ type: t.Literal('book-group'), division }, { additionalProperties: false }),
      t.Object(
        { type: t.Literal('work-part'), displayLabel: t.String(), inclusion },
        { additionalProperties: false },
      ),
    ])) });
const pageResult = t.Object({ structure: ref, owner: ref, component: ref, work: ref,
  mainVersion: ref, revision: ref,
  predecessor: t.Nullable(ref), placementCount: t.Optional(t.Integer()), completion: t.Optional(completion),
  occurrences: t.Array(occurrence),
  next: t.Nullable(t.String()), sourcePosition,
  cost: t.Optional(t.Object({ pagesRead: t.Integer(), pagesWritten: t.Integer() })) });
const writeResponses = { 200: writeResult, 201: writeResult, 202: pendingOperation, ...workReadProblems };
const readResponses = { 200: pageResult, ...authorizedReadProblems, ...workReadProblems };
function disclosedPage(page: CompositionPage) {
  // Scan costs depend on hidden membership and stay internal to the read.
  const { placementCount: _count, cost: _cost, ...disclosed } = page;
  return disclosed;
}
async function disclosedComposition<T>(work: MainWorkDependencies, request: Request,
  structure: string, actingSubject: string | undefined,
  options: { revision?: string; selectedRoot?: boolean },
  read: (session: WorkReadSession, header: NonNullable<Awaited<ReturnType<typeof readCompositionHeader>>>,
    revision: string) => Promise<T>) {
  return workRead(work, request, { actingSubject }, async session => {
    const header = await readCompositionHeader(work.environment, structure);
    if (!header || !await (structureProfileFor(header.profile).componentPredicate
      ? canReadCompositionWork(session, header.work) : canReadCompositionResource(session, header.owner))) {
      throw new CompositionUnavailable('Composition is unavailable');
    }
    const profile = structureProfileFor(header.profile);
    if (header.profile === 'zone-navigation') {
      const read = async () => {
        if (!session.principal || !actingSubject) return false;
        try { await requireZoneEditor(work, request, header.owner, actingSubject); return true; }
        catch (error) { if (error instanceof ZoneUnavailable) return false; throw error; }
      };
      const allowed = await read();
      session.observeDependency(`zone-navigation-preview:${header.owner}`, allowed, read);
      if (!allowed) throw new CompositionUnavailable('Composition is unavailable');
    }
    const requestedRevision = options.revision;
    let revision = requestedRevision ?? header.head;
    if (options.selectedRoot !== false && profile.workPublication === true) {
      revision = await selectWorkCompositionRevision(session, header, requestedRevision);
      if (!await structureRevisionDisclosureVisible(session, { work: header.work,
        structure, revision })) throw new CompositionUnavailable('Composition is unavailable');
      const result = await read(session, header, revision);
      if (!await structureRevisionDisclosureVisible(session, { work: header.work,
        structure, revision })) throw new WorkReadMoved('Structure disclosure changed during read');
      return result;
    }
    return read(session, header, revision);
  });
}
export const openApiOperations = {
  '/v1/compositions': { post: { rateLimitFamily: 'write', exposure: 'public', bearer: true, idempotencyKey: true } },
  '/v1/compositions/{id}/export': { get: { rateLimitFamily: 'read', exposure: 'public', bearer: true } },
  '/v1/compositions/{id}': { get: { rateLimitFamily: 'read', exposure: 'public', bearer: false } },
  '/v1/compositions/{id}/revisions/{revision}': { get: { rateLimitFamily: 'read', exposure: 'public', bearer: false } },
  '/v1/compositions/{id}/occurrences/{occurrence}': { get: { rateLimitFamily: 'read', exposure: 'public', bearer: false } },
  // Reopens if a public book page ever reads an imported seal.
  '/v1/compositions/{id}/seals/{seal}': { get: { rateLimitFamily: 'read', exposure: 'platform:catalogue-import', bearer: false } },
  '/v1/compositions/{id}/changes': { post: { rateLimitFamily: 'write', exposure: 'public', bearer: true, idempotencyKey: true } },
  '/v1/compositions/{id}/seals': { post: { rateLimitFamily: 'write', exposure: 'platform:catalogue-import', bearer: true, idempotencyKey: true } },
  '/v1/compositions/{id}/restorations': { post: { rateLimitFamily: 'write', exposure: 'public', bearer: true, idempotencyKey: true } },
  '/v1/compositions/{id}/stages': { post: { rateLimitFamily: 'write', exposure: 'platform:catalogue-import', bearer: true, idempotencyKey: true } },
  '/v1/compositions/{id}/stages/{stage}': { get: { rateLimitFamily: 'read', exposure: 'platform:catalogue-import', bearer: true }, delete: { rateLimitFamily: 'write', exposure: 'platform:catalogue-import', bearer: true } },
  '/v1/compositions/{id}/stages/{stage}/lease': { post: { rateLimitFamily: 'write', exposure: 'platform:catalogue-import', bearer: true } },
  '/v1/compositions/{id}/stages/{stage}/pages/{ordinal}': { put: { rateLimitFamily: 'write', exposure: 'platform:catalogue-import', bearer: true } },
  '/v1/compositions/{id}/stages/{stage}/seal': { post: { rateLimitFamily: 'write', exposure: 'platform:catalogue-import', bearer: true } },
  '/v1/compositions/{id}/stages/{stage}/activate': { post: { rateLimitFamily: 'write', exposure: 'platform:catalogue-import', bearer: true } },
  '/v1/compositions/{id}/refreshes': { post: { rateLimitFamily: 'write', exposure: 'platform:catalogue-import', bearer: true, idempotencyKey: true } },
} as const;
const sealPageResult = t.Object({ structure: ref, seal: ref, structureRevision: ref,
  coverage: t.Union([t.Literal('complete'), t.Literal('partial')]),
  pins: t.Array(t.Object({ occurrence: ref, target: t.Optional(t.String()),
    variant: t.Optional(t.String()), revision: t.Optional(t.String()),
    unavailable: t.Optional(t.Union([t.Literal('erased'), t.Literal('withdrawn'),
      t.Literal('undisclosed'), t.Literal('missing')])) })), next: t.Nullable(t.String()),
  sourcePosition });

function key(request: Request): string | null {
  const value = request.headers.get('idempotency-key');
  return value && /^[A-Za-z0-9:_./-]{1,128}$/.test(value) ? value : null;
}

export function compositionError(error: unknown): Response {
  if (error instanceof StructureStageInvalid || error instanceof InvalidStructureObject) {
    return problem(400, 'invalid_structure_stage', error.message);
  }
  if (error instanceof StructureRefreshInvalid) {
    return problem(400, 'invalid_structure_refresh', error.message);
  }
  if (error instanceof StructureStageConflict) return problem(409, 'structure_stage_conflict', error.message);
  if (error instanceof StructureStageUnavailable) return problem(404, 'structure_stage_unavailable',
    'Structure stage is unavailable');
  if (error instanceof InvalidCompositionChange) return problem(400, 'invalid_composition', error.message);
  if (error instanceof StructureSummaryRepairRequired) {
    return problem(409, 'structure_summary_repair_required', error.message);
  }
  if (error instanceof CompositionUnavailable) return problem(404, 'composition_unavailable',
    'Composition is unavailable');
  if (error instanceof StaleCompositionHead) return problem(409, 'stale_composition_head', error.message);
  if (error instanceof CompositionConflict || error instanceof CompositionExists
    || error instanceof CompositionTooLarge) return problem(409, 'composition_conflict', error.message);
  if (error instanceof CompositionCorrupt || error instanceof StructureObjectCorrupt
    || error instanceof StructureObjectUnavailable || error instanceof ObjectUnavailable
    || error instanceof ObjectIntegrityError) {
    // The same answer for corrupt, missing and unreadable history; the log keeps
    // which of those it was so the 503 can be routed.
    logWorkerFault('main.route.composition_unavailable', error, { messages: false });
    return problem(503, 'composition_unavailable', 'Composition history is unavailable');
  }
  return workReadError(error);
}

const writeBody = t.Object({ actingSubject: ref }, { additionalProperties: false });

const stageResult = t.Object({ id: groupUuid, structure: ref, generation: ref,
  kind: t.Union([t.Literal('replace'), t.Literal('import'), t.Literal('refresh')]),
  sourceRef: t.Nullable(ref), sourceRevision: t.Nullable(ref),
  mappingPolicy: t.Nullable(t.Union([t.Literal('source-key'), t.Literal('explicit')])),
  baseHead: ref, revision: ref, status: t.Union([t.Literal('staging'), t.Literal('sealed'),
    t.Literal('activated'), t.Literal('cancelled'), t.Literal('failed')]),
  holder: t.Nullable(groupUuid), fence: t.String(), pages: t.Integer(), records: t.Integer(),
  bytes: t.Integer(), manifest: t.Nullable(t.String()), graphStarted: t.Boolean(),
  projectionBatches: t.Integer(), placementCount: t.Nullable(t.Integer()),
  graphReceipt: t.Nullable(t.String()), graphDataEpoch: t.Nullable(t.String()),
  graphSequence: t.Nullable(t.String()), cost: t.Optional(cost) });
const stageResponses = { 200: stageResult, 201: stageResult, ...workReadProblems };
const refreshConflict = t.Object({ ...problemResult(409).properties,
  conflicts: t.Array(t.Object({ sourceKey: t.String(), reason: t.String() }, { additionalProperties: false })) },
{ additionalProperties: false });
const refreshResponses = { ...stageResponses, 409: t.Union([problemResult(409), refreshConflict]) };
const stageParams = t.Object({ id: groupUuid, stage: groupUuid });

function compositionStageRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  const context = async (request: Request, structure: string, actingSubject: string) => {
    await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
    const principal = await work.account.verify(request, ['work:edit', 'work:read']);
    const header = await readCompositionHeader(work.environment, structure);
    if (!header) throw new CompositionUnavailable('composition is unavailable');
    structureProfileFor(header.profile);
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
      response: transportResponses(openApiOperations["/v1/compositions/{id}/stages"].post, stageResponses, 'POST'),
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
      response: transportResponses(openApiOperations["/v1/compositions/{id}/stages/{stage}"].get, stageResponses, 'GET'),
    }, async ({ request, params, query }) => {
      try {
        const structure = `https://rezics.com/id/${params.id}`;
        const { proof } = await context(request, structure, query.actingSubject);
        return Response.json(await store().read(params.stage, proof.principalId, structure),
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return compositionError(error); }
    })
    .post('/v1/compositions/:id/stages/:stage/lease', {
      params: stageParams, body: writeBody, response: transportResponses(openApiOperations["/v1/compositions/{id}/stages/{stage}/lease"].post, stageResponses, 'POST'),
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
      { additionalProperties: false }), response: transportResponses(openApiOperations["/v1/compositions/{id}/stages/{stage}/pages/{ordinal}"].put, stageResponses, 'PUT'),
    }, async ({ request, params, body }) => {
      try {
        const structure = `https://rezics.com/id/${params.id}`;
        const { header, proof } = await context(request, structure, body.actingSubject);
        return Response.json(await store().upload({ id: params.stage, principalId: proof.principalId,
          profile: header.profile,
          structure, holder: body.holder, fence: body.fence, ordinal: params.ordinal,
          entries: body.entries as OccurrenceRecord[] }),
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return compositionError(error); }
    })
    .post('/v1/compositions/:id/stages/:stage/seal', {
      params: stageParams,
      body: t.Object({ actingSubject: ref, holder: groupUuid, fence: t.String() },
        { additionalProperties: false }), response: transportResponses(openApiOperations["/v1/compositions/{id}/stages/{stage}/seal"].post, stageResponses, 'POST'),
    }, async ({ request, params, body }) => {
      try {
        const structure = `https://rezics.com/id/${params.id}`;
        const { header, proof, principal } = await context(request, structure, body.actingSubject);
        return Response.json(await store().seal({ id: params.stage, principalId: proof.principalId,
          structure, mainVersion: header.mainVersion, holder: body.holder, fence: body.fence,
          profile: header.profile,
          canReadTarget: target => canReadStructureTarget(structureProfileFor(header.profile), {
            environment: work.environment, access: work.access, principal, actingSubject: body.actingSubject, target,
              targetReader: resourceTargetReader(work, request, body.actingSubject) }) }),
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return compositionError(error); }
    })
    .post('/v1/compositions/:id/stages/:stage/activate', {
      params: stageParams, body: writeBody, response: transportResponses(openApiOperations["/v1/compositions/{id}/stages/{stage}/activate"].post, { ...stageResponses, 202: pendingOperation }, 'POST'),
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
            kind: stage.kind, sourceRef: stage.sourceRef, sourceRevision: stage.sourceRevision,
            mappingPolicy: stage.mappingPolicy,
            actingSubject: body.actingSubject, idempotencyKey: `structure-stage-${stage.id}`,
            onGraphStart: () => store().beginActivation(stage.id, proof.principalId, structure),
            onProjectionBatch: previous => store().advanceProjectionBatch(stage.id,
              proof.principalId, structure, previous) }, resourceTargetReader(work, request, body.actingSubject));
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
    .post('/v1/compositions/:id/refreshes', {
      params: t.Object({ id: groupUuid }),
      body: t.Object({ expectedHead: ref, sourceStructure: ref, sourceRevision: ref,
        actingSubject: ref }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/compositions/{id}/refreshes"].post, { ...refreshResponses, 202: pendingOperation }, 'POST'),
    }, async ({ request, params, body }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      try {
        const structure = `https://rezics.com/id/${params.id}`;
        const { header, proof, principal } = await context(request, structure, body.actingSubject);
        if (body.sourceStructure === structure) {
          throw new StructureRefreshInvalid('a Structure cannot refresh from itself');
        }
        const sourceHeader = await readCompositionHeader(work.environment, body.sourceStructure);
        if (!sourceHeader || sourceHeader.profile !== header.profile
          || !await work.access.canReadWork(principal, body.actingSubject, sourceHeader.owner)) {
          throw new CompositionUnavailable('Structure source is unavailable');
        }
        const local = await readStructureSnapshot(work.environment, structure, body.expectedHead);
        const priorSource = local.manifest.source;
        if (priorSource && (priorSource.ref !== body.sourceStructure
          || priorSource.mappingPolicy !== 'source-key')) {
          throw new StructureRefreshInvalid('Structure source correspondence differs from retained basis');
        }
        const source = await readStructureSnapshot(work.environment,
          body.sourceStructure, body.sourceRevision);
        const base = priorSource ? await readStructureSnapshot(work.environment,
          body.sourceStructure, priorSource.revision) : undefined;
        let stage = await store().create({ principalId: proof.principalId,
          idempotencyKey: `refresh:${idempotencyKey}`, scope: proof.scope, structure,
          baseHead: body.expectedHead, kind: base ? 'refresh' : 'import',
          sourceRef: body.sourceStructure, sourceRevision: body.sourceRevision,
          mappingPolicy: 'source-key' });
        if (stage.status === 'cancelled') throw new StructureStageConflict('refresh plan was rejected');
        if (stage.status === 'activated') return Response.json(stage,
          { headers: { 'cache-control': 'no-store' } });
        if (header.head !== body.expectedHead) {
          if (stage.status === 'staging') await store().cancel(stage.id, proof.principalId, structure);
          throw new StaleCompositionHead('refresh basis is stale');
        }
        if (stage.status === 'staging') {
          const plan = planStructureRefresh({ profile: header.profile, source, ...(base ? { base } : {}), local,
            revision: stage.revision });
          if (plan.conflicts.length) {
            await store().cancel(stage.id, proof.principalId, structure);
            return problem(409, 'structure_refresh_conflict',
              'Source and local changes need a correspondence decision', undefined, { conflicts: plan.conflicts });
          }
          stage = await store().renew(stage.id, proof.principalId, structure);
          const records = [...plan.records].sort((a, b) => a.occurrence.localeCompare(b.occurrence));
          for (let ordinal = 0; ordinal * 256 < records.length; ordinal++) {
            stage = await store().upload({ id: stage.id, principalId: proof.principalId,
              structure, holder: stage.holder!, fence: stage.fence, ordinal, profile: header.profile,
              entries: records.slice(ordinal * 256, ordinal * 256 + 256) });
          }
          stage = await store().seal({ id: stage.id, principalId: proof.principalId,
            structure, mainVersion: header.mainVersion, holder: stage.holder!, fence: stage.fence,
            profile: header.profile,
            measures: plan.measures, completion: plan.completion,
            canReadTarget: target => canReadStructureTarget(structureProfileFor(header.profile), {
              environment: work.environment, access: work.access, principal, actingSubject: body.actingSubject, target,
              targetReader: resourceTargetReader(work, request, body.actingSubject) }) });
        }
        if (stage.status !== 'sealed' || !stage.manifest) {
          throw new StructureStageConflict('refresh stage is not sealed');
        }
        const result = await activateAdmittedCompositionStage(work.environment, work.account,
          work.access, request, { structure, expectedHead: stage.baseHead, stageId: stage.id,
            generation: stage.generation, revision: stage.revision, manifestDigest: stage.manifest,
            kind: stage.kind, sourceRef: stage.sourceRef, sourceRevision: stage.sourceRevision,
            mappingPolicy: stage.mappingPolicy, actingSubject: body.actingSubject,
            idempotencyKey: `structure-stage-${stage.id}`,
            onGraphStart: () => store().beginActivation(stage.id, proof.principalId, structure),
            onProjectionBatch: previous => store().advanceProjectionBatch(stage.id,
              proof.principalId, structure, previous) }, resourceTargetReader(work, request, body.actingSubject));
        if (result.outcome === 'cancelled') {
          await store().fail(stage.id, proof.principalId, structure, {
            receipt: result.receipt, dataEpoch: result.dataEpoch, sequence: result.sequence,
            reason: result.reason ?? 'graph-cancelled' });
          if (result.reason === 'stale-head') throw new StaleCompositionHead('refresh basis is stale');
          throw new CompositionConflict('refresh activation was rejected by the graph');
        }
        if (!result.revision) throw new StructureStageConflict('refresh receipt lacks a revision');
        const activated = await store().activate(stage.id, proof.principalId, structure,
          { receipt: result.receipt, dataEpoch: result.dataEpoch, sequence: result.sequence,
            revision: result.revision });
        return Response.json({ ...activated, ...(result.cost ? { cost: result.cost } : {}) },
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return compositionError(error); }
    })
    .delete('/v1/compositions/:id/stages/:stage', {
      params: stageParams, body: writeBody, response: transportResponses(openApiOperations["/v1/compositions/{id}/stages/{stage}"].delete, stageResponses, 'DELETE'),
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
      body: t.Object({ profile, work: ref,
        mainVersion: ref, ...writeBody.properties }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/compositions"].post, writeResponses, 'POST'),
    }, async ({ request, body }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      try {
        const result = await createAdmittedComposition(work.environment, work.account, work.access,
          request, { profile: body.profile, work: body.work, mainVersion: body.mainVersion,
            actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ structure: result.structure, mainVersion: result.mainVersion ?? result.component,
          revision: result.revision, receipt: result.receipt, replayed: result.replayed,
          sourcePosition: { datasetId: 'product', dataEpoch: result.dataEpoch,
            sequence: result.sequence } }, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return compositionError(error); }
    })
    .post('/v1/compositions/:id/changes', {
      params: t.Object({ id: groupUuid }),
      body: t.Object({ profile, expectedHead: ref,
        operations: t.Array(operation, { minItems: 1, maxItems: 16 }),
        ...writeBody.properties }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/compositions/{id}/changes"].post, writeResponses, 'POST'),
    }, async ({ request, params, body }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      try {
        const result = await changeAdmittedComposition(work.environment, work.account, work.access,
          request, { structure: `https://rezics.com/id/${params.id}`, expectedHead: body.expectedHead,
            profile: body.profile, operations: body.operations.map(item => commandOperation(item, body.profile)),
            actingSubject: body.actingSubject, idempotencyKey },
          resourceTargetReader(work, request, body.actingSubject));
        return Response.json({ structure: result.structure, revision: result.revision,
          expectedHead: result.expectedHead, receipt: result.receipt, replayed: result.replayed,
          occurrences: result.occurrences ?? body.operations.flatMap((operation, index) =>
            operation.op === 'insert' && result.revision ? [derivedId(`${result.revision}\0occurrence\0${index}`)] : []),
          ...(result.cost ? { cost: result.cost } : {}),
          sourcePosition: { datasetId: 'product', dataEpoch: result.dataEpoch,
            sequence: result.sequence } }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return compositionError(error); }
    })
    .post('/v1/compositions/:id/seals', {
      params: t.Object({ id: groupUuid }),
      body: t.Object({ expectedHead: ref, ...writeBody.properties },
        { additionalProperties: false }), response: transportResponses(openApiOperations["/v1/compositions/{id}/seals"].post, writeResponses, 'POST'),
    }, async ({ request, params, body }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      try {
        const result = await sealAdmittedComposition(work.environment, work.account, work.access,
          request, { structure: `https://rezics.com/id/${params.id}`, expectedHead: body.expectedHead,
            actingSubject: body.actingSubject, idempotencyKey }, resourceTargetReader(work, request, body.actingSubject));
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
        { additionalProperties: false }), response: transportResponses(openApiOperations["/v1/compositions/{id}/restorations"].post, writeResponses, 'POST'),
    }, async ({ request, params, body }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      try {
        const result = await restoreAdmittedComposition(work.environment, work.account, work.access,
          request, { structure: `https://rezics.com/id/${params.id}`,
            expectedHead: body.expectedHead, restoredFrom: body.restoredFrom,
            actingSubject: body.actingSubject, idempotencyKey }, resourceTargetReader(work, request, body.actingSubject));
        return Response.json({ structure: result.structure, revision: result.revision,
          expectedHead: result.expectedHead, receipt: result.receipt, replayed: result.replayed,
          ...(result.cost ? { cost: result.cost } : {}), sourcePosition: { datasetId: 'product',
            dataEpoch: result.dataEpoch, sequence: result.sequence } },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return compositionError(error); }
    })
    .get('/v1/compositions/:id/export', {
      params: t.Object({ id: groupUuid }),
      query: t.Object({ actingSubject: ref, revision: t.Optional(ref), parent: t.Optional(ref),
        after: t.Optional(t.String({ maxLength: 2048 })) }, { additionalProperties: false }),
      detail: { description: 'Export an exact native Structure revision in bounded sibling pages. Retain revision and visit containers in breadth-first order; next continues the same parent. Exact Content and its derivations retain their owner disclosure and rights.' },
      response: transportResponses(openApiOperations['/v1/compositions/{id}/export'].get, {
        200: t.Object({ profile: t.Literal('native-export-page-v1'), structure: ref, revision: ref, parent: ref,
          next: t.Nullable(t.String()), occurrences: t.Array(occurrence, { maxItems: NATIVE_EXPORT_PAGE_SIZE }),
          containers: t.Array(ref, { maxItems: NATIVE_EXPORT_PAGE_SIZE }),
          selections: t.Array(t.Any(), { maxItems: NATIVE_EXPORT_PAGE_SIZE }),
          contents: t.Array(t.Object({ reference: t.Object({ target: t.String(), selector: ExactInstructionSelector }),
            document: t.Optional(t.Any()), body: t.Optional(t.String()) }), { maxItems: NATIVE_EXPORT_PAGE_SIZE }),
          measures: t.Array(t.Any()), rights: t.Array(t.Any()),
          cost: t.Object({ pagesRead: t.Integer(), occurrences: t.Integer() }) }),
        ...authorizedReadProblems, ...workReadProblems }, 'GET'),
    }, async ({ request, params, query }) => {
      try {
        await work.account.verify(request, ['work:read']);
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        if ((query.parent || query.after) && !query.revision) return problem(400,
          'invalid_request', 'Native export continuation requires the selected revision');
        const structure = `https://rezics.com/id/${params.id}`;
        const page = await disclosedComposition(work, request, structure, query.actingSubject,
          { revision: query.revision }, (session, header, revision) => readNativeExportPage(session,
            { structure, revision, work: header.work, actingSubject: query.actingSubject,
              parent: query.parent, after: query.after }));
        return Response.json(page, { headers: { 'cache-control': 'private, no-store' } });
      } catch (error) { return compositionError(error); }
    })
    .get('/v1/compositions/:id', {
      params: t.Object({ id: groupUuid }),
      query: t.Object({ actingSubject: t.Optional(ref), parent: t.Optional(ref),
        after: t.Optional(t.String({ maxLength: 2048 })), limit: t.Optional(t.Numeric({
          minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/compositions/{id}"].get, readResponses, 'GET'),
    }, async ({ request, params, query }) => {
      try {
        const structure = `https://rezics.com/id/${params.id}`;
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const page = await disclosedComposition(work, request, structure, query.actingSubject, {},
          (session, header, revision) => readVisibleCompositionPage(work.environment, { structure, revision,
          ...(query.parent ? { parent: query.parent } : {}), ...(query.after ? { after: query.after } : {}),
          limit: query.limit ?? 50,
          visible: item => !structureProfileFor(header.profile).targetRoles.includes(item.role) || !!item.target,
          canReadTargets: compositionTargetBatchReader(session, structureProfileFor(header.profile)) }));
        return Response.json(disclosedPage(page), { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return compositionError(error); }
    })
    .get('/v1/compositions/:id/revisions/:revision', {
      params: t.Object({ id: groupUuid, revision: groupUuid }),
      query: t.Object({ actingSubject: t.Optional(ref), parent: t.Optional(ref),
        after: t.Optional(t.String({ maxLength: 2048 })), limit: t.Optional(t.Numeric({
          minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/compositions/{id}/revisions/{revision}"].get, readResponses, 'GET'),
    }, async ({ request, params, query }) => {
      try {
        const structure = `https://rezics.com/id/${params.id}`;
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const page = await disclosedComposition(work, request, structure, query.actingSubject,
          { revision: `https://rezics.com/id/${params.revision}` },
          (session, header, revision) => readVisibleCompositionPage(work.environment, { structure, revision,
          ...(query.parent ? { parent: query.parent } : {}), ...(query.after ? { after: query.after } : {}),
          limit: query.limit ?? 50,
          visible: item => !structureProfileFor(header.profile).targetRoles.includes(item.role) || !!item.target,
          canReadTargets: compositionTargetBatchReader(session, structureProfileFor(header.profile)) }));
        return Response.json(disclosedPage(page), { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return compositionError(error); }
    })
    .get('/v1/compositions/:id/seals/:seal', {
      params: t.Object({ id: groupUuid, seal: groupUuid }),
      query: t.Object({ actingSubject: t.Optional(ref), after: t.Optional(t.String({ maxLength: 2048 })),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })) },
      { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/compositions/{id}/seals/{seal}"].get, { 200: sealPageResult, ...authorizedReadProblems, ...workReadProblems }, 'GET'),
    }, async ({ request, params, query }) => {
      try {
        const structure = `https://rezics.com/id/${params.id}`;
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const page = await disclosedComposition(work, request, structure, query.actingSubject,
          { selectedRoot: false },
          (session, header) => readCompositionSeal(work.environment, { structure,
          seal: `https://rezics.com/id/${params.seal}`,
          ...(query.after ? { after: query.after } : {}), limit: query.limit ?? 50,
          canReadTarget: compositionTargetReader(session, structureProfileFor(header.profile)) }));
        return Response.json(page, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return compositionError(error); }
    })
    .get('/v1/compositions/:id/occurrences/:occurrence', {
      params: t.Object({ id: groupUuid, occurrence: groupUuid }),
      query: t.Object({ actingSubject: t.Optional(ref), revision: t.Optional(ref) },
        { additionalProperties: false }), response: transportResponses(openApiOperations["/v1/compositions/{id}/occurrences/{occurrence}"].get, readResponses, 'GET'),
    }, async ({ request, params, query }) => {
      try {
        const structure = `https://rezics.com/id/${params.id}`;
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const page = await disclosedComposition(work, request, structure, query.actingSubject,
          { ...(query.revision ? { revision: query.revision } : {}) },
          (session, header, revision) => readVisibleCompositionPage(work.environment, { structure, revision,
          occurrence: `https://rezics.com/id/${params.occurrence}`,
          limit: 1,
          visible: item => !structureProfileFor(header.profile).targetRoles.includes(item.role) || !!item.target,
          canReadTargets: compositionTargetBatchReader(session, structureProfileFor(header.profile)) }));
        return Response.json(disclosedPage(page), { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return compositionError(error); }
    })
    .use(compositionStageRoutes(fuseki, work));
}
