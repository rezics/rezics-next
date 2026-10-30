import { setFixtureAccountState } from '../support/native-suspension-driver.ts';
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { Pool, type QueryConfig } from 'pg';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAuthService, type SessionProof, type TrustedAccessPorts } from '@rezics/auth';
import { routeOf } from '../../src/route/route.ts';
import { readAccount } from '../../src/access/account-data.ts';
import {
  createAuthBindings,
  AuthBindingDeniedError,
  AuthBindingUnavailableError,
  type AuthBindingCapabilities,
  type AuthAuthorizationReceipt,
} from '../../src/access/auth-bindings.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new Pool({ connectionString: url });
const human = '00000000-0000-7000-8000-123400000001';
const subject = '00000000-0000-7000-8000-abcd00000002';
const organization = '00000000-0000-7000-8000-ffff00000003';
const receiptId = '00000000-0000-8000-8000-abcd00000004';
const ports: TrustedAccessPorts = createAuthBindings({ pool });
const proof: SessionProof = {
  account_id: human,
  client_id: 'web',
  scope: ['read'],
  authn_epoch: 1,
  auth_time: 1,
  amr: ['pwd'],
};
const input = {
  authorization: 'durable-reference',
  subjectAccountId: subject,
  purpose: 'session' as const,
  human: proof,
};

async function update(id: string, fields: string, values: unknown[] = []) {
  await pool.query(`UPDATE access.account SET ${fields} WHERE route=$1 AND account_id=$2`, [
    routeOf(id),
    id,
    ...values,
  ]);
}
beforeEach(async () => {
  await pool.query('DELETE FROM access.account');
  for (const [id, kind] of [
    [human, 'actor'],
    [subject, 'actor'],
    [organization, 'organization'],
  ])
    await pool.query(
      `INSERT INTO access.account (route,account_id,kind,state,transaction_id) VALUES ($1,$2,$3,'active',$2)`,
      [routeOf(id!), id, kind],
    );
  await update(subject, 'operator_account_id=$3', [organization]);
});
afterAll(() => pool.end());

test('binding denial is a forbidden outcome while missing capabilities remain unavailable', async () => {
  const denied = createAuthBindings({ pool, consumeAuthAuthorization: async () => null });
  await expect(denied.consumeAuthorization!(input)).rejects.toMatchObject({
    name: 'AuthBindingDeniedError',
    status: 403,
  });
  const unavailable = new AuthBindingUnavailableError('consumeAuthAuthorization');
  expect('status' in unavailable).toBe(false);
  await expect(ports.consumeAuthorization!(input)).rejects.toBeInstanceOf(AuthBindingUnavailableError);
});

test('ordinary reads translate the real account anchor once and retain stored kind and operator relation', async () => {
  const queries: QueryConfig[] = [];
  const counted = Object.create(pool) as Pool;
  counted.query = ((query: QueryConfig) => {
    queries.push(query);
    return pool.query(query);
  }) as Pool['query'];
  const bindings = createAuthBindings({ pool: counted });
  expect(await bindings.readAccount(subject)).toEqual({
    accountId: subject,
    kind: 'actor',
    state: 'active',
    authnEpoch: 1,
    automated: true,
    fenced: false,
  });
  const anchored = queries.filter((query) => query.text.includes('FROM access.account'));
  expect(anchored).toHaveLength(1);
  expect(anchored[0]!.values).toEqual([routeOf(subject), subject]);
  expect(await bindings.readAccount(human)).toMatchObject({ kind: 'actor', automated: false });
  expect(await bindings.readAccount(organization)).toMatchObject({ kind: 'organization', automated: false });
  for (const id of ['invalid', subject.toUpperCase(), receiptId]) expect(await bindings.readAccount(id)).toBeNull();
  for (const state of ['pending', 'suspended', 'deleted']) {
    await setFixtureAccountState(pool, human, state);
    expect(await bindings.readAccount(human)).toBeNull();
    expect(await bindings.readRecoveryAccount!(human)).toBeNull();
  }
});

test('bigint floors cross the Auth number boundary only at exact safe precision; outages deny reads', async () => {
  await update(human, 'minimum_authn_epoch=$3', [String(Number.MAX_SAFE_INTEGER)]);
  expect(await ports.readAccount(human)).toMatchObject({ authnEpoch: Number.MAX_SAFE_INTEGER });
  for (const floor of ['9007199254740992', '9007199254740993', '9223372036854775807']) {
    await update(human, 'minimum_authn_epoch=$3', [floor]);
    expect((await readAccount(pool, routeOf(human)!, human))!.minimumAuthnEpoch).toBe(BigInt(floor));
    expect(await ports.readAccount(human)).toBeNull();
    expect(await ports.readRecoveryAccount!(human)).toBeNull();
  }
  const unavailable = new Pool({ connectionString: url });
  await unavailable.end();
  expect(await createAuthBindings({ pool: unavailable }).readAccount(subject)).toBeNull();
});

