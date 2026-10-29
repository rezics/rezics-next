import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { fromPlainText, serializeDocument } from '@rezics/document';
import type { Account, CommunityDriver, CommunityGrowth, Fixture, Realm } from '../../../../specs/community-driver.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { checkGrowth, seed, type Population } from '../support/growth.ts';
import { createCommunityDriver, restartWorker, worker } from '../community/community-driver.ts';

const scales = [256, 1024, 4096] as const;
const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;
const growingRelations = [
  'access.account',
  'access.membership_inverse',
  'access.resource_grant',
  'access.resource_denial',
  'access.resource_role_grant',
  'community.realm_member',
  'community.realm_member_terminal',
  'community.space',
  'community.space_revision',
  'community.realm',
  'community.realm_revision',
  'community.realm_ban',
  'content.board',
  'content.board_thread',
  'content.thread',
  'content.post',
  'content.revision',
  'content.reaction_total',
] as const;
const threadBody = Buffer.from(serializeDocument(fromPlainText('A fixed point-read growth thread.')));
const threadDigest = createHash('sha256').update(threadBody).digest();
const createdAt = '2020-01-01T00:00:00.000Z';

let driver: CommunityDriver;
let fixture: Fixture;
let growth: CommunityGrowth | undefined;

beforeAll(async () => {
  driver = await createCommunityDriver();
  fixture = await driver.provision();
}, 120_000);

afterAll(async () => {
  await growth?.close();
  await driver?.close();
});

async function command<T>(
  actor: Account | null,
  method: 'POST' | 'PUT',
  path: string,
  body?: unknown,
  ifMatch?: string,
) {
  const response = await driver.request({
    actor,
    method,
    path,
    key: JSON.stringify(randomUUID()),
    ...(ifMatch === undefined ? {} : { ifMatch }),
    ...(body === undefined ? {} : { body }),
  });
  const text = await response.clone().text();
  expect(response.status, `${method} ${path}: ${text}`).toBe(method === 'POST' ? 201 : 200);
  return (await response.json()) as T;
}

async function makeProtectedRealm(): Promise<{ realm: Realm; boardId: string }> {
  const spaceValue = await command<{ space: { spaceId: string } }>(fixture.owner, 'POST', '/v1/spaces', {
    title: 'Protected point-read host',
  });
  const realmValue = await command<{ realm: Realm }>(fixture.owner, 'POST', '/v1/realms', {
    spaceId: spaceValue.space.spaceId,
    title: 'Protected point-read Realm',
    summary: 'Growth test Realm',
    visibility: 'protected',
    contextId: fixture.contextId,
  });
  const schemeValue = await command<{ subject: { id: string } }>(fixture.owner, 'POST', '/v1/subjects', {
    type: 'skos:ConceptScheme',
    labels: { en: 'Protected point-read scheme' },
  });
  const assigned = await command<{ realm: Realm }>(
    fixture.owner,
    'PUT',
    `/v1/realms/${realmValue.realm.realmId}/boardScheme`,
    {
      schemeId: schemeValue.subject.id,
    },
    JSON.stringify(realmValue.realm.headRevisionId),
  );
  const concept = await command<{ subject: { id: string } }>(fixture.owner, 'POST', '/v1/subjects', {
    type: 'skos:Concept',
    labels: { en: 'Protected point-read concept' },
    statements: {
      'skos:inScheme': [
        { property: { id: 'skos:inScheme' }, value: { type: 'value', content: schemeValue.subject.id } },
      ],
    },
  });
  const board = await command<{ board: { id: string } }>(
    fixture.owner,
    'POST',
    `/v1/realms/${assigned.realm.realmId}/boards`,
    {
      conceptId: concept.subject.id,
      title: 'Protected point-read board',
      visibility: 'published',
    },
  );

  await worker.stop();
  try {
    const join = await driver.request({
      actor: fixture.member,
      method: 'POST',
      path: `/v1/realms/${assigned.realm.realmId}/membership`,
      key: JSON.stringify(randomUUID()),
    });
    expect(join.status).toBe(202);
  } finally {
    await restartWorker();
  }
  await driver.settle();
  return { realm: assigned.realm, boardId: board.board.id };
}

