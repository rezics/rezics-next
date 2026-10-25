import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createAuthService, type AuthService } from '@rezics/auth';
import type { Pool, PoolClient } from 'pg';
import { exportJWK, generateKeyPair } from 'jose';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { createAccess } from '../../src/access/index.ts';
import { createNativeAccountBindings } from '../../src/access/native-account-bindings.ts';
import { createRegistrationProofBindings } from '../../src/access/registration-proof.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const issuer = 'https://credential-bridge.auth.test';
const password = 'credential bridge original password';
let db: GrowthDatabase;
let auth: AuthService;
let authPool: Pool;
let bindings: ReturnType<typeof createNativeAccountBindings>;
let revokeAfterConsume = false;
let sequence = 0;
const key = () => `bridge-${++sequence}`;
const request = (path: string, body: unknown, headers = new Headers()) =>
  auth.handler(
    new Request(`${issuer}${path}`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie: headers.get('cookie') ?? '' },
      body: JSON.stringify(body),
    }),
  );
const login = async (id: string, candidate = password) => {
  const response = await request('/signin', {
    email: `${id}@bridge.test`,
    password: candidate,
    client_id: 'bridge',
    scope: ['account:manage'],
  });
  expect(response.status).toBe(200);
  return new Headers({
    cookie: response.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; '),
  });
};
async function person() {
  const accountId = newId(0x9400 + sequence++);
  const handle = `credential_${sequence}`;
  const held = await bindings.internalLifecycle.reserveHandle({ accountId, handle, key: key() });
  const input = { accountId, handle, reservationId: held.value.reservationId, key: key() };
  const outcome = await bindings.internalLifecycle.createPending(input);
  const registration = createRegistrationProofBindings({ pool: db.pool, referenceKeys });
  const authorization = (await registration.createProvisioningReference({ input, outcome }))!;
  await auth.internal.provisionPassword({ authorization, email: `${accountId}@bridge.test`, password });
  // Setup only: credential approval, consumption, floor and mutation use production ports.
  await db.admin.query("UPDATE access.account SET state='active' WHERE account_id=$1", [accountId]);
  await bindings.operators.provisionManagementDefaults({ operatorAccountId: accountId, key: key() });
  return { accountId, headers: await login(accountId) };
}
const referenceKeys = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(94)]]) };
beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  migrateAuth(db.url);
  const access = createAccess({
    actions: new Map([['account:manage', { anonymous: false }]]),
    auth: {
      issuer,
      audience: 'https://bridge.api.test',
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async () => auth.handler(new Request(`${issuer}/.well-known/jwks.json`)),
    },
  });
  bindings = createNativeAccountBindings({
    pool: db.pool,
    access,
    actions: new Map([['account:manage', { anonymous: false }]]),
    routeKey: new Uint8Array(32).fill(95),
    referenceKeys,
    auth: () => auth,
    proofs: {
      provisioning: { resolve: async () => null } as never,
      barriers: { verify: async () => null } as never,
      workflow: {
        recordPending: async () => {},
        pendingReference: async () => null,
        provisioningEvidence: async () => null,
      },
    },
  });
  const pair = await generateKeyPair('ES256', { extractable: true });
  authPool = db.openPool({ max: 2 });
  auth = await createAuthService({
    database: authPool,
    issuer,
    audience: 'https://bridge.api.test',
    secret: 'credential-bridge-persistent-secret-32-bytes',
    signing: { activeKid: 'bridge', privateKeys: [{ ...(await exportJWK(pair.privateKey)), kid: 'bridge' }] },
    trustedAccess: {
      ...bindings.trustedAccess,
      async consumeAuthorization(input) {
        const opening = await bindings.trustedAccess.consumeAuthorization!(input);
        if (revokeAfterConsume) {
          revokeAfterConsume = false;
          await db.admin.query(
            "DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND action='account:manage'",
            [routeOf(input.human.account_id)!, input.human.account_id],
          );
        }
        return opening;
      },
    },
  });
  await auth.internal.registerClient({ clientId: 'bridge', firstParty: true, scopes: ['account:manage'] });
});
afterAll(async () => db?.close());
async function staged(
  subjectAccountId: string,
  headers: Headers,
  credential: Parameters<AuthService['internal']['stageCredentialEffect']>[0]['credential'],
) {
  const stage = await auth.internal.stageCredentialEffect({ key: key(), subjectAccountId, headers, credential });
  return { effectRef: stage.effectRef, key: stage.key, subjectAccountId, headers };
}
async function publicKey() {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const kid = key();
  return { kind: 'key' as const, kid, publicJwk: { ...(await exportJWK(pair.publicKey)), kid } };
}

