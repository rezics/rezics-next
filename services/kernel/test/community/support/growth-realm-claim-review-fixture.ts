import { expect } from 'bun:test';
import { PLATFORM_RESOURCE } from '../../../src/access/bootstrap-governance.ts';
import { routeOf } from '../../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { contentGovernanceCredential } from '../../content/support/system.ts';
import { accountDeletionRuntime, deletePersona } from '../../support/account-deletion.ts';
import { createCommunityDriver, communityFixtureRuntime, closeCommunityDrivers } from '../community-driver.ts';

/** Native setup only. Never manufacture the ownership decision needed by the listing. */
export async function claimReviewGrowthFixture() {
  const driver = await createCommunityDriver();
  try {
    const { system } = communityFixtureRuntime();
    const deletion = accountDeletionRuntime(system);
    const owner = await deletion.person();
    const governance = await contentGovernanceCredential(system);
    const caller = { id: owner.accountId, bearer: owner.bearer };
    async function post<T>(path: string, body: unknown, actor = caller): Promise<T> {
      const response = await driver.request({
        method: 'POST',
        path,
        actor,
        body,
        key: JSON.stringify(crypto.randomUUID()),
      });
      const value: unknown = await response.json();
      expect({ status: response.status, value }).toMatchObject({ status: 201 });
      return value as T;
    }
    await post(
      '/v1/grants',
      {
        resource: PLATFORM_RESOURCE,
        subject: { kind: 'account', id: owner.accountId },
        actions: ['space:create', 'realm:create'],
        valid: '(,)',
      },
      { id: governance.actor.accountId, bearer: governance.bearer },
    );
    const { space } = await post<{ space: { spaceId: string } }>('/v1/spaces', {
      title: 'Native claim review growth host',
    });
    const { realm } = await post<{ realm: { realmId: string; headRevisionId: string } }>('/v1/realms', {
      spaceId: space.spaceId,
      contextId: GLOBAL_CONTEXT,
      visibility: 'public',
      title: 'Native claim review growth source',
    });
    await driver.settle();
    async function source() {
      const result = await system.database.pool.query<{
        ownership_state: string;
        orphaned_at: string | null;
        claim_eligible_at: string | null;
        original_root: boolean | null;
        original_deadline: boolean | null;
        head_revision_id: string;
        state: string;
      }>(
        `SELECT ownership_state, orphaned_at::text, claim_eligible_at::text,
                orphaned_at=$3::timestamptz AS original_root,
                claim_eligible_at=orphaned_at + interval '720 hours' AS original_deadline,
                head_revision_id::text, state
         FROM community.realm WHERE route=$1 AND realm_id=$2`,
        [routeOf(realm.realmId), realm.realmId, erasedAt],
      );
      expect(result.rows).toHaveLength(1);
      return result.rows[0]!;
    }
    let erasedAt: string | null = null;
    return {
      realm,
      ownerAccountId: owner.accountId,
      source,
      async eraseOwner() {
        // Auth commits the immutable root. The default registered Community
        // participant must perform succession before retiring its owner locator.
        const erased = await deletePersona({ pool: system.database.pool, auth: deletion.auth }, owner);
        erasedAt = erased.at;
        await driver.settle();
        return erased;
      },
      async close() {
        await driver.close();
        await closeCommunityDrivers();
      },
    };
  } catch (error) {
    await driver.close();
    await closeCommunityDrivers();
    throw error;
  }
}
