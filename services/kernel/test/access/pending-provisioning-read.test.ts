import { reinstateAccount, suspendAccount } from '../support/native-suspension-driver.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool, type QueryConfig } from 'pg';
import { exportJWK, generateKeyPair } from 'jose';
import { createAuthService } from '@rezics/auth';
import {
  createAuthBindings,
  AuthBindingDeniedError,
  type AuthProvisioningReceipt,
} from '../../src/access/auth-bindings.ts';
import { createLifecycleInternals } from '../../src/access/lifecycle.ts';
import { createRegistrationProofBindings } from '../../src/access/registration-proof.ts';
import { readPublicAccount } from '../../src/access/account-data.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { seal, unseal } from '../../src/tokens/seal.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new Pool({ connectionString: url });
let receipt: AuthProvisioningReceipt;
const reference = 'pending-command';
const internal = createLifecycleInternals({
  pool,
  routeKey: new Uint8Array(32).fill(39),
  provisioningEvidence: async () => null,
  recoveryEvidence: async () => null,
});
const referenceKeys = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(73)]]) };
const nativeProof = createRegistrationProofBindings({ pool, referenceKeys });
const nativeBindings = createAuthBindings({ pool, ...nativeProof });
let nativeReference: string;
// This capability fixture checks the seam, not full committed receipt provenance.
const verifyProvisioningReceipt = async (value: string) => (value === reference ? receipt : null);
const bindings = createAuthBindings({ pool, verifyProvisioningReceipt });
async function update(fields: string, values: unknown[] = []) {
  await pool.query(`UPDATE access.account SET ${fields} WHERE route=$1 AND account_id=$2`, [
    routeOf(receipt.accountId),
    receipt.accountId,
    ...values,
  ]);
}
beforeAll(async () => {
  const accountId = internal.registrationTarget(reference);
  const claim = await internal.reserveHandle({ accountId, handle: 'pending-reader', key: reference });
  const input = {
    accountId,
    handle: 'pending-reader',
    reservationId: claim.value.reservationId,
    key: reference,
  };
  const outcome = await internal.createPending(input);
  receipt = outcome.value;
  nativeReference = (await nativeProof.createProvisioningReference({ input, outcome }))!;
  expect(nativeReference).toBeString();
});
afterAll(() => pool.end());

test('native pending identity is private and only its exact approved registration can be read', async () => {
  expect(await bindings.authorizeProvisioning(reference)).toEqual({ accountId: receipt.accountId });
  expect(await nativeBindings.readProvisioningAccount!(receipt.accountId, nativeReference)).toMatchObject({
    accountId: receipt.accountId,
    registrationId: receipt.registrationId,
    expiresAt: receipt.expiresAt,
  });
  for (const bad of ['', receipt.accountId, `${nativeReference}x`])
    expect(await nativeBindings.readProvisioningAccount!(receipt.accountId, bad)).toBeNull();
  const scope = 'access.registration-proof.v1';
  const payload = unseal(referenceKeys, scope, nativeReference) as Record<string, unknown>;
  for (const patch of [
    { key: 'missing-receipt' },
    { reservationId: newId(1) },
    { expiresAt: '2000-01-01T00:00:00.000Z' },
  ])
    expect(
      await nativeBindings.readProvisioningAccount!(
        receipt.accountId,
        seal(referenceKeys, scope, { ...payload, ...patch }),
      ),
    ).toBeNull();
  expect(await bindings.readAccount(receipt.accountId)).toBeNull();
  expect(await readPublicAccount(pool, routeOf(receipt.accountId)!, receipt.accountId)).toBeNull();
  expect(await bindings.readProvisioningAccount!(receipt.accountId, reference)).toEqual({
    accountId: receipt.accountId,
    kind: 'actor',
    state: 'pending',
    authnEpoch: 1,
    automated: false,
    fenced: false,
    registrationId: receipt.registrationId,
    expiresAt: receipt.expiresAt,
  });
  for (const command of ['', 'missing', receipt.accountId])
    expect(await bindings.readProvisioningAccount!(receipt.accountId, command)).toBeNull();
  expect(await bindings.readProvisioningAccount!(newId(routeOf(receipt.accountId)!), reference)).toBeNull();
  expect(await createAuthBindings({ pool }).readProvisioningAccount!(receipt.accountId, reference)).toBeNull();
  for (const bad of [
    null,
    { ...receipt, registrationId: newId(1) },
    { ...receipt, expiresAt: '2000-01-01' },
    { ...receipt, expiresAt: new Date(Date.now() + 5000).toISOString() },
  ])
    expect(
      await createAuthBindings({ pool, verifyProvisioningReceipt: async () => bad }).readProvisioningAccount!(
        receipt.accountId,
        reference,
      ),
    ).toBeNull();
});

