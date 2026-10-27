import { trustedAccessPorts } from './support/trusted-access.ts';
import { expect, test } from 'bun:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import { createAuthService, type AuthServiceOptions } from '../src/index.ts';
import { createSigner } from '../src/signing.ts';
import { capture, checkGrowth, openGrowthDatabase } from '../../kernel/test/support/growth.ts';

function expectIndex(plans: readonly unknown[], expected: string): void {
  let found = false;
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const plan = node as Record<string, unknown>;
    if (typeof plan['Index Name'] === 'string' && plan['Index Name'].startsWith(expected)) found = true;
    if (typeof plan.Plan === 'object' && plan.Plan !== null) visit(plan.Plan);
    if (Array.isArray(plan.Plans)) for (const child of plan.Plans) visit(child);
  };
  for (const plan of plans) visit(plan);
  expect(found, `plan should use ${expected}`).toBe(true);
}

test('signing loading and refreshed JWKS stay bounded as retired history and unrelated Auth rows grow', async () => {
  const fixture = testDatabase();
  const db = await openGrowthDatabase(fixture.url);
  try {
    const key = {
      ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
      kid: 'growth-current',
    };
    const options: AuthServiceOptions = {
      database: db.pool,
      issuer: 'https://growth.auth.test',
      audience: 'https://api.growth.test',
      secret: 'growth-signing-test-secret-with-at-least-32-bytes',
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
    };
    const initial = await createAuthService(options);
    const hasArchive = (await db.admin.query("SELECT to_regclass('auth_signing_key_archive') AS name")).rows[0].name;
    if (hasArchive) {
      let state = await initial.internal.signing.status();
      state = await initial.internal.signing.stage({
        expectedGeneration: state.generation,
        key: { ...key, kid: 'growth-active' },
      });
      state = await initial.internal.signing.rotate({ expectedGeneration: state.generation, kid: 'growth-active' });
      await initial.internal.signing.stage({
        expectedGeneration: state.generation,
        key: { ...key, kid: 'growth-next' },
      });
    }
    // The same seed also reproduces the pre-upgrade unbounded loading failure.
    const historyTable = hasArchive ? 'auth_signing_key_archive' : 'auth_signing_key';
    const report = await checkGrowth(db, {
      name: 'Signing keys and JWKS stays within its bound as K grows',
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      repetitions: 3,
      async grow(_, scale, previous) {
        const range = [previous * 500 + 1, scale * 500];
        await db.admin.query(
          `INSERT INTO ${historyTable} (kid, private_jwk)
          SELECT 'history-'||n, $3::jsonb || jsonb_build_object('kid', 'history-'||n)
          FROM generate_series($1::integer,$2::integer) n`,
          [...range, key],
        );
        await db.admin.query(
          `INSERT INTO "user" (id,name,email,"emailVerified")
          SELECT 'owner-'||n,'','owner-'||n||'@growth.test',false FROM generate_series($1::integer,$2::integer) n`,
          range,
        );
        await db.admin.query(
          `INSERT INTO auth_client SELECT 'client-'||n,true,ARRAY['read']
          FROM generate_series($1::integer,$2::integer) n`,
          range,
        );
        await db.admin.query(
          `INSERT INTO session (id,token,"userId","updatedAt","expiresAt","clientId","grantedScope","authnEpoch","authTime","authMethods")
          SELECT 'session-'||n,'token-'||n,'owner-'||n,now(),now(),'client-'||n,'read',1,1,'pwd'
          FROM generate_series($1::integer,$2::integer) n`,
          range,
        );
        await db.admin.query(`ANALYZE ${historyTable}`);
        await db.admin.query('ANALYZE "user"');
        await db.admin.query('ANALYZE auth_client');
        await db.admin.query('ANALYZE session');
      },
      async operation() {
        // A fresh instance includes bootstrap, generation lookup and key import;
        // discovery then exercises a real refresh, never a cache hit alone.
        const service = await createAuthService({ ...options, signing: { activeKid: key.kid, privateKeys: [] } });
        // The live key table has three fixed slots; this injected archive lookup exercises growing retired history.
        await createSigner(db.pool, { activeKid: 'growth-active', privateKeys: [key] });
        const signer = await createSigner(db.pool, { activeKid: key.kid, privateKeys: [] });
        const now = Math.floor(Date.now() / 1000);
        const token = await signer.sign({
          iss: options.issuer,
          aud: options.audience,
          sub: 'person',
          client_id: 'web',
          scope: 'read',
          authn_epoch: 1,
          iat: now,
          exp: now + 300,
          auth_time: now,
          amr: ['pwd'],
        });
        const response = await service.handler(new Request(`${options.issuer}/.well-known/jwks.json`));
        expect(response.status).toBe(200);
        const jwks = await response.json();
        expect(jwks.keys.length).toBeLessThanOrEqual(3);
        await jwtVerify(token, createLocalJWKSet(jwks), {
          issuer: options.issuer,
          audience: options.audience,
          algorithms: ['ES256'],
        });
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([1, 8, 64]);
    for (const sample of report.samples) {
      expect(sample.cost.rows).toBeGreaterThan(0);
      expect(sample.cost.rows).toBeLessThanOrEqual(30);
      expect(sample.cost.statements).toBeGreaterThan(0);
    }
    const archiveLookup = await capture(db, async () => {
      await createSigner(db.pool, { activeKid: 'growth-active', privateKeys: [key] });
    });
    expectIndex(archiveLookup.capture.plans, 'auth_signing_key_archive_pkey');
    console.info('Signing growth:', JSON.stringify(report.samples));
  } finally {
    await db.close();
    fixture.close();
  }
}, 60_000);
