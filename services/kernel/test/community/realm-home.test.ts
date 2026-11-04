import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Account, CommunityDriver, Fixture } from '../../../../specs/community-driver.ts';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { REALM_OWNER_ROLE } from '../../src/access/realm-ownership.ts';
import { createRealmHomeBoardObservationReader } from '../../src/content/realm-board-home.ts';
import { createRealmHomePublicationObservationReader } from '../../src/community/realm-home-publications.ts';
import { createRealmHomeReader, type realmHomeResponse } from '../../src/community/realm-home.ts';
import boardWindow from '../../src/content/board-realm-page.sql';
import summaries from '../../src/semantic/summaries-read.sql';
import memberCount from '../../src/community/member-count-read.sql';
import { routeOf } from '../../src/route/route.ts';
import { observeSql } from '../content/support/sql-observer.ts';
import { closeCommunityDrivers, communityFixtureRuntime, createCommunityDriver } from './community-driver.ts';

type Home = ReturnType<typeof realmHomeResponse>;
let driver: CommunityDriver;
let people: Fixture;
let runtime: ReturnType<typeof communityFixtureRuntime>;
const key = () => JSON.stringify(crypto.randomUUID());
const context = () => ({ actor: { kind: 'anonymous' as const }, deadline: Date.now() + 60_000 });
const deps = () => ({
  pool: runtime.system.database.pool,
  access: runtime.system.access,
  routeKey: runtime.system.routeKey,
  tokens: runtime.system.tokenKeys,
});

beforeAll(async () => {
  driver = await createCommunityDriver();
  people = await driver.provision();
  runtime = communityFixtureRuntime();
});
afterAll(closeCommunityDrivers);

async function command<T>(
  path: string,
  body: unknown,
  method: 'POST' | 'PUT' | 'PATCH' = 'POST',
  head?: string,
  actor = people.owner,
) {
  const response = await driver.request({
    actor,
    path,
    method,
    body,
    key: key(),
    ...(head === undefined ? {} : { ifMatch: JSON.stringify(head) }),
  });
  const json = await response.json();
  expect(response.status, JSON.stringify(json)).toBe(method === 'POST' ? 201 : 200);
  return json as T;
}
function leave(actions: Home['actions']) {
  if (!('leave' in actions)) throw new Error('Signed-out Home has no leave advice');
  return actions.leave;
}
async function grantOwner(realmId: string, account: Account, actor: Account, revoke = false) {
  const response = await driver.request({
    actor,
    path: `/v1/roleGrants${revoke ? ':revoke' : ''}`,
    method: 'POST',
    key: key(),
    body: {
      resource: { route: routeOf(realmId)!, id: realmId },
      subject: { kind: 'account', id: account.id },
      role: REALM_OWNER_ROLE,
      valid: '(,)',
    },
  });
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(revoke ? 200 : 201);
}
async function realm(visibility: 'public' | 'protected' = 'public') {
  const { space } = await command<{ space: { spaceId: string } }>('/v1/spaces', { title: 'Home carrier' });
  const { realm } = await command<{ realm: { realmId: string; headRevisionId: string } }>('/v1/realms', {
    spaceId: space.spaceId,
    contextId: people.contextId,
    title: 'Home identity',
    summary: 'Current description',
    visibility,
  });
  return { ...realm, spaceId: space.spaceId };
}
async function read(path: string, actor: Account | null = null) {
  return driver.request({ actor, method: 'GET', path });
}
async function home(id: string, actor: Account | null = null): Promise<Home> {
  const response = await read(`/v1/realms/${id}/home`, actor);
  const json = await response.json();
  expect(response.status, JSON.stringify(json)).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  return json as Home;
}
async function subject(type: string, label: string, statements?: unknown) {
  return (
    await command<{ subject: { id: string } }>(
      '/v1/subjects',
      {
        type,
        labels: { en: label },
        ...(statements ? { statements } : {}),
      },
      'POST',
      undefined,
      people.subjectOwner,
    )
  ).subject.id;
}

