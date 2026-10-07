import { Elysia, t } from 'elysia';
import { pendingOperation, problemResult } from '../api-contract.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import { AdmissionDenied, AdmissionExpired } from '../modules/access/admission.ts';
import { InvalidVerificationInput, readAssessment, readClaimRevisions, VerificationGraphStale }
  from '../modules/verification/graph.ts';
import { assessAdmittedClaim, createAdmittedClaim, PendingVerification, readClaimQuality,
  recordAdmittedReliability, type VerificationDependencies } from '../modules/verification/operations.ts';
import { nativeId, VerificationConflict, VerificationDenied, VerificationInvalid, VerificationMissing,
  VerificationStale, VerificationUnavailable } from '../modules/verification/store.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

export const openApiOperations = {
  '/v1/claims': { post: { rateLimitFamily: 'write', exposure: 'platform:wiki-agents', bearer: true, idempotencyKey: true } },
  '/v1/claims/{claim}': { get: { rateLimitFamily: 'read', exposure: 'platform:wiki-agents', bearer: true } },
  '/v1/source-reliability-assessments': { post: { rateLimitFamily: 'write', exposure: 'platform:wiki-agents', bearer: true, idempotencyKey: true } },
  '/v1/claims/{claim}/assessments': { post: { rateLimitFamily: 'write', exposure: 'platform:wiki-agents', bearer: true, idempotencyKey: true } },
  '/v1/claims/{claim}/assessments/{assessment}': { get: { rateLimitFamily: 'read', exposure: 'platform:wiki-agents', bearer: true } },
  '/v1/claims/{claim}/evidence': { post: { rateLimitFamily: 'write', exposure: 'platform:wiki-agents', bearer: true, idempotencyKey: true } },
  '/v1/claims/{claim}/evidence/{revision}': { get: { rateLimitFamily: 'read', exposure: 'platform:wiki-agents', bearer: true } },
  '/v1/claims/{claim}/challenges': { post: { rateLimitFamily: 'write', exposure: 'platform:wiki-agents', bearer: true, idempotencyKey: true }, get: { rateLimitFamily: 'read', exposure: 'platform:wiki-agents', bearer: true } },
  '/v1/claims/{claim}/challenges/{challenge}/withdrawal': { post: { rateLimitFamily: 'write', exposure: 'platform:wiki-agents', bearer: true, idempotencyKey: true } },
  '/v1/claims/{claim}/corrections': { get: { rateLimitFamily: 'read', exposure: 'platform:wiki-agents', bearer: true } },
  '/v1/claims/{claim}/correction-subscriptions': { post: { rateLimitFamily: 'write', exposure: 'platform:update-subscriptions', bearer: true, idempotencyKey: true } },
  '/v1/verification/origins': { post: { rateLimitFamily: 'write', exposure: 'platform:wiki-agents', bearer: true, idempotencyKey: true } },
  '/v1/sources/observations/{observation}/lineage': { post: { rateLimitFamily: 'write', exposure: 'platform:wiki-agents', bearer: true, idempotencyKey: true } },
  '/v1/sources/observations/{observation}/disposition': { post: { rateLimitFamily: 'write', exposure: 'platform:wiki-agents', bearer: true, idempotencyKey: true } },
  '/v1/verification/lineage/{edge}/retraction': { post: { rateLimitFamily: 'write', exposure: 'platform:wiki-agents', bearer: true, idempotencyKey: true } },
  '/v1/sources/observations/{observation}/derivation': { post: { rateLimitFamily: 'write', exposure: 'platform:wiki-agents', bearer: true, idempotencyKey: true } },
} as const;

const uuid = t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const nativeRef = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const reference = t.String({ minLength: 1, maxLength: 300, pattern: '^(https://|urn:)[^\\s<>"{}|\\\\^`]+$' });
const instant = t.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?Z$' });
const note = t.String({ minLength: 1, maxLength: 2000 });
const openResult = t.Object({}, { additionalProperties: true });
const written = { 200: openResult, 201: openResult, 202: pendingOperation, ...writeProblems,
  404: problemResult(404), 422: problemResult(422) };
