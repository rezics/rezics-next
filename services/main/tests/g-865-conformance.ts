import { expect } from 'bun:test';
import { EditorialBlocked, EditorialReceiptInvalid, type ApplyInput, type BaseHead,
  type EditorialAdapter, type Json, type Proposal, type ProposalReview, type Blocker } from '../src/modules/editorial-review/contract.ts';
import { applyReviewedRevision, reviewState, type CurrentReviewer, type Viewer }
  from '../src/modules/editorial-review/lifecycle.ts';
import { MemoryCommandJournal } from './g-865-command-journal.ts';
import type { CommandOutcome, EditorialCommand } from '../src/modules/editorial-review/contract.ts';

export interface AdapterFixture {
  adapter: EditorialAdapter; proposal: Proposal; input: ApplyInput;
  reviews: ProposalReview[]; authority: CurrentReviewer[]; viewer: Viewer;
  writes(): number;
  moveHead(): BaseHead[];
  loseNextAcknowledgement(): void;
  compensationCandidate?: Json;
}
export interface AdapterFixtureModule { kind: string; create(): Promise<AdapterFixture> }

async function blocked(work: Promise<unknown>, code: Blocker['code']): Promise<void> {
  let failure: unknown;
  try { await work; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(EditorialBlocked);
  expect((failure as EditorialBlocked).blocker.code).toBe(code);
}
const apply = (f: AdapterFixture, adapter = f.adapter, proposal = f.proposal, input = f.input,
  reviews = f.reviews, authority = f.authority, viewer = f.viewer) =>
  applyReviewedRevision(adapter, proposal, input, reviews, authority, viewer);

/** The one class guard is reused by every discovered adapter, including future
 * bundles. Owner ports are deterministic; production transaction/race evidence
 * belongs to the HTTP/owner integration suite, not these contract fixtures. */
export async function runEditorialAdapterConformance(module: AdapterFixtureModule): Promise<void> {
  const f = await module.create();
  expect(f.adapter.kind).toBe(module.kind);
  expect(await f.adapter.preview(f.input.revision)).not.toHaveLength(0);

  // Changed candidates invalidate ALL earlier approvals by computation.
  const old = f.reviews.map(row => ({ ...row, revision: f.input.revision.n - 1 }));
  await blocked(apply(f, f.adapter, f.proposal, f.input, old), 'required_approvals');
  expect(reviewState(f.proposal, old, f.authority, f.adapter.requiredApprovals, f.viewer).staleApprovalIds)
    .toEqual(old.map(row => row.id));
  expect(f.writes()).toBe(0);

  // The same operator cannot approve through another Agent; counting is private.
  await blocked(apply(f, f.adapter, f.proposal, f.input, f.reviews, f.authority,
    { ...f.viewer, principalKey: f.proposal.proposerKey }), 'self_review');
  const self = f.reviews.map(row => ({ ...row, reviewerKey: f.proposal.proposerKey }));
  await blocked(apply(f, f.adapter, f.proposal, f.input, self,
    self.map(row => ({ reviewer: row.reviewer, reviewerKey: row.reviewerKey, eligible: true }))), 'required_approvals');
  expect(f.writes()).toBe(0);

  await blocked(apply(f, f.adapter, f.proposal, f.input, f.reviews,
    f.authority.map(row => ({ ...row, eligible: false }))), 'required_approvals');
  await blocked(apply(f, f.adapter, f.proposal, f.input, f.reviews, f.authority,
    { ...f.viewer, eligibleReviewer: false }), 'review_authority_required');
  await blocked(apply(f, f.adapter, { ...f.proposal, latestRevision: f.input.revision.n + 1 }), 'stale_revision');
  expect(f.writes()).toBe(0);

  // Deliberate adapter regressions: success without a receipt and a substituted
  // candidate receipt must both fail the same guard before a terminal decision.
  const missing: EditorialAdapter = { ...f.adapter,commands: undefined,
    apply: async () => ({ outcome: 'applied', receipt: undefined! }) };
  await expect(apply(f, missing)).rejects.toBeInstanceOf(EditorialReceiptInvalid);
  const substituted: EditorialAdapter = { ...f.adapter,commands: undefined, apply: async input => ({ outcome: 'applied',
    receipt: { receipt: 'urn:test:wrong-candidate', proposal: input.revision.proposal,
      revision: input.revision.n, candidateDigest: '0'.repeat(64), operationKey: input.operationKey,
      beforeHeads: input.expectedHeads, afterHeads: input.expectedHeads.map(row => ({ ...row, head: 'urn:test:after' })),
      candidate: input.revision.candidate, before: input.revision.before,
      owner: {} } }) };
  await expect(apply(f, substituted)).rejects.toBeInstanceOf(EditorialReceiptInvalid);
  expect(f.writes()).toBe(0);

  const moved = await module.create();
  const actual = moved.moveHead();
  await blocked(apply(moved), 'stale_base');
  expect(actual).not.toEqual(moved.input.expectedHeads);
  expect(moved.proposal.decision).toBeNull();
  expect(moved.writes()).toBe(0);

  const lost = await module.create();
  lost.loseNextAcknowledgement();
  await blocked(apply(lost), 'apply_pending');
  const result = await apply(lost);
  expect(result.outcome).toBe('applied');
  expect(result.receipt?.operationKey).toBe(lost.input.operationKey);
  expect(lost.writes()).toBe(1);
  const replay = await apply(lost);
  expect(replay.receipt).toEqual(result.receipt);
  expect(lost.writes()).toBe(1);

  await blocked(apply(lost, lost.adapter, { ...lost.proposal, decision: result }), 'terminal_decision');
  expect(lost.writes()).toBe(1);
  const compensated = await lost.adapter.compensate(result.receipt!);
  expect(compensated.candidate).toEqual(lost.compensationCandidate ?? lost.input.revision.before as Json);
  expect(compensated.baseHeads).toEqual(result.receipt!.afterHeads);
}

/** Exercise the shared multi-command kernel with each adapter's real fixture
 * owner. Two independent owner effects use one reviewed application. */
export async function runEditorialOrderedConformance(module: AdapterFixtureModule): Promise<void> {
  const owners = await Promise.all([module.create(),module.create()]);
  const f = owners[0]!;
  const settled = new Map<string,CommandOutcome>();
  let interruptSecond = true;
  const commands: EditorialCommand[] = owners.map((owner,index) => ({
    key: `${f.input.operationKey}:${index}`,
    prepare: async () => ({ action: 'test.owner',scope: `test:${index}`,digest: owner.input.revision.candidateDigest }),
    resolve: async delivery => settled.get(delivery.key) ?? null,
    execute: async delivery => {
      if (index === 1 && interruptSecond) { interruptSecond = false; return null; }
      const result = await owner.adapter.apply(owner.input);
      if (result.outcome !== 'applied') return null;
      const outcome: CommandOutcome = { key: delivery.key,outcome: 'applied',receipt: result.receipt.receipt,result: result.receipt.owner };
      settled.set(delivery.key,outcome); return outcome;
    },
  }));
  const adapter: EditorialAdapter = { ...f.adapter,commands: async () => commands,
    complete: async input => ({ receipt: 'urn:test:ordered',proposal: input.revision.proposal,revision: input.revision.n,
      candidateDigest: input.revision.candidateDigest,operationKey: input.operationKey,beforeHeads: input.expectedHeads,
      afterHeads: input.expectedHeads,candidate: input.revision.candidate,before: input.revision.before,owner: {} }) };
  const input = { ...f.input,commands: new MemoryCommandJournal() };
  await blocked(apply(f,adapter,f.proposal,input),'apply_pending');
  expect(owners.map(owner => owner.writes())).toEqual([1,0]);
  await blocked(apply(f,adapter,f.proposal,{ ...input,resumeDelivery: false }),'apply_pending');
  expect(owners.map(owner => owner.writes())).toEqual([1,0]);
  const result = await apply(f,adapter,f.proposal,input);
  expect(result.receipt?.commands?.map(command => command.key)).toEqual(commands.map(command => command.key));
  expect(owners.map(owner => owner.writes())).toEqual([1,1]);
  expect((await apply(f,adapter,f.proposal,input)).receipt).toEqual(result.receipt);
  expect(owners.map(owner => owner.writes())).toEqual([1,1]);
}
