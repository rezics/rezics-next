import { trustedAccessPorts } from './support/trusted-access.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool, type PoolClient } from 'pg';
import { testDatabase } from '../scripts/database.ts';
import {
  createAuthService,
  createBarrierProofVerifier,
  createRecoveryEstablishmentVerifier,
  type AuthServiceOptions,
} from '../src/index.ts';

const issuer = 'https://recovery.auth.test';
const password = 'original sufficiently long password';
const replacement = 'replacement sufficiently long password';
let fixture: ReturnType<typeof testDatabase>;
let database: Pool;
let options: AuthServiceOptions;
let service: Awaited<ReturnType<typeof createAuthService>>;
let token = '';
let drain = async () => {};
let reference = '';
let failure: 'before' | 'after' | 'receipt' | null = null;
let authorizations = 0;

function trackQueries(target: Pool) {
  let inflight = 0;
  const query = target.query.bind(target);
  const connect = target.connect.bind(target) as {
    (): Promise<PoolClient>;
    (...args: unknown[]): void;
  };
  const tracked = (run: () => unknown) => {
    inflight++;
    try {
      return Promise.resolve(run()).finally(() => {
        inflight--;
      });
    } catch (error) {
      inflight--;
      throw error;
    }
  };
  const hasCallback = (args: unknown[]) => typeof args.at(-1) === 'function';
  const trackClient = (client: PoolClient) => {
    if (Object.hasOwn(client, 'trackedQuery')) return client;
    const clientQuery = client.query.bind(client);
    Object.defineProperty(client, 'trackedQuery', { value: true });
    client.query = ((...args: unknown[]) =>
      hasCallback(args)
        ? clientQuery(...(args as [string]))
        : tracked(() => clientQuery(...(args as [string])))) as PoolClient['query'];
    return client;
  };
  target.query = ((...args: unknown[]) =>
    hasCallback(args) ? query(...(args as [string])) : tracked(() => query(...(args as [string])))) as Pool['query'];
  target.connect = ((...args: unknown[]) =>
    hasCallback(args) ? connect(...args) : connect().then(trackClient)) as Pool['connect'];
  return async function settled() {
    for (;;) {
      await new Promise((resolve) => setImmediate(resolve));
      if (inflight === 0) {
        await new Promise((resolve) => setImmediate(resolve));
        if (inflight === 0) return;
      }
    }
  };
}
function request(path: string, body: unknown) {
  return service.handler(
    new Request(`${issuer}${path}`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}
async function start(id: string) {
  const mailKey = createHmac('sha256', 'persistent-native-recovery-secret-32-bytes')
    .update(JSON.stringify(['auth-recovery-mail-v1', id]))
    .digest('hex');
  await database.query('DELETE FROM auth_attempt_counter WHERE key=$1', [mailKey]);
  const previous = token;
  expect((await request('/recovery/start', { email: `${id}@example.test` })).status).toBe(200);
  const deadline = Date.now() + 5_000;
  while (token === previous && Date.now() < deadline) await Bun.sleep(10);
  expect(token).not.toBe(previous);
  await drain();
  return token;
}
function complete(id: string, value: string, newPassword = replacement) {
  return request('/recovery/complete', { account_id: id, token: value, new_password: newPassword });
}
function resolve(value: unknown = reference) {
  return service.internal.resolveRecoveryEstablishment(value);
}

beforeAll(async () => {
  fixture = testDatabase();
  // Every native adapter, callback proof read, and assertion uses this one pool.
  database = new Pool({ connectionString: fixture.url, max: 1, connectionTimeoutMillis: 2000 });
  drain = trackQueries(database);
  await database.query(`CREATE TABLE test_access (id text PRIMARY KEY,epoch integer NOT NULL,state text NOT NULL,automated boolean DEFAULT false);
    CREATE TABLE test_barrier (operation text PRIMARY KEY,account_id text NOT NULL,reference text NOT NULL,epoch integer NOT NULL);
    INSERT INTO test_access SELECT id,7,'pending',id='robot' FROM unnest(ARRAY['success','failed','stale','absent','expired','robot','rollback','unbounded','racing','deadline']) id`);
  const readAccount = async (accountId: string) => {
    const row = (await database.query('SELECT * FROM test_access WHERE id=$1', [accountId])).rows[0];
    return row
      ? {
          accountId,
          kind: 'actor' as const,
          state: row.state,
          authnEpoch: row.epoch,
          automated: row.automated,
          fenced: row.state === 'active',
        }
      : null;
  };
  const key = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'recovery',
  };
  options = {
    database,
    issuer,
    audience: 'https://api.test',
    secret: 'persistent-native-recovery-secret-32-bytes',
    signing: { activeKid: key.kid, privateKeys: [key] },
    trustedAccess: trustedAccessPorts({
      async readFencedAccount(id) {
        return (await this.readAccount(id)) ?? (await this.readRecoveryAccount!(id));
      },
      readAccount,
      readRecoveryAccount: readAccount,
      authorizeProvisioning: async (id) => ({ accountId: id }),
      async completeRecovery(reference) {
        expect(await createRecoveryEstablishmentVerifier({ database }).resolve(reference)).not.toBeNull();
      },
      async authorizeRecovery(input) {
        authorizations++;
        reference = input.proofReference!;
        expect(
          await createBarrierProofVerifier({ database }).verify(reference, {
            accountId: input.accountId,
            purpose: 'recovery',
            previousEpoch: input.proofEpoch,
            operationKey: input.operationKey!,
          }),
        ).not.toBeNull();
        expect(await createRecoveryEstablishmentVerifier({ database }).resolve(reference)).toBeNull();
        if (failure === 'before') throw new Error('Access unavailable');
        const prior = (await database.query('SELECT * FROM test_barrier WHERE operation=$1', [input.operationKey]))
          .rows[0];
        let epoch = prior?.epoch;
        if (!prior) {
          epoch = (
            await database.query('UPDATE test_access SET epoch=epoch+1 WHERE id=$1 AND epoch=$2 RETURNING epoch', [
              input.accountId,
              input.proofEpoch,
            ])
          ).rows[0]?.epoch;
          if (!epoch) throw new Error('Stale Access floor');
          await database.query('INSERT INTO test_barrier VALUES ($1,$2,$3,$4)', [
            input.operationKey,
            input.accountId,
            reference,
            epoch,
          ]);
        } else expect(prior.reference).toBe(reference);
        if (failure === 'after') throw new Error('Lost Access acknowledgement');
        return {
          accountId: failure === 'receipt' ? 'success' : input.accountId,
          receiptId: input.operationKey!,
          minimumAuthnEpoch: epoch,
        };
      },
    }),
    recoveryDelivery: {
      async deliver(value) {
        token = value.token;
      },
    },
  };
  service = await createAuthService(options);
  for (const id of [
    'success',
    'failed',
    'stale',
    'absent',
    'expired',
    'robot',
    'rollback',
    'unbounded',
    'racing',
    'deadline',
  ])
    await service.internal.provisionPassword({ authorization: id, email: `${id}@example.test`, password });
  await database.query("UPDATE test_access SET state='active'");
}, 60000);
afterAll(async () => {
  await database?.end();
  fixture?.close();
});

test('only committed native recovery credential transaction produces new establishment evidence; max=1 pool progresses', async () => {
  expect(await resolve('a'.repeat(64))).toBeNull();
  const value = await start('success');
  expect((await complete('success', value)).status).toBe(200);
  expect(database.totalCount).toBe(1);
  const evidence = await resolve();
  const row = (
    await database.query(
      'SELECT p.*,w.*,r.minimum_authn_epoch FROM auth_barrier_proof p JOIN auth_recovery_establishment w USING(reference) JOIN auth_effect_receipt r USING(receipt_id) WHERE reference=$1',
      [reference],
    )
  ).rows[0];
  expect(evidence).toEqual({
    accountId: 'success',
    receiptId: row.receipt_id,
    minimumAuthnEpoch: '8',
    authnEpoch: 8,
    establishmentId: row.establishment_id,
    expiresAt: row.expires_at.toISOString(),
  });
  expect(Object.isFrozen(evidence)).toBe(true);
  expect(row.applied_at).toBeInstanceOf(Date);
  expect(row.expires_at.getTime()).toBeLessThanOrEqual(row.created_at.getTime() + 300000);
  expect(row.effect_commitment).toBe(row.evidence[8]);
  expect(row.credential_id).toBe(row.evidence[5]);
  expect(row.credential_fingerprint).not.toBe(row.evidence[6]);
  const native = (await database.query('SELECT password,"updatedAt" FROM account WHERE id=$1', [row.credential_id]))
    .rows[0];
  expect(row.credential_fingerprint).toBe(
    createHash('sha256')
      .update(JSON.stringify([native.password, native.updatedAt.toISOString()]))
      .digest('hex'),
  );
  expect(JSON.stringify(row)).not.toContain(value);
  expect(JSON.stringify(row)).not.toContain(replacement);
  expect(JSON.stringify(evidence)).not.toContain(native.password);
  expect(JSON.stringify(evidence)).not.toContain(row.credential_fingerprint);
});

test('exact successful reset resumes after lost acknowledgement without another password effect', async () => {
  const saved = reference;
  const value = token;
  const before = (await database.query(`SELECT password,"updatedAt" FROM account WHERE "userId"='success'`)).rows[0];
  const evidence = await resolve(saved);
  const calls = authorizations;
  // Discard the first HTTP acknowledgement and recreate the entire Auth service.
  service = await createAuthService(options);
  expect((await complete('success', value)).status).toBe(200);
  expect(await resolve(saved)).toEqual(evidence);
  expect(authorizations).toBe(calls);
  expect((await database.query(`SELECT password,"updatedAt" FROM account WHERE "userId"='success'`)).rows[0]).toEqual(
    before,
  );
  expect((await database.query("SELECT epoch FROM test_access WHERE id='success'")).rows[0].epoch).toBe(8);
  expect((await complete('success', value, password)).status).toBe(401);
  await database.query(`UPDATE account SET "updatedAt"="updatedAt"+interval '1 second' WHERE "userId"='success'`);
  expect(await resolve(saved)).toBeNull();
  expect((await complete('success', value)).status).toBe(401);
});

test('failed or superseded credential receipt never resolves and failed Auth mutation keeps native Access fence', async () => {
  const value = await start('failed');
  const before = (await database.query(`SELECT password FROM account WHERE "userId"='failed'`)).rows[0].password;
  failure = 'after';
  expect((await complete('failed', value)).status).toBe(503);
  const exact = reference;
  expect(await resolve(exact)).toBeNull();
  expect((await complete('failed', value, password)).status).toBe(401);
  failure = null;
  await database.query(
    `ALTER TABLE auth_recovery_establishment ADD CONSTRAINT test_fail_witness CHECK (account_id<>'failed') NOT VALID`,
  );
  try {
    expect((await complete('failed', value)).status).toBe(503);
  } finally {
    await database.query('ALTER TABLE auth_recovery_establishment DROP CONSTRAINT test_fail_witness');
  }
  expect(await resolve(exact)).toBeNull();
  expect((await database.query(`SELECT password FROM account WHERE "userId"='failed'`)).rows[0].password).toBe(before);
  expect(
    (await database.query('SELECT applied_at FROM auth_barrier_proof WHERE reference=$1', [exact])).rows[0].applied_at,
  ).toBeNull();
  expect((await database.query("SELECT epoch FROM test_access WHERE id='failed'")).rows[0].epoch).toBe(8);
  expect((await complete('failed', value)).status).toBe(200);
  expect(reference).toBe(exact);
  expect(await resolve(exact)).not.toBeNull();
  const second = await start('failed');
  expect((await complete('failed', second)).status).toBe(200);
  expect(await resolve(exact)).toBeNull();
  expect((await complete('failed', value)).status).toBe(401);
  expect((await database.query("SELECT epoch FROM test_access WHERE id='failed'")).rows[0].epoch).toBe(9);
});

test('stale/absent/expired native proofs, invalid receipts, automated humans and injected evidence stay denied', async () => {
  let value = await start('stale');
  await database.query("UPDATE test_access SET epoch=epoch+1 WHERE id='stale'");
  expect((await complete('stale', value)).status).toBe(401);
  value = await start('absent');
  await database.query("DELETE FROM verification WHERE value='absent'");
  expect((await complete('absent', value)).status).toBe(401);
  value = await start('expired');
  await database.query("UPDATE auth_recovery SET expires_at=now()-interval '1 second' WHERE account_id='expired'");
  expect((await complete('expired', value)).status).toBe(401);
  const beforeRobot = token;
  expect((await request('/recovery/start', { email: 'robot@example.test' })).status).toBe(200);
  await drain();
  expect(token).toBe(beforeRobot);
  expect((await database.query("SELECT 1 FROM auth_recovery WHERE account_id='robot'")).rows).toHaveLength(0);
  value = await start('stale');
  failure = 'receipt';
  expect((await complete('stale', value)).status).toBe(401);
  expect(await resolve()).toBeNull();
  failure = null;
  expect(
    (
      await request('/recovery/complete', {
        account_id: 'stale',
        token: value,
        new_password: replacement,
        evidence: {},
      })
    ).status,
  ).toBe(400);
  expect((await complete('absent', value)).status).toBe(401);
  expect((await complete('stale', 'forged')).status).toBe(401);
});

test('receipt publication rolls back native verification consumption and never fabricates success', async () => {
  const value = await start('rollback');
  await database.query(
    `ALTER TABLE auth_barrier_proof ADD CONSTRAINT test_reject_proof CHECK (account_id<>'rollback') NOT VALID`,
  );
  try {
    expect((await complete('rollback', value)).status).toBe(503);
  } finally {
    await database.query('ALTER TABLE auth_barrier_proof DROP CONSTRAINT test_reject_proof');
  }
  expect((await database.query("SELECT id FROM verification WHERE value='rollback'")).rows).toHaveLength(1);
  expect(
    (await database.query("SELECT consumed_operation FROM auth_recovery WHERE account_id='rollback'")).rows[0]
      .consumed_operation,
  ).toBeNull();
  failure = 'before';
  expect((await complete('rollback', value)).status).toBe(503);
  const exact = reference;
  expect(await resolve(exact)).toBeNull();
  await database.query('DELETE FROM auth_barrier_proof WHERE reference=$1', [exact]);
  failure = null;
  expect((await complete('rollback', value)).status).toBe(401);
});

test('bounded session revocation stays guarded and missing exact effect/source never resolves', async () => {
  const value = await start('unbounded');
  await database.query(`UPDATE "user" SET sessions_bounded=false WHERE id='unbounded'`);
  expect((await complete('unbounded', value)).status).toBe(503);
  const exact = reference;
  expect(await resolve(exact)).toBeNull();
  await database.query(`UPDATE "user" SET sessions_bounded=true WHERE id='unbounded'`);
  expect((await complete('unbounded', value)).status).toBe(200);
  expect(await resolve(exact)).not.toBeNull();
  await database.query(
    `UPDATE auth_effect_receipt SET purpose='set-password' WHERE receipt_id=(SELECT receipt_id FROM auth_recovery_establishment WHERE reference=$1)`,
    [exact],
  );
  expect(await resolve(exact)).toBeNull();
  expect((await complete('unbounded', value)).status).toBe(401);
  await database.query(
    `UPDATE auth_effect_receipt SET purpose='recovery' WHERE receipt_id=(SELECT receipt_id FROM auth_recovery_establishment WHERE reference=$1)`,
    [exact],
  );
  await database.query("DELETE FROM auth_recovery WHERE account_id='unbounded'");
  expect(await resolve(exact)).toBeNull();
});

test('lost native COMMIT acknowledgement resumes through the committed witness without another mutation', async () => {
  const value = await start('racing');
  const client = await database.connect();
  const original = client.query;
  let witnessWritten = false;
  let acknowledgementLost = false;
  client.query = function (this: PoolClient, ...args: Parameters<typeof original>) {
    const result = Reflect.apply(original, this, args);
    if (typeof args[0] === 'string' && args[0].includes('INSERT INTO auth_recovery_establishment'))
      witnessWritten = true;
    if (args[0] === 'COMMIT' && witnessWritten && !acknowledgementLost) {
      return Promise.resolve(result).then(() => {
        acknowledgementLost = true;
        throw new Error('Native COMMIT acknowledgement lost');
      });
    }
    return result;
  } as typeof original;
  client.release();
  try {
    expect((await complete('racing', value)).status).toBe(503);
  } finally {
    client.query = original;
  }
  expect(acknowledgementLost).toBe(true);
  const success = await resolve();
  expect(success).not.toBeNull();
  const before = (await database.query(`SELECT password,"updatedAt" FROM account WHERE "userId"='racing'`)).rows[0];
  const calls = authorizations;
  service = await createAuthService(options);
  expect((await complete('racing', value)).status).toBe(200);
  expect(await resolve()).toEqual(success);
  expect(authorizations).toBe(calls);
  expect((await database.query(`SELECT password,"updatedAt" FROM account WHERE "userId"='racing'`)).rows[0]).toEqual(
    before,
  );
  expect((await database.query("SELECT epoch FROM test_access WHERE id='racing'")).rows[0].epoch).toBe(8);
  for (const change of ["account_id='stale'", 'minimum_authn_epoch=9', "purpose='set-password'"]) {
    await database.query(`UPDATE auth_effect_receipt SET ${change} WHERE receipt_id=$1`, [success!.receiptId]);
    expect(await resolve()).toBeNull();
    await database.query(
      `UPDATE auth_effect_receipt SET account_id='racing',minimum_authn_epoch=8,purpose='recovery' WHERE receipt_id=$1`,
      [success!.receiptId],
    );
  }
  expect(await resolve()).toEqual(success);
  await database.query(`UPDATE test_access SET epoch=epoch+1 WHERE id='racing'`);
  expect((await complete('racing', value)).status).toBe(401);
  // Auth verifies its native credential only; Access owns comparison to its floor.
  expect(await resolve()).toEqual(success);
  await database.query(`DELETE FROM "user" WHERE id='racing'`);
  expect(await resolve()).toBeNull();
  expect(
    (await database.query('SELECT reference FROM auth_recovery_establishment WHERE reference=$1', [reference])).rows,
  ).toHaveLength(0);
});

test('native proof expiry denies before sweep and owns bounded cascading witness cleanup', async () => {
  const value = await start('deadline');
  await database.query(
    `UPDATE auth_recovery SET expires_at=statement_timestamp()+interval '2 seconds' WHERE account_id='deadline'`,
  );
  expect((await complete('deadline', value)).status).toBe(200);
  const exact = reference;
  const row = (await database.query('SELECT expires_at FROM auth_barrier_proof WHERE reference=$1', [exact])).rows[0];
  expect(await resolve(exact)).not.toBeNull();
  const proofs = createBarrierProofVerifier({ database });
  expect(await proofs.sweep({ limit: 1000 })).toEqual({ removed: 0, hasMore: false });
  expect(await resolve(exact)).not.toBeNull();
  await Bun.sleep(Math.max(0, row.expires_at.getTime() - Date.now() + 20));
  expect(await resolve(exact)).toBeNull();
  expect((await complete('deadline', value)).status).toBe(401);
  expect(
    (await database.query('SELECT reference FROM auth_recovery_establishment WHERE reference=$1', [exact])).rows,
  ).toHaveLength(1);
  expect(await proofs.sweep({ limit: 1 })).toEqual({ removed: 1, hasMore: false });
  expect(
    (await database.query('SELECT reference FROM auth_recovery_establishment WHERE reference=$1', [exact])).rows,
  ).toHaveLength(0);
});
