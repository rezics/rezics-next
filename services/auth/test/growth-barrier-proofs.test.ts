import { expect, test } from 'bun:test';
import { exportJWK, generateKeyPair } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import { createAuthService, createBarrierProofVerifier, type BarrierProof } from '../src/index.ts';
import {
  capture,
  checkGrowth,
  costOf,
  openGrowthDatabase,
  type GrowthDatabase,
} from '../../kernel/test/support/growth.ts';

// One seed grows same-owner proof/consent/recovery history and unrelated owners
// together. The real measured source is prepared by authenticated Auth handlers.
async function grow(db: GrowthDatabase, scale: number, previous: number) {
  const range = [previous * 1024 + 1, scale * 1024];
  await db.admin.query(
    `INSERT INTO "user" (id,name,"emailVerified")
    SELECT 'owner-'||i,'',false FROM generate_series($1::integer,$2::integer) i`,
    range,
  );
  await db.admin.query(
    `INSERT INTO auth_client (client_id,first_party,scopes)
    SELECT 'client-'||i,false,ARRAY['read','write'] FROM generate_series($1::integer,$2::integer) i`,
    range,
  );
  await db.admin.query(
    `INSERT INTO auth_consent (account_id,client_id,scopes)
    SELECT owner,'client-'||i,ARRAY['read','write'] FROM generate_series($1::integer,$2::integer) i
    CROSS JOIN LATERAL (VALUES ('hot'),('owner-'||i)) AS owners(owner)`,
    range,
  );
  await db.admin.query(
    `INSERT INTO auth_recovery (proof_hash,account_id,authn_epoch,expires_at)
    SELECT md5(owner||i),owner,1,now()+interval '1 day' FROM generate_series($1::integer,$2::integer) i
    CROSS JOIN LATERAL (VALUES ('hot'),('owner-'||i)) AS owners(owner)`,
    range,
  );
  await db.admin.query(
    `INSERT INTO verification (id,identifier,value,"expiresAt")
    SELECT 'verification-'||i,'history-'||i,'hot',now()+interval '1 day' FROM generate_series($1::integer,$2::integer) i`,
    range,
  );
  await db.admin.query(
    `INSERT INTO auth_barrier_proof(reference,account_id,purpose,previous_epoch,operation_key,digest,evidence,expires_at)
    SELECT md5(owner||i)||md5(owner||i),owner,'consent-reduction',1,'history-'||i,repeat('0',64),'[]',now()+interval '4 minutes'
    FROM generate_series($1::integer,$2::integer) i CROSS JOIN LATERAL (VALUES ('hot'),('owner-'||i)) AS owners(owner)`,
    range,
  );
  await db.admin.query(
    `INSERT INTO auth_barrier_proof(reference,account_id,purpose,previous_epoch,operation_key,digest,evidence,created_at,expires_at)
    SELECT md5('expired-'||i)||md5('expired-'||i),'hot','recovery',1,'expired-'||i,repeat('0',64),'[]',now()-interval '10 minutes',now()-interval '9 minutes'
    FROM generate_series($1::integer,$2::integer) i`,
    [previous * 2048 + 1, scale * 2048],
  );
  for (const table of ['"user"', 'auth_client', 'auth_consent', 'auth_recovery', 'verification', 'auth_barrier_proof'])
    await db.admin.query(`VACUUM (ANALYZE) ${table}`);
}

