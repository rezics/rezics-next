import { canonicalCandidate, EditorialBlocked, EditorialInvalid, EditorialReceiptInvalid,
  headsEqual, revisionOperationKey, type ApplyInput, type Blocker, type EditorialAdapter,
  type OwnerReceipt, type Proposal, type ProposalReview, type ProposalRevision,
  type ResourceRef, type TerminalDecision } from './contract.ts';

/** Authority results come from a fresh Access read under its decision fence.
 * Reusing the authority observed when a review was submitted is forbidden. */
export interface CurrentReviewer { reviewer: ResourceRef; reviewerKey: string; eligible: boolean }
export interface Viewer { agent: ResourceRef; principalKey: string; eligibleReviewer: boolean }
export type AllowedAction = 'revise' | 'review' | 'apply' | 'reject' | 'withdraw' | 'revert';
export interface ReviewState { state: 'open' | 'changes_requested' | 'approved' | TerminalDecision['outcome'];
  approvalIds: string[]; staleApprovalIds: string[]; blockers: Blocker[]; allowedActions: AllowedAction[] }

export function assertOpenRevision(proposal: Proposal, revision: ProposalRevision): void {
  if (proposal.decision) throw new EditorialBlocked({ code: 'terminal_decision', outcome: proposal.decision.outcome });
  revisionOperationKey(proposal.id, revision.n);
  if (revision.proposal !== proposal.id) throw new EditorialInvalid('Revision belongs to another proposal');
  if (revision.n !== proposal.latestRevision) {
    throw new EditorialBlocked({ code: 'stale_revision', latestRevision: proposal.latestRevision });
  }
  if (canonicalCandidate(revision.candidate).digest !== revision.candidateDigest) {
    throw new EditorialInvalid('Candidate digest differs from the retained revision');
  }
}

export function assertIndependentReview(proposal: Proposal, viewer: Viewer): void {
  if (viewer.agent === proposal.proposer || viewer.principalKey === proposal.proposerKey) {
    throw new EditorialBlocked({ code: 'self_review' });
  }
  if (!viewer.eligibleReviewer) throw new EditorialBlocked({ code: 'review_authority_required' });
}

/** Comments leave the review stance unchanged; the last approve/request_changes
 * from each independent operator on this exact revision determines their stance.
 * Callers supply the indexed current stances and the requested timeline page,
 * rather than scanning all historical reviews to decide an operation. */
export function reviewState(proposal: Proposal, reviews: readonly ProposalReview[],
  authority: readonly CurrentReviewer[], required: 1 | 2, viewer: Viewer): ReviewState {
  if (required !== 1 && required !== 2) throw new EditorialInvalid('Required approval count is invalid');
  const stances = new Map<string, ProposalReview>();
  const staleApprovalIds: string[] = [];
  for (const review of reviews) {
    if (review.proposal !== proposal.id) throw new EditorialInvalid('Review belongs to another proposal');
    if (review.revision !== proposal.latestRevision) {
      if (review.outcome === 'approve') staleApprovalIds.push(review.id);
      continue;
    }
    if (review.outcome === 'comment') continue;
    if (!/^(0|[1-9][0-9]*)$/.test(review.sequence)) throw new EditorialInvalid('Review sequence is invalid');
    const previous = stances.get(review.reviewerKey);
    if (!previous || BigInt(review.sequence) > BigInt(previous.sequence)) stances.set(review.reviewerKey, review);
    else if (review.sequence === previous.sequence && review.id !== previous.id) {
      throw new EditorialInvalid('Review sequence is ambiguous');
    }
  }
  const current = new Map(authority.map(row => [JSON.stringify([row.reviewer, row.reviewerKey]), row.eligible]));
  const eligible = [...stances.values()].filter(row => row.reviewer !== proposal.proposer
    && row.reviewerKey !== proposal.proposerKey
    && current.get(JSON.stringify([row.reviewer, row.reviewerKey])) === true);
  const approvalIds = eligible.filter(row => row.outcome === 'approve').map(row => row.id).sort();
  const blockers: Blocker[] = [];
  const allowedActions: AllowedAction[] = [];
  if (proposal.decision) {
    blockers.push({ code: 'terminal_decision', outcome: proposal.decision.outcome });
    if (proposal.decision.outcome === 'applied') allowedActions.push('revert');
    return { state: proposal.decision.outcome, approvalIds, staleApprovalIds, blockers, allowedActions };
  }
  if (approvalIds.length < required) blockers.push({ code: 'required_approvals', required, received: approvalIds.length });
  const own = viewer.principalKey === proposal.proposerKey || viewer.agent === proposal.proposer;
  if (own) {
    allowedActions.push('revise', 'withdraw');
    blockers.push({ code: 'self_review' });
  } else if (viewer.eligibleReviewer) {
    allowedActions.push('review', 'reject');
    if (approvalIds.length >= required) allowedActions.push('apply');
  } else blockers.push({ code: 'review_authority_required' });
  const state = approvalIds.length >= required ? 'approved'
    : eligible.some(row => row.outcome === 'request_changes') ? 'changes_requested' : 'open';
  return { state, approvalIds, staleApprovalIds, blockers, allowedActions };
}

