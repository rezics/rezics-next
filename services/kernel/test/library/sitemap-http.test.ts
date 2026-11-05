import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { actionCatalogue } from '../../src/http/request.ts';
import { decodeListCursor, encodeListCursor } from '../../src/tokens/list-cursor.ts';
import { routeOf } from '../../src/route/route.ts';
import { capture, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { testKernel } from '../support/test-kernel.ts';

const path = '/v1/sitemap/collections';
let fixtureCase = 0;
const owner = id(0, 999);
const modified = '2026-05-01T01:02:03.456Z';
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(107)]]) };
const originalKey = tokens.keys.get(1)!;
let now = new Date('2026-10-27T01:00:00.000Z');
let db: GrowthDatabase;
let app: ReturnType<typeof testKernel>;
let bearer: string;
type Page = { items: { id: string; lastModified: string }[]; next: string | null };
const binding = (limit: number) => ({ route: `GET ${path}`, viewer: null, query: { limit } });
function id(route: number, n: number) {
  const prefix = (0x10000000 + (n === 999 ? 0 : fixtureCase)).toString(16).padStart(8, '0');
  return `${prefix}-0000-7000-8000-${route.toString(16).padStart(4, '0')}${n.toString(16).padStart(8, '0')}`;
}
async function insert(rows: { route: number; n: number; kind?: string }[]) {
  await db.admin.query(
    `INSERT INTO library.collection
       (route,collection_id,curator_account_id,title,visibility,state,revision,created_at,updated_at,transaction_id)
     SELECT r.route,r.id,r.curator,'Sitemap',CASE WHEN r.kind='deleted' THEN 'public' ELSE r.kind END,
       CASE WHEN r.kind='deleted' THEN 'deleted' ELSE 'active' END,1,$2,$2,r.id
     FROM jsonb_to_recordset($1::jsonb) r(route int,id uuid,curator uuid,kind text)`,
    [
      JSON.stringify(
        rows.map((r) => ({
          route: r.route,
          id: id(r.route, r.n),
          curator: id(r.route, 999),
          kind: r.kind ?? 'public',
        })),
      ),
      modified,
    ],
  );
}
async function response(values: Record<string, string> = {}, auth = false, kernel = app) {
  return kernel.handle(
    new Request(`https://kernel.test${path}?${new URLSearchParams(values)}`, {
      headers: auth ? { authorization: `Bearer ${bearer}` } : {},
    }),
  );
}
async function page(values: Record<string, string> = {}, auth = false, kernel = app): Promise<Page> {
  const result = await response(values, auth, kernel);
  expect(result.status).toBe(200);
  const body = (await result.json()) as Page;
  expect(Object.keys(body).sort()).toEqual(['items', 'next']);
  return body;
}
async function walk(limit: number, auth = false) {
  const items: Page['items'] = [];
  let next: string | null = null;
  let pages = 0;
  do {
    const result = await page({ limit: String(limit), ...(next ? { cursor: next } : {}) }, auth);
    expect(result.items.length).toBeLessThanOrEqual(limit);
    items.push(...result.items);
    next = result.next;
    expect(++pages).toBeLessThan(1500);
  } while (next);
  expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  return items;
}
async function invalid(cursor: string, limit = 1, kernel = app) {
  const result = await response({ cursor, limit: String(limit) }, false, kernel);
  expect(result.status).toBe(400);
  expect(await result.json()).toMatchObject({ code: 'invalid_cursor' });
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  const keys = await generateKeyPair('ES256');
  const jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'fixture', alg: 'ES256' }] };
  app = testKernel({
    pool: db.pool,
    tokens,
    clock: () => now,
    auth: {
      issuer: 'https://sitemap.test',
      audience: 'https://api.sitemap.test',
      jwksUrl: 'https://sitemap.test/jwks',
      fetch: async () => Response.json(jwks),
    },
  });
  const issued = Math.floor(now.getTime() / 1000);
  bearer = await new SignJWT({
    sub: owner,
    client_id: 'web',
    scope: 'collection:read',
    authn_epoch: 1,
    auth_time: issued,
    amr: ['pwd'],
  })
    .setIssuer('https://sitemap.test')
    .setAudience('https://api.sitemap.test')
    .setIssuedAt(issued)
    .setExpirationTime(issued + 300)
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: 'fixture' })
    .sign(keys.privateKey);
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete,public_views)
    VALUES (0,$1,'actor','active',$1,true,'{"posts":true,"reviews":true,"collections":false,"realms":true}')`,
    [owner],
  );
});
beforeEach(async () => {
  fixtureCase += 1;
  now = new Date('2026-10-27T01:00:00.000Z');
  tokens.current = 1;
  tokens.keys.clear();
  tokens.keys.set(1, originalKey);
  await db.admin.query('DELETE FROM library.collection');
  await db.admin.query('DELETE FROM access.exposure_opening WHERE "group"=\'collections\'');
  await db.admin.query(
    `INSERT INTO access.exposure_opening("group",valid,transaction_id)
    VALUES ('collections','[2020-01-01,)', $1)`,
    [owner],
  );
});
afterAll(async () => {
  await db?.close();
});

test('the Collection sitemap lists only indexable public Collections and advances after filtered candidates', async () => {
  await insert([
    { route: 0, n: 1 },
    { route: 0, n: 2, kind: 'private' },
    { route: 0, n: 3, kind: 'unlisted' },
    { route: 0, n: 4, kind: 'deleted' },
    { route: 0, n: 5 },
    { route: 15, n: 1 },
    { route: 31, n: 1 },
    { route: 65535, n: 1 },
  ]);
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    VALUES (0,$1,$2,'collection:read','(,)',$2)`,
    [id(0, 2), owner],
  );
  const privateRead = await app.handle(
    new Request(`https://kernel.test/v1/collections/${id(0, 2)}`, {
      headers: { authorization: `Bearer ${bearer}` },
    }),
  );
  expect(privateRead.status).toBe(200);
  const expected = [id(0, 1), id(0, 5), id(15, 1), id(31, 1), id(65535, 1)].map((id) => ({
    id,
    lastModified: modified,
  }));
  for (const limit of [1, 48, 1000]) {
    expect(await walk(limit)).toEqual(expected);
    expect(await walk(limit, true)).toEqual(expected);
  }
}, 180_000);

