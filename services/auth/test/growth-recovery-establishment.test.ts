import { trustedAccessPorts } from './support/trusted-access.ts';
import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import { createAuthService, createBarrierProofVerifier, type AuthService } from '../src/index.ts';
import {
  capture,
  checkGrowth,
  costOf,
  openGrowthDatabase,
  type GrowthDatabase,
} from '../../kernel/test/support/growth.ts';

async function grow(db: GrowthDatabase, scale: number, previous: number) {
  const range = [previous * 1024 + 1, scale * 1024];
  await db.admin.query(
    `INSERT INTO "user" (id,name,"emailVerified") SELECT 'owner-'||i,'',false FROM generate_series($1::integer,$2::integer) i`,
    range,
  );
  await db.admin.query(
    `INSERT INTO test_access SELECT 'owner-'||i,1,'active' FROM generate_series($1::integer,$2::integer) i`,
    range,
  );
  await db.admin.query(
    `INSERT INTO account (id,"accountId","providerId","userId",password,"updatedAt")
    SELECT 'credential-'||i,'owner-'||i,'credential','owner-'||i,'old',now() FROM generate_series($1::integer,$2::integer) i`,
    range,
  );
  await db.admin.query(
    `INSERT INTO auth_recovery (proof_hash,account_id,authn_epoch,expires_at,consumed_operation,consumed_verification_id,consumed_at)
    SELECT md5(owner||i)||md5(owner||i),owner,1,now()+interval '1 day',encode(sha256(convert_to(owner||i,'UTF8')),'hex'),'spent-'||i,now()
    FROM generate_series($1::integer,$2::integer) i CROSS JOIN LATERAL (VALUES ('hot'),('owner-'||i)) owners(owner)`,
    range,
  );
  await db.admin.query(
    `INSERT INTO auth_barrier_proof(reference,account_id,purpose,previous_epoch,operation_key,digest,evidence,created_at,expires_at,applied_at)
    SELECT md5(owner||i)||md5(owner||i),owner,'recovery',1,encode(sha256(convert_to(owner||i,'UTF8')),'hex'),repeat('0',64),
      jsonb_build_array('recovery-v1',owner,1,md5(owner||i)||md5(owner||i),'spent-'||i,'historical-'||owner||i,repeat('0',64),'set-password',repeat('0',64)),
      now(),now()+interval '4 minutes',now()
    FROM generate_series($1::integer,$2::integer) i CROSS JOIN LATERAL (VALUES ('hot'),('owner-'||i)) owners(owner)`,
    range,
  );
  await db.admin.query(
    `INSERT INTO auth_effect_receipt
    SELECT 'effect-'||owner||i,owner,'recovery',2 FROM generate_series($1::integer,$2::integer) i
    CROSS JOIN LATERAL (VALUES ('hot'),('owner-'||i)) owners(owner)`,
    range,
  );
  await db.admin.query(
    `INSERT INTO auth_recovery_establishment
    SELECT md5(owner||i)||md5(owner||i),'effect-'||owner||i,owner,'historical-'||owner||i,repeat('0',64),repeat('0',64),'establishment-'||owner||i,2
    FROM generate_series($1::integer,$2::integer) i CROSS JOIN LATERAL (VALUES ('hot'),('owner-'||i)) owners(owner)`,
    range,
  );
  await db.admin.query(
    `INSERT INTO verification (id,identifier,value,"expiresAt")
    SELECT 'verification-'||i,'history-'||i,'hot',now()+interval '1 day' FROM generate_series($1::integer,$2::integer) i`,
    range,
  );
  for (const table of [
    '"user"',
    'account',
    'test_access',
    'auth_recovery',
    'auth_barrier_proof',
    'auth_effect_receipt',
    'auth_recovery_establishment',
    'verification',
  ])
    await db.admin.query(`VACUUM (ANALYZE) ${table}`);
}

