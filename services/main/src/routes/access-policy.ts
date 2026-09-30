import { Elysia, t } from 'elysia';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import { groupChangeIntentDigest } from '../modules/access/group-intent.ts';
import {
  PolicyConflict, PolicyDenied, PolicyInvalid, PolicyNotFound, PolicyReferenceNotAdmitted,
  PolicyStale, PolicyUnavailable, ProofHandleMismatch, ProofHandleStale,
} from '../modules/access/policy-errors.ts';
import { POLICY_DECISION_ACTIONS } from '../modules/access/policy-decisions.ts';
import type { AccessPolicyOwner } from '../modules/access/policy-owner.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { groupAgent, groupGeneration, groupUuid } from './shared.ts';

declare module './dependencies.ts' {
  interface MainWorkDependencies {
    accessPolicy?: AccessPolicyOwner;
  }
}

const scopeId = t.String({ minLength: 1, maxLength: 256 });
const action = t.String({ pattern: '^[a-z][a-z0-9.-]{0,127}$' });
const condition = t.Object({ op: t.String() }, { additionalProperties: true });
const mandatoryRule = t.Object({ ruleId: groupUuid, actions: t.Array(action, { minItems: 1, maxItems: 16 }),
  condition }, { additionalProperties: false });
const orderedRule = t.Object({ ruleId: groupUuid, actions: t.Array(action, { minItems: 1, maxItems: 16 }),
  effect: t.Union([t.Literal('allow'), t.Literal('deny')]), condition }, { additionalProperties: false });
const basis = t.Union([t.Literal('authenticated_principal'), t.Literal('acting_subject')]);
const setKind = t.Union([t.Literal('org'), t.Literal('realm')]);
const decisionAction = t.Union([t.Literal('work.read'), t.Literal('work.edit'), t.Literal('work.create')]);
const interaction = t.Union([t.Literal('message'), t.Literal('reply'), t.Literal('mention')]);
const noStore = { headers: { 'cache-control': 'no-store' } };

const changeCommon = { profile: t.Literal('access-policy-change-v1'), issuerSubject: groupAgent,
  expectedAuthorityEpoch: groupGeneration };
const policyChangeBody = t.Union([
  t.Object({ ...changeCommon, action: t.Literal('end-policy'), policyId: groupUuid,
    scopeId: t.String({ pattern: '^semantic:read:https://rezics\\.com/id/[0-9a-f-]{36}$' }),
    expectedHeadRevision: groupGeneration }, { additionalProperties: false }),
  t.Object({ ...changeCommon, action: t.Literal('publish-revision'), policyId: groupUuid, scopeId,
    expectedHeadRevision: groupGeneration, mandatory: t.Array(mandatoryRule, { maxItems: 16 }),
    ordered: t.Array(orderedRule, { maxItems: 64 }),
    limits: t.Optional(t.Object({ maxStates: t.Optional(t.Integer()), maxInputRows: t.Optional(t.Integer()),
      deadlineMs: t.Optional(t.Integer()) }, { additionalProperties: false })) },
  { additionalProperties: false }),
  t.Object({ ...changeCommon, action: t.Literal('admit-set'), setAdmissionId: groupUuid, setKind, basis,
    referencingScopeId: scopeId, purpose: t.Union([t.Literal('resource-exclusion'),
      t.Literal('resource-eligibility')]), validUntil: t.String({ format: 'date-time' }) },
  { additionalProperties: false }),
  t.Object({ ...changeCommon, action: t.Literal('revoke-set'), setAdmissionId: groupUuid,
    expectedGeneration: groupGeneration }, { additionalProperties: false }),
]);
const policyChangeResult = t.Object({ profile: t.Literal('access-policy-change-v1'),
  action: t.Union([t.Literal('publish-revision'), t.Literal('end-policy'), t.Literal('admit-set'), t.Literal('revoke-set')]),
  policyId: t.Nullable(groupUuid), revision: t.Nullable(groupGeneration),
  setAdmissionId: t.Nullable(groupUuid), authorityEpoch: groupGeneration, replayed: t.Boolean() });
