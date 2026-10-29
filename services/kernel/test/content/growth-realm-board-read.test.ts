import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { CommunityDriver, CommunityGrowth, Fixture } from '../../../../specs/community-driver.ts';
import { createCommunityDriver } from '../community/community-driver.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { checkGrowth, seed, type GrowthDatabase, type Population } from '../support/growth.ts';

const growingRelations = [
  'access.account',
  'access.membership_inverse',
  'access.resource_grant',
  'access.resource_role_grant',
  'community.realm',
  'community.realm_member',
  'content.board',
  'content.thread',
] as const;

let driver: CommunityDriver;
let fixture: Fixture;
let growth: CommunityGrowth;
let database: GrowthDatabase;
let schemeId: string;
let spaceId: string;
let conceptId: string;

type Realm = { realmId: string; headRevisionId: string };
beforeAll(async () => {
  driver = await createCommunityDriver();
  fixture = await driver.provision();
  growth = await driver.growthFixture();
  database = growth.database;

  const existing = await driver.request({ actor: fixture.owner, method: 'GET', path: `/v1/realms/${growth.realmId}` });
  expect(existing.status).toBe(200);
  const boardSchemeId = ((await existing.json()) as { realm: { boardSchemeId: string | null } }).realm.boardSchemeId;
  expect(boardSchemeId).not.toBeNull();
  schemeId = boardSchemeId!;
  const concept = await driver.request({
    actor: fixture.owner,
    method: 'POST',
    path: '/v1/subjects',
    key: JSON.stringify('realm-board-read-growth-concept'),
    body: {
      type: 'skos:Concept',
      labels: { en: 'Realm board read growth concept' },
      statements: {
        'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: schemeId } }],
      },
    },
  });
  expect(concept.status).toBe(201);
  conceptId = ((await concept.json()) as { subject: { id: string } }).subject.id;

  const space = await driver.request({
    actor: fixture.owner,
    method: 'POST',
    path: '/v1/spaces',
    key: JSON.stringify('protected-growth-space'),
    body: { title: 'Protected board read growth host' },
  });
  expect(space.status).toBe(201);
  spaceId = ((await space.json()) as { space: { spaceId: string } }).space.spaceId;
}, 90_000);

afterAll(async () => {
  await growth?.close();
  await driver?.close();
});

async function createProtectedBoard(): Promise<{ realm: Realm; boardId: string }> {
  const created = await driver.request({
    actor: fixture.owner,
    method: 'POST',
    path: '/v1/realms',
    key: JSON.stringify('protected-growth-realm'),
    body: {
      spaceId,
      title: 'Protected board read growth Realm',
      summary: 'Protected point-read probe',
      visibility: 'protected',
      contextId: fixture.contextId,
    },
  });
  expect(created.status).toBe(201);
  const realm = (await created.json() as { realm: Realm }).realm;
  const configured = await driver.request({
    actor: fixture.owner,
    method: 'PUT',
    path: `/v1/realms/${realm.realmId}/boardScheme`,
    key: JSON.stringify('protected-growth-board-scheme'),
    ifMatch: JSON.stringify(realm.headRevisionId),
    body: { schemeId },
  });
  expect(configured.status).toBe(200);
  const configuredRealm = (await configured.json() as { realm: Realm }).realm;
  const board = await driver.request({
    actor: fixture.owner,
    method: 'POST',
    path: `/v1/realms/${realm.realmId}/boards`,
    key: JSON.stringify('protected-growth-board'),
    body: {
      conceptId,
      title: 'Protected point-read board',
      visibility: 'published',
    },
  });
  expect(board.status).toBe(201);
  const boardId = ((await board.json()) as { board: { id: string } }).board.id;
  const joined = await driver.request({
    actor: fixture.member,
    method: 'POST',
    path: `/v1/realms/${realm.realmId}/membership`,
    key: JSON.stringify('protected-growth-member-join'),
  });
  expect(joined.status).toBe(202);
  await driver.settle();
  return { realm: configuredRealm, boardId };
}