test('sitemap limits, empty cursor and opaque cursor bindings are enforced', async () => {
  await insert([
    { route: 0, n: 1 },
    { route: 0, n: 2 },
  ]);
  expect((await page()).items).toHaveLength(2);
  for (const limit of ['0', '1001', '-1', '1.5', 'abc']) expect((await response({ limit })).status).toBe(400);
  expect((await response({ cursor: '' })).status).toBe(400);
  const next = (await page({ limit: '1' })).next!;
  await invalid('forged');
  await invalid(next.slice(0, -2) + 'xx');
  await invalid(next, 48);
  for (const changed of [
    { ...binding(1), route: 'GET /v1/sitemap/boards' },
    { ...binding(1), viewer: owner },
  ])
    expect((await decodeListCursor(tokens, changed, next, now)).ok).toBe(false);
  const decoded = await decodeListCursor(tokens, binding(1), next, now);
  expect(decoded.ok).toBe(true);
  const readable = Buffer.from(next, 'base64url').toString('utf8');
  for (const secret of [id(0, 1), modified, JSON.stringify(decoded)]) expect(readable).not.toContain(secret);
  const foreign = await encodeListCursor(
    tokens,
    { ...binding(1), route: 'GET /v1/sitemap/threads' },
    { epoch: 1, after: ['collections', 0, 'scan', 0, id(0, 1)] },
    now,
  );
  await invalid(foreign);
  for (const after of [
    [],
    ['wrong', 0, 'scan'],
    ['collections', -1, 'done'],
    ['collections', 0, 'scan', 16, id(16, 1)],
    ['collections', 0, 'scan', 0, 'bad'],
    ['collections', 0, 'done', 0, id(0, 1)],
  ]) {
    await invalid(await encodeListCursor(tokens, binding(1), { epoch: 1, after }, now));
  }
});

