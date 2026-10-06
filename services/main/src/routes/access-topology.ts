import { Elysia, t, type AnySchema, type UnwrapSchema } from 'elysia';
import { AccountAssertionDenied } from '../modules/account/verify-assertion.ts';
import type { VerifiedPrincipal } from '../modules/access/admission.ts';
import type { AuthorityControl } from '../modules/access/grants.ts';
import { groupChangeIntentDigest } from '../modules/access/group-intent.ts';
import { InvitationExpired } from '../modules/access/invitation.ts';
import { PolicyUnavailable } from '../modules/access/policy-errors.ts';
import { AGENT_ACCESS_COST } from '../modules/access/invitation-schema.ts';
import { problemResult } from '../api-contract.ts';
import { ControlConflict, ControlDenied, ControlInvalid, ControlStale, ControlUnavailable,
  type ControlReceipt } from '../modules/access/topology-control.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { groupAgent, groupGeneration, groupUuid } from './shared.ts';

const instant = t.String({ format: 'date-time' });
const digest = t.String({ pattern: '^[0-9a-f]{64}$' });
const action = t.String({ pattern: '^[a-z][a-z0-9.-]{0,127}$' });
const ceiling = t.Object({ actions: t.Array(action, { minItems: 1, maxItems: 32 }),
  maxRepresentatives: t.Integer({ minimum: 1, maximum: 256 }),
  maxMandateDays: t.Integer({ minimum: 1, maximum: 366 }) }, { additionalProperties: false });
const result = t.Object({ replayed: t.Optional(t.Boolean()) }, { additionalProperties: true });
const noStore = { headers: { 'cache-control': 'no-store' } };

export const openApiOperations = {
  '/v1/access/delegated-grant-changes': { post: { exposure: 'platform:organization-authority', bearer: true, idempotencyKey: true } },
  '/v1/me/authority-admissions/{admissionId}/consumption': { get: { exposure: 'platform:organization-authority', bearer: true } },
  '/v1/agents/{id}/access': { get: { exposure: 'public', bearer: true } },
  '/v1/me/agent-invitations': { get: { exposure: 'public', bearer: true } },
  '/v1/agents/invitations': { post: { exposure: 'public', bearer: true, idempotencyKey: true } },
  '/v1/agents/invitations/{invitationId}': { get: { exposure: 'public', bearer: true } },
  '/v1/agents/invitation-acceptances': { post: { exposure: 'public', bearer: true, idempotencyKey: true } },
  '/v1/agents/invitation-revocations': { post: { exposure: 'public', bearer: true, idempotencyKey: true } },
  '/v1/agents/controller-changes': { post: { exposure: 'public', bearer: true, idempotencyKey: true } },
  '/v1/agents/recoveries': { post: { exposure: 'public' } },
  '/v1/agents/control': { get: { exposure: 'public' }, post: { exposure: 'public' } },
  '/v1/access/grants/{grantId}/lineage': { get: { exposure: 'public' } },
  '/v1/access/automation-installations': { post: { exposure: 'platform:agent-mode' } },
  '/v1/me/automation-enrollments': { post: { exposure: 'platform:agent-mode' } },
  '/v1/access/protected-change-activations': { post: { exposure: 'platform:organization-authority' } },
  '/v1/access/protected-change-approvals': { post: { exposure: 'platform:organization-authority' } },
  '/v1/access/protected-change-proposals/{proposalId}': { get: { exposure: 'platform:organization-authority' } },
  '/v1/access/protected-change-proposals': { post: { exposure: 'platform:organization-authority' } },
  '/v1/access/protected-sets': { post: { exposure: 'platform:organization-authority' } },
  '/v1/access/representative-roster-changes': { post: { exposure: 'platform:organization-authority' } },
  '/v1/access/representative-policies/{policyId}': { get: { exposure: 'platform:organization-authority' } },
  '/v1/access/representative-policy-changes': { post: { exposure: 'platform:organization-authority' } },
  '/v1/me/authority-admissions/{admissionId}/checks': { post: { exposure: 'platform:organization-authority' } },
  '/v1/me/authority-admissions': { post: { exposure: 'platform:organization-authority' } },
  '/v1/access/representation-edges/{edgeId}': { get: { exposure: 'platform:organization-authority' } },
  '/v1/access/representation-edge-changes': { post: { exposure: 'platform:organization-authority' } },
} as const;

