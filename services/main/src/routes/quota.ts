import { Elysia, t } from 'elysia';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import { commerceIntentDigest } from '../modules/commerce/store.ts';
import { QUOTA_SCOPE, QuotaDenied, QuotaExhausted, QuotaInvalid, QuotaKeyConflict, QuotaStale,
  QuotaUnavailable, type QuotaStore } from '../modules/quota/store.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

const agent = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const unit = t.String({ pattern: '^[a-z][a-z0-9.-]{0,62}$' });
const units = t.String({ pattern: '^(0|[1-9][0-9]{0,17})$' });
const target = { unit, beneficiary: agent, operationId: t.String({ minLength: 1, maxLength: 128 }),
  stage: t.Integer({ minimum: 0, maximum: 10000 }) };
const common = { profile: t.Literal('realm-quota-reservation-v1'), ...target };
const reservationBody = t.Union([
  t.Object({ ...common, action: t.Literal('reserve'), amount: units }, { additionalProperties: false }),
  t.Object({ ...common, action: t.Union([t.Literal('renew'), t.Literal('defer'), t.Literal('release')]) },
    { additionalProperties: false }),
  t.Object({ ...common, action: t.Union([t.Literal('consume'), t.Literal('settle')]), consumed: units,
    ackReference: t.Optional(t.String({ minLength: 1, maxLength: 200 })) }, { additionalProperties: false }),
]);
const reservationResult = t.Object({ profile: t.Literal('realm-quota-reservation-v1'),
  reservationId: t.String(), realm: agent, unit, beneficiary: agent, operationId: t.String(),
  stage: t.Integer(), policyRevision: units, ledger: t.Object({
    source: t.Union([t.Literal('base'), t.Literal('entitlement')]), entitlementId: t.Nullable(t.String()) }),
  amount: units, consumed: units, state: t.Union([t.Literal('reserved'), t.Literal('reconciling'),
    t.Literal('settled'), t.Literal('released'), t.Literal('expired')]), generation: units,
  expiresAt: t.String({ format: 'date-time' }), replayed: t.Boolean() });

export function quotaError(error: unknown): Response {
  if (error instanceof QuotaInvalid) return problem(400, 'invalid_quota_request', error.message);
  if (error instanceof QuotaDenied) return problem(403, 'quota_denied', 'Quota authority is missing');
  if (error instanceof QuotaKeyConflict) return problem(409, 'idempotency_conflict', error.message);
  if (error instanceof QuotaExhausted) return problem(409, 'quota_exhausted', 'Quota capacity is exhausted');
  if (error instanceof QuotaStale) return problem(409, 'quota_stale', error.message);
  if (error instanceof QuotaUnavailable) return problem(503, 'quota_unavailable', 'Quota owner is unavailable');
  return commandError(error);
}

/** Realm quota reservation lifecycle keyed by the caller's operation and stage. */
export function quotaRoutes(work: MainWorkDependencies & { quota?: QuotaStore }) {
  return new Elysia()
    .post('/v1/realms/:realm/quota-reservations', {
      params: t.Object({ realm: agent }), body: reservationBody,
      response: { 200: reservationResult, ...writeProblems },
    }, async ({ request, params, body }) => {
      try {
        const principal = await work.account.verify(request, [QUOTA_SCOPE]);
        if (!work.quota) return problem(503, 'quota_unavailable', 'Quota owner is unavailable');
        // The reservation digest binds the reserved intent; transitions are keyed by the reservation.
        const digest = commerceIntentDigest({ realm: params.realm, unit: body.unit, beneficiary: body.beneficiary,
          operationId: body.operationId, stage: body.stage,
          amount: body.action === 'reserve' ? body.amount : undefined });
        const { profile: _profile, ...command } = body;
        const result = await work.quota.apply(principal, { ...command, realm: params.realm }, digest);
        return Response.json({ profile: 'realm-quota-reservation-v1', ...result },
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return quotaError(error); }
    })
    .get('/v1/realms/:realm/quota-reservations', {
      params: t.Object({ realm: agent }),
      query: t.Object({ unit, beneficiary: agent, operationId: t.String({ minLength: 1, maxLength: 128 }),
        stage: t.Optional(t.Numeric({ minimum: 0, maximum: 10000 })) }, { additionalProperties: false }),
      response: { 200: reservationResult, ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        const principal = await work.account.verify(request, [QUOTA_SCOPE]);
        if (!work.quota) return problem(503, 'quota_unavailable', 'Quota owner is unavailable');
        const result = await work.quota.read(principal, { realm: params.realm, unit: query.unit,
          beneficiary: query.beneficiary, operationId: query.operationId, stage: query.stage ?? 0 });
        return Response.json({ profile: 'realm-quota-reservation-v1', ...result },
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return quotaError(error); }
    });
}

export const openApiOperations = {
  '/v1/realms/{realm}/quota-reservations': { get: { exposure: 'platform:commerce', rateLimitFamily: 'read' }, post: { exposure: 'platform:commerce', rateLimitFamily: 'write' } },
} as const;
