import { trustedAccessPorts } from './support/trusted-access.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { exportJWK, generateKeyPair } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import { betterAuthOptions } from '../src/better-auth.ts';
import { createAuthService, type AuthService } from '../src/index.ts';
import {
  capture,
  checkGrowth,
  costOf,
  openGrowthDatabase,
  type GrowthDatabase,
} from '../../kernel/test/support/growth.ts';

let fixture: ReturnType<typeof testDatabase>;
let db: GrowthDatabase;
let context: Awaited<ReturnType<typeof betterAuth>['$context']>;
let service: AuthService;
const issuer = 'https://growth.verification.test';
const secret = 'growth-verification-secret-at-least-32-bytes';

beforeAll(async () => {
  fixture = testDatabase();
  db = await openGrowthDatabase(fixture.url);
  const options: BetterAuthOptions = betterAuthOptions(db.pool, issuer, secret);
  context = await betterAuth(options).$context;
  const keys = await generateKeyPair('ES256', { extractable: true });
  const key = { ...(await exportJWK(keys.privateKey)), kid: 'growth-verification', alg: 'ES256' };
  service = await createAuthService({
    database: db.pool,
    issuer,
    secret,
    audience: 'https://growth.api.test',
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
}, 60000);
afterAll(async () => {
  await db?.close();
  fixture?.close();
}, 60000);

// Both operations use this seed: unrelated rows, measured-identifier history and
// expired operational rows all grow together. No index/scan planner overrides.
async function grow(database: GrowthDatabase, scale: number, previous: number) {
  if (!previous) await database.admin.query('TRUNCATE verification');
  await database.admin.query(
    `INSERT INTO verification (id,identifier,value,"createdAt","expiresAt")
    SELECT 'history-'||i, 'measured', 'native-secret',
      timestamptz '2020-01-01' + i*interval '1 second', now()+interval '1 day'
    FROM generate_series($1::integer,$2::integer) i`,
    [previous * 1024 + 1, scale * 1024],
  );
  await database.admin.query(
    `INSERT INTO verification (id,identifier,value,"expiresAt")
    SELECT 'unrelated-'||i, 'unrelated-'||i, 'native-secret', now()+interval '1 day'
    FROM generate_series($1::integer,$2::integer) i`,
    [previous * 1024 + 1, scale * 1024],
  );
  await database.admin.query(
    `INSERT INTO verification (id,identifier,value,"expiresAt")
    SELECT 'expired-'||i, 'expired-'||i, 'native-secret', now()-interval '1 day'
    FROM generate_series($1::integer,$2::integer) i`,
    [previous * 8192 + 1, scale * 8192],
  );
  await database.admin.query('VACUUM (ANALYZE) verification');
}

function nodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object') return [];
  const object = value as Record<string, unknown>;
  return [...('Node Type' in object ? [object] : []), ...Object.values(object).flatMap(nodes)];
}

test('checkGrowth measures actual native latest queries at three scales of unrelated rows AND identifier history', async () => {
  const report = await checkGrowth(db, {
    name: 'native verification latest',
    grow,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    async operation(_database, scale) {
      const found = await context.internalAdapter.findVerificationValue('measured');
      expect(found?.id).toBe(`history-${scale * 1024}`);
    },
  });
  expect(report.samples.map((s) => s.scale)).toEqual([1, 8, 64]);
  for (const sample of report.samples) {
    expect(sample.cost.rows).toBe(1);
    expect(sample.cost.statements).toBe(1);
    expect(sample.cost.blocks).toBeLessThanOrEqual(16);
  }
  const actual = await capture(db, () => context.internalAdapter.findVerificationValue('measured'));
  expect(actual.capture.statements.every((sql) => /^select /i.test(sql) && /limit \$\d+/i.test(sql))).toBe(true);
  const plans = nodes(actual.capture.plans);
  expect(plans.some((n) => n['Node Type'] === 'Sort' || n['Node Type'] === 'Seq Scan')).toBe(false);
  expect(plans.filter((n) => n['Node Type'] === 'Limit').every((n) => n['Actual Rows'] === 1)).toBe(true);
  expect(plans.some((n) => n['Index Name'] === 'verification_latest_idx')).toBe(true);
  console.info('Native verification latest growth:', JSON.stringify(report.samples));
}, 120000);

test('checkGrowth measures one actual indexed expiry batch with fixed B=1000 at the same three scales', async () => {
  const report = await checkGrowth(db, {
    name: 'native verification expiry',
    grow,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    async operation() {
      expect(await service.internal.pruneExpiredVerifications()).toBe(1000);
    },
  });
  expect(report.samples.map((s) => s.scale)).toEqual([1, 8, 64]);
  for (const sample of report.samples) {
    expect(sample.cost.statements).toBe(1);
    // Candidate index visit, lock probe and deletion are all counted.
    expect(sample.cost.rows).toBeLessThanOrEqual(3000);
    expect(sample.cost.rows).toBeGreaterThanOrEqual(1000);
  }
  const actual = await capture(db, () => service.internal.pruneExpiredVerifications());
  const plans = nodes(actual.capture.plans);
  expect(plans.some((n) => n['Node Type'] === 'Sort' || n['Node Type'] === 'Seq Scan')).toBe(false);
  expect(plans.some((n) => n['Index Name'] === 'verification_expiry_idx')).toBe(true);
  expect(plans.find((n) => n['Node Type'] === 'Limit')?.['Actual Rows']).toBe(1000);
  expect((await db.admin.query("SELECT count(*) FROM verification WHERE identifier='measured'")).rows[0].count).toBe(
    '65536',
  );
  console.info('Native verification expiry growth:', JSON.stringify(report.samples));
  const lock = await db.admin.connect();
  try {
    await lock.query('BEGIN');
    await lock.query(`SELECT id FROM verification WHERE "expiresAt"<statement_timestamp()
      ORDER BY "expiresAt",id LIMIT 2001 FOR UPDATE`);
    const contended = await capture(db, () => service.internal.pruneExpiredVerifications());
    expect(contended.value).toBe(0);
    const cost = costOf(contended.capture);
    // Even a fully locked prefix cannot make SKIP LOCKED walk the table.
    expect(cost.rows).toBeLessThanOrEqual(4000);
    expect(cost.statements).toBe(1);
    expect(nodes(contended.capture.plans).some((n) => n['Node Type'] === 'Seq Scan')).toBe(false);
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
  }
}, 120000);
