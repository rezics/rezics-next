import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createAuthService, createBarrierProofVerifier, type AuthService, type TrustedAccessPorts } from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
import { Client, Pool } from 'pg';
import { createAuthDatabase } from '../support/auth-database.ts';
import { createAuthBarrierCapabilities } from '../../src/access/auth-barriers.ts';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import { createLifecycleInternals } from '../../src/access/lifecycle.ts';
import { createRecoveryCompletion } from '../../src/access/recovery-completion.ts';
import { newId, routeOf } from '../../src/route/route.ts';

async function cloneAuthDatabase(): Promise<{ url: string; close(): Promise<void> }> {
  const name = `auth_barriers_auth_${Bun.randomUUIDv7().replaceAll('-', '')}`;
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

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const lifecycle = createLifecycleInternals({
  pool,
  routeKey: new Uint8Array(32),
  provisioningEvidence: async () => null,
  recoveryEvidence: async () => null,
});
let fixture: Awaited<ReturnType<typeof cloneAuthDatabase>>;
let database: Pool;
let service: AuthService;
let barriers: ReturnType<typeof createAuthBarrierCapabilities>;
let access: TrustedAccessPorts;
let delivery = '';
let fail: 'before' | 'after' | null = null;
let failConsent: 'before' | 'after' | null = null;
let consent: Parameters<NonNullable<TrustedAccessPorts['invalidateAccount']>>[0];
let captured: Parameters<NonNullable<TrustedAccessPorts['authorizeRecovery']>>[0];
const issuer = 'https://native-barriers.test';
const password = 'correct horse battery staple';
const human = newId(913);
const other = newId(913);
const request = (path: string, body: unknown, cookie = '') =>
  service.handler(
    new Request(`${issuer}${path}`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    }),
  );
async function login(accountId = human) {
  const response = await request('/signin', { account_id: accountId, password, client_id: 'web', scope: ['read'] });
  expect(response.status).toBe(200);
  return response.headers
    .getSetCookie()
    .map((v) => v.split(';')[0])
    .join('; ');
}
async function floor() {
  return lifecycle.readFenceState(human);
}
async function startRecovery() {
  // Each scenario needs an independent delivery, outside the mail cooldown contract.
  await database.query('DELETE FROM auth_attempt_counter');
  delivery = '';
  expect((await request('/recovery/start', { email: `${human}@example.test` })).status).toBe(200);
  const deadline = Date.now() + 5000;
  while (!delivery && Date.now() < deadline) await Bun.sleep(5);
  expect(delivery).not.toBe('');
}

beforeAll(async () => {
  fixture = await cloneAuthDatabase();
  database = new Pool({ connectionString: fixture.url });
  barriers = createAuthBarrierCapabilities({ lifecycle, proofs: createBarrierProofVerifier({ database }) });
  access = {
    ...createAuthBindings({
      pool,
      ...createRecoveryCompletion({ pool, routeKey: new Uint8Array(32), auth: () => service }),
    }),
    ...barriers.trustedAccess,
  };
  const key = { ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)), kid: 'test' };
  service = await createAuthService({
    database,
    issuer,
    audience: 'https://api.test',
    secret: 'native-barrier-secret-at-least-32-bytes',
    signing: { activeKid: key.kid, privateKeys: [key] },
    trustedAccess: {
      ...access,
      async invalidateAccount(input) {
        consent = input;
        if (failConsent === 'before') throw new Error('Consent proof published before native command');
        const receipt = await access.invalidateAccount!(input);
        if (failConsent === 'after') throw new Error('Lost consent barrier acknowledgement');
        return receipt;
      },
      async authorizeRecovery(input) {
        captured = input;
        if (fail === 'before') throw new Error('Auth proof published before native command');
        const receipt = await access.authorizeRecovery!(input);
        if (fail === 'after') throw new Error('Lost acknowledgement after native commit');
        return receipt;
      },
    },
    recoveryDelivery: {
      async deliver({ token }) {
        delivery = token;
      },
    },
  });
  await service.internal.registerClient({ clientId: 'web', firstParty: true, scopes: ['read', 'write'] });
  await service.internal.registerClient({ clientId: 'external', firstParty: false, scopes: ['read', 'write'] });
  for (const id of [human, other]) {
    await pool.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','pending',$2)`,
      [routeOf(id), id],
    );
    // Provisioning is outside this barrier contract; native accounts remain the authority.
    const provisioningAccess = { ...access };
    delete provisioningAccess.readProvisioningAccount;
    const provisioning = await createAuthService({
      database,
      issuer,
      audience: 'https://api.test',
      secret: 'native-barrier-secret-at-least-32-bytes',
      signing: { activeKid: key.kid, privateKeys: [key] },
      trustedAccess: {
        ...provisioningAccess,
        readAccount: async (accountId) =>
          accountId === id ? { accountId, kind: 'actor', state: 'pending', authnEpoch: 1, automated: false } : null,
        authorizeProvisioning: async () => ({ accountId: id }),
      },
    });
    await provisioning.internal.provisionPassword({
      authorization: 'provisioning-fixture',
      email: `${id}@example.test`,
      password,
    });
    await pool.query(`UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2`, [routeOf(id), id]);
  }
}, 60_000);
afterAll(async () => {
  await pool.end();
  await database?.end();
  await fixture?.close();
});