const policyRevisionResult = t.Object({ profile: t.Literal('access-policy-revision-v1'),
  policyId: groupUuid, scopeId, ownerSubject: groupAgent, headRevision: groupGeneration,
  revision: groupGeneration, combiningAlgorithm: t.Literal('first-applicable'),
  defaultEffect: t.Literal('deny'), digest: t.String(), authorityEpoch: groupGeneration,
  limits: t.Object({ maxStates: t.Integer(), maxInputRows: t.Integer(), deadlineMs: t.Integer() }),
  mandatory: t.Array(t.Object({ ruleId: groupUuid, actions: t.Array(t.String()), condition: t.Unknown() }),
    { maxItems: 16 }),
  ordered: t.Array(t.Object({ ruleId: groupUuid, actions: t.Array(t.String()),
    effect: t.Union([t.Literal('allow'), t.Literal('deny')]), condition: t.Unknown() }), { maxItems: 64 }),
  references: t.Array(t.Object({ ruleId: groupUuid, setAdmissionId: groupUuid,
    polarity: t.Union([t.Literal('exclude'), t.Literal('include')]) }), { maxItems: 16 }) });
const decisionBody = t.Object({ profile: t.Literal('access-policy-decision-v1'), scopeId, action: decisionAction,
  actingSubject: t.Nullable(groupAgent), reusable: t.Optional(t.Boolean()),
  validitySeconds: t.Optional(t.Integer({ minimum: 1, maximum: 120 })) }, { additionalProperties: false });
const decisionResult = t.Object({ profile: t.Literal('access-policy-decision-v1'),
  decisionId: t.Nullable(groupUuid),
  result: t.Union([t.Literal('allow'), t.Literal('deny'), t.Literal('unavailable')]),
  policyId: groupUuid, policyRevision: groupGeneration, authorityEpoch: groupGeneration,
  expiresAt: t.Nullable(t.String({ format: 'date-time' })), reusable: t.Boolean(),
  sources: t.Array(t.Object({ kind: t.Union([t.Literal('permission_grant'), t.Literal('role_binding')]),
    id: groupUuid, generation: groupGeneration }), { maxItems: 8 }) });
const revalidationBody = t.Object({ profile: t.Literal('access-policy-decision-revalidation-v1'),
  decisionId: groupUuid, scopeId, action: decisionAction, actingSubject: t.Nullable(groupAgent) },
{ additionalProperties: false });
const muteBody = t.Object({ profile: t.Literal('access-interaction-mute-v1'),
  targetKind: t.Union([t.Literal('realm'), t.Literal('agent')]), target: groupAgent,
  match: t.Union([t.Literal('publishing-realm'), t.Literal('author-membership'),
    t.Literal('publication-context'), t.Literal('author')]),
  muted: t.Boolean(), expectedRevision: t.Nullable(groupUuid) }, { additionalProperties: false });
const muteResult = t.Object({ profile: t.Literal('access-interaction-mute-v1'), revision: groupUuid,
  muted: t.Boolean(), replayed: t.Boolean() });
const muteList = t.Object({ profile: t.Literal('access-interaction-mutes-v1'),
  mutes: t.Array(t.Object({ targetKind: t.String(), target: groupAgent, match: t.String(),
    revision: groupUuid }), { maxItems: 256 }) });
const blockCommon = { profile: t.Literal('access-interaction-block-change-v1'), recipientSubject: groupAgent,
  expectedAuthorityEpoch: groupGeneration, blockId: groupUuid };
const blockBody = t.Union([
  t.Object({ ...blockCommon, action: t.Literal('block'),
    target: t.Union([t.Object({ kind: t.Literal('agent'), subject: groupAgent }, { additionalProperties: false }),
      t.Object({ kind: t.Literal('member-set'), setKind, setOwnerSubject: groupAgent, basis },
        { additionalProperties: false })]),
    interactions: t.Array(interaction, { minItems: 1, maxItems: 3, uniqueItems: true }) },
  { additionalProperties: false }),
  t.Object({ ...blockCommon, action: t.Literal('unblock'), expectedGeneration: groupGeneration },
    { additionalProperties: false }),
]);
const blockResult = t.Object({ profile: t.Literal('access-interaction-block-change-v1'), blockId: groupUuid,
  generation: groupGeneration, authorityEpoch: groupGeneration, replayed: t.Boolean() });
const interactionBody = t.Object({ profile: t.Literal('access-interaction-decision-v1'),
  recipientSubject: groupAgent, interaction, actingSubject: groupAgent }, { additionalProperties: false });
const interactionResult = t.Object({ profile: t.Literal('access-interaction-decision-v1'),
  decisionId: groupUuid, result: t.Union([t.Literal('allow'), t.Literal('deny'), t.Literal('unavailable')]),
  authorityEpoch: groupGeneration, expiresAt: t.String({ format: 'date-time' }) });
