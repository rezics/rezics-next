import { Elysia, t } from 'elysia';
import { groupChangeIntentDigest } from '../modules/access/group-intent.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { groupAgent, groupGeneration, groupUuid } from './shared.ts';
import { AccountAssertionInsufficientScope } from '../modules/account/verify-assertion.ts';

const membershipCommon = { profile: t.Literal('access-membership-change-v1'),
  kind: t.Union([t.Literal('org'), t.Literal('realm')]),
  ownerSubject: groupAgent, memberSubject: groupAgent,
  expectedGeneration: groupGeneration, expectedPolicyRevision: groupGeneration };

const membershipChangeBody = t.Union([
  t.Object({ ...membershipCommon, action: t.Literal('join'),
    termsRevision: t.String({ minLength: 1, maxLength: 128 }),
    consentReference: groupUuid },
  { additionalProperties: false }),
  t.Object({ ...membershipCommon, action: t.Literal('leave') },
  { additionalProperties: false }),
]);

const membershipChangeResult = t.Object({ profile: t.Literal('access-membership-change-v1'),
  membershipId: groupUuid, kind: t.Union([t.Literal('org'), t.Literal('realm')]),
  ownerSubject: groupAgent, memberSubject: groupAgent,
  action: t.Union([t.Literal('join'), t.Literal('leave')]),
  state: t.Union([t.Literal('joined'), t.Literal('left')]),
  generation: groupGeneration, policyRevision: groupGeneration,
  termsRevision: t.Nullable(t.String()), consentReference: t.Nullable(t.String()),
  authorityEpoch: groupGeneration, replayed: t.Boolean() });

const representedRequestBody = t.Object({
  profile: t.Literal('access-represented-org-membership-request-v1'),
  requestId: groupUuid, actingSubject: groupAgent, ownerSubject: groupAgent,
  validUntil: t.String({ format: 'date-time' }),
}, { additionalProperties: false });

const representedRequestResult = t.Object({
  profile: t.Literal('access-represented-org-membership-request-v1'),
  requestId: groupUuid, actingSubject: groupAgent, ownerSubject: groupAgent,
  validUntil: t.String({ format: 'date-time' }), expiresAt: t.String({ format: 'date-time' }),
  status: t.Union([t.Literal('pending'), t.Literal('expired'), t.Literal('accepted')]),
  representationId: t.Nullable(groupUuid),
});

const representedChangeCommon = {
  issuerSubject: groupAgent, ownerSubject: groupAgent, expectedAuthorityEpoch: groupGeneration,
};

const representedMandateBody = t.Union([
  t.Object({ ...representedChangeCommon,
    profile: t.Literal('access-represented-org-mandate-change-v1'),
    action: t.Literal('accept'), requestId: groupUuid, representationId: groupUuid },
  { additionalProperties: false }),
  t.Object({ ...representedChangeCommon,
    profile: t.Literal('access-represented-org-mandate-change-v1'),
    action: t.Literal('revoke'), representationId: groupUuid,
    expectedObjectGeneration: groupGeneration }, { additionalProperties: false }),
]);

const representedGrantBody = t.Union([
  t.Object({ ...representedChangeCommon,
    profile: t.Literal('access-represented-org-grant-change-v1'),
    action: t.Literal('grant'), grantId: groupUuid, recipientSubject: groupAgent,
    validUntil: t.String({ format: 'date-time' }) }, { additionalProperties: false }),
  t.Object({ ...representedChangeCommon,
    profile: t.Literal('access-represented-org-grant-change-v1'),
    action: t.Literal('revoke'), grantId: groupUuid,
    expectedObjectGeneration: groupGeneration }, { additionalProperties: false }),
]);

const representedAuthorityResult = t.Object({
  profile: t.Union([t.Literal('access-represented-org-mandate-change-v1'),
    t.Literal('access-represented-org-grant-change-v1')]),
  action: t.Union([t.Literal('accept'), t.Literal('revoke'), t.Literal('grant')]),
  objectId: groupUuid, authorityEpoch: groupGeneration,
});

const representedProof = {
  actingSubject: groupAgent, representationId: groupUuid,
  expectedRepresentationGeneration: groupGeneration, grantId: groupUuid,
  expectedGrantGeneration: groupGeneration, expectedPrincipalEpoch: groupGeneration,
  expectedActingGeneration: groupGeneration, expectedOwnerGeneration: groupGeneration,
  expectedAuthorityEpoch: groupGeneration,
};

