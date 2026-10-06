import { Elysia, t } from 'elysia';
import { PlatformGrantDenied, PlatformGrantStale, PlatformGrantConflict, PlatformGrantUnavailable }
  from '../modules/access/platform-grants.ts';
import { GROUP_SCOPE } from '../modules/access/groups.ts';
import { groupChangeIntentDigest } from '../modules/access/group-intent.ts';
import { OrgRealmUnavailable } from '../modules/access/org-realm-authority.ts';
import { ManagedOrgUnavailable } from '../modules/access/managed-org-authority.ts';
import { managedOrgUuid, managedOrgQuery, managedOrgStateResult, managedOrgChangeBody,
  managedOrgChangeResult, managedOrgReadQuery, managedOrgReadResult, orgRosterPolicyBody,
  orgRosterPolicyResult } from '../modules/access/managed-org-schemas.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { groupAgent, groupGeneration, groupUuid } from './shared.ts';

const groupChangeCommon = { profile: t.Literal('work-create-group-change-v1'),
  issuerSubject: groupAgent, expectedGroupGeneration: groupGeneration };

const groupChangeBody = t.Union([
  t.Object({ ...groupChangeCommon, action: t.Literal('create'),
    groupId: groupUuid, parentId: t.Nullable(groupUuid) }, { additionalProperties: false }),
  t.Object({ ...groupChangeCommon, action: t.Literal('reparent'),
    groupId: groupUuid, expectedObjectGeneration: groupGeneration,
    parentId: t.Nullable(groupUuid) }, { additionalProperties: false }),
  t.Object({ ...groupChangeCommon, action: t.Literal('add-member'),
    memberId: groupUuid, groupId: groupUuid, agentSubject: groupAgent },
  { additionalProperties: false }),
  t.Object({ ...groupChangeCommon, action: t.Literal('grant'),
    grantId: groupUuid, groupId: groupUuid, validUntil: t.String({ format: 'date-time' }),
    membershipDependency: t.Optional(t.Object({ membershipId: groupUuid,
      generation: groupGeneration }, { additionalProperties: false })) },
  { additionalProperties: false }),
  t.Object({ ...groupChangeCommon, action: t.Literal('revoke-member'),
    memberId: groupUuid, expectedObjectGeneration: groupGeneration },
  { additionalProperties: false }),
  t.Object({ ...groupChangeCommon, action: t.Literal('revoke-grant'),
    grantId: groupUuid, expectedObjectGeneration: groupGeneration },
  { additionalProperties: false }),
]);

const groupScopeResult = t.Object({ profile: t.Literal('work-create-group-scope-v1'),
  scope: t.Literal('work:create:root'), groupGeneration,
  groups: t.Array(t.Object({ id: groupUuid, parentId: t.Nullable(groupUuid),
    generation: groupGeneration }), { maxItems: 256 }),
  members: t.Array(t.Object({ id: groupUuid, groupId: groupUuid, agentSubject: groupAgent,
    generation: groupGeneration }), { maxItems: 1024 }),
  grants: t.Array(t.Object({ id: groupUuid, groupId: groupUuid, issuerSubject: groupAgent,
    validUntil: t.String({ format: 'date-time' }), generation: groupGeneration,
    membershipDependency: t.Nullable(t.Object({ membershipId: groupUuid,
      generation: groupGeneration })) }), { maxItems: 256 }) });

const groupChangeResult = t.Object({ profile: t.Literal('work-create-group-change-v1'),
  action: t.Union([t.Literal('create'), t.Literal('reparent'), t.Literal('add-member'),
    t.Literal('grant'), t.Literal('revoke-member'), t.Literal('revoke-grant')]),
  groupGeneration });

const groupImpactBody = t.Object({ profile: t.Literal('work-create-group-impact-v1'),
  proposalId: groupUuid, issuerSubject: groupAgent, expectedGroupGeneration: groupGeneration,
  groupId: groupUuid, expectedObjectGeneration: groupGeneration,
  parentId: t.Nullable(groupUuid) }, { additionalProperties: false });