export function assertOwnerReceipt(receipt: OwnerReceipt,
  input: Pick<ApplyInput, 'revision' | 'expectedHeads' | 'operationKey'>): void {
  if (!receipt || typeof receipt.receipt !== 'string' || !receipt.receipt.length
    || receipt.proposal !== input.revision.proposal || receipt.revision !== input.revision.n
    || receipt.candidateDigest !== input.revision.candidateDigest
    || receipt.operationKey !== input.operationKey || receipt.owner === undefined
    || receipt.candidate === undefined || receipt.before === undefined
    || canonicalCandidate(receipt.candidate).digest !== input.revision.candidateDigest
    || canonicalCandidate(receipt.before).digest !== canonicalCandidate(input.revision.before).digest
    || !headsEqual(receipt.beforeHeads, input.expectedHeads)
    || !Array.isArray(receipt.afterHeads) || !headsEqual(receipt.afterHeads, receipt.afterHeads)
    || receipt.afterHeads.length !== receipt.beforeHeads.length
    || receipt.afterHeads.some(head => head.head === null || !receipt.beforeHeads.some(before =>
      before.component === head.component && before.head !== head.head))) {
    throw new EditorialReceiptInvalid('Application lacks an exact successful owner receipt');
  }
  canonicalCandidate(receipt.owner);
}

/** This guard returns a decision to persist, never mutates a status. The caller
 * must serialize against revision/decision rows and retain an application intent
 * BEFORE dispatch; pending owner acknowledgement cannot reopen a proposal.
 * The permit is independently rechecked by the owner inside its effect commit. */
export async function applyReviewedRevision(adapter: EditorialAdapter, proposal: Proposal,
  input: ApplyInput, reviews: readonly ProposalReview[], authority: readonly CurrentReviewer[],
  viewer: Viewer, reverts: string | null = null): Promise<TerminalDecision> {
  assertOpenRevision(proposal, input.revision);
  assertIndependentReview(proposal, viewer);
  if (input.operationKey !== revisionOperationKey(proposal.id, input.revision.n)
    || input.permit.proposal !== proposal.id || input.permit.revision !== input.revision.n
    || input.permit.candidateDigest !== input.revision.candidateDigest
    || input.permit.decidingAgent !== viewer.agent || !input.permit.proof
    || adapter.kind !== proposal.kind
    || canonicalCandidate(input.target).digest !== canonicalCandidate(proposal.target).digest
    || !headsEqual(input.expectedHeads, input.revision.baseHeads)) {
    throw new EditorialInvalid('Application differs from its admitted proposal revision');
  }
  const state = reviewState(proposal, reviews, authority, adapter.requiredApprovals, viewer);
  if (!state.allowedActions.includes('apply')) {
    const blocker = state.blockers.find(row => row.code === 'required_approvals');
    throw new EditorialBlocked(blocker ?? { code: 'review_authority_required' });
  }
  const result = await adapter.apply(input);
  if (result.outcome === 'stale_base') throw new EditorialBlocked({ code: 'stale_base',
    expectedHeads: input.expectedHeads, actualHeads: result.actualHeads });
  if (result.outcome === 'pending') throw new EditorialBlocked({ code: 'apply_pending', operationKey: input.operationKey });
  assertOwnerReceipt(result.receipt, input);
  return { proposal: proposal.id, revision: input.revision.n, actor: viewer.agent,
    outcome: 'applied', receipt: result.receipt, reverts };
}
