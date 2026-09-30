import { Elysia, t } from 'elysia';
import { groupChangeIntentDigest } from '../modules/access/group-intent.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { groupAgent, groupGeneration, groupUuid } from './shared.ts';

const representationRequestBody = t.Object({
  profile: t.Literal('work-create-representation-request-v1'),
  requestId: groupUuid, actingSubject: groupAgent,
  validUntil: t.String({ format: 'date-time' }) }, { additionalProperties: false });

const representationRequestResult = t.Object({
  profile: t.Literal('work-create-representation-request-v1'),
  requestId: groupUuid, actingSubject: groupAgent,
  validUntil: t.String({ format: 'date-time' }),
  expiresAt: t.String({ format: 'date-time' }),
  status: t.Union([t.Literal('pending'), t.Literal('expired'), t.Literal('accepted')]),
  representationId: t.Nullable(groupUuid) });

const representationCommon = { profile: t.Literal('work-create-representation-change-v1'),
  issuerSubject: groupAgent, expectedAuthorityEpoch: groupGeneration };

const representationChangeBody = t.Union([
  t.Object({ ...representationCommon, action: t.Literal('accept'),
    requestId: groupUuid, representationId: groupUuid }, { additionalProperties: false }),
  t.Object({ ...representationCommon, action: t.Literal('revoke'),
    representationId: groupUuid, expectedObjectGeneration: groupGeneration },
  { additionalProperties: false }),
]);

const representationChangeResult = t.Object({
  profile: t.Literal('work-create-representation-change-v1'),
  action: t.Union([t.Literal('accept'), t.Literal('revoke')]),
  representationId: groupUuid, authorityEpoch: groupGeneration });

const representationReadResult = t.Object({
  profile: t.Literal('work-create-representation-v1'),
  id: groupUuid, actingSubject: groupAgent, requestId: t.Nullable(groupUuid),
  validUntil: t.String({ format: 'date-time' }),
  active: t.Boolean(), generation: groupGeneration, authorityEpoch: groupGeneration });

const rolePermissions = t.Array(t.Union([t.Literal('work.create'), t.Literal('work.edit')]),
  { maxItems: 2, uniqueItems: true });

const roleFamilyBody = t.Object({ profile: t.Literal('work-create-role-family-v1'),
  familyId: groupUuid, issuerSubject: groupAgent,
  expectedAuthorityEpoch: groupGeneration, permissions: rolePermissions },
{ additionalProperties: false });

const roleRevisionBody = t.Object({ profile: t.Literal('work-create-role-revision-v1'),
  familyId: groupUuid, issuerSubject: groupAgent, expectedAuthorityEpoch: groupGeneration,
  expectedHeadRevision: groupGeneration, permissions: rolePermissions },
{ additionalProperties: false });

const roleRevisionResult = t.Object({ profile: t.Literal('work-create-role-revision-v1'),
  familyId: groupUuid, revision: groupGeneration });

const roleFamilyResult = t.Object({ profile: t.Literal('work-create-role-family-v1'),
  id: groupUuid, ownerSubject: groupAgent, headRevision: groupGeneration,
  revisions: t.Array(t.Object({ revision: groupGeneration, permissions: rolePermissions }),
    { maxItems: 32 }) });

const roleBinding = t.Object({ id: groupUuid, familyId: groupUuid,
  roleRevision: groupGeneration, issuerSubject: groupAgent,
  recipientSubject: groupAgent, validUntil: t.String({ format: 'date-time' }),
  active: t.Boolean(), generation: groupGeneration,
  membershipDependency: t.Nullable(t.Object({ membershipId: groupUuid,
    generation: groupGeneration })) });

const roleBindingPageResult = t.Object({ profile: t.Literal('work-create-role-bindings-v1'),
  authorityEpoch: groupGeneration, bindings: t.Array(roleBinding, { maxItems: 50 }),
  nextCursor: t.Nullable(groupUuid) });

const roleBindingReadResult = t.Object({ profile: t.Literal('work-create-role-binding-v1'),
  authorityEpoch: groupGeneration, binding: roleBinding });