const walkWork = t.Object({ expansions: t.Integer({ minimum: 0 }), links: t.Integer({ minimum: 0 }) });
const assessmentWritten = { ...written, 202: t.Union([pendingOperation, t.Object({
  status: t.Literal('analysis-partial'), assessment: t.Null(), replayed: t.Boolean(),
  activation: t.Object({ status: t.Literal('analysis-partial') }),
  analysis: t.Object({ support: t.Literal('abstained'), coverage: t.Literal('incomplete'),
    dependence: t.Literal('over-budget'), independentOrigins: t.Null(), origins: t.Array(t.String(), { maxItems: 0 }),
    reasons: t.Array(t.String()), applicableSourceAssessments: t.Array(reference, { maxItems: 32 }),
    work: t.Object({ expansions: t.Integer({ minimum: 0, maximum: 40 }), links: t.Integer({ minimum: 0, maximum: 160 }) }),
    totalWork: walkWork, lineageNodes: t.Integer({ minimum: 0 }), lineageComplete: t.Literal(false),
    lineageContinuation: t.String({ maxLength: 60, pattern: '^[0-9a-f-]{36}:[0-9]+$' }),
  }),
})]) };
const read = { 200: openResult, ...authorizedReadProblems };

const evidenceItem = t.Object({
  stance: t.Union([t.Literal('supports'), t.Literal('contradicts'), t.Literal('uncertain')]),
  observation: t.Optional(uuid), contentRevision: t.Optional(uuid), graphReference: t.Optional(reference),
  selector: t.Record(t.String(), t.Unknown()),
  availability: t.Union([t.Literal('available'), t.Literal('inaccessible'), t.Literal('withdrawn'), t.Literal('erased')]),
}, { additionalProperties: false });
const lineageTarget = t.Object({ observation: t.Optional(uuid), origin: t.Optional(uuid),
  reference: t.Optional(reference) }, { additionalProperties: false });

function claimError(error: unknown): Response {
  if (error instanceof PendingVerification) {
    return Response.json({ operationId: error.operationId, status: 'reconciling', phase: 'verification',
      result: null, retry: { allowed: true, afterMs: 1000 } }, { status: 202,
      headers: { 'cache-control': 'no-store', 'retry-after': '1' } });
  }
  if (error instanceof InvalidVerificationInput || error instanceof VerificationInvalid) {
    return problem(400, 'invalid_verification_request', 'Verification request fields are invalid');
  }
  if (error instanceof VerificationDenied || error instanceof AdmissionDenied) {
    return problem(403, 'authority_denied', 'Verification authority is not granted');
  }
  if (error instanceof VerificationMissing) return problem(404, 'verification_record_unavailable', error.message);
  if (error instanceof AdmissionExpired) return problem(409, 'admission_expired', 'Verification admission expired; retry with a new Idempotency-Key');
  if (error instanceof VerificationStale || error instanceof VerificationGraphStale) {
    return problem(409, 'stale_head', error.message);
  }
  if (error instanceof VerificationConflict) return problem(409, 'idempotency_conflict', error.message);
  if (error instanceof VerificationUnavailable) return problem(503, 'verification_unavailable', 'Verification owner is unavailable');
  return commandError(error);
}

const keyOf = (request: Request) => {
  const key = request.headers.get('idempotency-key');
  return key && /^[A-Za-z0-9:_./-]{1,128}$/.test(key) ? key : null;
};

