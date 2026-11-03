import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Account, CommunityDriver, Fixture, Publication } from '../../../../specs/community-driver.ts';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import readSlot from '../../src/community/publication-preparation-read.sql';
import { readPublicationPreparation } from '../../src/community/publication-preparation.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import reference from '../../src/semantic/read-subject-reference.sql';
import { observeSql } from '../content/support/sql-observer.ts';
import { closeCommunityDrivers, communityFixtureRuntime, createCommunityDriver } from './community-driver.ts';

type Preparation = NonNullable<Awaited<ReturnType<typeof readPublicationPreparation>>>['preparation'];
let driver: CommunityDriver;
let people: Fixture;
let runtime: ReturnType<typeof communityFixtureRuntime>;
const key = () => JSON.stringify(crypto.randomUUID());
beforeAll(async () => {
  driver = await createCommunityDriver();
  people = await driver.provision();
  runtime = communityFixtureRuntime();
});
afterAll(closeCommunityDrivers);

async function post<T>(actor: Account, path: string, body: unknown, status = 201) {
  const response = await driver.request({
    actor,
    method: 'POST',
    path,
    body,
    key: key(),
  });
  const value = await response.json();
  expect(response.status, JSON.stringify(value)).toBe(status);
  return value as T;
}
async function realm(visibility: 'public' | 'protected' = 'public') {
  const { space } = await post<{ space: { spaceId: string } }>(people.owner, '/v1/spaces', {
    title: 'Inspection host',
  });
  const { realm } = await post<{ realm: { realmId: string } }>(people.owner, '/v1/realms', {
    spaceId: space.spaceId,
    contextId: people.contextId,
    title: 'Inspection Realm',
    visibility,
  });
  return realm.realmId;
}
function inspect(realmId: string, actor: Account | null = people.owner, subjectId = people.subject.id) {
  return driver.request({
    actor,
    method: 'GET',
    path: `/v1/realms/${realmId}/publications/${subjectId}/preparation`,
  });
}
async function prepared(realmId: string, actor = people.owner) {
  const response = await inspect(realmId, actor);
  const value = await response.json();
  expect(response.status, JSON.stringify(value)).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('rezics-session-token')).toEqual(expect.any(String));
  expect(response.headers.get('etag')).toBeNull();
  return (value as { preparation: Preparation }).preparation;
}
async function decide(realmId: string, verdict: 'withdraw' | 'reject', head: string) {
  const response = await driver.request({
    actor: people.owner,
    method: 'POST',
    path: `/v1/realms/${realmId}/publications/${people.subject.id}:${verdict}`,
    key: key(),
    ifMatch: JSON.stringify(head),
    body: {},
  });
  const value = await response.json();
  expect(response.status, JSON.stringify(value)).toBe(200);
  return (value as { publication: Publication }).publication;
}

test('one selected native slot exposes absent, adopted and terminal heads without changing public GET', async () => {
  const realmId = await realm();
  const base = `/v1/realms/${realmId}/publications`;
  const empty = await prepared(realmId);
  expect(empty.current).toBeNull();
  expect(empty.subject).toEqual({
    originalId: people.subject.id,
    currentId: people.subject.id,
    presentation: { state: 'unavailable' },
  });
  expect(empty.realm).toMatchObject({
    realmId,
    title: 'Inspection Realm',
    hostTitle: 'Inspection host',
  });
  expect(empty.commands.publish).toEqual({
    method: 'POST',
    href: base,
    subjectId: people.subject.id,
    expectedHead: null,
    ifMatch: null,
  });
  expect(empty.commands.withdraw).toBeNull();
  expect(empty.commands.reject).toBeNull();
  const { publication: adopted } = await post<{ publication: Publication }>(people.owner, base, {
    subjectId: people.subject.id,
  });
  const publicRead = await driver.request({
    actor: null,
    method: 'GET',
    path: `${base}/${people.subject.id}`,
  });
  expect(publicRead.status).toBe(200);
  expect(publicRead.headers.get('etag')).toBe(JSON.stringify(adopted.publicationId));
  expect((await publicRead.json()).publication).toEqual({
    realmId,
    subjectId: people.subject.id,
    publicationId: adopted.publicationId,
    verdict: 'adopt',
    subjectRevisionId: null,
    publishedAt: expect.any(String),
  });
  expect((await prepared(realmId)).current).toMatchObject({
    publicationId: adopted.publicationId,
    verdict: 'adopt',
  });
  const withdrawn = await decide(realmId, 'withdraw', adopted.publicationId);
  const terminal = await prepared(realmId);
  expect(terminal.current).toMatchObject({
    publicationId: withdrawn.publicationId,
    verdict: 'withdraw',
  });
  expect(terminal.commands.publish.ifMatch).toBe(JSON.stringify(withdrawn.publicationId));
  expect(terminal.commands.reject?.expectedHead).toBe(withdrawn.publicationId);
  expect(
    (
      await driver.request({
        actor: null,
        method: 'GET',
        path: `${base}/${people.subject.id}`,
      })
    ).status,
  ).toBe(404);
  const rejected = await decide(realmId, 'reject', withdrawn.publicationId);
  expect((await prepared(realmId)).current).toMatchObject({
    publicationId: rejected.publicationId,
    verdict: 'reject',
  });
  const republished = await driver.request({
    actor: people.owner,
    method: 'POST',
    path: base,
    key: key(),
    ifMatch: JSON.stringify(rejected.publicationId),
    body: { subjectId: people.subject.id },
  });
  expect(republished.status).toBe(201);
  expect((await prepared(realmId)).current?.verdict).toBe('adopt');
});