const roleBindingCommon = { profile: t.Literal('work-create-role-binding-change-v1'),
  issuerSubject: groupAgent, expectedAuthorityEpoch: groupGeneration };

const roleBindingChangeBody = t.Union([
  t.Object({ ...roleBindingCommon, action: t.Literal('bind'),
    bindingId: groupUuid, familyId: groupUuid, roleRevision: groupGeneration,
    recipientSubject: groupAgent, validUntil: t.String({ format: 'date-time' }),
    membershipDependency: t.Optional(t.Object({ membershipId: groupUuid,
      generation: groupGeneration }, { additionalProperties: false })) },
  { additionalProperties: false }),
  t.Object({ ...roleBindingCommon, action: t.Literal('revoke'),
    bindingId: groupUuid, expectedObjectGeneration: groupGeneration },
  { additionalProperties: false }),
]);

const roleBindingChangeResult = t.Object({
  profile: t.Literal('work-create-role-binding-change-v1'),
  action: t.Union([t.Literal('bind'), t.Literal('revoke')]),
  bindingId: groupUuid, authorityEpoch: groupGeneration });

export function accessRoleRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .post('/v1/me/representation-requests', {
      body: representationRequestBody,
      response: { 200: representationRequestResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['access:represent']);
        if (!work.representations) {
          return problem(503, 'representation_unavailable', 'Representation owner is unavailable');
        }
        const key = request.headers.get('idempotency-key');
        if (!key || key.length > 128 || key.includes('\0')) {
          return problem(400, 'invalid_idempotency_key', 'A bounded idempotency key is required');
        }
        const result = await work.representations.request(principal,
          body.requestId, body.actingSubject, new Date(body.validUntil), key,
          groupChangeIntentDigest(body));
        return Response.json({ profile: 'work-create-representation-request-v1', ...result },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/access/representation-requests/:requestId', {
      params: t.Object({ requestId: groupUuid }),
      query: t.Object({ issuerSubject: groupAgent }, { additionalProperties: false }),
      response: { 200: representationRequestResult, ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        const principal = await work.account.verify(request, ['access:representation-manage']);
        if (!work.representations) {
          return problem(503, 'representation_unavailable', 'Representation owner is unavailable');
        }
        const result = await work.representations.readRequest(principal,
          query.issuerSubject, params.requestId);
        return Response.json({ profile: 'work-create-representation-request-v1', ...result },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/access/representations/:representationId', {
      params: t.Object({ representationId: groupUuid }),
      query: t.Object({ issuerSubject: groupAgent }, { additionalProperties: false }),
      response: { 200: representationReadResult, ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        const principal = await work.account.verify(request, ['access:representation-manage']);
        if (!work.representations) {
          return problem(503, 'representation_unavailable', 'Representation owner is unavailable');
        }
        const result = await work.representations.readRepresentation(principal,
          query.issuerSubject, params.representationId);
        return Response.json({ profile: 'work-create-representation-v1', ...result },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/access/representation-changes', {
      body: representationChangeBody,
      response: { 200: representationChangeResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['access:representation-manage']);
        if (!work.representations) {
          return problem(503, 'representation_unavailable', 'Representation owner is unavailable');
        }
        const key = request.headers.get('idempotency-key');
        if (!key || key.length > 128 || key.includes('\0')) {
          return problem(400, 'invalid_idempotency_key', 'A bounded idempotency key is required');
        }
        const context = { principal, issuerSubject: body.issuerSubject,
          expectedAuthorityEpoch: body.expectedAuthorityEpoch,
          idempotencyKey: key, requestDigest: groupChangeIntentDigest(body) };
        const authorityEpoch = body.action === 'accept'
          ? await work.representations.accept(context, body.requestId, body.representationId)
          : await work.representations.revoke(context, body.representationId,
            body.expectedObjectGeneration);
        return Response.json({ profile: 'work-create-representation-change-v1',
          action: body.action, representationId: body.representationId, authorityEpoch },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/access/roles', {
      body: roleFamilyBody,
      response: { 200: roleRevisionResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['access:role']);
        if (!work.roles) return problem(503, 'role_unavailable', 'Role owner is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key || key.length > 128 || key.includes('\0')) {
          return problem(400, 'invalid_idempotency_key', 'A bounded idempotency key is required');
        }
        const revision = await work.roles.createFamily({ principal,
          issuerSubject: body.issuerSubject, expectedAuthorityEpoch: body.expectedAuthorityEpoch,
          idempotencyKey: key, requestDigest: groupChangeIntentDigest(body) },
        body.familyId, body.permissions);
        return Response.json({ profile: 'work-create-role-revision-v1',
          familyId: body.familyId, revision },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/access/role-revisions', {
      body: roleRevisionBody,
      response: { 200: roleRevisionResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['access:role']);
        if (!work.roles) return problem(503, 'role_unavailable', 'Role owner is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key || key.length > 128 || key.includes('\0')) {
          return problem(400, 'invalid_idempotency_key', 'A bounded idempotency key is required');
        }
        const revision = await work.roles.addRevision({ principal,
          issuerSubject: body.issuerSubject, expectedAuthorityEpoch: body.expectedAuthorityEpoch,
          idempotencyKey: key, requestDigest: groupChangeIntentDigest(body) },
        body.familyId, body.expectedHeadRevision, body.permissions);
        return Response.json({ profile: 'work-create-role-revision-v1',
          familyId: body.familyId, revision },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/access/roles/:familyId', {
      params: t.Object({ familyId: groupUuid }),
      query: t.Object({ issuerSubject: groupAgent }, { additionalProperties: false }),
      response: { 200: roleFamilyResult, ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        const principal = await work.account.verify(request, ['access:role']);
        if (!work.roles) return problem(503, 'role_unavailable', 'Role owner is unavailable');
        const family = await work.roles.readFamily(principal, query.issuerSubject, params.familyId);
        return Response.json({ profile: 'work-create-role-family-v1', ...family },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/access/role-bindings', {
      query: t.Object({ issuerSubject: groupAgent, after: t.Optional(groupUuid) },
        { additionalProperties: false }),
      response: { 200: roleBindingPageResult, ...authorizedReadProblems },
    }, async ({ request, query }) => {
      try {
        const principal = await work.account.verify(request, ['access:role']);
        if (!work.roles) return problem(503, 'role_unavailable', 'Role owner is unavailable');
        const page = await work.roles.readBindingPage(principal,
          query.issuerSubject, query.after);
        return Response.json({ profile: 'work-create-role-bindings-v1', ...page },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/access/role-bindings/:bindingId', {
      params: t.Object({ bindingId: groupUuid }),
      query: t.Object({ issuerSubject: groupAgent }, { additionalProperties: false }),
      response: { 200: roleBindingReadResult, ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        const principal = await work.account.verify(request, ['access:role']);
        if (!work.roles) return problem(503, 'role_unavailable', 'Role owner is unavailable');
        const binding = await work.roles.readBinding(principal,
          query.issuerSubject, params.bindingId);
        return Response.json({ profile: 'work-create-role-binding-v1', ...binding },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/access/role-bindings', {
      body: roleBindingChangeBody,
      response: { 200: roleBindingChangeResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['access:role']);
        if (!work.roles) return problem(503, 'role_unavailable', 'Role owner is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key || key.length > 128 || key.includes('\0')) {
          return problem(400, 'invalid_idempotency_key', 'A bounded idempotency key is required');
        }
        const context = { principal, issuerSubject: body.issuerSubject,
          expectedAuthorityEpoch: body.expectedAuthorityEpoch,
          idempotencyKey: key, requestDigest: groupChangeIntentDigest(body) };
        const authorityEpoch = body.action === 'bind'
          ? await work.roles.bind(context, body.bindingId, body.familyId,
            body.roleRevision, body.recipientSubject, new Date(body.validUntil),
            body.membershipDependency)
          : await work.roles.revokeBinding(context, body.bindingId,
            body.expectedObjectGeneration);
        return Response.json({ profile: 'work-create-role-binding-change-v1',
          action: body.action, bindingId: body.bindingId, authorityEpoch },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    });
}
