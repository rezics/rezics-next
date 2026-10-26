import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Client, Pool } from 'pg';
import { createAuthHost, type AuthService } from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
import { createAuthDatabase } from '../support/auth-database.ts';
import { createAccess } from '../../src/access/index.ts';
import { createLifecycleInternals } from '../../src/access/lifecycle.ts';
import { createRegistrationPorts } from '../support/registration-ports.ts';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import { createRegistrationProofBindings } from '../../src/access/registration-proof.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { capture, checkGrowth, openGrowthDatabase } from '../support/growth.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue } from '../../src/http/request.ts';

async function cloneAuthDatabase(): Promise<{ url: string; close(): Promise<void> }> {
  const name = `growth_reinstate_auth_${Bun.randomUUIDv7().replaceAll('-', '')}`;
  const url = await createAuthDatabase(process.env.DATABASE_URL!, name);
  return {
    url,
    async close() {
      const admin = new URL(process.env.DATABASE_URL!);
      admin.pathname = '/postgres';
      const owner = new Client({ connectionString: admin.toString() });
      await owner.connect();
      try {
        await owner.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await owner.end();
      }
    },
  };
}

const issuer = 'https://reinstatement-growth.auth.test';
const audience = 'https://reinstatement-growth.api.test';
const password = 'native grant routes registration password';
const routeKey = new Uint8Array(32).fill(71);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(72)]]) };
const factor = 24;
let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let authDatabase: Awaited<ReturnType<typeof cloneAuthDatabase>>;
let authPool: Pool;
let host: Awaited<ReturnType<typeof createAuthHost>>;
let service: AuthService;
let access: ReturnType<typeof createAccess>;
let kernel: ReturnType<typeof createKernel>;
let root: { accountId: string; bearer: string };
let scopes: string[];
let now = Date.now();
let seedPool: Pool;
let seedLifecycle: ReturnType<typeof createLifecycleInternals>;
const subjects: { accountId: string }[] = [];
let spare: { accountId: string };
let cursor = 0;

async function issue(email: string, scope = scopes) {
  const signed = await service.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, client_id: 'reinstatement-growth-client', scope }),
    }),
  );
  expect(signed.status).toBe(200);
  const cookie = signed.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const response = await service.handler(
    new Request(`${issuer}/token`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie },
      body: '{}',
    }),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}
async function person(name: string) {
  const result = await host.workflows.register({
    key: name,
    handle: name,
    email: `${name}@reinstatement-growth.test`,
    password,
  });
  return { accountId: result.accountId, bearer: await issue(`${name}@reinstatement-growth.test`) };
}
async function call(bearer: string, path: string, body: unknown, key = Bun.randomUUIDv7()) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(key),
      },
      body: JSON.stringify(body),
    }),
  );
  return { response, value: await response.json() };
}
async function suspend(accountId: string) {
  expect((await call(root.bearer, `/v1/accounts/${accountId}:suspend`, {})).response.status).toBe(200);
}
async function reinstate(accountId: string) {
  const result = await call(root.bearer, `/v1/accounts/${accountId}:reinstate`, {});
  expect(result.response.status).toBe(200);
  return result;
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  seedPool = new Pool({ connectionString: db.url, max: 8 });
  seedLifecycle = createLifecycleInternals({
    pool: seedPool,
    routeKey,
    provisioningEvidence: async () => null,
    recoveryEvidence: async () => null,
  });
  const limiter = createWriteRateLimiter({
    secret: 'reinstatement-growth-private-write-rate-secret-32b',
    overrides: JSON.stringify({
      'new-account': { write: { maximum: 100000, seconds: 86400 } },
      member: { write: { maximum: 100000, seconds: 86400 } },
    }),
  });
  kernel = createKernel({
    pool: db.pool,
    routeKey,
    tokens,
    clock: () => new Date(now),
    access: (config) => {
      expect([...config.actions]).toEqual([...actionCatalogue(kernel)]);
      return access;
    },
    writeRate: {
      async spend(...args) {
        return limiter.spend(...args);
      },
    },
  });
  const actions = actionCatalogue(kernel);
  scopes = [...actions.keys()].filter((action) => action !== 'media:complete');
  authDatabase = await cloneAuthDatabase();
  authPool = new Pool({ connectionString: authDatabase.url });
  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'reinstatement-growth',
  };
  access = createAccess({
    actions,
    auth: {
      issuer,
      audience,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async () => service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
    },
  });
  const registration = createRegistrationProofBindings({ pool: db.pool, referenceKeys: tokens });
  const { ports: registrationPorts } = createRegistrationPorts({
    pool: db.pool,
    authPool,
    routeKey,
    referenceKeys: tokens,
  });
  host = await createAuthHost({
    database: authPool,
    systemDatabasePool: authPool,
    issuer,
    audience,
    secret: 'reinstatement-growth-auth-persistent-secret-32bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: createAuthBindings({
      pool: db.pool,
      ...registration,
      verifyPendingIdentity: registration.verifyNativePendingIdentity,
    }),
    access: registrationPorts,
    stagingKey: new Uint8Array(32).fill(73),
    maintenanceSchedule: '0 0 1 1 *',
    executorId: 'reinstatement-growth-executor',
  });
  service = host.service;
  await service.internal.registerClient({ clientId: 'reinstatement-growth-client', firstParty: true, scopes });
  await host.start();
  root = await person('grant_root');
  const bootstrap = Bun.spawn(['bun', 'scripts/bootstrap-governance.ts', '--account', root.accountId], {
    env: { ...process.env, DATABASE_URL: db.url },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(await bootstrap.exited).toBe(0);
  spare = await person('spare_account');
  await suspend(spare.accountId);
  for (let i = 0; i < 15; i++) {
    const subject = await person(`subject_${i}`);
    await suspend(subject.accountId);
    subjects.push(subject);
  }
}, 180000);
afterAll(async () => {
  await host?.stop();
  await authDatabase?.close();
  await seedPool?.end();
  await db?.close();
});