test('sitemap cursors use the kernel clock and existing key rotation', async () => {
  await insert([
    { route: 0, n: 1 },
    { route: 0, n: 2 },
  ]);
  const old = (await page({ limit: '1' })).next!;
  tokens.keys.set(2, new Uint8Array(32).fill(33));
  tokens.current = 2;
  const fresh = (await page({ limit: '1', cursor: old })).next!;
  expect((await decodeListCursor(tokens, binding(1), fresh, now)).ok).toBe(true);
  expect(Buffer.from(fresh, 'base64url')[1]).toBe(2);
  tokens.keys.delete(1);
  await invalid(old);
  const issuedAt = now.getTime();
  const continuation = await page({ limit: '1', cursor: fresh });
  for (const elapsed of [15 * 60_000 + 1, 24 * 60 * 60_000, 366 * 24 * 60 * 60_000]) {
    now = new Date(issuedAt + elapsed);
    expect((await decodeListCursor(tokens, binding(1), fresh, now)).ok).toBe(true);
    expect(await page({ limit: '1', cursor: fresh })).toEqual(continuation);
  }
});

test('a closed collections gate does no discovery and never returns a checkpoint', async () => {
  await insert([{ route: 0, n: 1 }]);
  const cursor = (await page({ limit: '1' })).next!;
  await db.admin.query('DELETE FROM access.exposure_opening WHERE "group"=\'collections\'');
  for (const auth of [false, true]) {
    const measured = await capture(db, () => page({ limit: '1', cursor }, auth));
    expect(measured.value).toEqual({ items: [], next: null });
    expect(measured.capture.statements.some((sql) => sql.includes('FROM library.collection'))).toBe(false);
  }
});

test('immutable checkpoints survive edits and profile Collections visibility does not hide public pages', async () => {
  await insert([
    { route: 0, n: 1 },
    { route: 0, n: 2 },
    { route: 0, n: 3 },
  ]);
  const first = await page({ limit: '1' });
  await db.admin.query(
    `UPDATE library.collection SET title='Edited',updated_at='2026-10-26'
    WHERE collection_id=ANY($1::uuid[])`,
    [[id(0, 1), id(0, 3)]],
  );
  const second = await page({ limit: '1', cursor: first.next! });
  const third = await page({ limit: '1', cursor: second.next! });
  expect([...first.items, ...second.items, ...third.items].map((item) => item.id)).toEqual([
    id(0, 1),
    id(0, 2),
    id(0, 3),
  ]);
  expect(third.items[0]!.lastModified).toBe('2026-10-26T00:00:00.000Z');
  // The curator has explicitly disabled the profile Collections view.
  const lists = await app.handle(new Request(`https://kernel.test/v1/accounts/${owner}/collections`));
  expect(await lists.json()).toMatchObject({ collections: [] });
});

test('candidate caps consume denials, encrypt skipped positions and retain the next eligible item', async () => {
  await insert(Array.from({ length: 7 }, (_, n) => ({ route: 0, n: n + 1 })));
  const actions = new Map(actionCatalogue(app));
  actions.set('collection:read', { anonymous: false });
  const denied = testKernel({ pool: db.pool, tokens, clock: () => now, actions });
  const result = await page({ limit: '1' }, false, denied);
  expect(result.items).toEqual([]);
  expect(result.next).toBeString();
  const decoded = await decodeListCursor(tokens, binding(1), result.next!, now);
  expect(decoded).toMatchObject({ ok: true, after: ['collections', 0, 'scan', 0, id(0, 4)] });
  const outer = Buffer.from(result.next!, 'base64url').toString('utf8');
  for (const value of [id(0, 4), modified, 'collections', 'scan', JSON.stringify(decoded)])
    expect(outer).not.toContain(value);
  expect(
    (
      await decodeListCursor(
        { current: 1, keys: new Map([[1, new Uint8Array(32).fill(55)]]) },
        binding(1),
        result.next!,
        now,
      )
    ).ok,
  ).toBe(false);
  const eligible = await page({ limit: '1', cursor: result.next! });
  expect(eligible.items.map((item) => item.id)).toEqual([id(0, 5)]);
});