test('mounted empty home keeps carrier, identity, optional states, and anonymous sign-in distinct', async () => {
  const target = await realm();
  const initial = await home(target.realmId);
  expect(initial.realm.title).toBe('Home identity');
  expect(initial.realm.summary).toBe('Current description');
  expect(initial.space.spaceId).toBe(target.spaceId);
  expect(initial.space.realmId).toBe(target.realmId);
  expect(initial.space.title).toBe('Home carrier');
  expect(initial.presentation).not.toHaveProperty('join');
  expect(initial.presentation.avatar).toEqual({ state: 'none', value: null });
  expect(initial.presentation.rules).toEqual({ state: 'none', value: null });
  expect(initial.boards).toEqual({ items: [], next: null });
  expect(initial.publications).toEqual({ items: [], next: null });
  expect(initial.viewer).toEqual({ state: 'anonymous' });
  expect(initial.actions).toEqual({ state: 'sign-in' });
  const signedIn = await home(target.realmId, people.owner);
  expect('readability' in signedIn.viewer).toBe(true);
  expect(signedIn.actions.state).toBe('current');
  if (signedIn.actions.state !== 'current') throw new Error('Native action advice is unavailable');
  expect(signedIn.actions.enter).toMatchObject({
    state: 'available',
    method: 'GET',
    path: `/v1/realms/${target.realmId}`,
    expectedStatus: 200,
  });
  const fault = observeSql(runtime.system.database.pool);
  try {
    fault.armFault({
      match: { statement: memberCount.sql },
      boundary: 'before',
      error: new AccessUnavailableError('overloaded'),
    });
    expect((await home(target.realmId)).presentation.members).toEqual({ state: 'unknown', count: null, version: null });
  } finally {
    await fault.close();
  }
  const protectedRealm = await realm('protected');
  expect((await read(`/v1/realms/${protectedRealm.realmId}/home`)).status).toBe(404);
  expect((await home(protectedRealm.realmId, people.owner)).realm.visibility).toBe('protected');
  expect((await read(`/v1/realms/${target.realmId}/home?cursor=foreign`)).status).toBe(400);
  const { space } = await command<{ space: { spaceId: string } }>('/v1/spaces', { title: 'Carrier without Realm' });
  expect((await (await read(`/v1/spaces/${space.spaceId}`)).json()).space.realmId).toBeNull();
});

test('twenty boards and twelve summaries retain independent ordinary sparse continuations', async () => {
  const target = await realm();
  const schemeId = await subject('skos:ConceptScheme', 'Home boards');
  await command(`/v1/realms/${target.realmId}/boardScheme`, { schemeId }, 'PUT', target.headRevisionId);
  for (let index = 0; index < 21; index++) {
    const conceptId = await subject('skos:Concept', `Board ${index}`, {
      'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: schemeId } }],
    });
    await command(`/v1/realms/${target.realmId}/boards`, {
      conceptId,
      title: `Board ${index}`,
      visibility: 'published',
    });
  }
  for (let index = 0; index < 13; index++) {
    const subjectId = await subject('schema:Book', `Home work ${index}`);
    await command(`/v1/realms/${target.realmId}/publications`, { subjectId });
  }
  await driver.settle();
  const initial = await home(target.realmId);
  expect(initial.boards.items).toHaveLength(20);
  expect(initial.publications.items).toHaveLength(12);
  expect(initial.boards.next).toBeString();
  expect(initial.publications.next).toBeString();
  expect(initial.boards.items.every((board) => !('community' in board))).toBe(true);
  expect(initial.publications.items.every((item) => item.summary.id === item.publication.subjectId)).toBe(true);
  const observed = observeSql(runtime.system.database.pool);
  try {
    const response = await read(
      `/v1/realms/${target.realmId}/boardShelf?cursor=${encodeURIComponent(initial.boards.next!)}`,
    );
    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page.items).toHaveLength(1);
    expect(page.next).toBeNull();
    expect(initial.boards.items.map((board) => board.id)).not.toContain(page.items[0].id);
    expect(observed.records.some((entry) => entry.statement === summaries.sql)).toBe(false);
  } finally {
    await observed.close();
  }
  const observedPublications = observeSql(runtime.system.database.pool);
  try {
    const response = await read(
      `/v1/realms/${target.realmId}/publicationShelf?cursor=${encodeURIComponent(initial.publications.next!)}`,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).items).toHaveLength(1);
    expect(observedPublications.records.some((entry) => entry.statement === boardWindow.sql)).toBe(false);
  } finally {
    await observedPublications.close();
  }
  const raw = await (await read(`/v1/realms/${target.realmId}/boards?limit=20`)).json();
  expect(raw.items.map((board: { id: string }) => board.id)).toEqual(initial.boards.items.map((board) => board.id));
  const continuation = await read(`/v1/realms/${target.realmId}/boardShelf?cursor=${encodeURIComponent(raw.next)}`);
  expect((await continuation.json()).items).toHaveLength(1);
  expect(
    (await read(`/v1/realms/${target.realmId}/boardShelf?cursor=${encodeURIComponent(raw.next)}`, people.owner)).status,
  ).toBe(400);
});

