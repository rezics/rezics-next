import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  createAuthHost,
  createBarrierProofVerifier,
  createNativeWorkflowProofPorts,
  createProvisioningEvidenceVerifier,
  type AuthService,
} from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
import type { Pool } from 'pg';
import { testDatabase } from '../../../auth/scripts/database.ts';
import { createNativeAccountBindings } from '../../src/access/native-account-bindings.ts';
import { createAccess } from '../../src/access/index.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

let db: GrowthDatabase;
let fixture: ReturnType<typeof testDatabase>;
let host: Awaited<ReturnType<typeof createAuthHost>>;
let service: AuthService;
let bindings: ReturnType<typeof createNativeAccountBindings>;
let accountId: string;
let authDatabase: Pool;
let token = '';
let serial = 0;
const issuer = 'https://growth-recovery.auth.test';
const password = 'native growth recovery password';
const request = (path: string, body: unknown) =>
  service.handler(
    new Request(issuer + path, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
async function recover() {
  await bindings.internalLifecycle.raiseFence({ accountId, key: `growth-fence-${serial++}` });
  expect((await request('/recovery/start', { email: 'human@growth.test' })).status).toBe(200);
  const body = { account_id: accountId, token, new_password: password };
  expect((await request('/recovery/complete', body)).status).toBe(200);
  // Exact success replay includes real Auth/current-credential resolution and
  // native authorization before receipt disclosure in the same capture.
  expect((await request('/recovery/complete', body)).status).toBe(200);
}
async function unrelated(index: number) {
  const name = `growth_recovery_other_${index}`;
  await host.workflows.register({ key: name, handle: name, email: `${name}@growth.test`, password });
}
beforeAll(async () => {
  db = await openGrowthDatabase();
  fixture = testDatabase();
  const database = db.openPool();
  authDatabase = database;
  const system = db.openPool();
  database.options.connectionString = fixture.url;
  system.options.connectionString = fixture.url;
  // The growth harness also owns these pools. Host shutdown may close them first.
  for (const pool of [database, system]) {
    const end = pool.end.bind(pool);
    let ended: Promise<void> | undefined;
    pool.end = (() => (ended ??= end())) as typeof pool.end;
  }
  const actions = new Map(['account:manage', 'access:grant'].map((action) => [action, { anonymous: false }]));
  const access = createAccess({ actions });
  bindings = createNativeAccountBindings({
    pool: db.pool,
    access,
    actions,
    routeKey: new Uint8Array(32).fill(81),
    referenceKeys: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(82)]]) },
    auth: () => service,
    proofs: {
      workflow: createNativeWorkflowProofPorts({ database }),
      provisioning: createProvisioningEvidenceVerifier({ database }),
      barriers: createBarrierProofVerifier({ database }),
    },
  });
  const key = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'growth-recovery',
  };
  host = await createAuthHost({
    database,
    systemDatabasePool: system,
    issuer,
    audience: 'https://growth.api.test',
    secret: 'native-growth-recovery-persistent-secret-32-bytes',
    signing: { activeKid: key.kid, privateKeys: [key] },
    stagingKey: new Uint8Array(32).fill(83),
    trustedAccess: bindings.trustedAccess,
    access: bindings.workflowPorts,
    recoveryDelivery: {
      async deliver(value) {
        token = value.token;
      },
    },
    maintenanceSchedule: '0 0 1 1 *',
  });
  service = host.service;
  await host.start();
  accountId = (
    await host.workflows.register({
      key: 'growth_recovery_human',
      handle: 'growth_recovery_human',
      email: 'human@growth.test',
      password,
    })
  ).accountId;
  // Real native history on the same owner and unrelated owners, beyond the
  // small-table scan crossover. None of these rows grants the measured effect.
  for (let i = 0; i < 256; i++) {
    await recover();
    await unrelated(i);
  }
}, 600000);
afterAll(async () => {
  await host?.stop();
  await db?.close();
  fixture?.close();
});

test('native completion growth independent of receipt history', async () => {
  const report = await checkGrowth(db, {
    name: 'native recovery completion with all Auth and Access queries',
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    // The native DBOS supervisor can overlap a capture with a bounded wake.
    slack: { statements: { absolute: 6, relative: 0 }, rows: { absolute: 6, relative: 0 } },
    repetitions: 3,
    warmups: 0,
    async grow(_db, scale, previous) {
      for (let i = previous * 4; i < scale * 4; i++) {
        await recover();
        await unrelated(256 + i);
      }
      for (const table of ['access.account', 'access.lifecycle_fence_receipt', 'core.receipt'])
        await db.admin.query(`VACUUM (ANALYZE) ${table}`);
      for (const table of [
        'auth_recovery',
        'auth_barrier_proof',
        'auth_recovery_establishment',
        'auth_effect_receipt',
        'account',
      ])
        await authDatabase.query(`VACUUM (ANALYZE) ${table}`);
    },
    async operation() {
      await recover();
    },
  });
  expect(report.samples.map((s) => s.scale)).toEqual([1, 8, 64]);
  for (const sample of report.samples) {
    for (const table of [
      'public.auth_recovery_establishment',
      'public.auth_barrier_proof',
      'public.auth_recovery',
      'public.auth_effect_receipt',
      'public.account',
      'access.account',
      'access.lifecycle_fence_receipt',
      'core.receipt',
    ])
      expect(sample.cost.relations?.[table]).toBeDefined();
  }
}, 600000);
