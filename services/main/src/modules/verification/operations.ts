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
  validateVerificationReference,
  recordReliability, reliabilityDigest, sealVerificationAdmission,
  VerificationGraphStale, type ClaimRecord, type CreateClaimInput, type Family, type GraphReceipt,
  type ReliabilityInput } from './graph.ts';
import { uuidOf, VerificationDenied, VerificationMissing, VerificationStale,
  VerificationInvalid, type Dependency, type VerificationStore,
} from './store.ts';
import type {
  AssessmentProducerPermit,
  AssessmentProducerRecord,
  AssessmentProducerTerminal,
  StagedAssessmentProducer,
} from './assessment-producer.ts';
import { verificationLimits } from './schema.ts';

class PartialVerification extends Error {
  constructor(readonly basis: Basis) { super('lineage analysis is incomplete'); }
}

export class PendingVerification extends PendingActivation {
  constructor(readonly operationId: string) { super('verification outcome requires reconciliation'); }
}

export interface VerificationDependencies {
  env: WorkActivationEnvironment;
  account: Pick<AccountAssertionVerifier, 'verify'>;
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome' | 'activePrincipalId'>;
  store: VerificationStore;
  /** Installed only after the stopped-writer fold cutover; existing terminal identities can still replay. */
  legacyClaimDispatch?: 'terminal-replay-only';
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
  terminalReplayOnly = false,
  afterRegistration?: (admission: RegisteredAdmission) => Promise<void>,
): Promise<GraphReceipt & { replayed: boolean; admission: RegisteredAdmission }> {
  await assertGraphAdmissionOpen(deps.env.fuseki, deps.env.lineage);
  const { scope, action, accountScope } = ADMISSIONS[family];
  const principal = await deps.account.verify(request, [accountScope]);
  const registered = await deps.access.register({ principal, actingSubject: intent.actingSubject, scope, action,
    idempotencyKey: intent.idempotencyKey, requestDigest: intent.digest });
  try {
    // Assessment intent must survive before dispatch, cancellation and Access acknowledgement.
    await afterRegistration?.(registered);
    const retained = terminalReplayOnly
      ? await readReceipt(deps.env, registered.id, family, RESULTS[family]) : null;
    if (terminalReplayOnly && !retained) {
      // Seal the keyed refusal through the ordinary cancellation family; never leave a claimed command to dispatch later.
      const cancelled = await sealVerificationAdmission(deps.env, registered, family, RESULTS[family]);
      await deps.access.recordGraphOutcome(registered.id, cancelled);
      throw new CancelledActivation('Legacy Claim creation is closed; use an existing terminal receipt');
    }
    let admission: RegisteredAdmission = registered;
    if (!retained && registered.state !== 'sealed' && registered.dispatchEligible) {
      admission = await deps.access.claim(registered.id, intent.digest);
    }
    if (!retained && admission.state !== 'sealed') {
      if (!admission.dispatchEligible || admission.state === 'registered') {
        await sealVerificationAdmission(deps.env, admission, family, RESULTS[family]);
      } else {
        try { await execute(admission); }
        catch (error) {
          if (error instanceof IdempotencyConflict || error instanceof InvalidVerificationInput
            || error instanceof PartialVerification) throw error;
          // A refused basis seals the admission, then reports the refusal itself.
          if (unavailable(error)) {
            await sealVerificationAdmission(deps.env, admission, family, RESULTS[family]);
            throw error;
          }
        }
      }
    }
    const terminal = retained ?? await readReceipt(deps.env, registered.id, family, RESULTS[family]);
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
    if (error instanceof AdmissionExpired || error instanceof PartialVerification || error instanceof IdempotencyConflict || error instanceof CancelledActivation
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
    admission => createClaim(deps.env, admission, input), undefined,
    deps.legacyClaimDispatch === 'terminal-replay-only');
  const record = (await readClaimRevisions(deps.env, [receipt.result.claimRevision!])).get(receipt.result.claimRevision!);
  if (!record) throw new PendingVerification(receipt.admissionId);
  return { claim: claimView(receipt.result.claimRevision!, record), receipt: receipt.receipt,
    sourcePosition: { datasetId: 'product' as const, dataEpoch: receipt.dataEpoch, sequence: receipt.sequence },
    replayed: receipt.replayed };
}

export function claimView(revision: string, record: ClaimRecord) {
  return { claim: record.claim, revision, head: record.head, referent: record.referent,
    representation: record.representation, rdfValue: record.rdfValue,
    interpretationContext: record.interpretationContext, propositionPredicate: record.propositionPredicate,
    value: record.value, valuePrecision: record.valuePrecision, valueQualifiers: record.valueQualifiers,
    validFrom: record.validFrom, validUntil: record.validUntil, editionScope: record.editionScope,
    claimStatus: record.claimStatus, statedBy: record.statedBy, recordedAt: record.recordedAt,
    ...(record.retainedSourceRevision ? { retainedSourceRevision: record.retainedSourceRevision } : {}) };
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
  lineageContinuation?: string;
  method: 'automated' | 'human-review'; judgment: Exclude<Support, 'abstained'> | null;
  evaluationContext: string; adoptedRevision: string | null;
  scorePerMillion: number | null; calibration: string | null; evaluationReference?: string | null;
  limitations: string;
  expectedSummary: string | null; resolvesChallenges: readonly string[]; actingSubject: string;
}

export function assessmentDigest(claim: string, input: AssessClaimInput): string {
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
  if (input.evaluationReference != null) validateVerificationReference(input.evaluationReference, 'evaluationReference');
  for (const item of input.sourceAssessments) native(item, 'sourceAssessment');
  const { lineageContinuation: _continuation, ...intent } = input;
  return hash(JSON.stringify({ family: 'claim-assessment-v1', claim, ...intent,
    evaluationReference: input.evaluationReference ?? null,
    sourceAssessments: [...input.sourceAssessments].sort(), resolvesChallenges: [...input.resolvesChallenges].sort() }));
}

interface Basis {
  record: ClaimRecord; analysis: AnalysisResult; support: Support;
  snapshot: Awaited<ReturnType<VerificationStore['analysisSnapshot']>>;
  reliability: Awaited<ReturnType<typeof readReliability>>;
  acceptance: Awaited<ReturnType<typeof readAcceptance>>;
}

/** Load exact inputs and apply the deterministic method; every basis head must be current. */
async function assessmentBasis(deps: Pick<VerificationDependencies, 'env' | 'store'>, claim: string, input: AssessClaimInput,
  requireCurrent: boolean, admission: Pick<
    RegisteredAdmission,
    | 'id'
    | 'principalId'
    | 'actingSubject'
    | 'scope'
    | 'authorityEpoch'
    | 'requestDigest'
    | 'idempotencyKey'
  >,
): Promise<Basis> {
  const records = await readClaimRevisions(deps.env, [input.claimRevision]);
  const record = records.get(input.claimRevision);
  if (!record || record.claim !== claim) throw new VerificationMissing('claim revision is unavailable');
  const evidence = uuidOf(input.evidenceSetRevision);
  if (!evidence) throw new VerificationMissing('evidence revision is unavailable');
  const snapshot = await deps.store.analysisSnapshot(claim, evidence, {
    principal: admission.principalId, actingSubject: admission.actingSubject, scope: admission.scope,
    authorityEpoch: admission.authorityEpoch, requestDigest: admission.requestDigest,
  }, input.lineageContinuation, admission.idempotencyKey, !requireCurrent);
  if (record.representation === 'statement' && snapshot.revision.claimRevision !== input.claimRevision) {
    throw new VerificationMissing('evidence revision targets another Statement revision');
  }
  const reliability = await readReliability(deps.env, input.sourceAssessments);
  const acceptance = input.adoptedRevision ? await readAcceptance(deps.env, input.adoptedRevision, claim,
    record.representation, input.claimRevision) : null;
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
    links: snapshot.links, truncated: snapshot.truncated, lineageProof: snapshot.lineageProof, recordOf: snapshot.recordOf,
    observedAt: snapshot.observedAt,
    referencedClaims: new Map([...referenced].map(([key, value]) => [key, scope(value)])),
    reliability: [...reliability.values()].map(item => ({ assessment: item.assessment, source: item.source,
      domain: item.domain, context: item.context, result: item.result,
      applicableFrom: item.applicableFrom, applicableUntil: item.applicableUntil })) });
  const support: Support = snapshot.truncated ? 'abstained'
    : input.method === 'human-review' ? input.judgment! : analysis.support;
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
    { owner: 'content', kind: 'lineage-walk', reference: basis.snapshot.walk, expectedHead: basis.snapshot.walk },
  ];
}

