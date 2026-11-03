import { expect } from 'bun:test';
import type { RealmClaimRequest } from '../../../src/community/realm-continuity.ts';
import type { RealmClaimReviewPage } from '../../../src/community/realm-claim-review.ts';
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
    const claimant = system.actors.author;
    const reviewer = system.actors.moderator;
    const control = system.actors.other;
    const reviewPath = `/v1/realms/${realm.realmId}/claimRequests`;
    async function reviewCall<T>(
      method: 'GET' | 'POST',
      query: string,
      status: number,
      bearer: string,
    ): Promise<T> {
      // Use the fixture's native Kernel, which carries its trusted command clock,
      // with the same production Access and registered erasure runtime as the driver.
      const response = await system.kernel.handle(
        new Request(`https://content.test${reviewPath}${query}`, {
          method,
          headers: {
            authorization: `Bearer ${bearer}`,
            ...(method === 'POST'
              ? { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) }
              : {}),
          },
          ...(method === 'POST' ? { body: '{}' } : {}),
        }),
      );
      const value: unknown = await response.json();
      expect({ status: response.status, value }).toMatchObject({ status });
      return value as T;
    }
    return {
      realm,
      ownerAccountId: owner.accountId,
      source,
      claimantAccountId: claimant.actor.accountId,
      async prepareReview() {
        const sourceRow = await source();
        expect(sourceRow.ownership_state).toBe('orphaned');
        expect(sourceRow.original_root).toBe(true);
        expect(sourceRow.original_deadline).toBe(true);
        expect(sourceRow.claim_eligible_at).toBeString();
        for (const account of [reviewer, control])
          await post(
            '/v1/grants',
            {
              resource: PLATFORM_RESOURCE,
              subject: { kind: 'account', id: account.actor.accountId },
              actions: ['realm:approve_claim'],
              valid: '(,)',
            },
            { id: governance.actor.accountId, bearer: governance.bearer },
          );
        await post(
          '/v1/grants',
          {
            resource: { route: routeOf(realm.realmId), id: realm.realmId },
            subject: { kind: 'account', id: claimant.actor.accountId },
            actions: ['realm:read', 'realm:participate'],
            valid: '(,)',
          },
          { id: governance.actor.accountId, bearer: governance.bearer },
        );
        const eligible = Date.parse(sourceRow.claim_eligible_at!);
        // Date clocks have millisecond precision; bracket the original database
        // deadline without rounding its episode identity or rewriting the source.
        await system.clock.setCommandTime(new Date(eligible - 1).toISOString());
        const early = await reviewCall<{ code: string }>('POST', '', 409, claimant.bearer);
        expect(early.code).toBe('conflict');
        await system.clock.setCommandTime(new Date(eligible + 1).toISOString());
      },
      submit: () => reviewCall<RealmClaimRequest>('POST', '', 202, claimant.bearer),
      list(limit = 1, cursor?: string, actor: 'reviewer' | 'control' | 'claimant' = 'reviewer') {
        const query = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) });
        return reviewCall<RealmClaimReviewPage>(
          'GET',
          `?${query}`,
          200,
          { reviewer, control, claimant }[actor].bearer,
        );
      },
      async rejectedList(code: string, actor: 'reviewer' | 'control' | 'claimant', limit = 1, cursor?: string) {
        const query = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) });
        const value = await reviewCall<{ code: string }>(
          'GET',
          `?${query}`,
          code === 'not_found' ? 404 : 400,
          { reviewer, control, claimant }[actor].bearer,
        );
        expect(value.code).toBe(code);
      },
      async revokeReviewer() {
        const response = await driver.request({
          method: 'POST',
          path: '/v1/grants:revoke',
          actor: { id: governance.actor.accountId, bearer: governance.bearer },
          key: JSON.stringify(crypto.randomUUID()),
          body: {
            resource: PLATFORM_RESOURCE,
            subject: { kind: 'account', id: reviewer.actor.accountId },
            actions: ['realm:approve_claim'],
            valid: '(,)',
          },
        });
        expect({ status: response.status, value: await response.json() }).toMatchObject({ status: 200 });
      },
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
