// Admitted verification commands. Graph records follow the Access admission →
// guarded graph command → receipt → recorded outcome template; Content-owned
// effects (challenge resolution, summary activation, invalidation) run after the
// graph receipt and are idempotent per admission, so a lost response or crash
// between stores resolves by replaying the same request.
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry,
  type RegisteredAdmission } from '../access/admission.ts';
import { CancelledActivation, IdempotencyConflict, PendingActivation, hash,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { analyzeClaimSupport, currentVerificationHead, HUMAN_REVIEW_METHOD, SUMMARY_POLICY, SUPPORT_METHOD,
  type AnalysisResult, type ClaimScope, type Support } from './analysis.ts';
import { ADMISSIONS, claimDigest, createClaim, graphHeads, InvalidVerificationInput, native,
  readAcceptance, readAssessment, readClaimHead, readClaimRevisions, readReliability, readReceipt, recordAssessment,
  recordReliability, reliabilityDigest, sealVerificationAdmission,
  VerificationGraphStale, type ClaimRecord, type CreateClaimInput, type Family, type GraphReceipt,
  type ReliabilityInput } from './graph.ts';
import { uuidOf, VerificationDenied, VerificationMissing, VerificationStale,
  type ActivationOutcome, type Dependency, type VerificationStore } from './store.ts';
import { verificationLimits } from './schema.ts';

export class PendingVerification extends PendingActivation {
  constructor(readonly operationId: string) { super('verification outcome requires reconciliation'); }
}

export interface VerificationDependencies {
  env: WorkActivationEnvironment;
  account: Pick<AccountAssertionVerifier, 'verify'>;
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome' | 'activePrincipalId'>;
  store: VerificationStore;
}

const RESULTS: Record<Family, readonly string[]> = {
  'claim-create': ['claim', 'claimRevision'],
  'reliability-assess': ['reliabilityScope', 'reliabilityRevision'],
  'claim-assess': ['assessment'],
};

/** Access admission around one graph command, sealing undispatchable admissions. */
async function admitted(deps: VerificationDependencies, request: Request, family: Family,
  intent: { actingSubject: string; idempotencyKey: string; digest: string },
  execute: (admission: RegisteredAdmission) => Promise<GraphReceipt>, unavailable: (error: unknown) => boolean = () => false,
): Promise<GraphReceipt & { replayed: boolean; admission: RegisteredAdmission }> {
  await assertGraphAdmissionOpen(deps.env.fuseki, deps.env.lineage);
  const { scope, action, accountScope } = ADMISSIONS[family];
  const principal = await deps.account.verify(request, [accountScope]);
  const registered = await deps.access.register({ principal, actingSubject: intent.actingSubject, scope, action,
    idempotencyKey: intent.idempotencyKey, requestDigest: intent.digest });
  try {
    let admission: RegisteredAdmission = registered;
    if (registered.state !== 'sealed' && registered.dispatchEligible) {
      try { admission = await deps.access.claim(registered.id, intent.digest); }
      catch (error) { if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error; }
    }
    if (admission.state !== 'sealed') {
      if (!admission.dispatchEligible || admission.state === 'registered') {
        await sealVerificationAdmission(deps.env, admission, family, RESULTS[family]);
      } else {
        try { await execute(admission); }
        catch (error) {
          if (error instanceof IdempotencyConflict || error instanceof InvalidVerificationInput) throw error;
          // A refused basis seals the admission, then reports the refusal itself.
          if (unavailable(error)) {
            await sealVerificationAdmission(deps.env, admission, family, RESULTS[family]);
            throw error;
          }
        }
      }
    }
    const terminal = await readReceipt(deps.env, registered.id, family, RESULTS[family]);
    if (!terminal) throw new PendingVerification(registered.id);
    await deps.access.recordGraphOutcome(registered.id, terminal);
    if (terminal.requestDigest !== intent.digest || terminal.admissionId !== registered.id
      || terminal.authorityEpoch !== registered.authorityEpoch || terminal.scope !== registered.scope) {
      throw new IdempotencyConflict('verification admission differs from graph receipt');
    }
    if (terminal.outcome === 'cancelled') {
      if (!registered.dispatchEligible) throw new AdmissionDenied('verification authority is not granted');
      throw new CancelledActivation('verification command was cancelled');
    }
    return { ...terminal, replayed: registered.replayed, admission: registered };
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof CancelledActivation
      || error instanceof AdmissionDenied || error instanceof InvalidVerificationInput
      || error instanceof VerificationGraphStale || error instanceof VerificationStale
      || error instanceof VerificationMissing || error instanceof PendingVerification) throw error;
    throw new PendingVerification(registered.id);
  }
}

