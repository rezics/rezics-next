import { suspendAccount } from '../support/native-suspension-driver.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bootstrapGovernance } from '../../src/access/bootstrap-governance.ts';
import { createLifecycleCommands, LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import type { CollectionView } from '../../src/library/collection-reads.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { accountToken, admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { capture, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const owner = newId(0x6c33);
const other = newId(0x6c33);
const suspended = newId(0x6c33);
const unknown = newId(0x6c33);
const scopes = ['collection:create', 'collection:read', 'collection:update', 'collection:delete', 'exposure:open'];
const credentials = new Map<string, string>();
type Persona = 'owner' | 'other' | 'anonymous';
type Page = { collections: CollectionView[]; next: string | null };
const accountPath = (id = owner) => `/v1/accounts/${id}/collections`;
const curatorPath = (id = owner) => `/v1/collections?curatorAccountId=${id}`;
let db: GrowthDatabase;
let app: ReturnType<typeof createKernel>;
let publicCollections: CollectionView[];
let activeCollections: CollectionView[];

async function request(method: string, path: string, body?: unknown, as: Persona = 'owner') {
  const id = as === 'owner' ? owner : as === 'other' ? other : null;
  return app.handle(
    new Request(`https://kernel.test${path}`, {
      method,
      headers: {
        ...(id ? { authorization: `Bearer ${credentials.get(id)!}` } : {}),
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(randomUUID()) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function json<T>(response: Response, status = 200): Promise<T> {
  expect(response.status).toBe(status);
  return response.json() as Promise<T>;
}
async function page(path: string, as: Persona = 'anonymous'): Promise<Page> {
  const value = await json<Page>(await request('GET', path, undefined, as));
  expect(Object.keys(value).sort()).toEqual(['collections', 'next']);
  return value;
}
async function create(title: string, visibility: CollectionView['visibility']) {
  return (
    await json<{ collection: CollectionView }>(await request('POST', '/v1/collections', { title, visibility }), 201)
  ).collection;
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  app = createKernel({
    pool: db.pool,
    routeKey: new Uint8Array(32).fill(73),
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(74)]]) },
    access: admittedAccess,
    writeRate: {
      async spend() {
        return { allowed: true as const };
      },
    },
  });
  for (const id of [owner, other, suspended]) {
    await db.admin.query(
      `INSERT INTO access.account
        (route, account_id, kind, state, transaction_id, membership_inverse_complete, display_name)
       VALUES ($1,$2,'actor','active',$2,true,'Public curator')`,
      [routeOf(id), id],
    );
    credentials.set(id, await accountToken({ accountId: id, clientId: 'web', scopes }));
  }
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES ($1,$2,$2,'account:update','(,)',$2)`,
    [routeOf(owner), owner],
  );
  await bootstrapGovernance(db.pool, owner);
  await json(await request('POST', '/v1/platform/exposure/collections:open'));
  const first = await create('First public', 'public');
  const unlisted = await create('Unlisted', 'unlisted');
  const second = await create('Second public', 'public');
  const privateCollection = await create('Private', 'private');
  const deleted = await create('Deleted public', 'public');
  expect((await request('DELETE', `/v1/collections/${deleted.id}?revision=${deleted.revision}`)).status).toBe(204);
  // Move the first Collection ahead of the second by updating it, rather than relying on creation order.
  const updated = (
    await json<{ collection: CollectionView }>(
      await request('PATCH', `/v1/collections/${first.id}`, { revision: first.revision, title: 'Updated public' }),
    )
  ).collection;
  publicCollections = [updated, second];
  activeCollections = [updated, privateCollection, second, unlisted];
  await db.admin.query(
    `INSERT INTO library.collection
      (route,collection_id,curator_account_id,title,visibility,state,revision,created_at,updated_at,transaction_id)
     VALUES ($1,$2,$3,'Suspended public','public','active',1,now(),now(),$2)`,
    [routeOf(suspended), newId(routeOf(suspended)!), suspended],
  );
  await suspendAccount(db.admin, suspended);
});
afterAll(async () => {
  await db?.close();
});

test('the account Collection route declares its account parameter, exposure, read action and anonymous access', () => {
  const operation = openApiDocument(app).paths['/v1/accounts/{accountId}/collections']?.get;
  expect(operation).toMatchObject({
    'x-exposure': 'gate:collections',
    'x-action': 'collection:read',
    security: [{ bearerAuth: [] }, {}],
  });
  expect(operation?.parameters).toContainEqual(expect.objectContaining({ in: 'path', name: 'accountId' }));
});

test('every viewer sees only public Collections on the account path in newest updated order with keyset pages', async () => {
  for (const as of ['anonymous', 'other', 'owner'] as const) {
    expect(await page(accountPath(), as)).toEqual({ collections: publicCollections, next: null });
    let cursor: string | null = null;
    const collected: CollectionView[] = [];
    for (const expected of publicCollections) {
      const result = await page(`${accountPath()}?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, as);
      expect(result.collections).toEqual([expected]);
      collected.push(...result.collections);
      cursor = result.next;
      if (collected.length < publicCollections.length) expect(cursor).toBeString();
      else expect(cursor).toBeNull();
    }
    expect(collected).toEqual(publicCollections);
  }
});