test('only the recovery read exposes a fenced active human, never an automated actor or organization', async () => {
  for (const id of [human, subject, organization]) await update(id, 'authn_fenced=true, minimum_authn_epoch=2');
  expect(await ports.readAccount(human)).toBeNull();
  expect(await ports.readAccount(subject)).toBeNull();
  expect(await ports.readRecoveryAccount!(human)).toEqual({
    accountId: human,
    kind: 'actor',
    state: 'active',
    authnEpoch: 2,
    automated: false,
    fenced: true,
  });
  expect(await ports.readRecoveryAccount!(subject)).toBeNull();
  expect(await ports.readRecoveryAccount!(organization)).toBeNull();
});

test('absent coordinator capabilities throw named unavailable errors and never change Access', async () => {
  await expect(ports.authorizeProvisioning(human)).rejects.toBeInstanceOf(AuthBindingUnavailableError);
  await expect(ports.consumeAuthorization!(input)).rejects.toBeInstanceOf(AuthBindingUnavailableError);
  await expect(
    ports.invalidateAccount!({ accountId: human, previousEpoch: 1, reason: 'consent-reduction' }),
  ).rejects.toBeInstanceOf(AuthBindingUnavailableError);
  await expect(ports.authorizeRecovery!({ accountId: human, proofEpoch: 1 })).rejects.toBeInstanceOf(
    AuthBindingUnavailableError,
  );
  expect(await readAccount(pool, routeOf(human)!, human)).toMatchObject({ minimumAuthnEpoch: 1n, fenced: false });
});

test('provisioning verifier must resolve a live native registration receipt on its real account', async () => {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  await update(human, "state='pending', registration_id=$3, registration_expires_at=$4", [receiptId, expiresAt]);
  const registration = { accountId: human, registrationId: receiptId, expiresAt };
  const bindings = createAuthBindings({
    pool,
    verifyProvisioningReceipt: async (reference) => {
      expect(reference).toBe('registration-command');
      return registration;
    },
  });
  expect(await bindings.authorizeProvisioning('registration-command')).toEqual({ accountId: human });
  for (const bad of [
    null,
    { ...registration, accountId: subject },
    { ...registration, registrationId: human },
    { ...registration, expiresAt: '2000-01-01' },
  ]) {
    await expect(
      createAuthBindings({ pool, verifyProvisioningReceipt: async () => bad }).authorizeProvisioning('forged'),
    ).rejects.toBeInstanceOf(AuthBindingDeniedError);
  }
  await update(human, 'authn_fenced=true');
  await expect(bindings.authorizeProvisioning('registration-command')).rejects.toBeInstanceOf(AuthBindingDeniedError);
});

function authorization(): AuthAuthorizationReceipt {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  return {
    authorization: {
      receiptId,
      subjectAccountId: subject,
      actingHumanId: human,
      operatorAccountId: organization,
      purpose: 'session',
      clientId: proof.client_id,
      scopes: [...proof.scope],
      humanEpoch: 1,
      subjectEpoch: 1,
      expiresAt,
    },
    operatorOpening: {
      receiptId,
      subjectAccountId: subject,
      actingHumanId: human,
      operatorAccountId: organization,
      purpose: 'session',
      clientId: proof.client_id,
      scopes: [...proof.scope],
      requestedBy: null,
      reservationId: receiptId,
      version: '1',
      expiresAt,
    },
  };
}

test('effect seam preserves the verified human evidence and denies malformed binding or broad purpose substitution', async () => {
  // Callback receipts test the structural seam only, not product authorization.
  const value = authorization();
  const capabilities: AuthBindingCapabilities = {
    consumeAuthAuthorization: async (actual) => {
      expect(actual).toBe(input);
      expect(actual.human).toBe(proof);
      return value;
    },
  };
  expect(await createAuthBindings({ pool, ...capabilities }).consumeAuthorization!(input)).toEqual(value.authorization);
  for (const patch of [
    { subjectAccountId: human },
    { purpose: 'add-key' as const },
    { actingHumanId: subject },
    { humanEpoch: 2 },
    { subjectEpoch: 2 },
    { operatorAccountId: human },
    { clientId: 'forged' },
    { scopes: ['admin'] },
    { receiptId: '' },
    { expiresAt: '2000-01-01' },
  ]) {
    const bad = authorization();
    Object.assign(bad.authorization, patch);
    await expect(
      createAuthBindings({ pool, consumeAuthAuthorization: async () => bad }).consumeAuthorization!(input),
    ).rejects.toBeInstanceOf(AuthBindingDeniedError);
  }
  for (const opening of [
    null,
    { ...value.operatorOpening!, purpose: 'credential-management' as const },
    { ...value.operatorOpening!, requestedBy: human },
    { ...value.operatorOpening!, receiptId: human },
  ]) {
    await expect(
      createAuthBindings({ pool, consumeAuthAuthorization: async () => ({ ...value, operatorOpening: opening }) })
        .consumeAuthorization!(input),
    ).rejects.toBeInstanceOf(AuthBindingDeniedError);
  }
  await update(human, 'authn_fenced=true');
  await expect(createAuthBindings({ pool, ...capabilities }).consumeAuthorization!(input)).rejects.toBeInstanceOf(
    AuthBindingDeniedError,
  );
});

