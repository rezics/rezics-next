import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Account, CommunityDriver, Fixture } from '../../../../specs/community-driver.ts';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { createRealmHomeBoardObservationReader } from '../../src/content/realm-board-home.ts';
import { createRealmHomePublicationObservationReader } from '../../src/community/realm-home-publications.ts';
import type { realmHomeResponse } from '../../src/community/realm-home.ts';
import boardWindow from '../../src/content/board-realm-page.sql';
import summaries from '../../src/semantic/summaries-read.sql';
import memberCount from '../../src/community/member-count-read.sql';
import { observeSql } from '../content/support/sql-observer.ts';
import { closeCommunityDrivers, communityFixtureRuntime, createCommunityDriver } from './community-driver.ts';

type Home = ReturnType<typeof realmHomeResponse>;
let driver: CommunityDriver;
let people: Fixture;
let runtime: ReturnType<typeof communityFixtureRuntime>;
const key = () => JSON.stringify(crypto.randomUUID());
const context = () => ({ actor: { kind: 'anonymous' as const }, deadline: Date.now() + 60_000 });
const deps = () => ({ pool: runtime.system.database.pool, access: runtime.system.access,
  routeKey: runtime.system.routeKey, tokens: runtime.system.tokenKeys });

beforeAll(async () => {
  driver = await createCommunityDriver();
  people = await driver.provision();
  runtime = communityFixtureRuntime();
});
afterAll(closeCommunityDrivers);

async function command<T>(path: string, body: unknown, method = 'POST', head?: string) {
  const response = await driver.request({ actor: people.owner, path, method, body, key: key(),
    ...(head === undefined ? {} : { ifMatch: JSON.stringify(head) }) });
  const json = await response.json();
  expect(response.status, JSON.stringify(json)).toBe(method === 'POST' ? 201 : 200);
  return json as T;
}
async function realm(visibility: 'public' | 'protected' = 'public') {
  const { space } = await command<{ space: { spaceId: string } }>('/v1/spaces', { title: 'Home carrier' });
  const { realm } = await command<{ realm: { realmId: string; headRevisionId: string } }>('/v1/realms', {
    spaceId: space.spaceId, contextId: people.contextId, title: 'Home identity', summary: 'Current description', visibility,
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
  return (await command<{ subject: { id: string } }>('/v1/subjects', {
    type, labels: { en: label }, ...(statements ? { statements } : {}),
  })).subject.id;
}

test('mounted empty home keeps carrier, identity, optional states and unavailable viewer decisions distinct', async () => {
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
  expect(Object.values(initial.actions)).toEqual(Array(5).fill('sign-in'));
  const signedIn = await home(target.realmId, people.owner);
  expect(signedIn.viewer).toEqual({ state: 'unavailable' });
  expect(Object.values(signedIn.actions)).toEqual(Array(5).fill('unavailable'));
  const fault = observeSql(runtime.system.database.pool);
  try {
    fault.armFault({ match: { statement: memberCount.sql }, boundary: 'before',
      error: new AccessUnavailableError('overloaded') });
    expect((await home(target.realmId)).presentation.members).toEqual({ state: 'unknown', count: null, version: null });
  } finally { await fault.close(); }
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
    await command(`/v1/realms/${target.realmId}/boards`, { conceptId, title: `Board ${index}`, visibility: 'published' });
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
    const response = await read(`/v1/realms/${target.realmId}/boardShelf?cursor=${encodeURIComponent(initial.boards.next!)}`);
    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page.items).toHaveLength(1);
    expect(page.next).toBeNull();
    expect(initial.boards.items.map((board) => board.id)).not.toContain(page.items[0].id);
    expect(observed.records.some((entry) => entry.statement === summaries.sql)).toBe(false);
  } finally { await observed.close(); }
  const observedPublications = observeSql(runtime.system.database.pool);
  try {
    const response = await read(`/v1/realms/${target.realmId}/publicationShelf?cursor=${encodeURIComponent(initial.publications.next!)}`);
    expect(response.status).toBe(200);
    expect((await response.json()).items).toHaveLength(1);
    expect(observedPublications.records.some((entry) => entry.statement === boardWindow.sql)).toBe(false);
  } finally { await observedPublications.close(); }
  const raw = await (await read(`/v1/realms/${target.realmId}/boards?limit=20`)).json();
  expect(raw.items.map((board: { id: string }) => board.id)).toEqual(initial.boards.items.map((board) => board.id));
  const continuation = await read(`/v1/realms/${target.realmId}/boardShelf?cursor=${encodeURIComponent(raw.next)}`);
  expect((await continuation.json()).items).toHaveLength(1);
  expect((await read(`/v1/realms/${target.realmId}/boardShelf?cursor=${encodeURIComponent(raw.next)}`, people.owner)).status).toBe(400);
});

test('retained observations reject late publication replacement and required hydration failure retries the same window', async () => {
  const target = await realm();
  const subjectId = await subject('schema:Book', 'No stale home label');
  const { publication } = await command<{ publication: { publicationId: string } }>(
    `/v1/realms/${target.realmId}/publications`, { subjectId },
  );
  await driver.settle();
  const selected = await createRealmHomePublicationObservationReader(deps())(target.realmId, context());
  const boards = await createRealmHomeBoardObservationReader(deps())(target.realmId, context());
  expect(await selected!.current()).toBe(true);
  expect(await boards.current()).toBe(true);
  const fault = observeSql(runtime.system.database.pool);
  try {
    fault.armFault({ match: { statement: summaries.sql }, boundary: 'before', error: new AccessUnavailableError('overloaded') });
    const response = await read(`/v1/realms/${target.realmId}/home`);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('No stale home label');
  } finally { await fault.close(); }
  expect((await home(target.realmId)).publications.items[0]!.summary.label?.value).toBe('No stale home label');
  const withdrawn = await driver.request({ actor: people.owner, method: 'DELETE',
    path: `/v1/realms/${target.realmId}/publications/${subjectId}`, key: key(), body: {},
    ifMatch: JSON.stringify(publication.publicationId) });
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
  } finally { barrier.release(); await pending; await barrierObserver.close(); }
  expect((await home(target.realmId)).realm.summary).toBe('New description');
});
