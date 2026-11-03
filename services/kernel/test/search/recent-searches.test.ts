import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccess } from '../../src/access/index.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { createCollectionCommands } from '../../src/library/collections.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import type { Access } from '../../src/request/access.ts';
import type { RecentEntry } from '../../src/search/recent-searches.ts';
import { createKernelClient } from '@rezics/client';

const pool = createPool(process.env.DATABASE_URL!);
const signing = await generateKeyPair('ES256', { extractable: true });
const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'recent', alg: 'ES256' };
let access: Access;
const kernel = createKernel({
  pool,
  routeKey: new Uint8Array(32).fill(6),
  access: (config) => {
    access = createAccess({
      ...config,
      auth: {
        issuer: 'https://recent.test',
        audience: 'https://api.test',
        jwksUrl: 'https://recent.test/jwks',
        fetch: async () => Response.json({ keys: [jwk] }),
      },
    });
    return access;
  },
});
const scopes = 'recent_search:read recent_search:write collection:create collection:read collection:delete';
async function viewer() {
  const id = newId(0x7341);
  await pool.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id,authn_fenced,minimum_authn_epoch,membership_inverse_complete)
    VALUES ($1,$2,'actor','active',$2,false,1,true)`,
    [routeOf(id), id],
  );
  const token = await new SignJWT({
    client_id: 'web',
    scope: scopes,
    authn_epoch: 1,
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'recent', typ: 'at+jwt' })
    .setIssuer('https://recent.test')
    .setAudience('https://api.test')
    .setSubject(id)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signing.privateKey);
  const client = createKernelClient('http://kernel.test', {
    headers: { authorization: `Bearer ${token}` },
    fetch: (async (input, init) => kernel.handle(new Request(input, init))) as typeof fetch,
  });
  // Resolve the actual installed Access and authenticate through its verified token binding.
  await client.recentSearches.get();
  const actor = await access.authenticate(token, { pool, deadline: Date.now() + 10000 });
  return { id, actor, client, token };
}
let a: Awaited<ReturnType<typeof viewer>>, b: Awaited<ReturnType<typeof viewer>>;
beforeAll(async () => {
  a = await viewer();
  b = await viewer();
});
afterAll(() => pool.end());
const headers = () => ({ 'idempotency-key': JSON.stringify(randomUUID()) });
const use = (client: typeof a.client, entry: RecentEntry, revision: number) =>
  client.recentSearches.post({ entry, expectedRevision: revision }, { headers: headers() });

const remove = (client: typeof a.client, id: string, expectedRevision: number) =>
  client.recentSearches({ id }).delete(undefined, { query: { expectedRevision }, headers: headers() });

test('the typed self-resource isolates accounts, rejects caller account selection and keeps private strings out of outbox/receipts', async () => {
  const text = `private query ${randomUUID()}`;
  const created = await use(a.client, { kind: 'query', text, languages: ['en'] }, 0);
  expect(created.status).toBe(200);
  const page = await a.client.recentSearches.get();
  expect(page.data?.recentSearches[0]?.entry).toEqual({ kind: 'query', text, languages: ['en'] });
  expect((await b.client.recentSearches.get()).data?.recentSearches).toEqual([]);
  expect((await remove(b.client, created.data!.id!, 0)).status).toBe(404);
  const arbitrary = await kernel.handle(
    new Request('http://kernel.test/v1/recentSearches', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${a.token}`, ...headers() },
      body: JSON.stringify({ accountId: a.id, entry: { kind: 'query', text }, expectedRevision: 0 }),
    }),
  );
  expect(arbitrary.status).toBe(400);
  const anonymous = await kernel.handle(new Request('http://kernel.test/v1/recentSearches'));
  expect(anonymous.status).toBe(401);
  const events = await pool.query(`SELECT data::text AS data FROM core.outbox WHERE data::text LIKE $1`, [`%${text}%`]);
  expect(events.rows).toEqual([]);
  const receipts = await pool.query(
    'SELECT response::text FROM core.receipt WHERE principal_id=$1 AND response::text LIKE $2',
    [a.id, `%${text}%`],
  );
  expect(receipts.rows).toEqual([]);
});

test('language-qualified queries remain distinct and use the repeated search language parameter', async () => {
  const { client: c } = await viewer();
  const text = `same query ${randomUUID()}`;
  expect((await use(c, { kind: 'query', text, languages: ['fr', 'en'] }, 0)).status).toBe(200);
  expect((await use(c, { kind: 'query', text, languages: ['ja'] }, 1)).status).toBe(200);
  expect((await use(c, { kind: 'query', text: 'legacy query' }, 2)).status).toBe(200);

  const rows = (await c.recentSearches.get()).data!.recentSearches;
  const selected = rows.filter((row) => row.entry.kind === 'query' && row.entry.text === text);
  expect(selected).toHaveLength(2);
  expect(new Set(selected.map((row) => row.id)).size).toBe(2);
  for (const row of selected) {
    expect(row.entry.kind).toBe('query');
    if (row.entry.kind !== 'query') continue;
    const url = new URL(row.display!.href, 'https://kernel.test');
    expect(url.searchParams.get('q')).toBe(text);
    expect(url.searchParams.getAll('language')).toEqual(row.entry.languages ?? []);
  }
  const legacy = rows.find((row) => row.entry.kind === 'query' && row.entry.text === 'legacy query')!;
  expect(new URL(legacy.display!.href, 'https://kernel.test').searchParams.getAll('language')).toEqual([]);
});