test('barriers require a committed exact higher floor for the same account and retain fences', async () => {
  const native = { receiptId, accountId: human, minimumAuthnEpoch: '2', kind: 'fence', priorOperatorAccountId: null };
  const request = { accountId: human, previousEpoch: 1, reason: 'consent-reduction' as const };
  for (const bad of [
    null,
    native,
    { ...native, accountId: subject },
    { ...native, minimumAuthnEpoch: '9007199254740993' },
  ])
    await expect(
      createAuthBindings({ pool, invalidateAccount: async () => bad }).invalidateAccount!(request),
    ).rejects.toBeInstanceOf(AuthBindingDeniedError);
  await update(human, 'authn_fenced=true');
  const barrier: AuthBindingCapabilities['authorizeRecovery'] = async (actual) => {
    expect(actual).toEqual({ accountId: human, proofEpoch: 1 });
    await update(human, 'minimum_authn_epoch=2');
    return native;
  };
  expect(
    await createAuthBindings({ pool, authorizeRecovery: barrier }).authorizeRecovery!({
      accountId: human,
      proofEpoch: 1,
    }),
  ).toEqual({ receiptId, accountId: human, minimumAuthnEpoch: 2 });
  expect(await ports.readAccount(human)).toBeNull();
  expect(await ports.readRecoveryAccount!(human)).toMatchObject({ authnEpoch: 2, fenced: true });
  await expect(
    createAuthBindings({ pool, authorizeRecovery: barrier }).authorizeRecovery!({ accountId: human, proofEpoch: 1 }),
  ).rejects.toBeInstanceOf(AuthBindingDeniedError);
});

test('real Auth cannot establish a native session for a fenced Access identity', async () => {
  const name = `auth_bindings_${process.pid}`;
  const authUrl = new URL(url);
  authUrl.pathname = `/${name}`;
  await pool.query(`CREATE DATABASE ${name}`);
  const authPool = new Pool({ connectionString: authUrl.toString() });
  try {
    const { migrate } = await import(new URL('../../../auth/scripts/database.ts', import.meta.url).href);
    migrate(authUrl.toString());
    const key = await generateKeyPair('ES256', { extractable: true });
    const privateKey = { ...(await exportJWK(key.privateKey)), kid: 'binding-key', alg: 'ES256' };
    const publicKey = { ...(await exportJWK(key.publicKey)), kid: 'binding-key', alg: 'ES256' };
    // Privileged native credential fixture; no callback can authorize the sign-in.
    await authPool.query(`INSERT INTO "user" (id,name,"emailVerified") VALUES ($1,'',false)`, [human]);
    await authPool.query('INSERT INTO auth_public_key VALUES ($1,$2,$3)', [human, 'binding-key', publicKey]);
    const issuer = 'https://bindings.auth.test';
    const service = await createAuthService({
      database: authPool,
      issuer,
      audience: 'https://bindings.api.test',
      secret: 'test-auth-binding-secret-with-at-least-32-bytes',
      signing: { activeKid: privateKey.kid, privateKeys: [privateKey] },
      trustedAccess: ports,
    });
    await service.internal.registerClient({ clientId: 'web', firstParty: true, scopes: ['read'] });
    async function signin() {
      const assertion = await new SignJWT({})
        .setProtectedHeader({ alg: 'ES256', kid: 'binding-key' })
        .setIssuer(human)
        .setSubject(human)
        .setAudience(`${issuer}/token`)
        .setIssuedAt()
        .setExpirationTime('60s')
        .setJti(crypto.randomUUID())
        .sign(key.privateKey);
      return service.handler(
        new Request(`${issuer}/signin/key`, {
          method: 'POST',
          headers: { origin: issuer, 'content-type': 'application/json' },
          body: JSON.stringify({ account_id: human, assertion, client_id: 'web', scope: ['read'] }),
        }),
      );
    }
    expect((await signin()).status).toBe(200);
    const before = await authPool.query('SELECT id FROM session');
    expect(before.rows).toHaveLength(1);
    await update(human, 'authn_fenced=true');
    expect((await signin()).status).toBe(401);
    expect((await authPool.query('SELECT id FROM session')).rows).toEqual(before.rows);
  } finally {
    await authPool.end();
    await dropTestDatabase(pool, name);
  }
}, 60_000);
