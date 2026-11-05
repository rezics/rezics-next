import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccess } from '../../src/access/index.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import type { RecentEntry } from '../../src/search/recent-searches.ts';
import { createKernelClient } from '@rezics/client';

const pool = createPool(process.env.DATABASE_URL!);
const signing = await generateKeyPair('ES256', { extractable: true });
const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'recent-revision', alg: 'ES256' };
const kernel = createKernel({
  pool,
  routeKey: new Uint8Array(32).fill(6),
  access: (config) =>
    createAccess({
      ...config,
      auth: {
        issuer: 'https://recent-revision.test',
        audience: 'https://api.test',
        jwksUrl: 'https://recent-revision.test/jwks',
        fetch: async () => Response.json({ keys: [jwk] }),
      },
    }),
});
async function viewer() {
  const id = newId(0x7341);
  await pool.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id,authn_fenced,minimum_authn_epoch,membership_inverse_complete)
    VALUES ($1,$2,'actor','active',$2,false,1,true)`,
    [routeOf(id), id],
  );
  const token = await new SignJWT({
    client_id: 'web',
    scope: 'recent_search:read recent_search:write',
    authn_epoch: 1,
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'recent-revision', typ: 'at+jwt' })
    .setIssuer('https://recent-revision.test')
    .setAudience('https://api.test')
    .setSubject(id)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signing.privateKey);
  const client = createKernelClient('http://kernel.test', {
    headers: { authorization: `Bearer ${token}` },
    fetch: (async (input, init) => kernel.handle(new Request(input, init))) as typeof fetch,
  });
  await client.recentSearches.get();
  return { id, client };
}
afterAll(() => pool.end());
const headers = () => ({ 'idempotency-key': JSON.stringify(randomUUID()) });
const use = (client: Awaited<ReturnType<typeof viewer>>['client'], entry: RecentEntry, revision: number) =>
  client.recentSearches.post({ entry, expectedRevision: revision }, { headers: headers() });
const remove = (client: Awaited<ReturnType<typeof viewer>>['client'], id: string, expectedRevision: number) =>
  client.recentSearches({ id }).delete(undefined, { query: { expectedRevision }, headers: headers() });
async function effects(accountId: string) {
  const [entries, state, events, receipts] = await Promise.all([
    pool.query(
      'SELECT id, entry, revision, last_used, expires_at FROM search.recent_search WHERE account_id=$1 ORDER BY id',
      [accountId],
    ),
    pool.query('SELECT revision FROM search.recent_search_state WHERE account_id=$1', [accountId]),
    pool.query(
      `SELECT type, data FROM core.outbox WHERE subject=$1 AND type='com.rezics.search.recent-changed.v1' ORDER BY position, event_seq`,
      [accountId],
    ),
    pool.query(
      `SELECT command_kind, idempotency_key, response FROM core.receipt WHERE principal_id=$1 AND command_kind LIKE 'search.recent.%' ORDER BY transaction_id`,
      [accountId],
    ),
  ]);
  return { entries: entries.rows, state: state.rows, events: events.rows, receipts: receipts.rows };
}

test('the final representable transition succeeds and fresh use, remove and clear at the terminal head conflict without effects', async () => {
  const { client, id } = await viewer();
  const firstEntry = { kind: 'query' as const, text: `kept ${randomUUID()}` };
  const seeded = await use(client, firstEntry, 0);
  expect(seeded.status).toBe(200);
  await pool.query('UPDATE search.recent_search_state SET revision=$2 WHERE account_id=$1', [id, 2147483645]);
  const acceptedHeaders = headers();
  const terminalEntry = { kind: 'query' as const, text: `terminal ${randomUUID()}` };
  const accepted = await client.recentSearches.post(
    { entry: terminalEntry, expectedRevision: 2147483645 },
    { headers: acceptedHeaders },
  );
  expect(accepted.status).toBe(200);
  expect(accepted.data?.revision).toBe(2147483646);
  const replay = await client.recentSearches.post(
    { entry: terminalEntry, expectedRevision: 2147483645 },
    { headers: acceptedHeaders },
  );
  expect(replay.status).toBe(200);
  expect(replay.data).toEqual(accepted.data);
  const history = await client.recentSearches.get();
  expect(history.status).toBe(200);
  expect(history.data?.revision).toBe(2147483646);
  expect(history.data?.recentSearches.map((row) => row.entry)).toEqual([terminalEntry, firstEntry]);
  expect(history.data?.recentSearches[0]?.revision).toBe(2147483646);
  const before = await effects(id);
  expect(Number(before.state[0]?.revision)).toBe(2147483646);
  expect((await use(client, { kind: 'query', text: 'fresh use' }, 2147483646)).status).toBe(409);
  expect(await effects(id)).toEqual(before);
  expect((await remove(client, accepted.data!.id!, 2147483646)).status).toBe(409);
  expect(await effects(id)).toEqual(before);
  expect(
    (await client.recentSearches.$clear.post({ expectedRevision: 2147483646 }, { headers: headers() })).status,
  ).toBe(409);
  expect(await effects(id)).toEqual(before);
  expect((await client.recentSearches.get()).data).toEqual(history.data);
});
