import { operationResult } from '../modules/operation/contract.ts';
import { reasons } from '../modules/safety-queue/contract.ts';
import { Elysia, t } from 'elysia';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import { GovernanceConflict, GovernanceDenied, GovernanceInvalid, GovernanceStale, GovernanceUnavailable,
  type GovernanceStore } from '../modules/governance/store.ts';
import type { GovernanceRules } from '../modules/governance/rules.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

/** Access grants on the case scope gate decide actual decision authority. */
export const REPORT_SCOPE = 'governance:report';
export const MODERATION_SCOPE = 'governance:decide';

export const openApiOperations = {
  '/v1/governance/rules': { post: { bearer: true, idempotencyKey: true } },
  '/v1/governance/rule-queries': { post: { bearer: true } },
  '/v1/reports': { post: { bearer: true, idempotencyKey: true } },
  '/v1/reports/{report}': { get: { bearer: true } },
  '/v1/moderation/decisions': { post: { bearer: true, idempotencyKey: true } },
  '/v1/governance/process-steps': { post: { bearer: true, idempotencyKey: true } },
} as const;

export function requireGovernanceKey(request: Request, key: string): Response | null {
  return request.headers.get('idempotency-key') === key ? null
    : problem(400, 'invalid_idempotency_key', 'Idempotency-Key must match the request');
}

export interface GovernanceRouteDependencies {
  governance?: { store: GovernanceStore; rules?: GovernanceRules };
}

const agent = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const uuid = t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const key = t.String({ pattern: '^[A-Za-z0-9:_./-]{1,128}$' });
const digest = t.String({ pattern: '^[0-9a-f]{64}$' });
const owner = t.Union([t.Literal('graph'), t.Literal('content'), t.Literal('source'), t.Literal('media'), t.Literal('review')]);
// Literals written out, not mapped from an array, so typed clients see the values instead of `never`.
const component = t.Union([t.Literal('name'), t.Literal('title'), t.Literal('body'), t.Literal('structure'),
  t.Literal('media_use'), t.Literal('synopsis'), t.Literal('cover'), t.Literal('publication'), t.Literal('record')]);
const context = t.String({ pattern: '^(urn:rezics:context:global|https://rezics\\.com/id/[0-9a-f-]{36})$' });
const disclosure = t.Union([t.Literal('private'), t.Literal('parties'), t.Literal('public_summary')]);
const bounded = (max: number) => t.String({ minLength: 1, maxLength: max });
const noStore = { headers: { 'cache-control': 'no-store' } };

export const evidenceTarget = t.Object({ owner, resource: bounded(512), component,
  revision: t.Nullable(bounded(512)), locator: t.Nullable(bounded(512)) }, { additionalProperties: false });
export const reportFields = {
  actingSubject: agent,
  authority: t.Object({ kind: t.Union([t.Literal('platform'), t.Literal('realm'), t.Literal('resource_owner')]),
    scopeId: bounded(256) }, { additionalProperties: false }),
  context,
  target: t.Object({ owner, resource: bounded(512), component }, { additionalProperties: false }),
  disclosure,
  reasonCode: t.String({ pattern: '^[a-z][a-z0-9_.-]{0,63}$' }),
  statement: t.Nullable(bounded(4000)),
  evidence: t.Array(evidenceTarget, { minItems: 1, maxItems: 16 }),
  idempotencyKey: key,
};
const reportResult = t.Object({ profile: t.String(), reportId: t.String(), caseId: t.String(),
  caseGeneration: t.String(), evidenceDigest: t.String(), replayed: t.Boolean(),
  caseState: t.Optional(t.String()), decisionHead: t.Optional(t.Nullable(t.String())),
  evidence: t.Array(t.Object({ ordinal: t.Number(), owner: t.String(), resource: t.String(), component: t.String(),
    revision: t.Nullable(t.String()), revisionDigest: t.Nullable(t.String()), state: t.String() })) });
