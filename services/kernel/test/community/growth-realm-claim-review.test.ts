import { expect, test } from 'bun:test';
import { claimReviewGrowthFixture } from './support/growth-realm-claim-review-fixture.ts';

test('registered owner erasure supplies the original native orphan episode required by claim review growth', async () => {
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
    });
  } finally {
    await fixture.close();
  }
}, 600_000);
