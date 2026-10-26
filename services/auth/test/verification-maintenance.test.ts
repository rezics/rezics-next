import { trustedAccessPorts } from './support/trusted-access.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';
import { exportJWK, generateKeyPair } from 'jose';
import { testDatabase, migrate, schemaDump } from '../scripts/database.ts';
import { betterAuthOptions } from '../src/better-auth.ts';
import { createAuthService, type AuthService } from '../src/index.ts';

const issuer = 'https://verification.auth.test';
const secret = 'verification-test-secret-with-at-least-32-bytes';
let fixture: ReturnType<typeof testDatabase>;
let pool: Pool;
let secondPool: Pool;
let native: ReturnType<typeof betterAuth>;
let second: ReturnType<typeof betterAuth>;
let service: AuthService;
let secondService: AuthService;
let context: Awaited<ReturnType<typeof betterAuth>['$context']>;
const delivered: string[] = [];
const password = 'original password for verification';
let raceBarrier: (() => Promise<void>) | undefined;

beforeAll(async () => {
  fixture = testDatabase();
  pool = new Pool({ connectionString: fixture.url });
  secondPool = new Pool({ connectionString: fixture.url });
  const options: BetterAuthOptions = {
    ...betterAuthOptions(pool, issuer, secret),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      revokeSessionsOnPasswordReset: true,
      async sendResetPassword({ token }: { token: string }) {
        delivered.push(token);
      },
    },
    databaseHooks: {
      verification: {
        delete: {
          async before(verification) {
            if (verification.identifier === 'reset-password:race') await raceBarrier?.();
          },
        },
      },
    },
  };
  native = betterAuth(options);
  second = betterAuth<BetterAuthOptions>({ ...options, database: secondPool });
  context = await native.$context;
  await second.$context;
  for (const id of ['owner', 'other']) {
    await context.internalAdapter.createUser(
      { id, name: '', email: `${id}@example.test`, emailVerified: false },
      { method: 'email-password' },
    );
    await context.internalAdapter.createAccount({
      userId: id,
      accountId: id,
      providerId: 'credential',
      password: await context.password.hash(password),
    });
  }
  const keys = await generateKeyPair('ES256', { extractable: true });
  const key = { ...(await exportJWK(keys.privateKey)), kid: 'verification-test', alg: 'ES256' };
  const serviceOptions = {
    database: pool,
    issuer,
    audience: 'https://verification.api.test',
    secret,
    signing: { activeKid: key.kid, privateKeys: [key] },
    trustedAccess: trustedAccessPorts({
      async readFencedAccount() {
        return null;
      },
      async readAccount() {
        return null;
      },
      async authorizeProvisioning() {
        throw new Error('unused');
      },
    }),
  };
  service = await createAuthService(serviceOptions);
  secondService = await createAuthService({ ...serviceOptions, database: secondPool });
}, 60000);
afterAll(async () => {
  await Promise.all([pool?.end(), secondPool?.end()]);
  fixture?.close();
}, 60000);

async function row(
  id: string,
  identifier: string,
  value = 'owner',
  createdAt = new Date(),
  expiresAt = new Date(Date.now() + 600000),
) {
  await pool.query('INSERT INTO verification (id,identifier,value,"createdAt","expiresAt") VALUES ($1,$2,$3,$4,$5)', [
    id,
    identifier,
    value,
    createdAt,
    expiresAt,
  ]);
}
async function reset(token: string, target = native) {
  try {
    return await target.api.resetPassword({ body: { token, newPassword: 'replacement password for verification' } });
  } catch {
    return null;
  }
}
async function passwordHash(id: string) {
  return (await context.internalAdapter.findCredentialAccount(id))!.password;
}

