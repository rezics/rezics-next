import { expect, mock, test } from 'bun:test';
import { claimRoutes } from '../src/routes/claims.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import { AdmissionDenied, type AdmissionRequest,
  type RegisteredAdmission } from '../src/modules/access/admission.ts';
import { analyzeClaimSupport, LINEAGE_BUDGET, type AnalysisInput, type EvidenceItem,
  type LineageLink, type LineageProof } from '../src/modules/verification/analysis.ts';
import { assessAdmittedClaim, type AssessClaimInput,
  type VerificationDependencies } from '../src/modules/verification/operations.ts';
import { VerificationDenied, type AnalysisSnapshot, type AssessmentProducerRecord, type AssessmentProducerStage,
  type VerificationStore } from '../src/modules/verification/store.ts';

const claim = { referent: 'urn:rezics:lineage:referent', context: 'urn:rezics:lineage:context',
  predicate: 'https://schema.org/datePublished', editionScope: null, validFrom: null, validUntil: null };

const observationItem = (observation: string, ordinal = 0): EvidenceItem => ({
  ordinal, stance: 'supports', availability: 'available', observation,
  contentRevision: null, graphReference: null,
});

const completeProof: LineageProof = { dependence: 'established', independentOrigins: 2,
  origins: ['origin:first', 'origin:second'] };

function input(extra: Partial<AnalysisInput> = {}): AnalysisInput {
  return { claim, evaluationContext: claim.context, items: [observationItem('root')],
    links: [], truncated: false, recordOf: new Map(), observedAt: new Map(),
    referencedClaims: new Map(), reliability: [], lineageProof: completeProof, ...extra };
}

test('partial lineage never establishes support or independence from a provisional proof or reliable source', () => {
  const result = analyzeClaimSupport(input({ truncated: true,
    recordOf: new Map([['root', 'record']]),
    observedAt: new Map([['root', '2026-10-01T00:00:00.000Z']]),
    reliability: [{ assessment: 'rating', source: 'record', domain: claim.predicate,
      context: claim.context, result: 'ReliableForDomain', applicableFrom: null, applicableUntil: null }] }));
  expect(result).toMatchObject({ dependence: 'over-budget', support: 'abstained', coverage: 'incomplete',
    independentOrigins: null, origins: [], work: { expansions: 0, links: 0 } });
  expect(result.reasons).toContain('lineage-over-budget');
  expect(result.reasons).not.toContain('independent-origins');
  expect(result.reasons).not.toContain('reliable-primary');
});

test('a completed durable proof establishes support beyond one node budget without repeating the traversal', () => {
  const links: LineageLink[] = Array.from({ length: LINEAGE_BUDGET * 3 }, (_, index) => ({
    source: index === 0 ? 'root' : `node:${index}`, relation: 'derived-from',
    targetObservation: `node:${index + 1}`, targetOrigin: null, targetReference: null,
  }));
  const result = analyzeClaimSupport(input({ links }));
  expect(result).toMatchObject({ dependence: 'established', support: 'supported', coverage: 'complete',
    independentOrigins: 2, origins: completeProof.origins, work: { expansions: 0, links: 0 } });
  expect(result.reasons).toContain('independent-origins');
  expect(result.reasons).not.toContain('lineage-over-budget');
});

test('the bounded origin preview does not replace the durable independent-origin count', () => {
  for (const origins of [[], ['origin:preview']]) {
    const result = analyzeClaimSupport(input({ lineageProof: {
      dependence: 'established', independentOrigins: LINEAGE_BUDGET * 3, origins,
    } }));
    expect(result).toMatchObject({ dependence: 'established', support: 'supported',
      independentOrigins: LINEAGE_BUDGET * 3, origins, work: { expansions: 0, links: 0 } });
  }
  const single = analyzeClaimSupport(input({ lineageProof: {
    dependence: 'established', independentOrigins: 1, origins: ['origin:single'],
  } }));
  expect(single).toMatchObject({ independentOrigins: 1, support: 'insufficient' });
  expect(single.reasons).toContain('single-origin');
});

test('a durable observation proof does not establish independence of supporting content or graph anchors', () => {
  const opaqueAnchors: EvidenceItem[] = [
    { ...observationItem('unused', 1), observation: null, contentRevision: 'content-revision' },
    { ...observationItem('unused', 1), observation: null, graphReference: 'urn:rezics:graph:revision' },
  ];
  for (const opaque of opaqueAnchors) {
    const result = analyzeClaimSupport(input({ items: [observationItem('root'), opaque] }));
    expect(result).toMatchObject({ dependence: 'unknown', support: 'insufficient',
      independentOrigins: null, origins: [], work: { expansions: 0, links: 0 } });
    expect(result.reasons).toContain('dependence-unknown');
  }
});

test('a completed circular proof abstains even when an origin preview and provisional count remain', () => {
  const result = analyzeClaimSupport(input({ lineageProof: { ...completeProof, dependence: 'circular' } }));
  expect(result).toMatchObject({ dependence: 'circular', support: 'abstained', coverage: 'incomplete',
    independentOrigins: null, origins: [], work: { expansions: 0, links: 0 } });
  expect(result.reasons).toContain('lineage-circular');
});

