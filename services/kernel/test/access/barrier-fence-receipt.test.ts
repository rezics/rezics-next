import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createAuthService, createBarrierProofVerifier, type AuthService, type TrustedAccessPorts } from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { testDatabase } from '../../../auth/scripts/database.ts';
import { createAuthBarrierCapabilities } from '../../src/access/auth-barriers.ts';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import { createLifecycleInternals } from '../../src/access/lifecycle.ts';
import { createRecoveryCompletion } from '../../src/access/recovery-completion.ts';
import { newId, routeOf } from '../../src/route/route.ts';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const lifecycle = createLifecycleInternals({
  pool,
  routeKey: new Uint8Array(32),
  provisioningEvidence: async () => null,
  recoveryEvidence: async () => null,
});
let fixture: ReturnType<typeof testDatabase>;
let database: Pool;
let service: AuthService;
let barriers: ReturnType<typeof createAuthBarrierCapabilities>;
let delivery = '';
// The trusted port hands Auth this receipt id instead of the one Access committed.
let replace: ((receiptId: string) => string) | null = null;
// Runs after Access committed a consent barrier and before the port returns it to Auth.
let afterAccess: (() => Promise<void>) | null = null;
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
const floor = (accountId = human) => lifecycle.readFenceState(accountId);
async function startRecovery() {
  await database.query('DELETE FROM auth_attempt_counter');
  delivery = '';
  expect((await request('/recovery/start', { email: `${human}@example.test` })).status).toBe(200);
  const deadline = Date.now() + 5000;
  while (!delivery && Date.now() < deadline) await Bun.sleep(5);
  expect(delivery).not.toBe('');
}
const scalar = async (text: string, values: unknown[]) => (await database.query(text, values)).rows[0];
// Every Auth effect of a barrier: granted consent, password, sessions and the receipts that record them.
async function authState(accountId: string) {
  return {
    consent: await scalar('SELECT scopes FROM auth_consent WHERE account_id=$1', [accountId]),
    password: await scalar(`SELECT password,"updatedAt" FROM account WHERE "userId"=$1 AND "providerId"='credential'`, [
      accountId,
    ]),
    sessions: (await scalar('SELECT count(*)::int AS count FROM session WHERE "userId"=$1', [accountId])).count,
    effects: (await scalar('SELECT count(*)::int AS count FROM auth_effect_receipt WHERE account_id=$1', [accountId]))
      .count,
    establishments: (
      await scalar('SELECT count(*)::int AS count FROM auth_recovery_establishment WHERE account_id=$1', [accountId])
    ).count,
    applied: (
      await scalar(
        'SELECT count(*)::int AS count FROM auth_barrier_proof WHERE account_id=$1 AND applied_at IS NOT NULL',
        [accountId],
      )
    ).count,
  };
}
async function reduce(cookie: string) {
  return request('/consent', { client_id: 'external', scope: ['read'] }, cookie);
}
async function broaden(accountId: string) {
  await database.query(
    `INSERT INTO auth_consent (account_id,client_id,scopes) VALUES ($1,'external',$2)
     ON CONFLICT (account_id,client_id) DO UPDATE SET scopes=EXCLUDED.scopes,pending_scopes=NULL,pending_reference=NULL`,
    [accountId, ['read', 'write']],
  );
}

