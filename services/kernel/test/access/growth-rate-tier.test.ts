import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase } from '../support/growth.ts';
import { nativeFixture, scopes } from './native-account-bindings-fixture.ts';

let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let fixture: Awaited<ReturnType<typeof nativeFixture>>;
let kernel: ReturnType<typeof createKernel>;
let staff: Awaited<ReturnType<Awaited<ReturnType<typeof nativeFixture>>['person']>>;
let operator: Awaited<ReturnType<Awaited<ReturnType<typeof nativeFixture>>['person']>>;
let subject: Awaited<ReturnType<Awaited<ReturnType<typeof nativeFixture>>['automated']>>;
let spare: Awaited<ReturnType<Awaited<ReturnType<typeof nativeFixture>>['automated']>>;
const routeKey = new Uint8Array(32).fill(82);

async function setService(accountId: string) {
  const requestKey = `growth-rate-tier-${Bun.randomUUIDv7()}`;
  const response = await kernel.handle(
    new Request(`http://kernel.test/v1/accounts/${accountId}:setRateTier`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${staff.bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(requestKey),
      },
      body: JSON.stringify({ key: requestKey, tier: 'service' }),
    }),
  );
  if (response.status !== 200) throw new Error(`Rate tier change failed: ${response.status} ${await response.text()}`);
}

async function addPopulation(database: typeof db, route: number, operatorAccountId: string, count: number) {
  const unrelated = Array.from({ length: count }, () => newId(route));
  const operated = Array.from({ length: count }, () => ({ accountId: newId(route), reservationId: newId(route) }));
  if (unrelated.length) {
    await database.admin.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete)
       SELECT $1,id,'actor','active',id,true FROM unnest($2::uuid[]) id`,
      [route, unrelated],
    );
  }
  if (operated.length) {
    await database.admin.query(
      `INSERT INTO access.account
        (route,account_id,kind,state,operator_account_id,operator_reservation_id,transaction_id,membership_inverse_complete)
       SELECT $1,i.account_id,'actor','active',$2,i.reservation_id,i.account_id,true
       FROM unnest($3::uuid[],$4::uuid[]) AS i(account_id,reservation_id)`,
      [
        route,
        operatorAccountId,
        operated.map(({ accountId }) => accountId),
        operated.map(({ reservationId }) => reservationId),
      ],
    );
    await database.admin.query(
      `INSERT INTO access.operator_relation_slot
        (route,subject_account_id,reservation_id,operator_account_id,terminal,transaction_id)
       SELECT $1,i.account_id,i.reservation_id,$2,false,i.account_id
       FROM unnest($3::uuid[],$4::uuid[]) AS i(account_id,reservation_id)`,
      [
        route,
        operatorAccountId,
        operated.map(({ accountId }) => accountId),
        operated.map(({ reservationId }) => reservationId),
      ],
    );
  }
}

beforeAll(async () => {
  if (!scopes.includes('account:set_rate_tier')) scopes.push('account:set_rate_tier');
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  fixture = await nativeFixture(db.pool);
  kernel = createKernel({
    pool: db.pool,
    routeKey,
    tokens: fixture.referenceKeys,
    access: () => fixture.access,
    writeRate: createWriteRateLimiter({
      secret: 'growth-rate-tier-write-rate-secret-32bytes',
      overrides: JSON.stringify({ 'new-account': { write: { maximum: 100000, seconds: 86400 } } }),
    }),
  });
  staff = await fixture.person(`rate-tier-growth-staff-${Bun.randomUUIDv7()}`);
  operator = await fixture.person(`rate-tier-growth-operator-${Bun.randomUUIDv7()}`);
  const bootstrap = Bun.spawn(
    [process.execPath, `${import.meta.dir}/../../scripts/bootstrap-governance.ts`, '--account', staff.accountId],
    { env: { ...process.env, DATABASE_URL: db.url }, stdout: 'pipe', stderr: 'pipe' },
  );
  const exitCode = await bootstrap.exited;
  if (exitCode !== 0)
    throw new Error(
      `Governance bootstrap failed: ${await new Response(bootstrap.stdout).text()}\n${await new Response(bootstrap.stderr).text()}`,
    );
  subject = await fixture.automated(`rate-tier-growth-subject-${Bun.randomUUIDv7()}`, operator);
}, 120000);

afterAll(async () => {
  try {
    await fixture?.close();
  } finally {
    await db?.close();
  }
});

test('rate tier stays bounded as unrelated accounts and operated accounts grow', async () => {
  const route = routeOf(subject.accountId)!;
  const report = await checkGrowth(db, {
    name: 'account rate tier',
    scales: [1, 8, 64],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      const target = 1024 + scale * 128;
      const prior = previous === 0 ? 0 : 1024 + previous * 128;
      await addPopulation(database, route, operator.accountId, target - prior);
      spare = await fixture.automated(`rate-tier-growth-spare-${scale}-${Bun.randomUUIDv7()}`, operator);
      await database.admin.query('VACUUM ANALYZE access.account');
      await database.admin.query('VACUUM ANALYZE access.operator_relation_slot');
    },
    warmup: () => setService(spare.accountId),
    operation: () => setService(subject.accountId),
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
  expect(new Set(report.samples.map(({ cost }) => cost.rows)).size).toBe(1);
  expect(new Set(report.samples.map(({ cost }) => cost.statements)).size).toBe(1);
}, 120000);
