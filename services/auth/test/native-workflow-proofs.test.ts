import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { testDatabase } from '../scripts/database.ts';
import { createNativeWorkflowProofPorts } from '../src/index.ts';

let db: ReturnType<typeof testDatabase>;
let pool: Pool;
beforeAll(async () => {
  db = testDatabase();
  pool = new Pool({ connectionString: db.url });
});
afterAll(async () => {
  await pool?.end();
  db?.close();
});

test('pending transport is immutable, indexed by native staging owner and survives pool restart', async () => {
  await pool.query(
    `INSERT INTO auth_registration_stage (registration_id,request_key,handle,account_id,request_digest) VALUES ('transport-registration','transport-key','transport','transport-account',$1)`,
    [Buffer.from('digest')],
  );
  const input = {
    accountId: 'transport-account',
    reservationId: 'transport-reservation',
    reference: 'exact-native-reference',
  };
  const proofs = createNativeWorkflowProofPorts({ database: pool });
  expect(await proofs.pendingReference(input)).toBeNull();
  await proofs.recordPending(input);
  await proofs.recordPending(input);
  await expect(proofs.recordPending({ ...input, reference: 'replacement-reference' })).rejects.toThrow();
  await expect(proofs.recordPending({ ...input, reservationId: 'replacement-reservation' })).rejects.toThrow();
  expect(await proofs.pendingReference({ ...input, accountId: 'another-account' })).toBeNull();
  await pool.end();
  pool = new Pool({ connectionString: db.url });
  const restarted = createNativeWorkflowProofPorts({ database: pool });
  expect(await restarted.pendingReference(input)).toBe(input.reference);
  expect(await restarted.provisioningEvidence(input)).toBeNull();
  await pool.query('DELETE FROM auth_registration_stage WHERE registration_id=$1', ['transport-registration']);
  expect(await restarted.pendingReference(input)).toBeNull();
});

test('absent staging, another workflow registration and absent native witness never become proof', async () => {
  const proof = createNativeWorkflowProofPorts({ database: pool });
  await expect(
    proof.recordPending({ accountId: 'missing', reservationId: 'missing', reference: 'not-authority' }),
  ).rejects.toThrow();
  expect(await proof.provisioningEvidence({ accountId: 'missing', reservationId: 'missing' })).toBeNull();
  expect(await proof.creationBinding({ registrationId: 'missing', operationKey: 'missing' })).toBeNull();
});