beforeAll(async () => {
  fixture = testDatabase();
  database = new Pool({ connectionString: fixture.url });
  barriers = createAuthBarrierCapabilities({ lifecycle, proofs: createBarrierProofVerifier({ database }) });
  const access: TrustedAccessPorts = {
    ...createAuthBindings({
      pool,
      ...createRecoveryCompletion({ pool, routeKey: new Uint8Array(32), auth: () => service }),
    }),
    ...barriers.trustedAccess,
  };
  const key = { ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)), kid: 'test' };
  const options = {
    database,
    issuer,
    audience: 'https://api.test',
    secret: 'native-barrier-secret-at-least-32-bytes',
    signing: { activeKid: key.kid, privateKeys: [key] },
  };
  service = await createAuthService({
    ...options,
    trustedAccess: {
      ...access,
      async invalidateAccount(input) {
        const receipt = await access.invalidateAccount!(input);
        await afterAccess?.();
        return replace ? { ...receipt, receiptId: replace(receipt.receiptId) } : receipt;
      },
      async authorizeRecovery(input) {
        const receipt = await access.authorizeRecovery!(input);
        return replace ? { ...receipt, receiptId: replace(receipt.receiptId) } : receipt;
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
    const provisioningAccess = { ...access };
    delete provisioningAccess.readProvisioningAccount;
    const provisioning = await createAuthService({
      ...options,
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
  fixture?.close();
});

test('a committed consent reduction barrier advances the floor and fences the account before any Auth effect', async () => {
  const cookie = await login();
  await broaden(human);
  const before = await authState(human);
  const previous = Number((await floor())!.minimumAuthnEpoch);
  let observed = false;
  afterAccess = async () => {
    observed = true;
    // Access has committed; Auth has applied nothing yet.
    const state = (await floor())!;
    expect(state).toMatchObject({ fenced: true, minimumAuthnEpoch: String(previous + 1) });
    expect(await lifecycle.readFenceReceipt(human, state.receiptId!)).toMatchObject({
      accountId: human,
      minimumAuthnEpoch: String(previous + 1),
      kind: 'fence',
    });
    expect(await authState(human)).toEqual(before);
  };
  try {
    expect((await reduce(cookie)).status).toBe(200);
  } finally {
    afterAccess = null;
  }
  expect(observed).toBe(true);
  expect((await scalar('SELECT scopes FROM auth_consent WHERE account_id=$1', [human])).scopes).toEqual(['read']);
  // Auth completed the barrier with that receipt, so the account can sign in again at the new floor.
  expect(await floor()).toMatchObject({ fenced: false, minimumAuthnEpoch: String(previous + 1) });
  await login();
});

test('the fence clears only when Auth completes the barrier with that receipt', async () => {
  const cookie = await login();
  await broaden(human);
  const previous = Number((await floor())!.minimumAuthnEpoch);
  // Access commits the barrier, then Auth fails before it finishes.
  afterAccess = async () => {
    throw new Error('Auth stopped after the Access commit');
  };
  try {
    expect((await reduce(cookie)).status).toBe(503);
  } finally {
    afterAccess = null;
  }
  const fenced = (await floor())!;
  expect(fenced).toMatchObject({ fenced: true, minimumAuthnEpoch: String(previous + 1) });
  const completion = {
    accountId: human,
    purpose: 'consent-reduction' as const,
    operationKey: '',
    receiptId: fenced.receiptId!,
    minimumAuthnEpoch: previous + 1,
  };
  // The operation key Auth recorded for this barrier.
  completion.operationKey = (
    await scalar(
      `SELECT operation_key FROM auth_barrier_proof WHERE account_id=$1 AND purpose='consent-reduction'
      ORDER BY created_at DESC LIMIT 1`,
      [human],
    )
  ).operation_key;
  const access = barriers.trustedAccess;
  for (const wrong of [
    { receiptId: crypto.randomUUID() },
    { receiptId: newId(913) },
    { minimumAuthnEpoch: previous + 2 },
    { accountId: other },
    { operationKey: 'another-operation' },
    { purpose: 'recovery' as const },
  ]) {
    await expect(access.completeBarrier({ ...completion, ...wrong })).rejects.toThrow();
    expect(await floor()).toEqual(fenced);
  }
  // Auth finishes: its own retry applies the consent reduction and then completes the barrier.
  expect((await reduce(cookie)).status).toBe(200);
  expect(await floor()).toMatchObject({
    fenced: false,
    receiptId: fenced.receiptId,
    minimumAuthnEpoch: String(previous + 1),
  });
  // An exact repeat reads the committed completion; it neither raises nor clears anything else.
  await access.completeBarrier(completion);
  expect(await floor()).toMatchObject({ fenced: false, receiptId: fenced.receiptId });
  // A later fence is not this barrier's to clear; the repeat is still the committed completion.
  await lifecycle.raiseFence({ accountId: human, key: 'later-fence' });
  await access.completeBarrier(completion);
  expect((await floor())!.fenced).toBe(true);
  // Restore the unfenced fixture for the next scenario.
  await pool.query('UPDATE access.account SET authn_fenced=false WHERE route=$1 AND account_id=$2', [
    routeOf(human),
    human,
  ]);
});

test('Auth applies nothing for a consent barrier whose receipt Access does not confirm for that account and floor', async () => {
  const cookie = await login();
  await broaden(human);
  const before = await authState(human);
  const previous = Number((await floor())!.minimumAuthnEpoch);
  // A receipt id Access never committed, then a real receipt of another account and floor.
  const foreign = newId(913);
  for (const substitute of [() => crypto.randomUUID(), () => foreign]) {
    replace = substitute;
    try {
      expect((await reduce(cookie)).status).toBe(401);
    } finally {
      replace = null;
    }
    expect(await authState(human)).toEqual(before);
  }
  // Access committed the barrier and holds the fence; the confirmed retry finishes it.
  expect(await floor()).toMatchObject({ fenced: true, minimumAuthnEpoch: String(previous + 1) });
  expect((await reduce(cookie)).status).toBe(200);
  expect((await scalar('SELECT scopes FROM auth_consent WHERE account_id=$1', [human])).scopes).toEqual(['read']);
  expect(await floor()).toMatchObject({ fenced: false, minimumAuthnEpoch: String(previous + 1) });
});

test('a recovery whose receipt Access does not confirm changes no password session effect or establishment row', async () => {
  await login();
  await lifecycle.raiseFence({ accountId: human, key: 'recovery-fence' });
  await startRecovery();
  const complete = () => request('/recovery/complete', { account_id: human, token: delivery, new_password: password });
  const before = await authState(human);
  const previous = Number((await floor())!.minimumAuthnEpoch);
  expect(before.sessions).toBeGreaterThan(0);
  for (const substitute of [() => crypto.randomUUID(), () => newId(913)]) {
    replace = substitute;
    try {
      expect((await complete()).status).toBe(401);
    } finally {
      replace = null;
    }
    expect(await authState(human)).toEqual(before);
  }
  expect(await floor()).toMatchObject({ fenced: true, minimumAuthnEpoch: String(previous + 1) });
});

test('valid consent and recovery barriers still complete', async () => {
  // The recovery above committed its barrier in Access; its confirmed retry completes it.
  const before = await authState(human);
  const previous = Number((await floor())!.minimumAuthnEpoch);
  const complete = () => request('/recovery/complete', { account_id: human, token: delivery, new_password: password });
  expect((await complete()).status).toBe(200);
  const after = await authState(human);
  expect(after.sessions).toBe(0);
  expect(after.establishments).toBe(before.establishments + 1);
  expect(after.effects).toBe(before.effects + 1);
  expect(await floor()).toMatchObject({ fenced: false, minimumAuthnEpoch: String(previous) });
  // And a fresh consent reduction after recovery.
  const cookie = await login();
  await broaden(human);
  expect((await reduce(cookie)).status).toBe(200);
  expect(await floor()).toMatchObject({ fenced: false, minimumAuthnEpoch: String(previous + 1) });
});
