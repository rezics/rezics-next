import { createHash } from 'node:crypto';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry,
  type GraphTerminalProof, type RegisteredAdmission } from '../access/admission.ts';
import { ProtectionInvalid, type ContentProtectionAction, type ContentProtectionStore, type CorrectionDecision,
  type CorrectionProposal, type OwnerOutcome, type ProtectionState, ProtectionIdempotencyConflict } from './content-store.ts';
import type { ProtectionAction } from './schema.ts';
import { protectionReceiptIri, contentReceiptFamilies, type ContentProtectionAdmissionAction } from './receipt-family.ts';

/** Account, Access and the Content owner admit each protected command. Edit, protect,
 * relax, propose and review are distinct Access actions; the client never supplies origin. */

export class ProtectionDenied extends Error {}
export class ProtectionPending extends Error {
  constructor(readonly operationId: string) { super('Content outcome needs receipt reconciliation'); }
}
type Access = Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>;
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

function terminalProof(admission: RegisteredAdmission, result: OwnerOutcome<unknown>): GraphTerminalProof {
  if (!Object.hasOwn(contentReceiptFamilies, admission.action)) throw new ProtectionDenied('wrong protection admission action');
  return { outcome: result.outcome === 'succeeded' ? 'succeeded' : 'cancelled',
    receipt: protectionReceiptIri(admission.id, admission.action as ContentProtectionAdmissionAction),
    admissionId: admission.id, requestDigest: admission.requestDigest,
    authorityEpoch: admission.authorityEpoch, scope: admission.scope,
    dataEpoch: result.position.dataEpoch, sequence: result.position.sequence };
}

/** Register and claim; a denied claim may still replay an already recorded owner outcome. */
async function admit(access: Access, store: ContentProtectionStore, request: Request, account: Account, input: {
  scope: string; action: ContentProtectionAdmissionAction; oauthScope: 'content:protect' | 'content:correct' | 'content:review';
  actingSubject: string; idempotencyKey: string; digest: string;
}): Promise<{ admission: RegisteredAdmission; operationId: string }> {
  const principal = await account.verify(request, [input.oauthScope]);
  const admission = await access.register({ principal, actingSubject: input.actingSubject, scope: input.scope,
    action: input.action, idempotencyKey: input.idempotencyKey, requestDigest: input.digest });
  const operationId = `${contentReceiptFamilies[input.action]}:${admission.id}`;
  if (admission.state === 'sealed') {
    // After a Content rollback, Access can retain the terminal proof while the
    // Content receipt is gone. Re-executing that old intent would undo the fence.
    let receipt: Awaited<ReturnType<ContentProtectionStore['readReceipt']>>;
    try { receipt = await store.readReceipt(operationId); }
    catch { throw new ProtectionPending(operationId); }
    if (!receipt) throw new ProtectionPending(operationId);
  } else {
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

/** A lost commit acknowledgement is resolved by the operation's own receipt. If
 * Content is unreachable too, the outcome stays pending under the same identity. */
async function resolveOwnerResponse<T>(store: ContentProtectionStore, operationId: string,
  digest: string, action: ContentProtectionAction, dispatch: () => Promise<OwnerOutcome<T>>): Promise<OwnerOutcome<T>> {
  try { return await dispatch(); }
  catch (error) {
    let receipt: Awaited<ReturnType<ContentProtectionStore['readReceipt']>>;
    try { receipt = await store.readReceipt(operationId); }
    catch { throw new ProtectionPending(operationId); }
    if (!receipt) throw error;
    if (receipt.requestDigest !== digest || receipt.action !== action) {
      throw new ProtectionIdempotencyConflict('operation receipt differs from request');
    }
    return dispatch();
  }
}

async function complete<T>(store: ContentProtectionStore, access: Access, admission: RegisteredAdmission,
  digest: string, action: ContentProtectionAction, dispatch: () => Promise<OwnerOutcome<T>>): Promise<OwnerOutcome<T>> {
  const operationId = `${contentReceiptFamilies[admission.action as ContentProtectionAdmissionAction]}:${admission.id}`;
  const result = await resolveOwnerResponse(store, operationId, digest, action, dispatch);
  try { await access.recordGraphOutcome(admission.id, terminalProof(admission, result)); }
  catch { throw new ProtectionPending(operationId); }
  return result;
}

export async function changeAdmittedProtection(store: ContentProtectionStore, account: Account, access: Access,
  request: Request, input: ProtectionCommand): Promise<OwnerOutcome<ProtectionState>> {
  target(input.resourceId, input.variantId, input.actingSubject);
  const digest = digestOf('content-draft-protection-v1', { action: input.action, resourceId: input.resourceId,
    variantId: input.variantId, actingSubject: input.actingSubject, expectedContentHead: input.expectedContentHead,
    expectedProtectionHead: input.expectedProtectionHead, expectedRuleRevision: input.expectedRuleRevision,
    reason: input.reason, evidence: input.evidence });
  const { admission, operationId } = await admit(access, store, request, account, { scope: `content:protect:${input.resourceId}`,
    action: PROTECTION_ADMISSION[input.action], actingSubject: input.actingSubject, idempotencyKey: input.idempotencyKey,
    digest, oauthScope: 'content:protect' });
  return complete(store, access, admission, digest, 'protection.change', () => store.changeProtection({
    operationId, requestDigest: digest, resourceId: input.resourceId,
    variantId: input.variantId, action: input.action, expectedContentHead: input.expectedContentHead,
    expectedProtectionHead: input.expectedProtectionHead, expectedRuleRevision: input.expectedRuleRevision,
    reason: input.reason, evidence: input.evidence, agent: input.actingSubject }));
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
    idempotencyKey: input.idempotencyKey, digest, oauthScope: 'content:correct' });
  return complete(store, access, admission, digest, 'correction.propose', () => store.proposeCorrection({
    operationId, requestDigest: digest, resourceId: input.resourceId,
    variantId: input.variantId, expectedContentHead: input.expectedContentHead,
    expectedProtectionHead: input.expectedProtectionHead, expectedRuleRevision: input.expectedRuleRevision,
    reason: input.reason, evidence: input.evidence, agent: input.actingSubject, candidateJson,
    predecessor: input.predecessor, proposerKey: independenceKey(admission.principalId) }));
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
    actingSubject: input.actingSubject, idempotencyKey: input.idempotencyKey, digest, oauthScope: 'content:review' });
  return complete(store, access, admission, digest, 'correction.decide', () => store.decideCorrection({
    operationId, requestDigest: digest, proposalRevision: input.proposalRevision,
    outcome: input.outcome, expectedCandidateDigest: input.expectedCandidateDigest,
    expectedContentHead: input.expectedContentHead, expectedProtectionHead: input.expectedProtectionHead,
    expectedRuleRevision: input.expectedRuleRevision, reason: input.reason, evidence: input.evidence,
    agent: input.actingSubject, independenceProof: `urn:rezics:admission:${admission.id}`,
    reviewerKey: independenceKey(admission.principalId) }));
}

