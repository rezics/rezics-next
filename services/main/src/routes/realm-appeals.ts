import { Elysia, t } from 'elysia';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import { problemResult } from '../api-contract.ts';
import { APPEAL_ALREADY_OPEN } from '../modules/governance/realm-sanction-appeal.ts';
import { GovernanceConflict, GovernanceDenied, GovernanceInvalid, GovernanceStale,
  GovernanceUnavailable } from '../modules/governance/store.ts';
import { readId, readUuid } from '../modules/work/read-contract.ts';
import { commandError, problem } from './problems.ts';
import type { MainWorkDependencies } from './dependencies.ts';

const appealPath = '/v1/realms/{realm}/member-receipts/{receiptId}/appeal';
const memberBanPath = '/v1/realms/{realm}/member-ban';
export const openApiOperations = {
  [appealPath]: {
    post: { exposure: 'platform:realm-appeals', rateLimitFamily: 'write', bearer: true, idempotencyKey: true },
    get: { exposure: 'platform:realm-appeals', rateLimitFamily: 'read', bearer: true },
  },
  [memberBanPath]: {
    get: { exposure: 'platform:realm-appeals', rateLimitFamily: 'read', bearer: true },
  },
} as const;

const params = t.Object({ realm: readUuid, receiptId: readUuid });
const statement = t.String({ minLength: 1, maxLength: 2000 });
const opened = t.Object({
  realm: t.String(), receiptId: readUuid, caseId: readUuid,
  state: t.Union([t.Literal('open'), t.Literal('decided')]), replayed: t.Boolean(),
}, { additionalProperties: false });
const dismissed = t.Object({ state: t.Literal('decided'), caseId: readUuid, statement,
  outcome: t.Literal('dismiss'), rationale: t.Nullable(t.String()) }, { additionalProperties: false });
const reversed = t.Object({ state: t.Literal('decided'), caseId: readUuid, statement,
  outcome: t.Literal('reversed'), rationale: t.Nullable(t.String()),
  liftedAt: t.String(), liftReceiptId: t.Nullable(readUuid) }, { additionalProperties: false });
const appeal = t.Union([
  t.Object({ state: t.Literal('none') }, { additionalProperties: false }),
  t.Object({ state: t.Literal('open'), caseId: readUuid, statement }, { additionalProperties: false }),
  dismissed, reversed,
]);
const reading = t.Object({
  realm: t.String(), receiptId: readUuid, action: t.Literal('ban'), reason: t.String(),
  bannedUntil: t.Nullable(t.String()), permanent: t.Boolean(), happenedAt: t.String(), appeal,
}, { additionalProperties: false });
const memberBanAppeal = t.Union([
  t.Object({ state: t.Literal('none') }, { additionalProperties: false }),
  t.Object({ state: t.Literal('open'), caseId: readUuid, statement }, { additionalProperties: false }),
  t.Object({ state: t.Literal('decided'), caseId: readUuid, statement, outcome: t.Literal('dismiss'),
    rationale: t.Nullable(t.String()), decidedAt: t.String() }, { additionalProperties: false }),
  t.Object({ state: t.Literal('decided'), caseId: readUuid, statement, outcome: t.Literal('reversed'),
    rationale: t.Nullable(t.String()), liftedAt: t.String(), liftReceiptId: t.Nullable(readUuid),
    decidedAt: t.String() }, { additionalProperties: false }),
]);
const memberBanReading = t.Object({
  realm: t.String(), receiptId: readUuid, action: t.Literal('ban'), reason: t.String(),
  bannedUntil: t.Nullable(t.String()), permanent: t.Boolean(), happenedAt: t.String(), appeal: memberBanAppeal,
}, { additionalProperties: false });
const noStore = { headers: { 'cache-control': 'no-store' } };
const realmOf = (id: string) => `https://rezics.com/id/${id}`;

function appealError(error: unknown): Response {
  if (error instanceof GovernanceDenied) return problem(404, 'appeal_unavailable', 'Appeal is unavailable');
  if (error instanceof GovernanceConflict) {
    if (error.message === APPEAL_ALREADY_OPEN)
      return problem(409, 'appeal_already_open', 'An appeal is already open for this ban');
    if (error.message.includes('idempotency'))
      return problem(409, 'idempotency_conflict', 'Idempotency key binds another statement');
    return problem(409, 'appeal_conflict', 'Appeal could not be opened');
  }
  if (error instanceof GovernanceInvalid) return problem(400, 'invalid_appeal', error.message);
  if (error instanceof GovernanceStale) return problem(409, 'stale_appeal', 'Appeal changed since review');
  if (error instanceof GovernanceUnavailable) return problem(503, 'governance_unavailable', 'Governance is unavailable');
  return commandError(error);
}

/** One ban receipt has one appeal. The read never names the decider. */
export function realmAppealRoutes(work: MainWorkDependencies) {
  const unavailable = () => problem(503, 'governance_unavailable', 'Governance is unavailable');
  return new Elysia()
    .post('/v1/realms/:realm/member-receipts/:receiptId/appeal', {
      params, body: t.Object({ statement }, { additionalProperties: false }),
      response: { 200: opened, 201: opened, ...writeProblems, 404: problemResult(404) },
    }, async ({ request, params: path, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey))
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      try {
        const principal = await work.account.verify(request, []);
        if (!work.governance?.store) return unavailable();
        const result = await work.governance.store.openRealmSanctionAppeal(principal, {
          realm: realmOf(path.realm), receiptId: path.receiptId, statement: body.statement, idempotencyKey });
        return Response.json(result, { status: result.replayed ? 200 : 201, ...noStore });
      } catch (error) { return appealError(error); }
    })
    .get('/v1/realms/:realm/member-receipts/:receiptId/appeal', {
      params, response: { 200: reading, ...authorizedReadProblems },
    }, async ({ request, params: path }) => {
      try {
        const principal = await work.account.verify(request, []);
        if (!work.governance?.store) return unavailable();
        return Response.json(await work.governance.store.readRealmSanctionAppeal(principal, {
          realm: realmOf(path.realm), receiptId: path.receiptId }), noStore);
      } catch (error) { return appealError(error); }
    })
    .get('/v1/realms/:realm/member-ban', {
      params: t.Object({ realm: readUuid }),
      query: t.Object({ actingSubject: readId }, { additionalProperties: false }),
      response: { 200: memberBanReading, ...authorizedReadProblems },
    }, async ({ request, params: path, query }) => {
      try {
        const principal = await work.account.verify(request, []);
        if (!work.governance?.store) return unavailable();
        return Response.json(await work.governance.store.readRealmMemberBan(principal, {
          realm: realmOf(path.realm), actingSubject: query.actingSubject }), noStore);
      } catch (error) { return appealError(error); }
    });
}
