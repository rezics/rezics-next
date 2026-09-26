import type { VerifiedPrincipal } from '../access/admission.ts';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { type AccessVotes, type PolicyRole, type VoteAdmission, type VoteAuthority, VoteIneligible,
  approverSlotIri } from './access.ts';
import { type AllocationIntent, type BallotIntent, type HolderCharterIntent, type PreparePollIntent,
  approvalIri, checkBallot, checkHolderCharter, checkPreparePoll, classifyBallotGuard, dispatchAllocation,
  dispatchApproval, dispatchBallot, dispatchClosePoll, dispatchFinalizePoll, dispatchHolderCharter, dispatchOpenPoll,
  dispatchPreparePoll, holderCharterDigest, planAllocation, type BallotCandidate, type BallotContext } from './commands.ts';
import { PendingVoteWork, VoteConflict, VoteRejected, VoteStale, VoteUnavailable, checkedVoteReceipt, digestOf,
  readVoteReceipt, sealVoteTerminal, type VoteReceipt } from './graph.ts';
import { countApprovals, readPoll, readSeat } from './read.ts';
import type { VoteOperation } from './schema.ts';

/**
 * Admitted vote operations: verify the Account assertion, admit current Access
 * authority with its exact proof, commit one guarded graph command, then seal the
 * admission with the graph receipt. A retry with the same key replays the receipt;
 * a lost response or crash between the stores is resolved by the same receipt.
 */

export interface VoteDependencies {
  environment: WorkActivationEnvironment;
  account: Pick<AccountAssertionVerifier, 'verify'>;
  votes: AccessVotes;
}

export const VOTE_SCOPES = { cast: ['vote:cast'], manage: ['vote:manage'], read: ['vote:read'] } as const;

export interface AdmittedVote { admission: VoteAdmission; receipt: VoteReceipt; principal: VerifiedPrincipal }

async function recoverExisting(deps: VoteDependencies, request: Request, scopes: readonly string[],
  operation: VoteOperation, poll: string, actingSubject: string, key: string,
  requestDigest: string): Promise<AdmittedVote | null> {
  await assertGraphAdmissionOpen(deps.environment.fuseki, deps.environment.lineage);
  const principal = await deps.account.verify(request, scopes);
  const admission = await deps.votes.replay(principal, operation, poll, actingSubject, key, requestDigest);
  if (!admission) return null;
  try {
    const receipt = await readVoteReceipt(deps.environment, admission);
    if (!receipt) {
      if (admission.state === 'sealed') throw new PendingVoteWork(admission.id);
      return null;
    }
    await deps.votes.seal(admission, { outcome: receipt.outcome, receipt: receipt.receipt,
      admissionId: receipt.admissionId, requestDigest: receipt.requestDigest,
      authorityEpoch: receipt.authorityEpoch, scope: receipt.scope, dataEpoch: receipt.dataEpoch,
      sequence: receipt.sequence });
    return { admission, receipt: checkedVoteReceipt(receipt, admission), principal };
  } catch (error) {
    if (error instanceof VoteRejected || error instanceof VoteStale || error instanceof VoteConflict
      || error instanceof PendingVoteWork) throw error;
    throw new PendingVoteWork(admission.id);
  }
}

async function admitted(deps: VoteDependencies, request: Request, scopes: readonly string[],
  authority: (principal: VerifiedPrincipal) => Promise<VoteAuthority>, key: string, requestDigest: string,
  dispatch: (admission: VoteAdmission) => Promise<boolean>,
  classify: (admission: VoteAdmission) => Promise<'stale-head' | string>): Promise<AdmittedVote> {
  const env = deps.environment;
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await deps.account.verify(request, scopes);
  const admission = await deps.votes.admit(principal, await authority(principal), key, requestDigest);
  try {
    let receipt = await readVoteReceipt(env, admission);
    if (!receipt && admission.state !== 'sealed') {
      if (!admission.dispatchEligible) receipt = await sealVoteTerminal(env, admission);
      else {
        let committed = false;
        try { committed = await dispatch(admission); }
        catch (error) {
          if (error instanceof VoteRejected) receipt = await sealVoteTerminal(env, admission, 'rejected', error.code);
          else if (error instanceof VoteStale) receipt = await sealVoteTerminal(env, admission, 'stale-head');
          else if (error instanceof VoteUnavailable) {
            receipt = await sealVoteTerminal(env, admission, 'rejected', 'dependency_unavailable');
          } else throw error;
        }
        receipt ??= await readVoteReceipt(env, admission);
        if (!receipt && !committed) {
          const verdict = await classify(admission);
          receipt = verdict === 'stale-head' ? await sealVoteTerminal(env, admission, 'stale-head')
            : await sealVoteTerminal(env, admission, 'rejected', verdict);
        }
      }
    }
    if (!receipt) throw new PendingVoteWork(admission.id);
    await deps.votes.seal(admission, { outcome: receipt.outcome, receipt: receipt.receipt,
      admissionId: receipt.admissionId, requestDigest: receipt.requestDigest,
      authorityEpoch: receipt.authorityEpoch, scope: receipt.scope, dataEpoch: receipt.dataEpoch,
      sequence: receipt.sequence });
    return { admission, receipt: checkedVoteReceipt(receipt, admission), principal };
  } catch (error) {
    if (error instanceof VoteRejected || error instanceof VoteStale || error instanceof VoteConflict) throw error;
    throw new PendingVoteWork(admission.id);
  }
}

