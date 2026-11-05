import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { testDatabase } from '../scripts/database.ts';
import { createNativeWorkflowProofPorts } from '../src/native-workflow-proofs.ts';
import { createNativeLifecycleResults } from '../src/native-lifecycle-results.ts';

let fixture: ReturnType<typeof testDatabase>;
let database: Pool;
beforeAll(() => {
  fixture = testDatabase();
  database = new Pool({ connectionString: fixture.url, max: 1 });
});
afterAll(async () => {
  await database?.end();
  fixture?.close();
});

test('unknown and imported original sources stay pending without exposing retained private staging data', async () => {
  const reader = createNativeWorkflowProofPorts({ database });
  const consumers = createNativeLifecycleResults({ database, access: {} });
  await database.query(
    `INSERT INTO auth_provisioning_receipt (idempotency_key,account_id,digest) VALUES ('imported','imported',$1)`,
    [Buffer.alloc(32)],
  );
  expect(
    await reader.readOriginalLifecycleSource({
      kind: 'activation',
      accountId: 'imported',
      reservationId: 'reservation',
      operationKey: 'activate',
      source: { registrationId: 'stage', provisioningReceiptKey: 'imported' },
    }),
  ).toBeNull();
  expect(
    await reader.readOriginalLifecycleSource({
      kind: 'recovery',
      accountId: 'unknown',
      operationKey: 'complete',
      source: { establishmentReference: 'a'.repeat(64) },
    }),
  ).toBeNull();
  expect(await consumers.readRegistrationResult('unknown')).toBeNull();
  expect(await consumers.readRecoveryResult('a'.repeat(64))).toBeNull();
  expect(await consumers.readRecoveryResult('not a native reference')).toBeNull();
});
