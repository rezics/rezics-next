import { trustedAccessPorts } from './support/trusted-access.ts';
import { expect, test } from 'bun:test';
import { decodeJwt, exportJWK, generateKeyPair } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import { migrate as migrateKernel } from '../../kernel/scripts/database.ts';
import { newId, routeOf } from '../../kernel/src/route/route.ts';
import { createAuthService, type AccessAccount, type AuthService, type SessionProof } from '../src/index.ts';
import { capture, checkGrowth, openGrowthDatabase } from '../../kernel/test/support/growth.ts';

test('checkGrowth live proof signing uses constant native evidence at 1x/8x/64x; copies reject before I/O', async () => {
  const fixture = testDatabase();
  const db = await openGrowthDatabase(fixture.url);
  const issuer = 'https://growth-proof.auth.test';
  const humanId = newId(0x92a0);
  const robotId = newId(0x92b0);
  let service: AuthService;
  let operation: (proof: SessionProof) => Promise<void>;
  const completed = new Error('structural callback complete');
  try {
    migrateKernel(fixture.url);
    for (const [id, operator] of [
      [humanId, null],
      [robotId, humanId],
    ] as const)
      await db.admin.query(
        `INSERT INTO access.account(route,account_id,kind,state,operator_account_id,transaction_id)
        VALUES ($1,$2,'actor','pending',$3,$4)`,
        [routeOf(id), id, operator, newId(routeOf(id)!)],
      );
    const key = await generateKeyPair('ES256', { extractable: true });
    service = await createAuthService({
      database: db.pool,
      issuer,
      audience: 'https://growth-proof.api.test',
      secret: 'growth-proof-secret-at-least-32-bytes',
      signing: {
        activeKid: 'growth-proof',
        privateKeys: [{ ...(await exportJWK(key.privateKey)), kid: 'growth-proof' }],
      },
      trustedAccess: trustedAccessPorts({
        async readFencedAccount(id) {
          return this.readAccount(id);
        },
        async readAccount(id) {
          return (
            (
              await db.pool.query<AccessAccount>(
                `SELECT account_id::text AS "accountId",kind,state,
            minimum_authn_epoch::int AS "authnEpoch",authn_fenced AS fenced,(operator_account_id IS NOT NULL) AS automated
            FROM access.account WHERE route=$1 AND account_id=$2`,
                [routeOf(id), id],
              )
            ).rows[0] ?? null
          );
        },
        async authorizeProvisioning(accountId) {
          return { accountId };
        },
        async consumeAuthorization({ human }) {
          await operation(human);
          // This fixture measures the identity boundary, not later operator authorization.
          throw completed;
        },
      }),
    });
    await service.internal.registerClient({ clientId: 'growth-proof-web', firstParty: true, scopes: ['read'] });
    await service.internal.provisionPassword({
      authorization: humanId,
      email: 'human@growth-proof.test',
      password: 'correct horse battery staple',
    });
    await service.internal.provisionCredentialless({ authorization: robotId });
    await db.admin.query(`UPDATE access.account SET state='active'`);
    const response = await service.handler(
      new Request(`${issuer}/signin`, {
        method: 'POST',
        headers: { origin: issuer, 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'human@growth-proof.test',
          password: 'correct horse battery staple',
          client_id: 'growth-proof-web',
          scope: ['read'],
        }),
      }),
    );
    expect(response.status).toBe(200);
    const headers = new Headers({
      cookie: response.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; '),
    });
    // Fix the selected owner's neighborhood at the native cap, including expired history.
    await db.admin.query(
      `INSERT INTO session (id,token,"userId","clientId","expiresAt","updatedAt","grantedScope","authnEpoch","authTime","authMethods")
      SELECT 'own-history-'||i,'own-token-'||i,$1,'growth-proof-web','2000-01-01',now(),'read',1,1,'pwd' FROM generate_series(1,63) i`,
      [humanId],
    );
    operation = async (proof) => {
      const report = await checkGrowth(db, {
        name: 'live native proof token against unrelated accounts and session history',
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        repetitions: 3,
        async grow(_, scale, previous) {
          const ids = Array.from({ length: (scale - previous) * 1024 }, () => newId(0x92c0));
          await db.admin.query(
            `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
            SELECT $1,id::uuid,'actor','active',id::uuid FROM unnest($2::text[]) id`,
            [0x92c0, ids],
          );
          await db.admin.query(
            `INSERT INTO "user" (id,name,"emailVerified") SELECT id,'',false FROM unnest($1::text[]) id`,
            [ids],
          );
          await db.admin.query(
            `INSERT INTO session (id,token,"userId","clientId","expiresAt","updatedAt","grantedScope","authnEpoch","authTime","authMethods")
            SELECT id||'-'||j,id||'-token-'||j,id,'growth-proof-web',
            CASE WHEN j%2=0 THEN '2000-01-01'::timestamptz ELSE '2099-01-01'::timestamptz END,now(),'read',1,1,'pwd'
            FROM unnest($1::text[]) id CROSS JOIN generate_series(1,2) j`,
            [ids],
          );
          await db.admin.query('VACUUM ANALYZE session');
          await db.admin.query('ANALYZE "user"');
          await db.admin.query('ANALYZE access.account');
        },
        async operation() {
          const token = await service.internal.accessTokenForProof(proof);
          expect(decodeJwt(token).sub).toBe(humanId);
        },
      });
      expect(report.samples.map((s) => s.scale)).toEqual([1, 8, 64]);
      for (const { cost } of report.samples) {
        expect(cost.rows).toBeGreaterThan(0);
        expect(cost.rows).toBeLessThan(50);
        expect(cost.statements).toBeGreaterThan(0);
        expect(cost.relations?.['public.session']?.rows).toBe(1);
        expect(cost.relations?.['access.account']?.rows).toBe(1);
      }
      const rejected = await capture(db, async () => {
        await expect(service.internal.accessTokenForProof({ ...proof })).rejects.toThrow();
      });
      expect(rejected.capture.statements).toEqual([]);
      expect(rejected.capture.plans).toEqual([]);
      console.info('Live proof token growth:', JSON.stringify(report.samples));
    };
    await expect(
      service.internal.openAutomatedSession({ authorization: 'structural', subjectAccountId: robotId, headers }),
    ).rejects.toBe(completed);
  } finally {
    await db.close();
    fixture.close();
  }
}, 120000);