test('native recovery delivery keeps tokens secret and preserves owner, wrong-token, expiry and one-use outcomes', async () => {
  const before = await passwordHash('owner');
  const other = await passwordHash('other');
  const response = await native.api.requestPasswordReset({ body: { email: 'owner@example.test' } });
  await pool.query("INSERT INTO auth_client VALUES ('verification-test',true,ARRAY['read'])");
  await pool.query(`INSERT INTO session
    (id,token,"userId","expiresAt","updatedAt","clientId","grantedScope","authnEpoch","authTime","authMethods")
    SELECT 'session-'||id,'secret-session-'||id,id,now()+interval '1 day',now(),'verification-test','read',1,1,'pwd'
    FROM "user" WHERE id IN ('owner','other')`);
  const token = delivered.at(-1)!;
  expect(token.length).toBeGreaterThan(20);
  expect(JSON.stringify(response)).not.toContain(token);
  expect(await reset(`${token}-wrong`)).toBeNull();
  expect(await passwordHash('owner')).toBe(before);
  expect(await reset(token)).toEqual({ status: true });
  expect(await reset(token)).toBeNull();
  expect(await passwordHash('other')).toBe(other);
  expect((await pool.query('SELECT "userId" FROM session')).rows).toEqual([{ userId: 'other' }]);
  await row('expired', 'reset-password:expired', 'owner', new Date(), new Date(Date.now() - 60000));
  const current = await passwordHash('owner');
  expect(await reset('expired')).toBeNull();
  expect(await passwordHash('owner')).toBe(current);
});

test('duplicate identifiers select the latest valid native record and consume all history exactly once', async () => {
  await row('history-old', 'reset-password:history', 'other', new Date(Date.now() - 100000));
  await row('history-new', 'reset-password:history');
  expect((await context.internalAdapter.findVerificationValue('reset-password:history'))?.id).toBe('history-new');
  const other = await passwordHash('other');
  expect(await reset('history')).toEqual({ status: true });
  expect(await passwordHash('other')).toBe(other);
  expect((await pool.query("SELECT id FROM verification WHERE identifier='reset-password:history'")).rows).toEqual([]);
  expect(await reset('history')).toBeNull();
});

test('equal createdAt uses descending native id for deterministic lookup and consume', async () => {
  const tie = new Date();
  // Insert the losing record first to expose heap-order ties.
  await row('tie-a', 'reset-password:tie', 'other', tie);
  await row('tie-z', 'reset-password:tie', 'owner', tie);
  expect((await context.internalAdapter.findVerificationValue('reset-password:tie'))?.id).toBe('tie-z');
  expect((await context.internalAdapter.consumeVerificationValue('reset-password:tie'))?.id).toBe('tie-z');
  expect(await context.internalAdapter.consumeVerificationValue('reset-password:tie')).toBeNull();
});

test('an expired latest record never falls back to older valid history', async () => {
  await row('valid-old', 'reset-password:expired-latest', 'owner', new Date(Date.now() - 100000));
  await row('invalid-new', 'reset-password:expired-latest', 'other', new Date(), new Date(Date.now() - 10000));
  const before = await passwordHash('owner');
  expect(await reset('expired-latest')).toBeNull();
  expect(await passwordHash('owner')).toBe(before);
});

test('two real native instances admit only one recovery consumer', async () => {
  await row('race', 'reset-password:race');
  let arrivals = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  raceBarrier = async () => {
    if (++arrivals === 2) release();
    await gate;
  };
  try {
    const results = await Promise.all([reset('race', native), reset('race', second)]);
    expect(arrivals).toBe(2);
    expect(results.filter(Boolean)).toHaveLength(1);
  } finally {
    raceBarrier = undefined;
  }
  expect(await reset('race', second)).toBeNull();
});