const groupImpactPreviewResult = t.Object({ profile: t.Literal('work-create-group-impact-v1'),
  proposalId: groupUuid, issuerSubject: groupAgent, groupId: groupUuid,
  parentId: t.Nullable(groupUuid), expectedGroupGeneration: groupGeneration,
  expectedObjectGeneration: groupGeneration, impactDigest: t.String({ pattern: '^[0-9a-f]{64}$' }),
  affectedMemberCount: t.Integer({ minimum: 1, maximum: 1024 }),
  gainedGrantIds: t.Array(groupUuid, { maxItems: 256 }),
  lostGrantIds: t.Array(groupUuid, { maxItems: 256 }),
  expiresAt: t.String({ format: 'date-time' }),
  status: t.Union([t.Literal('pending'), t.Literal('stale'), t.Literal('activated')]),
  activatedGeneration: t.Nullable(groupGeneration) });

const groupImpactApprovalBody = t.Object({ profile: t.Literal('work-create-group-impact-approval-v1'),
  proposalId: groupUuid, approverSubject: groupAgent,
  impactDigest: t.String({ pattern: '^[0-9a-f]{64}$' }) }, { additionalProperties: false });

const groupImpactApprovalResult = t.Object({ profile: t.Literal('work-create-group-impact-approval-v1'),
  proposalId: groupUuid, groupGeneration });

const agentGrant = t.Object({ id: groupUuid, issuerSubject: groupAgent,
  recipientSubject: groupAgent, validUntil: t.String({ format: 'date-time' }),
  active: t.Boolean(), generation: groupGeneration });

const grantPageResult = t.Object({ profile: t.Literal('work-create-agent-grants-v1'),
  authorityEpoch: groupGeneration, grants: t.Array(agentGrant, { maxItems: 50 }),
  nextCursor: t.Nullable(groupUuid) });

const grantReadResult = t.Object({ profile: t.Literal('work-create-agent-grant-v1'),
  authorityEpoch: groupGeneration, grant: agentGrant });

const grantChangeCommon = { profile: t.Literal('work-create-agent-grant-change-v1'),
  issuerSubject: groupAgent, expectedAuthorityEpoch: groupGeneration };

const workGrantChangeBody = t.Union([
  t.Object({ ...grantChangeCommon, action: t.Literal('create'),
    grantId: groupUuid, recipientSubject: groupAgent,
    validUntil: t.String({ format: 'date-time' }),
    membershipDependency: t.Optional(t.Object({ membershipId: groupUuid,
      generation: groupGeneration }, { additionalProperties: false })) },
  { additionalProperties: false }),
  t.Object({ ...grantChangeCommon, action: t.Literal('revoke'),
    grantId: groupUuid, expectedObjectGeneration: groupGeneration },
  { additionalProperties: false }),
]);

const grantChangeResult = t.Object({ profile: t.Literal('work-create-agent-grant-change-v1'),
  action: t.Union([t.Literal('create'), t.Literal('revoke')]),
  authorityEpoch: groupGeneration });

const platformRecipient = t.Union([
  t.Object({ principalId: groupUuid }, { additionalProperties: false }),
  t.Object({ groupId: groupUuid }, { additionalProperties: false }),
]);
const platformGrant = t.Object({ id: groupUuid, issuerSubject: groupAgent,
  permission: t.String({ minLength: 1, maxLength: 128 }), scopeId: t.String({ minLength: 1, maxLength: 256 }),
  recipient: platformRecipient, validUntil: t.Nullable(t.String({ format: 'date-time' })),
  active: t.Boolean(), generation: groupGeneration, receipt: t.String() });
const platformGrantChangeCommon = { profile: t.Literal('platform-grant-change-v1'),
  issuerSubject: groupAgent, expectedAuthorityEpoch: groupGeneration, grantId: groupUuid };