test('native consent commits an exact floor barrier before Auth effects and sign-in resumes once Auth completes it', async () => {
  const cookie = await login();
  expect((await request('/consent', { client_id: 'external', scope: ['read', 'write'] }, cookie)).status).toBe(200);
  failConsent = 'after';
  expect((await request('/consent', { client_id: 'external', scope: ['read'] }, cookie)).status).toBe(503);
  expect(
    (await database.query('SELECT scopes FROM auth_consent WHERE account_id=$1 AND client_id=$2', [human, 'external']))
      .rows[0].scopes,
  ).toEqual(['read', 'write']);
  // Auth has not revoked this native session or reduced consent yet.
  expect((await request('/token', {}, cookie)).status).toBe(401);
  const exact = await barriers.invalidateAccount(consent);
  expect(await barriers.invalidateAccount(consent)).toEqual(exact);
  failConsent = null;
  expect((await request('/consent', { client_id: 'external', scope: ['read'] }, cookie)).status).toBe(200);
  expect(await floor()).toMatchObject({ minimumAuthnEpoch: '2', fenced: false });
  const state = (await floor())!;
  expect(await lifecycle.readFenceReceipt(human, state.receiptId!)).toMatchObject({
    accountId: human,
    minimumAuthnEpoch: '2',
  });
  expect((await request('/token', {}, cookie)).status).toBe(401);
  await login();
});

test('recovery binds consumed native proof, preserves fence on failed Auth work and replays exact native receipt', async () => {
  await lifecycle.raiseFence({ accountId: human, key: 'initial-recovery-fence' });
  await startRecovery();
  const complete = () => request('/recovery/complete', { account_id: human, token: delivery, new_password: password });
  const previous = Number((await floor())!.minimumAuthnEpoch);
  fail = 'after';
  expect((await complete()).status).toBe(503);
  expect(await floor()).toMatchObject({ minimumAuthnEpoch: String(previous + 1), fenced: true });
  const exact = await barriers.authorizeRecovery(captured);
  expect(exact).toEqual(await lifecycle.readFenceReceipt(human, exact!.receiptId));
  const concurrent = await Promise.all(Array.from({ length: 4 }, () => barriers.authorizeRecovery(captured)));
  expect(concurrent).toEqual(Array(4).fill(exact));
  const mismatches = [
    { ...exact!, receiptId: crypto.randomUUID() },
    { ...exact!, accountId: other },
    { ...exact!, minimumAuthnEpoch: String(previous + 2) },
  ];
  for (const mismatch of mismatches) {
    const invalid = createAuthBarrierCapabilities({
      lifecycle: { ...lifecycle, readFenceReceipt: async () => mismatch },
      proofs: createBarrierProofVerifier({ database }),
    });
    await expect(invalid.authorizeRecovery(captured)).rejects.toThrow();
  }
  for (const change of [
    { accountId: other },
    { proofEpoch: previous - 1 },
    { operationKey: 'wrong' },
    { proofReference: 'f'.repeat(64) },
  ])
    await expect(barriers.authorizeRecovery({ ...captured, ...change })).rejects.toThrow();
  await expect(
    barriers.invalidateAccount({ ...captured, previousEpoch: previous, reason: 'consent-reduction' }),
  ).rejects.toThrow();
  fail = null;
  expect((await complete()).status).toBe(200);
  expect(await floor()).toMatchObject({ minimumAuthnEpoch: String(previous + 1), fenced: false });
  await expect(barriers.authorizeRecovery(captured)).rejects.toThrow();
});

