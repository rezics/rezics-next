import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Account, CommunityDriver, Fixture, Method, Realm, Space } from '../../../../specs/community-driver.ts';
import type { BanReviewPage } from '../../src/community/ban-review-page-schemas.ts';
import pageWindow from '../../src/community/ban-review-page-window.sql';
import identities from '../../src/access/public-identity-page.sql';
import { routeOf } from '../../src/route/route.ts';
import { observeSql } from '../content/support/sql-observer.ts';
import { accountDeletionRuntime, deletePersona } from '../support/account-deletion.ts';
import { createCommunityDriver, closeCommunityDrivers, communityFixtureRuntime } from './community-driver.ts';

let driver: CommunityDriver, fixture: Fixture;
beforeAll(async () => {
  driver = await createCommunityDriver();
  fixture = await driver.provision();
}, 120_000);
afterAll(closeCommunityDrivers);
const call = (method: Method, path: string, actor: Account | null = fixture.owner, body?: unknown) =>
  driver.request({
    method,
    path,
    actor,
    ...(body === undefined ? {} : { body }),
    ...(method === 'GET' ? {} : { key: JSON.stringify(crypto.randomUUID()) }),
  });
async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json();
  expect({ status: response.status, body }).toMatchObject({ status });
  return body as T;
}
async function realm() {
  const { space } = await json<{ space: Space }>(
    await call('POST', '/v1/spaces', fixture.owner, { title: 'Ban host' }),
    201,
  );
  const { realm } = await json<{ realm: Realm }>(
    await call('POST', '/v1/realms', fixture.owner, {
      spaceId: space.spaceId,
      title: 'Operational bans',
      visibility: 'protected',
      contextId: fixture.contextId,
    }),
    201,
  );
  expect((await driver.grantModerator(realm.realmId, fixture.moderator)).status).toBe(201);
  return realm;
}
const path = (realm: Realm) => `/v1/realms/${realm.realmId}/bans`;
const ban = (realm: Realm, id: string, reason = 'Actual reason', actor = fixture.owner) =>
  call('PUT', `${path(realm)}/${id}`, actor, { reason });
const unban = (realm: Realm, id: string) => call('DELETE', `${path(realm)}/${id}`);
// Preserve the exact query, including cursor and selected key, on every read.
function callRead(realm: Realm, query = '', actor = fixture.owner) {
  return call('GET', `${path(realm)}${query}`, actor);
}

// This mounted outcome exposes the base gap: bare account IDs supplied neither
// current presentation, command advice nor an exact selection/readback envelope.
test.serial(
  'mounted inventory recognizes Accounts, confirms one current target and reads actual post-command state',
  async () => {
    const r = await realm();
    const empty = await json<BanReviewPage>(await callRead(r));
    expect(empty).toMatchObject({
      items: [],
      next: null,
      selected: { state: 'not-requested' },
      context: { state: 'available', realmTitle: 'Operational bans', spaceTitle: 'Ban host' },
      viewer: {
        accountId: fixture.owner.id,
        unban: { state: 'permitted', operationId: 'realm.unban', reauthorizes: true },
      },
    });
    for (const actor of [fixture.member, fixture.outsider]) expect((await callRead(r, '', actor)).status).toBe(403);
    expect((await call('GET', path(r), null)).status).toBe(401);
    expect((await ban(r, fixture.owner.id)).status).toBe(409);
    await json(
      await call('POST', `/v1/realms/${r.realmId}/members`, fixture.owner, { accountId: fixture.member.id }),
      202,
    );
    await driver.settle();
    const receipt = await json<{ ban: { workflowId: string; at: string } }>(await ban(r, fixture.member.id));
    expect(receipt.ban.workflowId).toEqual(expect.any(String));
    await driver.settle(); // A receipt alone is not completed native removal.
    const q = `?selectedAccountId=${fixture.member.id}`;
    const listed = await json<BanReviewPage>(await callRead(r, q));
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      accountId: fixture.member.id,
      reason: 'Actual reason',
      at: receipt.ban.at,
      account: { state: 'available', accountId: fixture.member.id, destination: expect.stringMatching(/^\/@/) },
      moderator: { state: 'available', accountId: fixture.owner.id },
      unban: { state: 'permitted', accountId: fixture.member.id, membershipRestored: false },
      removal: { state: 'unavailable' },
    });
    expect(listed.selected).toEqual({ state: 'current', ban: listed.items[0] });
    expect((await call('GET', `/v1/realms/${r.realmId}/members/me`, fixture.member)).status).toBe(404);
    expect((await unban(r, fixture.member.id)).status).toBe(204);
    const absent = await json<BanReviewPage>(await callRead(r, q));
    expect(absent).toMatchObject({
      items: [],
      next: null,
      selected: { state: 'absent', accountId: fixture.member.id },
    });
    expect((await call('GET', `/v1/realms/${r.realmId}/members/me`, fixture.member)).status).toBe(404);
    const fresh = await json<{ ban: { at: string } }>(await ban(r, fixture.member.id, 'New episode'));
    expect(fresh.ban.at).not.toBe(receipt.ban.at);
    expect((await json<BanReviewPage>(await callRead(r, q))).selected).toMatchObject({
      state: 'current',
      ban: { reason: 'New episode', at: fresh.ban.at },
    });
  },
  120_000,
);