const platformGrantChangeBody = t.Union([
  t.Object({ ...platformGrantChangeCommon, action: t.Literal('create'), permission: t.String({ minLength: 1, maxLength: 128 }),
    recipient: platformRecipient, validUntil: t.Nullable(t.String({ format: 'date-time' })),
    scopeId: t.Optional(t.String({ minLength: 1, maxLength: 256 })) }, { additionalProperties: false }),
  t.Object({ ...platformGrantChangeCommon, action: t.Literal('revoke'), expectedObjectGeneration: groupGeneration },
    { additionalProperties: false }),
]);
const grantChangeBody = t.Union([workGrantChangeBody, platformGrantChangeBody]);
const platformGrantResult = t.Object({ profile: t.Literal('platform-grant-v1'), authorityEpoch: groupGeneration, grant: platformGrant });
const platformGrantPage = t.Object({ profile: t.Literal('platform-grants-v1'), authorityEpoch: groupGeneration,
  grants: t.Array(platformGrant, { maxItems: 50 }), nextCursor: t.Nullable(groupUuid) });
const platformGrantChangeResult = t.Object({ profile: t.Literal('platform-grant-change-v1'),
  authorityEpoch: groupGeneration, grant: platformGrant });
const grantError = (error: unknown) => {
  if (error instanceof PlatformGrantDenied) return problem(403, 'grant_denied', error.message);
  if (error instanceof PlatformGrantStale) return problem(409, 'grant_stale', error.message);
  if (error instanceof PlatformGrantConflict) return problem(409, 'idempotency_conflict', error.message);
  if (error instanceof PlatformGrantUnavailable) return problem(503, 'grant_unavailable', error.message);
  return commandError(error);
};

const orgContentDraftGrantBody = t.Object({
  profile: t.Literal('access-organization-content-draft-grant-change-v1'),
  organizationSubject: groupAgent, recipientSubject: groupAgent, grantId: groupUuid,
  expectedAuthorityEpoch: groupGeneration, validUntil: t.String({ format: 'date-time' }),
}, { additionalProperties: false });
const orgContentDraftGrantResult = t.Object({
  profile: t.Literal('access-organization-content-draft-grant-change-v1'),
  organizationSubject: groupAgent, recipientSubject: groupAgent, grantId: groupUuid,
  scope: t.String({ minLength: 1, maxLength: 256 }), action: t.Literal('content.draft'),
  authorityEpoch: groupGeneration,
});

export const openApiOperations = {
  '/v1/access/organization-content-draft-grants': { post: { exposure: 'platform:organization-authority', bearer: true, idempotencyKey: true } },
  '/v1/access/org-realm-participation': { get: { exposure: 'platform:organization-authority' } },
  '/v1/access/org-realm-moves': { post: { exposure: 'platform:organization-authority' } },
  '/v1/access/org-realm-changes': { post: { exposure: 'platform:organization-authority' } },
  '/v1/access/org-realm-proposals': { post: { exposure: 'platform:organization-authority' } },
  '/v1/access/organization-roster-policy': { post: { exposure: 'platform:organization-authority' } },
  '/v1/access/managed-organization-grants': { post: { exposure: 'platform:organization-authority' } },
  '/v1/access/managed-organization-grants/{grantId}': { get: { exposure: 'platform:organization-authority' } },
  '/v1/access/organization-management': { get: { exposure: 'platform:organization-authority' } },
  '/v1/access/grant-changes': { post: { exposure: 'public' } },
  '/v1/access/grants/{grantId}': { get: { exposure: 'public' } },
  '/v1/access/grants': { get: { exposure: 'public' } },
  '/v1/access/group-impact-approvals': { post: { exposure: 'public' } },
  '/v1/access/group-impact-proposals/{proposalId}': { get: { exposure: 'public' } },
  '/v1/access/group-impact-proposals': { post: { exposure: 'public' } },
  '/v1/access/group-changes': { post: { exposure: 'public' } },
  '/v1/access/group-scope': { get: { exposure: 'public' } },
} as const;

const orgRealmTuple = { realm: groupAgent, organizationSubject: groupAgent };

const orgRealmBasis = { ...orgRealmTuple,
  expectedGeneration: groupGeneration, expectedPolicyRevision: groupGeneration };

const orgRealmProposalBody = t.Object({ ...orgRealmBasis,
  profile: t.Literal('access-org-realm-proposal-v1'),
  termsRevision: t.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false });

