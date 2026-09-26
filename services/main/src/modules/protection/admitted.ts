import { createHash } from 'node:crypto';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry,
  type RegisteredAdmission } from '../access/admission.ts';
import { ProtectionInvalid, type ContentProtectionAction, type ContentProtectionStore, type CorrectionDecision,
  type CorrectionProposal, type OwnerOutcome, type ProtectionState } from './content-store.ts';
import type { ProtectionAction } from './schema.ts';

/** Account, Access and the Content owner admit each protected command. Edit, protect,
 * relax, propose and review are distinct Access actions; the client never supplies origin. */

export class ProtectionDenied extends Error {}
type Access = Pick<AccessAdmissionRegistry, 'register' | 'claim'>;
type Account = Pick<AccountAssertionVerifier, 'verify'>;

export const PROTECTION_ADMISSION = {
  tighten: 'content.protection.tighten', confirm: 'content.protection.confirm', relax: 'content.protection.relax',
  propose: 'content.correction.propose', review: 'content.correction.review',
} as const;
const NATIVE = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const VARIANT = /^urn:rezics:variant:[0-9a-f-]{36}$/;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
/** One-way per-proposal key over the private principal; Access keeps the principal itself. */
const independenceKey = (principalId: string) => (proposal: string) =>
  sha(`rezics-correction-independence-v1\0${proposal}\0${principalId}`);

interface Common {
  actingSubject: string; idempotencyKey: string; expectedContentHead: string; expectedProtectionHead: string | null;
  expectedRuleRevision: string; reason: string; evidence: string[];
}
export interface ProtectionCommand extends Common { resourceId: string; variantId: string; action: ProtectionAction }
export interface CorrectionCommand extends Common { resourceId: string; variantId: string; body: string; predecessor: string | null }
export interface DecisionCommand extends Common {
  proposalRevision: string; outcome: 'approved' | 'rejected'; expectedCandidateDigest: string;
}

function target(resourceId: string, variantId: string, actingSubject: string) {
  if (!NATIVE.test(resourceId) || !VARIANT.test(variantId) || !NATIVE.test(actingSubject)) {
    throw new ProtectionInvalid('exact target and acting subject are required');
  }
}

/** Register and claim; a denied claim may still replay an already recorded owner outcome.
 * Access cannot yet seal these admissions: `recordGraphOutcome` and strong revocation
 * know only their listed receipt families, so the `content-protection-*` families and
 * `sealContentProtectionAdmission` still need registering there. */
async function admit(access: Access, store: ContentProtectionStore, request: Request, account: Account, input: {
  scope: string; action: string; actingSubject: string; idempotencyKey: string; digest: string; family: string;
}): Promise<{ admission: RegisteredAdmission; operationId: string }> {
  const principal = await account.verify(request, ['work:edit']);
  const admission = await access.register({ principal, actingSubject: input.actingSubject, scope: input.scope,
    action: input.action, idempotencyKey: input.idempotencyKey, requestDigest: input.digest });
  const operationId = `${input.family}:${admission.id}`;
  if (admission.state !== 'sealed') {
    try { await access.claim(admission.id, input.digest); }
    catch (error) {
      if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
      if (!await store.readReceipt(operationId)) throw new ProtectionDenied('protected command is not admitted');
    }
  }
  return { admission, operationId };
}

const digestOf = (profile: string, value: Record<string, unknown>) => sha(JSON.stringify({ profile,
  ...Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) }));

export async function changeAdmittedProtection(store: ContentProtectionStore, account: Account, access: Access,
  request: Request, input: ProtectionCommand): Promise<OwnerOutcome<ProtectionState>> {
  target(input.resourceId, input.variantId, input.actingSubject);
  const digest = digestOf('content-draft-protection-v1', { action: input.action, resourceId: input.resourceId,
    variantId: input.variantId, actingSubject: input.actingSubject, expectedContentHead: input.expectedContentHead,
    expectedProtectionHead: input.expectedProtectionHead, expectedRuleRevision: input.expectedRuleRevision,
    reason: input.reason, evidence: input.evidence });
  const { operationId } = await admit(access, store, request, account, { scope: `content:protect:${input.resourceId}`,
    action: PROTECTION_ADMISSION[input.action], actingSubject: input.actingSubject, idempotencyKey: input.idempotencyKey,
    digest, family: 'content-protection-change' });
  return store.changeProtection({ operationId, requestDigest: digest, resourceId: input.resourceId,
    variantId: input.variantId, action: input.action, expectedContentHead: input.expectedContentHead,
    expectedProtectionHead: input.expectedProtectionHead, expectedRuleRevision: input.expectedRuleRevision,
    reason: input.reason, evidence: input.evidence, agent: input.actingSubject });
}

