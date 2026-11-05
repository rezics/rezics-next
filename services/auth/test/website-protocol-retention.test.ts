import { trustedAccessPorts } from './support/trusted-access.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import { createAuthService, WEBSITE_CLIENT_ID, type AuthService } from '../src/index.ts';
import { capture, checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../../kernel/test/support/growth.ts';

let fixture: ReturnType<typeof testDatabase>;
let db: GrowthDatabase;
let service: AuthService;
const owner = 'retention-owner';
const batch = 100;
const kinds = [
  '"oauthAccessToken"',
  '"oauthRefreshToken"',
  '"oauthRefreshFamily"',
  '"oauthClientAssertion"',
  'auth_recent_oidc_session',
] as const;

beforeAll(async () => {
  // This file owns its migrated database; it never shares another suite's rows.
  fixture = testDatabase();
  db = await openGrowthDatabase(fixture.url);
  const keys = await generateKeyPair('ES256', { extractable: true });
  const key = { ...(await exportJWK(keys.privateKey)), kid: 'retention-signing', alg: 'ES256' };
  service = await createAuthService({
    database: db.pool,
    issuer: 'https://retention.auth.test',
    secret: 'retention-only-secret-with-at-least-32-bytes',
    audience: 'https://retention.api.test',
    signing: { activeKid: key.kid, privateKeys: [key] },
    trustedAccess: trustedAccessPorts({
      async readFencedAccount(id) {
        return this.readAccount(id);
      },
      async readAccount() {
        return null;
      },
      async authorizeProvisioning() {
        throw new Error('unused');
      },
    }),
  });
  await db.admin.query(`INSERT INTO "user" (id,name,"emailVerified") VALUES ($1,'',false)`, [owner]);
  await db.admin.query(`INSERT INTO auth_client (client_id,first_party,scopes) VALUES ($1,true,ARRAY['openid'])`, [
    WEBSITE_CLIENT_ID,
  ]);
}, 60000);

afterAll(async () => {
  await db?.close();
  fixture?.close();
}, 60000);

/** Seeds expired and live rows of every kind; `tag` keeps keys unique. */
async function seed(tag: string, from: number, to: number, expired: boolean) {
  const at = expired ? `now() - interval '1 day' - i * interval '1 second'` : `now() + interval '1 day'`;
  const range = [from, to];
  await db.admin.query(
    `INSERT INTO "oauthRefreshFamily" (id,"clientId",revoked,sequence,"expiresAt")
     SELECT $3||'-family-'||i,$4,i % 2 = 0,i,${at} FROM generate_series($1::int,$2::int) i`,
    [...range, tag, WEBSITE_CLIENT_ID],
  );
  await db.admin.query(
    `INSERT INTO "oauthRefreshToken" (id,token,"clientId","userId","authorizationCodeId","expiresAt","createdAt",scopes)
     SELECT $3||'-refresh-'||i,$3||'-refresh-hash-'||i,$4,$5,$3||'-family-'||i,${at},now(),'["openid"]'::jsonb
     FROM generate_series($1::int,$2::int) i`,
    [...range, tag, WEBSITE_CLIENT_ID, owner],
  );
  await db.admin.query(
    `INSERT INTO "oauthAccessToken" (id,token,"clientId","userId","refreshId","expiresAt","createdAt",scopes)
     SELECT $3||'-access-'||i,$3||'-access-hash-'||i,$4,$5,$3||'-refresh-'||i,${at},now(),'["openid"]'::jsonb
     FROM generate_series($1::int,$2::int) i`,
    [...range, tag, WEBSITE_CLIENT_ID, owner],
  );
  await db.admin.query(
    `INSERT INTO "oauthClientAssertion" (id,"expiresAt") SELECT $3||'-jti-'||i,${at} FROM generate_series($1::int,$2::int) i`,
    [...range, tag],
  );
  await db.admin.query(
    `INSERT INTO auth_recent_oidc_session (session_id,account_id,expires_at)
     SELECT $3||'-sid-'||i,$4,${at} FROM generate_series($1::int,$2::int) i`,
    [...range, tag, owner],
  );
}

async function counts(tag: string) {
  const result: Record<string, number> = {};
  for (const kind of kinds) {
    const key = kind === 'auth_recent_oidc_session' ? 'session_id' : 'id';
    result[kind] = Number(
      (await db.admin.query(`SELECT count(*) FROM ${kind} WHERE ${key} LIKE $1`, [`${tag}-%`])).rows[0].count,
    );
  }
  return result;
}

function nodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object') return [];
  const object = value as Record<string, unknown>;
  return [...('Node Type' in object ? [object] : []), ...Object.values(object).flatMap(nodes)];
}

test('one retention invocation removes at most one bounded batch of expired rows per kind and never live state', async () => {
  await seed('live', 1, 50, false);
  await seed('due', 1, batch + 20, true);
  expect(await service.internal.pruneExpiredProtocolState(batch)).toBe(kinds.length * batch);
  expect(await counts('due')).toEqual(Object.fromEntries(kinds.map((kind) => [kind, 20])));
  expect(await service.internal.pruneExpiredProtocolState(batch)).toBe(kinds.length * 20);
  expect(await service.internal.pruneExpiredProtocolState(batch)).toBe(0);
  // Unexpired families stay, including revoked ones: revocation is final until expiry.
  expect(await counts('live')).toEqual(Object.fromEntries(kinds.map((kind) => [kind, 50])));
  for (const invalid of [0, 1001, 1.5])
    await expect(service.internal.pruneExpiredProtocolState(invalid)).rejects.toThrow(RangeError);
  await db.admin
    .query(`DELETE FROM "oauthAccessToken"; DELETE FROM "oauthRefreshToken"; DELETE FROM "oauthRefreshFamily";
    DELETE FROM "oauthClientAssertion"; DELETE FROM auth_recent_oidc_session`);
}, 60000);

test('checkGrowth keeps one retention invocation constant in rows and statements as expired and live history grows', async () => {
  const report = await checkGrowth(db, {
    name: 'native protocol retention',
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 3,
    async grow(_database, scale, previous) {
      // Expired backlog and live history grow together; each run admits one batch.
      await seed('expired', previous * 1024 + 1, scale * 1024, true);
      await seed('current', previous * 1024 + 1, scale * 1024, false);
      for (const kind of kinds) await db.admin.query(`VACUUM (ANALYZE) ${kind}`);
    },
    async operation() {
      expect(await service.internal.pruneExpiredProtocolState(batch)).toBe(kinds.length * batch);
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([1, 8, 64]);
  for (const sample of report.samples) expect(sample.cost.statements).toBe(kinds.length);
  const actual = await capture(db, () => service.internal.pruneExpiredProtocolState(batch));
  const plans = nodes(actual.capture.plans);
  expect(plans.some((node) => node['Node Type'] === 'Seq Scan' || node['Node Type'] === 'Sort')).toBe(false);
  for (const index of [
    'oauth_access_expiry',
    'oauth_refresh_expiry',
    'oauthRefreshFamily_expiresAt_idx',
    'oauth_assertion_expiry',
    'auth_recent_oidc_expiry',
  ])
    expect(plans.some((node) => node['Index Name'] === index)).toBe(true);
  expect((await counts('current'))['"oauthRefreshToken"']).toBe(64 * 1024);
  console.info('Native protocol retention growth:', JSON.stringify(report.samples));
}, 180000);
