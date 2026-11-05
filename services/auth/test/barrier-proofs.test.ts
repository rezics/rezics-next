import { trustedAccessPorts } from './support/trusted-access.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { testDatabase } from '../scripts/database.ts';
import { createAuthService, createBarrierProofVerifier, type AuthServiceOptions } from '../src/index.ts';

const issuer = 'https://barriers.auth.test';
const password = 'original password long enough';
const changed = 'replacement password long enough';
let fixture: ReturnType<typeof testDatabase>;
let database: Pool;
let options: AuthServiceOptions;
let service: Awaited<ReturnType<typeof createAuthService>>;
let delivery = '';
let fail: 'before' | 'after' | 'receipt' | null = null;
let observed: {
  reference: string;
  accountId: string;
  purpose: 'consent-reduction' | 'recovery';
  previousEpoch: number;
  operationKey: string;
};

function request(path: string, body: unknown, cookie = '') {
  return service.handler(
    new Request(`${issuer}${path}`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    }),
  );
}
async function login(id = 'human', value = password) {
  const response = await request('/signin', { account_id: id, password: value, client_id: 'web', scope: ['read'] });
  expect(response.status).toBe(200);
  return response.headers
    .getSetCookie()
    .map((v) => v.split(';')[0])
    .join('; ');
}
async function start(accountId = 'human') {
  // Each scenario needs an independent delivery, outside the mail cooldown contract.
  await database.query('DELETE FROM auth_attempt_counter');
  delivery = '';
  expect((await request('/recovery/start', { email: `${accountId}@example.test` })).status).toBe(200);
  const deadline = Date.now() + 5000;
  while (!delivery && Date.now() < deadline) await Bun.sleep(5);
  expect(delivery).not.toBe('');
  return delivery;
}
async function verify(overrides = {}) {
  return createBarrierProofVerifier({ database }).verify(observed.reference, { ...observed, ...overrides });
}