test('lost response, competing publisher and stale head retain explicit request uncertainty and exact replay', async () => {
  const realmId = await realm();
  const base = `/v1/realms/${realmId}/publications`;
  expect((await driver.grantModerator(realmId, people.moderator)).status).toBe(201);
  const request = {
    actor: people.owner,
    method: 'POST' as const,
    path: base,
    key: key(),
    body: { subjectId: people.subject.id },
  };
  // Drop the first successful transport response without reading its receipt.
  await driver.request(request);
  const current = await prepared(realmId);
  expect(current.current?.verdict).toBe('adopt');
  expect(current.recovery).toEqual({
    requestIdentity: 'unknown',
    replay: 'original-command',
  });
  const replay = await driver.request(request);
  expect(replay.status).toBe(201);
  expect((await replay.json()).publication.publicationId).toBe(current.current!.publicationId);
  const competing = await driver.request({
    actor: people.moderator,
    method: 'POST',
    path: base,
    key: key(),
    ifMatch: current.commands.publish.ifMatch!,
    body: { subjectId: people.subject.id },
  });
  expect(competing.status).toBe(201);
  const latest = (await competing.json()).publication.publicationId as string;
  const stale = await driver.request({
    actor: people.owner,
    method: 'POST',
    path: current.commands.withdraw!.href,
    key: key(),
    ifMatch: current.commands.withdraw!.ifMatch!,
    body: {},
  });
  expect(stale.status).toBe(412);
  expect((await prepared(realmId)).current?.publicationId).toBe(latest);
  const observer = observeSql(runtime.system.database.pool);
  try {
    await prepared(realmId);
    const slots = observer.records.filter((entry) => entry.statement === readSlot.sql);
    expect(slots).toHaveLength(2);
    for (const entry of slots) {
      expect(entry.parameters[readSlot.params.indexOf('subject')]).toBe(people.subject.id);
      expect(entry.parameters[readSlot.params.indexOf('realm')]).toBe(realmId);
    }
    expect(
      observer.records.some((entry) => /core\.receipt|INSERT INTO|UPDATE |DELETE FROM/.test(entry.statement)),
    ).toBe(false);
  } finally {
    await observer.close();
  }
});

test('readability, management and membership never confer publication authority; source failures remain failures', async () => {
  const realmId = await realm('protected');
  await post(people.owner, `/v1/realms/${realmId}/members`, { accountId: people.member.id }, 202);
  await post(people.owner, '/v1/grants', {
    resource: { route: routeOf(realmId)!, id: realmId },
    subject: { kind: 'account', id: people.member.id },
    actions: ['realm:manage'],
    valid: '(,)',
  });
  for (const actor of [null, people.member, people.outsider]) expect((await inspect(realmId, actor)).status).toBe(404);
  expect((await inspect(people.unknown.realm)).status).toBe(404);
  expect((await inspect(realmId, people.owner, newId(0x4100))).status).toBe(404);
  const observer = observeSql(runtime.system.database.pool);
  try {
    observer.armFault({
      match: { statement: reference.sql },
      boundary: 'before',
      error: new AccessUnavailableError('overloaded'),
    });
    const unavailable = await inspect(realmId);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain(people.subject.id);
  } finally {
    await observer.close();
  }
  expect((await prepared(realmId)).current).toBeNull();
  expect((await driver.suspend(people.outsider)).status).toBe(200);
  expect([401, 404]).toContain((await inspect(realmId, people.outsider)).status);
});

test('a selected Subject edit or competing decision during preparation withholds stale state', async () => {
  const realmId = await realm();
  const { publication } = await post<{ publication: Publication }>(people.owner, `/v1/realms/${realmId}/publications`, {
    subjectId: people.subject.id,
  });
  for (const change of ['subject', 'publication'] as const) {
    const observer = observeSql(runtime.system.database.pool);
    const barrier = observer.hold({ statement: change === 'subject' ? reference.sql : readSlot.sql }, 'after');
    const pending = inspect(realmId);
    try {
      await barrier.entered;
      if (change === 'subject') {
        expect((await driver.subjectCommand('edit', people.subjectOwner, people.subject.id, key())).status).toBe(201);
      } else await decide(realmId, 'withdraw', publication.publicationId);
    } finally {
      barrier.release();
    }
    try {
      const result = await pending;
      expect(result.status).toBe(503);
    } finally {
      await observer.close();
    }
  }
  expect((await driver.subjectCommand('takeDown', people.subjectOwner, people.subject.id, key())).status).toBe(201);
  expect((await inspect(realmId)).status).toBe(404);
});