test('native recovery rolls consumption back when the password update fails', async () => {
  await row('rollback', 'reset-password:rollback');
  const before = await passwordHash('owner');
  await pool.query(`CREATE FUNCTION reject_test_password() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'test password failure'; END $$;
    CREATE TRIGGER reject_test_password BEFORE UPDATE OF password ON account
    FOR EACH ROW EXECUTE FUNCTION reject_test_password()`);
  try {
    expect(await reset('rollback')).toBeNull();
    expect(await passwordHash('owner')).toBe(before);
    expect((await context.internalAdapter.findVerificationValue('reset-password:rollback'))?.id).toBe('rollback');
  } finally {
    await pool.query('DROP TRIGGER reject_test_password ON account; DROP FUNCTION reject_test_password()');
  }
  expect(await reset('rollback')).toEqual({ status: true });
});

async function expired(count: number) {
  await pool.query('TRUNCATE verification');
  await pool.query(
    `INSERT INTO verification (id,identifier,value,"expiresAt")
    SELECT 'expired-'||lpad(i::text,5,'0'), 'batch-'||i, 'owner', now()-interval '1 hour'
    FROM generate_series(1,$1::integer) i`,
    [count],
  );
  await row('live', 'live');
}

test('native lookup never runs request-time expiry cleanup', async () => {
  await expired(1001);
  await context.internalAdapter.findVerificationValue('live');
  expect(Number((await pool.query('SELECT count(*) FROM verification')).rows[0].count)).toBe(1002);
});

test('one internal maintenance invocation removes exactly 1000 of 1000 or 1001 expired rows', async () => {
  for (const size of [1000, 1001]) {
    await expired(size);
    expect(await service.internal.pruneExpiredVerifications()).toBe(1000);
    expect((await pool.query('SELECT id FROM verification ORDER BY id')).rows.map((r) => r.id)).toEqual(
      size === 1000 ? ['live'] : ['expired-01001', 'live'],
    );
  }
});

test('cleanup skips locked expiry keys, preserves live rows and supports concurrent instances', async () => {
  await expired(1001);
  const lock = await pool.connect();
  try {
    await lock.query('BEGIN');
    await lock.query("SELECT id FROM verification WHERE id='expired-00001' FOR UPDATE");
    expect(await service.internal.pruneExpiredVerifications()).toBe(1000);
    expect((await pool.query('SELECT id FROM verification ORDER BY id')).rows.map((r) => r.id)).toEqual([
      'expired-00001',
      'live',
    ]);
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
  }
  await expired(2501);
  const counts = await Promise.all([
    service.internal.pruneExpiredVerifications(),
    secondService.internal.pruneExpiredVerifications(),
  ]);
  expect(counts).toEqual([1000, 1000]);
  expect(Number((await pool.query('SELECT count(*) FROM verification')).rows[0].count)).toBe(502);
});

test('fresh migrations and generated schema include the native verification indexes', async () => {
  migrate(fixture.url);
  expect(schemaDump(fixture.url, fixture)).toBe(await Bun.file(new URL('../db/schema.sql', import.meta.url)).text());
  const result = await pool.query("SELECT indexname,indexdef FROM pg_indexes WHERE tablename='verification'");
  expect(result.rows.some((r) => /\("expiresAt", id\)/.test(r.indexdef))).toBe(true);
  expect(result.rows.some((r) => /\(identifier, "createdAt" DESC, id DESC\)/.test(r.indexdef))).toBe(true);
  const plan = await getMigrations(betterAuthOptions(pool, issuer, secret));
  expect([plan.toBeCreated, plan.toBeAdded, plan.toBeAddedIndexes, plan.unsafeChanges, plan.schemaProblems]).toEqual([
    [],
    [],
    [],
    [],
    [],
  ]);
  const migration = await Bun.file(
    new URL('../db/migrations/20261025102531_verification_maintenance.sql', import.meta.url),
  ).text();
  const [up, down] = migration.split('-- migrate:down');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(down!);
    expect(
      (
        await client.query(
          "SELECT indexname FROM pg_indexes WHERE indexname IN ('verification_expiry_idx','verification_latest_idx')",
        )
      ).rows,
    ).toEqual([]);
    await client.query(up!);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
