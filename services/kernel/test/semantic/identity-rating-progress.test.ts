import { expect, test } from 'bun:test';
import { repairIdentityRatingVisibility } from '../../src/semantic/identity-rating-repair.ts';
import type {
  IdentityRatingParent,
  IdentityRatingSelectedPage,
  IdentityRatingCommitReceipt,
  IdentityRatingRepairCheckpoint,
} from '../../src/semantic/identity-rating-parent.ts';

const scope = { subjectId: 'subject', visibility: 'hidden' as const, securityRevision: '4' };

// Native records survive replacing the adapter, including loss of its last successful reply.
class Records {
  pages: IdentityRatingSelectedPage[];
  receipts = new Map<string, IdentityRatingCommitReceipt>();
  checkpoint: IdentityRatingRepairCheckpoint | null = null;
  acknowledged = new Set<string>();
  position = 0;
  effects = 0;
  selections = 0;
  references = 0;
  cleanupSteps = 0;
  reclaimed = false;
  ownerRevision = '8';
  loseCommitReply = false;
  loseCleanupReply = false;
  constructor(count: number) {
    this.pages = Array.from({ length: count }, (_, i) => ({
      pageId: `page-${i}`,
      ownerId: 'owner',
      ownerRevision: '8',
      identityEpoch: '12',
      after: i === 0 ? null : String(i),
      next: i === count - 1 ? null : String(i + 1),
      terminal: i === count - 1,
      items: [{ id: `vote-${i}`, revision: '3', targetId: 'subject', units: 7 }],
      native: { frontier: 'retained-frontier', phase: 'withdrawal', revision: String(i) },
    }));
  }
  adapter(): IdentityRatingParent {
    return {
      readRepairCheckpoint: async () => this.checkpoint && JSON.parse(JSON.stringify(this.checkpoint)),
      selectPage: async (_scope, limit, replay) => {
        expect(limit).toBe(64);
        this.selections++;
        if (this.reclaimed) throw new Error('page payload was reclaimed');
        return this.pages.find((p) => p.pageId === replay?.pageId) ?? this.pages[this.position]!;
      },
      readCommitReceipt: async (b) => this.receipts.get(b.digest) ?? null,
      commitSelectedPage: async (_scope, p, b) => {
        const receipt = {
          pageId: p.pageId,
          selectionDigest: b.digest,
          ownerId: p.ownerId,
          ownerRevision: p.ownerRevision,
          identityEpoch: p.identityEpoch,
          transactionId: `tx-${p.pageId}`,
          position: String(++this.effects),
          terminal: p.terminal,
        };
        this.receipts.set(b.digest, receipt);
        if (this.loseCommitReply) {
          this.loseCommitReply = false;
          throw new Error('lost commit reply');
        }
        return { status: 'committed', receipt };
      },
      verifyCommitReceipt: async (_s, _p, b, r) =>
        this.receipts.get(b.digest) === r && r.ownerRevision === this.ownerRevision,
      acknowledgeSelectedPage: async (s, p, b, receipt) => {
        if (!this.acknowledged.has(b.digest)) {
          this.acknowledged.add(b.digest);
          if (!p.terminal) this.position++;
          this.checkpoint = {
            scope: s,
            binding: { ...b, native: p.native! },
            receipt,
            phase: p.terminal ? 'reclamation' : 'repair',
          };
        }
        return true;
      },
      reclaimFinalProvenance: async () => {
        if (this.references) return 'still-referenced';
        if (this.cleanupSteps-- > 0) return 'continuing';
        this.reclaimed = true;
        if (this.loseCleanupReply) {
          this.loseCleanupReply = false;
          throw new Error('lost cleanup reply');
        }
        return 'reclaimed';
      },
      verifyReclaimedCheckpoint: async (_s, c) =>
        c.receipt.ownerRevision !== this.ownerRevision
          ? 'stale'
          : this.reclaimed && c.binding.digest === this.checkpoint?.binding.digest
            ? 'current'
            : 'pending',
    };
  }
}

test('small invocations advance the retained native frontier without replaying acknowledged effects', async () => {
  const records = new Records(10);
  for (let i = 0; i < 5; i++) {
    const result = await repairIdentityRatingVisibility(records.adapter(), scope, 2);
    expect(result.status).toBe(i === 4 ? 'complete' : 'continuing');
    expect(result.pages).toBe(2);
    expect(result.checkpoint?.binding.native).toEqual({
      frontier: 'retained-frontier',
      phase: 'withdrawal',
      revision: String(i * 2 + 1),
    });
  }
  expect(records.effects).toBe(10);
});

test('lost commit and final cleanup replies recover from native records after replacing the adapter', async () => {
  const records = new Records(2);
  records.loseCommitReply = true;
  await expect(repairIdentityRatingVisibility(records.adapter(), scope, 1)).rejects.toThrow('lost commit reply');
  expect((await repairIdentityRatingVisibility(records.adapter(), scope, 1)).status).toBe('continuing');
  expect(records.effects).toBe(1);
  records.loseCleanupReply = true;
  await expect(repairIdentityRatingVisibility(records.adapter(), scope)).rejects.toThrow('lost cleanup reply');
  const selections = records.selections;
  expect(await repairIdentityRatingVisibility(records.adapter(), scope)).toMatchObject({
    status: 'complete',
    pages: 0,
    provenance: 'already-reclaimed',
    checkpoint: { phase: 'complete' },
  });
  expect(records.selections).toBe(selections);
  expect(records.effects).toBe(2);
});

test('reclamation waits for final references, yields bounded cleanup, and refuses terminal owner ABA', async () => {
  const records = new Records(1);
  records.references = 1;
  expect(await repairIdentityRatingVisibility(records.adapter(), scope)).toMatchObject({
    status: 'complete',
    provenance: 'still-referenced',
  });
  expect(records.reclaimed).toBe(false);
  records.references = 0;
  records.cleanupSteps = 2;
  for (let i = 0; i < 2; i++)
    expect((await repairIdentityRatingVisibility(records.adapter(), scope)).status).toBe('continuing');
  expect((await repairIdentityRatingVisibility(records.adapter(), scope)).status).toBe('complete');
  records.ownerRevision = '10';
  expect(await repairIdentityRatingVisibility(records.adapter(), scope)).toMatchObject({
    status: 'pending',
    reason: 'provenance-owner-changed',
  });
  expect(records.effects).toBe(1);
});

test('a stuck frontier, changed checkpoint scope, or oversized selection cannot produce more effects', async () => {
  const records = new Records(2),
    parent = records.adapter();
  const stuck = { ...parent, selectPage: async () => records.pages[0]! };
  expect(await repairIdentityRatingVisibility(stuck, scope)).toMatchObject({
    status: 'pending',
    pages: 1,
    reason: 'repair-frontier-did-not-advance',
  });
  expect(await repairIdentityRatingVisibility(parent, { ...scope, securityRevision: '5' })).toMatchObject({
    status: 'pending',
    reason: 'checkpoint-binding-mismatch',
  });
  const large = new Records(1);
  large.pages[0] = {
    ...large.pages[0]!,
    items: Array.from({ length: 64 }, (_, i) => ({
      id: String(i),
      revision: '\0'.repeat(256),
      targetId: '\0'.repeat(256),
      units: 7,
    })),
  };
  expect(await repairIdentityRatingVisibility(large.adapter(), scope)).toMatchObject({
    status: 'pending',
    reason: 'invalid-selected-page',
  });
  expect(large.effects).toBe(0);
  expect(records.effects).toBe(1);
});
