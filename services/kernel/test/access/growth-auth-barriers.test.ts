import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createAuthService, createBarrierProofVerifier, type AuthService } from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { testDatabase } from '../../../auth/scripts/database.ts';
import { createAuthBarrierCapabilities } from '../../src/access/auth-barriers.ts';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import { createLifecycleInternals } from '../../src/access/lifecycle.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

let db: GrowthDatabase;
let lifecycle: ReturnType<typeof createLifecycleInternals>;
let service: AuthService;
let fixture: ReturnType<typeof testDatabase>;
let database: Pool;
let delivery = '';
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
  fixture = testDatabase();
  database = new Pool({ connectionString: fixture.url });
  const barriers = createAuthBarrierCapabilities({ lifecycle, proofs: createBarrierProofVerifier({ database }) });
  const access = { ...createAuthBindings({ pool: db.pool }), ...barriers.trustedAccess };
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
      },
    },
  });
  await lifecycle.raiseFence({ accountId, key: 'initial' });
  for (let i = 0; i < 512; i++) {
    const other = newId(routeOf(accountId)!);
    await account(other);
    await lifecycle.raiseFence({ accountId: other, key: `baseline-other-${i}` });
  }
}, 60_000);
afterAll(async () => {
  await db?.close();
  await database?.end();
  fixture?.close();
});

test('native Auth barriers stay bounded with same-account receipts and unrelated accounts at 1x 8x 64x', async () => {
  const report = await checkGrowth(db, {
    name: 'native Auth barriers',
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    repetitions: 3,
    warmups: 1,
    async grow(_db, scale, previous) {
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
      expect((await request('/recovery/start', { email: `${accountId}@example.test` })).status).toBe(200);
      expect(
        (await request('/recovery/complete', { account_id: accountId, token: delivery, new_password: password }))
          .status,
      ).toBe(200);
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
  for (const sample of report.samples) {
    expect(sample.cost.relations?.['access.lifecycle_fence_receipt']?.rows).toBe(2);
    expect(sample.cost.relations?.['access.account']?.rows).toBeGreaterThan(0);
  }
}, 60_000);