const orgRealmProposalResult = t.Object({ ...orgRealmTuple,
  profile: t.Literal('access-org-realm-proposal-v1'), proposalId: groupUuid,
  nextGeneration: groupGeneration, policyRevision: groupGeneration,
  termsRevision: t.String(), expiresAt: t.String({ format: 'date-time' }), replayed: t.Boolean() });

const orgRealmChangeCommon = { ...orgRealmBasis, profile: t.Literal('access-org-realm-change-v1') };

const orgRealmChangeBody = t.Union([
  t.Object({ ...orgRealmChangeCommon, action: t.Literal('join'), proposalId: groupUuid,
    termsRevision: t.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false }),
  t.Object({ ...orgRealmChangeCommon, action: t.Literal('leave') }, { additionalProperties: false }),
  t.Object({ ...orgRealmChangeCommon, action: t.Union([t.Literal('suspend'), t.Literal('lift-ban')]),
    reasonReference: t.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false }),
]);

const orgRealmResultFields = { ...orgRealmTuple, participationId: t.Nullable(groupUuid),
  mode: t.Literal('independent'),
  state: t.Union([t.Literal('absent'), t.Literal('joined'), t.Literal('left'), t.Literal('suspended')]),
  generation: groupGeneration, policyRevision: groupGeneration, termsRevision: t.String(),
  admissionOpen: t.Boolean(), banned: t.Boolean(), banGeneration: groupGeneration,
  proposalId: t.Nullable(groupUuid) };

const orgRealmChangeResult = t.Object({ ...orgRealmResultFields,
  profile: t.Literal('access-org-realm-change-v1'),
  action: t.Union([t.Literal('join'), t.Literal('leave'), t.Literal('suspend'), t.Literal('lift-ban')]),
  authorityEpoch: groupGeneration, replayed: t.Boolean() });

const orgRealmReadResult = t.Object({ ...orgRealmResultFields,
  profile: t.Literal('access-org-realm-participation-v1') });

const orgRealmMoveSide = { realm: groupAgent,
  expectedGeneration: groupGeneration, expectedPolicyRevision: groupGeneration, proposalId: groupUuid };

const orgRealmMoveBody = t.Object({ profile: t.Literal('access-org-realm-move-v1'),
  organizationSubject: groupAgent,
  source: t.Object({ ...orgRealmMoveSide, participationId: groupUuid }, { additionalProperties: false }),
  target: t.Object({ ...orgRealmMoveSide, termsRevision: t.String({ minLength: 1, maxLength: 128 }) },
    { additionalProperties: false }) }, { additionalProperties: false });

const orgRealmMoveResult = t.Object({ profile: t.Literal('access-org-realm-move-v1'), moveId: groupUuid,
  source: t.Object({ ...orgRealmResultFields, participationId: groupUuid, state: t.Literal('left') }),
  target: t.Object({ ...orgRealmResultFields, participationId: groupUuid, state: t.Literal('joined') }),
  authorityEpoch: groupGeneration, replayed: t.Boolean() });