test('missing and unavailable proof capabilities deny before native mutation', async () => {
  const before = await floor();
  await expect(
    barriers.authorizeRecovery({ accountId: human, proofEpoch: Number(before!.minimumAuthnEpoch) }),
  ).rejects.toThrow();
  const unavailable = createAuthBarrierCapabilities({
    lifecycle,
    proofs: {
      verify: async () => {
        throw new Error('Auth unavailable');
      },
    },
  });
  await expect(
    unavailable.authorizeRecovery({
      accountId: human,
      proofEpoch: Number(before!.minimumAuthnEpoch),
      proofReference: 'a'.repeat(64),
      operationKey: 'untrusted',
    }),
  ).rejects.toThrow();
  expect(await floor()).toEqual(before);
});

test('native attempt denies changed eligibility, stale proof and later floor supersession', async () => {
  await lifecycle.raiseFence({ accountId: human, key: 'native-attempt-recovery-fence' });
  await startRecovery();
  fail = 'before';
  expect(
    (await request('/recovery/complete', { account_id: human, token: delivery, new_password: password })).status,
  ).toBe(503);
  const before = await floor();
  const proof = await createBarrierProofVerifier({ database }).verify(captured.proofReference!, {
    accountId: human,
    purpose: 'recovery',
    previousEpoch: captured.proofEpoch,
    operationKey: captured.operationKey!,
  });
  expect(proof).not.toBeNull();
  for (const [state, operator, fenced] of [
    ['suspended', null, true],
    ['active', other, true],
    ['active', null, false],
  ] as const) {
    await pool.query(
      'UPDATE access.account SET state=$3,operator_account_id=$4,authn_fenced=$5 WHERE route=$1 AND account_id=$2',
      [routeOf(human), human, state, operator, fenced],
    );
    await expect(barriers.authorizeRecovery(captured)).rejects.toThrow();
    expect((await floor())!.minimumAuthnEpoch).toBe(before!.minimumAuthnEpoch);
  }
  await pool.query(
    "UPDATE access.account SET state='active',operator_account_id=NULL,authn_fenced=true WHERE route=$1 AND account_id=$2",
    [routeOf(human), human],
  );
  const expiredAttempt = createLifecycleInternals({
    pool,
    routeKey: new Uint8Array(32),
    clock: () => new Date(Date.parse(proof!.expiresAt) + 1),
    provisioningEvidence: async () => null,
    recoveryEvidence: async () => null,
  });
  await expect(
    createAuthBarrierCapabilities({
      lifecycle: expiredAttempt,
      proofs: createBarrierProofVerifier({ database }),
    }).authorizeRecovery(captured),
  ).rejects.toThrow();
  expect(await floor()).toEqual(before);
  const first = { ...captured };
  await startRecovery();
  expect(
    (await request('/recovery/complete', { account_id: human, token: delivery, new_password: password })).status,
  ).toBe(503);
  const second = { ...captured };
  const competing = await Promise.allSettled([barriers.authorizeRecovery(first), barriers.authorizeRecovery(second)]);
  expect(competing.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(competing.filter((result) => result.status === 'rejected')).toHaveLength(1);
  expect((await floor())!.minimumAuthnEpoch).toBe(String(Number(before!.minimumAuthnEpoch) + 1));
  const winner = competing[0]!.status === 'fulfilled' ? first : second;
  const committed = await barriers.authorizeRecovery(winner);
  expect(committed).toEqual(await lifecycle.readFenceReceipt(human, committed!.receiptId));
  await lifecycle.raiseFence({ accountId: human, key: 'superseding-native-command' });
  const superseded = await floor();
  await expect(barriers.authorizeRecovery(winner)).rejects.toThrow();
  // The original proof remains real and valid in Auth; native compare rejects it.
  expect(await createBarrierProofVerifier({ database }).verify(first.proofReference!, proof!)).not.toBeNull();
  expect(await floor()).toEqual(superseded);
  fail = null;
});

test('a consent barrier advances the floor without taking over an already raised persistent fence', async () => {
  const original = (await lifecycle.raiseFence({ accountId: other, key: 'consent-existing-fence' })).value;
  // Isolated fixture toggles let a real authenticated consent receipt reach the
  // command while its persistent native fence is raised, without a new floor.
  await pool.query('UPDATE access.account SET authn_fenced=false WHERE route=$1 AND account_id=$2', [
    routeOf(other),
    other,
  ]);
  const cookie = await login(other);
  expect((await request('/consent', { client_id: 'external', scope: ['read', 'write'] }, cookie)).status).toBe(200);
  failConsent = 'before';
  expect((await request('/consent', { client_id: 'external', scope: ['read'] }, cookie)).status).toBe(503);
  await pool.query('UPDATE access.account SET authn_fenced=true WHERE route=$1 AND account_id=$2', [
    routeOf(other),
    other,
  ]);
  const receipt = await barriers.invalidateAccount(consent);
  expect(receipt!.minimumAuthnEpoch).toBe(String(Number(original.minimumAuthnEpoch) + 1));
  const kept = { fenced: true, receiptId: original.receiptId, minimumAuthnEpoch: receipt!.minimumAuthnEpoch };
  expect(await lifecycle.readFenceState(other)).toMatchObject(kept);
  // Auth completes the barrier with its own receipt; the fence it did not raise stays with its receipt.
  failConsent = null;
  await barriers.trustedAccess.completeBarrier({
    accountId: other,
    purpose: 'consent-reduction',
    operationKey: consent.operationKey!,
    receiptId: receipt!.receiptId,
    minimumAuthnEpoch: Number(receipt!.minimumAuthnEpoch),
  });
  expect(await lifecycle.readFenceState(other)).toMatchObject(kept);
});

test('barrier confirmation propagates an unavailable Access lifecycle and preserves genuine negative receipts', async () => {
  const input = {
    accountId: human,
    purpose: 'consent-reduction' as const,
    operationKey: 'unavailable-confirmation',
    receiptId: newId(routeOf(human)!),
    minimumAuthnEpoch: 1,
  };
  const failure = new Error('Access connection terminated unexpectedly');
  const before = await floor();
  const unavailable = createAuthBarrierCapabilities({
    lifecycle: {
      ...lifecycle,
      confirmBarrier: async () => {
        throw failure;
      },
    },
    proofs: createBarrierProofVerifier({ database }),
  });
  await expect(unavailable.trustedAccess.confirmBarrier(input)).rejects.toBe(failure);
  expect(await barriers.trustedAccess.confirmBarrier(input)).toBe(false);
  expect(await floor()).toEqual(before);
});

test('a failed Auth proof read propagates before any native barrier mutation', async () => {
  const failure = new Error('Auth unavailable');
  const before = await floor();
  const unavailable = createAuthBarrierCapabilities({
    lifecycle,
    proofs: {
      verify: async () => {
        throw failure;
      },
    },
  });
  await expect(
    unavailable.authorizeRecovery({
      accountId: human,
      proofEpoch: Number(before!.minimumAuthnEpoch),
      proofReference: 'a'.repeat(64),
      operationKey: 'unavailable-proof',
    }),
  ).rejects.toBe(failure);
  expect(await floor()).toEqual(before);
});