test('a completed unknown proof does not promote known branches into independent support', () => {
  const result = analyzeClaimSupport(input({ lineageProof: { ...completeProof, dependence: 'unknown' } }));
  expect(result).toMatchObject({ dependence: 'unknown', support: 'insufficient',
    independentOrigins: null, origins: [], work: { expansions: 0, links: 0 } });
  expect(result.reasons).toContain('dependence-unknown');
  expect(result.reasons).not.toContain('independent-origins');
});

const claimId = 'https://rezics.com/id/00000000-0000-0000-0000-000000000001';
const deniedIntent: AssessClaimInput & { idempotencyKey: string } = {
  claimRevision: 'https://rezics.com/id/00000000-0000-0000-0000-000000000002',
  evidenceSetRevision: 'https://rezics.com/id/00000000-0000-0000-0000-000000000003',
  actingSubject: 'https://rezics.com/id/00000000-0000-0000-0000-000000000004',
  lineageContinuation: '00000000-0000-0000-0000-000000000005:1',
  sourceAssessments: [], method: 'automated', judgment: null, evaluationContext: claim.context,
  adoptedRevision: null, scorePerMillion: null, calibration: null,
  limitations: 'Inspect exact evidence provenance.', expectedSummary: null, resolvesChallenges: [],
  idempotencyKey: 'verification-lineage-denied',
};

function deniedDependencies() {
  const forbidden = mock(async (): Promise<never> => { throw new Error('denied caller reached owner data'); });
  const verify = mock(async () => ({ issuer: 'https://account.example', subject: 'inactive-assessor' }));
  const activePrincipalId = mock(async () => null);
  const deps: VerificationDependencies = {
    account: { verify }, access: { activePrincipalId, register: forbidden, claim: forbidden,
      recordGraphOutcome: forbidden },
    env: { fuseki: { query: forbidden } } as unknown as VerificationDependencies['env'],
    store: { analysisSnapshot: forbidden } as unknown as VerificationStore,
  };
  return { deps, forbidden, verify, activePrincipalId };
}

test('an inactive assessor cannot read or advance a lineage continuation', async () => {
  const { deps, forbidden, verify, activePrincipalId } = deniedDependencies();
  const request = new Request('https://main.example/v1/claims/claim/assessments');
  await expect(assessAdmittedClaim(deps, request, claimId, deniedIntent))
    .rejects.toBeInstanceOf(VerificationDenied);
  expect(verify).toHaveBeenCalledWith(request, ['claim:assess']);
  expect(activePrincipalId).toHaveBeenCalledTimes(1);
  expect(forbidden).not.toHaveBeenCalled();
});

test('an Account-denied assessor cannot reach Access or lineage continuation state', async () => {
  const { deps, forbidden, activePrincipalId } = deniedDependencies();
  const denial = new AccountAssertionDenied('claim assessment consent is denied');
  deps.account.verify = mock(async (): Promise<never> => { throw denial; });
  await expect(assessAdmittedClaim(deps,
    new Request('https://main.example/v1/claims/claim/assessments'), claimId, deniedIntent)).rejects.toBe(denial);
  expect(activePrincipalId).not.toHaveBeenCalled();
  expect(forbidden).not.toHaveBeenCalled();
});