test.serial(
  '20/21 and 100/101 raw boundaries, exact selection outside the page and same-input continuation',
  async () => {
    const r = await realm();
    const { system } = communityFixtureRuntime();
    const ids: string[] = [];
    for (let i = 0; i < 101; i++) ids.push((await accountDeletionRuntime(system).person()).accountId);
    ids.sort();
    for (const id of ids) await json(await ban(r, id));
    const first = await json<BanReviewPage>(await callRead(r));
    expect(first.items.map((item) => item.accountId)).toEqual(ids.slice(0, 20));
    expect(first.next).toEqual(expect.any(String));
    const selected = await json<BanReviewPage>(await callRead(r, `?selectedAccountId=${ids[100]}`));
    expect(selected.next).toBe(first.next);
    expect(selected.items).toEqual(first.items);
    expect(selected.selected).toMatchObject({
      state: 'current',
      ban: { accountId: ids[100], account: { state: 'concealed', label: 'Account', destination: null } },
    });
    const q = `?cursor=${encodeURIComponent(first.next!)}&selectedAccountId=${ids[100]}`;
    const retry = await json<BanReviewPage>(await callRead(r, q));
    expect(await json<BanReviewPage>(await callRead(r, q))).toEqual(retry);
    expect(retry.items.map((item) => item.accountId)).toEqual(ids.slice(20, 40));
    const hundred = await json<BanReviewPage>(await callRead(r, '?limit=100'));
    expect(hundred.items.map((item) => item.accountId)).toEqual(ids.slice(0, 100));
    const end = await json<BanReviewPage>(await callRead(r, `?limit=100&cursor=${encodeURIComponent(hundred.next!)}`));
    expect(end.items.map((item) => item.accountId)).toEqual(ids.slice(100));
    expect(end.next).toBeNull();
    for (const id of ids.slice(20)) expect((await unban(r, id)).status).toBe(204);
    expect((await json<BanReviewPage>(await callRead(r))).next).toBeNull();
    expect((await callRead(r, `?limit=1&cursor=${encodeURIComponent(first.next!)}`)).status).toBe(400);
    expect((await callRead(r, `?cursor=${encodeURIComponent(first.next!)}`, fixture.moderator)).status).toBe(400);
  },
  180_000,
);

test.serial(
  'erased target keeps its operational row and erased moderator retains native null actor',
  async () => {
    const r = await realm(),
      { system } = communityFixtureRuntime();
    const deletion = accountDeletionRuntime(system),
      person = await deletion.person();
    await json(await ban(r, person.accountId));
    await deletePersona({ pool: system.database.pool, auth: deletion.auth }, person);
    await driver.settle();
    const hidden = await json<BanReviewPage>(await callRead(r, `?selectedAccountId=${person.accountId}`));
    expect(hidden.items[0]?.account).toEqual({
      state: 'concealed',
      accountId: person.accountId,
      label: 'Account',
      destination: null,
    });
    expect(hidden.selected).toMatchObject({ state: 'current' });
    const mod = await deletion.person(),
      moderator = { id: mod.accountId, bearer: mod.bearer };
    expect((await driver.grantModerator(r.realmId, moderator)).status).toBe(201);
    await json(await ban(r, fixture.member.id, 'Native erased actor', moderator));
    await deletePersona({ pool: system.database.pool, auth: deletion.auth }, mod);
    await driver.settle();
    const current = await json<BanReviewPage>(await callRead(r, `?selectedAccountId=${fixture.member.id}`));
    expect(current.selected).toMatchObject({
      state: 'current',
      ban: { actor: null, moderator: null, reason: 'Native erased actor' },
    });
  },
  180_000,
);