const representedMembershipCommon = {
  profile: t.Literal('access-represented-org-membership-change-v1'),
  ownerSubject: groupAgent, memberSubject: groupAgent,
  expectedGeneration: groupGeneration, expectedPolicyRevision: groupGeneration,
  ...representedProof,
};

const representedMembershipBody = t.Union([
  t.Object({ ...representedMembershipCommon, action: t.Literal('join'),
    termsRevision: t.String({ minLength: 1, maxLength: 128 }), consentReference: groupUuid },
  { additionalProperties: false }),
  t.Object({ ...representedMembershipCommon, action: t.Literal('leave') },
  { additionalProperties: false }),
]);

const representedMembershipResult = t.Object({
  ...membershipChangeResult.properties,
  profile: t.Literal('access-represented-org-membership-change-v1'),
  kind: t.Literal('org'), actingSubject: groupAgent,
});

const eligibleSetGrantBody = t.Union([
  t.Object({ profile: t.Literal('access-eligible-org-member-set-grant-change-v1'),
    action: t.Literal('grant'), issuerSubject: groupAgent,
    recipientSubject: groupAgent, selectorId: groupUuid, grantId: groupUuid,
    expectedAuthorityEpoch: groupGeneration,
    validUntil: t.String({ format: 'date-time' }) }, { additionalProperties: false }),
  t.Object({ profile: t.Literal('access-eligible-org-member-set-grant-change-v1'),
    action: t.Literal('revoke'), issuerSubject: groupAgent, grantId: groupUuid,
    expectedAuthorityEpoch: groupGeneration,
    expectedObjectGeneration: groupGeneration }, { additionalProperties: false }),
]);

const eligibleSetGrantResult = t.Object({
  profile: t.Literal('access-eligible-org-member-set-grant-change-v1'),
  action: t.Union([t.Literal('grant'), t.Literal('revoke')]),
  objectId: groupUuid, authorityEpoch: groupGeneration,
});

const eligibleSetGrantReadResult = t.Object({
  profile: t.Literal('access-eligible-org-member-set-grant-v1'),
  grantId: groupUuid, selectorId: groupUuid, selectorVersion: t.Literal('1'),
  recipientSubject: groupAgent, ownerSubject: groupAgent,
  active: t.Boolean(), generation: groupGeneration,
  validUntil: t.String({ format: 'date-time' }),
});

const selectedOrgMembershipCommon = {
  profile: t.Literal('access-selected-org-membership-change-v1'),
  ownerSubject: groupAgent, memberSubject: groupAgent,
  recipientSubject: groupAgent, selectorId: groupUuid,
  expectedSelectorVersion: t.Literal('1'), grantId: groupUuid,
  expectedGrantGeneration: groupGeneration,
  privateMembershipId: groupUuid,
  expectedPrivateMembershipGeneration: groupGeneration,
  expectedPrincipalEpoch: groupGeneration,
  expectedRecipientGeneration: groupGeneration,
  expectedOwnerGeneration: groupGeneration,
  expectedAuthorityEpoch: groupGeneration,
  expectedGeneration: groupGeneration, expectedPolicyRevision: groupGeneration,
};

const selectedOrgMembershipBody = t.Union([
  t.Object({ ...selectedOrgMembershipCommon, action: t.Literal('join'),
    termsRevision: t.String({ minLength: 1, maxLength: 128 }),
    consentReference: groupUuid }, { additionalProperties: false }),
  t.Object({ ...selectedOrgMembershipCommon, action: t.Literal('leave') },
    { additionalProperties: false }),
]);

const selectedOrgMembershipResult = t.Object({
  ...membershipChangeResult.properties,
  profile: t.Literal('access-selected-org-membership-change-v1'),
  kind: t.Literal('org'),
});

const membershipConsentBody = t.Object({
  profile: t.Literal('access-membership-consent-v1'),
  kind: t.Union([t.Literal('org'), t.Literal('realm')]),
  ownerSubject: groupAgent, memberSubject: groupAgent,
  expectedGeneration: groupGeneration, expectedPolicyRevision: groupGeneration,
  termsRevision: t.String({ minLength: 1, maxLength: 128 }),
}, { additionalProperties: false });

const membershipConsentResult = t.Object({
  profile: t.Literal('access-membership-consent-v1'),
  consentReference: groupUuid, nextGeneration: groupGeneration,
  expiresAt: t.String({ format: 'date-time' }), replayed: t.Boolean(),
});