const revocationBody = t.Object({ profile: t.Literal('access-revocation-v1'), revocationId: groupUuid,
  issuerSubject: groupAgent, mode: t.Union([t.Literal('ordinary'), t.Literal('strong')]), scopeId,
  expectedAuthorityEpoch: groupGeneration,
  target: t.Object({ kind: t.Union([t.Literal('permission_grant'), t.Literal('representation')]),
    id: groupUuid, expectedGeneration: groupGeneration }, { additionalProperties: false }) },
{ additionalProperties: false });
const revocationResult = t.Object({ profile: t.Literal('access-revocation-v1'), revocationId: groupUuid,
  mode: t.Union([t.Literal('ordinary'), t.Literal('strong')]),
  state: t.Union([t.Literal('draining'), t.Literal('completed')]),
  target: t.Object({ kind: t.String(), id: groupUuid, generation: groupGeneration }), scopeId,
  fenceAuthorityEpoch: groupGeneration, affectedWork: t.Integer(), pending: t.Integer(),
  replayed: t.Optional(t.Boolean()) });

function policyError(error: unknown): Response {
  if (error instanceof PolicyInvalid) return problem(400, 'policy_invalid', 'Request is outside the Access policy profile');
  if (error instanceof PolicyDenied) return problem(403, 'policy_denied', 'Access policy operation is not admitted');
  if (error instanceof ProofHandleMismatch) return problem(403, 'proof_handle_mismatch', 'Proof handle is bound to another context');
  if (error instanceof PolicyNotFound) return problem(404, 'policy_not_found', 'No policy governs this scope');
  if (error instanceof PolicyStale) return problem(409, 'policy_stale', 'Access authority changed');
  if (error instanceof PolicyConflict) return problem(409, 'policy_key_conflict', 'Idempotency key binds another intent');
  if (error instanceof PolicyReferenceNotAdmitted) {
    return problem(409, 'policy_reference_not_admitted', 'A referenced set is not admitted for this policy');
  }
  if (error instanceof ProofHandleStale) return problem(409, 'proof_handle_stale', 'Proof handle is no longer current');
  if (error instanceof PolicyUnavailable) {
    return problem(503, 'policy_unavailable', 'Access owner is unavailable', { 'retry-after': '1' });
  }
  return commandError(error);
}

function receiptKey(request: Request, body: Record<string, unknown>) {
  const key = request.headers.get('idempotency-key');
  if (!key || key.length > 128 || key.includes('\0')) throw new PolicyInvalid('bounded idempotency key required');
  return { idempotencyKey: key, requestDigest: groupChangeIntentDigest(body) };
}

function owner(work: MainWorkDependencies): AccessPolicyOwner {
  if (!work.accessPolicy) throw new PolicyUnavailable('Access policy owner is unavailable');
  return work.accessPolicy;
}