for (const kind of ['consent', 'recovery', 'sweep'] as const) {
  test(`checkGrowth bounds actual ${kind} at 1x/8x/64x same-owner and unrelated history`, async () => {
    const fixture = testDatabase();
    const db = await openGrowthDatabase(fixture.url);
    try {
      const verifier = createBarrierProofVerifier({ database: db.pool });
      const issuer = 'https://growth.barrier.test';
      const password = 'growth password sufficiently long';
      let token = '';
      let cookie = '';
      let latest: {
        reference: string;
        expected: Pick<BarrierProof, 'accountId' | 'purpose' | 'previousEpoch' | 'operationKey'>;
      };
      await db.admin.query(
        "CREATE TABLE test_access(id text PRIMARY KEY,epoch integer NOT NULL,state text NOT NULL); INSERT INTO test_access VALUES ('hot',1,'pending')",
      );
      const readAccount = async (accountId: string) => {
        const row = (await db.pool.query('SELECT epoch,state FROM test_access WHERE id=$1', [accountId])).rows[0];
        return row
          ? { accountId, kind: 'actor' as const, automated: false, state: row.state, authnEpoch: row.epoch }
          : null;
      };
      async function barrier(
        accountId: string,
        purpose: BarrierProof['purpose'],
        previousEpoch: number,
        reference?: string,
        operationKey?: string,
      ) {
        expect(reference).toBeString();
        expect(operationKey).toBeString();
        latest = {
          reference: reference!,
          expected: { accountId, purpose, previousEpoch, operationKey: operationKey! },
        };
        const proof = await verifier.verify(reference!, latest.expected);
        expect(proof).not.toBeNull();
        expect(
          await verifier.verify(reference!, {
            ...latest.expected,
            purpose: purpose === 'recovery' ? 'consent-reduction' : 'recovery',
          }),
        ).toBeNull();
        expect(await verifier.verify(reference!, { ...latest.expected, operationKey: 'untrusted' })).toBeNull();
        const row = (
          await db.pool.query('UPDATE test_access SET epoch=epoch+1 WHERE id=$1 AND epoch=$2 RETURNING epoch', [
            accountId,
            previousEpoch,
          ])
        ).rows[0];
        if (!row) throw new Error('Native floor CAS denied');
        return { accountId, receiptId: operationKey!, minimumAuthnEpoch: row.epoch };
      }
      const key = {
        ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
        kid: 'growth-barrier',
      };
      const auth = await createAuthService({
        database: db.pool,
        issuer,
        audience: 'https://api.test',
        secret: 'persistent-growth-barrier-secret-32-bytes',
        signing: { activeKid: key.kid, privateKeys: [key] },
        trustedAccess: {
          readAccount,
          readRecoveryAccount: readAccount,
          authorizeProvisioning: async () => ({ accountId: 'hot' }),
          invalidateAccount: (v) =>
            barrier(v.accountId, 'consent-reduction', v.previousEpoch, v.proofReference, v.operationKey),
          authorizeRecovery: (v) => barrier(v.accountId, 'recovery', v.proofEpoch, v.proofReference, v.operationKey),
        },
        recoveryDelivery: {
          async deliver(v) {
            token = v.token;
          },
        },
      });
      const request = (path: string, body: unknown) =>
        auth.handler(
          new Request(`${issuer}${path}`, {
            method: 'POST',
            headers: { origin: issuer, 'content-type': 'application/json', cookie },
            body: JSON.stringify(body),
          }),
        );
      await auth.internal.provisionPassword({ authorization: 'approved', email: 'hot@example.test', password });
      await db.admin.query("UPDATE test_access SET state='active'");
      await auth.internal.registerClient({ clientId: 'web', firstParty: true, scopes: ['read'] });
      await auth.internal.registerClient({ clientId: 'external', firstParty: false, scopes: ['read', 'write'] });
      const report = await checkGrowth(db, {
        name: `Auth barrier ${kind}`,
        repetitions: 1,
        warmups: 0,
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        async grow(_, scale, previous) {
          await grow(db, scale, previous);
          if (kind === 'consent') {
            const signed = await request('/signin', { account_id: 'hot', password, client_id: 'web', scope: ['read'] });
            expect(signed.status).toBe(200);
            cookie = signed.headers
              .getSetCookie()
              .map((v) => v.split(';')[0])
              .join('; ');
            expect((await request('/consent', { client_id: 'external', scope: ['read', 'write'] })).status).toBe(200);
          } else if (kind === 'recovery')
            expect((await request('/recovery/start', { account_id: 'hot' })).status).toBe(200);
        },
        async operation() {
          if (kind === 'sweep') expect(await verifier.sweep({ limit: 1000 })).toEqual({ removed: 1000, hasMore: true });
          else {
            const result =
              kind === 'consent'
                ? await request('/consent', { client_id: 'external', scope: ['read'] })
                : await request('/recovery/complete', { account_id: 'hot', token, new_password: password });
            expect(result.status).toBe(200);
            expect(await verifier.verify(latest.reference, latest.expected)).toBeNull();
          }
        },
      });
      console.info(`Auth barrier ${kind} growth:`, JSON.stringify(report.samples));
      expect(report.samples.map((s) => s.scale)).toEqual([1, 8, 64]);
      for (const { cost } of report.samples) {
        expect(cost.statements).toBeGreaterThan(0);
        expect(cost.rows).toBeGreaterThan(0);
        expect(cost.rows).toBeLessThanOrEqual(kind === 'sweep' ? 4002 : 250);
        expect(cost.statements).toBeLessThanOrEqual(kind === 'sweep' ? 1 : 90);
        expect(Object.values(cost.relations ?? {}).every((relation) => relation.sequentialScans === 0)).toBe(true);
      }
      if (kind === 'sweep') {
        const batches = await checkGrowth(db, {
          name: 'barrier cleanup follows admitted batch',
          repetitions: 1,
          warmups: 0,
          bounds: { rows: 'linear', blocks: 'linear', statements: 'constant' },
          async grow() {
            await db.admin.query('VACUUM (ANALYZE) auth_barrier_proof');
          },
          async operation(_, scale) {
            expect((await verifier.sweep({ limit: scale * 8 })).removed).toBe(scale * 8);
          },
        });
        for (const sample of batches.samples) expect(sample.cost.rows).toBeLessThanOrEqual(sample.scale * 8 * 4 + 2);
        const lock = await db.admin.connect();
        try {
          await lock.query('BEGIN');
          await lock.query(
            'SELECT reference FROM auth_barrier_proof WHERE expires_at<=now() ORDER BY expires_at,reference LIMIT 1001 FOR UPDATE',
          );
          const result = await capture(db, () => verifier.sweep({ limit: 1000 }));
          expect(result.value).toEqual({ removed: 0, hasMore: true });
          expect(costOf(result.capture).rows).toBeLessThanOrEqual(3002);
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