const edgeChangeBody = t.Union([
  t.Object({ profile: t.Literal('access-representation-edge-change-v1'), action: t.Literal('create'),
    edgeId: groupUuid, representativeSubject: groupAgent, representedSubject: groupAgent,
    edgeAction: action, maxPathEdges: t.Integer({ minimum: 1, maximum: 8 }), validUntil: instant,
    expectedTopologyEpoch: groupGeneration }, { additionalProperties: false }),
  t.Object({ profile: t.Literal('access-representation-edge-change-v1'), action: t.Literal('revoke'),
    edgeId: groupUuid, representedSubject: groupAgent, expectedObjectGeneration: groupGeneration,
    expectedTopologyEpoch: groupGeneration }, { additionalProperties: false }),
]);
const admissionBody = t.Object({ profile: t.Literal('access-compound-admission-v1'),
  admissionId: groupUuid, actingSubject: groupAgent,
  command: t.String({ pattern: '^[a-z][a-z0-9.+-]{0,127}$' }),
  obligations: t.Array(t.Object({ obligation: action, representationId: groupUuid,
    edgeIds: t.Array(groupUuid, { maxItems: 8 }), grantId: groupUuid },
  { additionalProperties: false }), { minItems: 1, maxItems: 8 }) },
{ additionalProperties: false });
const policyBody = t.Union([
  t.Object({ profile: t.Literal('access-representative-policy-change-v1'), action: t.Literal('create'),
    policyId: groupUuid, institutionSubject: groupAgent, approvalSubject: groupAgent, ceiling },
  { additionalProperties: false }),
  t.Object({ profile: t.Literal('access-representative-policy-change-v1'), action: t.Literal('revise'),
    policyId: groupUuid, institutionSubject: groupAgent, expectedGeneration: groupGeneration,
    ceiling }, { additionalProperties: false }),
]);
const rosterBody = t.Object({ profile: t.Literal('access-representative-roster-change-v1'),
  action: t.Literal('accept'), policyId: groupUuid, institutionSubject: groupAgent,
  requestId: groupUuid, representationId: groupUuid }, { additionalProperties: false });
const protectBody = t.Object({ profile: t.Literal('access-protected-set-v1'),
  objectKind: t.Union([t.Literal('group'), t.Literal('role-family')]), objectId: groupUuid,
  issuerSubject: groupAgent, approvalSubject: groupAgent,
  requiredApprovals: t.Integer({ minimum: 1, maximum: 8 }) }, { additionalProperties: false });
const proposalChange = t.Union([
  t.Object(
    {
      kind: t.Literal('agent-controller'),
      recipientSubject: groupAgent,
      representationId: groupUuid,
    },
    { additionalProperties: false },
  ),
  t.Object({ kind: t.Literal('group-member'), groupId: groupUuid, memberId: groupUuid,
    agentSubject: groupAgent }, { additionalProperties: false }),
  t.Object({ kind: t.Literal('group-parent'), groupId: groupUuid, parentId: t.Nullable(groupUuid),
    expectedObjectGeneration: groupGeneration }, { additionalProperties: false }),
  t.Object({ kind: t.Literal('role-revision'), familyId: groupUuid,
    expectedHeadRevision: groupGeneration,
    permissions: t.Array(t.Literal('work.create'), { maxItems: 1 }),
    approvalSubject: t.Optional(groupAgent) }, { additionalProperties: false }),
  t.Object({ kind: t.Literal('automation-install'), installationId: groupUuid,
    enrollmentId: groupUuid, approvalSubject: groupAgent }, { additionalProperties: false }),
  t.Object({ kind: t.Literal('representative-policy'), policyId: groupUuid,
    expectedGeneration: groupGeneration, ceiling }, { additionalProperties: false }),
]);
const proposalBody = t.Object({ profile: t.Literal('access-protected-change-v1'),
  proposalId: groupUuid, issuerSubject: groupAgent, expectedAuthorityEpoch: groupGeneration,
  change: proposalChange }, { additionalProperties: false });