async function seedCleanupSweepState(db: GrowthDatabase, scale: number) {
  await db.admin.query(
    `INSERT INTO auth_barrier_proof(reference,account_id,purpose,previous_epoch,operation_key,digest,evidence,created_at,expires_at)
    SELECT md5('cleanup-warmup-'||$1||'-'||i)||md5('cleanup-warmup-'||$1||'-'||i),'hot','recovery',1,'cleanup-warmup-'||$1||'-'||i,
      repeat('0',64),'[]',now()-interval '1 day 10 minutes',now()-interval '1 day 9 minutes'
    FROM generate_series(1,1000) i`,
    [scale],
  );
  await db.admin.query(
    `INSERT INTO auth_barrier_proof(reference,account_id,purpose,previous_epoch,operation_key,digest,evidence,created_at,expires_at)
    SELECT md5('cleanup-backlog-'||$1||'-'||i)||md5('cleanup-backlog-'||$1||'-'||i),'hot','recovery',1,'cleanup-backlog-'||$1||'-'||i,
      repeat('0',64),'[]',now()-interval '2 minutes',now()-interval '1 minute'
    FROM generate_series(1,2000) i`,
    [scale],
  );
}

for (const kind of ['complete', 'resolve', 'cleanup'] as const) {
  test(`native ${kind} remains bounded across same-account consumed history and unrelated owners`, async () => {
    const fixture = testDatabase();
    const db = await openGrowthDatabase(fixture.url);
    try {
      const issuer = 'https://growth.recovery.test';
      const password = 'sufficiently long native growth password';
      const secret = 'persistent-native-growth-recovery-secret';
      const tokens = new Map<string, string>();
      let reference = '';
      let service: AuthService;
      const authorized = new Map<string, { accountId: string; receiptId: string; minimumAuthnEpoch: number }>();
      const proofs = createBarrierProofVerifier({ database: db.pool });
      await db.admin.query(`CREATE TABLE test_access (id text PRIMARY KEY,epoch integer NOT NULL,state text NOT NULL);
      INSERT INTO test_access VALUES ('hot',7,'pending'),('warmup',7,'pending')`);
      const readAccount = async (accountId: string) => {
        const row = (await db.pool.query('SELECT epoch,state FROM test_access WHERE id=$1', [accountId])).rows[0];
        return row
          ? { accountId, kind: 'actor' as const, automated: false, state: row.state, authnEpoch: row.epoch }
          : null;
      };
      const key = {
        ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
        kid: 'growth',
      };
      service = await createAuthService({
        database: db.pool,
        issuer,
        audience: 'https://api.test',
        secret,
        signing: { activeKid: key.kid, privateKeys: [key] },
        trustedAccess: trustedAccessPorts({
          async readFencedAccount(id) {
            return (await this.readAccount(id)) ?? (await this.readRecoveryAccount!(id));
          },
          readAccount,
          readRecoveryAccount: readAccount,
          authorizeProvisioning: async (authorization) => ({
            accountId: authorization === 'approved-warmup' ? 'warmup' : 'hot',
          }),
          async authorizeRecovery(input) {
            reference = input.proofReference!;
            expect(
              await proofs.verify(reference, {
                accountId: input.accountId,
                purpose: 'recovery',
                previousEpoch: input.proofEpoch,
                operationKey: input.operationKey!,
              }),
            ).not.toBeNull();
            const row = (
              await db.pool.query('UPDATE test_access SET epoch=epoch+1 WHERE id=$1 AND epoch=$2 RETURNING epoch', [
                input.accountId,
                input.proofEpoch,
              ])
            ).rows[0];
            if (!row) throw new Error('Native floor CAS denied');
            const expected = {
              accountId: input.accountId,
              receiptId: input.operationKey!,
              minimumAuthnEpoch: row.epoch as number,
            };
            authorized.set(reference, expected);
            return expected;
          },
          async completeRecovery(proofReference) {
            const expected = authorized.get(proofReference);
            const witness = await service.internal.resolveRecoveryEstablishment(proofReference);
            const access = expected
              ? (await db.pool.query('SELECT epoch,state FROM test_access WHERE id=$1', [expected.accountId])).rows[0]
              : null;
            if (
              !expected ||
              !witness ||
              !access ||
              access.state !== 'active' ||
              witness.accountId !== expected.accountId ||
              witness.receiptId !== expected.receiptId ||
              witness.authnEpoch !== access.epoch ||
              witness.minimumAuthnEpoch !== String(expected.minimumAuthnEpoch) ||
              access.epoch !== expected.minimumAuthnEpoch
            )
              throw new Error('Recovery completion denied');
            authorized.delete(proofReference);
          },
        }),
        recoveryDelivery: {
          async deliver(value) {
            tokens.set(value.accountId, value.token);
          },
        },
      });
      const request = (path: string, body: unknown) =>
        service.handler(
          new Request(`${issuer}${path}`, {
            method: 'POST',
            headers: { origin: issuer, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
        );
      await service.internal.provisionPassword({ authorization: 'approved', email: 'hot@example.test', password });
      await service.internal.provisionPassword({
        authorization: 'approved-warmup',
        email: 'warmup@example.test',
        password,
      });
      await db.admin.query("UPDATE test_access SET state='active'");
      await service.internal.registerClient({ clientId: 'web', firstParty: true, scopes: ['read'] });
      const complete = (accountId: string) =>
        request('/recovery/complete', {
          account_id: accountId,
          token: tokens.get(accountId),
          new_password: password,
        });
      async function startRecovery(accountId: 'hot' | 'warmup') {
        const email = accountId === 'hot' ? 'hot@example.test' : 'warmup@example.test';
        const deliveryKey = createHmac('sha256', secret)
          .update(JSON.stringify(['auth-recovery-mail-v1', accountId]))
          .digest('hex');
        await db.admin.query('DELETE FROM auth_attempt_counter WHERE key=$1', [deliveryKey]);
        tokens.delete(accountId);
        expect((await request('/recovery/start', { email })).status).toBe(200);
        for (let attempt = 0; attempt < 500 && !tokens.has(accountId); attempt++) await Bun.sleep(10);
        expect(tokens.has(accountId)).toBe(true);
      }
      const report = await checkGrowth(db, {
        name: `native recovery establishment ${kind}`,
        repetitions: 1,
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        async grow(_, scale, previous) {
          await grow(db, scale, previous);
          if (kind === 'complete' && scale === 1) {
            // Keep the measured hot user's maximum 64-session set selective in
            // PostgreSQL's plan by giving the session index an unrelated cohort.
            await db.admin.query(
              `INSERT INTO session (id,token,"userId","expiresAt","clientId","grantedScope","authnEpoch","authTime","authMethods","updatedAt")
              SELECT 'unrelated-session-'||i,'unrelated-token-'||i,'owner-'||((i-1)%1024+1),now()+interval '1 day','web','read',1,1,'pwd',now()
              FROM generate_series(1,4096) i`,
            );
          }
          await startRecovery('hot');
          if (kind === 'complete') await startRecovery('warmup');
          // Exercise the real maximum stored session set, never an uncapped history.
          await db.admin.query('DELETE FROM session WHERE "userId"=ANY($1::text[])', [['hot', 'warmup']]);
          await db.admin.query(
            `INSERT INTO session (id,token,"userId","expiresAt","clientId","grantedScope","authnEpoch","authTime","authMethods","updatedAt")
          SELECT 'session-'||$1||'-'||i,'token-'||$1||'-'||i,'hot',now()+interval '1 day','web','read',7,1,'pwd',now() FROM generate_series(1,64) i`,
            [scale],
          );
          if (kind === 'complete') {
            await db.admin.query(
              `INSERT INTO session (id,token,"userId","expiresAt","clientId","grantedScope","authnEpoch","authTime","authMethods","updatedAt")
          SELECT 'warm-session-'||$1||'-'||i,'warm-token-'||$1||'-'||i,'warmup',now()+interval '1 day','web','read',7,1,'pwd',now() FROM generate_series(1,64) i`,
              [scale],
            );
          } else expect((await complete('hot')).status).toBe(200);
          await db.admin.query('VACUUM (ANALYZE) session');
          if (kind === 'cleanup') await seedCleanupSweepState(db, scale);
        },
        async operation() {
          if (kind === 'complete') expect((await complete('hot')).status).toBe(200);
          else if (kind === 'resolve')
            expect(await service.internal.resolveRecoveryEstablishment(reference)).not.toBeNull();
          else expect(await proofs.sweep({ limit: 1000 })).toEqual({ removed: 1000, hasMore: true });
        },
        async warmup() {
          if (kind === 'complete') expect((await complete('warmup')).status).toBe(200);
          else if (kind === 'cleanup')
            expect(await proofs.sweep({ limit: 1000 })).toEqual({ removed: 1000, hasMore: true });
          else expect(await service.internal.resolveRecoveryEstablishment(reference)).not.toBeNull();
        },
      });
      console.info(`Native recovery ${kind} Cost:`, JSON.stringify(report.samples));
      expect(report.samples.map((s) => s.scale)).toEqual([1, 8, 64]);
      for (const { cost } of report.samples) {
        expect(cost.statements).toBeLessThanOrEqual(kind === 'cleanup' || kind === 'resolve' ? 1 : 100);
        expect(cost.rows).toBeLessThanOrEqual(kind === 'cleanup' ? 6002 : kind === 'resolve' ? 10 : 550);
        expect(cost.statements).toBeGreaterThan(0);
        expect(cost.rows).toBeGreaterThan(0);
        if (kind === 'cleanup') {
          // PostgreSQL may prefer a scan of the small 1x proof table for a 1000
          // row delete. Growth counts bound that choice; each FK cascade must
          // still seek its one witness, even in the smallest fixture.
          expect(cost.relations?.['public.auth_recovery_establishment']?.sequentialScans).toBe(0);
        } else expect(Object.values(cost.relations ?? {}).every((r) => r.sequentialScans === 0)).toBe(true);
      }
      if (kind === 'resolve') {
        const actual = await capture(db, () => service.internal.resolveRecoveryEstablishment(reference));
        expect(actual.value).not.toBeNull();
        const plan = JSON.stringify(actual.capture.plans);
        for (const index of [
          'auth_recovery_establishment_pkey',
          'auth_barrier_proof_pkey',
          'auth_effect_receipt_pkey',
          'account_pkey',
          'auth_recovery_pkey',
        ])
          expect(plan).toContain(`"Index Name":"${index}"`);
      }
      // Live proof deletion is never admitted by expiry cleanup, even with backlog.
      expect(await service.internal.resolveRecoveryEstablishment(reference)).not.toBeNull();
      if (kind === 'cleanup') {
        const expired = (
          await db.admin.query(
            `SELECT w.reference FROM auth_recovery_establishment w JOIN auth_barrier_proof p USING(reference) WHERE p.expires_at<=now() ORDER BY p.expires_at,p.reference LIMIT 1000`,
          )
        ).rows.map((r) => r.reference);
        const cleanup = await capture(db, () => proofs.sweep({ limit: 1000 }));
        expect(cleanup.value.removed).toBe(1000);
        expect(
          (
            await db.admin.query('SELECT reference FROM auth_recovery_establishment WHERE reference=ANY($1::text[])', [
              expired,
            ])
          ).rows,
        ).toHaveLength(0);
        expect(costOf(cleanup.capture).statements).toBe(1);
        const lock = await db.admin.connect();
        try {
          await lock.query('BEGIN');
          await lock.query(
            'SELECT reference FROM auth_barrier_proof WHERE expires_at<=now() ORDER BY expires_at,reference LIMIT 1001 FOR UPDATE',
          );
          const busy = await capture(db, () => proofs.sweep({ limit: 1000 }));
          expect(busy.value).toEqual({ removed: 0, hasMore: true });
          expect(costOf(busy.capture).rows).toBeLessThanOrEqual(3002);
        } finally {
          await lock.query('ROLLBACK');
          lock.release();
        }
      }
    } finally {
      await db.close();
      fixture.close();
    }
  }, 180000);
}
