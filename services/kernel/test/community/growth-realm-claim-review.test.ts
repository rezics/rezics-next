import { expect, test } from 'bun:test';
import { assertGrowthAccessPaths, checkGrowth } from '../support/growth.ts';
import reviewPage from '../../src/community/realm-claim-review-page.sql';
import {
  claimReviewGrowthAxes,
  claimReviewGrowthScales,
  claimReviewGrowthFixture,
} from './support/growth-realm-claim-review-fixture.ts';

test('registered owner erasure supplies the original episode and native HTTP request for claim review growth', async () => {
  const fixture = await claimReviewGrowthFixture();
  try {
    expect(await fixture.source()).toMatchObject({
      ownership_state: 'owned',
      state: 'active',
      orphaned_at: null,
      claim_eligible_at: null,
      head_revision_id: fixture.realm.headRevisionId,
    });
    const erased = await fixture.eraseOwner();
    expect(erased.accountId).toBe(fixture.ownerAccountId);
    // A terminal account root, closed grant, ACK or SQL-written orphan does not
    // substitute for the default producer invoking native Access succession.
    expect(await fixture.source()).toMatchObject({
      ownership_state: 'orphaned',
      state: 'active',
      original_root: true,
      original_deadline: true,
      head_revision_id: fixture.realm.headRevisionId,
      lifecycle_version: expect.any(Number),
      discovery_epoch: expect.any(Number),
    });
    const orphan = await fixture.source();
    await fixture.prepareReview();
    const claim = await fixture.submit();
    expect(claim).toMatchObject({
      realmId: fixture.realm.realmId,
      state: 'pending',
      orphanedAt: new Date(erased.at).toISOString(),
      claimEligibleAt: new Date(orphan.claim_eligible_at!).toISOString(),
    });
    // A new HTTP idempotency key still refers to the same native pending request.
    expect(await fixture.submit()).toEqual(claim);
    const first = await fixture.list();
    const disclosed = {
      realmId: fixture.realm.realmId,
      requestId: claim.requestId,
      claimantAccountId: fixture.claimantAccountId,
      state: 'pending' as const,
      orphanedAt: claim.orphanedAt,
      claimEligibleAt: claim.claimEligibleAt,
      requestedAt: claim.requestedAt,
    };
    expect(first).toEqual({ claimRequests: [disclosed], next: expect.any(String) });
    // The cursor follows the last examined key even when its successor is empty.
    expect(await fixture.list(1, first.next!)).toEqual({ claimRequests: [], next: null });
    await fixture.rejectedList('invalid_cursor', 'control', 1, first.next!);
    await fixture.rejectedList('invalid_cursor', 'reviewer', 2, first.next!);
    await fixture.bumpPartitionEpochAndReject(first.next!);
    await fixture.rejectedList('not_found', 'claimant');

    // Forty genuine requests fill two raw candidate pages. A requested limit of
    // 100 still examines twenty, and a full deep page retains an empty successor.
    const additional = await fixture.submitAdditional(39);
    const expected = [
      disclosed,
      ...additional.map((item) => ({
        realmId: item.realmId,
        requestId: item.requestId,
        claimantAccountId: item.claimantAccountId,
        state: 'pending' as const,
        orphanedAt: item.orphanedAt,
        claimEligibleAt: item.claimEligibleAt,
        requestedAt: item.requestedAt,
      })),
    ].sort((left, right) => (left.requestId < right.requestId ? -1 : left.requestId > right.requestId ? 1 : 0));
    const populated = await fixture.list(100);
    expect(populated).toEqual({ claimRequests: expected.slice(0, 20), next: expect.any(String) });
    const deep = await fixture.list(100, populated.next!);
    expect(deep).toEqual({ claimRequests: expected.slice(20), next: expect.any(String) });
    expect(await fixture.list(100, deep.next!)).toEqual({ claimRequests: [], next: null });

    // A trusted read clock before these native requests, but after the original
    // eligibility instant, makes every raw candidate temporarily ineligible.
    // No stored episode, request timestamp or source fence is rewritten.
    await fixture.reviewTime(1);
    const filtered = await fixture.list(100);
    expect(filtered).toEqual({ claimRequests: [], next: expect.any(String) });
    const filteredDeep = await fixture.list(100, filtered.next!);
    expect(filteredDeep).toEqual({ claimRequests: [], next: expect.any(String) });
    expect(await fixture.list(100, filteredDeep.next!)).toEqual({ claimRequests: [], next: null });
    const filteredOne = await fixture.list(1);
    expect(filteredOne).toEqual({ claimRequests: [], next: expect.any(String) });
    await fixture.reviewTime(2);
    // The cursor consumed raw keys, so eligibility returning cannot refill them.
    expect(await fixture.list(100, filtered.next!)).toEqual({
      claimRequests: expected.slice(20),
      next: expect.any(String),
    });
    expect(await fixture.list(1, filteredOne.next!)).toEqual({
      claimRequests: [expected[1]!],
      next: expect.any(String),
    });

    await fixture.revokeDuringList();
    await fixture.rejectedList('not_found', 'reviewer');
    expect(await fixture.list(100, undefined, 'control')).toEqual({
      claimRequests: expected.slice(0, 20),
      next: expect.any(String),
    });

    // Each pressure axis is grown alone. The real registered Kernel route,
    // production Access, native cursor, and shared growth classifier stay in
    // the measured path; population and grant setup remain outside it.
    for (const axis of claimReviewGrowthAxes) {
      try {
        const report = await checkGrowth(fixture.growthDatabase, {
          name: `Realm claim review listing: ${axis}`,
          scales: claimReviewGrowthScales,
          bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
          indexProbes: 64,
          repetitions: 3,
          grow: (_database, scale, previous) => fixture.grow(axis, scale, previous),
          warmup: async () => {
            await fixture.grantReviewer();
            await fixture.measureListingPaths(expected);
          },
          prepare: () => fixture.grantReviewer(),
          operation: () => fixture.measureListingPaths(expected),
        });
        expect(report.samples.map(({ scale }) => scale)).toEqual([...claimReviewGrowthScales]);
        assertGrowthAccessPaths(report.name, report.samples, ['community.realm', 'community.realm_claim_request']);
        for (const sample of report.samples) {
          for (const cost of sample.repetitions) {
            expect(cost.statements).toBeGreaterThan(0);
            expect(cost.rows).toBeGreaterThan(0);
            expect(cost.blocks).toBeGreaterThan(0);
            expect(cost.plans).toBeGreaterThan(0);
            expect(cost.backgroundStatements ?? 0).toBe(0);
          }
          for (const run of sample.statementRepetitions)
            expect(run.some(({ statement }) => statement === reviewPage.sql)).toBe(true);
        }
      } finally {
        await fixture.clearGrowth(axis);
      }
    }
    expect(await fixture.source()).toEqual(orphan);
  } finally {
    await fixture.close();
  }
}, 1_200_000);