function producerReceipt(row: AssessmentProducerRecord, receipt: GraphReceipt) {
  if (
    receipt.admissionId !== row.admission ||
    receipt.requestDigest !== row.requestDigest ||
    receipt.authorityEpoch !== row.authorityEpoch ||
    receipt.scope !== row.scope ||
    assessmentDigest(row.claim, row.intent) !== row.requestDigest ||
    (row.terminal &&
      (row.terminal.receipt !== receipt.receipt ||
        (receipt.outcome === 'cancelled'
          ? row.terminal.status !== 'cancelled' || row.terminal.assessment !== null
          : row.terminal.status === 'cancelled' ||
            row.terminal.assessment !== receipt.result.assessment)))
  ) {
    throw new IdempotencyConflict('assessment producer differs from its original graph receipt');
  }
}

/** Reconcile only Content effects against the original terminal; never admit or redispatch a graph command. */
export async function reconcileAssessmentProducerEffects(
  deps: Pick<VerificationDependencies, 'env' | 'store'>,
  admission: string,
  permit: AssessmentProducerPermit,
): Promise<AssessmentProducerRecord> {
  return reconcileAssessmentEffects(deps, admission, permit);
}

async function reconcileAssessmentEffects(
  deps: Pick<VerificationDependencies, 'env' | 'store'>,
  admission: string,
  permit: AssessmentProducerPermit,
  prepared?: Basis,
): Promise<AssessmentProducerRecord> {
  const original = await deps.store.readAssessmentProducer(admission);
  if (!original)
    throw new VerificationMissing('original assessment producer intent is unavailable');
  const receipt = await readReceipt(deps.env, admission, 'claim-assess', ['assessment']);
  if (!receipt) throw new PendingVerification(admission);
  producerReceipt(original, receipt);
  if (original.terminal || receipt.outcome === 'cancelled') {
    return deps.store.withAssessmentProducerEffects(
      admission,
      original.requestDigest,
      permit,
      async () => ({
        status: 'cancelled',
        receipt: receipt.receipt,
        assessment: null,
        activation: { status: 'cancelled' },
      }),
    );
  }
  const assessment = receipt.result.assessment!;
  const recorded = await readAssessment(deps.env, assessment);
  if (!recorded) throw new PendingVerification(admission);
  const input = original.intent;
  if (
    recorded.claim !== original.claim ||
    recorded.claimRevision !== original.claimRevision ||
    recorded.dataEpoch !== receipt.dataEpoch ||
    recorded.sequence !== receipt.sequence ||
    recorded.evidenceSetRevision !== input.evidenceSetRevision ||
    recorded.actingSubject !== original.actingSubject ||
    recorded.evaluationContext !== input.evaluationContext ||
    recorded.method !== (input.method === 'automated' ? SUPPORT_METHOD : HUMAN_REVIEW_METHOD) ||
    recorded.assessorKind !== (input.method === 'human-review' ? 'human' : 'automated') ||
    recorded.methodRevision !== recorded.method ||
    recorded.policyRevision !== SUMMARY_POLICY ||
    JSON.stringify(recorded.sourceAssessments) !==
      JSON.stringify([...input.sourceAssessments].sort()) ||
    recorded.scorePerMillion !== input.scorePerMillion ||
    recorded.calibration !== input.calibration ||
    recorded.evaluationReference !== (input.evaluationReference ?? null) ||
    recorded.limitations !== input.limitations
  ) {
    throw new IdempotencyConflict('recorded assessment differs from original producer pins');
  }
  // These reads use the exact original R and evidence pins. A later head never retargets this intent.
  let current: Basis;
  try {
    current =
      prepared ??
      (await assessmentBasis(deps, original.claim, input, false, {
        id: admission,
        principalId: original.principal,
        actingSubject: original.actingSubject,
        scope: original.scope,
        authorityEpoch: original.authorityEpoch,
        requestDigest: original.requestDigest,
        idempotencyKey: original.idempotencyKey,
      }));
  } catch (error) {
    if (!(error instanceof VerificationStale || error instanceof VerificationMissing)) throw error;
    return deps.store.withAssessmentProducerEffects(
      admission,
      original.requestDigest,
      permit,
      async () => ({
        status: 'refused',
        receipt: receipt.receipt,
        assessment,
        activation: { status: 'refused', reason: error.message },
      }),
    );
  }
  if ((recorded.representation ?? 'claim') !== current.record.representation) {
    throw new IdempotencyConflict(
      'recorded assessment differs from its exact claim representation',
    );
  }
  const reproduced =
    current.support === recorded.support &&
    current.analysis.dependence === recorded.dependence &&
    current.analysis.coverage === recorded.coverage &&
    current.analysis.independentOrigins === recorded.independentOrigins;
  const graphPins = dependencies(original.claim, input, current, null);
  const graph = reproduced ? await graphHeads(deps.env, graphPins) : null;
  const graphStale = graphPins
    .filter(
      (item) =>
        item.owner === 'graph' &&
        item.kind !== 'policy' &&
        graph?.heads.get(item.reference) !== item.expectedHead,
    )
    .map((item) => item.kind);
  const observedDemand = await deps.store.reassessmentDemand(
    original.claim,
    input.evaluationContext,
  );
  return deps.store.withAssessmentProducerEffects(
    admission,
    original.requestDigest,
    permit,
    async (client) => {
      await client.query('SAVEPOINT assessment_effects');
      try {
        if (input.resolvesChallenges.length) {
          await deps.store.resolveChallenges(
            original.principal,
            admission,
            original.claim,
            assessment,
            input.resolvesChallenges,
            recorded.support === 'material-conflict' ? 'material-conflict' : 'not-established',
            `Resolved by assessment ${assessment}`,
            original.actingSubject,
            client,
          );
        }
        const challenge = await deps.store.challengeState(original.claim, client);
        const activation: AssessmentProducerTerminal['activation'] = !reproduced
          ? { status: 'not-reproduced' }
          : graphStale.length
            ? { status: 'stale-dependency', kinds: [...new Set(graphStale)] }
            : await deps.store.activateSummary(
                {
                  target: original.claim,
                  context: input.evaluationContext,
                  claim: original.claim,
                  claimRevision: original.claimRevision,
                  adoptedRevision: input.adoptedRevision,
                  assessment,
                  policyRevision: SUMMARY_POLICY,
                  support: recorded.support,
                  review: recorded.assessorKind === 'human' ? 'reviewed' : 'unreviewed',
                  coverage: recorded.coverage,
                  dependence: recorded.dependence,
                  reasons: current.analysis.reasons,
                  dependencies: dependencies(original.claim, input, current, challenge.revision),
                  ownerPositions: { graph: graph!.position },
                  operationKey: `assessment:${admission}`,
                  expectedActive: input.expectedSummary,
                  observedDemand,
                  openChallenges: challenge.open,
                  resolvedChallenges: challenge.resolved,
                },
                client,
              );
        return {
          status:
            activation.status === 'activated' || activation.status === 'replayed'
              ? 'activated'
              : activation.status === 'not-reproduced'
                ? 'no-activation'
                : 'refused',
          receipt: receipt.receipt,
          assessment,
          activation,
        };
      } catch (error) {
        if (
          !(
            error instanceof VerificationDenied ||
            error instanceof VerificationMissing ||
            error instanceof VerificationStale ||
            error instanceof VerificationInvalid
          )
        )
          throw error;
        // Roll back this attempt's partial tail, retaining older exact challenge receipts.
        await client.query('ROLLBACK TO SAVEPOINT assessment_effects');
        return {
          status: 'refused',
          receipt: receipt.receipt,
          assessment,
          activation: { status: 'refused', reason: error.message },
        };
      }
    },
  );
}

