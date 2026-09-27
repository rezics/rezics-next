import { Elysia, t } from 'elysia';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import { problemResult } from '../api-contract.ts';
import { escalationCommand, escalationReceipt, impact, memberCommand, memberPage, memberQuery,
  memberReceipt, roleCommand, roleList, roleReceipt, RealmAdminConflict, RealmAdminDenied,
  RealmAdminInvalid, RealmAdminLimit, RealmAdminStale, RealmAdminUnavailable } from '../modules/realm-admin/contract.ts';
import { settingsCommand, settingsReceipt, settingsView } from '../modules/realm-admin/contract.ts';
import { readId, readUuid } from '../modules/work/read-contract.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

export const openApiOperations = {
  '/v1/realms/{realm}/management': { post: { bearer: true, idempotencyKey: true } },
  '/v1/realms/{realm}/members': { get: { bearer: true }, post: { bearer: true, idempotencyKey: true } },
  '/v1/realms/{realm}/roles': { get: { bearer: true } },
  '/v1/realms/{realm}/role-impact': { post: { bearer: true } },
  '/v1/realms/{realm}/role-changes': { post: { bearer: true, idempotencyKey: true } },
  '/v1/realms/{realm}/escalations': { post: { bearer: true, idempotencyKey: true } },
  '/v1/realms/{realm}/settings': { get: { bearer: true }, put: { bearer: true, idempotencyKey: true } },
} as const;
const params = t.Object({ realm: readUuid });
const query = t.Object({ actingSubject: readId }, { additionalProperties: false });
const headers = { 'cache-control': 'private, no-store' };
const problems = { ...writeProblems, 422: problemResult(422) };
const key = (request: Request): string => {
  const value = request.headers.get('idempotency-key');
  if (!value || !/^[A-Za-z0-9:_./-]{1,128}$/.test(value)) throw new RealmAdminInvalid('Idempotency-Key is required');
  return value;
};
function errorResponse(error: unknown) {
  if (error instanceof RealmAdminDenied) return problem(403, 'realm_management_denied', error.message);
  if (error instanceof RealmAdminInvalid) return problem(400, 'invalid_realm_management_request', error.message);
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
        return Response.json(await owner().settings(principal, `https://rezics.com/id/${path.realm}`, options.actingSubject), { headers });
      } catch (error) { return errorResponse(error); }
    })
    .put('/v1/realms/:realm/settings', { params, body: settingsCommand,
      response: { 200: settingsReceipt, 201: settingsReceipt, ...problems },
    }, async ({ request, params: path, body }) => {
      try {
        const principal = await work.account.verify(request, ['governance:decide']);
        const result = await owner().changeSettings(principal, `https://rezics.com/id/${path.realm}`, body, key(request));
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
    .post('/v1/realms/:realm/members', { params, body: memberCommand,
      response: { 200: memberReceipt, 201: memberReceipt, ...problems },
    }, async ({ request, params: path, body }) => {
      try {
        const principal = await work.account.verify(request, ['governance:decide']);
        const result = await owner().changeMember(principal, `https://rezics.com/id/${path.realm}`, body, key(request));
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
