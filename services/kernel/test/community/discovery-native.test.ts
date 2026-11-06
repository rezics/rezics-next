import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { bundledRelease } from '@rezics/definitions/bundled';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import {
  createContentSystemWithOrdinaryScopes,
  contentGovernanceCredential,
  type ContentSystem,
} from '../content/support/system.ts';
import { productionActions } from '../support/production-actions.ts';
import { listRealmDiscovery, type DiscoveryPage } from '../../src/community/discovery.ts';
import { projectRealmDiscovery } from '../../src/community/discovery-projection.ts';
import { expireRealmDiscovery } from '../../src/community/discovery-expiry.ts';

let system: ContentSystem;
let current: Date;
const clock = () => current;
const DAY = 86_400_000;
let first: number;

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
  system = await createContentSystemWithOrdinaryScopes(
    { databaseUrl },
    [...productionActions().keys()].filter((action) =>
      /^(account|access|space|realm|board|thread|post|subject|context|definitions|statement|document|copy|moderation|exposure|report|rating|follow|reaction|openapi):/.test(
        action,
      ),
    ),
  );
  const governance = await contentGovernanceCredential(system);
  const release = await call('/v1/definitions/releases', { release: bundledRelease }, governance);
  await call(`/v1/definitions/releases/${release.digest}:activate`, { expected_head: null }, governance);
  first = Math.floor(Date.now() / DAY) * DAY + DAY;
  await time(first);
}, 120_000);
afterAll(async () => {
  await system?.close();
});

async function time(value: number) {
  current = new Date(value);
  await system.clock.setCommandTime(current.toISOString());
}
async function call(
  path: string,
  body: unknown,
  credential = system.actors.author,
  method = 'POST',
  etag?: string,
): Promise<any> {
  const response = await system.kernel.handle(
    new Request(`https://content.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${credential.bearer}`,
        'content-type': 'application/json',
        'Idempotency-Key': JSON.stringify(crypto.randomUUID()),
        ...(etag ? { 'If-Match': JSON.stringify(etag) } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
  expect(response.status).toBe(method === 'POST' ? 201 : 200);
  return response.json();
}
async function community(visibility: 'public' | 'protected' = 'public') {
  const { space } = await call('/v1/spaces', { title: 'Discovery host' });
  let { realm } = await call('/v1/realms', {
    spaceId: space.spaceId,
    title: 'Discovery Realm',
    summary: '  Current\n summary  ',
    contextId: GLOBAL_CONTEXT,
    visibility,
  });
  const { subject: scheme } = await call('/v1/subjects', { type: 'skos:ConceptScheme', labels: { en: 'Boards' } });
  ({ realm } = await call(
    `/v1/realms/${realm.realmId}/boardScheme`,
    { schemeId: scheme.id },
    undefined,
    'PUT',
    realm.headRevisionId,
  ));
  const { subject: concept } = await call('/v1/subjects', {
    type: 'skos:Concept',
    labels: { en: 'Discussion' },
    statements: {
      'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.id } }],
    },
  });
  const { board } = await call(`/v1/realms/${realm.realmId}/boards`, {
    conceptId: concept.id,
    title: 'Discussion',
    visibility: 'published',
  });
  return { realm, board, space };
}
async function start(boardId: string) {
  return call('/v1/threads', {
    boardId,
    title: 'A real start',
    body: fromPlainText('Discussion'),
    licence: 'MIT',
    subjectIds: [],
    visibility: 'published',
  });
}
async function catchUp(realmId: string) {
  // Every step is the production pool reader; no manufactured source record is accepted.
  while (await projectRealmDiscovery(system.database.pool, realmId, { clock, deadlineNow: () => Date.now() })) {
    /* bounded committed pages */
  }
}
function page(sort: 'popular' | 'trending', cursor?: string, limit = 20): Promise<DiscoveryPage> {
  return listRealmDiscovery(
    {
      pool: system.database.pool,
      access: system.access,
      tokens: system.tokenKeys,
      clock,
      deadlineNow: () => Date.now(),
    },
    Date.now() + 30_000,
    { sort, limit, ...(cursor ? { cursor } : {}) },
  );
}

test('native public Popular and Trending Realm discovery ranks real bounded windows, honors original source and current lifecycle privacy, signed cursor and due expiry', async () => {
  const control = await community();
  const publicRealm = await community();
  const privateRealm = await community('protected');
  await start(publicRealm.board.id); // first day, inclusive Popular boundary at cutoff +30
  await start(privateRealm.board.id); // never becomes evidence after publication
  await time(first + 29 * DAY);
  await start(control.board.id);
  await start(publicRealm.board.id);
  await time(first + 30 * DAY);
  const publicNow = await call(
    `/v1/realms/${privateRealm.realm.realmId}`,
    { visibility: 'public' },
    undefined,
    'PATCH',
    privateRealm.realm.headRevisionId,
  );
  await catchUp(publicRealm.realm.realmId);
  await catchUp(privateRealm.realm.realmId);
  await expireRealmDiscovery(system.database.pool, { clock, deadlineNow: () => Date.now() });
  const popular = await page('popular', undefined, 1);
  expect(popular.realms.map((r) => r.realmId)).toEqual([publicRealm.realm.realmId]);
  expect(popular.realms[0]).toEqual({
    realmId: publicRealm.realm.realmId,
    spaceId: publicRealm.space.spaceId,
    name: 'Discovery Realm',
    description: 'Current summary',
    avatar: null,
  });
  expect((await page('trending')).realms.map((r) => r.realmId)).toEqual(
    [control.realm.realmId, publicRealm.realm.realmId].sort(),
  );
  await catchUp(publicRealm.realm.realmId); // genuine no-effect replay cannot count twice
  expect((await page('popular', popular.next!, 1)).realms.map((r) => r.realmId)).toEqual([control.realm.realmId]);
  await expect(page('trending', popular.next!, 1)).rejects.toMatchObject({ code: 'invalid_cursor' });

  // Current native gate wins even before the derived consumer catches up.
  await call(
    `/v1/realms/${publicRealm.realm.realmId}`,
    { visibility: 'protected' },
    undefined,
    'PATCH',
    publicRealm.realm.headRevisionId,
  );
  const sparse = await page('popular', undefined, 1);
  expect(sparse.realms).toEqual([]);
  expect(sparse.next).not.toBeNull();
  await catchUp(publicRealm.realm.realmId);
  await start(privateRealm.board.id); // genuinely public new epoch start, today is still excluded
  await catchUp(privateRealm.realm.realmId);
  expect((await page('popular')).realms.map((r) => r.realmId)).toEqual([control.realm.realmId]);
  await time(first + 31 * DAY);
  await expireRealmDiscovery(system.database.pool, { clock, deadlineNow: () => Date.now() });
  expect((await page('trending')).realms.map((r) => r.realmId)).toEqual([privateRealm.realm.realmId]);
  await expect(page('popular', popular.next!, 1)).rejects.toMatchObject({ code: 'stale_cursor' });
  await time(first + 32 * DAY);
  await expireRealmDiscovery(system.database.pool, { clock, deadlineNow: () => Date.now() });
  expect((await page('trending')).realms).toEqual([]);
  await time(first + 62 * DAY);
  await expireRealmDiscovery(system.database.pool, { clock, deadlineNow: () => Date.now() });
  expect((await page('popular')).realms).toEqual([]);
  // Retaining Context is an identity invariant, never permission to fall back to Global.
  expect(publicNow.realm.contextId).toBe(GLOBAL_CONTEXT);
}, 120_000);