function admittedDependencies() {
  const forbidden = mock(async (): Promise<never> => { throw new Error('partial analysis reached a write'); });
  const bind = (value: string) => ({ type: 'uri', value });
  const query = mock(async (sparql: string) => {
    if (sparql.includes('ASK {')) return { boolean: true };
    if (sparql.includes('SELECT ?revision ?claim ?head ?source ?root')) return { results: { bindings: [] } };
    if (!sparql.includes('SELECT ?revision ?claim')) throw new Error('unexpected graph query');
    return { results: { bindings: [{ revision: bind(deniedIntent.claimRevision), claim: bind(claimId),
      head: bind(deniedIntent.claimRevision), referent: bind(claim.referent), context: bind(claim.context),
      predicate: bind(claim.predicate), value: { type: 'literal', value: '2000-01-01' },
      precision: bind('https://rezics.com/vocab/ExactValue'), status: bind('https://rezics.com/vocab/Asserted'),
      statedBy: bind(deniedIntent.actingSubject), recordedAt: { type: 'literal', value: '2026-10-01T00:00:00Z' },
      epoch: { type: 'literal', value: 'epoch' }, sequence: { type: 'literal', value: '1' } }] } };
  });
  let admission: RegisteredAdmission;
  const register = mock(async (request: AdmissionRequest): Promise<RegisteredAdmission> => {
    admission = { id: '00000000-0000-0000-0000-000000000006', principalId: 'assessor',
      actingSubject: request.actingSubject, scope: request.scope, action: request.action,
      idempotencyKey: request.idempotencyKey, requestDigest: request.requestDigest, authorityEpoch: 'authority:1',
      expiresAt: '2099-01-01T00:00:00Z', state: 'claimed', dispatchEligible: true, replayed: true };
    return admission;
  });
  const claimAdmission = mock(async () => ({ ...admission!, claimedAt: '2026-10-01T00:00:00Z' }));
  const snapshot: AnalysisSnapshot = {
    revision: { revision: deniedIntent.evidenceSetRevision, claim: claimId, claimRevision: deniedIntent.claimRevision,
      purpose: 'claim-head', predecessor: null, itemCount: 1, manifestDigest: 'digest',
      createdAt: '2026-10-01T00:00:00Z', items: [{ ordinal: 0, stance: 'supports', availability: 'available',
        currentAvailability: 'available', observation: 'root', selector: {} }] },
    evidenceHead: deniedIntent.evidenceSetRevision, links: [], truncated: true, visited: ['root'],
    lineageHeads: new Map(), dispositionHeads: new Map(), recordOf: new Map(), observedAt: new Map(),
    challenge: { revision: null, open: 0, resolved: 0 }, walk: '00000000-0000-0000-0000-000000000005',
    complete: false, lineageNodes: 80, continuation: '00000000-0000-0000-0000-000000000005:2', stepReplayed: false,
    work: { expansions: 40, links: 80 }, totalWork: { expansions: 80, links: 160 },
    lineageProof: { dependence: 'over-budget', independentOrigins: null, origins: [] },
  };
  const analysisSnapshot = mock(async (..._args: Parameters<VerificationStore['analysisSnapshot']>) => snapshot);
  let producer: AssessmentProducerRecord | null = null;
  const stageAssessmentProducer = mock(async (input: AssessmentProducerStage) => {
    producer = { ...input, stageGeneration: '0', restoreEpoch: '1', terminal: null };
    return { row: producer, permit: { mode: 'ordinary' as const, job: null, generation: '0', restoreEpoch: '1' } };
  });
  const deps: VerificationDependencies = {
    account: { verify: async () => ({ issuer: 'https://account.example', subject: 'assessor' }) },
    access: { activePrincipalId: async () => 'assessor', register, claim: claimAdmission,
      recordGraphOutcome: forbidden },
    env: { fuseki: { query, update: forbidden }, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } } as unknown as VerificationDependencies['env'],
    store: { analysisSnapshot, stageAssessmentProducer, readAssessmentProducer: async () => producer,
      activateSummary: forbidden, resolveChallenges: forbidden } as unknown as VerificationStore,
  };
  return { deps, forbidden, query, analysisSnapshot, snapshot };
}

test('a partial human review never records or activates its requested supported judgment', async () => {
  const { deps, forbidden, analysisSnapshot, snapshot } = admittedDependencies();
  const result = await assessAdmittedClaim(deps,
    new Request('https://main.example/v1/claims/claim/assessments'), claimId,
    { ...deniedIntent, method: 'human-review', judgment: 'supported' });
  expect(result).toMatchObject({ status: 'analysis-partial', assessment: null,
    activation: { status: 'analysis-partial' }, analysis: { support: 'abstained', dependence: 'over-budget',
      independentOrigins: null, coverage: 'incomplete', origins: [], lineageComplete: false,
      lineageContinuation: snapshot.continuation, work: snapshot.work, totalWork: snapshot.totalWork } });
  expect(analysisSnapshot).toHaveBeenCalledTimes(1);
  expect(analysisSnapshot.mock.calls[0]?.[2]).toMatchObject({ principal: 'assessor',
    actingSubject: deniedIntent.actingSubject, scope: 'verification:assess:global', authorityEpoch: 'authority:1' });
  expect(forbidden).not.toHaveBeenCalled();
});

test('a refused Access claim cannot advance a previously claimed continuation', async () => {
  const { deps, analysisSnapshot } = admittedDependencies();
  const denial = new AdmissionDenied('assessment authority was revoked after registration');
  deps.access.claim = mock(async (): Promise<never> => { throw denial; });
  await expect(assessAdmittedClaim(deps,
    new Request('https://main.example/v1/claims/claim/assessments'), claimId, deniedIntent)).rejects.toBe(denial);
  expect(analysisSnapshot).not.toHaveBeenCalled();
});


test('the assessment API returns an explicit 202 continuation with incomplete support', async () => {
  const { deps, snapshot, forbidden } = admittedDependencies();
  const app = claimRoutes({ environment: deps.env, account: deps.account, access: deps.access,
    verification: deps.store } as unknown as MainWorkDependencies);
  const { idempotencyKey, ...intent } = deniedIntent;
  const response = await app.handle(new Request(
    'http://localhost/v1/claims/00000000-0000-0000-0000-000000000001/assessments', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify({ profile: 'claim-assessment-v1', ...intent, method: 'human-review', judgment: 'supported' }),
    }));
  expect(response.status).toBe(202);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toMatchObject({ status: 'analysis-partial', assessment: null,
    analysis: { lineageContinuation: snapshot.continuation, lineageComplete: false,
      support: 'abstained', coverage: 'incomplete', independentOrigins: null,
      applicableSourceAssessments: [], work: { expansions: 40, links: 80 } } });
  expect(forbidden).not.toHaveBeenCalled();
});