test('retained observations reject late publication replacement and required hydration failure retries the same window', async () => {
  const target = await realm();
  const subjectId = await subject('schema:Book', 'No stale home label');
  const { publication } = await command<{ publication: { publicationId: string } }>(
    `/v1/realms/${target.realmId}/publications`,
    { subjectId },
  );
  await driver.settle();
  const selected = await createRealmHomePublicationObservationReader(deps())(target.realmId, context());
  const boards = await createRealmHomeBoardObservationReader(deps())(target.realmId, context());
  expect(await selected!.current()).toBe(true);
  expect(await boards.current()).toBe(true);
  const fault = observeSql(runtime.system.database.pool);
  try {
    fault.armFault({
      match: { statement: summaries.sql },
      boundary: 'before',
      error: new AccessUnavailableError('overloaded'),
    });
    const response = await read(`/v1/realms/${target.realmId}/home`);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('No stale home label');
  } finally {
    await fault.close();
  }
  expect((await home(target.realmId)).publications.items[0]!.summary.label?.value).toBe('No stale home label');
  const withdrawn = await driver.request({
    actor: people.owner,
    method: 'DELETE',
    path: `/v1/realms/${target.realmId}/publications/${subjectId}`,
    key: key(),
    body: {},
    ifMatch: JSON.stringify(publication.publicationId),
  });
  expect(withdrawn.status).toBe(200);
  await command(`/v1/realms/${target.realmId}/publications`, { subjectId });
  expect(await selected!.current()).toBe(false);
  await driver.settle();
  const barrierObserver = observeSql(runtime.system.database.pool);
  const barrier = barrierObserver.hold({ statement: summaries.sql }, 'after');
  const pending = read(`/v1/realms/${target.realmId}/home`);
  try {
    await barrier.entered;
    await command(`/v1/realms/${target.realmId}`, { summary: 'New description' }, 'PATCH', target.headRevisionId);
    barrier.release();
    const stale = await pending;
    expect(stale.status).toBe(503);
    expect(await stale.text()).not.toContain('Current description');
  } finally {
    barrier.release();
    await pending;
    await barrierObserver.close();
  }
  expect((await home(target.realmId)).realm.summary).toBe('New description');
});

