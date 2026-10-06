import { Elysia, t } from 'elysia';
import { writeProblems } from '../api-responses.ts';
import { RightsConflict, RightsDenied, RightsInvalid, RightsStale, RightsUnavailable,
  type RightsStore } from '../modules/rights/store.ts';
import { changeAdmittedOffering, createAdmittedOffering, readOffering, readOfferingRevision, RightsOfferingInvalid,
  RightsOfferingStale, RightsOfferingUnavailable } from '../modules/rights/offering.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { problem } from './problems.ts';
import { decisionFields, decisionResult, type GovernanceRouteDependencies, governanceError, REPORT_SCOPE,
  reportFields, requireGovernanceKey } from './reports.ts';

/** Bearer scopes are separate from Access grants on the affected material or case. */
export const RIGHTS_SCOPE = 'rights:assess';
export const RIGHTS_DECIDE_SCOPE = 'rights:decide';
export const RIGHTS_OFFER_SCOPE = 'rights:offer';

export const openApiOperations = {
  '/v1/rights/offerings': { post: { exposure: 'platform:commerce', bearer: true, idempotencyKey: true } },
  '/v1/rights/offerings/{offering}/changes': { post: { exposure: 'platform:commerce', bearer: true, idempotencyKey: true } },
  '/v1/rights/offerings/{offering}': { get: { exposure: 'platform:commerce', bearer: true } },
  '/v1/rights/offerings/{offering}/revisions/{revision}': { get: { exposure: 'platform:commerce', bearer: true } },
  '/v1/rights/use-assessments': { post: { exposure: 'public', bearer: true, idempotencyKey: true } },
  '/v1/rights/use-evaluations': { post: { exposure: 'public', bearer: true } },
  '/v1/rights/complaints': { post: { exposure: 'public', bearer: true, idempotencyKey: true } },
  '/v1/rights/restrictions': { post: { exposure: 'public', bearer: true, idempotencyKey: true } },
} as const;

export interface RightsRouteDependencies { rights?: { store: RightsStore } }

const agent = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const uuid = t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const nullable = (max: number) => t.Nullable(t.String({ minLength: 1, maxLength: max }));
const literals = (values: readonly string[]) => t.Union(values.map(value => t.Literal(value)));
const instrument = t.String({ pattern: '^https?://[^\\s]{1,500}$' });
const noStore = { headers: { 'cache-control': 'no-store' } };