test('FULL embeds the curator public summary and BASIC keeps the Collection list shape', async () => {
  const result = await json<{ collections: (CollectionView & { curator: unknown })[]; next: string | null }>(
    await request('GET', `${accountPath()}?view=FULL`, undefined, 'anonymous'),
  );
  expect(result).toEqual({
    collections: publicCollections.map((collection) => ({
      ...collection,
      curator: { id: owner, handle: null, displayName: 'Public curator' },
    })),
    next: null,
  });
  expect(await page(`${accountPath()}?view=BASIC`)).toEqual(await page(curatorPath()));
});

test('unknown and suspended accounts return the same empty page on both per-account listings', async () => {
  for (const id of [unknown, suspended])
    for (const as of ['anonymous', 'other', 'owner'] as const)
      for (const path of [accountPath(id), curatorPath(id)])
        expect(await page(path, as)).toEqual({ collections: [], next: null });
});

test('account pages reject foreign cursors, malformed ids and invalid page queries', async () => {
  const first = await page(`${accountPath()}?limit=1`);
  expect(first.next).toBeString();
  for (const id of [other, unknown]) {
    const response = await request(
      'GET',
      `${accountPath(id)}?cursor=${encodeURIComponent(first.next!)}`,
      undefined,
      'anonymous',
    );
    expect(await json(response, 400)).toMatchObject({ code: 'invalid_cursor' });
  }
  expect(await json(await request('GET', accountPath('invalid'), undefined, 'anonymous'), 404)).toMatchObject({
    code: 'not_found',
  });
  for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'view=INVALID', 'cursor=tampered']) {
    expect((await request('GET', `${accountPath()}?${query}`, undefined, 'anonymous')).status).toBe(400);
  }
});

test('turning Collections view off hides both lists from others, preserves curator views and public point reads', async () => {
  const first = await page(`${accountPath()}?limit=1`);
  const access = admittedAccess({ actions: LIFECYCLE_ACTIONS });
  const actor = await authenticateAccount(
    access,
    { pool: db.pool, deadline: Date.now() + 10000 },
    {
      accountId: owner,
      clientId: 'web',
      scopes: ['account:update'],
    },
  );
  await createLifecycleCommands({ pool: db.pool, access }).updateAccount(
    { actor, deadline: Date.now() + 10000 },
    { accountId: owner, key: randomUUID(), patch: { publicViews: { collections: false } } },
  );
  for (const as of ['anonymous', 'other'] as const) {
    for (const path of [accountPath(), curatorPath(), `${accountPath()}?cursor=${encodeURIComponent(first.next!)}`]) {
      const result = await capture(db, () => page(path, as));
      expect(result.value).toEqual({ collections: [], next: null });
      expect(result.capture.statements.some((statement) => /FROM library\.collection\b/i.test(statement))).toBe(false);
      expect(
        result.capture.statements.some((statement) => /BEGIN ISOLATION LEVEL REPEATABLE READ/i.test(statement)),
      ).toBe(false);
    }
    expect(await json(await request('GET', `/v1/collections/${publicCollections[0]!.id}`, undefined, as))).toEqual({
      collection: publicCollections[0],
    });
  }
  expect(await page(accountPath(), 'owner')).toEqual({ collections: publicCollections, next: null });
  expect(await page(curatorPath(), 'owner')).toEqual({ collections: activeCollections, next: null });
});