test('native home carries membership and current entry, management, and leave advice', async () => {
  const target = await realm();
  const empty = await home(target.realmId, people.outsider);
  expect(empty.boards.items).toEqual([]);
  expect(empty.publications.items).toEqual([]);
  if (!('readability' in empty.viewer) || empty.actions.state !== 'current')
    throw new Error('Public signed-in viewer was not observed');
  expect(empty.viewer.membership).toEqual({
    state: 'none',
    since: null,
    reservationId: null,
    transactionId: null,
  });
  expect(empty.actions.enter).toMatchObject({ state: 'available', method: 'GET' });
  expect(empty.actions.leave).toEqual({ state: 'prohibited', reason: 'not_member' });
  expect(empty.actions.manage).toEqual({ state: 'prohibited', reason: 'not_authorized' });

  const joinKey = key();
  const join = {
    actor: people.member,
    method: 'POST' as const,
    path: `/v1/realms/${target.realmId}/membership`,
    key: joinKey,
  };
  // Discard the first result as an uncertain response. Home observes the committed
  // native membership but does not repair or issue the membership command.
  await driver.request(join);
  await driver.settle();
  const readback = await home(target.realmId, people.member);
  expect(readback.viewer).toMatchObject({ readability: 'allowed', membership: { state: 'member' } });
  expect((await driver.commandEvidence(people.member, joinKey)).receipts).toHaveLength(1);

  // Retry the exact original command and key after readback.
  expect((await driver.request(join)).status).toBe(202);
  const evidence = await driver.commandEvidence(people.member, joinKey);
  expect(evidence.receipts).toHaveLength(1);
  expect(evidence.lastAttempt).toEqual({ authorized: true, receiptRead: true, storedResponseReturned: true });
  await driver.settle();

  const member = await home(target.realmId, people.member);
  if (!('readability' in member.viewer) || member.actions.state !== 'current')
    throw new Error('Member viewer was not observed');
  expect(member.viewer.membership.state).toBe('member');
  expect(member.actions.leave).toMatchObject({
    state: 'available',
    method: 'DELETE',
    path: `/v1/realms/${target.realmId}/membership`,
    expectedStatus: 202,
  });
  expect(member.actions.manage).toEqual({ state: 'prohibited', reason: 'not_authorized' });

  const left = await driver.request({
    actor: people.member,
    method: 'DELETE',
    path: `/v1/realms/${target.realmId}/membership`,
  });
  expect(left.status).toBe(202);
  await driver.settle();
  const returned = await home(target.realmId, people.member);
  if (!('readability' in returned.viewer) || returned.actions.state !== 'current')
    throw new Error('Returned member viewer was not observed');
  expect(returned.viewer.membership.state).toBe('none');
  expect(returned.actions.leave).toEqual({ state: 'prohibited', reason: 'not_member' });

  expect(
    (
      await driver.request({
        actor: people.owner,
        method: 'POST',
        path: `/v1/realms/${target.realmId}/membership`,
        key: key(),
      })
    ).status,
  ).toBe(202);
  await driver.settle();
  const owner = await home(target.realmId, people.owner);
  if (!('readability' in owner.viewer) || owner.actions.state !== 'current')
    throw new Error('Owner viewer was not observed');
  expect(owner.viewer.membership.state).toBe('member');
  expect(owner.actions.leave).toEqual({
    state: 'unavailable',
    reason: 'last_explicit_holder',
  });
  expect(owner.actions.manage).toMatchObject({ state: 'available', method: 'GET' });
  expect(
    (
      await driver.request({
        actor: people.owner,
        method: 'DELETE',
        path: `/v1/realms/${target.realmId}/membership`,
      })
    ).status,
  ).toBe(409);

  const protectedTarget = await realm('protected');
  expect((await driver.grantModerator(protectedTarget.realmId, people.moderator)).status).toBe(201);
  const protectedModerator = await home(protectedTarget.realmId, people.moderator);
  expect(protectedModerator.realm.visibility).toBe('protected');
  if (!('readability' in protectedModerator.viewer) || protectedModerator.actions.state !== 'current')
    throw new Error('Protected moderator viewer was not observed');
  expect(protectedModerator.viewer.membership.state).toBe('none');
  expect(protectedModerator.actions.manage).toMatchObject({ state: 'available', method: 'GET' });
});

test('home retires a replaced explicit owner source even when leave advice stays available', async () => {
  const target = await realm();
  const member = await driver.request({
    actor: people.member,
    method: 'POST',
    path: `/v1/realms/${target.realmId}/membership`,
    key: key(),
  });
  expect(member.status).toBe(202);
  await driver.settle();
  await grantOwner(target.realmId, people.member, people.owner);
  const before = await home(target.realmId, people.owner);
  expect(leave(before.actions)).toMatchObject({ state: 'available', method: 'DELETE' });

  const observer = observeSql(runtime.system.database.pool);
  const barrier = observer.hold({ statement: summaries.sql }, 'after');
  const pending = read(`/v1/realms/${target.realmId}/home`, people.owner);
  try {
    await barrier.entered;
    await grantOwner(target.realmId, people.owner, people.member, true);
    await grantOwner(target.realmId, people.owner, people.member);
    barrier.release();
    const stale = await pending;
    expect(stale.status).toBe(503);
    expect((await stale.json()).code).toBe('transaction_retry_exhausted');
  } finally {
    barrier.release();
    await pending;
    await observer.close();
  }
  expect(leave((await home(target.realmId, people.owner)).actions)).toMatchObject({
    state: 'available',
    method: 'DELETE',
  });
});