test.serial(
  'hydration failure withholds a page, preserves exact retry and never replays a write',
  async () => {
    const r = await realm(),
      { system } = communityFixtureRuntime();
    await json(await ban(r, fixture.member.id));
    const q = `?selectedAccountId=${fixture.member.id}`;
    const before = await json<BanReviewPage>(await callRead(r, q));
    const observer = observeSql(system.database.pool);
    try {
      observer.armFault({
        match: { statement: identities.sql },
        boundary: 'before',
        error: new Error('Identity home unavailable'),
      });
      expect((await callRead(r, q)).status).toBe(503);
      expect(await json<BanReviewPage>(await callRead(r, q))).toEqual(before);
      expect(
        observer.records.every(
          (record) => !/INSERT INTO community.realm_ban|UPDATE community.realm_ban/.test(record.statement),
        ),
      ).toBe(true);
    } finally {
      await observer.close();
    }
  },
  60_000,
);

test.serial(
  'unban/reban, revocation, session fencing and removal after raw selection withhold stale facts',
  async () => {
    const { system } = communityFixtureRuntime();
    for (const change of ['episode', 'permission', 'empty-permission', 'session', 'removed'] as const) {
      const r = await realm();
      if (change !== 'empty-permission') await json(await ban(r, fixture.member.id));
      const observer = observeSql(system.database.pool);
      const barrier = observer.hold({ statement: pageWindow.sql }, 'after');
      const pending = callRead(r, `?selectedAccountId=${fixture.member.id}`, fixture.moderator);
      try {
        await barrier.entered;
        if (change === 'episode') {
          expect((await unban(r, fixture.member.id)).status).toBe(204);
          await json(await ban(r, fixture.member.id, 'Replaced while reading'));
        } else if (change === 'permission' || change === 'empty-permission') {
          expect(
            (
              await call('POST', '/v1/roleGrants:revoke', fixture.owner, {
                resource: { route: routeOf(r.realmId), id: r.realmId },
                subject: { kind: 'account', id: fixture.moderator.id },
                role: 'community.realm.moderator',
                valid: '(,)',
              })
            ).status,
          ).toBe(200);
        } else if (change === 'session') {
          await system.database.pool.query(
            'UPDATE access.account SET minimum_authn_epoch=minimum_authn_epoch+1 WHERE route=$1 AND account_id=$2',
            [routeOf(fixture.moderator.id), fixture.moderator.id],
          );
        } else {
          const { container } = await json<{ container: { version: string; headRevisionId: string } }>(
            await call('GET', `/v1/realms/${r.realmId}/lifecycle`),
          );
          await json(
            await driver.request({
              method: 'POST',
              path: `/v1/realms/${r.realmId}/removal`,
              actor: fixture.owner,
              key: JSON.stringify(crypto.randomUUID()),
              ifMatch: JSON.stringify(container.headRevisionId),
              body: { expectedVersion: container.version, reason: 'Removed during read' },
            }),
          );
        }
      } finally {
        barrier.release();
      }
      try {
        const response = await pending;
        expect([401, 403, 503]).toContain(response.status);
        expect(await response.text()).not.toContain('Actual reason');
      } finally {
        await observer.close();
        if (change === 'session')
          await system.database.pool.query(
            'UPDATE access.account SET minimum_authn_epoch=minimum_authn_epoch-1 WHERE route=$1 AND account_id=$2',
            [routeOf(fixture.moderator.id), fixture.moderator.id],
          );
      }
    }
  },
  180_000,
);

test.serial(
  'erasure during hydration withholds stale identity; retry observes a concealed current ban',
  async () => {
    const r = await realm(),
      { system } = communityFixtureRuntime();
    const deletion = accountDeletionRuntime(system),
      person = await deletion.person();
    await json(await ban(r, person.accountId));
    const observer = observeSql(system.database.pool);
    const barrier = observer.hold({ statement: identities.sql }, 'after');
    const pending = callRead(r, `?selectedAccountId=${person.accountId}`);
    try {
      await barrier.entered;
      try {
        await deletePersona({ pool: system.database.pool, auth: deletion.auth }, person);
      } finally {
        barrier.release();
      }
      const response = await pending;
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain(person.accountId);
      expect((await json<BanReviewPage>(await callRead(r))).items[0]).toMatchObject({
        accountId: person.accountId,
        account: { state: 'concealed', label: 'Account', destination: null },
      });
    } finally {
      barrier.release();
      await observer.close();
    }
  },
  120_000,
);

test.serial(
  'suspended caller cannot inspect even an empty inventory',
  async () => {
    const r = await realm(),
      { system } = communityFixtureRuntime();
    const person = await accountDeletionRuntime(system).person();
    const moderator = { id: person.accountId, bearer: person.bearer };
    expect((await driver.grantModerator(r.realmId, moderator)).status).toBe(201);
    await json<BanReviewPage>(await callRead(r, '', moderator));
    const suspended = await driver.suspend(moderator);
    expect(suspended.ok).toBe(true);
    expect([401, 403]).toContain((await callRead(r, '', moderator)).status);
  },
  60_000,
);
