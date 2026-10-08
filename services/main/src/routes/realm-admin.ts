import { Elysia, t } from 'elysia';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import { problemResult } from '../api-contract.ts';
import { escalationCommand, escalationReceipt, impact, memberCommand, memberPage, memberQuery,
  memberReceipt, roleCommand, roleList, roleReceipt, RealmAdminConflict, RealmAdminDenied,
  RealmAdminInvalid, RealmAdminLimit, RealmAdminStale, RealmAdminUnavailable } from '../modules/realm-admin/contract.ts';
import { settingsCommand, settingsReceipt, settingsView } from '../modules/realm-admin/contract.ts';
import { spaceSettingsCommand, spaceSettingsReceipt, spaceSettingsView } from '../modules/realm-admin/contract.ts';
import { invitationPage } from '../modules/access/realm-management-joining-contract.ts';
import { readId, readUuid } from '../modules/work/read-contract.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { AppealNotEscalable } from '../modules/access/realm-management.ts';
import { commandError, problem } from './problems.ts';
import { joinRequestBasis, joinRequestCommand, joinRequestReceipt, joinRequestPage, joinRequestWithdraw,
  joinRequestDecision, joinRequestDecisionReceipt, RealmJoinRequestMissing, joinRequestQuery,
  ownJoinRequestQuery, ownJoinRequestPage } from '../modules/realm-admin/join-requests.ts';

export const openApiOperations = {
  '/v1/realms/{realm}/join-requests/mine': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: true } },
  '/v1/realms/{realm}/join-requests/{request}/withdraw': { post: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/realms/{realm}/join-requests/{request}/decisions': { post: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/realms/{realm}/join-requests/basis': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: true } },
  '/v1/realms/{realm}/join-requests': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: true }, post: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/spaces/{space}/settings': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: true }, put: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/realms/{realm}/management': { post: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/realms/{realm}/members': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: true }, post: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/realms/{realm}/invitations': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: true } },
  '/v1/realms/{realm}/roles': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: true } },
  '/v1/realms/{realm}/role-impact': { post: { exposure: 'public', rateLimitFamily: 'read', bearer: true } },
  '/v1/realms/{realm}/role-changes': { post: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/realms/{realm}/escalations': { post: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/realms/{realm}/settings': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: true }, put: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
} as const;
const params = t.Object({ realm: readUuid });
const query = t.Object({ actingSubject: readId }, { additionalProperties: false });
const headers = { 'cache-control': 'private, no-store' };
const problems = { ...writeProblems, 404: problemResult(404), 422: problemResult(422) };
const key = (request: Request): string => {
  const value = request.headers.get('idempotency-key');
  if (!value || !/^[A-Za-z0-9:_./-]{1,128}$/.test(value)) throw new RealmAdminInvalid('Idempotency-Key is required');
  return value;
};
function errorResponse(error: unknown) {
  if (error instanceof RealmJoinRequestMissing) return problem(404, 'realm_unavailable', 'Realm is unavailable');
  if (error instanceof RealmAdminDenied) return problem(403, 'realm_management_denied', error.message);
  if (error instanceof RealmAdminInvalid) return problem(400, 'invalid_realm_management_request', error.message);
  if (error instanceof AppealNotEscalable) return problem(409, 'appeal_not_escalable', error.message);
  if (error instanceof RealmAdminStale) return problem(409, 'stale_realm_management_basis', error.message);
  if (error instanceof RealmAdminConflict) return problem(409, 'idempotency_conflict', error.message);
  if (error instanceof RealmAdminLimit) return problem(422, 'realm_management_budget_exceeded', error.message);
  if (error instanceof RealmAdminUnavailable) return problem(503, 'realm_management_unavailable', error.message);
  return commandError(error);
}