function pointReadPopulation(realmId: string, boardId: string): Population {
  const realmRoute = routeOf(realmId);
  const boardRoute = routeOf(boardId);
  if (realmRoute === null || boardRoute !== realmRoute) throw new Error('Measured Realm and board are not colocated');
  return {
    name: `realm-board-point-read-${randomUUID()}`,
    hotPartition: partitionOf(boardRoute),
    hotShare: 1,
    rows({ route, ordinal }) {
      const transactionId = randomUUID();
      const accountId = newId(route);
      const reservationId = newId(realmRoute);
      const board = newId(realmRoute);
      const thread = newId(realmRoute);
      const post = newId(realmRoute);
      const revision = newId(realmRoute);
      const membership = {
        route: realmRoute,
        realm_id: realmId,
        account_id: accountId,
        role: 'member',
        valid: '[2020-01-01 00:00:00+00,)',
        reservation_id: reservationId,
        transaction_id: transactionId,
      };
      return {
        'access.account': [
          { route, account_id: accountId, kind: 'actor', state: 'active', transaction_id: transactionId },
        ],
        'community.realm_member': [membership],
        'access.membership_inverse': [
          {
            route,
            account_id: accountId,
            kind: 'realm',
            group_id: realmId,
            reservation_id: reservationId,
            transaction_id: transactionId,
            source_transaction_id: transactionId,
          },
        ],
        'access.resource_grant': [
          {
            route: realmRoute,
            resource_id: realmId,
            subject_id: accountId,
            subject_role: '',
            action: 'realm:read',
            valid: '[2020-01-01 00:00:00+00,)',
            transaction_id: transactionId,
          },
        ],
        'content.board': [
          {
            route: realmRoute,
            board_id: board,
            realm_id: realmId,
            subject_id: newId(realmRoute),
            title: 'Unrelated board in measured Realm',
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: transactionId,
            created_at: createdAt,
            purpose: 'discussion',
          },
        ],
        'content.thread': [
          {
            route: realmRoute,
            thread_id: thread,
            author_account_id: accountId,
            board_id: boardId,
            title: 'Unrelated measured-board thread',
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: transactionId,
            created_at: createdAt,
            first_post_id: post,
            availability: 'available',
          },
        ],
        'content.post': [
          {
            route: realmRoute,
            thread_id: thread,
            post_id: post,
            reply_to_post_id: null,
            author_account_id: accountId,
            head_revision_id: revision,
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: transactionId,
            created_at: createdAt,
            availability: 'available',
          },
        ],
        'content.revision': [
          {
            route: realmRoute,
            thread_id: thread,
            post_id: post,
            revision_id: revision,
            body: threadBody,
            body_sha256: threadDigest,
            search_text: 'A fixed point-read growth thread.',
            licence: 'CC-BY-4.0',
            subject_ids: [],
            board_id: boardId,
            availability: 'available',
            recorded_transaction_id: transactionId,
            recorded_at: createdAt,
            media_ids: [],
          },
        ],
        'content.board_thread': [
          {
            route: realmRoute,
            board_id: boardId,
            thread_id: thread,
            created_at: createdAt,
            source_epoch: 1,
            source_position: ordinal + 3,
            source_revision_id: revision,
            last_activity_at: createdAt,
          },
        ],
      };
    },
  };
}

async function grow(
  growthFixture: CommunityGrowth,
  realmId: string,
  boardId: string,
  scale: number,
  previous: number,
  outsider?: Account,
) {
  await growthFixture.grow(scale, previous);
  await seed(growthFixture.database, pointReadPopulation(realmId, boardId), { from: previous, to: scale });
  if (outsider) await expectHiddenAsMissing(outsider, boardId);
}

async function read(actor: Account | null, boardId: string) {
  return driver.request({ actor, method: 'GET', path: `/v1/boards/${boardId}` });
}

async function expectHiddenAsMissing(outsider: Account, boardId: string) {
  const hidden = await read(outsider, boardId);
  const missing = await read(outsider, newId(routeOf(boardId)!));
  expect(hidden.status).toBe(404);
  expect(missing.status).toBe(404);
  const hiddenBody = (await hidden.json()) as Record<string, unknown>;
  const missingBody = (await missing.json()) as Record<string, unknown>;
  delete hiddenBody.request_id;
  delete missingBody.request_id;
  expect(hiddenBody).toEqual(missingBody);
}

function expectNoGrowingSequentialScans(report: Awaited<ReturnType<typeof checkGrowth>>) {
  expect(report.samples).toHaveLength(3);
  for (const sample of report.samples)
    for (const relation of growingRelations)
      expect(sample.cost.relations[relation]?.sequentialScans ?? 0, `${relation} at scale ${sample.scale}`).toBe(0);
}

test('Public Realm board point read stays within its bound as boards, members and grants grow', async () => {
  growth = await driver.growthFixture();
  const expected = await read(null, growth.boardId);
  expect(expected.status).toBe(200);
  const expectedBody = await expected.clone().json();
  const report = await checkGrowth(growth.database, {
    name: 'Public Realm board point read stays within its bound as boards, members and grants grow',
    scales,
    bounds,
    grow: (_db, scale, previous) => grow(growth!, growth!.realmId, growth!.boardId, scale, previous),
    operation: async () => {
      const response = await read(null, growth!.boardId);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expectedBody);
    },
  });
  expectNoGrowingSequentialScans(report);
  await growth.close();
  growth = undefined;
});

test('Protected Realm board point read by a member stays within its bound as boards, members and grants grow', async () => {
  growth = await driver.growthFixture();
  const protectedTarget = await makeProtectedRealm();
  const memberResponse = await read(fixture.member, protectedTarget.boardId);
  expect(memberResponse.status).toBe(200);
  const expectedBody = await memberResponse.clone().json();

  const report = await checkGrowth(growth.database, {
    name: 'Protected Realm board point read by a member stays within its bound as boards, members and grants grow',
    scales,
    bounds,
    grow: (_db, scale, previous) =>
      grow(growth!, protectedTarget.realm.realmId, protectedTarget.boardId, scale, previous, fixture.outsider),
    operation: async () => {
      const response = await read(fixture.member, protectedTarget.boardId);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expectedBody);
    },
  });
  expectNoGrowingSequentialScans(report);

  await growth.close();
  growth = undefined;
});