export function accessPolicyRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .post('/v1/access/policy-changes', {
      body: policyChangeBody, response: { 200: policyChangeResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['access:manage']);
        const key = receiptKey(request, body);
        const context = { principal, issuerSubject: body.issuerSubject,
          expectedAuthorityEpoch: body.expectedAuthorityEpoch, ...key };
        const result = await owner(work).changes.change(context, body.action === 'publish-revision'
          ? { action: body.action, policyId: body.policyId, scopeId: body.scopeId,
            expectedHeadRevision: body.expectedHeadRevision, mandatory: body.mandatory,
            ordered: body.ordered, ...(body.limits ? { limits: body.limits } : {}) }
          : body.action === 'end-policy'
            ? { action: body.action, policyId: body.policyId, scopeId: body.scopeId,
              expectedHeadRevision: body.expectedHeadRevision }
          : body.action === 'admit-set'
            ? { action: body.action, setAdmissionId: body.setAdmissionId, setKind: body.setKind,
              basis: body.basis, referencingScopeId: body.referencingScopeId, purpose: body.purpose,
              validUntil: new Date(body.validUntil) }
            : { action: body.action, setAdmissionId: body.setAdmissionId,
              expectedGeneration: body.expectedGeneration });
        return Response.json({ profile: 'access-policy-change-v1', ...result }, noStore);
      } catch (error) { return policyError(error); }
    })
    .get('/v1/access/policies/:policyId/revisions/:revision', {
      params: t.Object({ policyId: groupUuid, revision: groupGeneration }),
      query: t.Object({ issuerSubject: groupAgent }, { additionalProperties: false }),
      response: { 200: policyRevisionResult, ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        const principal = await work.account.verify(request, ['access:manage']);
        const result = await owner(work).changes.readRevision(principal, query.issuerSubject,
          params.policyId, params.revision);
        return Response.json({ profile: 'access-policy-revision-v1', ...result }, noStore);
      } catch (error) { return policyError(error); }
    })
    .post('/v1/access/policy-decisions', {
      body: decisionBody, response: { 200: decisionResult, ...writeProblems, 404: authorizedReadProblems[404] },
    }, async ({ request, body }) => {
      try {
        // The credential scope for the action is a hard guard before any policy input.
        const principal = await work.account.verify(request, [POLICY_DECISION_ACTIONS[body.action]]);
        const result = await owner(work).decisions.decide({ principal, scopeId: body.scopeId,
          action: body.action, actingSubject: body.actingSubject, reusable: body.reusable ?? false,
          validitySeconds: body.validitySeconds ?? 120 });
        return Response.json({ profile: 'access-policy-decision-v1', ...result }, noStore);
      } catch (error) { return policyError(error); }
    })
    .post('/v1/access/policy-decision-revalidations', {
      body: revalidationBody, response: { 200: decisionResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, [POLICY_DECISION_ACTIONS[body.action]]);
        const result = await owner(work).decisions.revalidate(principal, body.decisionId, body.scopeId,
          body.action, body.actingSubject);
        return Response.json({ profile: 'access-policy-decision-v1', ...result }, noStore);
      } catch (error) { return policyError(error); }
    })
    .put('/v1/me/interaction-mutes', {
      body: muteBody, response: { 200: muteResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['work:read']);
        const result = await owner(work).interactions.setMute(principal, {
          targetKind: body.targetKind, target: body.target,
          match: body.match as 'publishing-realm', muted: body.muted,
          expectedRevision: body.expectedRevision }, receiptKey(request, body));
        return Response.json({ profile: 'access-interaction-mute-v1', ...result }, noStore);
      } catch (error) { return policyError(error); }
    })
    .get('/v1/me/interaction-mutes', {
      response: { 200: muteList, ...authorizedReadProblems },
    }, async ({ request }) => {
      try {
        const principal = await work.account.verify(request, ['work:read']);
        const rows = await owner(work).interactions.listMutes(principal);
        return Response.json({ profile: 'access-interaction-mutes-v1', mutes: rows.map(row => ({
          targetKind: row.target_kind, target: row.target, match: row.match, revision: row.revision })) },
        noStore);
      } catch (error) { return policyError(error); }
    })
    .post('/v1/access/interaction-blocks', {
      body: blockBody, response: { 200: blockResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['access:manage']);
        const result = await owner(work).interactions.changeBlock(principal, body.recipientSubject,
          body.expectedAuthorityEpoch, body.action === 'block'
            ? { action: 'block', blockId: body.blockId, target: body.target, interactions: body.interactions }
            : { action: 'unblock', blockId: body.blockId, expectedGeneration: body.expectedGeneration },
          receiptKey(request, body));
        return Response.json({ profile: 'access-interaction-block-change-v1', ...result }, noStore);
      } catch (error) { return policyError(error); }
    })
    .post('/v1/access/interaction-decisions', {
      body: interactionBody, response: { 200: interactionResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['comment:create']);
        const result = await owner(work).interactions.decide(principal, body.recipientSubject,
          body.interaction, body.actingSubject);
        return Response.json({ profile: 'access-interaction-decision-v1', ...result }, noStore);
      } catch (error) { return policyError(error); }
    })
    .post('/v1/access/revocations', {
      body: revocationBody, response: { 200: revocationResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['access:grant']);
        const result = await owner(work).revocations.revoke(principal, {
          revocationId: body.revocationId, issuerSubject: body.issuerSubject, mode: body.mode,
          scopeId: body.scopeId, expectedAuthorityEpoch: body.expectedAuthorityEpoch,
          target: body.target }, receiptKey(request, body));
        return Response.json({ profile: 'access-revocation-v1', ...result }, noStore);
      } catch (error) { return policyError(error); }
    })
    .get('/v1/access/revocations/:revocationId', {
      params: t.Object({ revocationId: groupUuid }),
      query: t.Object({ issuerSubject: groupAgent }, { additionalProperties: false }),
      response: { 200: revocationResult, ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        const principal = await work.account.verify(request, ['access:grant']);
        const result = await owner(work).revocations.read(principal, query.issuerSubject,
          params.revocationId);
        return Response.json({ profile: 'access-revocation-v1', ...result }, noStore);
      } catch (error) { return policyError(error); }
    });
}
