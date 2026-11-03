import { expect } from 'bun:test';
import type { RealmClaimRequest } from '../../../src/community/realm-continuity.ts';
import type { RealmClaimReviewPage } from '../../../src/community/realm-claim-review.ts';
import { PLATFORM_RESOURCE } from '../../../src/access/bootstrap-governance.ts';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { createKernel, type Kernel } from '../../../src/http/kernel.ts';
import reviewPage from '../../../src/community/realm-claim-review-page.sql';
import { contentGovernanceCredential } from '../../content/support/system.ts';
import { observeSql } from '../../content/support/sql-observer.ts';
import { accountDeletionRuntime, deletePersona } from '../../support/account-deletion.ts';
import { openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../../support/growth.ts';
import { createCommunityDriver, communityFixtureRuntime, closeCommunityDrivers } from '../community-driver.ts';

export const claimReviewGrowthScales = [256, 1024, 4096] as const;
export const claimReviewGrowthAxes = ['realms', 'requests', 'episodes'] as const;
export type ClaimReviewGrowthAxis = (typeof claimReviewGrowthAxes)[number];

/** Native setup only. Never manufacture the ownership decision needed by the listing. */
export async function claimReviewGrowthFixture() {
  const driver = await createCommunityDriver();
  let growth: GrowthDatabase | undefined;
  let growthObserver: ReturnType<typeof observeSql> | undefined;
  try {
    const { system } = communityFixtureRuntime();
    const databaseUrl = system.database.pool.options.connectionString;
    if (!databaseUrl) throw new Error('Community fixture database URL is missing');
    growth = await openGrowthDatabase(databaseUrl);
    growthObserver = observeSql(growth.pool);
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
        lifecycle_version: number;
        discovery_epoch: number;
        state: string;
      }>(
        `SELECT ownership_state, orphaned_at::text, claim_eligible_at::text,
                orphaned_at=$3::timestamptz AS original_root,
                claim_eligible_at=orphaned_at + interval '720 hours' AS original_deadline,
                head_revision_id::text, lifecycle_version, discovery_epoch, state
         FROM community.realm WHERE route=$1 AND realm_id=$2`,
        [routeOf(realm.realmId), realm.realmId, erasedAt],
      );
      expect(result.rows).toHaveLength(1);
      return result.rows[0]!;
    }
    let erasedAt: string | null = null;
    let trustedReadTime = new Date();
    const claimant = system.actors.author;
    const reviewer = system.actors.moderator;
    const control = system.actors.other;
    const reviewPath = `/v1/realms/${realm.realmId}/claimRequests`;
    const growthKernel: Kernel = createKernel({
      pool: growth.pool,
      routeKey: system.routeKey,
      tokens: system.tokenKeys,
      access: system.access,
      clock: () => new Date(trustedReadTime),
      content: { cursorNow: () => Date.now() },
      writeRate: createWriteRateLimiter({ secret: crypto.randomUUID() + crypto.randomUUID(), overrides: '{}' }),
      ratePeer: () => '127.0.0.1',
    });
    async function reviewCall<T>(
      method: 'GET' | 'POST',
      query: string,
      status: number,
      bearer: string,
      kernel: Kernel = system.kernel,
    ): Promise<T> {
      // Use the fixture's native Kernel, which carries its trusted command clock,
      // with the same production Access and registered erasure runtime as the driver.
      const response = await kernel.handle(
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
    async function revokeReviewer() {
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
    }

    const realmIds: string[] = [];
    const realmSpaceIds = new Map<string, string>();
    const unrelatedRequestIds: string[] = [];
    const episodeRequestIds: string[] = [];
    const unrelatedRealmId = newId(routeOf(realm.realmId)!);
    const requestHostSpaceId = newId(routeOf(realm.realmId)!);
    const requestHostSpaceRevisionId = newId(routeOf(realm.realmId)!);
    const requestHostRealmRevisionId = newId(routeOf(realm.realmId)!);
    let sourceCache: Awaited<ReturnType<typeof source>> | undefined;
    const requestHost: Population = {
      name: `claim-review-request-host-${crypto.randomUUID()}`,
      hotPartition: partitionOf(routeOf(realm.realmId)!),
      hotShare: 1,
      rows() {
        const route = routeOf(realm.realmId)!;
        if (!erasedAt) throw new Error('Claim review growth requires the native orphan episode');
        realmSpaceIds.set(unrelatedRealmId, requestHostSpaceId);
        return {
          'community.space': [
            {
              route,
              space_id: requestHostSpaceId,
              state: 'active',
              head_revision_id: requestHostSpaceRevisionId,
              created_at: erasedAt!,
              creator: owner.accountId,
            },
          ],
          'community.space_revision': [
            {
              route,
              space_id: requestHostSpaceId,
              revision_id: requestHostSpaceRevisionId,
              predecessor: null,
              title: 'Unrelated claim review request host',
              summary: '',
              created_at: erasedAt!,
              author: owner.accountId,
            },
          ],
          'community.realm': [
            {
              route,
              realm_id: unrelatedRealmId,
              space_id: requestHostSpaceId,
              state: 'active',
              visibility: 'public',
              context_id: GLOBAL_CONTEXT,
              head_revision_id: requestHostRealmRevisionId,
              created_at: erasedAt!,
              creator: owner.accountId,
              ownership_state: 'orphaned',
              orphaned_at: erasedAt,
              claim_eligible_at: sourceCache!.claim_eligible_at!,
            },
          ],
          'community.realm_revision': [
            {
              route,
              realm_id: unrelatedRealmId,
              revision_id: requestHostRealmRevisionId,
              predecessor: null,
              title: 'Unrelated claim review request host',
              summary: '',
              visibility: 'public',
              context_id: GLOBAL_CONTEXT,
              created_at: erasedAt!,
              author: owner.accountId,
            },
          ],
        };
      },
    };
    const unrelatedRealms: Population = {
      name: `claim-review-unrelated-realms-${crypto.randomUUID()}`,
      hotPartition: partitionOf(routeOf(realm.realmId)!),
      hotShare: 1,
      rows({ ordinal }) {
        const route = routeOf(realm.realmId)!;
        const spaceId = newId(route);
        const spaceRevisionId = newId(route);
        const realmId = ordinal === 0 ? unrelatedRealmId : newId(route);
        const realmRevisionId = newId(route);
        realmIds[ordinal] = realmId;
        realmSpaceIds.set(realmId, spaceId);
        return {
          'community.space': [
            {
              route,
              space_id: spaceId,
              state: 'active',
              head_revision_id: spaceRevisionId,
              created_at: erasedAt!,
              creator: owner.accountId,
            },
          ],
          'community.space_revision': [
            {
              route,
              space_id: spaceId,
              revision_id: spaceRevisionId,
              predecessor: null,
              title: 'Unrelated claim review Space',
              summary: '',
              created_at: erasedAt!,
              author: owner.accountId,
            },
          ],
          'community.realm': [
            {
              route,
              realm_id: realmId,
              space_id: spaceId,
              state: 'active',
              visibility: 'public',
              context_id: GLOBAL_CONTEXT,
              head_revision_id: realmRevisionId,
              created_at: erasedAt!,
              creator: owner.accountId,
            },
          ],
          'community.realm_revision': [
            {
              route,
              realm_id: realmId,
              revision_id: realmRevisionId,
              predecessor: null,
              title: 'Unrelated claim review Realm',
              summary: '',
              visibility: 'public',
              context_id: GLOBAL_CONTEXT,
              created_at: erasedAt,
              author: owner.accountId,
            },
          ],
        };
      },
    };
    function requestPopulation(
      name: string,
      hostRealmId: string,
      orphanedAt: string,
      requestedAt: string,
      requestIds: string[],
    ): Population {
      return {
        name,
        hotPartition: partitionOf(routeOf(realm.realmId)!),
        hotShare: 1,
        rows({ ordinal }) {
          const route = routeOf(realm.realmId)!;
          const requestId = newId(route);
          requestIds[ordinal] = requestId;
          return {
            'community.realm_claim_request': [
              {
                route,
                realm_id: hostRealmId,
                request_id: requestId,
                account_id: newId(route),
                orphaned_at: orphanedAt,
                requested_at: requestedAt,
                state: 'pending',
                approved_at: null,
              },
            ],
          };
        },
      };
    }
    let unrelatedRequests: Population | undefined;
    let retainedEpisodes: Population | undefined;
    let requestHostSeeded = false;
    async function grow(axis: ClaimReviewGrowthAxis, scale: number, previous: number) {
      if (!erasedAt) throw new Error('Claim review growth requires the native orphan episode');
      sourceCache ??= await source();
      if (axis === 'requests' && !requestHostSeeded) {
        await seed({ pool: growth!.pool, admin: growth!.admin }, requestHost, { from: 0, to: 1 });
        requestHostSeeded = true;
      }
      unrelatedRequests ??= requestPopulation(
        `claim-review-unrelated-requests-${crypto.randomUUID()}`,
        unrelatedRealmId,
        erasedAt,
        new Date(Date.parse(sourceCache!.claim_eligible_at!) + 1).toISOString(),
        unrelatedRequestIds,
      );
      retainedEpisodes ??= requestPopulation(
        `claim-review-retained-episodes-${crypto.randomUUID()}`,
        realm.realmId,
        new Date(Date.parse(erasedAt) - 32 * 86_400_000).toISOString(),
        new Date(Date.parse(erasedAt) - 86_400_000).toISOString(),
        episodeRequestIds,
      );
      const population = axis === 'realms' ? unrelatedRealms : axis === 'requests' ? unrelatedRequests : retainedEpisodes;
      await seed({ pool: growth!.pool, admin: growth!.admin }, population, { from: previous, to: scale });
      const ids = axis === 'realms' ? realmIds : axis === 'requests' ? unrelatedRequestIds : episodeRequestIds;
      const table = axis === 'realms' ? 'community.realm' : 'community.realm_claim_request';
      const column = axis === 'realms' ? 'realm_id' : 'request_id';
      const count = await growth!.admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table} WHERE route=$1 AND ${column}=ANY($2::uuid[])`,
        [routeOf(realm.realmId), ids.slice(0, scale)],
      );
      expect(Number(count.rows[0]?.count)).toBe(scale);
    }
    async function clearPressureRealms(realmKeys: string[]) {
      if (!realmKeys.length) return;
      const client = await growth!.admin.connect();
      const route = routeOf(realm.realmId)!;
      try {
        await client.query('BEGIN');
        await client.query('SET CONSTRAINTS ALL DEFERRED');
        await client.query('DELETE FROM community.realm_revision WHERE route=$1 AND realm_id=ANY($2::uuid[])', [
          route,
          realmKeys,
        ]);
        await client.query('DELETE FROM community.realm WHERE route=$1 AND realm_id=ANY($2::uuid[])', [route, realmKeys]);
        const spaces = realmKeys.map((realmKey) => realmSpaceIds.get(realmKey)).filter((value): value is string => !!value);
        await client.query('DELETE FROM community.space_revision WHERE route=$1 AND space_id=ANY($2::uuid[])', [
          route,
          spaces,
        ]);
        await client.query('DELETE FROM community.space WHERE route=$1 AND space_id=ANY($2::uuid[])', [route, spaces]);
        await client.query('COMMIT');
        for (const realmKey of realmKeys) realmSpaceIds.delete(realmKey);
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {}
        throw error;
      } finally {
        client.release();
      }
    }
    async function setReviewTime(millisecondsAfterEligibility: number) {
      const row = await source();
      trustedReadTime = new Date(Date.parse(row.claim_eligible_at!) + millisecondsAfterEligibility);
      await system.clock.setCommandTime(trustedReadTime.toISOString());
    }
    async function clearGrowth(axis: ClaimReviewGrowthAxis) {
      const route = routeOf(realm.realmId)!;
      if (axis === 'realms') {
        await clearPressureRealms(realmIds.filter(Boolean));
        realmIds.length = 0;
        return;
      }
      const ids = (axis === 'requests' ? unrelatedRequestIds : episodeRequestIds).filter(Boolean);
      if (ids.length)
        await growth!.admin.query('DELETE FROM community.realm_claim_request WHERE route=$1 AND request_id=ANY($2::uuid[])', [
          route,
          ids,
        ]);
      (axis === 'requests' ? unrelatedRequestIds : episodeRequestIds).length = 0;
      if (axis === 'requests' && requestHostSeeded) {
        await clearPressureRealms([unrelatedRealmId]);
        requestHostSeeded = false;
      }
    }
    async function grantReviewer() {
      await post(
        '/v1/grants',
        {
          resource: PLATFORM_RESOURCE,
          subject: { kind: 'account', id: reviewer.actor.accountId },
          actions: ['realm:approve_claim'],
          valid: '(,)',
        },
        { id: governance.actor.accountId, bearer: governance.bearer },
      );
      await driver.settle();
    }
    async function bumpPartitionEpochAndReject(cursor: string) {
      const route = routeOf(realm.realmId)!;
      const partition = partitionOf(route);
      const before = await system.database.pool.query<{ epoch: number }>(
        'SELECT epoch FROM core.partition WHERE partition_no=$1',
        [partition],
      );
      const epoch = before.rows[0]?.epoch;
      if (epoch === undefined) throw new Error('Claim review partition is missing');
      await system.database.pool.query('UPDATE core.partition SET epoch=$2 WHERE partition_no=$1', [partition, epoch + 1]);
      try {
        await rejectListAt('stale_cursor', 'reviewer', 1, cursor, system.kernel);
      } finally {
        await system.database.pool.query('UPDATE core.partition SET epoch=$2 WHERE partition_no=$1', [partition, epoch]);
      }
    }
    async function listAt(
      limit: number,
      cursor: string | undefined,
      actor: 'reviewer' | 'control' | 'claimant',
      kernel: Kernel,
    ) {
      const query = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) });
      return reviewCall<RealmClaimReviewPage>(
        'GET',
        `?${query}`,
        200,
        { reviewer, control, claimant }[actor].bearer,
        kernel,
      );
    }
    async function rejectListAt(
      code: string,
      actor: 'reviewer' | 'control' | 'claimant',
      limit: number,
      cursor: string | undefined,
      kernel: Kernel,
    ) {
      const query = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) });
      const status = code === 'not_found' ? 404 : code === 'stale_cursor' ? 409 : 400;
      const value = await reviewCall<{ code: string }>(
        'GET',
        `?${query}`,
        status,
        { reviewer, control, claimant }[actor].bearer,
        kernel,
      );
      expect(value.code).toBe(code);
    }
    async function measureListingPaths(expected: readonly RealmClaimReviewPage['claimRequests'][number][]) {
      const first = await listAt(100, undefined, 'reviewer', growthKernel);
      expect(first).toEqual({ claimRequests: expected.slice(0, 20), next: expect.any(String) });
      const deep = await listAt(100, first.next!, 'reviewer', growthKernel);
      expect(deep).toEqual({ claimRequests: expected.slice(20), next: expect.any(String) });
      expect(await listAt(100, deep.next!, 'reviewer', growthKernel)).toEqual({ claimRequests: [], next: null });

      await setReviewTime(1);
      const filtered = await listAt(100, undefined, 'reviewer', growthKernel);
      expect(filtered).toEqual({ claimRequests: [], next: expect.any(String) });
      const filteredDeep = await listAt(100, filtered.next!, 'reviewer', growthKernel);
      expect(filteredDeep).toEqual({ claimRequests: [], next: expect.any(String) });
      expect(await listAt(100, filteredDeep.next!, 'reviewer', growthKernel)).toEqual({
        claimRequests: [],
        next: null,
      });
      const filteredOne = await listAt(1, undefined, 'reviewer', growthKernel);
      expect(filteredOne).toEqual({ claimRequests: [], next: expect.any(String) });
      expect(await listAt(1, filteredOne.next!, 'reviewer', growthKernel)).toEqual({
        claimRequests: [],
        next: expect.any(String),
      });
      await setReviewTime(2);
      expect(await listAt(100, filtered.next!, 'reviewer', growthKernel)).toEqual({
        claimRequests: expected.slice(20),
        next: expect.any(String),
      });
      expect(await listAt(1, filteredOne.next!, 'reviewer', growthKernel)).toEqual({
        claimRequests: [expected[1]!],
        next: expect.any(String),
      });

      await rejectListAt('not_found', 'claimant', 1, undefined, growthKernel);
      expect(await listAt(100, undefined, 'control', growthKernel)).toEqual({
        claimRequests: expected.slice(0, 20),
        next: expect.any(String),
      });
      await revokeDuringGrowthList();
      expect(await listAt(100, undefined, 'control', growthKernel)).toEqual({
        claimRequests: expected.slice(0, 20),
        next: expect.any(String),
      });
    }
    async function revokeDuringGrowthList() {
      const barrier = growthObserver!.hold({ statement: reviewPage.sql }, 'after');
      const pending = reviewCall<{ code: string }>('GET', '?limit=20', 404, reviewer.bearer, growthKernel);
      try {
        const reached = await Promise.race([barrier.entered.then(() => true), pending.then(() => false)]);
        expect(reached).toBe(true);
        await revokeReviewer();
      } finally {
        barrier.release();
        await pending;
      }
      expect((await pending).code).toBe('not_found');
    }
    if (!growth || !growthObserver) throw new Error('Claim review growth instrumentation was not opened');
    return {
      realm,
      ownerAccountId: owner.accountId,
      source,
      claimantAccountId: claimant.actor.accountId,
      growthDatabase: growth,
      grow,
      clearGrowth,
      grantReviewer,
      measureListingPaths,
      bumpPartitionEpochAndReject,
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
        trustedReadTime = new Date(eligible - 1);
        await system.clock.setCommandTime(trustedReadTime.toISOString());
        const early = await reviewCall<{ code: string }>('POST', '', 409, claimant.bearer);
        expect(early.code).toBe('conflict');
        trustedReadTime = new Date(eligible + 2);
        await system.clock.setCommandTime(trustedReadTime.toISOString());
      },
      submit: () => reviewCall<RealmClaimRequest>('POST', '', 202, claimant.bearer),
      async submitAdditional(count: number) {
        const items = [];
        for (let i = 0; i < count; i++) {
          const person = await deletion.person();
          await post(
            '/v1/grants',
            {
              resource: { route: routeOf(realm.realmId), id: realm.realmId },
              subject: { kind: 'account', id: person.accountId },
              actions: ['realm:read', 'realm:participate'],
              valid: '(,)',
            },
            { id: governance.actor.accountId, bearer: governance.bearer },
          );
          const claim = await reviewCall<RealmClaimRequest>('POST', '', 202, person.bearer);
          items.push({ ...claim, claimantAccountId: person.accountId });
        }
        return items;
      },
      async reviewTime(millisecondsAfterEligibility: number) {
        await setReviewTime(millisecondsAfterEligibility);
      },
      list(
        limit = 1,
        cursor?: string,
        actor: 'reviewer' | 'control' | 'claimant' = 'reviewer',
        runtime: 'native' | 'growth' = 'native',
      ) {
        return listAt(limit, cursor, actor, runtime === 'growth' ? growthKernel : system.kernel);
      },
      rejectedList(
        code: string,
        actor: 'reviewer' | 'control' | 'claimant',
        limit = 1,
        cursor?: string,
        runtime: 'native' | 'growth' = 'native',
      ) {
        return rejectListAt(code, actor, limit, cursor, runtime === 'growth' ? growthKernel : system.kernel);
      },
      async revokeDuringList() {
        // Hold the actual HTTP read after its initial candidate query. The
        // ordinary grant command commits before the final source/Access snapshot.
        const observer = observeSql(system.database.pool);
        const barrier = observer.hold({ statement: reviewPage.sql }, 'after');
        const pending = reviewCall<{ code: string }>('GET', '?limit=20', 404, reviewer.bearer);
        try {
          const reached = await Promise.race([barrier.entered.then(() => true), pending.then(() => false)]);
          expect(reached).toBe(true);
          await revokeReviewer();
        } finally {
          barrier.release();
          await observer.close();
          await pending;
        }
        expect((await pending).code).toBe('not_found');
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
        try {
          await growthObserver?.close();
        } finally {
          try {
            await growth?.close();
          } finally {
            await driver.close();
            await closeCommunityDrivers();
          }
        }
      },
    };
  } catch (error) {
    try {
      await growthObserver?.close();
    } finally {
      try {
        await growth?.close();
      } finally {
        await driver.close();
        await closeCommunityDrivers();
      }
    }
    throw error;
  }
}
