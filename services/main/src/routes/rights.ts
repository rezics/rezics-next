import { Elysia, t } from 'elysia';
import { writeProblems } from '../api-responses.ts';
import { RightsConflict, RightsDenied, RightsInvalid, RightsStale, RightsUnavailable,
  type RightsStore } from '../modules/rights/store.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { problem } from './problems.ts';
import { decisionFields, decisionResult, type GovernanceRouteDependencies, governanceError, REPORT_SCOPE,
  reportFields } from './reports.ts';

/** Bearer scope for rights records until Account registers a rights scope; Access grants decide authority. */
export const RIGHTS_SCOPE = 'source:intake';

export interface RightsRouteDependencies { rights?: { store: RightsStore } }

const agent = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const uuid = t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const nullable = (max: number) => t.Nullable(t.String({ minLength: 1, maxLength: max }));
const literals = (values: readonly string[]) => t.Union(values.map(value => t.Literal(value)));
const instrument = t.String({ pattern: '^https?://[^\\s]{1,500}$' });
const noStore = { headers: { 'cache-control': 'no-store' } };

const material = t.Object({
  scopeKind: literals(['source_provider', 'source_record', 'content_variant', 'media_asset']),
  provider: nullable(100), namespace: nullable(100), sourceRecordId: t.Nullable(uuid),
  contentVariantId: nullable(300), mediaAsset: t.Nullable(agent),
  component: t.String({ pattern: '^[a-z][a-z0-9_.-]{0,63}$' }) }, { additionalProperties: false });
const useKey = {
  family: literals(['data_rights', 'service_terms']),
  useKind: literals(['acquisition', 'raw_retention', 'wiki_display', 'search', 'media_delivery', 'quotation',
    'export', 'paid_data_product', 'redistribution']),
  useScope: t.String({ pattern: '^[a-z0-9][a-z0-9:_./-]{0,127}$' }),
};
const assessmentProperties = { assessmentId: t.String(), materialId: t.String(), family: t.String(),
  useKind: t.String(), useScope: t.String(), expressionKind: t.String(), basis: t.String(), outcome: t.String(),
  licenseInstrument: t.Nullable(t.String()), exceptionKind: t.Nullable(t.String()), rationale: t.Nullable(t.String()),
  extent: t.Record(t.String(), t.Unknown()), predecessor: t.Nullable(t.String()), revision: t.Nullable(t.String()),
  obligations: t.Array(t.Object({ kind: t.String(), instrument: t.String(), appliesTo: t.String(),
    notice: t.Nullable(t.String()) })) };
const assessment = t.Object(assessmentProperties);
const assessmentResult = t.Object({ profile: t.String(), replayed: t.Boolean(), ...assessmentProperties });
const evaluationResult = t.Object({ profile: t.String(), status: t.String(),
  materialId: t.Optional(t.Nullable(t.String())), assessment: t.Optional(assessment) });
const complaintResult = t.Object({ profile: t.String(), reportId: t.String(), caseId: t.String(),
  caseGeneration: t.String(), evidenceDigest: t.String(), replayed: t.Boolean(),
  evidence: t.Array(t.Object({ ordinal: t.Number(), owner: t.String(), resource: t.String(), component: t.String(),
    revision: t.Nullable(t.String()), revisionDigest: t.Nullable(t.String()), state: t.String() })) });

export function rightsError(error: unknown): Response {
  if (error instanceof RightsInvalid) return problem(400, 'invalid_rights_request', error.message);
  if (error instanceof RightsDenied) return problem(403, 'rights_denied', error.message);
  if (error instanceof RightsConflict) return problem(409, 'idempotency_conflict', error.message);
  if (error instanceof RightsStale) return problem(409, 'stale_rights_basis', error.message);
  if (error instanceof RightsUnavailable) return problem(503, 'rights_unavailable', error.message);
  return governanceError(error);
}

/**
 * LIVE13-LIVE17 use assessments and GOV24/GOV25 rights complaints and
 * restrictions. Complaints and restrictions are governance cases and decisions
 * of the rights kind; there is no separate rights decision model.
 */