export const decisionFields = {
  reasons: t.Optional(reasons),
  caseId: uuid,
  expectedGeneration: t.String({ pattern: '^(0|[1-9][0-9]{0,18})$' }),
  actingSubject: agent,
  targets: t.Array(t.Object({ owner, resource: bounded(512), component, locator: t.Nullable(bounded(512)),
    scopeKind: t.Union([t.Literal('exact_revision'), t.Literal('component')]), revision: t.Nullable(bounded(512)),
    expectedHead: t.Nullable(bounded(512)),
    expiresAt: t.Optional(t.Nullable(t.String({ format: 'date-time' }))),
    effect: t.Union([t.Literal('disclosure'), t.Literal('publication'), t.Literal('participation'), t.Literal('capability'),
      t.Literal('search'), t.Literal('raw_delivery'), t.Literal('media_delivery'), t.Literal('export'),
      t.Literal('source_apply')]) },
  { additionalProperties: false }), { maxItems: 64 }),
  rule: t.Object({ ref: bounded(512), revision: bounded(512), digest }, { additionalProperties: false }),
  evidenceDigest: digest,
  reversesDecisionId: t.Nullable(uuid),
  answersStepId: t.Nullable(uuid),
  rationale: t.Nullable(bounded(8000)),
  disclosure,
  idempotencyKey: key,
};
export const decisionResult = t.Object({ profile: t.String(), decisionId: t.String(), caseId: t.String(),
  caseGeneration: t.String(), outcome: t.String(), replayed: t.Boolean(), operation: operationResult,
  enforcement: t.Array(t.Object({ owner: t.String(), resource: t.String(), component: t.String(),
    revision: t.Nullable(t.String()), effect: t.String(), state: t.String(), fenceEpoch: t.String() })) });
export const stepFields = {
  caseId: uuid, decisionId: uuid, actingSubject: agent,
  process: t.Union([t.Literal('platform_appeal'), t.Literal('dmca_512'), t.Literal('ordinary_dispute')]),
  step: t.Union(['appeal', 'uploader_notice', 'counter_notice', 'claimant_notice', 'restoration_window',
    'claimant_action'].map(value => t.Literal(value))),
  partySubject: t.Nullable(agent), statement: t.Nullable(bounded(8000)), documentDigest: t.Nullable(digest),
  occurredAt: t.String({ format: 'date-time' }), dueAt: t.Nullable(t.String({ format: 'date-time' })),
  idempotencyKey: key,
};
const stepResult = t.Object({ profile: t.String(), stepId: t.String(), dueAt: t.Nullable(t.String()),
  replayed: t.Boolean() });
const ruleResult = t.Object({ profile: t.Literal('governance-rule-v1'), ref: t.String(), scopeId: t.String(),
  revision: t.String(), digest, document: t.Record(t.String(), t.Unknown()), replayed: t.Boolean() });

export function governanceError(error: unknown): Response {
  if (error instanceof GovernanceInvalid) return problem(400, 'invalid_governance_request', error.message);
  if (error instanceof GovernanceDenied) return problem(403, 'governance_denied', error.message);
  if (error instanceof GovernanceConflict) return problem(409, 'idempotency_conflict', error.message);
  if (error instanceof GovernanceStale) return problem(409, 'stale_governance_basis', error.message);
  if (error instanceof GovernanceUnavailable) return problem(503, 'governance_unavailable', error.message);
  return commandError(error);
}