const approvalBody = t.Object({ profile: t.Literal('access-protected-change-approval-v1'),
  proposalId: groupUuid, approverSubject: groupAgent, changeDigest: digest },
{ additionalProperties: false });
const activationBody = t.Object({ profile: t.Literal('access-protected-change-activation-v1'),
  proposalId: groupUuid }, { additionalProperties: false });
const enrollmentBody = t.Object({ profile: t.Literal('access-automation-enrollment-v1'),
  enrollmentId: groupUuid, ownerSubject: groupAgent,
  actions: t.Array(action, { minItems: 1, maxItems: 32 }), validUntil: instant },
{ additionalProperties: false });
const installationBody = t.Object({ profile: t.Literal('access-automation-installation-v1'),
  installationId: groupUuid, ownerSubject: groupAgent, enrollmentId: groupUuid },
{ additionalProperties: false });
const delegatedGrantBody = t.Union([t.Object({ profile: t.Literal('access-delegated-grant-change-v1'),
  action: t.Literal('create'), issuerSubject: groupAgent, expectedAuthorityEpoch: groupGeneration,
  grantId: groupUuid, recipientSubject: groupAgent, validUntil: instant,
  lifetime: t.Union([t.Literal('institutional'), t.Literal('dependent')]),
  upstreamGrantId: t.Optional(groupUuid),
  redelegationDepth: t.Integer({ minimum: 0, maximum: 8 }),
  representativePolicyId: t.Optional(groupUuid) }, { additionalProperties: false }),
  t.Object({ profile: t.Literal('access-delegated-grant-change-v1'),
    action: t.Literal('revoke'), issuerSubject: groupAgent,
    expectedAuthorityEpoch: groupGeneration, grantId: groupUuid,
    expectedObjectGeneration: groupGeneration, selectedAdmissionId: groupUuid },
  { additionalProperties: false })]);
const controlBody = t.Object({ profile: t.Literal('access-agent-control-v1'),
  subjectId: groupAgent, recoverySubject: groupAgent,
  recoveryApprovals: t.Integer({ minimum: 1, maximum: 8 }),
  recoveryDelaySeconds: t.Integer({ minimum: 0, maximum: 2_592_000 }),
  minControllers: t.Integer({ minimum: 1, maximum: 16 }),
  maxControllers: t.Integer({ minimum: 1, maximum: 16 }) }, { additionalProperties: false });
const controllerBody = t.Object(
  {
    profile: t.Literal('access-agent-controller-change-v1'),
    action: t.Literal('remove'),
    subjectId: groupAgent,
    representationId: groupUuid,
    expectedGeneration: groupGeneration,
    expectedAuthorityEpoch: t.Optional(groupGeneration),
  },
  { additionalProperties: false },
);
const recoveryBody = t.Object({ profile: t.Literal('access-agent-recovery-v1'),
  recoveryId: groupUuid, subjectId: groupAgent,
  reason: t.Union([t.Literal('last-controller-lost'), t.Literal('controller-compromised')]),
  expectedControlGeneration: groupGeneration }, { additionalProperties: false });
const invitationBody = t.Object(
  {
    profile: t.Literal('access-agent-invitation-v1'),
    invitationId: groupUuid,
    issuerSubject: groupAgent,
    recipientSubject: groupAgent,
    grantValidUntil: t.Optional(instant),
    offer: t.Optional(t.Union([t.Literal('control'), t.Literal('represent'), t.Literal('manage')])),
    actions: t.Optional(
      t.Array(action, { minItems: 1, maxItems: AGENT_ACCESS_COST.actions, uniqueItems: true }),
    ),
    scopeId: t.Optional(t.String({ minLength: 1, maxLength: 256 })),
    expiresAt: t.Optional(instant),
    issuerLifetime: t.Union([t.Literal('institutional'), t.Literal('operator-dependent')]),
    expectedAuthorityEpoch: groupGeneration,
  },
  { additionalProperties: false },
);
const acceptanceBody = t.Object(
  {
    profile: t.Literal('access-agent-invitation-acceptance-v1'),
    invitationId: groupUuid,
    grantId: t.Optional(groupUuid),
    edgeId: t.Optional(groupUuid),
    representationId: t.Optional(groupUuid),
    expectedAuthorityEpoch: t.Optional(groupGeneration),
  },
  { additionalProperties: false },
);
const invitationRevocationBody = t.Object(
  {
    profile: t.Literal('access-agent-invitation-revocation-v1'),
    invitationId: groupUuid,
    expectedAuthorityEpoch: t.Optional(groupGeneration),
  },
  { additionalProperties: false },
);