// ----------------------------------------------------------------- claims

export async function createAdmittedClaim(deps: VerificationDependencies, request: Request,
  input: CreateClaimInput & { idempotencyKey: string }) {
  const digest = claimDigest(input);
  const receipt = await admitted(deps, request, 'claim-create',
    { actingSubject: input.actingSubject, idempotencyKey: input.idempotencyKey, digest },
    admission => createClaim(deps.env, admission, input));
  const record = (await readClaimRevisions(deps.env, [receipt.result.claimRevision!])).get(receipt.result.claimRevision!);
  if (!record) throw new PendingVerification(receipt.admissionId);
  return { claim: claimView(receipt.result.claimRevision!, record), receipt: receipt.receipt,
    sourcePosition: { datasetId: 'product' as const, dataEpoch: receipt.dataEpoch, sequence: receipt.sequence },
    replayed: receipt.replayed };
}

export function claimView(revision: string, record: ClaimRecord) {
  return { claim: record.claim, revision, head: record.head, referent: record.referent,
    interpretationContext: record.interpretationContext, propositionPredicate: record.propositionPredicate,
    value: record.value, valuePrecision: record.valuePrecision, valueQualifiers: record.valueQualifiers,
    validFrom: record.validFrom, validUntil: record.validUntil, editionScope: record.editionScope,
    claimStatus: record.claimStatus, statedBy: record.statedBy, recordedAt: record.recordedAt };
}

// ------------------------------------------------------- source reliability

export async function recordAdmittedReliability(deps: VerificationDependencies, request: Request,
  input: ReliabilityInput & { idempotencyKey: string }) {
  const digest = reliabilityDigest(input);
  const receipt = await admitted(deps, request, 'reliability-assess',
    { actingSubject: input.actingSubject, idempotencyKey: input.idempotencyKey, digest },
    admission => recordReliability(deps.env, admission, input), error => error instanceof VerificationGraphStale);
  // The graph receipt is the owner event; replays record the same invalidation once.
  await deps.store.recordGraphInvalidation(receipt.receipt, 'source-assessment', receipt.result.reliabilityScope!,
    receipt.result.reliabilityRevision!, receipt);
  return { scope: receipt.result.reliabilityScope!, assessment: receipt.result.reliabilityRevision!,
    source: input.source, domainDefinition: input.domainDefinition, evaluationContext: input.evaluationContext,
    predecessor: input.expectedHead, result: input.result, receipt: receipt.receipt,
    sourcePosition: { datasetId: 'product' as const, dataEpoch: receipt.dataEpoch, sequence: receipt.sequence },
    replayed: receipt.replayed };
}

// ------------------------------------------------------- claim assessments

export interface AssessClaimInput {
  claimRevision: string; evidenceSetRevision: string; sourceAssessments: readonly string[];
  method: 'automated' | 'human-review'; judgment: Exclude<Support, 'abstained'> | null;
  evaluationContext: string; adoptedRevision: string | null;
  scorePerMillion: number | null; calibration: string | null; limitations: string;
  expectedSummary: string | null; resolvesChallenges: readonly string[]; actingSubject: string;
}

