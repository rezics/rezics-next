import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createAuthService } from '@rezics/auth';
import type { OriginalLifecycleRequest } from '@rezics/auth-contract';
import { createPool } from '../../src/database/pool.ts';
import { createLifecycleInternals, REGISTRATION_TTL_MS } from '../../src/access/lifecycle.ts';
import { readOriginalLifecycleResult } from '../../src/access/native-lifecycle-results.ts';
import { nativeReceiptKeyCandidates } from '../../src/command/receipt-key.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { nativeFixture, password, issuer } from './native-account-bindings-fixture.ts';

const pool = createPool(process.env.DATABASE_URL!, { connectionTimeoutMillis: 2000 });
pool.options.max = 1;
let f: Awaited<ReturnType<typeof nativeFixture>>;
const serviceId = '00000000-0000-8000-8000-000000000001';
beforeAll(async () => {
  f = await nativeFixture(pool, () => new Pool({ max: 1, connectionTimeoutMillis: 2000 }));
});
afterAll(async () => {
  try {
    await f?.close();
  } finally {
    await pool.end();
  }
});

async function registration(key: string, short = false) {
  // Use the actual native reservation command with its supported owner clock.
  // Everything thereafter uses the ordinary host, real Auth provisioning and
  // native activation. Neither receipt nor deadline is edited after commit.
  const normal = f.bindings.workflowPorts.reserveHandle;
  if (short) {
    const native = createLifecycleInternals({
      pool,
      routeKey: new Uint8Array(32).fill(91),
      clock: () => new Date(Date.now() - REGISTRATION_TTL_MS + 8000),
      provisioningEvidence: async () => null,
      recoveryEvidence: async () => null,
    });
    f.bindings.workflowPorts.reserveHandle = native.reserveHandle;
  }
  let ref;
  try {
    ref = await f.host.workflows.beginRegistration({ key, handle: key.replaceAll('-', '_') });
  } finally {
    f.bindings.workflowPorts.reserveHandle = normal;
  }
  await f.host.workflows.installRegistrationCredential({
    registrationId: ref.registrationId,
    email: `${key}@ordinary.test`,
    password,
  });
  const row = (
    await f.authPool.query<{
      reservation_id: string;
      activation_key: string;
      expires_at: Date;
    }>('SELECT reservation_id,activation_key,expires_at FROM auth_registration_stage WHERE registration_id=$1', [
      ref.registrationId,
    ])
  ).rows[0]!;
  const evidence = await f.proofs.provisioningEvidence({ accountId: ref.accountId, reservationId: row.reservation_id });
  const input: OriginalLifecycleRequest = {
    kind: 'activation' as const,
    accountId: ref.accountId,
    reservationId: row.reservation_id,
    operationKey: row.activation_key,
    source: { registrationId: ref.registrationId, provisioningReceiptKey: `registration:${ref.registrationId}` },
  };
  return { ref, row, input, evidence };
}

async function nativeReceipt(input: OriginalLifecycleRequest) {
  const kind = input.kind === 'activation' ? 'access.actor-activated' : 'access.authentication-established';
  return (
    await pool.query(
      `SELECT transaction_id,epoch,position::text,response,request_digest FROM core.receipt
     WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2 AND command_kind=$3
       AND idempotency_key=ANY($4::text[])`,
      [
        partitionOf(routeOf(input.accountId)!),
        serviceId,
        kind,
        nativeReceiptKeyCandidates(pool, kind, serviceId, `${routeOf(input.accountId)}:${input.operationKey}`),
      ],
    )
  ).rows[0];
}

test('Existing terminal Auth consumer can read the exact genuinely committed activation or recovery source result after transient evidence expires without admitting a new effect or retaining private source payload', async () => {
  const { ref, row, input, evidence } = await registration('original_activation', true);
  const read = f.bindings.trustedAccess.readOriginalLifecycleResult!;
  expect(await read(input)).toBeNull(); // Auth provisioning alone never implies activation.
  await f.host.workflows.activateRegistration(ref.registrationId);
  const committed = await nativeReceipt(input);
  const expected = {
    kind: 'activation' as const,
    accountId: ref.accountId,
    reservationId: row.reservation_id,
    authnEpoch: 1,
    outcome: {
      partition: partitionOf(routeOf(ref.accountId)!),
      epoch: committed.epoch,
      position: committed.position,
      transactionId: committed.transaction_id,
      value: committed.response,
    },
  };
  expect(await read(input)).toEqual(expected);
  expect(await f.bindings.workflowPorts.readOriginalLifecycleResult!(input)).toEqual(expected);
  await Bun.sleep(Math.max(0, row.expires_at.getTime() - Date.now() + 30));
  expect(
    await f.proofs.provisioningEvidence({ accountId: ref.accountId, reservationId: row.reservation_id }),
  ).toBeNull();
  await expect(
    f.bindings.internalLifecycle.activate({ accountId: ref.accountId, key: input.operationKey, evidence }),
  ).rejects.toThrow();
  await f.bindings.internalLifecycle.raiseFence({ accountId: ref.accountId, key: 'later-original-activation-fence' });
  await f.restart();
  const result = await f.host.nativeLifecycleResults.readRegistrationResult(ref.registrationId);
  expect(result).toEqual(expected);
  expect(await nativeReceipt(input)).toEqual(committed);
  const encoded = JSON.stringify(result);
  for (const privateField of ['handle', 'email', 'ciphertext', 'pendingReference', 'digest', 'credential', 'JWT'])
    expect(encoded).not.toContain(privateField);
  expect(
    await f.bindings.trustedAccess.readOriginalLifecycleResult!({ ...input, operationKey: 'absent-key' }),
  ).toBeNull();
  if (input.kind !== 'activation') throw new Error('Expected activation');
  expect(
    await f.bindings.trustedAccess.readOriginalLifecycleResult!({ ...input, reservationId: ref.accountId }),
  ).toBeNull();
  expect(
    await f.bindings.trustedAccess.readOriginalLifecycleResult!({
      ...input,
      source: { ...input.source, provisioningReceiptKey: 'absent' },
    }),
  ).toBeNull();
  await f.authPool.query('DELETE FROM auth_registration_stage WHERE registration_id=$1', [ref.registrationId]);
  expect(await f.bindings.trustedAccess.readOriginalLifecycleResult!(input)).toBeNull();
}, 30000);