interface MandateRequest { actingSubject: string; representationId: string; idempotencyKey: string }
interface BodyRequest extends MandateRequest { grantId: string }

export async function preparePoll(deps: VoteDependencies, request: Request,
  input: PreparePollIntent & BodyRequest): Promise<AdmittedVote> {
  const { idempotencyKey, actingSubject, representationId, grantId, ...intent } = input;
  const digest = digestOf({ operation: 'poll.prepare', intent, actingSubject, representationId, grantId });
  const prior = await recoverExisting(deps, request, VOTE_SCOPES.manage, 'poll.prepare', intent.poll,
    actingSubject, idempotencyKey, digest);
  if (prior) return prior;
  let slots: string[];
  try { slots = await deps.votes.countingSlots(intent.poll, intent.entitlements); }
  catch (error) {
    if (error instanceof VoteIneligible) throw new VoteRejected('counting_identity_unavailable', error.message);
    throw error;
  }
  checkPreparePoll(intent, slots);
  return admitted(deps, request, VOTE_SCOPES.manage, async () => ({ operation: 'poll.prepare', poll: intent.poll,
    body: intent.body, actingSubject, representationId, grantId, candidateDigest: digestOf({ intent, slots }),
    expectedHead: null }), idempotencyKey, digest,
  admission => dispatchPreparePoll(deps.environment, admission, intent, slots), async () => 'poll_exists');
}

export async function setHolderCharter(deps: VoteDependencies, request: Request,
  input: HolderCharterIntent & Omit<MandateRequest, 'actingSubject'>): Promise<AdmittedVote> {
  const { idempotencyKey, representationId, ...intent } = input;
  const digest = digestOf({ operation: 'holder-charter.set', intent, representationId });
  const prior = await recoverExisting(deps, request, VOTE_SCOPES.manage, 'holder-charter.set',
    intent.poll, intent.holder, idempotencyKey, digest);
  if (prior) return prior;
  const { poll } = await checkHolderCharter(deps.environment, intent);
  return admitted(deps, request, VOTE_SCOPES.manage, async () => ({ operation: 'holder-charter.set',
    poll: intent.poll, body: poll.body, actingSubject: intent.holder, holder: intent.holder,
    sourceEntitlement: intent.entitlement, representationId, candidateDigest: holderCharterDigest(intent),
    expectedHead: intent.expectedHead }), idempotencyKey, digest,
  admission => dispatchHolderCharter(deps.environment, admission, intent), async () => {
    try { await checkHolderCharter(deps.environment, intent); return 'holder_charter_guard_failed'; }
    catch (error) {
      if (error instanceof VoteStale) return 'stale-head';
      if (error instanceof VoteRejected) return error.code;
      throw error;
    }
  });
}

export async function activateAllocation(deps: VoteDependencies, request: Request,
  input: AllocationIntent & Omit<MandateRequest, 'actingSubject'>): Promise<AdmittedVote> {
  const { idempotencyKey, representationId, ...intent } = input;
  const digest = digestOf({ operation: 'allocation.activate', intent, representationId });
  const prior = await recoverExisting(deps, request, VOTE_SCOPES.manage, 'allocation.activate',
    intent.poll, intent.holder, idempotencyKey, digest);
  if (prior) return prior;
  const env = deps.environment;
  const poll = await readPoll(env, intent.poll);
  const root = await readSeat(env, intent.poll, intent.rootEntitlement);
  let slots: string[];
  try { slots = await deps.votes.countingSlots(intent.poll, intent.leaves); }
  catch (error) {
    if (error instanceof VoteIneligible) throw new VoteRejected('counting_identity_unavailable', error.message);
    throw error;
  }
  const leaves = planAllocation(poll, root, intent, slots);
  return admitted(deps, request, VOTE_SCOPES.manage, async () => ({ operation: 'allocation.activate',
    poll: intent.poll, body: poll.body, actingSubject: intent.holder, holder: intent.holder,
    sourceEntitlement: intent.rootEntitlement, representationId,
    candidateDigest: digestOf(leaves.map(leaf => [leaf.slot, leaf.units, leaf.residual]).sort()),
    expectedHead: null }), idempotencyKey, digest,
  admission => dispatchAllocation(env, admission, intent, root, leaves), async () => {
    const current = await readPoll(env, intent.poll);
    if (current.state !== 'draft') return 'poll_not_draft';
    return (await readSeat(env, intent.poll, intent.rootEntitlement)).counted ? 'allocation_guard_failed' : 'stale-head';
  });
}