function assessmentDigest(claim: string, input: AssessClaimInput): string {
  native(claim, 'claim');
  native(input.claimRevision, 'claimRevision');
  native(input.evidenceSetRevision, 'evidenceSetRevision');
  native(input.actingSubject, 'actingSubject');
  if (input.expectedSummary !== null) native(input.expectedSummary, 'expectedSummary');
  if (input.sourceAssessments.length > verificationLimits.sourceAssessments
    || new Set(input.sourceAssessments).size !== input.sourceAssessments.length
    || input.resolvesChallenges.length > 8 || new Set(input.resolvesChallenges).size !== input.resolvesChallenges.length
    || (input.method === 'human-review') !== (input.judgment !== null)
    || !input.limitations.trim() || input.limitations.length > 2000
    || (input.scorePerMillion !== null && (!Number.isInteger(input.scorePerMillion)
      || input.scorePerMillion < 0 || input.scorePerMillion > 1_000_000))
    || (input.calibration !== null && input.scorePerMillion === null)) {
    throw new InvalidVerificationInput('assessment request is invalid');
  }
  for (const item of input.sourceAssessments) native(item, 'sourceAssessment');
  return hash(JSON.stringify({ family: 'claim-assessment-v1', claim, ...input,
    sourceAssessments: [...input.sourceAssessments].sort(), resolvesChallenges: [...input.resolvesChallenges].sort() }));
}

interface Basis {
  record: ClaimRecord; analysis: AnalysisResult; support: Support;
  snapshot: Awaited<ReturnType<VerificationStore['analysisSnapshot']>>;
  reliability: Awaited<ReturnType<typeof readReliability>>;
  acceptance: Awaited<ReturnType<typeof readAcceptance>>;
}

/** Load exact inputs and apply the deterministic method; every basis head must be current. */
async function assessmentBasis(deps: VerificationDependencies, claim: string, input: AssessClaimInput,
  requireCurrent: boolean): Promise<Basis> {
  const records = await readClaimRevisions(deps.env, [input.claimRevision]);
  const record = records.get(input.claimRevision);
  if (!record || record.claim !== claim) throw new VerificationMissing('claim revision is unavailable');
  const evidence = uuidOf(input.evidenceSetRevision);
  if (!evidence) throw new VerificationMissing('evidence revision is unavailable');
  const snapshot = await deps.store.analysisSnapshot(claim, evidence);
  const reliability = await readReliability(deps.env, input.sourceAssessments);
  const acceptance = input.adoptedRevision ? await readAcceptance(deps.env, input.adoptedRevision, claim) : null;
  if (input.adoptedRevision && !acceptance) throw new VerificationMissing('acceptance decision is unavailable');
  if (reliability.size !== input.sourceAssessments.length) {
    throw new VerificationMissing('source assessment is unavailable');
  }
  if (requireCurrent && (record.head !== input.claimRevision || snapshot.evidenceHead !== input.evidenceSetRevision
    || [...reliability.values()].some(item => !item.current)
    || (acceptance && acceptance.head !== input.adoptedRevision))) {
    throw new VerificationStale('assessment basis is no longer current');
  }
  const graphItems = snapshot.revision.items.flatMap(item => item.graphReference ? [item.graphReference] : []);
  const referenced = await readClaimRevisions(deps.env, graphItems);
  const scope = (value: ClaimRecord): ClaimScope => ({ referent: value.referent, context: value.interpretationContext,
    predicate: value.propositionPredicate, editionScope: value.editionScope, validFrom: value.validFrom,
    validUntil: value.validUntil });
  const analysis = analyzeClaimSupport({ claim: scope(record), evaluationContext: input.evaluationContext,
    items: snapshot.revision.items.map(item => ({ ordinal: item.ordinal, stance: item.stance,
      availability: item.currentAvailability as 'available', observation: item.observation ?? null,
      contentRevision: item.contentRevision ?? null, graphReference: item.graphReference ?? null })),
    links: snapshot.links, truncated: snapshot.truncated, recordOf: snapshot.recordOf,
    observedAt: snapshot.observedAt,
    referencedClaims: new Map([...referenced].map(([key, value]) => [key, scope(value)])),
    reliability: [...reliability.values()].map(item => ({ assessment: item.assessment, source: item.source,
      domain: item.domain, context: item.context, result: item.result,
      applicableFrom: item.applicableFrom, applicableUntil: item.applicableUntil })) });
  const support: Support = input.method === 'human-review' ? input.judgment! : analysis.support;
  return { record, analysis, support, snapshot, reliability, acceptance };
}

