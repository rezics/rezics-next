import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import type { Access } from '../../src/request/access.ts';
import type { OrganizationSpeakersPage } from '../../src/access/organization-speakers.ts';

const pool = createPool(process.env.DATABASE_URL!);
const route = 0x4567;
const organization = newId(route);
const other = newId(route);
const reader = newId(route);
const otherReader = newId(route);
let now = new Date('2030-01-01T00:00:00Z');
const access: Access = {
  async authenticate(token) {
    return {
      kind: 'account',
      accountId: token === 'reader-2' ? otherReader : reader,
      clientId: 'test',
      scopes: [],
      requestedBy: null,
      authnEpoch: 1,
    };
  },
  async authorize() {
    return true;
  },
};
const kernel = createKernel({ pool, access, routeKey: new Uint8Array(32).fill(31), clock: () => now });
const speakers = [newId(0x1111), newId(0x2222), newId(0x3333)].sort();

async function account(id: string, kind = 'actor', state = 'active', fenced = false, listed = false) {
  await pool.query(
    `INSERT INTO access.account
    (route,account_id,kind,state,authn_fenced,speakers_listed,display_name,transaction_id)
    VALUES ($1,$2,$3,$4,$5,$6,'Public name',$2)`,
    [routeOf(id), id, kind, state, fenced, listed],
  );
}
async function assignment(actorId: string, principalId = organization, valid = '(,)') {
  const requestId = newId(route);
  await pool.query(
    `INSERT INTO access.principal_assignment
    (route,principal_id,request_id,assigned_actor_id,valid,transaction_id)
    VALUES ($1,$2,$3,$4,$5::tstzrange,$3)`,
    [routeOf(principalId), principalId, requestId, actorId, valid],
  );
  return requestId;
}
async function read(id = organization, query = '', authenticated: boolean | 'reader-2' = false) {
  const response = await kernel.handle(
    new Request(`https://kernel.test/v1/accounts/${id}/speakers${query}`, {
      headers: authenticated ? { authorization: `Bearer ${authenticated === 'reader-2' ? 'reader-2' : 'reader'}` } : {},
    }),
  );
  return { status: response.status, body: (await response.json()) as OrganizationSpeakersPage };
}

beforeAll(async () => {
  await account(organization, 'organization', 'active', false, true);
  await account(other, 'organization');
  await account(reader);
  await account(otherReader);
  for (const id of speakers) {
    await account(id);
    await assignment(id);
  }
  await assignment(speakers[0]!);
});
afterAll(async () => pool.end());

test('listed speakers are distinct current assignments and exactly the ids public identity items', async () => {
  const identities = await kernel.handle(new Request(`https://kernel.test/v1/accounts?ids=${speakers.join(',')}`));
  const expected = { status: 200, body: { speakers: (await identities.json()).accounts, next: null } };
  expect(await read()).toEqual(expected);
  expect(await read(organization, '', true)).toEqual(expected);
});

test('revoked, expired and future assignments, and inactive or fenced speakers are absent at the kernel clock', async () => {
  for (const state of ['pending', 'suspended', 'deleted']) {
    const id = newId(route);
    await account(id, 'actor', state);
    await assignment(id);
  }
  const fenced = newId(route);
  await account(fenced, 'actor', 'active', true);
  await assignment(fenced);
  const expired = newId(route);
  await account(expired);
  await assignment(expired, organization, '[2029-01-01,2030-01-01)');
  const future = newId(route);
  await account(future);
  await assignment(future, organization, '[2030-01-02,2030-01-03)');
  const revoked = newId(route);
  await account(revoked);
  const request = await assignment(revoked);
  await pool.query(
    `UPDATE access.principal_assignment SET revoked_at='2029-12-31',valid='(,2029-12-31)'
    WHERE route=$1 AND principal_id=$2 AND request_id=$3`,
    [route, organization, request],
  );
  expect((await read()).body.speakers.map(({ id }) => id)).toEqual(speakers);
  now = new Date('2030-01-02T00:00:00Z');
  expect((await read()).body.speakers.map(({ id }) => id)).toContain(future);
  now = new Date('2030-01-01T00:00:00Z');
});