export async function assessAdmittedClaim(deps: VerificationDependencies, request: Request, claim: string,
  input: AssessClaimInput & { idempotencyKey: string },
) {
  const { idempotencyKey, ...intent } = input;
  const digest = assessmentDigest(claim, intent);
  const principal = await deps.access.activePrincipalId(await deps.account.verify(request, ['claim:assess']),
  );
  if (!principal) throw new VerificationDenied('assessor principal is inactive');
  // A challenger never resolves its own challenge; refuse before any record is written.
  for (const challenge of input.resolvesChallenges) {
    const submitter = await deps.store.challengeSubmitter(challenge);
    if (!submitter) throw new VerificationMissing('challenge is unavailable');
    if (submitter === principal) throw new VerificationDenied('a submitter cannot resolve its own challenge');
  }
  let basis: Basis | null = null;
  const staged: { value: StagedAssessmentProducer | null } = { value: null };
  let receipt: Awaited<ReturnType<typeof admitted>>;
  try { receipt = await admitted(deps, request, 'claim-assess',
    { actingSubject: input.actingSubject, idempotencyKey, digest }, async (admission) => {
      basis = await assessmentBasis(deps, claim, intent, true, admission);
      if (basis.snapshot.truncated) throw new PartialVerification(basis);
      if (dependencies(claim, intent, basis, basis.snapshot.challenge.revision).length
        > verificationLimits.summaryDependencies) {
        throw new InvalidVerificationInput('assessment dependency manifest exceeds the admitted ceiling',
          );
      }
      return recordAssessment(deps.env, admission, digest, { claim, claimRevision: input.claimRevision,
        representation: basis.record.representation,
        evidenceSetRevision: input.evidenceSetRevision, sourceAssessments: [...input.sourceAssessments].sort(),
        method: input.method === 'automated' ? SUPPORT_METHOD : HUMAN_REVIEW_METHOD,
        methodRevision: input.method === 'automated' ? SUPPORT_METHOD : HUMAN_REVIEW_METHOD,
        policyRevision: SUMMARY_POLICY, evaluationContext: input.evaluationContext,
        coverage: basis.analysis.coverage, support: basis.support, dependence: basis.analysis.dependence,
        independentOrigins: basis.analysis.independentOrigins, scorePerMillion: input.scorePerMillion,
        calibration: input.calibration, evaluationReference: input.evaluationReference ?? null,
        limitations: input.limitations,
        assessorKind: input.method === 'human-review' ? 'human' : 'automated', actingSubject: input.actingSubject,
        });
    },
      (error) => error instanceof VerificationMissing || error instanceof VerificationStale
      || error instanceof VerificationGraphStale,
      false,
      async (admission) => {
        if (admission.state !== 'registered' && !(await deps.store.readAssessmentProducer(admission.id))) {
          // Claim precedes graph dispatch. A caller retry cannot backfill custody after that boundary,
          // including a committed graph assessment whose Access acknowledgement was lost.
          throw new VerificationMissing('original assessment producer intent is unavailable');
        }
        const { lineageContinuation: _continuation, ...originalIntent } = intent;
        staged.value = await deps.store.stageAssessmentProducer({
          admission: admission.id,
          requestDigest: digest,
          principal: admission.principalId,
          actingSubject: admission.actingSubject,
          scope: admission.scope,
          authorityEpoch: admission.authorityEpoch,
          idempotencyKey: admission.idempotencyKey,
          claim,
          claimRevision: input.claimRevision,
          intent: originalIntent,
        });
      },
    );
  } catch (error) {
    if (!(error instanceof PartialVerification)) {
      if (staged.value) {
        // A cancelled graph terminal may already be durable even when its API refusal throws.
        try {
          await reconcileAssessmentProducerEffects(
            deps,
            staged.value.row.admission,
            staged.value.permit,
          );
        } catch {
          /* No exact terminal or a transient failure leaves the original producer pending. */
        }
      }
      throw error;
    }
    const partial = error.basis;
    return { status: 'analysis-partial' as const, replayed: partial.snapshot.stepReplayed, assessment: null, activation: { status: 'analysis-partial' as const },
      analysis: { support: 'abstained' as const, coverage: 'incomplete' as const, dependence: 'over-budget' as const,
        independentOrigins: null, origins: [], reasons: partial.analysis.reasons,
        applicableSourceAssessments: partial.analysis.applicableReliability, work: partial.snapshot.work, totalWork: partial.snapshot.totalWork,
        lineageContinuation: partial.snapshot.continuation, lineageComplete: false, lineageNodes: partial.snapshot.lineageNodes,
      },
    };
  }
  const assessment = receipt.result.assessment!;
  const recorded = await readAssessment(deps.env, assessment);
  if (!recorded) throw new PendingVerification(receipt.admissionId);
  // The effect-only seam can also resume independently after a lost Access acknowledgement.
  if (!staged.value) throw new PendingVerification(receipt.admissionId);
  const producer = await reconcileAssessmentEffects(
    deps, receipt.admissionId,
    staged.value.permit,
    basis ?? undefined,
  );
  if (!producer.terminal) throw new PendingVerification(receipt.admissionId);
    const activation = producer.terminal.activation;
  // A durable terminal replays even when its former analysis basis is unavailable.
  // Never substitute a new basis merely to decorate that historical response.
  const current = basis as Basis | null;
  return { assessment: { ...recorded }, analysis: current
      ? { reasons: current.analysis.reasons,
    origins: current.analysis.origins, applicableSourceAssessments: current.analysis.applicableReliability,
    work: current.snapshot.work, totalWork: current.snapshot.totalWork,
    lineageContinuation: current.snapshot.continuation, lineageComplete: current.snapshot.complete,
    lineageNodes: current.snapshot.lineageNodes,
        }
      : null,
  activation, receipt: receipt.receipt, replayed: receipt.replayed,
  sourcePosition: { datasetId: 'product' as const, dataEpoch: receipt.dataEpoch, sequence: receipt.sequence,
    },
  };
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
