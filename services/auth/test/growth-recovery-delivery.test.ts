import { trustedAccessPorts } from './support/trusted-access.ts';
import { expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import { runPlacedTests } from '../scripts/placed-tests.ts';
import { createAuthService, type AccessAccount } from '../src/index.ts';
import { withAuthTransport } from '../src/rate-limit.ts';
import { capture, checkGrowth, costOf, openGrowthDatabase } from '../../kernel/test/support/growth.ts';

// Native production admission is decided at module load; keep the actual limiter.
if (process.env.AUTH_DELIVERY_GROWTH_CHILD !== '1') {
  test('native failed recovery delivery stays bounded with same identifier and owner history', async () => {
    const child = await runPlacedTests(['bun', 'test', import.meta.path], {
      env: { ...process.env, NODE_ENV: 'production', AUTH_DELIVERY_GROWTH_CHILD: '1' },
      timeout: 180_000,
    });
    if (child.output) console.info(child.output);
    expect(child.code).toBe(0);
  }, 180000);
} else {
  test('checkGrowth captures full native failed recovery start at 1/8/64 with duplicate identifier and owner history', async () => {
    const fixture = testDatabase();
    const db = await openGrowthDatabase(fixture.url);
    try {
      const issuer = 'https://delivery.growth.test';
      const account: AccessAccount = {
        accountId: 'selected',
        kind: 'actor',
        state: 'pending',
        automated: false,
        authnEpoch: 7,
      };
      const key = {
        ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
        kid: 'delivery-growth',
      };
      await db.admin.query(`CREATE TABLE test_access (id text PRIMARY KEY, epoch integer NOT NULL);
        INSERT INTO test_access VALUES ('selected',7)`);
      let nativeId = '';
      let proofHash = '';
      let population = 0;
      let sourceCommitted = false;
      const service = await createAuthService({
        database: db.pool,
        issuer,
        audience: 'https://api.test',
        secret: 'persistent-growth-delivery-secret-32-bytes',
        signing: { activeKid: key.kid, privateKeys: [key] },
        trustedAccess: trustedAccessPorts({
          async readFencedAccount(id) {
            return (await this.readAccount(id)) ?? (await this.readRecoveryAccount!(id));
          },
          async readAccount(id) {
            const row = (await db.pool.query('SELECT epoch FROM test_access WHERE id=$1', [id])).rows[0];
            return row ? { ...account, accountId: id, authnEpoch: row.epoch } : null;
          },
          async readRecoveryAccount(id) {
            const row = (await db.pool.query('SELECT epoch FROM test_access WHERE id=$1', [id])).rows[0];
            return row ? { ...account, accountId: id, authnEpoch: row.epoch } : null;
          },
          authorizeProvisioning: async () => ({ accountId: account.accountId }),
          async authorizeRecovery() {
            throw new Error('Failed delivery cannot change Access');
          },
        }),
        recoveryDelivery: {
          async deliver(value) {
            proofHash = createHash('sha256').update(value.token).digest('hex');
            const native = (
              await db.admin.query(
                'SELECT id FROM verification WHERE identifier=$1 AND value=$2 ORDER BY "createdAt" DESC LIMIT 1',
                [`reset-password:${value.token}`, account.accountId],
              )
            ).rows[0];
            nativeId = native.id;
            expect(
              (await db.admin.query('SELECT account_id FROM auth_recovery WHERE proof_hash=$1', [proofHash])).rows[0]
                .account_id,
            ).toBe(account.accountId);
            // Fixture-only work on the uncaptured admin pool: the native random token
            // is known only at delivery. Attach pre-grown duplicates to that exact
            // identifier before failure, without substituting any provider code.
            await db.admin.query(
              `INSERT INTO verification (id,identifier,value,"createdAt","expiresAt")
              SELECT 'duplicate-'||i,$1,'selected',CASE WHEN i%2=0 THEN now()-interval '1 day' ELSE now()+interval '1 day' END,now()+interval '2 days'
              FROM generate_series(1,$2::int) i ON CONFLICT (id) DO UPDATE SET identifier=excluded.identifier`,
              [`reset-password:${value.token}`, population],
            );
            sourceCommitted = true;
            throw new Error('Mail sink unavailable');
          },
        },
      });
      await service.internal.provisionPassword({
        authorization: 'approved',
        email: 'selected@example.test',
        password: 'original sufficiently long password',
      });
      account.state = 'active';
      const before = (
        await db.admin.query('SELECT password,"updatedAt" FROM account WHERE "userId"=$1', [account.accountId])
      ).rows[0];
      const counterKey = createHmac('sha256', 'persistent-growth-delivery-secret-32-bytes')
        .update(JSON.stringify([issuer, '192.0.2.7|/request-password-reset']))
        .digest('hex');
      const mailKey = createHmac('sha256', 'persistent-growth-delivery-secret-32-bytes')
        .update(JSON.stringify(['auth-recovery-mail-v1', account.accountId]))
        .digest('hex');
      const operation = async () => {
        sourceCommitted = false;
        nativeId = '';
        proofHash = '';
        // Fix an admitted bucket state without changing native policy or its SQL.
        await db.admin.query(
          `UPDATE auth_attempt_counter SET last_request=now()-interval '1 day', count=1 WHERE key=$1`,
          [counterKey],
        );
        await db.admin.query('DELETE FROM auth_attempt_counter WHERE key=$1', [mailKey]);
        const response = await withAuthTransport('192.0.2.7', () =>
          service.handler(
            new Request(`${issuer}/recovery/start`, {
              method: 'POST',
              headers: { origin: issuer, 'content-type': 'application/json' },
              body: JSON.stringify({ email: 'selected@example.test' }),
            }),
          ),
        );
        expect(response.status).toBe(200);
        const deadline = Date.now() + 5_000;
        for (;;) {
          const cooled =
            sourceCommitted &&
            nativeId !== '' &&
            proofHash !== '' &&
            (await db.admin.query('SELECT id FROM verification WHERE id=$1', [nativeId])).rows.length === 0 &&
            (await db.admin.query('SELECT proof_hash FROM auth_recovery WHERE proof_hash=$1', [proofHash])).rows
              .length === 0 &&
            (await db.admin.query('SELECT 1 FROM auth_attempt_counter WHERE key=$1', [mailKey])).rows.length === 0;
          if (cooled) break;
          if (Date.now() >= deadline) break;
          await Bun.sleep(10);
        }
        expect(sourceCommitted).toBe(true);
        expect((await db.admin.query('SELECT id FROM verification WHERE id=$1', [nativeId])).rows).toHaveLength(0);
        expect(
          (await db.admin.query('SELECT proof_hash FROM auth_recovery WHERE proof_hash=$1', [proofHash])).rows,
        ).toHaveLength(0);
        expect((await db.admin.query('SELECT 1 FROM auth_attempt_counter WHERE key=$1', [mailKey])).rows).toHaveLength(
          0,
        );
      };
      const report = await checkGrowth(db, {
        name: 'full native recovery failed delivery',
        repetitions: 2,
        warmups: 1,
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        async grow(_, scale, previous) {
          population = scale * 500;
          const range = [previous * 500 + 1, population];
          await db.admin.query(
            `INSERT INTO "user" (id,name,email,"emailVerified") SELECT 'owner-'||i,'','owner-'||i||'@example.test',false FROM generate_series($1::int,$2::int) i`,
            range,
          );
          await db.admin.query(
            `INSERT INTO test_access SELECT 'owner-'||i,7 FROM generate_series($1::int,$2::int) i`,
            range,
          );
          await db.admin.query(
            `INSERT INTO account (id,"accountId","providerId","userId",password,"updatedAt") SELECT 'credential-'||i,'owner-'||i,'credential','owner-'||i,'unused',now() FROM generate_series($1::int,$2::int) i`,
            range,
          );
          await db.admin.query(
            `INSERT INTO auth_recovery (proof_hash,account_id,authn_epoch,expires_at)
            SELECT md5(kind||i),CASE WHEN kind='same' THEN 'selected' ELSE 'owner-'||i END,7,now()+interval '1 day'
            FROM generate_series($1::int,$2::int) i CROSS JOIN unnest(ARRAY['same','unrelated']) kind`,
            range,
          );
          await db.admin.query(
            `INSERT INTO verification (id,identifier,value,"createdAt","expiresAt")
            SELECT kind||i,kind||i,CASE WHEN kind='duplicate-' THEN 'selected' ELSE 'owner-'||i END,
              CASE WHEN i%2=0 THEN now()-interval '1 day' ELSE now()+interval '1 day' END,now()+interval '2 days'
            FROM generate_series($1::int,$2::int) i CROSS JOIN unnest(ARRAY['duplicate-','unrelated-']) kind`,
            range,
          );
          await db.admin.query(
            `INSERT INTO auth_attempt_counter SELECT encode(sha256(convert_to('peer-'||i,'UTF8')),'hex'),1,now(),true FROM generate_series($1::int,$2::int) i`,
            range,
          );
          for (const table of [
            '"user"',
            'account',
            'auth_recovery',
            'verification',
            'auth_attempt_counter',
            'test_access',
          ])
            await db.admin.query(`VACUUM (ANALYZE) ${table}`);
        },
        operation,
      });
      console.info('Recovery failed delivery Cost:', JSON.stringify(report.samples));
      expect(report.samples.map((sample) => sample.scale)).toEqual([1, 8, 64]);
      for (const { cost } of report.samples) {
        expect(cost.rows).toBeGreaterThan(0);
        expect(cost.rows).toBeLessThanOrEqual(30);
        expect(cost.statements).toBeGreaterThan(5);
        expect(cost.statements).toBeLessThanOrEqual(15);
        expect(cost.relations?.['public.auth_attempt_counter']?.rows).toBeGreaterThan(0);
        expect(Object.values(cost.relations ?? {}).every((relation) => relation.sequentialScans === 0)).toBe(true);
      }
      const actual = await capture(db, operation);
      const deletes = actual.capture.statements.filter((sql) => /^DELETE FROM /i.test(sql));
      expect(deletes).toHaveLength(3);
      expect(deletes.some((sql) => /DELETE FROM verification WHERE id=\$1/.test(sql))).toBe(true);
      expect(deletes.some((sql) => /DELETE FROM auth_recovery WHERE proof_hash=\$1/.test(sql))).toBe(true);
      expect(deletes.some((sql) => /DELETE FROM auth_attempt_counter WHERE key=\$1/.test(sql))).toBe(true);
      const plans = JSON.stringify(actual.capture.plans);
      // Email start resolves the owner through user_email_key. The credential,
      // proof and verification deletes remain primary-key seeks.
      for (const index of ['verification_pkey', 'auth_recovery_pkey', 'user_email_key']) {
        expect(plans.includes(`"Index Name":"${index}"`)).toBe(true);
      }
      expect(plans).toContain('"Conflict Arbiter Indexes":["auth_attempt_counter_pkey"]');
      expect(costOf(actual.capture).rows).toBeLessThanOrEqual(30);
      expect(
        (await db.admin.query(`SELECT count(*) FROM verification WHERE id LIKE 'duplicate-%'`)).rows[0].count,
      ).toBe('32000');
      expect((await db.admin.query('SELECT count(*) FROM auth_recovery')).rows[0].count).toBe('64000');
      expect(
        (await db.admin.query('SELECT password,"updatedAt" FROM account WHERE "userId"=$1', [account.accountId]))
          .rows[0],
      ).toEqual(before);
      expect(
        (await db.admin.query('SELECT epoch FROM test_access WHERE id=$1', [account.accountId])).rows[0].epoch,
      ).toBe(7);
    } finally {
      await db.close();
      fixture.close();
    }
  }, 180000);
}