export function rightsRoutes(work: MainWorkDependencies) {
  const deps = work as MainWorkDependencies & RightsRouteDependencies & GovernanceRouteDependencies;
  const unavailable = () => problem(503, 'rights_unavailable', 'Rights records are unavailable');
  return new Elysia()
    .post('/v1/rights/use-assessments', {
      body: t.Object({ profile: t.Literal('rights-use-assessment-v1'), actingSubject: agent, material,
        expressionKind: literals(['fact', 'expression', 'compilation', 'media', 'service', 'unknown']), ...useKey,
        basis: literals(['original_contribution', 'unprotected_fact', 'public_domain', 'license', 'permission',
          'statutory_exception', 'service_terms', 'unknown']),
        outcome: literals(['supported', 'conditional', 'not_supported', 'undetermined']),
        licenseInstrument: t.Nullable(instrument), exceptionKind: t.Nullable(t.Literal('fair_use')),
        rationale: nullable(8000), extent: t.Record(t.String(), t.Unknown()), evidence: t.Record(t.String(), t.Unknown()),
        obligations: t.Array(t.Object({ kind: literals(['attribution', 'share_alike', 'notice_retention',
          'change_indication', 'non_commercial', 'no_derivatives', 'other']), instrument,
        appliesTo: literals(['display', 'export', 'redistribution', 'all']), notice: nullable(4000) },
        { additionalProperties: false }), { maxItems: 16 }),
        expectedAssessment: t.Nullable(uuid),
        idempotencyKey: t.String({ pattern: '^[A-Za-z0-9:_./-]{1,128}$' }) }, { additionalProperties: false }),
      response: { 200: assessmentResult, 201: assessmentResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, [RIGHTS_SCOPE]);
        if (!deps.rights) return unavailable();
        const { profile: _profile, ...input } = body;
        const result = await deps.rights.store.assess(principal, input as Parameters<RightsStore['assess']>[1]);
        return Response.json({ profile: 'rights-use-assessment-v1', ...result },
          { status: result.replayed ? 200 : 201, ...noStore });
      } catch (error) { return rightsError(error); }
    })
    .post('/v1/rights/use-evaluations', {
      body: t.Object({ profile: t.Literal('rights-use-evaluation-v1'), actingSubject: agent,
        material, ...useKey },
        { additionalProperties: false }),
      response: { 200: evaluationResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, [RIGHTS_SCOPE]);
        if (!deps.rights) return unavailable();
        const result = await deps.rights.store.evaluate(principal, body.actingSubject, body.material,
          { family: body.family, useKind: body.useKind, useScope: body.useScope });
        return Response.json({ profile: 'rights-use-evaluation-v1', ...result }, noStore);
      } catch (error) { return rightsError(error); }
    })
    .post('/v1/rights/complaints', {
      body: t.Object({ profile: t.Literal('rights-complaint-v1'), ...reportFields,
        complaint: t.Object({ process: literals(['dmca_512', 'ordinary_dispute']),
          claimantKind: literals(['rights_holder', 'authorized_agent', 'unknown']),
          claimantName: t.String({ minLength: 1, maxLength: 300 }), claimantContact: nullable(500),
          claimedWork: t.String({ minLength: 1, maxLength: 1000 }),
          claimedRight: literals(['copyright', 'trademark', 'privacy', 'other']),
          noticeDigest: t.String({ pattern: '^[0-9a-f]{64}$' }), noticeReceivedAt: t.String({ format: 'date-time' }) },
        { additionalProperties: false }) }, { additionalProperties: false }),
      response: { 200: complaintResult, 201: complaintResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, [REPORT_SCOPE]);
        if (!deps.governance) return unavailable();
        const { profile: _profile, ...input } = body;
        const result = await deps.governance.store.submitReport(principal,
          { kind: 'rights_complaint', ...input } as Parameters<NonNullable<typeof deps.governance>['store']['submitReport']>[1]);
        return Response.json({ profile: 'rights-complaint-v1', ...result },
          { status: result.replayed ? 200 : 201, ...noStore });
      } catch (error) { return rightsError(error); }
    })
    .post('/v1/rights/restrictions', {
      body: t.Object({ profile: t.Literal('rights-restriction-v1'),
        outcome: literals(['interim_restrict', 'final_restrict', 'dismiss', 'restore', 'reverse']), ...decisionFields },
      { additionalProperties: false }),
      response: { 200: decisionResult, 201: decisionResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, [RIGHTS_SCOPE]);
        if (!deps.governance) return unavailable();
        const { profile: _profile, ...input } = body;
        const result = await deps.governance.store.decide(principal,
          input as Parameters<NonNullable<typeof deps.governance>['store']['decide']>[1]);
        return Response.json({ profile: 'rights-restriction-v1', ...result },
          { status: result.replayed ? 200 : 201, ...noStore });
      } catch (error) { return rightsError(error); }
    });
}