test('current native lifecycle, relation and exact epoch floor govern the provisioning read', async () => {
  for (const fields of [
    "state='active'",
    "state='suspended'",
    "state='deleted'",
    'authn_fenced=true',
    'registration_id=NULL',
    'registration_expires_at=NULL',
    "registration_expires_at='2000-01-01'",
    "registration_expires_at=registration_expires_at + interval '1 microsecond'",
  ]) {
    if (fields === "state='suspended'") {
      await update("state='active'");
      await suspendAccount(pool, receipt.accountId);
    } else await update(fields);
    expect(await bindings.readProvisioningAccount!(receipt.accountId, reference)).toBeNull();
    if (fields === "state='suspended'") await reinstateAccount(pool, receipt.accountId);
    await update("state='pending', authn_fenced=false, registration_id=$3, registration_expires_at=$4", [
      receipt.registrationId,
      receipt.expiresAt,
    ]);
  }
  await update('operator_account_id=$3', [newId(2)]);
  expect(await bindings.readProvisioningAccount!(receipt.accountId, reference)).toMatchObject({
    kind: 'actor',
    automated: true,
  });
  await expect(bindings.authorizeProvisioning(reference)).rejects.toBeInstanceOf(AuthBindingDeniedError);
  await update('operator_account_id=NULL, minimum_authn_epoch=$3', [String(Number.MAX_SAFE_INTEGER)]);
  expect(await bindings.readProvisioningAccount!(receipt.accountId, reference)).toMatchObject({
    authnEpoch: Number.MAX_SAFE_INTEGER,
  });
  await update('minimum_authn_epoch=$3', ['9007199254740993']);
  expect(await bindings.readProvisioningAccount!(receipt.accountId, reference)).toBeNull();
});

test('adapter growth adds exactly two same-anchor point reads and constant rows at three native fixture sizes', async () => {
  const observations: Array<{ query: QueryConfig; rows: number }> = [];
  const counted = Object.create(pool) as Pool;
  counted.query = (async (query: QueryConfig) => {
    const result = await pool.query(query);
    observations.push({ query, rows: result.rows.length });
    return result;
  }) as Pool['query'];
  let verifications = 0;
  const reader = createAuthBindings({
    pool: counted,
    verifyProvisioningReceipt: async (command) => {
      verifications++;
      return verifyProvisioningReceipt(command);
    },
  });
  // A fresh pending account avoids the intentionally irreversible epoch increase above.
  const original = receipt;
  const id = newId(routeOf(receipt.accountId)!);
  receipt = { ...receipt, accountId: id };
  await pool.query(
    `INSERT INTO access.account (route,account_id,kind,state,transaction_id,registration_id,registration_expires_at)
    VALUES ($1,$2,'actor','pending',$2,$3,$4)`,
    [routeOf(id), id, receipt.registrationId, receipt.expiresAt],
  );
  try {
    for (const size of [10, 100, 1000]) {
      const ids = Array.from({ length: size }, () => newId(routeOf(id)!));
      await pool.query(
        `INSERT INTO access.account (route,account_id,kind,state,transaction_id)
        SELECT $1,id,'actor','active',id FROM unnest($2::uuid[]) AS id`,
        [routeOf(id), ids],
      );
      observations.length = 0;
      verifications = 0;
      expect(await reader.readProvisioningAccount!(id, reference)).toMatchObject({ accountId: id });
      expect(verifications).toBe(1);
      expect(observations).toHaveLength(2);
      for (const { query, rows } of observations) {
        expect(query.values?.slice(0, 2)).toEqual([routeOf(id), id]);
        expect(query.text).toContain('WHERE route = $1 AND account_id = $2');
        expect(rows).toBe(1);
      }
    }
  } finally {
    receipt = original;
  }
});

test('real Auth provisions through the concrete pending reader without ordinary pending visibility', async () => {
  const name = `pending_auth_${process.pid}`;
  const authUrl = new URL(url);
  authUrl.pathname = `/${name}`;
  await pool.query(`CREATE DATABASE ${name}`);
  const authPool = new Pool({ connectionString: authUrl.href });
  try {
    const { migrate } = await import(new URL('../../../auth/scripts/database.ts', import.meta.url).href);
    migrate(authUrl.href);
    const key = await generateKeyPair('ES256', { extractable: true });
    const privateKey = { ...(await exportJWK(key.privateKey)), kid: 'pending-key', alg: 'ES256' };
    const keyReference = 'auth-pending-command';
    const accountId = internal.registrationTarget(keyReference);
    const claim = await internal.reserveHandle({ accountId, handle: 'auth-pending-reader', key: keyReference });
    const input = {
      accountId,
      handle: 'auth-pending-reader',
      key: keyReference,
      reservationId: claim.value.reservationId,
    };
    const outcome = await internal.createPending(input);
    const authorization = (await nativeProof.createProvisioningReference({ input, outcome }))!;
    const service = await createAuthService({
      database: authPool,
      issuer: 'https://pending.auth.test',
      audience: 'https://pending.api.test',
      secret: 'pending-reader-test-secret-at-least-32-bytes',
      signing: { activeKid: privateKey.kid, privateKeys: [privateKey] },
      trustedAccess: nativeBindings,
    });
    expect(await nativeBindings.readAccount(accountId)).toBeNull();
    expect(
      await service.internal.provisionPassword({
        authorization,
        email: 'pending@example.test',
        password: 'correct horse battery staple',
      }),
    ).toEqual({ accountId });
    expect((await authPool.query('SELECT id FROM "user" WHERE id=$1', [accountId])).rows).toEqual([{ id: accountId }]);
    expect(
      (
        await authPool.query(`SELECT "userId" FROM account WHERE "userId"=$1 AND "providerId"='credential'`, [
          accountId,
        ])
      ).rows,
    ).toEqual([{ userId: accountId }]);
    expect(await nativeBindings.readAccount(accountId)).toBeNull();
  } finally {
    await authPool.end();
    await dropTestDatabase(pool, name);
  }
}, 60_000);