test('installed native bindings approve and revalidate beside consume and floor', () => {
  for (const port of [
    'approveCredentialEffect',
    'revalidateCredentialEffect',
    'consumeAuthorization',
    'advanceCredentialFloor',
  ] as const)
    expect(typeof bindings.trustedAccess[port]).toBe('function');
});
test('own human set-password stages approves and applies through real Auth and installed native bindings', async () => {
  const human = await person();
  const input = await staged(human.accountId, human.headers, {
    kind: 'password',
    password: 'credential bridge new password',
  });
  const approval = await auth.internal.approveCredentialEffect(input);
  const applied = await auth.internal.applyCredentialEffect({ ...input, authorization: approval.reference });
  expect(applied.replayed).toBe(false);
  await expect(auth.internal.applyCredentialEffect({ ...input, authorization: approval.reference })).rejects.toThrow();
  await login(human.accountId, 'credential bridge new password');
  expect(
    (await db.admin.query('SELECT minimum_authn_epoch FROM access.account WHERE account_id=$1', [human.accountId]))
      .rows[0].minimum_authn_epoch,
  ).toBe('2');
});
test('automated key add through a narrowed operator opening applies once', async () => {
  const human = await person();
  const subject = await person();
  const hold = await bindings.operators.reserveResponsibility({
    operatorAccountId: human.accountId,
    subjectAccountId: subject.accountId,
    key: key(),
  });
  await bindings.operators.recordOperatorRelation({
    ...hold.value,
    expectedOperatorAccountId: null,
    expectedVersion: '0',
    key: key(),
  });
  const credential = await publicKey();
  const input = await staged(subject.accountId, human.headers, credential);
  const approval = await auth.internal.approveCredentialEffect(input);
  expect((await auth.internal.applyCredentialEffect({ ...input, authorization: approval.reference })).replayed).toBe(
    false,
  );
  expect((await auth.internal.applyCredentialEffect({ ...input, authorization: approval.reference })).replayed).toBe(
    true,
  );
  expect(
    (await db.admin.query('SELECT kid FROM auth_public_key WHERE account_id=$1', [subject.accountId])).rows,
  ).toEqual([{ kid: credential.kid }]);
  expect(
    (
      await db.admin.query(
        'SELECT credential_purpose,consumed_at FROM access.operator_opening_receipt WHERE subject_account_id=$1',
        [subject.accountId],
      )
    ).rows[0],
  ).toMatchObject({ credential_purpose: 'add-key', consumed_at: expect.any(Date) });
});
test('revalidation after revocation spends the opening without mutation', async () => {
  const human = await person();
  const credential = await publicKey();
  const input = await staged(human.accountId, human.headers, credential);
  const approval = await auth.internal.approveCredentialEffect(input);
  revokeAfterConsume = true;
  await expect(auth.internal.applyCredentialEffect({ ...input, authorization: approval.reference })).rejects.toThrow();
  expect((await db.admin.query('SELECT kid FROM auth_public_key WHERE account_id=$1', [human.accountId])).rows).toEqual(
    [],
  );
  expect(
    (
      await db.admin.query(
        "SELECT consumed_at FROM access.workflow_approval WHERE actor_id=$1 AND operation->>'kind'='credential'",
        [human.accountId],
      )
    ).rows[0].consumed_at,
  ).not.toBeNull();
  await bindings.operators.provisionManagementDefaults({ operatorAccountId: human.accountId, key: key() });
  await expect(auth.internal.applyCredentialEffect({ ...input, authorization: approval.reference })).rejects.toThrow();
});
test('replay discloses only the saved result and never reopens after lost acknowledgement', async () => {
  const human = await person();
  const input = await staged(human.accountId, human.headers, await publicKey());
  const approval = await auth.internal.approveCredentialEffect(input);
  const appliedInput = { ...input, authorization: approval.reference };
  // Drop the actual Auth COMMIT acknowledgement after PostgreSQL committed it.
  const originals = new Map<PoolClient, PoolClient['query']>();
  let lost = false;
  const intercept = (client: PoolClient) => {
    if (originals.has(client)) return;
    const query = client.query.bind(client);
    originals.set(client, client.query);
    let effect = false;
    client.query = ((...args: Parameters<typeof query>) => {
      const raw = args[0] as string | { text: string };
      const sql = typeof raw === 'string' ? raw : raw.text;
      if (sql.includes('UPDATE auth_effect_receipt SET opening_receipt_id')) effect = true;
      const pending = (query as (...values: unknown[]) => Promise<unknown>)(...args);
      return effect && sql === 'COMMIT' && !lost
        ? pending.then(() => {
            lost = true;
            throw new Error('lost effect acknowledgement');
          })
        : pending;
    }) as typeof client.query;
  };
  authPool.on('acquire', intercept);
  try {
    await expect(auth.internal.applyCredentialEffect(appliedInput)).rejects.toThrow('lost effect acknowledgement');
  } finally {
    authPool.off('acquire', intercept);
    for (const [client, query] of originals) client.query = query;
  }
  expect(lost).toBe(true);
  const before = (await db.admin.query('SELECT * FROM auth_public_key WHERE account_id=$1', [human.accountId])).rows;
  const saved = await auth.internal.applyCredentialEffect(appliedInput);
  expect(saved.replayed).toBe(true);
  expect((await db.admin.query('SELECT * FROM auth_public_key WHERE account_id=$1', [human.accountId])).rows).toEqual(
    before,
  );
  await db.admin.query("DELETE FROM access.resource_grant WHERE resource_id=$1 AND action='account:manage'", [
    human.accountId,
  ]);
  await expect(auth.internal.applyCredentialEffect(appliedInput)).rejects.toThrow();
});
test('each of the four purposes refuses substitution for every other purpose', async () => {
  const human = await person();
  const existing = await publicKey();
  const install = await staged(human.accountId, human.headers, existing);
  const installed = await auth.internal.approveCredentialEffect(install);
  await auth.internal.applyCredentialEffect({ ...install, authorization: installed.reference });
  const inputs = [];
  for (const credential of [
    { kind: 'password' as const, password: 'another bridge password' },
    { kind: 'password' as const, password: null },
    await publicKey(),
    { kind: 'key' as const, kid: existing.kid, remove: true as const },
  ])
    inputs.push(await staged(human.accountId, human.headers, credential));
  for (let i = 0; i < inputs.length; i++) {
    const approval = await auth.internal.approveCredentialEffect(inputs[i]!);
    for (let j = 0; j < inputs.length; j++)
      if (i !== j)
        await expect(
          auth.internal.applyCredentialEffect({ ...inputs[j]!, authorization: approval.reference }),
        ).rejects.toThrow();
  }
});