test('empty partitions advance exhausted markers with at most four visits and preserve partition failures', async () => {
  let next: string | undefined;
  let lastPartition = -1;
  for (let n = 0; n < 3; n++) {
    const measured = await capture(db, () => page({ limit: '1', ...(next ? { cursor: next } : {}) }));
    expect(measured.value.items).toEqual([]);
    next = measured.value.next!;
    const decoded = await decodeListCursor(tokens, binding(1), next, now);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.after[2]).toBe('done');
      expect(Number(decoded.after[1])).toBeGreaterThan(lastPartition);
      lastPartition = Number(decoded.after[1]);
    }
    expect(measured.capture.statements.filter((sql) => sql.includes('FROM core.partition')).length).toBeLessThanOrEqual(
      4,
    );
  }
  await db.admin.query('UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=$1', [lastPartition]);
  const stale = await response({ limit: '1', cursor: next! });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ code: 'stale_cursor' });
  await db.admin.query("UPDATE core.partition SET write_state='moved',moved_to='elsewhere' WHERE partition_no=0");
  const moved = await response({ limit: '1' });
  expect(moved.status).toBe(503);
  expect(await moved.json()).toMatchObject({ code: 'partition_unavailable' });
  await db.admin.query("UPDATE core.partition SET write_state='active',moved_to=NULL WHERE partition_no=0");
  expect(routeOf(id(0, 1))).toBe(0);
});

test('a continuation carries the epoch of its own partition across different epochs', async () => {
  await db.admin.query('UPDATE core.partition SET epoch=7 WHERE partition_no=1');
  await insert([{ route: 31, n: 1 }]);
  const first = await page({ limit: '1' });
  expect(first.items.map((item) => item.id)).toEqual([id(31, 1)]);
  const decoded = await decodeListCursor(tokens, binding(1), first.next!, now);
  expect(decoded).toMatchObject({ ok: true, epoch: 7, after: ['collections', 1, 'scan', 31, id(31, 1)] });
  const second = await page({ limit: '1', cursor: first.next! });
  expect(second.items).toEqual([]);
  const following = await decodeListCursor(tokens, binding(1), second.next!, now);
  expect(following).toMatchObject({ ok: true, epoch: 1 });
  await db.admin.query('UPDATE core.partition SET epoch=1 WHERE partition_no=1');
});

test('Collection sitemap admission discovery and disclosure preserve unavailable outcomes', async () => {
  const { ProblemError } = await import('../../src/http/problem.ts');
  const { AccessUnavailableError } = await import('../../src/access/unavailable.ts');
  await insert([{ route: 0, n: 1 }]);
  // Fail only database transport at each stage; the kernel and its shared Access still perform the read.
  for (const stage of [
    'FROM access.exposure_opening',
    'FROM library.collection AS collection',
    'FROM library.collection\nWHERE',
  ]) {
    for (const code of ['dependency_unavailable', 'deadline_exceeded'] as const) {
      let failures = 0;
      const failure =
        code === 'dependency_unavailable' ? new ProblemError(code) : new AccessUnavailableError('deadline');
      const pool = new Proxy(db.pool, {
        get(target, property) {
          if (property === 'connect')
            return async () => {
              const client = await target.connect();
              return new Proxy(client, {
                get(connection, key) {
                  if (key === 'query')
                    return (...args: Parameters<typeof connection.query>) => {
                      const query: unknown = args[0];
                      const sql =
                        typeof query === 'string'
                          ? query
                          : typeof query === 'object' &&
                              query !== null &&
                              'text' in query &&
                              typeof query.text === 'string'
                            ? query.text
                            : '';
                      if (sql.includes(stage) && failures === 0) {
                        failures++;
                        throw failure;
                      }
                      return connection.query(...args);
                    };
                  const value = Reflect.get(connection, key);
                  return typeof value === 'function' ? value.bind(connection) : value;
                },
              });
            };
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const kernel = testKernel({ pool, tokens, clock: () => now });
      const result = await response({ limit: '1' }, false, kernel);
      expect(failures).toBe(1);
      expect(result.status).toBe(503);
      const problem = await result.json();
      expect(problem).toMatchObject({ code });
      expect(problem).not.toHaveProperty('items');
      expect(problem).not.toHaveProperty('next');
    }
  }
}, 30_000);
