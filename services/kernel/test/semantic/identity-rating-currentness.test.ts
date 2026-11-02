import { expect, test } from 'bun:test';
import { produceIdentityRatingVoteChange } from '../../src/semantic/identity-rating-producer.ts';
import { consumeIdentityRatingPage } from '../../src/semantic/identity-rating-consumer.ts';
import { repairIdentityRatingVisibility } from '../../src/semantic/identity-rating-repair.ts';
import type {
  IdentityRatingCommitReceipt,
  IdentityRatingParent,
  IdentityRatingRepairScope,
  IdentityRatingSelectedPage,
  IdentityRatingPageBinding,
} from '../../src/semantic/identity-rating-parent.ts';

const scope = (subjectId = 'subject-a'): IdentityRatingRepairScope => ({
  subjectId,
  visibility: 'hidden',
  securityRevision: '4',
});

const page = (pageId: string, terminal = false): IdentityRatingSelectedPage => ({
  pageId,
  ownerId: 'owner-a',
  ownerRevision: 'owner-revision-8',
  identityEpoch: 'epoch-12',
  after: null,
  next: terminal ? null : 'cursor-next',
  terminal,
  items: terminal ? [] : [{ id: 'vote-1', revision: '3', targetId: 'subject-a', units: 7 }],
});

class Parent implements IdentityRatingParent {
  readonly limits: number[] = [];
  readonly commits = new Map<string, IdentityRatingCommitReceipt>();
  readonly acknowledged = new Set<string>();
  readonly pages = new Map<string, readonly IdentityRatingSelectedPage[]>();
  readonly indexes = new Map<string, number>();
  readonly pending = new Map<string, 'redirect-chain' | 'epoch-pending'>();
  ownerRevision = 'owner-revision-8';
  interruptNextAcknowledgement = false;
  outstandingObligations = 0;
  reclaimed = false;
  commitCount = 0;

  async selectPage(input: IdentityRatingRepairScope, limit: number): Promise<IdentityRatingSelectedPage> {
    this.limits.push(limit);
    const pages = this.pages.get(input.subjectId) ?? [page(`${input.subjectId}-terminal`, true)];
    const index = Math.min(this.indexes.get(input.subjectId) ?? 0, pages.length - 1);
    return pages[index]!;
  }

  async readCommitReceipt(binding: IdentityRatingPageBinding): Promise<IdentityRatingCommitReceipt | null> {
    return this.commits.get(binding.digest) ?? null;
  }

  async commitSelectedPage(
    input: IdentityRatingRepairScope,
    selected: IdentityRatingSelectedPage,
    binding: IdentityRatingPageBinding,
  ) {
    const pending = this.pending.get(input.subjectId);
    if (pending) return { status: 'pending' as const, reason: pending };
    if (this.ownerRevision !== selected.ownerRevision)
      return { status: 'pending' as const, reason: 'owner-aba' as const };
    const receipt = {
      pageId: selected.pageId,
      selectionDigest: binding.digest,
      ownerId: selected.ownerId,
      ownerRevision: selected.ownerRevision,
      identityEpoch: selected.identityEpoch,
      transactionId: `tx-${selected.pageId}`,
      position: '12',
      terminal: selected.terminal,
    };
    this.commits.set(binding.digest, receipt);
    this.commitCount += 1;
    return { status: 'committed' as const, receipt };
  }

  async verifyCommitReceipt(
    _input: IdentityRatingRepairScope,
    _selected: IdentityRatingSelectedPage,
    binding: IdentityRatingPageBinding,
    receipt: IdentityRatingCommitReceipt,
  ): Promise<boolean> {
    return this.commits.get(binding.digest) === receipt;
  }