test('unlisted, actor, unknown, fenced and deleted organization pages are empty for every caller', async () => {
  await assignment(speakers[0]!, other);
  const ids = [other, reader, newId(route), '00000000-0000-4000-8000-000000000000'];
  for (const [state, fenced] of [
    ['deleted', false],
    ['active', true],
    ['suspended', false],
  ] as const) {
    const id = newId(route);
    await account(id, 'organization', state, fenced, true);
    await assignment(speakers[0]!, id);
    ids.push(id);
  }
  for (const id of ids)
    for (const authenticated of [false, true])
      expect(await read(id, '', authenticated)).toEqual({ status: 200, body: { speakers: [], next: null } });
});

test('opaque keyset pages advance across filtered identities and bind the organization with a bounded limit', async () => {
  const found: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const result = await read(organization, `?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    expect(result.status).toBe(200);
    expect(result.body.speakers.length).toBeLessThanOrEqual(1);
    found.push(...result.body.speakers.map(({ id }) => id));
    cursor = result.body.next;
    if (cursor) expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(++pages).toBeLessThan(20);
  } while (cursor);
  expect(found).toEqual(speakers);
  const first = await read(organization, '?limit=1');
  const token = first.body.next!;
  expect((await read(organization, `?cursor=${speakers[0]}`)).status).toBe(400);
  expect((await read(organization, `?cursor=${token.slice(0, -1)}!`)).status).toBe(400);
  await pool.query('UPDATE access.account SET speakers_listed=true WHERE route=$1 AND account_id=$2', [route, other]);
  expect((await read(other, `?cursor=${token}`)).status).toBe(400);
  await pool.query('UPDATE access.account SET speakers_listed=false WHERE route=$1 AND account_id=$2', [route, other]);
  expect((await read(other, `?cursor=${token}`)).body).toEqual({ speakers: [], next: null });
  now = new Date(now.getTime() + 16 * 60_000);
  expect((await read(organization, `?cursor=${token}`)).status).toBe(400);
  now = new Date('2030-01-01T00:00:00Z');
  for (const limit of ['0', '101', '1.5', 'no']) expect((await read(organization, `?limit=${limit}`)).status).toBe(400);
  expect((await read(organization, '?limit=100')).status).toBe(200);
});

test('organization speakers cursors hide their after-key and bind the query and viewer', async () => {
  const anonymousFirst = await read(organization, '?limit=1');
  const anonymousCursor = anonymousFirst.body.next!;
  expect(anonymousFirst.status).toBe(200);
  expect(anonymousCursor).toEqual(expect.any(String));
  expect(anonymousCursor).not.toContain(speakers[0]!);
  expect(Buffer.from(anonymousCursor, 'base64url').toString('utf8')).not.toContain(speakers[0]!);
  expect((await read(organization, `?limit=1&cursor=${encodeURIComponent(anonymousCursor)}`, true)).status).toBe(400);

  const accountFirst = await read(organization, '?limit=1', true);
  const accountCursor = accountFirst.body.next!;
  expect(accountFirst.status).toBe(200);
  expect(accountCursor).toEqual(expect.any(String));
  expect(accountCursor).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(accountCursor).not.toContain(speakers[0]!);
  expect(Buffer.from(accountCursor, 'base64url').toString('utf8')).not.toContain(speakers[0]!);
  expect((await read(organization, `?limit=1&cursor=${encodeURIComponent(accountCursor)}`, 'reader-2')).status).toBe(
    400,
  );
  expect((await read(organization, `?limit=1&cursor=${encodeURIComponent(accountCursor)}`)).status).toBe(400);
  expect((await read(organization, `?limit=2&cursor=${encodeURIComponent(accountCursor)}`, true)).status).toBe(400);
});

test('the speakers route declares the public identity action and public exposure', () => {
  const route = kernel.routes.find(
    ({ method, path }) => method === 'GET' && path === '/v1/accounts/:accountId/speakers',
  );
  expect(route?.hooks.detail).toMatchObject({ 'x-exposure': 'public', 'x-action': 'account:read_public_identity' });
});