function dependencies(claim: string, input: AssessClaimInput, basis: Basis,
  challengeHead: string | null): Dependency[] {
  return [
    { owner: 'graph', kind: 'claim', reference: claim, expectedHead: input.claimRevision },
    { owner: 'content', kind: 'evidence-set', reference: claim, expectedHead: input.evidenceSetRevision },
    { owner: 'content', kind: 'challenge', reference: claim, expectedHead: challengeHead },
    { owner: 'graph', kind: 'policy', reference: SUMMARY_POLICY, expectedHead: SUMMARY_POLICY },
    ...(basis.acceptance ? [{ owner: 'graph' as const, kind: 'acceptance',
      reference: basis.acceptance.slot, expectedHead: input.adoptedRevision }] : []),
    ...[...basis.reliability.values()].sort((a, b) => a.scope.localeCompare(b.scope)).map(item => ({
      owner: 'graph' as const, kind: 'source-assessment', reference: item.scope, expectedHead: item.assessment })),
    ...basis.snapshot.visited.map(observation => ({ owner: 'content' as const, kind: 'source-observation',
      reference: observation, expectedHead: basis.snapshot.lineageHeads.get(observation) ?? null })),
    ...basis.snapshot.visited.map(observation => ({ owner: 'content' as const, kind: 'source-disposition',
      reference: observation, expectedHead: basis.snapshot.dispositionHeads.get(observation) ?? null })),
  ];
}

export async function assessAdmittedClaim(deps: VerificationDependencies, request: Request, claim: string,
  input: AssessClaimInput & { idempotencyKey: string }) {
  const { idempotencyKey, ...intent } = input;
  const digest = assessmentDigest(claim, intent);
  const principal = await deps.access.activePrincipalId(await deps.account.verify(request, ['claim:assess']));
  if (!principal) throw new VerificationDenied('assessor principal is inactive');
  // A challenger never resolves its own challenge; refuse before any record is written.
  for (const challenge of input.resolvesChallenges) {
    const submitter = await deps.store.challengeSubmitter(challenge);
    if (!submitter) throw new VerificationMissing('challenge is unavailable');
    if (submitter === principal) throw new VerificationDenied('a submitter cannot resolve its own challenge');
  }
  let basis: Basis | null = null;
  const receipt = await admitted(deps, request, 'claim-assess',
    { actingSubject: input.actingSubject, idempotencyKey, digest }, async admission => {
      basis = await assessmentBasis(deps, claim, intent, true);
      if (dependencies(claim, intent, basis, basis.snapshot.challenge.revision).length
        > verificationLimits.summaryDependencies) {
        throw new InvalidVerificationInput('assessment dependency manifest exceeds the admitted ceiling');
      }
      return recordAssessment(deps.env, admission, digest, { claim, claimRevision: input.claimRevision,
        evidenceSetRevision: input.evidenceSetRevision, sourceAssessments: [...input.sourceAssessments].sort(),
        method: input.method === 'automated' ? SUPPORT_METHOD : HUMAN_REVIEW_METHOD,
        methodRevision: input.method === 'automated' ? SUPPORT_METHOD : HUMAN_REVIEW_METHOD,
        policyRevision: SUMMARY_POLICY, evaluationContext: input.evaluationContext,
        coverage: basis.analysis.coverage, support: basis.support, dependence: basis.analysis.dependence,
        independentOrigins: basis.analysis.independentOrigins, scorePerMillion: input.scorePerMillion,
        calibration: input.calibration, limitations: input.limitations,
        assessorKind: input.method === 'human-review' ? 'human' : 'automated', actingSubject: input.actingSubject });
    }, error => error instanceof VerificationMissing || error instanceof VerificationStale
      || error instanceof VerificationGraphStale);
  const assessment = receipt.result.assessment!;
  const recorded = await readAssessment(deps.env, assessment);
  if (!recorded) throw new PendingVerification(receipt.admissionId);
  // Replays recompute the deterministic basis and activate only if it still yields the recorded result.
  const current: Basis = basis ?? await assessmentBasis(deps, claim, intent, false);
  const reproduced = current.support === recorded.support && current.analysis.dependence === recorded.dependence
    && current.analysis.coverage === recorded.coverage
    && current.analysis.independentOrigins === recorded.independentOrigins;
  if (input.resolvesChallenges.length) {
    await deps.store.resolveChallenges(principal, receipt.admissionId, claim, assessment, input.resolvesChallenges,
      recorded.support === 'material-conflict' ? 'material-conflict' : 'not-established',
      `Resolved by assessment ${assessment}`, input.actingSubject);
  }
  let activation: ActivationOutcome | { status: 'not-reproduced' } = { status: 'not-reproduced' };
  if (reproduced) {
    const challenge = (await deps.store.analysisSnapshot(claim, uuidOf(input.evidenceSetRevision)!)).challenge;
    const pinned = dependencies(claim, intent, current, challenge.revision);
    const graph = await graphHeads(deps.env, pinned);
    const graphStale = pinned.filter(item => item.owner === 'graph' && item.kind !== 'policy'
      && graph.heads.get(item.reference) !== item.expectedHead).map(item => item.kind);
    activation = graphStale.length ? { status: 'stale-dependency', kinds: [...new Set(graphStale)] }
      : await deps.store.activateSummary({ target: claim, context: input.evaluationContext, claim,
        claimRevision: input.claimRevision, adoptedRevision: input.adoptedRevision, assessment,
        policyRevision: SUMMARY_POLICY, support: recorded.support,
        review: recorded.assessorKind === 'human' ? 'reviewed' : 'unreviewed', coverage: recorded.coverage,
        dependence: recorded.dependence, reasons: current.analysis.reasons, dependencies: pinned,
        ownerPositions: { graph: graph.position }, operationKey: `assessment:${receipt.admissionId}`,
        expectedActive: input.expectedSummary,
        observedDemand: await deps.store.reassessmentDemand(claim, input.evaluationContext),
        openChallenges: challenge.open, resolvedChallenges: challenge.resolved });
  }
  return { assessment: { ...recorded }, analysis: { reasons: current.analysis.reasons,
    origins: current.analysis.origins, applicableSourceAssessments: current.analysis.applicableReliability,
    work: current.analysis.work, lineageNodes: current.snapshot.visited.length },
  activation, receipt: receipt.receipt, replayed: receipt.replayed,
  sourcePosition: { datasetId: 'product' as const, dataEpoch: receipt.dataEpoch, sequence: receipt.sequence } };
}