test('home retries on leave/rejoin, containing-Space change, and role revocation during hydration', async () => {
  const target = await realm();
  const subjectId = await subject('schema:Book', 'Home race label');
  await command(`/v1/realms/${target.realmId}/publications`, { subjectId });
  await driver.settle();

  const joinMember = async () => {
    const response = await driver.request({
      actor: people.member,
      method: 'POST',
      path: `/v1/realms/${target.realmId}/membership`,
      key: key(),
    });
    expect(response.status).toBe(202);
    await driver.settle();
  };
  const leaveMember = async () => {
    const response = await driver.request({
      actor: people.member,
      method: 'DELETE',
      path: `/v1/realms/${target.realmId}/membership`,
    });
    expect(response.status).toBe(202);
    await driver.settle();
  };
  await joinMember();

  const membershipObserver = observeSql(runtime.system.database.pool);
  const membershipBarrier = membershipObserver.hold({ statement: summaries.sql }, 'after');
  const memberPage = read(`/v1/realms/${target.realmId}/home`, people.member);
  try {
    await membershipBarrier.entered;
    await leaveMember();
    await joinMember();
    membershipBarrier.release();
    const stale = await memberPage;
    expect(stale.status).toBe(503);
    expect((await stale.json()).code).toBe('transaction_retry_exhausted');
  } finally {
    membershipBarrier.release();
    await memberPage;
    await membershipObserver.close();
  }
  expect((await home(target.realmId, people.member)).viewer).toMatchObject({
    readability: 'allowed',
    membership: { state: 'member' },
  });

  const spaceObserver = observeSql(runtime.system.database.pool);
  const spaceBarrier = spaceObserver.hold({ statement: summaries.sql }, 'after');
  const pendingSpace = read(`/v1/realms/${target.realmId}/home`, people.member);
  try {
    await spaceBarrier.entered;
    const response = await read(`/v1/spaces/${target.spaceId}`, people.owner);
    const { space } = (await response.json()) as { space: { headRevisionId: string } };
    await command(`/v1/spaces/${target.spaceId}`, { summary: 'Changed carrier' }, 'PATCH', space.headRevisionId);
    spaceBarrier.release();
    const stale = await pendingSpace;
    expect(stale.status).toBe(503);
    expect((await stale.json()).code).toBe('transaction_retry_exhausted');
  } finally {
    spaceBarrier.release();
    await pendingSpace;
    await spaceObserver.close();
  }
  expect((await home(target.realmId, people.member)).space.summary).toBe('Changed carrier');

  expect((await driver.grantModerator(target.realmId, people.moderator)).status).toBe(201);
  const beforeRole = await home(target.realmId, people.moderator);
  if (beforeRole.actions.state !== 'current' || beforeRole.actions.manage.state !== 'available')
    throw new Error('Moderation advice was not current before revocation');
  const managePath = beforeRole.actions.manage.path;
  const roleObserver = observeSql(runtime.system.database.pool);
  const roleBarrier = roleObserver.hold({ statement: summaries.sql }, 'after');
  const pendingRole = read(`/v1/realms/${target.realmId}/home`, people.moderator);
  try {
    await roleBarrier.entered;
    const revoked = await driver.request({
      actor: people.owner,
      method: 'POST',
      path: '/v1/roleGrants:revoke',
      body: {
        resource: { route: routeOf(target.realmId)!, id: target.realmId },
        subject: { kind: 'account', id: people.moderator.id },
        role: 'community.realm.moderator',
        valid: '(,)',
      },
      key: key(),
    });
    expect(revoked.status).toBe(200);
    roleBarrier.release();
    const stale = await pendingRole;
    expect(stale.status).toBe(503);
    expect((await stale.json()).code).toBe('transaction_retry_exhausted');
  } finally {
    roleBarrier.release();
    await pendingRole;
    await roleObserver.close();
  }
  const currentRole = await home(target.realmId, people.moderator);
  if (currentRole.actions.state !== 'current') throw new Error('Native action advice is unavailable');
  expect(currentRole.actions.manage).toEqual({ state: 'prohibited', reason: 'not_authorized' });
  expect((await driver.request({ actor: people.moderator, method: 'GET', path: managePath })).status).toBe(403);

  const actorObserver = observeSql(runtime.system.database.pool);
  const actorBarrier = actorObserver.hold({ statement: summaries.sql }, 'after');
  const mutableContext = context();
  const pendingActor = createRealmHomeReader(deps())(target.realmId, mutableContext);
  try {
    await actorBarrier.entered;
    mutableContext.actor = { kind: 'anonymous' };
    actorBarrier.release();
    await expect(pendingActor).rejects.toThrow();
  } finally {
    actorBarrier.release();
    await pendingActor.catch(() => undefined);
    await actorObserver.close();
  }
});

test('home keeps banned concealment and suspended-account authentication failures', async () => {
  const target = await realm();
  const banned = await driver.request({
    actor: people.owner,
    method: 'PUT',
    path: `/v1/realms/${target.realmId}/bans/${people.outsider.id}`,
    key: key(),
    body: { reason: 'Home reader ban' },
  });
  expect(banned.status).toBe(200);
  await driver.settle();
  expect((await read(`/v1/realms/${target.realmId}/home`, people.outsider)).status).toBe(404);

  expect((await driver.suspend(people.member)).status).toBe(200);
  expect((await read(`/v1/realms/${target.realmId}/home`, people.member)).status).toBe(401);
});