export async function changePollState(deps: VoteDependencies, request: Request,
  input: BodyRequest & { poll: string; closesAt?: string },
  operation: 'poll.open' | 'poll.close' | 'resolution.finalize'): Promise<AdmittedVote> {
  const { idempotencyKey, actingSubject, representationId, grantId, ...intent } = input;
  const digest = digestOf({ operation, intent, actingSubject, representationId, grantId });
  const prior = await recoverExisting(deps, request, VOTE_SCOPES.manage, operation, intent.poll,
    actingSubject, idempotencyKey, digest);
  if (prior) return prior;
  const env = deps.environment;
  const poll = await readPoll(env, intent.poll);
  return admitted(deps, request, VOTE_SCOPES.manage, async () => ({ operation, poll: intent.poll, body: poll.body,
    actingSubject, representationId, grantId, candidateDigest: digestOf({ operation, intent }), expectedHead: null }),
  idempotencyKey, digest, async admission => operation === 'poll.open'
    ? dispatchOpenPoll(env, admission, intent, await readPoll(env, intent.poll))
    : operation === 'poll.close'
      ? dispatchClosePoll(env, admission, intent, await readPoll(env, intent.poll))
      : dispatchFinalizePoll(env, admission, intent, await readPoll(env, intent.poll)), async () => {
    const current = await readPoll(env, intent.poll);
    if (operation === 'poll.open') return current.state !== 'draft' ? 'poll_not_draft' : 'stale-head';
    if (operation === 'poll.close') return current.state !== 'open' ? 'poll_not_open' : 'stale-head';
    return current.state !== 'closed' ? 'poll_not_closed' : 'stale-head';
  });
}

function policyRoles(context: BallotContext): PolicyRole[] | undefined {
  return context.rule === 'designated' ? ['designated', 'backup'] : undefined;
}

export async function setBallot(deps: VoteDependencies, request: Request,
  input: BallotIntent & Omit<MandateRequest, 'actingSubject'>): Promise<AdmittedVote> {
  const { idempotencyKey, representationId, ...intent } = input;
  const digest = digestOf({ operation: 'ballot', intent, representationId });
  const operation = intent.availability === 'cast' ? 'ballot.cast' : 'ballot.withdraw';
  const prior = await recoverExisting(deps, request, VOTE_SCOPES.cast, operation,
    intent.poll, intent.holder, idempotencyKey, digest);
  if (prior) return prior;
  const env = deps.environment;
  if (intent.approvals.length > 64) throw new VoteRejected('too_many_approvals');
  const body = (await readPoll(env, intent.poll)).body;
  const context = await checkBallot(env, intent, await deps.votes.policyHead(intent.holder, body));
  if (context.rule === 'k-of-n') {
    const approved = await countApprovals(env, intent.poll, intent.seat, intent.approvals, context.candidateDigest);
    if (approved < context.charter!.threshold! || approved !== intent.approvals.length) {
      throw new VoteRejected('approvals_insufficient');
    }
  } else if (intent.approvals.length) throw new VoteRejected('approvals_not_chartered');
  return admitted(deps, request, VOTE_SCOPES.cast, async () => ({
    operation, poll: intent.poll, body,
    actingSubject: intent.holder, holder: intent.holder, seat: intent.seat,
    sourceEntitlement: context.seat.sourceEntitlement, representationId, policyRoles: policyRoles(context),
    candidateDigest: context.candidateDigest, expectedHead: intent.expectedHead }), idempotencyKey, digest,
  admission => dispatchBallot(env, admission, intent, context), async () => classifyBallotGuard(env, intent));
}

export async function approveBallot(deps: VoteDependencies, request: Request,
  input: { poll: string; seat: string; holder: string; candidate: BallotCandidate }
    & Omit<MandateRequest, 'actingSubject'>): Promise<AdmittedVote> {
  const { idempotencyKey, representationId, candidate, ...target } = input;
  const digest = digestOf({ operation: 'ballot.approve', target, candidate, representationId });
  const prior = await recoverExisting(deps, request, VOTE_SCOPES.cast, 'ballot.approve',
    target.poll, target.holder, idempotencyKey, digest);
  if (prior) return prior;
  const env = deps.environment;
  const body = (await readPoll(env, target.poll)).body;
  const context = await checkBallot(env, { ...candidate, ...target }, await deps.votes.policyHead(target.holder, body));
  if (context.rule !== 'k-of-n') throw new VoteRejected('charter_not_k_of_n');
  const intent = { ...target, expectedHead: candidate.expectedHead };
  return admitted(deps, request, VOTE_SCOPES.cast, async () => ({ operation: 'ballot.approve',
    poll: target.poll, body, actingSubject: target.holder, holder: target.holder, seat: target.seat,
    sourceEntitlement: context.seat.sourceEntitlement, representationId, policyRoles: ['approver'],
    candidateDigest: context.candidateDigest, expectedHead: candidate.expectedHead }), idempotencyKey, digest,
  admission => dispatchApproval(env, admission, intent, context,
    approverSlotIri(target.poll, target.holder, admission.principalId)), async admission => {
    const slot = approverSlotIri(target.poll, target.holder, admission.principalId);
    if (await countApprovals(env, target.poll, target.seat, [approvalIri(context.candidateDigest, slot)],
      context.candidateDigest)) return 'duplicate_approval';
    return classifyBallotGuard(env, intent);
  });
}