// --------------------------------------------------------------------- reads

/** A claim with its active summary and a bounded freshness proof against every pinned owner head. */
export async function readClaimQuality(deps: Pick<VerificationDependencies, 'env' | 'store'>, claim: string,
  context: string | null) {
  const record = await readClaimHead(deps.env, claim);
  if (!record) return null;
  const summary = context ? await deps.store.readSummary(claim, context) : null;
  let quality = null;
  if (summary) {
    const graph = await graphHeads(deps.env, summary.dependencies.filter(item => item.owner === 'graph'));
    const dependencies = summary.dependencies.map(item => ({ ...item,
      currentHead: currentVerificationHead(item.kind, item.reference, item.currentHead,
        graph.heads, SUMMARY_POLICY) }));
    const stale = dependencies.filter(item => item.currentHead !== item.expectedHead);
    quality = { generation: summary.generation, number: summary.number, assessment: summary.assessment,
      adoptedRevision: summary.adoptedRevision, policyRevision: summary.policyRevision,
      claimRevision: summary.claimRevision, support: summary.support, review: summary.review,
      dispute: summary.dispute, coverage: summary.coverage, dependence: summary.dependence,
      reasonCodes: summary.reasonCodes, activatedAt: summary.createdAt,
      freshness: stale.length ? (summary.pendingWork ? 'pending' : 'stale') : 'current',
      staleDependencies: stale.map(item => ({ kind: item.kind, reference: item.reference,
        expectedHead: item.expectedHead, currentHead: item.currentHead })),
      dependencyCount: dependencies.length, observedPosition: graph.position,
      activationPosition: summary.ownerPositions.graph ?? null };
  }
  return { claim: claimView(record.head, record), evidenceHead: await deps.store.evidenceHead(claim),
    context, quality };
}