const membershipConsentRevocationBody = t.Object({
  profile: t.Literal('access-membership-consent-revocation-v1'),
  consentReference: groupUuid,
}, { additionalProperties: false });

const membershipConsentRevocationResult = t.Object({
  profile: t.Literal('access-membership-consent-revocation-v1'),
  consentReference: groupUuid, revoked: t.Literal(true),
});

const privateMembershipConsentBody = t.Object({
  profile: t.Literal('access-private-membership-consent-v1'),
  kind: t.Union([t.Literal('org'), t.Literal('realm')]), ownerSubject: groupAgent,
  expectedGeneration: groupGeneration, expectedPolicyRevision: groupGeneration,
  termsRevision: t.String({ minLength: 1, maxLength: 128 }),
}, { additionalProperties: false });

const privateMembershipConsentResult = t.Object({
  profile: t.Literal('access-private-membership-consent-v1'),
  consentReference: groupUuid, nextGeneration: groupGeneration,
  expiresAt: t.String({ format: 'date-time' }), replayed: t.Boolean(),
});

const privateMembershipRevocationBody = t.Object({
  profile: t.Literal('access-private-membership-consent-revocation-v1'),
  consentReference: groupUuid,
}, { additionalProperties: false });

const privateMembershipRevocationResult = t.Object({
  profile: t.Literal('access-private-membership-consent-revocation-v1'),
  consentReference: groupUuid, revoked: t.Literal(true),
});

const privateMembershipCommon = { profile: t.Literal('access-private-membership-change-v1'),
  kind: t.Union([t.Literal('org'), t.Literal('realm')]), ownerSubject: groupAgent,
  expectedGeneration: groupGeneration, expectedPolicyRevision: groupGeneration };

const privateMembershipChangeBody = t.Union([
  t.Object({ ...privateMembershipCommon, action: t.Literal('join'),
    termsRevision: t.String({ minLength: 1, maxLength: 128 }), consentReference: groupUuid },
  { additionalProperties: false }),
  t.Object({ ...privateMembershipCommon, action: t.Literal('leave'),
    membershipId: groupUuid }, { additionalProperties: false }),
]);

const privateMembershipChangeResult = t.Object({
  profile: t.Literal('access-private-membership-change-v1'), membershipId: groupUuid,
  kind: t.Union([t.Literal('org'), t.Literal('realm')]), ownerSubject: groupAgent,
  action: t.Union([t.Literal('join'), t.Literal('leave')]),
  state: t.Union([t.Literal('joined'), t.Literal('left')]),
  generation: groupGeneration, policyRevision: groupGeneration,
  termsRevision: t.Nullable(t.String()), authorityEpoch: groupGeneration, replayed: t.Boolean(),
});

const privateMembershipPage = t.Object({
  profile: t.Literal('access-private-memberships-v1'),
  memberships: t.Array(t.Object({ membershipId: groupUuid,
    kind: t.Union([t.Literal('org'), t.Literal('realm')]), ownerSubject: groupAgent,
    state: t.Union([t.Literal('joined'), t.Literal('left')]),
    generation: groupGeneration, policyRevision: groupGeneration,
    termsRevision: t.Nullable(t.String()) })),
  nextCursor: t.Nullable(groupUuid),
});

const privateGroupMemberCommon = {
  profile: t.Literal('access-private-group-member-change-v1'), issuerSubject: groupAgent,
  expectedAuthorityEpoch: groupGeneration, expectedGroupGeneration: groupGeneration,
};

const privateGroupMemberChangeBody = t.Union([
  t.Object({ ...privateGroupMemberCommon, action: t.Literal('add-group-member'),
    memberId: groupUuid, groupId: groupUuid, membershipId: groupUuid,
    membershipGeneration: groupGeneration }, { additionalProperties: false }),
  t.Object({ ...privateGroupMemberCommon, action: t.Literal('revoke-group-member'),
    memberId: groupUuid, expectedObjectGeneration: groupGeneration },
  { additionalProperties: false }),
]);

const privateRoleBindingCommon = {
  profile: t.Literal('access-private-role-binding-change-v1'), issuerSubject: groupAgent,
  expectedAuthorityEpoch: groupGeneration,
};

