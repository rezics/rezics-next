import { afterAll, beforeEach, expect, test } from 'bun:test';
import type { Account, CommunityDriver, Fixture, Realm, Space } from '../../../../specs/community-driver.ts';
import { closeCommunityDrivers, createCommunityDriver, restartWorker, worker } from './community-driver.ts';

let driver: CommunityDriver;
let fixture: Fixture;

beforeEach(async () => {
  driver = await createCommunityDriver();
  fixture = await driver.provision();
}, 120_000);

afterAll(closeCommunityDrivers);

async function call(method: 'GET' | 'POST' | 'DELETE' | 'PUT', path: string, actor: Account | null = fixture.owner, body?: unknown, key?: string) {
  return driver.request({
    method,
    path,
    actor,
    ...(body === undefined ? {} : { body }),
    ...(method === 'GET' ? {} : { key: key ?? JSON.stringify(crypto.randomUUID()) }),
  });
}

async function json<T>(response: Response, status = 200): Promise<T> {
  expect(response.status).toBe(status);
  return response.json() as Promise<T>;
}

async function realm(visibility: 'public' | 'protected' = 'public') {
  const { space } = await json<{ space: Space }>(await call('POST', '/v1/spaces', fixture.owner, { title: 'Members host' }), 201);
  const { realm } = await json<{ realm: Realm }>(
    await call('POST', '/v1/realms', fixture.owner, {
      spaceId: space.spaceId,
      title: 'Members Realm',
      visibility,
      contextId: fixture.contextId,
    }),
    201,
  );
  return realm;
}

const memberPath = (value: Realm) => `/v1/realms/${value.realmId}/members`;