/** Terminal cancellation for a fenced admission; the Content operation lock admits one winner. */
export async function sealContentProtectionAdmission(store: ContentProtectionStore, admission: RegisteredAdmission) {
  if (!Object.hasOwn(contentReceiptFamilies, admission.action)) throw new ProtectionDenied('not a Content protection admission');
  const action = admission.action === PROTECTION_ADMISSION.propose ? 'correction.propose'
    : admission.action === PROTECTION_ADMISSION.review ? 'correction.decide' : 'protection.change';
  const result = await store.cancel(action satisfies ContentProtectionAction,
    `${contentReceiptFamilies[admission.action as ContentProtectionAdmissionAction]}:${admission.id}`, admission.requestDigest);
  return terminalProof(admission, result);
}

type ClosureAccess = Pick<AccessAdmissionRegistry, 'strongCloseScope' | 'listUnsealed' | 'strongDeactivatePrincipal'
  | 'listUnsealedPrincipal' | 'recordGraphOutcome'>;

async function sealPending(access: ClosureAccess, store: ContentProtectionStore, pending: RegisteredAdmission[]) {
  for (const admission of pending) {
    if (!Object.hasOwn(contentReceiptFamilies, admission.action)) continue;
    try {
      const proof = await sealContentProtectionAdmission(store, admission);
      await access.recordGraphOutcome(admission.id, proof);
    } catch { /* The Access fence remains closed until a later reconciliation pass. */ }
  }
}

/** One bounded pass after Access closes dispatch; unknown outcomes remain pending. */
export async function strongRevokeProtectionScope(access: ClosureAccess, store: ContentProtectionStore,
  scope: string, expectedEpoch: string) {
  const closed = await access.strongCloseScope(scope, expectedEpoch);
  await sealPending(access, store, await access.listUnsealed(scope, 100));
  const current = await access.strongCloseScope(scope, closed.authorityEpoch);
  return { scope, authorityEpoch: current.authorityEpoch,
    status: current.pending === 0 ? 'complete' as const : 'pending' as const, pending: current.pending };
}

/** Principal deactivation uses the same owner receipt race as scope closure. */
export async function strongRevokeProtectionPrincipal(access: ClosureAccess, store: ContentProtectionStore,
  principalId: string, expectedEpoch: string) {
  const fenced = await access.strongDeactivatePrincipal(principalId, expectedEpoch);
  await sealPending(access, store, await access.listUnsealedPrincipal(principalId, 100));
  const current = await access.strongDeactivatePrincipal(principalId, fenced.enforcementEpoch);
  return { principalId, enforcementEpoch: current.enforcementEpoch,
    status: current.pending === 0 ? 'complete' as const : 'pending' as const, pending: current.pending };
}