const privateRoleBindingChangeBody = t.Union([
  t.Object({ ...privateRoleBindingCommon, action: t.Literal('bind-role'),
    bindingId: groupUuid, familyId: groupUuid, roleRevision: groupGeneration,
    membershipId: groupUuid, membershipGeneration: groupGeneration,
    validUntil: t.String({ format: 'date-time' }) }, { additionalProperties: false }),
  t.Object({ ...privateRoleBindingCommon, action: t.Literal('revoke-role'),
    bindingId: groupUuid, expectedObjectGeneration: groupGeneration },
  { additionalProperties: false }),
]);

const privateRecipientChangeResult = t.Object({
  profile: t.Literal('access-private-recipient-change-v1'),
  action: t.Union([t.Literal('add-group-member'), t.Literal('revoke-group-member'),
    t.Literal('bind-role'), t.Literal('revoke-role')]),
  objectId: groupUuid, authorityEpoch: groupGeneration,
  groupGeneration, replayed: t.Boolean(),
});

export function accessMembershipRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .post('/v1/me/membership-consents', {
      body: membershipConsentBody,
      response: { 200: membershipConsentResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['access:membership-consent']);
        if (!work.membershipConsents) return problem(503, 'membership_unavailable', 'Membership owner is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key || key.length > 128 || key.includes('\0')) {
          return problem(400, 'invalid_idempotency_key', 'A bounded idempotency key is required');
        }
        const result = await work.membershipConsents.issue({ ...body, principal,
          idempotencyKey: key, requestDigest: groupChangeIntentDigest(body) });
        return Response.json({ profile: 'access-membership-consent-v1', ...result },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/me/membership-consent-revocations', {
      body: membershipConsentRevocationBody,
      response: { 200: membershipConsentRevocationResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['access:membership-consent']);
        if (!work.membershipConsents) return problem(503, 'membership_unavailable', 'Membership owner is unavailable');
        await work.membershipConsents.revoke(principal, body.consentReference);
        return Response.json({ profile: 'access-membership-consent-revocation-v1',
          consentReference: body.consentReference, revoked: true as const },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/access/membership-changes', {
      body: membershipChangeBody,
      response: { 200: membershipChangeResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        let principal;
        let selfLeaveOnly = false;
        try { principal = await work.account.verify(request, ['access:manage']); }
        catch (error) {
          if (!(error instanceof AccountAssertionInsufficientScope)
            || body.kind !== 'realm' || body.action !== 'leave') throw error;
          principal = await work.account.verify(request, ['access:membership-consent']);
          selfLeaveOnly = true;
        }
        if (!work.memberships) return problem(503, 'membership_unavailable', 'Membership owner is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key || key.length > 128 || key.includes('\0')) {
          return problem(400, 'invalid_idempotency_key', 'A bounded idempotency key is required');
        }
        const result = await work.memberships.change({ ...body, principal, selfLeaveOnly, historyEnvironment: work.environment,
          idempotencyKey: key, requestDigest: groupChangeIntentDigest(body) });
        return Response.json({ profile: 'access-membership-change-v1', ...result },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/me/represented-org-membership-requests', {
      body: representedRequestBody,
      response: { 200: representedRequestResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['access:represent']);
        if (!work.representedMembershipAuthority) {
          return problem(503, 'membership_unavailable', 'Membership authority owner is unavailable');
        }
        const key = request.headers.get('idempotency-key');
        if (!key || key.length > 128 || key.includes('\0')) {
          return problem(400, 'invalid_idempotency_key', 'A bounded idempotency key is required');
        }
        const result = await work.representedMembershipAuthority.request(principal,
          body.requestId, body.actingSubject, body.ownerSubject,
          new Date(body.validUntil), key, groupChangeIntentDigest(body));
        return Response.json({ profile: 'access-represented-org-membership-request-v1', ...result },
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/access/represented-org-membership-requests/:requestId', {
      params: t.Object({ requestId: groupUuid }),
      query: t.Object({ issuerSubject: groupAgent }, { additionalProperties: false }),
      response: { 200: representedRequestResult, ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        const principal = await work.account.verify(request, ['access:representation-manage']);
        if (!work.representedMembershipAuthority) {
          return problem(503, 'membership_unavailable', 'Membership authority owner is unavailable');
        }
        const result = await work.representedMembershipAuthority.readRequest(principal,
          query.issuerSubject, params.requestId);
        return Response.json({ profile: 'access-represented-org-membership-request-v1', ...result },
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/access/represented-org-mandate-changes', {
      body: representedMandateBody,
      response: { 200: representedAuthorityResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['access:representation-manage']);
        if (!work.representedMembershipAuthority) {
          return problem(503, 'membership_unavailable', 'Membership authority owner is unavailable');
        }
        const key = request.headers.get('idempotency-key');
        if (!key || key.length > 128 || key.includes('\0')) {
          return problem(400, 'invalid_idempotency_key', 'A bounded idempotency key is required');
        }
        const context = { principal, issuerSubject: body.issuerSubject,
          ownerSubject: body.ownerSubject, expectedAuthorityEpoch: body.expectedAuthorityEpoch,
          idempotencyKey: key, requestDigest: groupChangeIntentDigest(body) };
        const authorityEpoch = body.action === 'accept'
          ? await work.representedMembershipAuthority.accept(context, body.requestId,
            body.representationId)
          : await work.representedMembershipAuthority.revokeMandate(context,
            body.representationId, body.expectedObjectGeneration);
        return Response.json({ profile: 'access-represented-org-mandate-change-v1',
          action: body.action, objectId: body.representationId, authorityEpoch },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/access/represented-org-grant-changes', {
      body: representedGrantBody,
      response: { 200: representedAuthorityResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['access:grant']);
        if (!work.representedMembershipAuthority) {
          return problem(503, 'membership_unavailable', 'Membership authority owner is unavailable');
        }
        const key = request.headers.get('idempotency-key');
        if (!key || key.length > 128 || key.includes('\0')) {
          return problem(400, 'invalid_idempotency_key', 'A bounded idempotency key is required');
        }
        const context = { principal, issuerSubject: body.issuerSubject,
          ownerSubject: body.ownerSubject, expectedAuthorityEpoch: body.expectedAuthorityEpoch,
          idempotencyKey: key, requestDigest: groupChangeIntentDigest(body) };
        const authorityEpoch = body.action === 'grant'
          ? await work.representedMembershipAuthority.grant(context, body.grantId,
            body.recipientSubject, new Date(body.validUntil))
          : await work.representedMembershipAuthority.revokeGrant(context, body.grantId,
            body.expectedObjectGeneration);
        return Response.json({ profile: 'access-represented-org-grant-change-v1',
          action: body.action, objectId: body.grantId, authorityEpoch },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/access/represented-org-membership-changes', {
      body: representedMembershipBody,
      response: { 200: representedMembershipResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['access:manage']);
        if (!work.memberships) return problem(503, 'membership_unavailable', 'Membership owner is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key || key.length > 128 || key.includes('\0')) {
          return problem(400, 'invalid_idempotency_key', 'A bounded idempotency key is required');
        }
        const represented = { actingSubject: body.actingSubject,
          representationId: body.representationId,
          expectedRepresentationGeneration: body.expectedRepresentationGeneration,
          grantId: body.grantId, expectedGrantGeneration: body.expectedGrantGeneration,
          expectedPrincipalEpoch: body.expectedPrincipalEpoch,
          expectedActingGeneration: body.expectedActingGeneration,
          expectedOwnerGeneration: body.expectedOwnerGeneration,
          expectedAuthorityEpoch: body.expectedAuthorityEpoch };
        const result = await work.memberships.change({ ...body, kind: 'org', principal,
          represented, idempotencyKey: key, requestDigest: groupChangeIntentDigest(body) });
        return Response.json({ profile: 'access-represented-org-membership-change-v1',
          ...result, actingSubject: body.actingSubject },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/access/eligible-org-member-set-grant-changes', {
      body: eligibleSetGrantBody,
      response: { 200: eligibleSetGrantResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['access:grant']);
        if (!work.eligibleOrgMemberSet) {
          return problem(503, 'membership_unavailable', 'Eligible set owner is unavailable');
        }
        const key = request.headers.get('idempotency-key');
        if (!key || key.length > 128 || key.includes('\0')) {
          return problem(400, 'invalid_idempotency_key', 'A bounded idempotency key is required');
        }
        const context = { principal, issuerSubject: body.issuerSubject,
          expectedAuthorityEpoch: body.expectedAuthorityEpoch,
          idempotencyKey: key, requestDigest: groupChangeIntentDigest(body) };
        const authorityEpoch = body.action === 'grant'
          ? await work.eligibleOrgMemberSet.grant(context, body.grantId,
            body.selectorId, body.recipientSubject, new Date(body.validUntil))
          : await work.eligibleOrgMemberSet.revoke(context, body.grantId,
            body.expectedObjectGeneration);
        return Response.json({ profile: 'access-eligible-org-member-set-grant-change-v1',
          action: body.action, objectId: body.grantId, authorityEpoch },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/access/eligible-org-member-set-grants/:grantId', {
      params: t.Object({ grantId: groupUuid }),
      query: t.Object({ issuerSubject: groupAgent }, { additionalProperties: false }),
      response: { 200: eligibleSetGrantReadResult, ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        const principal = await work.account.verify(request, ['access:grant']);
        if (!work.eligibleOrgMemberSet) {
          return problem(503, 'membership_unavailable', 'Eligible set owner is unavailable');
        }
        const result = await work.eligibleOrgMemberSet.read(principal,
          query.issuerSubject, params.grantId);
        return Response.json({ profile: 'access-eligible-org-member-set-grant-v1', ...result },
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/access/selected-org-membership-changes', {
      body: selectedOrgMembershipBody,
      response: { 200: selectedOrgMembershipResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['access:manage']);
        if (!work.memberships) return problem(503, 'membership_unavailable', 'Membership owner is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key || key.length > 128 || key.includes('\0')) {
          return problem(400, 'invalid_idempotency_key', 'A bounded idempotency key is required');
        }
        const selected = { selectorId: body.selectorId,
          expectedSelectorVersion: body.expectedSelectorVersion,
          grantId: body.grantId, expectedGrantGeneration: body.expectedGrantGeneration,
          privateMembershipId: body.privateMembershipId,
          expectedPrivateMembershipGeneration: body.expectedPrivateMembershipGeneration,
          expectedPrincipalEpoch: body.expectedPrincipalEpoch,
          recipientSubject: body.recipientSubject,
          expectedRecipientGeneration: body.expectedRecipientGeneration,
          expectedOwnerGeneration: body.expectedOwnerGeneration,
          expectedAuthorityEpoch: body.expectedAuthorityEpoch };
        const result = await work.memberships.change({ ...body, kind: 'org', principal,
          selected, idempotencyKey: key, requestDigest: groupChangeIntentDigest(body) });
        return Response.json({ profile: 'access-selected-org-membership-change-v1', ...result },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/me/selected-org-membership-changes', {
      query: t.Object({ idempotencyKey: t.String({ minLength: 1, maxLength: 128 }) },
        { additionalProperties: false }),
      response: { 200: selectedOrgMembershipResult, ...authorizedReadProblems },
    }, async ({ request, query }) => {
      try {
        const principal = await work.account.verify(request, ['access:manage']);
        if (!work.memberships) return problem(503, 'membership_unavailable', 'Membership owner is unavailable');
        const result = await work.memberships.readSelected(principal, query.idempotencyKey);
        return Response.json({ profile: 'access-selected-org-membership-change-v1', ...result },
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/me/private-membership-consents', {
      body: privateMembershipConsentBody,
      response: { 200: privateMembershipConsentResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['access:membership-consent']);
        if (!work.privateMemberships) return problem(503, 'membership_unavailable', 'Membership owner is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key || key.length > 128 || key.includes('\0')) {
          return problem(400, 'invalid_idempotency_key', 'A bounded idempotency key is required');
        }
        const result = await work.privateMemberships.issue({ ...body, principal,
          idempotencyKey: key, requestDigest: groupChangeIntentDigest(body) });
        return Response.json({ profile: 'access-private-membership-consent-v1', ...result },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/me/private-membership-consent-revocations', {
      body: privateMembershipRevocationBody,
      response: { 200: privateMembershipRevocationResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['access:membership-consent']);
        if (!work.privateMemberships) return problem(503, 'membership_unavailable', 'Membership owner is unavailable');
        await work.privateMemberships.revoke(principal, body.consentReference);
        return Response.json({ profile: 'access-private-membership-consent-revocation-v1',
          consentReference: body.consentReference, revoked: true as const },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/me/private-memberships', {
      query: t.Object({ after: t.Optional(groupUuid),
        limit: t.Optional(t.String({ pattern: '^([1-9]|[1-4][0-9]|50)$' })) },
      { additionalProperties: false }),
      response: { 200: privateMembershipPage, ...writeProblems },
    }, async ({ request, query }) => {
      try {
        const principal = await work.account.verify(request, ['access:membership-consent']);
        if (!work.privateMemberships) return problem(503, 'membership_unavailable', 'Membership owner is unavailable');
        const result = await work.privateMemberships.readMine(principal,
          query.after ?? null, Number(query.limit ?? '50'));
        return Response.json({ profile: 'access-private-memberships-v1', ...result },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/access/private-membership-changes', {
      body: privateMembershipChangeBody,
      response: { 200: privateMembershipChangeResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        let principal;
        let selfLeaveOnly = false;
        try { principal = await work.account.verify(request, ['access:manage']); }
        catch (error) {
          if (!(error instanceof AccountAssertionInsufficientScope) || body.action !== 'leave') throw error;
          principal = await work.account.verify(request, ['access:membership-consent']);
          selfLeaveOnly = true;
        }
        if (!work.privateMemberships) return problem(503, 'membership_unavailable', 'Membership owner is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key || key.length > 128 || key.includes('\0')) {
          return problem(400, 'invalid_idempotency_key', 'A bounded idempotency key is required');
        }
        const result = await work.privateMemberships.change({ ...body, principal, selfLeaveOnly, historyEnvironment: work.environment,
          idempotencyKey: key, requestDigest: groupChangeIntentDigest(body) });
        return Response.json({ profile: 'access-private-membership-change-v1', ...result },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/access/private-group-member-changes', {
      body: privateGroupMemberChangeBody,
      response: { 200: privateRecipientChangeResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['access:manage']);
        if (!work.privateRecipients) return problem(503, 'private_recipient_unavailable',
          'Private recipient owner is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key || key.length > 128 || key.includes('\0')) {
          return problem(400, 'invalid_idempotency_key', 'A bounded idempotency key is required');
        }
        const result = await work.privateRecipients.change({ ...body, principal,
          idempotencyKey: key, requestDigest: groupChangeIntentDigest(body) });
        return Response.json({ profile: 'access-private-recipient-change-v1', ...result },
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/access/private-role-binding-changes', {
      body: privateRoleBindingChangeBody,
      response: { 200: privateRecipientChangeResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['access:role']);
        if (!work.privateRecipients) return problem(503, 'private_recipient_unavailable',
          'Private recipient owner is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key || key.length > 128 || key.includes('\0')) {
          return problem(400, 'invalid_idempotency_key', 'A bounded idempotency key is required');
        }
        const change = body.action === 'bind-role'
          ? { ...body, validUntil: new Date(body.validUntil) } : body;
        const result = await work.privateRecipients.change({ ...change, principal,
          idempotencyKey: key, requestDigest: groupChangeIntentDigest(body) });
        return Response.json({ profile: 'access-private-recipient-change-v1', ...result },
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    });
}

export const openApiOperations = {
  '/v1/access/private-role-binding-changes': { post: { exposure: 'platform:organization-authority' } },
  '/v1/access/private-group-member-changes': { post: { exposure: 'platform:organization-authority' } },
  '/v1/access/private-membership-changes': { post: { exposure: 'platform:organization-authority' } },
  '/v1/me/private-memberships': { get: { exposure: 'platform:organization-authority' } },
  '/v1/me/private-membership-consent-revocations': { post: { exposure: 'platform:organization-authority' } },
  '/v1/me/private-membership-consents': { post: { exposure: 'platform:organization-authority' } },
  '/v1/me/selected-org-membership-changes': { get: { exposure: 'platform:organization-authority' } },
  '/v1/access/selected-org-membership-changes': { post: { exposure: 'platform:organization-authority' } },
  '/v1/access/eligible-org-member-set-grants/{grantId}': { get: { exposure: 'platform:organization-authority' } },
  '/v1/access/eligible-org-member-set-grant-changes': { post: { exposure: 'platform:organization-authority' } },
  '/v1/access/represented-org-membership-changes': { post: { exposure: 'platform:organization-authority' } },
  '/v1/access/represented-org-grant-changes': { post: { exposure: 'platform:organization-authority' } },
  '/v1/access/represented-org-mandate-changes': { post: { exposure: 'platform:organization-authority' } },
  '/v1/access/represented-org-membership-requests/{requestId}': { get: { exposure: 'platform:organization-authority' } },
  '/v1/me/represented-org-membership-requests': { post: { exposure: 'platform:organization-authority' } },
  '/v1/access/membership-changes': { post: { exposure: 'public' } },
  '/v1/me/membership-consent-revocations': { post: { exposure: 'public' } },
  '/v1/me/membership-consents': { post: { exposure: 'public' } },
} as const;