test.serial('the manager reads actual members, inspects an exact account, and follows existing membership and ban outcomes', async () => {
  const currentRealm = await realm();
  const empty = await json<{ items: unknown[]; next: string | null }>(await call('GET', memberPath(currentRealm)));
  expect(empty).toEqual({ realmId: currentRealm.realmId, state: 'ready', items: [], next: null, selected: null });
  const ownerInspection = await json<{
    selected: { actions: { ban: { state: string; reason?: string } } };
  }>(await call('GET', `${memberPath(currentRealm)}?accountId=${fixture.owner.id}`));
  expect(ownerInspection.selected.actions.ban).toMatchObject({
    state: 'prohibited',
    reason: 'protected_owner_or_moderator',
  });

  await worker.stop();
  try {
    const key = JSON.stringify(crypto.randomUUID());
    const pendingAdd = await json<{ workflowId: string }>(
      await call('POST', memberPath(currentRealm), fixture.owner, { accountId: fixture.member.id }, key),
      202,
    );
    const replay = await json<{ workflowId: string }>(
      await call('POST', memberPath(currentRealm), fixture.owner, { accountId: fixture.member.id }, key),
      202,
    );
    expect(replay).toEqual(pendingAdd);
    const pending = await json<{ items: { accountId: string }[]; selected: { membership: string } }>(
      await call('GET', `${memberPath(currentRealm)}?accountId=${fixture.member.id}`),
    );
    expect(pending.items).toEqual([]);
    expect(pending.selected).toMatchObject({ accountId: fixture.member.id, membership: 'none' });
  } finally {
    await restartWorker();
    await driver.settle();
  }

  const populated = await json<{
    items: {
      accountId: string;
      identity: { state: string; displayName: string | null } | null;
      displayName: string;
      actions: { ban: { state: string; method?: string; path?: string; expectedStatus?: number } };
    }[];
    selected: {
      accountId: string;
      membership: string;
      banState: string;
      actions: { addMember: { state: string; method?: string; path?: string; expectedStatus?: number } };
    } | null;
    next: string | null;
  }>(await call('GET', `${memberPath(currentRealm)}?accountId=${fixture.outsider.id}`));
  expect(populated.items).toHaveLength(1);
  expect(populated.items[0]).toMatchObject({ accountId: fixture.member.id, membership: 'member', displayName: 'Member' });
  expect(populated.items[0]?.identity?.state).toBe('active');
  expect(populated.items[0]?.actions.ban).toMatchObject({
    state: 'available',
    method: 'PUT',
    path: `/v1/realms/${currentRealm.realmId}/bans/${fixture.member.id}`,
    expectedStatus: 200,
  });
  expect(populated.selected).toMatchObject({ accountId: fixture.outsider.id, membership: 'none' });
  expect(populated.selected?.banState).toBe('clear');
  expect(populated.selected?.actions.addMember).toMatchObject({
    state: 'available',
    method: 'POST',
    path: `/v1/realms/${currentRealm.realmId}/members`,
    expectedStatus: 202,
  });
  expect(populated.next).toBeNull();

  await worker.stop();
  try {
    expect((await call('DELETE', `/v1/realms/${currentRealm.realmId}/membership`, fixture.member)).status).toBe(202);
    const pendingLeave = await json<{ items: { accountId: string }[] }>(await call('GET', memberPath(currentRealm)));
    expect(pendingLeave.items.map((item) => item.accountId)).toEqual([fixture.member.id]);
  } finally {
    await restartWorker();
    await driver.settle();
  }
  const afterLeave = await json<{ items: unknown[]; selected: { membership: string; banState: string } }>(
    await call('GET', `${memberPath(currentRealm)}?accountId=${fixture.member.id}`),
  );
  expect(afterLeave.items).toEqual([]);
  expect(afterLeave.selected).toMatchObject({ membership: 'none', banState: 'clear' });

  await json(await call('POST', memberPath(currentRealm), fixture.owner, { accountId: fixture.member.id }), 202);
  await driver.settle();
  await worker.stop();
  try {
    await json(await call('PUT', `/v1/realms/${currentRealm.realmId}/bans/${fixture.member.id}`, fixture.owner, { reason: 'Repeated abuse' }));
    const pendingRemoval = await json<{ items: { accountId: string; banState: string }[] }>(await call('GET', memberPath(currentRealm)));
    expect(pendingRemoval.items).toMatchObject([{ accountId: fixture.member.id, banState: 'banned' }]);
  } finally {
    await restartWorker();
    await driver.settle();
  }
  const afterBan = await json<{
    items: unknown[];
    selected: {
      membership: string;
      banState: string;
      actions: {
        addMember: { state: string; reason?: string };
        unban: { state: string; method?: string; path?: string; expectedStatus?: number };
      };
    };
  }>(await call('GET', `${memberPath(currentRealm)}?accountId=${fixture.member.id}`));
  expect(afterBan.items).toEqual([]);
  expect(afterBan.selected).toMatchObject({ membership: 'none', banState: 'banned' });
  expect(afterBan.selected.actions.addMember).toMatchObject({ state: 'prohibited', reason: 'already_banned' });
  expect(afterBan.selected.actions.unban).toMatchObject({
    state: 'available',
    method: 'DELETE',
    path: `/v1/realms/${currentRealm.realmId}/bans/${fixture.member.id}`,
    expectedStatus: 204,
  });

  expect((await call('DELETE', `/v1/realms/${currentRealm.realmId}/bans/${fixture.member.id}`)).status).toBe(204);
  const afterUnban = await json<{
    selected: { membership: string; banState: string; actions: { unban: { state: string; reason?: string } } };
  }>(
    await call('GET', `${memberPath(currentRealm)}?accountId=${fixture.member.id}`),
  );
  expect(afterUnban.selected).toMatchObject({ membership: 'none', banState: 'clear' });
  expect(afterUnban.selected.actions.unban).toMatchObject({ state: 'prohibited', reason: 'not_banned' });
});

test.serial('readers cannot enumerate the management roster and suspension or concealment withholds it', async () => {
  const publicRealm = await realm();
  const denied = await call('GET', memberPath(publicRealm), fixture.outsider);
  expect(denied.status).toBe(403);

  const protectedRealm = await realm('protected');
  const concealed = await call('GET', memberPath(protectedRealm), fixture.outsider);
  const missing = await call('GET', `/v1/realms/${fixture.unknown.realm}/members`, fixture.outsider);
  expect(concealed.status).toBe(404);
  const { request_id: concealedRequest, ...concealedBody } = await concealed.json();
  const { request_id: missingRequest, ...missingBody } = await missing.json();
  expect(concealedRequest).toEqual(expect.any(String));
  expect(missingRequest).toEqual(expect.any(String));
  expect(concealedBody).toEqual(missingBody);

  expect((await driver.suspend(fixture.owner)).status).toBe(200);
  const suspended = await call('GET', memberPath(publicRealm), fixture.owner);
  expect(suspended.status).toBe(401);
});