function controlError(error: unknown): Response {
  if (error instanceof InvitationExpired) return problem(410, 'invitation_expired', error.message);
  if (error instanceof ControlInvalid) return problem(400, 'invalid_request', error.message);
  if (error instanceof ControlDenied) return problem(403, 'authority_denied', error.message);
  if (error instanceof ControlStale) return problem(409, 'authority_stale', error.message);
  if (error instanceof ControlConflict) return problem(409, 'authority_conflict', error.message);
  if (error instanceof ControlUnavailable || error instanceof PolicyUnavailable) {
    return problem(503, 'authority_unavailable', error.message, { 'retry-after': '1' });
  }
  return commandError(error);
}

function controlReceipt(request: Request, body: Record<string, unknown>): ControlReceipt {
  const key = request.headers.get('idempotency-key');
  if (!key || key.length > 128 || key.includes('\0')) {
    throw new ControlInvalid('a bounded idempotency key is required');
  }
  return { idempotencyKey: key, requestDigest: groupChangeIntentDigest(body) };
}

/** Authority-control routes (G-047): representation topology and its bounded
 * use, protected changes, representative policies, delegated grants, Agent
 * control/recovery and invitations. The owners share the grant owner's pool. */
export function accessTopologyRoutes(work: MainWorkDependencies) {
  const owner = (): AuthorityControl => {
    if (!work.grants) throw new ControlUnavailable('authority owner is unavailable');
    return work.grants.control;
  };
  const verifyAny = async (request: Request, scopes: string[]): Promise<VerifiedPrincipal> => {
    let denied: unknown;
    for (const scope of scopes) {
      try { return await work.account.verify(request, [scope]); } catch (error) {
        if (!(error instanceof AccountAssertionDenied)) throw error;
        denied = error;
      }
    }
    throw denied;
  };
  const write = <S extends AnySchema>(_schema: S, scope: string,
    run: (principal: VerifiedPrincipal, receipt: ControlReceipt,
      body: UnwrapSchema<S>) => Promise<unknown>) =>
    async ({ request, body }: { request: Request; body: UnwrapSchema<S> }) => {
      try {
        const principal = await work.account.verify(request, [scope]);
        const value = await run(principal,
          controlReceipt(request, body as Record<string, unknown>), body);
        return Response.json(value, noStore);
      } catch (error) { return controlError(error); }
    };
  const read = (response: Promise<unknown>) => response
    .then(value => Response.json(value, noStore), controlError);
  return new Elysia({ name: 'access-topology-routes' })
    .post('/v1/access/representation-edge-changes', {
      body: edgeChangeBody, response: { 200: result, ...writeProblems },
    }, write(edgeChangeBody, 'access:representation-manage', (principal, receipt, body) =>
      owner().topology.changeEdge(principal, receipt, body.action === 'create'
        ? { ...body, validUntil: new Date(body.validUntil) } : body)))
    .get('/v1/access/representation-edges/:edgeId', {
      params: t.Object({ edgeId: groupUuid }),
      query: t.Object({ representedSubject: groupAgent }),
      response: { 200: result, ...authorizedReadProblems },
    }, async ({ request, params, query }) => read(work.account
      .verify(request, ['access:representation-manage'])
      .then(principal => owner().topology.readEdge(principal, params.edgeId,
        query.representedSubject))))
    .post('/v1/me/authority-admissions', {
      body: admissionBody, response: { 200: result, ...writeProblems },
    }, write(admissionBody, 'access:represent', (principal, receipt, body) =>
      owner().topology.registerAdmission(principal, receipt, body)))
    .post('/v1/me/authority-admissions/:admissionId/checks', {
      params: t.Object({ admissionId: groupUuid }), response: { 200: result, ...writeProblems },
    }, async ({ request, params }) => read(work.account.verify(request, ['access:represent'])
      .then(principal => owner().topology.recheckAdmission(principal, params.admissionId))))
    .post('/v1/access/representative-policy-changes', {
      body: policyBody, response: { 200: result, ...writeProblems },
    }, write(policyBody, 'access:representation-manage', (principal, receipt, body) =>
      body.action === 'create' ? owner().policies.create(principal, receipt, body)
        : owner().policies.revise(principal, receipt, body)))
    .get('/v1/access/representative-policies/:policyId', {
      params: t.Object({ policyId: groupUuid }),
      query: t.Object({ institutionSubject: groupAgent }),
      response: { 200: result, ...authorizedReadProblems },
    }, async ({ request, params, query }) => read(work.account
      .verify(request, ['access:representation-manage'])
      .then(principal => owner().policies.read(principal, params.policyId,
        query.institutionSubject))))
    .post('/v1/access/representative-roster-changes', {
      body: rosterBody, response: { 200: result, ...writeProblems },
    }, write(rosterBody, 'access:representation-manage', (principal, receipt, body) =>
      owner().policies.acceptRoster(principal, receipt, body)))
    .post('/v1/access/protected-sets', {
      body: protectBody, response: { 200: result, ...writeProblems },
    }, write(protectBody, 'access:manage', (principal, receipt, body) =>
      owner().protectedChanges.protect(principal, receipt, body)))
    .post('/v1/access/protected-change-proposals', {
      body: proposalBody, response: { 200: result, ...writeProblems },
    }, write(proposalBody, 'access:manage', (principal, receipt, body) =>
      owner().protectedChanges.propose(principal, receipt, body)))
    .get('/v1/access/protected-change-proposals/:proposalId', {
      params: t.Object({ proposalId: groupUuid }),
      response: { 200: result, ...authorizedReadProblems },
    }, async ({ request, params }) => read(verifyAny(request,
      ['access:manage', 'access:approve', 'access:represent'])
      .then(principal => owner().protectedChanges.read(principal, params.proposalId))))
    .post('/v1/access/protected-change-approvals', {
      body: approvalBody, response: { 200: result, ...writeProblems },
    }, write(approvalBody, 'access:approve', (principal, receipt, body) =>
      owner().protectedChanges.approve(principal, receipt, body)))
    .post('/v1/access/protected-change-activations', {
      body: activationBody, response: { 200: result, ...writeProblems },
    }, write(activationBody, 'access:manage', (principal, receipt, body) =>
      owner().protectedChanges.activate(principal, receipt, body.proposalId)))
    .post('/v1/me/automation-enrollments', {
      body: enrollmentBody, response: { 200: result, ...writeProblems },
    }, write(enrollmentBody, 'access:represent', (principal, receipt, body) =>
      owner().protectedChanges.enroll(principal, receipt,
        { ...body, validUntil: new Date(body.validUntil) })))
    .post('/v1/access/automation-installations', {
      body: installationBody, response: { 200: result, ...writeProblems },
    }, write(installationBody, 'access:manage', (principal, receipt, body) =>
      owner().protectedChanges.installAutomation(principal, receipt, body)))
    .post('/v1/access/delegated-grant-changes', {
      body: delegatedGrantBody, response: { 200: result, ...writeProblems },
    }, write(delegatedGrantBody, 'access:grant', async (principal, receipt, body) => {
      if (!work.grants) throw new ControlUnavailable('grant owner is unavailable');
      const context = { principal, issuerSubject: body.issuerSubject,
        expectedAuthorityEpoch: body.expectedAuthorityEpoch };
      const authorityEpoch = body.action === 'create'
        ? await work.grants.createDelegated(context, body.grantId, body.recipientSubject,
          new Date(body.validUntil), receipt,
          { lifetime: body.lifetime, redelegationDepth: body.redelegationDepth,
            upstreamGrantId: body.upstreamGrantId,
            representativePolicyId: body.representativePolicyId })
        : await work.grants.revoke({ ...context, selectedAdmissionId: body.selectedAdmissionId },
          body.grantId, body.expectedObjectGeneration, receipt);
      return { profile: body.profile, grantId: body.grantId, authorityEpoch };
    }))
    .get('/v1/me/authority-admissions/:admissionId/consumption', {
      params: t.Object({ admissionId: groupUuid }),
      response: { 200: result, ...authorizedReadProblems },
    }, async ({ request, params }) => read(work.account.verify(request, ['access:grant'])
      .then(principal => {
        if (!work.grants) throw new ControlUnavailable('grant owner is unavailable');
        return work.grants.readAdmissionConsumption(principal, params.admissionId);
      })))
    .get('/v1/access/grants/:grantId/lineage', {
      params: t.Object({ grantId: groupUuid }), query: t.Object({ issuerSubject: groupAgent }),
      response: { 200: result, ...authorizedReadProblems },
    }, async ({ request, params, query }) => read(work.account.verify(request, ['access:grant'])
      .then(principal => {
        if (!work.grants) throw new ControlUnavailable('grant owner is unavailable');
        return work.grants.readLineage(principal, query.issuerSubject, params.grantId);
      })))
    .post('/v1/agents/control', {
      body: controlBody, response: { 200: result, ...writeProblems },
    }, write(controlBody, 'access:manage', (principal, receipt, body) =>
      owner().agentControl.configure(principal, receipt, body)))
    .get('/v1/agents/control', {
      query: t.Object({ subjectId: groupAgent }),
      response: { 200: result, ...authorizedReadProblems },
    }, async ({ request, query }) => read(work.account.verify(request, ['access:manage'])
      .then(principal => owner().agentControl.read(principal, query.subjectId))))
    .post('/v1/agents/controller-changes', {
      body: controllerBody, response: { 200: result, ...writeProblems },
    }, write(controllerBody, 'access:manage', (principal, receipt, body) =>
      owner().agentControl.removeController(principal, receipt, body)))
    .post('/v1/agents/recoveries', {
      body: recoveryBody, response: { 200: result, ...writeProblems },
    }, write(recoveryBody, 'access:represent', (principal, receipt, body) =>
      owner().agentControl.requestRecovery(principal, receipt, body)))
    .post(
      '/v1/agents/invitations',
      {
        body: invitationBody,
        response: { 200: result, ...writeProblems },
      },
      write(invitationBody, 'access:grant', (principal, receipt, body) =>
      owner().invitations.issue(principal, receipt, {
          ...body,
          grantValidUntil: body.grantValidUntil ? new Date(body.grantValidUntil) : undefined,
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
        }),
      ),
    )
    .get(
      '/v1/agents/invitations/:invitationId',
      {
        params: t.Object({ invitationId: groupUuid }),
        response: { 200: result, ...authorizedReadProblems },
      },
      async ({ request, params }) => read(verifyAny(request, ['access:grant', 'access:represent'])
      .then(principal => owner().invitations.read(principal, params.invitationId))),
    )
    .post(
      '/v1/agents/invitation-acceptances',
      {
        body: acceptanceBody,
        response: { 200: result, ...writeProblems, 410: problemResult(410) },
      }, write(acceptanceBody, 'access:represent', (principal, receipt, body) =>
      owner().invitations.accept(principal, receipt, body)),
    )
    .post(
      '/v1/agents/invitation-revocations',
      {
        body: invitationRevocationBody,
        response: { 200: result, ...writeProblems },
      },
      write(invitationRevocationBody, 'access:grant', (principal, receipt, body) =>
      owner().invitations.revoke(
          principal,
          receipt,
          body.invitationId,
          body.expectedAuthorityEpoch,
        ),
      ),
    )
    .get(
      '/v1/agents/:id/access',
      {
        params: t.Object({ id: groupUuid }),
        query: t.Object({ after: t.Optional(groupUuid) }),
        response: { 200: result, ...authorizedReadProblems },
      },
      async ({ request, params, query }) =>
        read(work.account.verify(request, ['access:manage'])
            .then((principal) =>
      owner().invitations.access(
                principal,
                `https://rezics.com/id/${params.id}`,
                query.after,
              ),
            ),
        ),
    )
    .get(
      '/v1/me/agent-invitations',
      {
        query: t.Object({ after: t.Optional(groupUuid) }),
        response: { 200: result, ...authorizedReadProblems },
      },
      async ({ request, query }) =>
        read(work.account.verify(request, ['access:represent'])
            .then((principal) =>
      owner().invitations.addressed(principal, query.after)),
        ),
    );
}
