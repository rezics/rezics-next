import { Elysia, t } from 'elysia';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import { problemResult } from '../api-contract.ts';
import { AdmissionUnavailable } from '../modules/access/admission.ts';
import { OwnerOperationBusy, OwnerOperationConflict, OwnerOperationInvalid, OwnerOperationMissing,
  OwnerOperationUnavailable }
  from '../modules/owner/operations.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

export const openApiOperations = {
  '/v1/owners/reconciliations': { post: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/owners/reconciliations/{id}': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: true } },
  '/v1/owners/relocations': { post: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/owners/relocations/{id}': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: true } },
} as const;

const uuid = t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const revision = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$', maxLength: 300 });
const bounded = (maxLength: number) => t.String({ minLength: 1, maxLength });
const reconcileBody = t.Union([t.Object({ profile: t.Literal('owner-reconciliation-v1'),
  kind: t.Literal('revision_recovery'), revision }, { additionalProperties: false }),
t.Object({ profile: t.Literal('owner-reconciliation-v1'), kind: t.Literal('restore'),
  sealedCoverage: bounded(1_000_000),
  sealedDeletionSets: t.Optional(t.Array(bounded(100_000), { maxItems: 10_000 })) },
{ additionalProperties: false }),
t.Object({ profile: t.Literal('owner-reconciliation-v1'), kind: t.Literal('relay_gap'),
  consumer: bounded(128), relayConsumer: bounded(128), dataEpoch: bounded(200),
  afterSequence: bounded(100), throughSequence: bounded(100) },
{ additionalProperties: false }),
t.Object({ profile: t.Literal('owner-reconciliation-v1'), kind: t.Literal('retention_gc') },
{ additionalProperties: false }),
t.Object({ profile: t.Literal('owner-reconciliation-v1'), kind: t.Literal('erasure'), erasureId: uuid },
{ additionalProperties: false })]);
const reconciliationState = t.Union([t.Literal('running'), t.Literal('held'),
  t.Literal('reconciled'), t.Literal('failed')]);
const reconcileResult = t.Union([t.Object({ profile: t.Literal('owner-reconciliation-v1'), id: uuid,
  kind: t.Literal('revision_recovery'), revision,
  state: reconciliationState,
  disposition: t.Nullable(t.Union([t.Literal('matched'), t.Literal('unavailable'),
    t.Literal('corrupt')])), replayed: t.Boolean() }),
t.Object({ profile: t.Literal('owner-reconciliation-v1'), id: uuid,
  kind: t.Literal('restore'), scope: t.Literal('product'), state: reconciliationState,
  disposition: t.Nullable(t.Union([t.Literal('matched'), t.Literal('conflict'),
    t.Literal('unavailable'), t.Literal('corrupt')])), replayed: t.Boolean() }),
t.Object({ profile: t.Literal('owner-reconciliation-v1'), id: uuid,
  kind: t.Literal('relay_gap'), consumer: bounded(128), state: reconciliationState,
  disposition: t.Nullable(t.Union([t.Literal('rebuilt'), t.Literal('gap')])),
  replayed: t.Boolean() }),
t.Object({ profile: t.Literal('owner-reconciliation-v1'), id: uuid,
  kind: t.Literal('retention_gc'), scope: t.Literal('product'), state: reconciliationState,
  disposition: t.Nullable(t.Union([t.Literal('retired'), t.Literal('preserved')])),
  replayed: t.Boolean() }),
t.Object({ profile: t.Literal('owner-reconciliation-v1'), id: uuid,
  kind: t.Literal('erasure'), erasure: uuid, state: reconciliationState,
  disposition: t.Nullable(t.Union([t.Literal('erased'), t.Literal('conflict')])),
  replayed: t.Boolean() })]);
const relocationBody = t.Union([t.Object({ profile: t.Literal('owner-relocation-v1'),
  action: t.Literal('stage'), owner: t.Union([t.Literal('graph'), t.Literal('content'),
    t.Literal('object')]), datasetId: bounded(300), sourceLocation: bounded(500),
  targetLocation: bounded(500), sourceRoutingEpoch: bounded(200) }, { additionalProperties: false }),
  t.Object({ profile: t.Literal('owner-relocation-v1'), action: t.Literal('activate'),
    id: uuid }, { additionalProperties: false })]);
const relocationResult = t.Object({ profile: t.Literal('owner-relocation-v1'), id: uuid,
  owner: t.Union([t.Literal('graph'), t.Literal('content'), t.Literal('object')]),
  datasetId: bounded(300), state: t.Union([t.Literal('staged'), t.Literal('copying'),
    t.Literal('draining'), t.Literal('verifying'), t.Literal('activated'),
    t.Literal('retaining'), t.Literal('collected'), t.Literal('aborted')]), replayed: t.Boolean() });
const noStore = { headers: { 'cache-control': 'no-store' } };

function ownerError(error: unknown): Response {
  if (error instanceof OwnerOperationInvalid) return problem(400, 'invalid_owner_request', error.message);
  if (error instanceof OwnerOperationUnavailable) return problem(503, 'owner_unavailable', error.message);
  if (error instanceof OwnerOperationConflict) {
    return problem(409, 'idempotency_conflict', 'Idempotency key binds another owner request');
  }
  if (error instanceof OwnerOperationBusy) return problem(409, 'owner_operation_busy', error.message);
  if (error instanceof OwnerOperationMissing) return problem(404, 'owner_operation_missing', error.message);
  return commandError(error);
}

function idempotencyKey(request: Request): string | null {
  const key = request.headers.get('idempotency-key');
  return key && /^[A-Za-z0-9:_./-]{1,128}$/.test(key) ? key : null;
}

/** Operator maintenance API. Restore reconciliation can release a verified hold. */
export function ownerRoutes(work: MainWorkDependencies) {
  const authorize = async (request: Request): Promise<boolean> => {
    const principal = await work.account.verify(request, ['owner:operate']);
    try { return Boolean(await work.access.activePrincipalId(principal)); }
    catch (error) {
      if (!(error instanceof AdmissionUnavailable) || !work.ownerOperations) throw error;
      return work.ownerOperations.activeFencedOperator(principal);
    }
  };
  const unavailable = () => problem(503, 'owner_unavailable', 'Owner operations are unavailable');
  const denied = () => problem(403, 'authority_denied', 'Owner operator is inactive');
  const missingKey = () => problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
  return new Elysia()
    .post('/v1/owners/reconciliations', { body: reconcileBody,
      response: { 200: reconcileResult, 201: reconcileResult, ...writeProblems } },
    async ({ request, body }) => {
      try {
        if (!await authorize(request)) return denied();
        if (!work.ownerOperations) return unavailable();
        const key = idempotencyKey(request);
        if (!key) return missingKey();
        const result = body.kind === 'restore'
          ? await work.ownerOperations.reconcileRestore({ sealedCoverage: body.sealedCoverage,
            sealedDeletionSets: body.sealedDeletionSets ?? [] }, key)
          : body.kind === 'relay_gap'
            ? await work.ownerOperations.reconcileRelayGap({ consumer: body.consumer,
              relayConsumer: body.relayConsumer, dataEpoch: body.dataEpoch,
              afterSequence: body.afterSequence, throughSequence: body.throughSequence }, key)
            : body.kind === 'retention_gc'
              ? await work.ownerOperations.reconcileRetentionGc(key)
              : body.kind === 'erasure'
                ? await work.ownerOperations.reconcileErasure({ erasureId: body.erasureId }, key)
            : await work.ownerOperations.reconcileRevision({ revision: body.revision }, key);
        return Response.json({ profile: 'owner-reconciliation-v1', ...result },
          { ...noStore, status: result.replayed ? 200 : 201 });
      } catch (error) { return ownerError(error); }
    })
    .get('/v1/owners/reconciliations/:id', { params: t.Object({ id: uuid }),
      response: { 200: reconcileResult, ...authorizedReadProblems } },
    async ({ request, params }) => {
      try {
        if (!await authorize(request)) return denied();
        if (!work.ownerOperations) return unavailable();
        const result = await work.ownerOperations.readReconciliation(params.id);
        return Response.json({ profile: 'owner-reconciliation-v1', ...result }, noStore);
      } catch (error) { return ownerError(error); }
    })
    .post('/v1/owners/relocations', { body: relocationBody,
      response: { 200: relocationResult, 201: relocationResult, ...writeProblems } },
    async ({ request, body }) => {
      try {
        if (!await authorize(request)) return denied();
        if (!work.ownerOperations) return unavailable();
        const key = idempotencyKey(request);
        if (!key) return missingKey();
        const result = body.action === 'stage'
          ? await work.ownerOperations.stageRelocation({ owner: body.owner,
            datasetId: body.datasetId, sourceLocation: body.sourceLocation,
            targetLocation: body.targetLocation, sourceRoutingEpoch: body.sourceRoutingEpoch }, key)
          : await work.ownerOperations.activateRelocation(body.id, key);
        return Response.json({ profile: 'owner-relocation-v1', ...result },
          { ...noStore, status: result.replayed ? 200 : 201 });
      } catch (error) { return ownerError(error); }
    })
    .get('/v1/owners/relocations/:id', { params: t.Object({ id: uuid }),
      response: { 200: relocationResult, ...authorizedReadProblems, 404: problemResult(404) } },
    async ({ request, params }) => {
      try {
        if (!await authorize(request)) return denied();
        if (!work.ownerOperations) return unavailable();
        const result = await work.ownerOperations.readRelocation(params.id);
        return Response.json({ profile: 'owner-relocation-v1', ...result }, noStore);
      } catch (error) { return ownerError(error); }
    });
}