function population(realmId: string, boardId: string, name: string): Population {
  const route = routeOf(boardId);
  if (route === null || routeOf(realmId) !== route) throw new Error('Growth board and Realm must share a route');
  return {
    name,
    hotPartition: route >>> 4,
    hotShare: 1,
    rows({ ordinal }) {
      const otherRealmId = newId(route);
      const otherRealmRevisionId = newId(route);
      const otherSpaceId = newId(route);
      const otherBoardId = newId(route);
      const sameRealmBoardId = newId(route);
      const memberId = newId(route);
      const reservationId = newId(route);
      const transactionId = crypto.randomUUID();
      const threadId = newId(route);
      return {
        'access.account': [
          {
            route,
            account_id: memberId,
            kind: 'actor',
            state: 'active',
            transaction_id: transactionId,
            membership_inverse_complete: true,
          },
        ],
        'community.realm': [
          {
            route,
            realm_id: otherRealmId,
            space_id: otherSpaceId,
            state: 'active',
            visibility: 'public',
            context_id: fixture.contextId,
            head_revision_id: otherRealmRevisionId,
            created_at: '2020-01-01T00:00:00.000Z',
            creator: fixture.owner.id,
          },
        ],
        'community.realm_member': [
          {
            route,
            realm_id: realmId,
            account_id: memberId,
            role: 'member',
            valid: '[2020-01-01 00:00:00+00,)',
            reservation_id: reservationId,
            transaction_id: transactionId,
          },
        ],
        'access.membership_inverse': [
          {
            route,
            account_id: memberId,
            kind: 'realm',
            group_id: realmId,
            reservation_id: reservationId,
            transaction_id: transactionId,
            source_transaction_id: transactionId,
          },
        ],
        'access.resource_role_grant': [
          {
            route,
            resource_id: realmId,
            subject_kind: 'identity',
            subject_id: memberId,
            subject_role: '',
            grant_role: 'community.realm.member',
            valid: '[2020-01-01 00:00:00+00,)',
            transaction_id: transactionId,
          },
        ],
        'access.resource_grant': [
          {
            route,
            resource_id: realmId,
            subject_id: memberId,
            subject_role: '',
            action: 'realm:read',
            valid: '[2020-01-01 00:00:00+00,)',
            transaction_id: transactionId,
            subject_kind: 'identity',
          },
        ],
        'content.board': [
          {
            route,
            board_id: otherBoardId,
            subject_id: conceptId,
            title: `Other Realm board ${ordinal}`,
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: transactionId,
            created_at: '2020-01-01T00:00:00.000Z',
            realm_id: otherRealmId,
          },
          {
            route,
            board_id: sameRealmBoardId,
            subject_id: conceptId,
            title: `Same Realm board ${ordinal}`,
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: transactionId,
            created_at: '2020-01-01T00:00:00.000Z',
            realm_id: realmId,
          },
        ],
        'content.thread': [
          {
            route,
            thread_id: threadId,
            author_account_id: memberId,
            board_id: boardId,
            title: `Thread ${ordinal}`,
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: transactionId,
            created_at: '2020-01-01T00:00:00.000Z',
            first_post_id: null,
            availability: 'available',
          },
        ],
      };
    },
  };
}

async function grow(checkPopulation: Population, scale: number, previous: number): Promise<void> {
  await seed(database, checkPopulation, { from: previous, to: scale });
}

async function assertNoSequentialScans(report: Awaited<ReturnType<typeof checkGrowth>>): Promise<void> {
  for (const sample of report.samples) {
    for (const relation of growingRelations)
      expect(sample.cost.relations?.[relation]?.sequentialScans ?? 0, `${relation} at scale ${sample.scale}`).toBe(0);
  }
}

test('Public Realm board point read stays within its bound as boards, members and grants grow', async () => {
  const boardId = growth.boardId;
  const realmId = growth.realmId;
  const checkPopulation = population(realmId, boardId, 'public-realm-board-point-read');
  const expected = await driver.request({ actor: null, method: 'GET', path: `/v1/boards/${boardId}` });
  expect(expected.status).toBe(200);
  const expectedBody = await expected.json();
  const report = await checkGrowth(database, {
    name: 'Public Realm board point read stays within its bound as boards, members and grants grow',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: (_db, scale, previous) => grow(checkPopulation, scale, previous),
    operation: async () => {
      const response = await driver.request({ actor: null, method: 'GET', path: `/v1/boards/${boardId}` });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expectedBody);
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  await assertNoSequentialScans(report);
});

test('Protected Realm board point read by a member stays within its bound as boards, members and grants grow', async () => {
  const { realm, boardId } = await createProtectedBoard();
  const checkPopulation = population(realm.realmId, boardId, 'protected-realm-board-point-read');
  const expected = await driver.request({ actor: fixture.member, method: 'GET', path: `/v1/boards/${boardId}` });
  expect(expected.status).toBe(200);
  const expectedBody = await expected.json();
  const report = await checkGrowth(database, {
    name: 'Protected Realm board point read by a member stays within its bound as boards, members and grants grow',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: (_db, scale, previous) => grow(checkPopulation, scale, previous),
    warmup: async () => {
      const hidden = await driver.request({ actor: fixture.outsider, method: 'GET', path: `/v1/boards/${boardId}` });
      expect(hidden.status).toBe(404);
      const hiddenBody = await hidden.json();
      const unknown = await driver.request({
        actor: fixture.outsider,
        method: 'GET',
        path: `/v1/boards/${fixture.unknown.board}`,
      });
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toEqual(hiddenBody);
    },
    operation: async () => {
      const response = await driver.request({ actor: fixture.member, method: 'GET', path: `/v1/boards/${boardId}` });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expectedBody);
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  await assertNoSequentialScans(report);
});