export function claimRoutes(work: MainWorkDependencies) {
  const store = work.verification;
  const deps = (): VerificationDependencies => {
    if (!store) throw new VerificationUnavailable('verification owner is not configured');
    return { env: work.environment, account: work.account, access: work.access, store };
  };
  const principal = async (request: Request, scope: string) => {
    const id = await work.access.activePrincipalId(await work.account.verify(request, [scope]));
    if (!id) throw new VerificationDenied('principal is inactive');
    return id;
  };
  const respond = (result: { replayed: boolean; status?: string }) => Response.json(result,
    { status: result.status === 'analysis-partial' ? 202 : result.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
  const ok = (result: unknown) => Response.json(result, { headers: { 'cache-control': 'no-store' } });
  const keyed = async (request: Request, run: (key: string) => Promise<Response>) => {
    const key = keyOf(request);
    if (!key) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
    try { return await run(key); } catch (error) { return claimError(error); }
  };

  return new Elysia()
    .post('/v1/claims', {
      body: t.Object({ profile: t.Literal('claim-create-v1'), referent: reference,
        interpretationContext: reference, propositionPredicate: reference,
        value: t.Union([t.Object({ kind: t.Literal('iri'), iri: reference }, { additionalProperties: false }),
          t.Object({ kind: t.Literal('literal'), lexical: t.String({ minLength: 1, maxLength: 2000 }),
            datatype: t.Union([t.Literal('string'), t.Literal('date'), t.Literal('dateTime'), t.Literal('integer')]) },
          { additionalProperties: false })]),
        valuePrecision: t.Union([t.Literal('exact'), t.Literal('approximate'), t.Literal('uncertain')]),
        valueQualifiers: t.Array(t.Union([t.Literal('disputed-attribution'), t.Literal('inferred')]), { maxItems: 2 }),
        validFrom: t.Nullable(instant), validUntil: t.Nullable(instant), editionScope: t.Nullable(reference),
        actingSubject: nativeRef }, { additionalProperties: false }),
      response: written,
    }, ({ request, body }) => keyed(request, async key => {
      const { profile: _profile, ...input } = body;
      return respond(await createAdmittedClaim(deps(), request, { ...input, idempotencyKey: key }));
    }))
    .get('/v1/claims/:claim', {
      params: t.Object({ claim: uuid }), query: t.Object({ context: t.Optional(reference) }),
      response: read,
    }, async ({ request, params, query }) => {
      try {
        await principal(request, 'claim:read');
        const result = await readClaimQuality(deps(), nativeId(params.claim), query.context ?? null);
        return result ? ok(result) : problem(404, 'claim_unavailable', 'Claim is unavailable');
      } catch (error) { return claimError(error); }
    })
    .post('/v1/source-reliability-assessments', {
      body: t.Object({ profile: t.Literal('source-reliability-assessment-v1'), source: nativeRef,
        domainDefinition: reference, evaluationContext: reference, expectedHead: t.Nullable(nativeRef),
        result: t.Union([t.Literal('ReliableForDomain'), t.Literal('MixedReliability'),
          t.Literal('UnreliableForDomain'), t.Literal('UntestedForDomain')]),
        method: reference, methodRevision: reference, calibration: t.Nullable(reference),
        applicableFrom: t.Nullable(instant), applicableUntil: t.Nullable(instant),
        inputDigest: t.String({ pattern: '^[0-9a-f]{64}$' }), inputCount: t.Integer({ minimum: 0, maximum: 32 }),
        limitations: note, rationale: t.Nullable(t.String({ minLength: 1, maxLength: 4000 })),
        assessorKind: t.Union([t.Literal('human'), t.Literal('automated')]), actingSubject: nativeRef,
      }, { additionalProperties: false }),
      response: written,
    }, ({ request, body }) => keyed(request, async key => {
      const { profile: _profile, ...input } = body;
      return respond(await recordAdmittedReliability(deps(), request, { ...input, idempotencyKey: key }));
    }))
    .post('/v1/claims/:claim/assessments', {
      params: t.Object({ claim: uuid }),
      body: t.Object({ profile: t.Literal('claim-assessment-v1'), claimRevision: nativeRef,
        evidenceSetRevision: nativeRef, lineageContinuation: t.Optional(t.String({ maxLength: 60, pattern: '^[0-9a-f-]{36}:[0-9]+$' })), sourceAssessments: t.Array(nativeRef, { maxItems: 32 }),
        method: t.Union([t.Literal('automated'), t.Literal('human-review')]),
        judgment: t.Nullable(t.Union([t.Literal('supported'), t.Literal('contradicted'),
          t.Literal('material-conflict'), t.Literal('insufficient')])),
        evaluationContext: reference, adoptedRevision: t.Nullable(reference),
        scorePerMillion: t.Nullable(t.Integer({ minimum: 0, maximum: 1_000_000 })),
        calibration: t.Nullable(reference), evaluationReference: t.Optional(t.Nullable(reference)),
        limitations: note, expectedSummary: t.Nullable(nativeRef),
        resolvesChallenges: t.Array(uuid, { maxItems: 8 }), actingSubject: nativeRef,
      }, { additionalProperties: false }),
      response: assessmentWritten,
    }, ({ request, params, body }) => keyed(request, async key => {
      const { profile: _profile, ...input } = body;
      return respond(await assessAdmittedClaim(deps(), request, nativeId(params.claim),
        { ...input, idempotencyKey: key }));
    }))
    .get('/v1/claims/:claim/assessments/:assessment', {
      params: t.Object({ claim: uuid, assessment: uuid }), response: read,
    }, async ({ request, params }) => {
      try {
        const reader = await principal(request, 'claim:read');
        const assessment = await readAssessment(work.environment, nativeId(params.assessment));
        if (!assessment || assessment.claim !== nativeId(params.claim)) {
          return problem(404, 'assessment_unavailable', 'Assessment is unavailable');
        }
        // The exact manifest it cited, with current availability; never the current head.
        const evidence = await deps().store.readEvidenceFor(assessment.evidenceSetRevision.split('/').at(-1)!, reader);
        return ok({ assessment, evidence, evidenceAvailability: evidence ? 'available' : 'inaccessible' });
      } catch (error) { return claimError(error); }
    })
    .post('/v1/claims/:claim/evidence', {
      params: t.Object({ claim: uuid }),
      body: t.Object({ profile: t.Literal('claim-evidence-v1'), claimRevision: nativeRef,
        expectedHead: t.Nullable(uuid), items: t.Array(evidenceItem, { maxItems: 64 }) },
      { additionalProperties: false }),
      response: written,
    }, ({ request, params, body }) => keyed(request, async key => {
      const id = await principal(request, 'claim:evidence');
      await claimRevisionOf(params.claim, body.claimRevision);
      return respond(await deps().store.recordEvidence(id, key, nativeId(params.claim), body));
    }))
    .get('/v1/claims/:claim/evidence/:revision', {
      params: t.Object({ claim: uuid, revision: uuid }), response: read,
    }, async ({ request, params }) => {
      try {
        const reader = await principal(request, 'claim:read');
        const evidence = await deps().store.readEvidenceFor(params.revision, reader);
        return evidence && evidence.claim === nativeId(params.claim) ? ok(evidence)
          : problem(404, 'evidence_unavailable', 'Evidence revision is unavailable');
      } catch (error) { return claimError(error); }
    })
    .post('/v1/claims/:claim/challenges', {
      params: t.Object({ claim: uuid }),
      body: t.Object({ profile: t.Literal('claim-challenge-v1'), claimRevision: nativeRef,
        adoptedRevision: t.Nullable(reference), context: reference, reason: note,
        counterevidence: t.Array(evidenceItem, { maxItems: 64 }), actingSubject: nativeRef },
      { additionalProperties: false }),
      response: written,
    }, ({ request, params, body }) => keyed(request, async key => {
      const id = await principal(request, 'claim:challenge');
      await claimRevisionOf(params.claim, body.claimRevision);
      const { profile: _profile, ...input } = body;
      return respond(await deps().store.submitChallenge(id, key, nativeId(params.claim), input));
    }))
    .get('/v1/claims/:claim/challenges', {
      params: t.Object({ claim: uuid }), response: read,
    }, async ({ request, params }) => {
      try {
        await principal(request, 'claim:read');
        return ok({ challenges: await deps().store.listChallenges(nativeId(params.claim)) });
      } catch (error) { return claimError(error); }
    })
    .post('/v1/claims/:claim/challenges/:challenge/withdrawal', {
      params: t.Object({ claim: uuid, challenge: uuid }),
      body: t.Object({ profile: t.Literal('claim-challenge-withdrawal-v1'), reason: note, actingSubject: nativeRef },
        { additionalProperties: false }),
      response: written,
    }, ({ request, params, body }) => keyed(request, async key => {
      const id = await principal(request, 'claim:challenge');
      return respond(await deps().store.withdrawChallenge(id, key, nativeId(params.claim), params.challenge,
        { reason: body.reason, actingSubject: body.actingSubject }));
    }))
    .get('/v1/claims/:claim/corrections', {
      params: t.Object({ claim: uuid }), query: t.Object({ context: reference }), response: read,
    }, async ({ request, params, query }) => {
      try {
        await principal(request, 'claim:read');
        return ok({ corrections: await deps().store.corrections(nativeId(params.claim), query.context) });
      } catch (error) { return claimError(error); }
    })
    .post('/v1/claims/:claim/correction-subscriptions', {
      params: t.Object({ claim: uuid }),
      body: t.Object({ profile: t.Literal('verification-correction-subscription-v1'),
        context: reference, expectedHead: t.Nullable(uuid),
        state: t.Union([t.Literal('subscribed'), t.Literal('unsubscribed')]) },
      { additionalProperties: false }), response: written,
    }, ({ request, params, body }) => keyed(request, async key => {
      const reader = await principal(request, 'claim:read');
      const claim = nativeId(params.claim);
      if (!(await readClaimQuality(deps(), claim, body.context))?.quality) {
        return problem(404, 'claim_unavailable', 'Claim is unavailable');
      }
      return respond(await deps().store.setCorrectionSubscription(reader, key, claim, body));
    }))
    .post('/v1/verification/origins', {
      body: t.Object({ profile: t.Literal('verification-origin-v1'),
        kind: t.Union([t.Literal('publication'), t.Literal('dataset'), t.Literal('statement'), t.Literal('native')]),
        locator: t.String({ minLength: 1, maxLength: 1000 }) }, { additionalProperties: false }),
      response: written,
    }, ({ request, body }) => keyed(request, async key => respond(await deps().store.recordOrigin(
      await principal(request, 'claim:lineage'), key, { kind: body.kind, locator: body.locator }))))
    .post('/v1/sources/observations/:observation/lineage', {
      params: t.Object({ observation: uuid }),
      body: t.Object({ profile: t.Literal('verification-lineage-edge-v1'),
        relation: t.Union([t.Literal('copy-of'), t.Literal('quotation-of'), t.Literal('derived-from'),
          t.Literal('publishes-origin')]), target: lineageTarget,
        basis: t.Union([t.Literal('declared-by-source'), t.Literal('detected'), t.Literal('reviewer-asserted')]),
        method: t.Nullable(reference) }, { additionalProperties: false }),
      response: written,
    }, ({ request, params, body }) => keyed(request, async key => respond(await deps().store.recordLineage(
      await principal(request, 'claim:lineage'), key, params.observation,
      { relation: body.relation, target: body.target, basis: body.basis, method: body.method }))))
    .post('/v1/sources/observations/:observation/disposition', {
      params: t.Object({ observation: uuid }),
      body: t.Object({ profile: t.Literal('verification-observation-disposition-v1'),
        expectedHead: t.Nullable(uuid),
        state: t.Union([t.Literal('available'), t.Literal('inaccessible'), t.Literal('withdrawn')]),
        reason: note }, { additionalProperties: false }),
      response: written,
    }, ({ request, params, body }) => keyed(request, async key => respond(
      await deps().store.recordObservationDisposition(await principal(request, 'claim:lineage'),
        key, params.observation, body))))
    .post('/v1/verification/lineage/:edge/retraction', {
      params: t.Object({ edge: uuid }),
      body: t.Object({ profile: t.Literal('verification-lineage-retraction-v1'), reason: note },
        { additionalProperties: false }),
      response: written,
    }, ({ request, params, body }) => keyed(request, async key => respond(await deps().store.retractLineage(
      await principal(request, 'claim:lineage'), key, params.edge, body.reason))))
    .post('/v1/sources/observations/:observation/derivation', {
      params: t.Object({ observation: uuid }),
      body: t.Object({ profile: t.Literal('verification-derivation-v1'),
        kind: t.Union([t.Literal('ai-extraction'), t.Literal('ai-generation'), t.Literal('tool-extraction'),
          t.Literal('human-transcription'), t.Literal('syndication-import')]),
        method: reference, model: t.Nullable(t.String({ minLength: 1, maxLength: 200 })),
        toolVersion: t.Nullable(t.String({ minLength: 1, maxLength: 200 })), profileRevision: t.Nullable(reference),
        limitations: note, inputs: t.Array(lineageTarget, { minItems: 1, maxItems: 32 }) },
      { additionalProperties: false }),
      response: written,
    }, ({ request, params, body }) => keyed(request, async key => {
      const { profile: _profile, ...input } = body;
      return respond(await deps().store.recordDerivation(await principal(request, 'claim:lineage'), key,
        params.observation, input));
    }));

  async function claimRevisionOf(claim: string, revision: string): Promise<void> {
    const record = (await readClaimRevisions(work.environment, [revision])).get(revision);
    if (!record || record.claim !== nativeId(claim)) throw new VerificationMissing('claim revision is unavailable');
  }
}