test('observed revisions preserve updates, remove and clear across devices; receipt replay cannot resurrect history', async () => {
  const { client: c } = await viewer(),
    entry = { kind: 'query' as const, text: 'A shared device search' };
  const requestHeaders = headers();
  const first = await c.recentSearches.post({ entry, expectedRevision: 0 }, { headers: requestHeaders });
  expect(first.status).toBe(200);
  const touched = await use(c, entry, 1);
  expect(touched.data?.id).toBe(first.data?.id);
  expect((await remove(c, first.data!.id!, 1)).status).toBe(409);
  const removed = await remove(c, first.data!.id!, 2);
  expect(removed.data?.revision).toBe(3);
  expect((await c.recentSearches.post({ entry, expectedRevision: 0 }, { headers: requestHeaders })).data).toEqual(
    first.data,
  );
  expect((await c.recentSearches.get()).data?.recentSearches).toEqual([]);
  expect((await use(c, entry, 2)).status).toBe(409);
  expect((await use(c, entry, 3)).status).toBe(200);
  expect((await c.recentSearches.$clear.post({ expectedRevision: 3 }, { headers: headers() })).status).toBe(409);
  expect((await c.recentSearches.$clear.post({ expectedRevision: 4 }, { headers: headers() })).data?.revision).toBe(5);
});

test('visited Collection names come from the native current owner read and disappear when the Collection is removed', async () => {
  const { client: c, actor } = await viewer();
  const commands = createCollectionCommands({ pool, access });
  const collection = await commands.createCollection(
    actor,
    { title: 'Private current title', visibility: 'private' },
    randomUUID(),
  );
  const entry = { kind: 'scope' as const, scope: { kind: 'collection' as const, id: collection.value.id } };
  expect((await use(c, entry, 0)).status).toBe(200);
  expect((await c.recentSearches.get()).data?.recentSearches[0]?.display?.name).toBe('Private current title');
  expect((await use(b.client, entry, 0)).status).toBe(404);
  const query = { kind: 'query' as const, text: '地図 + maps & /?', languages: ['ja', 'en'], scope: entry.scope };
  expect((await use(c, query, 1)).status).toBe(200);
  expect((await use(b.client, query, 0)).status).toBe(404);
  const replay = (await c.recentSearches.get()).data!.recentSearches.find((row) => row.entry.kind === 'query')!;
  const destination = new URL(replay.display!.href, 'https://kernel.test');
  expect(destination.pathname).toBe('/search');
  expect(destination.searchParams.get('q')).toBe(query.text);
  expect(destination.searchParams.getAll('language')).toEqual(['ja', 'en']);
  expect(JSON.parse(destination.searchParams.get('filter')!)).toEqual({ collection: { id: collection.value.id } });

  await commands.deleteCollection(actor, collection.value.id, collection.value.revision, randomUUID());
  const current = await c.recentSearches.get();
  expect(current.status).toBe(200);
  expect(current.data?.recentSearches.every((row) => row.display === null)).toBe(true);
  expect(current.data?.recentSearches.find((row) => row.entry.kind === 'query')?.entry).toEqual(query);
  expect(JSON.stringify(current.data)).not.toContain('Private current title');
});

test('the list is capped at twenty, cursors bind to the principal and revision, and expired private entries are withheld', async () => {
  const { client: c, id } = await viewer();
  for (let n = 0; n < 21; n++) expect((await use(c, { kind: 'query', text: `query ${n}` }, n)).status).toBe(200);
  const first = await c.recentSearches.get();
  expect(first.data?.recentSearches).toHaveLength(20);
  expect(first.data?.next).toBeTruthy();
  expect((await b.client.recentSearches.get({ query: { cursor: first.data!.next! } })).status).toBe(400);
  expect((await c.recentSearches.get({ query: { cursor: first.data!.next! } })).data?.recentSearches).toHaveLength(1);
  expect((await c.recentSearches.get({ query: { limit: 21 } })).status).toBe(400);
  await use(c, { kind: 'query', text: 'latest' }, 21);
  expect((await c.recentSearches.get({ query: { cursor: first.data!.next! } })).status).toBe(409);
  await pool.query(
    "UPDATE search.recent_search SET expires_at=clock_timestamp()-interval '1 second' WHERE account_id=$1",
    [id],
  );
  expect((await c.recentSearches.get()).data?.recentSearches).toEqual([]);
});