test('the second native snapshot rejects a receipt minimized while its genuine Auth source was being verified', async () => {
  const { ref, input } = await registration('original_minimized');
  await f.host.workflows.activateRegistration(ref.registrationId);
  const committed = await nativeReceipt(input);
  let released = false;
  const result = await readOriginalLifecycleResult(
    {
      pool,
      referenceKeys: f.referenceKeys,
      source: {
        async readOriginalLifecycleSource(request) {
          // max-one source pool can perform the ordinary owner read; Access has
          // released its checkout. Minimize only this test's exact receipt.
          released = pool.totalCount === pool.idleCount;
          const source = await f.proofs.readOriginalLifecycleSource(request);
          await pool.query(
            `UPDATE core.receipt SET response='null'::jsonb,payload_state='minimized'
        WHERE partition_no=$1 AND transaction_id=$2 AND command_kind='access.actor-activated'`,
            [partitionOf(routeOf(ref.accountId)!), committed.transaction_id],
          );
          return source;
        },
      },
    },
    input,
  );
  expect(released).toBe(true);
  expect(result).toBeNull();
  expect(await f.bindings.trustedAccess.readOriginalLifecycleResult!(input)).toBeNull();
});

test('original recovery uses the committed establishment and native floor after expiry without issuing a session or running completion', async () => {
  const person = await f.person('original_recovery');
  await f.bindings.internalLifecycle.raiseFence({ accountId: person.accountId, key: 'original-recovery-fence' });
  let token = '';
  const service = await createAuthService({
    database: f.authPool,
    issuer,
    audience: 'https://ordinary.api.test',
    secret: 'ordinary-native-persistent-auth-secret-32-bytes',
    signing: { activeKid: f.privateKey.kid, privateKeys: [f.privateKey] },
    trustedAccess: f.bindings.trustedAccess,
    recoveryDelivery: {
      async deliver(input) {
        token = input.token;
      },
    },
  });
  const request = (path: string, body: unknown) =>
    service.handler(
      new Request(`${issuer}${path}`, {
        method: 'POST',
        headers: { origin: issuer, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  expect((await request('/recovery/start', { email: 'original_recovery@ordinary.test' })).status).toBe(200);
  for (let i = 0; !token && i < 500; i++) await Bun.sleep(10);
  expect(token).not.toBe('');
  // Shorten the delivered source before its credential transaction, following
  // the existing native recovery expiry fixture. Preserve all committed proofs.
  await f.authPool.query(
    `UPDATE auth_recovery SET expires_at=statement_timestamp()+interval '8 seconds'
    WHERE account_id=$1 AND consumed_operation IS NULL`,
    [person.accountId],
  );
  expect(
    (
      await request('/recovery/complete', {
        account_id: person.accountId,
        token,
        new_password: 'original recovery replacement password',
      })
    ).status,
  ).toBe(200);
  const row = (
    await f.authPool.query<{ reference: string; expires_at: Date }>(
      `SELECT w.reference,p.expires_at FROM auth_recovery_establishment w
      JOIN auth_barrier_proof p ON p.reference=w.reference WHERE w.account_id=$1`,
      [person.accountId],
    )
  ).rows[0]!;
  const before = await f.host.nativeLifecycleResults.readRecoveryResult(row.reference);
  expect(before?.kind).toBe('recovery');
  await Bun.sleep(Math.max(0, row.expires_at.getTime() - Date.now() + 30));
  expect(await service.internal.resolveRecoveryEstablishment(row.reference)).toBeNull();
  await expect(f.bindings.trustedAccess.completeRecovery!(row.reference)).rejects.toThrow();
  const sessions = (await f.authPool.query('SELECT id FROM session WHERE "userId"=$1', [person.accountId])).rows;
  await f.restart();
  expect(await f.host.nativeLifecycleResults.readRecoveryResult(row.reference)).toEqual(before);
  expect((await f.authPool.query('SELECT id FROM session WHERE "userId"=$1', [person.accountId])).rows).toEqual(
    sessions,
  );
  await f.authPool.query('DELETE FROM auth_recovery_establishment WHERE reference=$1', [row.reference]);
  expect(await f.host.nativeLifecycleResults.readRecoveryResult(row.reference)).toBeNull();
}, 30000);
