import { expect, test } from 'bun:test';
import { IDENTITY_RATING_PAGE_LIMIT } from '../../src/semantic/identity-rating-parent.ts';
import { repairIdentityRatingVisibility } from '../../src/semantic/identity-rating-repair.ts';
import type {
  IdentityRatingCommitReceipt,
  IdentityRatingParent,
  IdentityRatingRepairScope,
  IdentityRatingSelectedPage,
} from '../../src/semantic/identity-rating-parent.ts';

test('visibility repair drains bounded pages and retains provenance until its last obligation settles', async () => {
  const scope: IdentityRatingRepairScope = {
    subjectId: 'subject-hidden',
    visibility: 'hidden',
    securityRevision: '9',
  };
  const pages: IdentityRatingSelectedPage[] = [
    {
      pageId: 'visibility-page-1',
      ownerId: 'owner-current',
      ownerRevision: 'owner-11',
      identityEpoch: 'epoch-4',
      after: null,
      next: 'cursor-1',
      terminal: false,
      items: [{ id: 'rating-a', revision: '2', targetId: scope.subjectId, units: 6 }],
    },
    {
      pageId: 'visibility-terminal',
      ownerId: 'owner-current',
      ownerRevision: 'owner-11',
      identityEpoch: 'epoch-4',
      after: 'cursor-1',
      next: null,
      terminal: true,
      items: [],
    },
  ];
  const receipts = new Map<string, IdentityRatingCommitReceipt>();
  const limits: number[] = [];
  let pageIndex = 0;
  let obligations = 1;
  let reclaimed = false;
  const parent: IdentityRatingParent = {
    async selectPage(selectedScope, limit) {
      expect(selectedScope).toEqual(scope);
      limits.push(limit);
      return pages[Math.min(pageIndex, pages.length - 1)]!;
    },
    async readCommitReceipt(binding) {
      return receipts.get(binding.digest) ?? null;
    },
    async commitSelectedPage(_selectedScope, selected, binding) {
      const receipt = {
        pageId: selected.pageId,
        selectionDigest: binding.digest,
        ownerId: selected.ownerId,
        ownerRevision: selected.ownerRevision,
        identityEpoch: selected.identityEpoch,
        transactionId: `tx-${selected.pageId}`,
        position: `${pageIndex + 1}`,
        terminal: selected.terminal,
      };
      receipts.set(binding.digest, receipt);
      return { status: 'committed', receipt };
    },
    async verifyCommitReceipt(_selectedScope, _selected, binding, receipt) {
      return receipts.get(binding.digest) === receipt;
    },
    async acknowledgeSelectedPage(_selectedScope, selected, binding, receipt) {
      if (receipts.get(binding.digest) !== receipt) return false;
      if (!selected.terminal) pageIndex += 1;
      return true;
    },
    async reclaimFinalProvenance(_selectedScope, receipt) {
      if (receipt.pageId !== 'visibility-terminal') return 'stale';
      if (reclaimed) return 'already-reclaimed';
      if (obligations > 0) return 'still-referenced';
      reclaimed = true;
      return 'reclaimed';
    },
  };

  const firstRepair = await repairIdentityRatingVisibility(parent, scope);
  expect(firstRepair).toMatchObject({ status: 'complete', pages: 2, provenance: 'still-referenced' });
  expect(limits).toEqual([IDENTITY_RATING_PAGE_LIMIT, IDENTITY_RATING_PAGE_LIMIT]);
  expect(reclaimed).toBe(false);

  obligations = 0;
  const replay = await repairIdentityRatingVisibility(parent, scope);
  expect(replay).toMatchObject({ status: 'complete', pages: 1, provenance: 'reclaimed' });
  expect(reclaimed).toBe(true);
});