const material = t.Object({
  scopeKind: literals(['source_provider', 'source_record', 'content_variant', 'media_asset', 'work', 'wiki_evidence']),
  provider: nullable(100), namespace: nullable(100), sourceRecordId: t.Nullable(uuid),
  contentVariantId: nullable(300), mediaAsset: t.Nullable(agent), workId: t.Optional(t.Nullable(agent)), wikiEvidenceId: t.Optional(t.Nullable(agent)),
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
const offeringResult = t.Object({ profile: t.Literal('rights-offering-operation-v1'),
  receipt: t.String(), admissionId: t.String(), offering: t.String(), revision: t.String(),
  action: t.String(), dataEpoch: t.String(), sequence: t.String(), replayed: t.Boolean() });
const offeringView = t.Object({ profile: t.Literal('rights-offering-v1'), offering: t.String(),
  target: t.String(), instrument: t.String(), declaration: t.String(), slot: t.String(),
  offeringHead: t.String(), state: t.Union([t.Literal('open'), t.Literal('ended')]),
  recognitionHead: t.Nullable(t.String()),
  recognition: t.Nullable(t.Union([t.Literal('recognized'), t.Literal('invalidated')])) });
const offeringRevisionView = t.Object({ profile: t.Literal('rights-offering-revision-v1'),
  offering: t.String(), revision: t.String(), kind: t.Union([t.Literal('offering'), t.Literal('recognition')]),
  state: literals(['open', 'ended', 'recognized', 'invalidated']), predecessor: t.Nullable(t.String()),
  actor: t.String(), dataEpoch: t.String(), sequence: t.String() });

export function rightsError(error: unknown): Response {
  if (error instanceof RightsOfferingInvalid) return problem(400, 'invalid_rights_offering', error.message);
  if (error instanceof RightsOfferingStale) return problem(409, 'stale_rights_offering', error.message);
  if (error instanceof RightsOfferingUnavailable) return problem(503, 'rights_offering_unavailable', error.message);
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
    .post('/v1/rights/offerings', {
      body: t.Object({ profile: t.Literal('rights-offering-create-v1'), target: agent,
        instrument, actingSubject: agent, idempotencyKey: t.String({ pattern: '^[A-Za-z0-9:_./-]{1,128}$' }) },
      { additionalProperties: false }),
      response: { 200: offeringResult, 201: offeringResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const keyError = requireGovernanceKey(request, body.idempotencyKey);
        if (keyError) return keyError;
        const { profile: _profile, ...input } = body;
        const result = await createAdmittedOffering(work.environment, work.account, work.access, request, input);
        return Response.json({ profile: 'rights-offering-operation-v1', receipt: result.receipt,
          admissionId: result.admissionId, offering: result.offering, revision: result.revision,
          action: result.action, dataEpoch: result.dataEpoch, sequence: result.sequence,
          replayed: result.replayed }, { status: result.replayed ? 200 : 201, ...noStore });
      } catch (error) { return rightsError(error); }
    })
    .post('/v1/rights/offerings/:offering/changes', {
      params: t.Object({ offering: uuid }),
      body: t.Object({ profile: t.Literal('rights-offering-change-v1'),
        action: literals(['end', 'recognize', 'invalidate']), actingSubject: agent,
        expectedOfferingHead: agent, expectedRecognitionHead: t.Nullable(agent),
        idempotencyKey: t.String({ pattern: '^[A-Za-z0-9:_./-]{1,128}$' }) }, { additionalProperties: false }),
      response: { 200: offeringResult, 201: offeringResult, ...writeProblems },
    }, async ({ request, body, params }) => {
      try {
        const keyError = requireGovernanceKey(request, body.idempotencyKey);
        if (keyError) return keyError;
        const { profile: _profile, ...input } = body;
        const result = await changeAdmittedOffering(work.environment, work.account, work.access, request,
          { ...input, offering: `https://rezics.com/id/${params.offering}` });
        return Response.json({ profile: 'rights-offering-operation-v1', receipt: result.receipt,
          admissionId: result.admissionId, offering: result.offering, revision: result.revision,
          action: result.action, dataEpoch: result.dataEpoch, sequence: result.sequence,
          replayed: result.replayed }, { status: result.replayed ? 200 : 201, ...noStore });
      } catch (error) { return rightsError(error); }
    })
    .get('/v1/rights/offerings/:offering', {
      params: t.Object({ offering: uuid }),
      query: t.Object({ actingSubject: agent }, { additionalProperties: false }),
      response: { 200: offeringView, ...writeProblems },
    }, async ({ request, params, query }) => {
      try {
        const principal = await work.account.verify(request, [RIGHTS_OFFER_SCOPE]);
        const view = await readOffering(work.environment, `https://rezics.com/id/${params.offering}`);
        if (!view || !await work.access.canReadWork(principal, query.actingSubject, view.target)) {
          return problem(404, 'not_found', 'Rights offering is unavailable');
        }
        return Response.json({ profile: 'rights-offering-v1', ...view }, noStore);
      } catch (error) { return rightsError(error); }
    })
    .get('/v1/rights/offerings/:offering/revisions/:revision', {
      params: t.Object({ offering: uuid, revision: uuid }),
      query: t.Object({ actingSubject: agent }, { additionalProperties: false }),
      response: { 200: offeringRevisionView, ...writeProblems },
    }, async ({ request, params, query }) => {
      try {
        const principal = await work.account.verify(request, [RIGHTS_OFFER_SCOPE]);
        const offering = `https://rezics.com/id/${params.offering}`;
        const view = await readOffering(work.environment, offering);
        if (!view || !await work.access.canReadWork(principal, query.actingSubject, view.target)) {
          return problem(404, 'not_found', 'Rights offering is unavailable');
        }
        const revision = await readOfferingRevision(work.environment, offering,
          `https://rezics.com/id/${params.revision}`);
        if (!revision) return problem(404, 'not_found', 'Rights offering revision is unavailable');
        return Response.json({ profile: 'rights-offering-revision-v1', ...revision }, noStore);
      } catch (error) { return rightsError(error); }
    })
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
        const keyError = requireGovernanceKey(request, body.idempotencyKey);
        if (keyError) return keyError;
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
        const keyError = requireGovernanceKey(request, body.idempotencyKey);
        if (keyError) return keyError;
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
      response: { 200: decisionResult, 202: decisionResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, [RIGHTS_DECIDE_SCOPE]);
        const keyError = requireGovernanceKey(request, body.idempotencyKey);
        if (keyError) return keyError;
        if (!deps.governance) return unavailable();
        const { profile: _profile, ...input } = body;
        const result = await deps.governance.store.decide(principal,
          input as Parameters<NonNullable<typeof deps.governance>['store']['decide']>[1], true);
        return Response.json({ profile: 'rights-restriction-v1', ...result },
          { status: result.operation.status === 'completed' ? 200 : 202, ...noStore });
      } catch (error) { return rightsError(error); }
    });
}
