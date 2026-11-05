import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { createAuthService, createBarrierProofVerifier, type AuthService } from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
import { Client, Pool } from 'pg';
import { createAuthDatabase } from '../support/auth-database.ts';
import { createAuthBarrierCapabilities } from '../../src/access/auth-barriers.ts';
import { createRecoveryCompletion } from '../../src/access/recovery-completion.ts';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import { createLifecycleInternals } from '../../src/access/lifecycle.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

async function cloneAuthDatabase(): Promise<{ url: string; close(): Promise<void> }> {
  const name = `growth_auth_barr_auth_${Bun.randomUUIDv7().replaceAll('-', '')}`;
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

let db: GrowthDatabase;
let lifecycle: ReturnType<typeof createLifecycleInternals>;
let service: AuthService;
let fixture: Awaited<ReturnType<typeof cloneAuthDatabase>>;
let database: Pool;
let delivery = '';
let delivered: (() => void) | undefined;
let serial = 0;
const accountId = newId(914);
const issuer = 'https://growth-barriers.test';
const password = 'correct horse battery staple';
const request = (path: string, body: unknown) =>
  service.handler(
    new Request(`${issuer}${path}`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
async function account(id: string) {
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)`,
    [routeOf(id), id],
  );
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  lifecycle = createLifecycleInternals({
    pool: db.pool,
    routeKey: new Uint8Array(32),
    provisioningEvidence: async () => null,
    recoveryEvidence: async () => null,
  });
  fixture = await cloneAuthDatabase();
  database = new Pool({ connectionString: fixture.url });
  const barriers = createAuthBarrierCapabilities({ lifecycle, proofs: createBarrierProofVerifier({ database }) });
  const access = {
    ...createAuthBindings({ pool: db.pool }),
    ...barriers.trustedAccess,
    ...createRecoveryCompletion({ pool: db.pool, routeKey: new Uint8Array(32), auth: () => service }),
  };
  const key = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'growth',
  };
  const options = {
    database,
    issuer,
    audience: 'https://api.test',
    secret: 'native-barrier-secret-at-least-32-bytes',
    signing: { activeKid: key.kid, privateKeys: [key] },
    trustedAccess: access,
  };
  await account(accountId);
  const provisioningAccess = { ...access };
  delete provisioningAccess.readProvisioningAccount;
  const provision = await createAuthService({
    ...options,
    trustedAccess: {
      ...provisioningAccess,
      readAccount: async () => ({ accountId, kind: 'actor', state: 'pending', authnEpoch: 1, automated: false }),
      authorizeProvisioning: async () => ({ accountId }),
    },
  });
  await provision.internal.provisionPassword({
    authorization: 'provisioning-fixture',
    email: `${accountId}@example.test`,
    password,
  });
  service = await createAuthService({
    ...options,
    recoveryDelivery: {
      async deliver({ token }) {
        delivery = token;
        delivered?.();
      },
    },
  });
  await lifecycle.raiseFence({ accountId, key: 'initial' });
}, 60_000);
afterAll(async () => {
  await db?.close();
  await database?.end();
  await fixture?.close();
});

test('native Auth barriers stay bounded with same-account receipts and unrelated accounts at 1x 8x 64x', async () => {
  const report = await checkGrowth(db, {
    name: 'native Auth barriers',
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    repetitions: 3,
    warmups: 1,
    async grow(_db, scale, previous) {
      if (previous === 0) {
        for (let i = 0; i < 512; i++) {
          const other = newId(routeOf(accountId)!);
          await account(other);
          await lifecycle.raiseFence({ accountId: other, key: `baseline-other-${i}` });
        }
      }
      for (let i = previous * 4; i < scale * 4; i++) {
        await lifecycle.raiseFence({ accountId, key: `history-${i}` });
        const other = newId(routeOf(accountId)!);
        await account(other);
        await lifecycle.raiseFence({ accountId: other, key: `other-${i}` });
      }
      for (const table of ['access.account', 'access.lifecycle_fence_receipt', 'core.receipt'])
        await db.admin.query(`VACUUM (ANALYZE) ${table}`);
    },
    async operation() {
      // Each sample starts with a deliverable recovery. The mail cooldown is
      // independent operational state, covered by Auth's delivery tests.
      const mailKey = createHmac('sha256', 'native-barrier-secret-at-least-32-bytes')
        .update(JSON.stringify(['auth-recovery-mail-v1', accountId]))
        .digest('hex');
      await database.query('DELETE FROM auth_attempt_counter WHERE key=$1', [mailKey]);
      await lifecycle.raiseFence({ accountId, key: `operation-${serial++}` });
      const deliveryReady = new Promise<void>((resolve) => {
        delivered = resolve;
      });
      expect((await request('/recovery/start', { email: `${accountId}@example.test` })).status).toBe(200);
      await deliveryReady;
      expect(
        (await request('/recovery/complete', { account_id: accountId, token: delivery, new_password: password }))
          .status,
      ).toBe(200);
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
  for (const sample of report.samples) {
    // Initial fence write, recovery floor write, committed receipt read, Auth's receipt confirmation and
    // establishment-authorized fence-clear receipt validation each touch one row.
    expect(sample.cost.relations?.['access.lifecycle_fence_receipt']?.rows).toBe(5);
    expect(sample.cost.relations?.['access.account']?.rows).toBeGreaterThan(0);
  }
}, 60_000);