test('reinstatement stays bounded as unrelated accounts and suspension history grow', async () => {
  const report = await checkGrowth(db, {
    name: 'account reinstatement',
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      now = Date.now();
      root.bearer = await issue('grant_root@reinstatement-growth.test');
      const spareState = (
        await database.admin.query('SELECT state FROM access.account WHERE account_id=$1', [spare.accountId])
      ).rows[0]!.state;
      if (spareState === 'active') await suspend(spare.accountId);
      const added = (scale - previous) * factor;
      for (const subject of [spare, ...subjects]) {
        await database.admin.query(
          `INSERT INTO access.lifecycle_fence_receipt(route,account_id,receipt_id,minimum_authn_epoch,kind,transaction_id)
           SELECT $1,$2,gen_random_uuid(),1,'fence',$3 FROM generate_series(1,$4)`,
          [routeOf(subject.accountId), subject.accountId, Bun.randomUUIDv7(), added],
        );
        for (const kind of ['access.account.suspend', 'access.account.reinstate']) {
          await database.admin.query(
            `INSERT INTO core.receipt(partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,position,transaction_id,response)
             SELECT $1,'account',$2,$3,gen_random_uuid()::text,$4,1,1,$5,'{}'::jsonb FROM generate_series(1,$6)`,
            [routeOf(subject.accountId)! >>> 4, root.accountId, kind, Buffer.alloc(32), Bun.randomUUIDv7(), added],
          );
        }
      }
      for (let start = previous * factor; start < scale * factor; start += 8) {
        await Promise.all(
          Array.from({ length: Math.min(8, scale * factor - start) }, async (_, offset) => {
            const i = start + offset;
            const accountId = newId((i * 17) % 65536);
            const handle = `noise_${i}`;
            const reserved = await seedLifecycle.reserveHandle({ accountId, handle, key: `noise-reserve-${i}` });
            await seedLifecycle.createPending({
              accountId,
              handle,
              reservationId: reserved.value.reservationId,
              key: `noise-create-${i}`,
            });
          }),
        );
      }
      for (const table of ['access.account', 'access.lifecycle_fence_receipt', 'core.receipt'])
        await database.admin.query(`VACUUM (ANALYZE) ${table}`);
      now = Date.now();
      root.bearer = await issue('grant_root@reinstatement-growth.test');
    },
    async warmup() {
      await reinstate(spare.accountId);
    },
    async operation() {
      const subject = subjects[cursor++];
      expect(subject).toBeDefined();
      await reinstate(subject!.accountId);
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
  expect(report.samples.every(({ cost }) => cost.rows > 0 && cost.blocks > 0 && cost.statements > 0)).toBe(true);
  await suspend(spare.accountId);
  const observed = await capture(db, () => reinstate(spare.accountId));
  for (const fragment of ['access.account', 'core.receipt', 'core.outbox'])
    expect(observed.capture.statements.some((sql) => sql.includes(fragment))).toBe(true);
  console.info(report.name, report.samples);
}, 600000);