async function verifyInFreshProcess() {
  const child = Bun.spawn(
    [
      'bun',
      '--eval',
      `
    import { Pool } from 'pg';
    import { createBarrierProofVerifier } from './src/barrier-proofs.ts';
    const database = new Pool({ connectionString: process.env.PROOF_TEST_DATABASE });
    try {
      const { reference, ...expected } = JSON.parse(process.env.PROOF_TEST_EXPECTED);
      console.log(JSON.stringify(await createBarrierProofVerifier({ database }).verify(reference, expected)));
    } finally { await database.end(); }
  `,
    ],
    {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, PROOF_TEST_DATABASE: fixture.url, PROOF_TEST_EXPECTED: JSON.stringify(observed) },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const output = await new Response(child.stdout).text();
  const error = await new Response(child.stderr).text();
  expect({ code: await child.exited, error }).toEqual({ code: 0, error: '' });
  return JSON.parse(output);
}

beforeAll(async () => {
  fixture = testDatabase();
  database = new Pool({ connectionString: fixture.url });
  // Access fixture persists its native floor and exact CAS receipt. Auth evidence
  // always comes from real provider sessions, consent and recovery rows.
  await database.query(`CREATE TABLE test_access (id text PRIMARY KEY, epoch integer NOT NULL, automated boolean DEFAULT false);
    CREATE TABLE test_recovery_clear (reference text PRIMARY KEY);
    CREATE TABLE test_barrier (key text PRIMARY KEY, account_id text NOT NULL, previous integer NOT NULL, epoch integer NOT NULL, digest text NOT NULL);
    INSERT INTO test_access VALUES ('human',1,false),('other',1,false),('robot',1,true)`);
  const readAccount = async (id: string) => {
    const row = (await database.query('SELECT * FROM test_access WHERE id=$1', [id])).rows[0];
    return row
      ? {
          accountId: id,
          kind: 'actor' as const,
          state: 'active' as const,
          authnEpoch: row.epoch,
          automated: row.automated,
        }
      : null;
  };
  async function barrier(
    input: { accountId: string; proofReference?: string; operationKey?: string },
    purpose: typeof observed.purpose,
    previousEpoch: number,
  ) {
    expect(input.proofReference).toBeString();
    expect(input.operationKey).toBeString();
    observed = {
      reference: input.proofReference!,
      operationKey: input.operationKey!,
      accountId: input.accountId,
      purpose,
      previousEpoch,
    };
    const proof = await verify();
    expect(proof).not.toBeNull();
    expect(Object.isFrozen(proof)).toBe(true);
    if (fail === 'before') throw new Error('Access unavailable');
    const connection = await database.connect();
    let epoch: number;
    try {
      await connection.query('BEGIN');
      await connection.query('SELECT * FROM test_access WHERE id=$1 FOR UPDATE', [input.accountId]);
      const prior = (await connection.query('SELECT * FROM test_barrier WHERE key=$1', [input.operationKey])).rows[0];
      if (prior) {
        expect(prior.digest).toBe(proof!.digest);
        expect(prior.previous).toBe(previousEpoch);
        epoch = prior.epoch;
      } else {
        const row = (
          await connection.query('UPDATE test_access SET epoch=epoch+1 WHERE id=$1 AND epoch=$2 RETURNING epoch', [
            input.accountId,
            previousEpoch,
          ])
        ).rows[0];
        if (!row) throw new Error('Stale native floor');
        epoch = row.epoch;
        await connection.query('INSERT INTO test_barrier VALUES ($1,$2,$3,$4,$5)', [
          input.operationKey,
          input.accountId,
          previousEpoch,
          epoch,
          proof!.digest,
        ]);
      }
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
    if (fail === 'after') throw new Error('Acknowledgement lost');
    return {
      receiptId: input.operationKey!,
      accountId: fail === 'receipt' ? 'other' : input.accountId,
      minimumAuthnEpoch: epoch,
    };
  }
  const key = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'barrier',
  };
  options = {
    database,
    issuer,
    secret: 'persistent-barrier-test-secret-at-least-32-bytes',
    audience: 'https://api.test',
    signing: { activeKid: key.kid, privateKeys: [key] },
    trustedAccess: trustedAccessPorts({
      async readFencedAccount(id) {
        return (await this.readAccount(id)) ?? (await this.readRecoveryAccount!(id));
      },
      readAccount,
      readRecoveryAccount: readAccount,
      authorizeProvisioning: async (accountId) => ({ accountId }),
      invalidateAccount: (input) => barrier(input, 'consent-reduction', input.previousEpoch),
      authorizeRecovery: (input) => barrier(input, 'recovery', input.proofEpoch),
      async completeRecovery(reference) {
        const witness = await service.internal.resolveRecoveryEstablishment(reference);
        const current = witness && (await readAccount(witness.accountId));
        const receipt =
          witness && (await database.query('SELECT * FROM test_barrier WHERE key=$1', [witness.receiptId])).rows[0];
        if (
          !witness ||
          !current ||
          current.automated ||
          current.authnEpoch !== witness.authnEpoch ||
          !receipt ||
          receipt.account_id !== witness.accountId ||
          receipt.epoch !== witness.authnEpoch
        )
          throw new Error('Invalid completion');
        await database.query('INSERT INTO test_recovery_clear VALUES ($1) ON CONFLICT DO NOTHING', [reference]);
      },
    }),
    recoveryDelivery: {
      async deliver({ token }) {
        delivery = token;
      },
    },
  };
  service = await createAuthService(options);
  await service.internal.registerClient({ clientId: 'web', firstParty: true, scopes: ['read', 'write'] });
  await service.internal.registerClient({ clientId: 'external', firstParty: false, scopes: ['read', 'write'] });
  for (const id of ['human', 'other', 'robot']) {
    options.trustedAccess.authorizeProvisioning = async () => ({ accountId: id });
    const original = options.trustedAccess.readAccount;
    options.trustedAccess.readAccount = async (accountId) => ({ ...(await original(accountId))!, state: 'pending' });
    await service.internal.provisionPassword({ authorization: id, email: `${id}@example.test`, password });
    options.trustedAccess.readAccount = original;
  }
}, 60000);
afterAll(async () => {
  await database?.end();
  fixture?.close();
});

test('real authenticated human consent publishes exact committed evidence, denies injected fields and expansion/noop/automation', async () => {
  const cookie = await login();
  for (const scope of [['read'], ['read', 'write'], ['read', 'write']])
    expect((await request('/consent', { client_id: 'external', scope }, cookie)).status).toBe(200);
  expect((await database.query('SELECT * FROM auth_barrier_proof')).rows).toHaveLength(0);
  expect(
    (await request('/consent', { client_id: 'external', scope: [], proofReference: 'forged' }, cookie)).status,
  ).toBe(400);
  expect((await request('/consent', { client_id: 'external', scope: [] })).status).toBe(401);
  expect((await request('/consent', { client_id: 'external', scope: [] }, await login('robot'))).status).toBe(401);
  const other = await login('other');
  expect((await request('/consent', { client_id: 'external', scope: ['read'] }, other)).status).toBe(200);
  fail = 'before';
  expect((await request('/consent', { client_id: 'external', scope: ['read'] }, cookie)).status).toBe(503);
  const proof = await verify();
  expect(proof).toMatchObject({
    accountId: 'human',
    purpose: 'consent-reduction',
    previousEpoch: 1,
    operationKey: observed.operationKey,
  });
  expect(proof!.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(await verifyInFreshProcess()).toEqual(proof);
  expect(Date.parse(proof!.expiresAt)).toBeLessThanOrEqual(Date.now() + 300000);
  for (const override of [
    { accountId: 'other' },
    { purpose: 'recovery' },
    { previousEpoch: 0 },
    { operationKey: 'wrong' },
  ])
    expect(await verify(override)).toBeNull();
  expect(await createBarrierProofVerifier({ database }).verify('untrusted', observed)).toBeNull();
  expect(await createBarrierProofVerifier({ database }).verify('e'.repeat(64), observed)).toBeNull();
  expect(
    (await database.query("SELECT scopes FROM auth_consent WHERE account_id='human' AND client_id='external'")).rows[0]
      .scopes,
  ).toEqual(['read', 'write']);
  fail = 'after';
  expect((await request('/consent', { client_id: 'external', scope: ['read'] }, cookie)).status).toBe(503);
  const exact = { ...observed };
  service = await createAuthService(options);
  expect(await verify()).not.toBeNull();
  fail = null;
  expect((await request('/consent', { client_id: 'external', scope: [] }, cookie)).status).toBe(401);
  expect((await request('/consent', { client_id: 'external', scope: ['read'] }, cookie)).status).toBe(200);
  expect(observed).toEqual(exact);
  expect(await verify()).toBeNull();
  expect((await database.query('SELECT * FROM test_barrier')).rows).toHaveLength(1);
});

test('native token verification and atomic exact consumption precede recovery proof publication and survive lost acknowledgement', async () => {
  const token = await start();
  const nativeExpiry = (
    await database.query(
      `SELECT "expiresAt" FROM verification WHERE value='human' ORDER BY "createdAt" DESC,id DESC LIMIT 1`,
    )
  ).rows[0].expiresAt;
  const complete = (value = token, newPassword = changed, accountId = 'human') =>
    request('/recovery/complete', { account_id: accountId, token: value, new_password: newPassword });
  const before = (await database.query('SELECT password FROM account WHERE "userId"=\'human\'')).rows[0].password;
  for (const [value, id] of [
    ['forged', 'human'],
    [token, 'other'],
  ])
    expect((await complete(value, changed, id)).status).toBe(401);
  fail = 'after';
  expect((await complete()).status).toBe(503);
  expect((await database.query('SELECT password FROM account WHERE "userId"=\'human\'')).rows[0].password).toBe(before);
  const exact = { ...observed };
  expect(await verify()).toMatchObject({ purpose: 'recovery', previousEpoch: 2 });
  expect(Date.parse((await verify())!.expiresAt)).toBeLessThanOrEqual(nativeExpiry.getTime());
  expect(await verifyInFreshProcess()).toEqual(await verify());
  service = await createAuthService(options);
  expect(await verify({ purpose: 'consent-reduction' })).toBeNull();
  expect((await complete(token, 'different intended password')).status).toBe(401);
  fail = null;
  const results = await Promise.all([complete(), complete()]);
  expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  expect(observed).toEqual(exact);
  expect(await verify()).toBeNull();
  const snapshot = async () => ({
    credential: (await database.query(`SELECT id,password,"updatedAt" FROM account WHERE "userId"='human'`)).rows,
    witness: (await database.query(`SELECT * FROM auth_recovery_establishment WHERE account_id='human'`)).rows,
    proof: (await database.query(`SELECT * FROM auth_recovery WHERE account_id='human'`)).rows,
    receipts: (await database.query('SELECT * FROM test_barrier ORDER BY key')).rows,
    clears: (await database.query('SELECT * FROM test_recovery_clear ORDER BY reference')).rows,
    floor: await options.trustedAccess.readRecoveryAccount!('human'),
  });
  const saved = await snapshot();
  expect((await complete()).status).toBe(200);
  expect(await snapshot()).toEqual(saved);
  expect(saved.witness).toHaveLength(1);
  expect(saved.clears).toHaveLength(1);
  expect(saved.proof.every((row) => row.consumed_operation !== null)).toBe(true);
  expect((await complete(token, 'different intended password')).status).toBe(401);
  expect((await login('human', changed)).length).toBeGreaterThan(0);
  const receipts = await database.query('SELECT * FROM auth_barrier_proof');
  expect(JSON.stringify(receipts.rows)).not.toContain(token);
  expect(JSON.stringify(receipts.rows)).not.toContain(changed);
});

test('stale native recovery epoch, absent verification, expired source and invalid Access receipt deny without credential effects', async () => {
  fail = null;
  let token = await start();
  await database.query("UPDATE test_access SET epoch=epoch+1 WHERE id='human'");
  const complete = () => request('/recovery/complete', { account_id: 'human', token, new_password: password });
  expect((await complete()).status).toBe(401);
  token = await start();
  await database.query('DELETE FROM verification');
  expect((await complete()).status).toBe(401);
  token = await start();
  await database.query(
    "UPDATE auth_recovery SET expires_at=now()-interval '1 second' WHERE consumed_operation IS NULL",
  );
  expect((await complete()).status).toBe(401);
  token = await start();
  fail = 'receipt';
  expect((await complete()).status).toBe(401);
  expect((await login('human', changed)).length).toBeGreaterThan(0);
  fail = null;
});

test('proof expiry follows the native session lifetime and a superseded consent revision cannot revive', async () => {
  const cookie = await login('other');
  expect((await request('/consent', { client_id: 'external', scope: ['read', 'write'] }, cookie)).status).toBe(200);
  await database.query(
    `UPDATE session SET "expiresAt"=statement_timestamp()+interval '90 seconds' WHERE "userId"='other'`,
  );
  fail = 'before';
  expect((await request('/consent', { client_id: 'external', scope: ['read'] }, cookie)).status).toBe(503);
  const proof = (await verify())!;
  const source = (
    await database.query(
      `SELECT s."expiresAt",p.evidence FROM auth_barrier_proof p
    JOIN session s ON s.id=p.evidence->>3 WHERE p.reference=$1`,
      [observed.reference],
    )
  ).rows[0];
  expect(Date.parse(proof.expiresAt)).toBeLessThanOrEqual(source.expiresAt.getTime());
  expect(source.evidence.slice(8)).toEqual([
    'external',
    ['read', 'write'],
    expect.any(String),
    ['read', 'write'],
    ['read'],
  ]);
  await database.query(`UPDATE session SET "authnEpoch"="authnEpoch"+1 WHERE id=$1`, [source.evidence[3]]);
  expect(await verify()).toBeNull();
  await database.query(`UPDATE session SET "authnEpoch"="authnEpoch"-1 WHERE id=$1`, [source.evidence[3]]);
  expect(await verify()).not.toBeNull();
  await database.query(
    `UPDATE auth_consent SET scopes=ARRAY['read'] WHERE account_id='other' AND client_id='external'`,
  );
  await database.query(
    `UPDATE auth_consent SET scopes=ARRAY['read','write'] WHERE account_id='other' AND client_id='external'`,
  );
  expect(await verify()).toBeNull();
  fail = null;
});

test('receipt insertion failure rolls back exact native consumption; absence alone cannot authorize a retry', async () => {
  const token = await start('other');
  const nativeId = (
    await database.query(`SELECT id FROM verification WHERE value='other' ORDER BY "createdAt" DESC,id DESC LIMIT 1`)
  ).rows[0].id;
  const complete = () => request('/recovery/complete', { account_id: 'other', token, new_password: changed });
  await database.query(
    `ALTER TABLE auth_barrier_proof ADD CONSTRAINT test_reject_recovery CHECK (purpose<>'recovery') NOT VALID`,
  );
  try {
    expect((await complete()).status).toBe(503);
  } finally {
    await database.query('ALTER TABLE auth_barrier_proof DROP CONSTRAINT test_reject_recovery');
  }
  expect((await database.query('SELECT id FROM verification WHERE id=$1', [nativeId])).rows).toHaveLength(1);
  expect(
    (await database.query(`SELECT consumed_operation FROM auth_recovery WHERE account_id='other'`)).rows[0]
      .consumed_operation,
  ).toBeNull();
  fail = 'before';
  expect((await complete()).status).toBe(503);
  expect(await verify()).not.toBeNull();
  expect((await database.query('SELECT id FROM verification WHERE id=$1', [nativeId])).rows).toHaveLength(0);
  expect(
    (await database.query(`SELECT consumed_verification_id FROM auth_recovery WHERE account_id='other'`)).rows[0]
      .consumed_verification_id,
  ).toBe(nativeId);
  await database.query('DELETE FROM auth_barrier_proof WHERE reference=$1', [observed.reference]);
  expect((await complete()).status).toBe(401);
  expect(await verify()).toBeNull();
  fail = null;
});

test('immutable evidence, rollback visibility, expiry and one bounded sweep fail closed', async () => {
  const connection = await database.connect();
  try {
    await connection.query('BEGIN');
    await connection.query(`INSERT INTO auth_barrier_proof(reference,account_id,purpose,previous_epoch,operation_key,digest,evidence,expires_at)
      SELECT repeat('a',64),account_id,purpose,previous_epoch,'rollback',digest,evidence,expires_at FROM auth_barrier_proof LIMIT 1`);
    expect(
      await createBarrierProofVerifier({ database }).verify('a'.repeat(64), { ...observed, operationKey: 'rollback' }),
    ).toBeNull();
    await connection.query('ROLLBACK');
    await expect(database.query("UPDATE auth_barrier_proof SET digest=repeat('0',64)")).rejects.toThrow();
    const tampered = (
      await database.query(`INSERT INTO auth_barrier_proof(reference,account_id,purpose,previous_epoch,operation_key,digest,evidence,expires_at)
      SELECT repeat('b',64),account_id,purpose,previous_epoch,'tampered',repeat('0',64),evidence,expires_at
      FROM auth_barrier_proof LIMIT 1 RETURNING account_id,purpose,previous_epoch`)
    ).rows[0];
    expect(
      await createBarrierProofVerifier({ database }).verify('b'.repeat(64), {
        accountId: tampered.account_id,
        purpose: tampered.purpose,
        previousEpoch: tampered.previous_epoch,
        operationKey: 'tampered',
      }),
    ).toBeNull();
    // Expired receipts can be introduced only by fixtures; real writers cap the lifetime.
    await database.query(`INSERT INTO auth_barrier_proof(reference,account_id,purpose,previous_epoch,operation_key,digest,evidence,created_at,expires_at)
      SELECT lpad(i::text,64,'0'),'human','recovery',1,'expired-'||i,repeat('0',64),'[]',now()-interval '10 minutes',now()-interval '9 minutes'
      FROM generate_series(1,4) i`);
    const verifier = createBarrierProofVerifier({ database });
    expect(
      await verifier.verify('0'.repeat(63) + '1', {
        accountId: 'human',
        purpose: 'recovery',
        previousEpoch: 1,
        operationKey: 'expired-1',
      }),
    ).toBeNull();
    for (const previousEpoch of [-1, 2147483648, Number.MAX_SAFE_INTEGER, NaN])
      expect(await verifier.verify(observed.reference, { ...observed, previousEpoch })).toBeNull();
    for (const limit of [0, 1001, 1.5, NaN]) await expect(verifier.sweep({ limit })).rejects.toThrow();
    expect(await verifier.sweep({ limit: 2 })).toEqual({ removed: 2, hasMore: true });
    expect(await verifier.sweep({ limit: 2 })).toEqual({ removed: 2, hasMore: false });
  } finally {
    await connection.query('ROLLBACK');
    connection.release();
  }
});