export async function proposeAdmittedCorrection(store: ContentProtectionStore, account: Account, access: Access,
  request: Request, input: CorrectionCommand): Promise<OwnerOutcome<CorrectionProposal>> {
  target(input.resourceId, input.variantId, input.actingSubject);
  const candidateJson = JSON.stringify({ body: input.body });
  const digest = digestOf('content-draft-correction-v1', { resourceId: input.resourceId, variantId: input.variantId,
    actingSubject: input.actingSubject, expectedContentHead: input.expectedContentHead,
    expectedProtectionHead: input.expectedProtectionHead, expectedRuleRevision: input.expectedRuleRevision,
    candidate: sha(candidateJson), predecessor: input.predecessor, reason: input.reason, evidence: input.evidence });
  const { admission, operationId } = await admit(access, store, request, account, {
    scope: `content:correct:${input.resourceId}`, action: PROTECTION_ADMISSION.propose, actingSubject: input.actingSubject,
    idempotencyKey: input.idempotencyKey, digest, family: 'content-correction-propose' });
  return store.proposeCorrection({ operationId, requestDigest: digest, resourceId: input.resourceId,
    variantId: input.variantId, expectedContentHead: input.expectedContentHead,
    expectedProtectionHead: input.expectedProtectionHead, expectedRuleRevision: input.expectedRuleRevision,
    reason: input.reason, evidence: input.evidence, agent: input.actingSubject, candidateJson,
    predecessor: input.predecessor, proposerKey: independenceKey(admission.principalId) });
}

export async function decideAdmittedCorrection(store: ContentProtectionStore, account: Account, access: Access,
  request: Request, input: DecisionCommand): Promise<OwnerOutcome<CorrectionDecision>> {
  if (!NATIVE.test(input.actingSubject)) throw new ProtectionInvalid('exact acting subject is required');
  const record = await store.readCorrection(input.proposalRevision);
  if (!record) throw new ProtectionDenied('proposal is not available');
  const digest = digestOf('content-draft-correction-decision-v1', { proposalRevision: input.proposalRevision,
    outcome: input.outcome, actingSubject: input.actingSubject, expectedCandidateDigest: input.expectedCandidateDigest,
    expectedContentHead: input.expectedContentHead, expectedProtectionHead: input.expectedProtectionHead,
    expectedRuleRevision: input.expectedRuleRevision, reason: input.reason, evidence: input.evidence });
  const { admission, operationId } = await admit(access, store, request, account, {
    scope: `content:review:${record.proposal.resourceId}`, action: PROTECTION_ADMISSION.review,
    actingSubject: input.actingSubject, idempotencyKey: input.idempotencyKey, digest, family: 'content-correction-decide' });
  return store.decideCorrection({ operationId, requestDigest: digest, proposalRevision: input.proposalRevision,
    outcome: input.outcome, expectedCandidateDigest: input.expectedCandidateDigest,
    expectedContentHead: input.expectedContentHead, expectedProtectionHead: input.expectedProtectionHead,
    expectedRuleRevision: input.expectedRuleRevision, reason: input.reason, evidence: input.evidence,
    agent: input.actingSubject, independenceProof: `urn:rezics:admission:${admission.id}`,
    reviewerKey: independenceKey(admission.principalId) });
}

/** Terminal cancellation for a fenced admission; the Content operation lock admits one winner. */
export function sealContentProtectionAdmission(store: ContentProtectionStore, admission: RegisteredAdmission) {
  const [family, action] = admission.action === PROTECTION_ADMISSION.propose
    ? ['content-correction-propose', 'correction.propose'] as const
    : admission.action === PROTECTION_ADMISSION.review ? ['content-correction-decide', 'correction.decide'] as const
      : Object.values(PROTECTION_ADMISSION).includes(admission.action as never)
        ? ['content-protection-change', 'protection.change'] as const : [null, null];
  if (!family || !action) throw new ProtectionDenied('not a Content protection admission');
  return store.cancel(action satisfies ContentProtectionAction, `${family}:${admission.id}`, admission.requestDigest);
}