export function realmAdminRoutes(work: MainWorkDependencies) {
  const owner = () => {
    if (!work.realmAdmin) throw new RealmAdminUnavailable('Realm management is unavailable');
    return work.realmAdmin;
  };
  return new Elysia()
    .post('/v1/realms/:realm/join-requests/:request/withdraw', {
      params: t.Object({ realm: readUuid, request: readUuid }), body: joinRequestWithdraw,
      response: { 200: joinRequestDecisionReceipt, 201: joinRequestDecisionReceipt, ...problems },
    }, async ({ request, params: path, body }) => {
      try {
        const principal = await work.account.verify(request, ['access:membership-consent']);
        if (!work.realmJoinRequests) throw new RealmAdminUnavailable('Join requests are unavailable');
        const result = await work.realmJoinRequests.withdraw(principal, `https://rezics.com/id/${path.realm}`, path.request, body, key(request));
        return Response.json(result, { headers, status: result.replayed ? 200 : 201 });
      } catch (error) { return errorResponse(error); }
    })
    .post('/v1/realms/:realm/join-requests/:request/decisions', {
      params: t.Object({ realm: readUuid, request: readUuid }), body: joinRequestDecision,
      response: { 200: joinRequestDecisionReceipt, 201: joinRequestDecisionReceipt, ...problems },
    }, async ({ request, params: path, body }) => {
      try {
        const principal = await work.account.verify(request, ['governance:decide']);
        if (!work.realmJoinRequests) throw new RealmAdminUnavailable('Join requests are unavailable');
        const result = await work.realmJoinRequests.decide(principal, `https://rezics.com/id/${path.realm}`, path.request, body, key(request));
        return Response.json(result, { headers, status: result.replayed ? 200 : 201 });
      } catch (error) { return errorResponse(error); }
    })
    .get('/v1/realms/:realm/join-requests/basis', { params, query,
      response: { 200: joinRequestBasis, ...authorizedReadProblems, ...problems },
    }, async ({ request, params: path, query: options }) => {
      try {
        const principal = await work.account.verify(request, ['access:membership-consent']);
        if (!work.realmJoinRequests) throw new RealmAdminUnavailable('Join requests are unavailable');
        return Response.json(await work.realmJoinRequests.basis(principal, `https://rezics.com/id/${path.realm}`, options.actingSubject), { headers });
      } catch (error) { return errorResponse(error); }
    })
    .post('/v1/realms/:realm/join-requests', { params, body: joinRequestCommand,
      response: { 200: joinRequestReceipt, 201: joinRequestReceipt, ...problems },
    }, async ({ request, params: path, body }) => {
      try {
        const principal = await work.account.verify(request, ['access:membership-consent']);
        if (!work.realmJoinRequests) throw new RealmAdminUnavailable('Join requests are unavailable');
        const result = await work.realmJoinRequests.request(principal, `https://rezics.com/id/${path.realm}`, body, key(request));
        return Response.json(result, { headers, status: result.replayed ? 200 : 201 });
      } catch (error) { return errorResponse(error); }
    })
    .get('/v1/realms/:realm/join-requests/mine', { params, query: ownJoinRequestQuery,
      response: { 200: ownJoinRequestPage, ...authorizedReadProblems, ...problems },
    }, async ({ request, params: path, query: options }) => {
      try {
        const principal = await work.account.verify(request, ['access:membership-consent']);
        if (!work.realmJoinRequests) throw new RealmAdminUnavailable('Join requests are unavailable');
        return Response.json(await work.realmJoinRequests.own(principal, `https://rezics.com/id/${path.realm}`, options), { headers });
      } catch (error) { return errorResponse(error); }
    })
    .get('/v1/realms/:realm/join-requests', { params, query: joinRequestQuery,
      response: { 200: joinRequestPage, ...authorizedReadProblems, ...problems },
    }, async ({ request, params: path, query: options }) => {
      try {
        const principal = await work.account.verify(request, ['governance:decide']);
        if (!work.realmJoinRequests) throw new RealmAdminUnavailable('Join requests are unavailable');
        return Response.json(await work.realmJoinRequests.list(principal, `https://rezics.com/id/${path.realm}`,
          options), { headers });
      } catch (error) { return errorResponse(error); }
    })
    .get('/v1/spaces/:space/settings', { params: t.Object({ space: readUuid }), query,
      response: { 200: spaceSettingsView, ...authorizedReadProblems, ...problems },
    }, async ({ request, params: path, query: options }) => {
      try {
        const principal = await work.account.verify(request, ['governance:decide']);
        return Response.json(await owner().spaceSettings(principal, `https://rezics.com/id/${path.space}`,
          options.actingSubject, work.environment), { headers });
      } catch (error) { return errorResponse(error); }
    })
    .put('/v1/spaces/:space/settings', { params: t.Object({ space: readUuid }), body: spaceSettingsCommand,
      response: { 200: spaceSettingsReceipt, 201: spaceSettingsReceipt, ...problems },
    }, async ({ request, params: path, body }) => {
      try {
        const principal = await work.account.verify(request, ['governance:decide']);
        const result = await owner().changeSpaceSettings(principal, `https://rezics.com/id/${path.space}`,
          body, key(request), work.environment);
        return Response.json(result, { headers, status: result.replayed ? 200 : 201 });
      } catch (error) { return errorResponse(error); }
    })
    .post('/v1/realms/:realm/management', { params, body: query,
      response: { 200: t.Object({ receiptId: readUuid, generation: t.String(), replayed: t.Boolean() }), ...problems },
    }, async ({ request, params: path, body }) => {
      try {
        const principal = await work.account.verify(request, ['governance:decide']);
        key(request);
        return Response.json(await owner().initialize(principal, `https://rezics.com/id/${path.realm}`,
          body.actingSubject, work.environment), { headers });
      } catch (error) { return errorResponse(error); }
    })
    .get('/v1/realms/:realm/settings', { params, query,
      response: { 200: settingsView, ...authorizedReadProblems, ...problems },
    }, async ({ request, params: path, query: options }) => {
      try {
        const principal = await work.account.verify(request, ['governance:decide']);
        return Response.json(await owner().settings(principal, `https://rezics.com/id/${path.realm}`, options.actingSubject, work.environment), { headers });
      } catch (error) { return errorResponse(error); }
    })
    .put('/v1/realms/:realm/settings', { params, body: settingsCommand,
      response: { 200: settingsReceipt, 201: settingsReceipt, ...problems },
    }, async ({ request, params: path, body }) => {
      try {
        const principal = await work.account.verify(request, ['governance:decide']);
        const result = await owner().changeSettings(principal, `https://rezics.com/id/${path.realm}`, body, key(request), work.environment);
        return Response.json(result, { headers, status: result.replayed ? 200 : 201 });
      } catch (error) { return errorResponse(error); }
    })
    .get('/v1/realms/:realm/members', { params,
      query: t.Object(memberQuery, { additionalProperties: false }),
      response: { 200: memberPage, ...authorizedReadProblems, ...problems },
    }, async ({ request, params: path, query: options }) => {
      try {
        const principal = await work.account.verify(request, ['governance:decide']);
        return Response.json(await owner().members(principal, `https://rezics.com/id/${path.realm}`, options), { headers });
      } catch (error) { return errorResponse(error); }
    })
    .get('/v1/realms/:realm/invitations', { params,
      query: t.Object({ actingSubject: readId, after: t.Optional(readUuid),
        limit: t.Optional(t.Integer({ minimum: 1, maximum: 50 })) }, { additionalProperties: false }),
      response: { 200: invitationPage, ...authorizedReadProblems, ...problems },
    }, async ({ request, params: path, query: options }) => {
      try {
        const principal = await work.account.verify(request, ['governance:decide']);
        if (!work.realmJoining) throw new RealmAdminUnavailable('Joining owner is unavailable');
        return Response.json(await work.realmJoining.outgoing(principal,
          `https://rezics.com/id/${path.realm}`, options.actingSubject, options.after, options.limit), { headers });
      } catch (error) { return errorResponse(error); }
    })
    .post('/v1/realms/:realm/members', { params, body: memberCommand,
      response: { 200: memberReceipt, 201: memberReceipt, ...problems },
    }, async ({ request, params: path, body }) => {
      try {
        const principal = await work.account.verify(request, ['governance:decide']);
        const result = await owner().changeMember(principal, `https://rezics.com/id/${path.realm}`, body, key(request), work.environment);
        return Response.json(result, { headers, status: result.replayed ? 200 : 201 });
      } catch (error) { return errorResponse(error); }
    })
    .get('/v1/realms/:realm/roles', { params, query,
      response: { 200: roleList, ...authorizedReadProblems, ...problems },
    }, async ({ request, params: path, query: options }) => {
      try {
        const principal = await work.account.verify(request, ['governance:decide']);
        return Response.json(await owner().roles(principal, `https://rezics.com/id/${path.realm}`, options.actingSubject), { headers });
      } catch (error) { return errorResponse(error); }
    })
    .post('/v1/realms/:realm/role-impact', { params, body: roleCommand,
      response: { 200: impact, ...problems },
    }, async ({ request, params: path, body }) => {
      try {
        const principal = await work.account.verify(request, ['governance:decide']);
        return Response.json(await owner().preview(principal, `https://rezics.com/id/${path.realm}`, body), { headers });
      } catch (error) { return errorResponse(error); }
    })
    .post('/v1/realms/:realm/role-changes', { params,
      body: t.Object({ ...roleCommand.properties, impactDigest: t.String({ pattern: '^[0-9a-f]{64}$' }) },
        { additionalProperties: false }), response: { 200: roleReceipt, 201: roleReceipt, ...problems },
    }, async ({ request, params: path, body }) => {
      try {
        const principal = await work.account.verify(request, ['governance:decide']);
        const { impactDigest, ...input } = body;
        const result = await owner().changeRole(principal, `https://rezics.com/id/${path.realm}`, input, key(request), impactDigest);
        return Response.json(result, { headers, status: result.replayed ? 200 : 201 });
      } catch (error) { return errorResponse(error); }
    })
    .post('/v1/realms/:realm/escalations', { params, body: escalationCommand,
      response: { 200: escalationReceipt, 201: escalationReceipt, ...problems },
    }, async ({ request, params: path, body }) => {
      try {
        const principal = await work.account.verify(request, body.itemKind === 'submission'
          ? ['governance:decide', 'realm:adopt'] : ['governance:decide']);
        const result = await owner().escalate(principal, `https://rezics.com/id/${path.realm}`, body, key(request));
        return Response.json(result, { headers, status: result.replayed ? 200 : 201 });
      } catch (error) { return errorResponse(error); }
    });
}