/** GOV01-GOV03 reports, moderation decisions and process steps (template: modules/governance/README.md). */
export function reportRoutes(work: MainWorkDependencies) {
  const owner = (work as MainWorkDependencies & GovernanceRouteDependencies).governance;
  const unavailable = () => problem(503, 'governance_unavailable', 'Governance is unavailable');
  return new Elysia()
    .post('/v1/governance/rules', {
      body: t.Object({ profile: t.Literal('governance-rule-v1'), ref: bounded(512), scopeId: bounded(256),
        actingSubject: agent, expectedRevision: t.Nullable(t.String({ pattern: '^[1-9][0-9]{0,18}$' })),
        document: t.Record(t.String(), t.Unknown()), idempotencyKey: key }, { additionalProperties: false }),
      response: { 200: ruleResult, 201: ruleResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, [MODERATION_SCOPE]);
        const keyError = requireGovernanceKey(request, body.idempotencyKey);
        if (keyError) return keyError;
        if (!owner?.rules) return unavailable();
        const { profile: _profile, ...input } = body;
        const result = await owner.rules.publish(principal, input);
        return Response.json({ profile: 'governance-rule-v1', ...result },
          { status: result.replayed ? 200 : 201, ...noStore });
      } catch (error) { return governanceError(error); }
    })
    .post('/v1/governance/rule-queries', {
      body: t.Object({ profile: t.Literal('governance-rule-query-v1'), ref: bounded(512),
        scopeId: bounded(256), actingSubject: agent }, { additionalProperties: false }),
      response: { 200: ruleResult, ...authorizedReadProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, [MODERATION_SCOPE]);
        if (!owner?.rules) return unavailable();
        const result = await owner.rules.read(principal, body.actingSubject, body.ref, body.scopeId);
        return Response.json({ profile: 'governance-rule-v1', ...result }, noStore);
      } catch (error) { return governanceError(error); }
    })
    .post('/v1/reports', {
      body: t.Object({ profile: t.Literal('content-report-v1'), ...reportFields }, { additionalProperties: false }),
      response: { 200: reportResult, 201: reportResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, [REPORT_SCOPE]);
        const keyError = requireGovernanceKey(request, body.idempotencyKey);
        if (keyError) return keyError;
        if (!owner) return unavailable();
        const { profile: _profile, ...input } = body;
        const result = await owner.store.submitReport(principal, { kind: 'content_report', ...input });
        return Response.json({ profile: 'governance-report-v1', ...result },
          { status: result.replayed ? 200 : 201, ...noStore });
      } catch (error) { return governanceError(error); }
    })
    .get('/v1/reports/:report', {
      params: t.Object({ report: uuid }),
      query: t.Object({ actingSubject: t.Optional(agent) }, { additionalProperties: false }),
      response: { 200: reportResult, ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        const principal = await work.account.verify(request, [REPORT_SCOPE]);
        if (!owner) return unavailable();
        const result = await owner.store.readReport(principal, params.report, query.actingSubject ?? null);
        return Response.json({ profile: 'governance-report-v1', ...result }, noStore);
      } catch (error) {
        if (error instanceof GovernanceDenied) return problem(404, 'not_found', 'Report is unavailable');
        return governanceError(error);
      }
    })
    .post('/v1/moderation/decisions', {
      body: t.Object({ profile: t.Literal('moderation-decision-v1'),
        outcome: t.Union([t.Literal('restrict'), t.Literal('interim_restrict'),
          t.Literal('final_restrict'), t.Literal('dismiss'), t.Literal('restore'), t.Literal('reverse')]),
        ...decisionFields }, { additionalProperties: false }),
      response: { 200: decisionResult, 202: decisionResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, [MODERATION_SCOPE]);
        const keyError = requireGovernanceKey(request, body.idempotencyKey);
        if (keyError) return keyError;
        if (!owner) return unavailable();
        const { profile: _profile, ...input } = body;
        const result = await owner.store.decide(principal, input, true);
        return Response.json({ profile: 'moderation-decision-v1', ...result },
          { status: result.operation.status === 'completed' ? 200 : 202, ...noStore });
      } catch (error) { return governanceError(error); }
    })
    .post('/v1/governance/process-steps', {
      body: t.Object({ profile: t.Literal('governance-process-step-v1'), ...stepFields },
        { additionalProperties: false }),
      response: { 200: stepResult, 201: stepResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, [REPORT_SCOPE]);
        const keyError = requireGovernanceKey(request, body.idempotencyKey);
        if (keyError) return keyError;
        if (!owner) return unavailable();
        const { profile: _profile, ...input } = body;
        const result = await owner.store.recordStep(principal, input);
        return Response.json({ profile: 'governance-process-step-v1', ...result },
          { status: result.replayed ? 200 : 201, ...noStore });
      } catch (error) { return governanceError(error); }
    });
}