export function accessAuthorityRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .get('/v1/access/group-scope', {
      query: t.Object({ issuerSubject: groupAgent }, { additionalProperties: false }),
      response: { 200: groupScopeResult, ...authorizedReadProblems },
    }, async ({ request, query }) => {
      try {
        const principal = await work.account.verify(request, ['access:manage']);
        if (!work.groups) return problem(503, 'group_unavailable', 'Group management is unavailable');
        const state = await work.groups.readState(principal, query.issuerSubject);
        return Response.json({ profile: 'work-create-group-scope-v1',
          scope: GROUP_SCOPE, ...state },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/access/group-changes', {
      body: groupChangeBody,
      response: { 200: groupChangeResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['access:manage']);
        if (!work.groups) return problem(503, 'group_unavailable', 'Group management is unavailable');
        const idempotencyKey = request.headers.get('idempotency-key');
        if (!idempotencyKey || idempotencyKey.length > 128 || idempotencyKey.includes('\0')) {
          return problem(400, 'invalid_idempotency_key', 'A bounded idempotency key is required');
        }
        const context = { principal, issuerSubject: body.issuerSubject,
          expectedGroupGeneration: body.expectedGroupGeneration };
        const receipt = { idempotencyKey, requestDigest: groupChangeIntentDigest(body) };
        const groups = work.groups;
        let groupGeneration: string;
        switch (body.action) {
          case 'create':
            groupGeneration = await groups.create(context, body.groupId, body.parentId, receipt);
            break;
          case 'reparent':
            groupGeneration = await groups.reparent(context, body.groupId,
              body.expectedObjectGeneration, body.parentId, receipt);
            break;
          case 'add-member':
            groupGeneration = await groups.addMember(context, body.memberId,
              body.groupId, body.agentSubject, receipt);
            break;
          case 'grant':
            groupGeneration = await groups.grant(context, body.grantId,
              body.groupId, new Date(body.validUntil), receipt, body.membershipDependency);
            break;
          case 'revoke-member':
            groupGeneration = await groups.revokeMember(context, body.memberId,
              body.expectedObjectGeneration, receipt);
            break;
          case 'revoke-grant':
            groupGeneration = await groups.revokeGrant(context, body.grantId,
              body.expectedObjectGeneration, receipt);
            break;
        }
        return Response.json({ profile: 'work-create-group-change-v1',
          action: body.action, groupGeneration },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/access/group-impact-proposals', {
      body: groupImpactBody,
      response: { 200: groupImpactPreviewResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['access:manage']);
        if (!work.groups) return problem(503, 'group_unavailable', 'Group management is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key || key.length > 128 || key.includes('\0')) {
          return problem(400, 'invalid_idempotency_key', 'A bounded idempotency key is required');
        }
        const preview = await work.groups.proposeImpact({ principal,
          issuerSubject: body.issuerSubject,
          expectedGroupGeneration: body.expectedGroupGeneration }, body.proposalId,
        body.groupId, body.expectedObjectGeneration, body.parentId,
        groupChangeIntentDigest(body), key);
        return Response.json({ profile: 'work-create-group-impact-v1', ...preview },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/access/group-impact-proposals/:proposalId', {
      params: t.Object({ proposalId: groupUuid }),
      query: t.Object({ approverSubject: groupAgent }, { additionalProperties: false }),
      response: { 200: groupImpactPreviewResult, ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        const principal = await work.account.verify(request, ['access:approve']);
        if (!work.groups) return problem(503, 'group_unavailable', 'Group management is unavailable');
        const preview = await work.groups.readImpactProposal(principal,
          query.approverSubject, params.proposalId);
        return Response.json({ profile: 'work-create-group-impact-v1', ...preview },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/access/group-impact-approvals', {
      body: groupImpactApprovalBody,
      response: { 200: groupImpactApprovalResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['access:approve']);
        if (!work.groups) return problem(503, 'group_unavailable', 'Group management is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key || key.length > 128 || key.includes('\0')) {
          return problem(400, 'invalid_idempotency_key', 'A bounded idempotency key is required');
        }
        const groupGeneration = await work.groups.approveImpact(principal,
          body.approverSubject, body.proposalId, body.impactDigest, key);
        return Response.json({ profile: 'work-create-group-impact-approval-v1',
          proposalId: body.proposalId, groupGeneration },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/access/grants', {
      query: t.Object({ issuerSubject: groupAgent, after: t.Optional(groupUuid), profile: t.Optional(t.Literal('platform-grants-v1')) },
        { additionalProperties: false }),
      response: { 200: t.Union([grantPageResult,platformGrantPage]), ...authorizedReadProblems },
    }, async ({ request, query }) => {
      try {
        const principal = await work.account.verify(request, ['access:grant']);
        if (!work.grants) return problem(503, 'grant_unavailable', 'Grant owner is unavailable');
        if (query.profile === 'platform-grants-v1') return Response.json({ profile: query.profile,
          ...await work.grants.platform.readPage(principal,query.issuerSubject,query.after) },
          { headers: { 'cache-control': 'private, no-store' } });
        const page = await work.grants.readPage(principal, query.issuerSubject, query.after);
        return Response.json({ profile: 'work-create-agent-grants-v1', ...page },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return grantError(error); }
    })
    .get('/v1/access/grants/:grantId', {
      params: t.Object({ grantId: groupUuid }),
      query: t.Object({ issuerSubject: groupAgent, profile: t.Optional(t.Literal('platform-grant-v1')) }, { additionalProperties: false }),
      response: { 200: t.Union([grantReadResult,platformGrantResult]), ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        const principal = await work.account.verify(request, ['access:grant']);
        if (!work.grants) return problem(503, 'grant_unavailable', 'Grant owner is unavailable');
        if (query.profile === 'platform-grant-v1') return Response.json({ profile: query.profile,
          ...await work.grants.platform.readOne(principal,query.issuerSubject,params.grantId) },
          { headers: { 'cache-control': 'private, no-store' } });
        const grant = await work.grants.readOne(principal, query.issuerSubject, params.grantId);
        return Response.json({ profile: 'work-create-agent-grant-v1', ...grant },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return grantError(error); }
    })
    .post('/v1/access/grant-changes', {
      body: grantChangeBody,
      response: { 200: t.Union([grantChangeResult,platformGrantChangeResult]), ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['access:grant']);
        if (!work.grants) return problem(503, 'grant_unavailable', 'Grant owner is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key || key.length > 128 || key.includes('\0')) {
          return problem(400, 'invalid_idempotency_key', 'A bounded idempotency key is required');
        }
        const context = { principal, issuerSubject: body.issuerSubject,
          expectedAuthorityEpoch: body.expectedAuthorityEpoch };
        const receipt = { idempotencyKey: key, requestDigest: groupChangeIntentDigest(body) };
        if (body.profile === 'platform-grant-change-v1') {
          const result = body.action === 'create'
            ? await work.grants.platform.create(context,body.grantId,body.permission,body.recipient,
              body.validUntil === null ? null : new Date(body.validUntil),receipt,body.scopeId)
            : await work.grants.platform.revoke(context,body.grantId,body.expectedObjectGeneration,receipt);
          return Response.json({ profile: body.profile, ...result }, { headers: { 'cache-control': 'private, no-store' } });
        }
        const authorityEpoch = body.action === 'create'
          ? await work.grants.create(context, body.grantId, body.recipientSubject,
            new Date(body.validUntil), receipt, body.membershipDependency)
          : await work.grants.revoke(context, body.grantId,
            body.expectedObjectGeneration, receipt);
        return Response.json({ profile: 'work-create-agent-grant-change-v1',
          action: body.action, authorityEpoch },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return grantError(error); }
    })
    .post('/v1/access/organization-content-draft-grants', {
      body: orgContentDraftGrantBody,
      response: { 200: orgContentDraftGrantResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['access:grant']);
        if (!work.grants) return problem(503, 'grant_unavailable', 'Grant owner is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key || key.length > 128 || key.includes('\0')) {
          return problem(400, 'invalid_idempotency_key', 'A bounded idempotency key is required');
        }
        const result = await work.grants.createOrganizationContentDraft({ principal,
          issuerSubject: body.organizationSubject, expectedAuthorityEpoch: body.expectedAuthorityEpoch },
        body.grantId, body.recipientSubject, new Date(body.validUntil),
        { idempotencyKey: key, requestDigest: groupChangeIntentDigest(body) });
        return Response.json({ profile: body.profile, organizationSubject: body.organizationSubject,
          recipientSubject: body.recipientSubject, grantId: body.grantId,
          scope: `content:draft:${body.organizationSubject}`, action: 'content.draft',
          authorityEpoch: result }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/access/organization-management', {
      query: managedOrgQuery,
      response: { 200: managedOrgStateResult, ...writeProblems },
    }, async ({ request, query }) => {
      try {
        const principal = await work.account.verify(request, ['access:manage']);
        if (!work.managedOrganizations) throw new ManagedOrgUnavailable('owner missing');
        const result = await work.managedOrganizations.readOrganization(principal, query.organizationSubject);
        return Response.json({ profile: 'access-organization-management-v1', ...result },
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/access/managed-organization-grants/:grantId', {
      params: t.Object({ grantId: managedOrgUuid }), query: managedOrgReadQuery,
      response: { 200: managedOrgReadResult, ...writeProblems },
    }, async ({ request, params, query }) => {
      try {
        const principal = await work.account.verify(request, ['access:manage']);
        if (!work.managedOrganizations) throw new ManagedOrgUnavailable('owner missing');
        const result = await work.managedOrganizations.readGrant(principal, params.grantId, query.side);
        return Response.json({ profile: 'access-managed-organization-grant-v1', ...result },
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/access/managed-organization-grants', {
      body: managedOrgChangeBody, response: { 200: managedOrgChangeResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['access:manage']);
        if (!work.managedOrganizations) throw new ManagedOrgUnavailable('owner missing');
        const key = request.headers.get('idempotency-key');
        if (!key || key.length > 128 || key.includes('\0')) {
          return problem(400, 'invalid_idempotency_key', 'A bounded idempotency key is required');
        }
        const result = await work.managedOrganizations.change(principal, body, key);
        return Response.json({ profile: 'access-managed-organization-grant-v1', ...result },
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/access/organization-roster-policy', {
      body: orgRosterPolicyBody, response: { 200: orgRosterPolicyResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['access:manage']);
        if (!work.managedOrganizations) throw new ManagedOrgUnavailable('owner missing');
        const key = request.headers.get('idempotency-key');
        if (!key || key.length > 128 || key.includes('\0')) {
          return problem(400, 'invalid_idempotency_key', 'A bounded idempotency key is required');
        }
        const result = await work.managedOrganizations.setRosterPolicy(principal, body, key);
        return Response.json({ profile: 'access-organization-roster-policy-v1', ...result },
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/access/org-realm-proposals', {
      body: orgRealmProposalBody,
      response: { 200: orgRealmProposalResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['access:manage']);
        if (!work.orgRealmParticipation) throw new OrgRealmUnavailable('owner missing');
        const key = request.headers.get('idempotency-key');
        if (!key || key.length > 128 || key.includes('\0')) {
          return problem(400, 'invalid_idempotency_key', 'A bounded idempotency key is required');
        }
        const result = await work.orgRealmParticipation.propose(principal, body, key);
        return Response.json({ profile: 'access-org-realm-proposal-v1', ...result },
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/access/org-realm-changes', {
      body: orgRealmChangeBody,
      response: { 200: orgRealmChangeResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['access:manage']);
        if (!work.orgRealmParticipation) throw new OrgRealmUnavailable('owner missing');
        const key = request.headers.get('idempotency-key');
        if (!key || key.length > 128 || key.includes('\0')) {
          return problem(400, 'invalid_idempotency_key', 'A bounded idempotency key is required');
        }
        const result = await work.orgRealmParticipation.change(principal, body, key);
        return Response.json({ profile: 'access-org-realm-change-v1', ...result },
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/access/org-realm-moves', {
      body: orgRealmMoveBody,
      response: { 200: orgRealmMoveResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['access:manage']);
        if (!work.orgRealmParticipation) throw new OrgRealmUnavailable('owner missing');
        const key = request.headers.get('idempotency-key');
        if (!key || key.length > 128 || key.includes('\0')) {
          return problem(400, 'invalid_idempotency_key', 'A bounded idempotency key is required');
        }
        const result = await work.orgRealmParticipation.move(principal, body, key);
        return Response.json({ profile: 'access-org-realm-move-v1', ...result },
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/access/org-realm-participation', {
      query: t.Object({ ...orgRealmTuple,
        side: t.Union([t.Literal('organization'), t.Literal('realm')]) }, { additionalProperties: false }),
      response: { 200: orgRealmReadResult, ...writeProblems },
    }, async ({ request, query }) => {
      try {
        const principal = await work.account.verify(request, ['access:manage']);
        if (!work.orgRealmParticipation) throw new OrgRealmUnavailable('owner missing');
        const result = await work.orgRealmParticipation.read(principal, query);
        return Response.json({ profile: 'access-org-realm-participation-v1', ...result },
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    });
}