  async acknowledgeSelectedPage(
    input: IdentityRatingRepairScope,
    selected: IdentityRatingSelectedPage,
    binding: IdentityRatingPageBinding,
    receipt: IdentityRatingCommitReceipt,
  ): Promise<boolean> {
    if (this.interruptNextAcknowledgement) {
      this.interruptNextAcknowledgement = false;
      throw new Error('interrupted after committed page');
    }
    if (this.commits.get(binding.digest) !== receipt) return false;
    if (!this.acknowledged.has(binding.digest)) {
      this.acknowledged.add(binding.digest);
      if (selected.terminal && this.outstandingObligations > 0) this.outstandingObligations -= 1;
      if (!selected.terminal) this.indexes.set(input.subjectId, (this.indexes.get(input.subjectId) ?? 0) + 1);
    }
    return true;
  }

  async reclaimFinalProvenance(): Promise<'reclaimed' | 'still-referenced' | 'already-reclaimed'> {
    if (this.reclaimed) return 'already-reclaimed';
    if (this.outstandingObligations > 0) return 'still-referenced';
    this.reclaimed = true;
    return 'reclaimed';
  }
}

test('the vote producer binds the transaction event to the authenticated voter and resolved target', () => {
  const event = produceIdentityRatingVoteChange({
    authenticatedVoterId: 'voter-a',
    questionId: 'question-a',
    sourceTargetId: 'subject-a',
    aggregateTargetId: 'subject-b',
    previous: 4,
    units: 7,
    revision: 5,
    populations: ['global'],
  });

  expect(event).toEqual({
    type: 'com.rezics.rating.vote.changed.v1',
    subject: 'voter-a',
    data: {
      voterId: 'voter-a',
      questionId: 'question-a',
      targetId: 'subject-a',
      aggregateTargetId: 'subject-b',
      previous: 4,
      units: 7,
      revision: 5,
      populations: ['global'],
    },
  });
});

test('owner ABA, a second redirect, and a pending epoch leave the selected repair step pending', async () => {
  const ownerChanged = new Parent();
  ownerChanged.pages.set(scope().subjectId, [page('owner-aba-page')]);
  ownerChanged.ownerRevision = 'owner-revision-10';
  expect(await consumeIdentityRatingPage(ownerChanged, scope())).toEqual({ status: 'pending', reason: 'owner-aba' });
  expect(ownerChanged.acknowledged.size).toBe(0);

  for (const reason of ['redirect-chain', 'epoch-pending'] as const) {
    const unstable = new Parent();
    unstable.pages.set(scope().subjectId, [page(`pending-${reason}`)]);
    unstable.pending.set(scope().subjectId, reason);
    expect(await consumeIdentityRatingPage(unstable, scope())).toEqual({ status: 'pending', reason });
    expect(unstable.acknowledged.size).toBe(0);
  }
});

test('a retry verifies a committed page receipt after interruption without committing its effects twice', async () => {
  const parent = new Parent();
  parent.pages.set(scope().subjectId, [page('committed-first-page'), page('terminal-page', true)]);
  parent.interruptNextAcknowledgement = true;

  await expect(consumeIdentityRatingPage(parent, scope())).rejects.toThrow('interrupted after committed page');
  const retried = await consumeIdentityRatingPage(parent, scope());

  expect(retried).toMatchObject({ status: 'committed', pageId: 'committed-first-page', terminal: false });
  expect(parent.commitCount).toBe(1);
  expect(parent.acknowledged.size).toBe(1);
});

test('terminal replay releases provenance only after the final obligation', async () => {
  const parent = new Parent();
  parent.outstandingObligations = 2;
  parent.pages.set(scope('subject-a').subjectId, [page('subject-a-terminal', true)]);
  parent.pages.set(scope('subject-b').subjectId, [page('subject-b-terminal', true)]);

  expect(await repairIdentityRatingVisibility(parent, scope('subject-a'))).toMatchObject({
    status: 'complete',
    provenance: 'still-referenced',
  });
  expect(parent.reclaimed).toBe(false);
  expect(await repairIdentityRatingVisibility(parent, scope('subject-b'))).toMatchObject({
    status: 'complete',
    provenance: 'reclaimed',
  });

  const commits = parent.commitCount;
  expect(await repairIdentityRatingVisibility(parent, scope('subject-b'))).toMatchObject({
    status: 'complete',
    provenance: 'already-reclaimed',
  });
  expect(parent.commitCount).toBe(commits);
});
