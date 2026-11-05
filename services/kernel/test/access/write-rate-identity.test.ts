import { suspendAccount } from '../support/native-suspension-driver.ts';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Pool, type QueryConfig } from 'pg';
import { AccessUnavailableError, createAccess } from '../../src/access/index.ts';
import { readPublicAccount } from '../../src/access/account-data.ts';
import { createWriteRateLimiter, WriteRateUnavailableError } from '../../src/access/write-rate.ts';
import { canonicalRateAddress, rateIdentity } from '../../src/access/write-rate-identity.ts';
import type { AccountActor } from '../../src/request/access.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new Pool({ connectionString: url });
const secret = 'private-deployment-secret-with-32-bytes';
const issuer = 'https://auth.example.test';
const audience = 'https://api.rezics.test';
const id = '00000000-0000-7000-8000-567800000001';
const operator = '00000000-0000-7000-8000-567800000002';
const route = 0x5678;
let access: ReturnType<typeof createAccess>;
let sign: (extra?: Record<string, unknown>) => Promise<string>;
const limiter = createWriteRateLimiter({ secret });
const context = () => ({ pool, deadline: Date.now() + 5000 });
async function account(tier = 'ordinary', age = 0, automated = false) {
  await pool.query('DELETE FROM access.account WHERE route=$1 AND account_id=$2', [route, id]);
  await pool.query(
    `INSERT INTO access.account (route, account_id, kind, state, rate_tier, created_at, operator_account_id, transaction_id)
    VALUES ($1, $2, 'actor', 'active', $3, statement_timestamp() - $4 * interval '1 day', $5, $2)`,
    [route, id, tier, age, automated ? operator : null],
  );
}
beforeAll(async () => {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'rate-key', alg: 'ES256' };
  access = createAccess({
    actions: new Map(),
    auth: {
      issuer,
      audience,
      jwksUrl: `${issuer}/jwks`,
      fetch: async () => new Response(JSON.stringify({ keys: [jwk] })),
    },
  });
  sign = (extra = {}) =>
    new SignJWT({
      client_id: 'import-service',
      scope: 'service trusted *',
      authn_epoch: 1,
      auth_time: Math.floor(Date.now() / 1000),
      amr: ['pwd'],
      ...extra,
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'rate-key', typ: 'at+jwt' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(id)
      .setIssuedAt()
      .setExpirationTime('3m')
      .sign(pair.privateKey);
});
beforeEach(() => pool.query('TRUNCATE access.write_rate_counter'));
afterAll(() => pool.end());

test('one verified anchored account read supplies age and private tier; OAuth clients and token claims confer no class', async () => {
  for (const [tier, age, automated, expected] of [
    ['ordinary', 0, false, 'new-account'],
    ['ordinary', 0, true, 'new-account'],
    ['ordinary', 8, false, 'member'],
    ['ordinary', 8, true, 'member'],
    ['trusted', 0, false, 'trusted'],
    ['service', 0, true, 'service'],
    ['service', 0, false, 'new-account'],
  ] as const) {
    await account(tier, age, automated);
    const calls: string[] = [];
    const source = Object.create(pool) as Pool;
    source.query = ((query: QueryConfig) => {
      calls.push(query.text);
      return pool.query(query);
    }) as Pool['query'];
    const received = { pool: source, deadline: Date.now() + 5000 };
    const actor = await access.authenticate(await sign({ rate_tier: 'service', accountClass: 'service' }), received);
    const identity = rateIdentity({ ...received, actor }, secret);
    expect(identity.rateClass).toBe(expected);
    expect(identity.route).toBe(route);
    expect(calls.filter((text) => /FROM access.account\b/.test(text))).toHaveLength(1);
    expect(calls.filter((text) => /FROM access\./.test(text))).toHaveLength(1);
    expect(Object.keys(actor).sort()).toEqual(['accountId', 'authnEpoch', 'clientId', 'kind', 'requestedBy', 'scopes']);
    const publicAccount = await readPublicAccount(pool, route, id);
    expect(publicAccount).not.toHaveProperty('createdAt');
    expect(publicAccount).not.toHaveProperty('rateTier');
  }
});

test('account class changes keep the same counter key and cannot reset a window', async () => {
  await account();
  const received = context();
  const actor = await access.authenticate(await sign(), received);
  expect((await limiter.spend({ ...received, actor }, 'write', 30)).allowed).toBe(true);
  await pool.query("UPDATE access.account SET rate_tier='trusted' WHERE route=$1 AND account_id=$2", [route, id]);
  const next = context();
  const trusted = await access.authenticate(await sign({ client_id: 'website' }), next);
  expect((await limiter.spend({ ...next, actor: trusted }, 'write', 100)).allowed).toBe(true);
  expect((await pool.query('SELECT route, count FROM access.write_rate_counter')).rows).toEqual([
    { route, count: 130 },
  ]);
  // An older token's verified class remains conservative, and still shares that key.
  expect((await limiter.spend({ ...received, actor }, 'write')).allowed).toBe(false);
});

test('forged, copied, cross-pool and expired actor evidence cannot spend', async () => {
  await account();
  const received = context();
  const actor = await access.authenticate(await sign(), received);
  const spoof: AccountActor = { ...actor };
  for (const attempt of [
    { ...received, actor: spoof },
    { ...received, actor, pool: Object.create(pool) as Pool },
    { ...received, actor, deadline: Date.now() - 1 },
  ])
    await expect(limiter.spend(attempt, 'write')).rejects.toBeInstanceOf(
      attempt.deadline < Date.now() ? AccessUnavailableError : WriteRateUnavailableError,
    );
  expect((await pool.query('SELECT * FROM access.write_rate_counter')).rows).toHaveLength(0);
  for (const update of ["state='suspended'", 'authn_fenced=true', 'minimum_authn_epoch=2']) {
    await account();
    if (update === "state='suspended'") await suspendAccount(pool, id);
    else await pool.query(`UPDATE access.account SET ${update} WHERE route=$1 AND account_id=$2`, [route, id]);
    await expect(access.authenticate(await sign(), context())).rejects.toThrow();
  }
});

test('creation time is immutable, finite, UTC, and private tiers are constrained', async () => {
  await account();
  const row = (
    await pool.query('SELECT created_at, rate_tier FROM access.account WHERE route=$1 AND account_id=$2', [route, id])
  ).rows[0];
  expect(row.created_at).toBeInstanceOf(Date);
  expect(row.rate_tier).toBe('ordinary');
  await expect(
    pool.query("UPDATE access.account SET created_at=created_at - interval '8 days' WHERE route=$1 AND account_id=$2", [
      route,
      id,
    ]),
  ).rejects.toMatchObject({ code: '23514' });
  await expect(
    pool.query("UPDATE access.account SET rate_tier='admin' WHERE route=$1 AND account_id=$2", [route, id]),
  ).rejects.toMatchObject({ code: '23514' });
});

test('canonical IP attribution collapses equivalent IPv6 and IPv4-mapped spellings', () => {
  expect(canonicalRateAddress('2001:db8:1:2:abcd::1')).toBe(canonicalRateAddress('2001:0db8:0001:0002::2'));
  expect(canonicalRateAddress('::ffff:192.0.2.1')).toBe('192.0.2.1');
  expect(canonicalRateAddress('::ffff:c000:201')).toBe('192.0.2.1');
  for (const invalid of [undefined, 'not-an-IP', '::1%eth0', '1.2.3.4, 5.6.7.8'])
    expect(canonicalRateAddress(invalid)).toBe('unknown');
});
