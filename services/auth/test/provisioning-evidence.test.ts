import { trustedAccessPorts } from './support/trusted-access.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { verifyPassword } from 'better-auth/crypto';
import { exportJWK, generateKeyPair } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import * as Auth from '../src/index.ts';

let fixture: ReturnType<typeof testDatabase>;
let database: Pool;
let service: Auth.AuthService;
let options: Auth.AuthServiceOptions;
const accounts = new Map<string, Auth.AccessAccount>();
const approvals = new Map<string, Auth.ProvisioningAuthorization>();
let authorizeHook: (() => void) | undefined;
const password = 'native provisioning evidence password';

function pending(id: string, automated = false) {
  accounts.set(id, { accountId: id, kind: 'actor', state: 'pending', automated, authnEpoch: 17 });
  const approval = {
    accountId: id,
    receipt: {
      registrationId: `registration-${id}`,
      reservationId: `reservation-${id}`,
      authnEpoch: 17,
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
  };
  approvals.set(id, approval);
  return approval;
}
function input(id: string) {
  return { authorization: id, email: `${id}@example.test`, password, idempotencyKey: `receipt-${id}` };
}
function verifier() {
  return Auth.createProvisioningEvidenceVerifier({ database });
}
async function provision(id: string, automated = false) {
  pending(id, automated);
  const result = automated
    ? await service.internal.provisionCredentialless({ authorization: id })
    : await service.internal.provisionPassword(input(id));
  expect(result.provisioningEvidence).toBeDefined();
  return result.provisioningEvidence!;
}

beforeAll(async () => {
  fixture = testDatabase();
  database = new Pool({ connectionString: fixture.url });
  const pair = await generateKeyPair('ES256', { extractable: true });
  const key = { ...(await exportJWK(pair.privateKey)), kid: 'provisioning-evidence', alg: 'ES256' };
  options = {
    database,
    issuer: 'https://provisioning.auth.test',
    audience: 'https://provisioning.api.test',
    secret: 'provisioning-evidence-native-test-secret-32-bytes',
    signing: { activeKid: key.kid, privateKeys: [key] },
    // This Auth-only trust fixture represents the pending Access boundary. It
    // proves native Auth commits, not the real pending receipt or lifecycle command.
    trustedAccess: trustedAccessPorts({
      async readFencedAccount(id) {
        return this.readAccount(id);
      },
      readAccount: async (id) => accounts.get(id) ?? null,
      async authorizeProvisioning(reference) {
        authorizeHook?.();
        const approval = approvals.get(reference);
        if (!approval) throw new Error('Pending authorization unavailable');
        return structuredClone(approval);
      },
    }),
  };
  service = await Auth.createAuthService(options);
}, 60000);
afterAll(async () => {
  await database?.end();
  fixture?.close();
}, 60000);

test('activation evidence proves committed native owner and password for the exact pending registration', async () => {
  pending('password');
  const result = await service.internal.provisionPassword(input('password'));
  const native = (await database.query('SELECT id,password FROM account WHERE "userId"=$1', ['password'])).rows;
  expect(native).toHaveLength(1);
  expect(await verifyPassword({ hash: native[0].password, password })).toBe(true);
  expect(result.provisioningEvidence).toBeDefined();
  const reference = result.provisioningEvidence!;
  expect(await verifier().resolve(reference)).toEqual({
    accountId: 'password',
    registrationId: 'registration-password',
    authIdentityId: 'password',
    authnEpoch: 17,
  });
  expect(JSON.stringify(reference)).not.toContain(password);
  expect(JSON.stringify(reference)).not.toContain(native[0].password);
  expect(await verifier().createReference(reference)).toEqual(reference);
  const restarted = await Auth.createAuthService(options);
  expect(await restarted.internal.provisionPassword(input('password'))).toEqual(result);
  expect((await database.query('SELECT id FROM account WHERE "userId"=$1', ['password'])).rows).toEqual(
    native.map(({ id }) => ({ id })),
  );
  for (const changed of [
    { receiptKey: 'absent' },
    { accountId: 'another-owner' },
    { registrationId: 'another-registration' },
    { reservationId: 'another-reservation' },
    { authnEpoch: 18 },
    { credentialId: 'another-credential' },
    { expiresAt: '2098-01-01T00:00:00.000Z' },
    { version: 2 },
    { extra: 'password' },
  ])
    expect(await verifier().resolve({ ...reference, ...changed })).toBeNull();
  for (const value of [null, '', [], {}, { ...reference, receiptKey: 'x'.repeat(1025) }])
    expect(await verifier().resolve(value)).toBeNull();
});

test('asynchronous lookup snapshots the exact reference before caller mutation', async () => {
  const reference = await provision('snapshot');
  const mutable = { ...reference };
  const resolving = verifier().resolve(mutable);
  mutable.registrationId = 'replacement';
  mutable.authnEpoch = 100;
  expect(await resolving).toEqual({
    accountId: 'snapshot',
    registrationId: 'registration-snapshot',
    authIdentityId: 'snapshot',
    authnEpoch: 17,
  });
  const locator = { ...reference };
  const producing = verifier().createReference(locator);
  locator.reservationId = 'replacement';
  expect(await producing).toEqual(reference);
});

test('staging, ciphertext, user existence and legacy approval cannot mint production evidence', async () => {
  pending('legacy');
  approvals.set('legacy', { accountId: 'legacy' });
  const result = await service.internal.provisionPassword(input('legacy'));
  expect(result.provisioningEvidence).toBeUndefined();
  await database.query(
    `INSERT INTO auth_registration_stage
    (registration_id,request_key,handle,account_id,reservation_id,request_digest,ciphertext)
    VALUES ('stage','stage','stage','staged','reservation-stage',$1,$1)`,
    [Buffer.from('ciphertext')],
  );
  const locator = {
    receiptKey: 'receipt-legacy',
    accountId: 'legacy',
    registrationId: 'stage',
    reservationId: 'reservation-stage',
    authnEpoch: 17,
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
  expect(await verifier().createReference(locator)).toBeNull();
  expect(await verifier().createReference({ ...locator, receiptKey: 'stage', accountId: 'staged' })).toBeNull();
});

test('rollback, uncommitted receipt and expired original authorization deny evidence', async () => {
  const reference = await provision('rollback');
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO "user" (id,name,email,"emailVerified") VALUES ('uncommitted','','uncommitted@example.test',false)`,
    );
    await client.query(`INSERT INTO account (id,"accountId","providerId","userId",password,"updatedAt")
      VALUES ('uncommitted','uncommitted','credential','uncommitted','native-hash',now())`);
    await client.query(
      `INSERT INTO auth_provisioning_receipt
      SELECT 'uncommitted','uncommitted',digest,registration_id,reservation_id,authn_epoch,expires_at,
        'uncommitted','uncommitted',provisioning_kind FROM auth_provisioning_receipt WHERE idempotency_key=$1`,
      [reference.receiptKey],
    );
    expect(
      await verifier().resolve({
        ...reference,
        receiptKey: 'uncommitted',
        accountId: 'uncommitted',
        credentialId: 'uncommitted',
      }),
    ).toBeNull();
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  expect(await verifier().resolve({ ...reference, receiptKey: 'uncommitted' })).toBeNull();
  pending('expired');
  approvals.get('expired')!.receipt!.expiresAt = '2000-01-01T00:00:00.000Z';
  await expect(service.internal.provisionPassword(input('expired'))).rejects.toThrow();
  expect((await database.query('SELECT id FROM "user" WHERE id=$1', ['expired'])).rows).toEqual([]);
  // Fail the receipt INSERT after native owner/credential writes; all three roll back.
  await database.query(`CREATE FUNCTION reject_test_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.account_id LIKE 'failed-%' THEN RAISE EXCEPTION 'receipt failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_test_receipt BEFORE INSERT ON auth_provisioning_receipt
      FOR EACH ROW EXECUTE FUNCTION reject_test_receipt()`);
  try {
    for (const automated of [false, true]) {
      const id = automated ? 'failed-automation' : 'failed-commit';
      pending(id, automated);
      await expect(
        automated
          ? service.internal.provisionCredentialless({ authorization: id })
          : service.internal.provisionPassword(input(id)),
      ).rejects.toThrow('receipt failure');
      expect((await database.query('SELECT id FROM "user" WHERE id=$1', [id])).rows).toEqual([]);
      expect(await verifier().createReference({ ...reference, receiptKey: `receipt-${id}`, accountId: id })).toBeNull();
    }
  } finally {
    await database.query(
      'DROP TRIGGER reject_test_receipt ON auth_provisioning_receipt; DROP FUNCTION reject_test_receipt()',
    );
  }
});

test('recheck original pending authorization before commit and publication; never adopt a later epoch', async () => {
  for (const phase of [2, 3]) {
    const id = `changed-${phase}`;
    pending(id);
    let reads = 0;
    authorizeHook = () => {
      if (++reads === phase) approvals.get(id)!.receipt!.reservationId = 'replacement';
    };
    try {
      await expect(service.internal.provisionPassword(input(id))).rejects.toThrow();
    } finally {
      authorizeHook = undefined;
    }
    expect((await database.query('SELECT id FROM "user" WHERE id=$1', [id])).rows.length).toBe(phase === 2 ? 0 : 1);
  }
  const reference = await provision('epoch');
  accounts.get('epoch')!.authnEpoch = 18;
  await expect(service.internal.provisionPassword(input('epoch'))).rejects.toThrow();
  expect((await verifier().resolve(reference))?.authnEpoch).toBe(17);
  approvals.get('epoch')!.receipt!.authnEpoch = 18;
  await expect(service.internal.provisionPassword(input('epoch'))).rejects.toThrow();
});

test('credentialless automation commits an exact durable receipt and replays without adopting an unrelated owner', async () => {
  const reference = await provision('automation', true);
  const first = await service.internal.provisionCredentialless({ authorization: 'automation' });
  expect(first.provisioningEvidence).toEqual(reference);
  expect((await database.query('SELECT password FROM account WHERE "userId"=$1', ['automation'])).rows).toEqual([
    { password: null },
  ]);
  expect(await verifier().resolve(reference)).toEqual({
    accountId: 'automation',
    registrationId: 'registration-automation',
    authIdentityId: 'automation',
    authnEpoch: 17,
  });
  approvals.get('automation')!.receipt!.registrationId = 'other-registration';
  await expect(service.internal.provisionCredentialless({ authorization: 'automation' })).rejects.toThrow();
  pending('unrelated-owner', true);
  await database.query(
    `INSERT INTO "user" (id,name,email,"emailVerified") VALUES ('unrelated-owner','','unrelated@example.test',false)`,
  );
  await expect(service.internal.provisionCredentialless({ authorization: 'unrelated-owner' })).rejects.toThrow();
  expect(
    (await database.query('SELECT * FROM auth_provisioning_receipt WHERE account_id=$1', ['unrelated-owner'])).rows,
  ).toEqual([]);
});

test('wrong native owner or credential denies; indexed native erasure revokes proof permanently', async () => {
  const reference = await provision('erased');
  await database.query(
    `INSERT INTO "user" (id,name,email,"emailVerified") VALUES ('other','','other@example.test',false)`,
  );
  await database.query('UPDATE account SET "userId"=$2,"accountId"=$2 WHERE id=$1', [reference.credentialId, 'other']);
  expect(await verifier().resolve(reference)).toBeNull();
  await database.query('UPDATE account SET "userId"=$2,"accountId"=$2 WHERE id=$1', [reference.credentialId, 'erased']);
  await expect(
    database.query('UPDATE auth_provisioning_receipt SET authn_epoch=18 WHERE idempotency_key=$1', [
      reference.receiptKey,
    ]),
  ).rejects.toThrow();
  accounts.get('erased')!.state = 'deleted';
  accounts.get('erased')!.fenced = true;
  await service.internal.eraseAccount('erased');
  expect(await verifier().resolve(reference)).toBeNull();
  expect(
    (await database.query('SELECT * FROM auth_provisioning_receipt WHERE idempotency_key=$1', [reference.receiptKey]))
      .rows,
  ).toEqual([]);
  const recreated = await provision('erased');
  expect(recreated.credentialId).not.toBe(reference.credentialId);
  expect(await verifier().resolve(reference)).toBeNull();
  const deletedCredential = await provision('deleted-credential');
  await database.query('DELETE FROM account WHERE id=$1', [deletedCredential.credentialId]);
  expect(await verifier().resolve(deletedCredential)).toBeNull();
});
