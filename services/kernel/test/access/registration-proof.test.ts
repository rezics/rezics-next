import { afterAll, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { createAuthBindings, AuthBindingDeniedError } from '../../src/access/auth-bindings.ts';
import { createLifecycleInternals, LifecycleDeniedError } from '../../src/access/lifecycle.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { seal, unseal } from '../../src/tokens/seal.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const reader = createPool(url);
const ring = { current: 7, keys: new Map([[7, randomBytes(32)]]) };
const scope = 'access.registration-proof.v1';
afterAll(async () => Promise.all([pool.end(), reader.end()]));
let sequence = 0;
function lifecycle(clock?: () => Date) {
  return createLifecycleInternals({
    pool,
    routeKey: new Uint8Array(32).fill(42),
    ...(clock ? { clock } : {}),
    provisioningEvidence: async () => null,
    recoveryEvidence: async () => null,
  });
}
async function pending(clock?: () => Date) {
  const internal = lifecycle(clock);
  const key = `registration-proof-${++sequence}`;
  const accountId = internal.registrationTarget(key);
  const handle = `Proof_${sequence}`;
  const reservation = await internal.reserveHandle({ accountId, handle, key });
  const input = { accountId, handle, key, reservationId: reservation.value.reservationId };
  const outcome = await internal.createPending(input);
  return { internal, input, outcome, reservation };
}
async function bindings(referenceKeys = ring) {
  // Load after the native fixture commits, so the initial missing capability fails on real PostgreSQL evidence.
  const { createRegistrationProofBindings } = await import('../../src/access/registration-proof.ts');
  return createRegistrationProofBindings({ pool: reader, referenceKeys });
}

test('provisioning reference proves one committed native pending registration receipt', async () => {
  const { internal, input, outcome } = await pending();
  const proof = await bindings();
  const reference = await proof.createProvisioningReference({ input, outcome });
  expect(reference).toBeString();
  expect(reference!.length).toBeLessThanOrEqual(4096);
  expect(await proof.verifyProvisioningReceipt(reference!)).toEqual(outcome.value);
  const replay = await internal.createPending(input);
  expect(replay.replayed).toBe(true);
  expect(await proof.createProvisioningReference({ input, outcome: replay })).toBe(reference);
  const ports = createAuthBindings({ pool: reader, ...proof });
  expect(await ports.authorizeProvisioning!(reference!)).toEqual({ accountId: input.accountId });
  // A pending kernel receipt does not establish successful Auth provisioning.
  await expect(
    internal.activate({ accountId: input.accountId, key: 'activate', evidence: reference }),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
});

test('wrong locator, digest, account, transaction, response and expiry deny', async () => {
  const first = await pending();
  const second = await pending();
  const proof = await bindings();
  const { input, outcome } = first;
  const create = (changed: typeof input, result = outcome) =>
    proof.createProvisioningReference({ input: changed, outcome: result });
  for (const changed of [
    { ...input, key: 'another-command' },
    { ...input, accountId: second.input.accountId },
    { ...input, reservationId: second.input.reservationId },
    { ...input, handle: 'another_handle' },
  ])
    expect(await create(changed)).toBeNull();
  for (const changed of [
    { ...outcome, transactionId: newId(0) },
    { ...outcome, epoch: outcome.epoch + 1 },
    { ...outcome, position: outcome.position + 1n },
    { ...outcome, partition: (outcome.partition + 1) % 4096 },
    { ...outcome, value: second.outcome.value },
    {
      ...outcome,
      value: { ...outcome.value, expiresAt: new Date(Date.parse(outcome.value.expiresAt) + 1).toISOString() },
    },
  ])
    expect(await create(input, changed)).toBeNull();
  const reference = (await create(input))!;
  const nativeKey = `${routeOf(input.accountId)}:${input.key}`;
  const receipt = await pool.query(
    'SELECT * FROM core.receipt WHERE partition_no=$1 AND command_kind=$2 AND idempotency_key=$3',
    [outcome.partition, 'access.actor-pending', nativeKey],
  );
  const original = receipt.rows[0]!;
  for (const [column, value] of [
    ['command_kind', 'access.handle-reserved'],
    ['actor_account_id', second.input.accountId],
    ['request_digest', randomBytes(32)],
    ['transaction_id', newId(0)],
    ['response', { ...outcome.value, registrationId: second.input.reservationId }],
    ['response', { ...outcome.value, accountId: second.input.accountId }],
    ['response', { ...outcome.value, expiresAt: new Date(Date.parse(outcome.value.expiresAt) + 1).toISOString() }],
    ['response', { ...outcome.value, authorization: true }],
  ] as const) {
    // Deliberately corrupt one isolated native receipt; restore before the next assertion.
    await pool.query(`UPDATE core.receipt SET ${column}=$1 WHERE partition_no=$2 AND transaction_id=$3`, [
      value,
      outcome.partition,
      outcome.transactionId,
    ]);
    try {
      expect(await proof.verifyProvisioningReceipt(reference)).toBeNull();
    } finally {
      await pool.query(`UPDATE core.receipt SET ${column}=$1 WHERE partition_no=$2 AND idempotency_key=$3`, [
        original[column],
        outcome.partition,
        nativeKey,
      ]);
    }
  }
  expect(await proof.verifyProvisioningReceipt(reference)).toEqual(outcome.value);
});

test('uncommitted rolled back wrong kind or reservation only evidence denies', async () => {
  const { input, outcome, reservation } = await pending();
  const proof = await bindings();
  const reference = (await proof.createProvisioningReference({ input, outcome }))!;
  const route = routeOf(input.accountId)!;
  expect(
    await proof.createProvisioningReference({ input, outcome: { ...reservation, value: outcome.value } }),
  ).toBeNull();
  // Save the actual native receipt, then make its reinsertion visible only on the writer connection.
  const locator = [outcome.partition, 'access.actor-pending', `${route}:${input.key}`];
  const saved = (
    await pool.query(
      'DELETE FROM core.receipt WHERE partition_no=$1 AND command_kind=$2 AND idempotency_key=$3 RETURNING *',
      locator,
    )
  ).rows[0]!;
  expect(await proof.verifyProvisioningReceipt(reference)).toBeNull();
  const writer = await pool.connect();
  const insert = () =>
    writer.query(`INSERT INTO core.receipt SELECT * FROM jsonb_populate_record(NULL::core.receipt,$1::jsonb)`, [
      JSON.stringify({ ...saved, request_digest: `\\x${Buffer.from(saved.request_digest).toString('hex')}` }),
    ]);
  try {
    await writer.query('BEGIN');
    await insert();
    expect(
      (
        await writer.query(
          'SELECT 1 FROM core.receipt WHERE partition_no=$1 AND command_kind=$2 AND idempotency_key=$3',
          locator,
        )
      ).rowCount,
    ).toBe(1);
    expect(await proof.verifyProvisioningReceipt(reference)).toBeNull();
    expect(await proof.createProvisioningReference({ input, outcome })).toBeNull();
    await writer.query('ROLLBACK');
    expect(await proof.verifyProvisioningReceipt(reference)).toBeNull();
    await writer.query('BEGIN');
    await insert();
    await writer.query('COMMIT');
  } finally {
    await writer.query('ROLLBACK');
    writer.release();
  }
  expect(await proof.verifyProvisioningReceipt(reference)).toEqual(outcome.value);
  const internal = lifecycle();
  const accountId = internal.registrationTarget('reservation-only');
  const claim = await internal.reserveHandle({ accountId, handle: 'reservation_only', key: 'reservation-only' });
  expect(
    await proof.createProvisioningReference({
      input: {
        accountId,
        handle: 'reservation_only',
        key: 'reservation-only',
        reservationId: claim.value.reservationId,
      },
      outcome: {
        ...claim,
        partition: partitionOf(routeOf(accountId)!),
        value: { accountId, registrationId: claim.value.reservationId, expiresAt: claim.value.expiresAt },
      },
    }),
  ).toBeNull();
});

test('a native pending command cannot prove its commit before COMMIT or after rollback', async () => {
  const proof = await bindings();
  for (const rollback of [false, true]) {
    const internal = lifecycle();
    const key = `commit-proof-${++sequence}`;
    const accountId = internal.registrationTarget(key);
    const handle = `commit_proof_${sequence}`;
    const reservation = await internal.reserveHandle({ accountId, handle, key });
    const input = { accountId, handle, key, reservationId: reservation.value.reservationId };
    const partition = partitionOf(routeOf(accountId)!);
    const writerPool = createPool(url!);
    const failure = new Error('Abort native pending commit');
    let beforeCommit: Parameters<typeof proof.createProvisioningReference>[0] | undefined;
    let reference = '';
    writerPool.on('connect', (client) => {
      const query = client.query.bind(client);
      client.query = ((...args: Parameters<PoolClient['query']>) => {
        if (args[0] !== 'COMMIT') return query(...args);
        return (async () => {
          // Observe the real executor's staged receipt on its own transaction, then
          // independently prove neither receipt nor account is committed yet.
          const row = (
            await query('SELECT * FROM core.receipt WHERE partition_no=$1 AND command_kind=$2 AND idempotency_key=$3', [
              partition,
              'access.actor-pending',
              `${routeOf(accountId)}:${key}`,
            ])
          ).rows[0]!;
          beforeCommit = {
            input,
            outcome: {
              value: row.response,
              partition,
              epoch: row.epoch,
              position: BigInt(row.position),
              transactionId: row.transaction_id,
              replayed: false,
            },
          };
          reference = seal(ring, scope, {
            accountId,
            key,
            handle: handle.toLowerCase(),
            reservationId: input.reservationId,
            expiresAt: row.response.expiresAt,
            transactionId: row.transaction_id,
            epoch: row.epoch,
            position: String(row.position),
          });
          expect(await proof.createProvisioningReference(beforeCommit)).toBeNull();
          expect(await proof.verifyProvisioningReceipt(reference)).toBeNull();
          expect(
            (
              await reader.query('SELECT 1 FROM access.account WHERE route=$1 AND account_id=$2', [
                routeOf(accountId),
                accountId,
              ])
            ).rowCount,
          ).toBe(0);
          if (rollback) throw failure;
          return query(...args);
        })();
      }) as PoolClient['query'];
    });
    try {
      const native = createLifecycleInternals({
        pool: writerPool,
        routeKey: new Uint8Array(32).fill(42),
        provisioningEvidence: async () => null,
        recoveryEvidence: async () => null,
      });
      if (rollback) {
        await expect(native.createPending(input)).rejects.toBe(failure);
        expect(beforeCommit).toBeDefined();
        expect(await proof.createProvisioningReference(beforeCommit!)).toBeNull();
        expect(await proof.verifyProvisioningReceipt(reference)).toBeNull();
      } else {
        const outcome = await native.createPending(input);
        expect(await proof.createProvisioningReference({ input, outcome })).toBe(reference);
        expect(await proof.verifyProvisioningReceipt(reference)).toEqual(outcome.value);
      }
    } finally {
      await writerPool.end();
    }
  }
});

test('anchored pending registration and partition must remain eligible, even before expiry cleanup', async () => {
  const { input, outcome } = await pending();
  const proof = await bindings();
  const reference = (await proof.createProvisioningReference({ input, outcome }))!;
  const route = routeOf(input.accountId)!;
  const original = (
    await pool.query('SELECT * FROM access.account WHERE route=$1 AND account_id=$2', [route, input.accountId])
  ).rows[0]!;
  for (const [column, value] of [
    ['registration_id', newId(route)],
    ['registration_expires_at', new Date(Date.parse(outcome.value.expiresAt) + 1)],
    ['state', 'active'],
    ['authn_fenced', true],
    ['operator_account_id', newId(route)],
    ['handle', 'different_handle'],
    ['transaction_id', newId(route)],
  ] as const) {
    await pool.query(`UPDATE access.account SET ${column}=$1 WHERE route=$2 AND account_id=$3`, [
      value,
      route,
      input.accountId,
    ]);
    try {
      expect(await proof.verifyProvisioningReceipt(reference)).toBeNull();
    } finally {
      await pool.query(`UPDATE access.account SET ${column}=$1 WHERE route=$2 AND account_id=$3`, [
        original[column],
        route,
        input.accountId,
      ]);
    }
  }
  await pool.query("UPDATE core.partition SET write_state='fenced' WHERE partition_no=$1", [outcome.partition]);
  try {
    expect(await proof.verifyProvisioningReceipt(reference)).toBeNull();
  } finally {
    await pool.query("UPDATE core.partition SET write_state='active' WHERE partition_no=$1", [outcome.partition]);
  }
  const raisedFloor = await pending();
  const floorReference = (await proof.createProvisioningReference(raisedFloor))!;
  await pool.query('UPDATE access.account SET minimum_authn_epoch=9007199254740992 WHERE route=$1 AND account_id=$2', [
    routeOf(raisedFloor.input.accountId),
    raisedFloor.input.accountId,
  ]);
  expect(await proof.verifyProvisioningReceipt(floorReference)).toBeNull();
  const nativeTime = (await reader.query('SELECT statement_timestamp() AS at')).rows[0].at as Date;
  const expired = await pending(() => new Date(nativeTime.getTime() - 31 * 60_000));
  expect(await proof.createProvisioningReference(expired)).toBeNull();
  const expiredReference = seal(ring, scope, {
    ...(unseal(ring, scope, reference) as Record<string, unknown>),
    ...expired.input,
    handle: expired.input.handle.toLowerCase(),
    expiresAt: expired.outcome.value.expiresAt,
    transactionId: expired.outcome.transactionId,
    epoch: expired.outcome.epoch,
    position: expired.outcome.position.toString(),
  });
  expect(await proof.verifyProvisioningReceipt(expiredReference)).toBeNull();
  expect(
    (
      await reader.query('SELECT state FROM access.account WHERE route=$1 AND account_id=$2', [
        routeOf(expired.input.accountId),
        expired.input.accountId,
      ])
    ).rows[0].state,
  ).toBe('pending');
});

test('references are bounded, integrity bound to configured keys and fail closed when evidence is unavailable', async () => {
  const { input, outcome } = await pending();
  const proof = await bindings();
  const reference = (await proof.createProvisioningReference({ input, outcome }))!;
  for (const invalid of [
    '',
    'x'.repeat(4097),
    `${reference}x`,
    reference.replace(/^./, reference[0] === 'A' ? 'B' : 'A'),
    seal(ring, 'other-scope', unseal(ring, scope, reference)),
    seal(ring, scope, {}),
  ]) {
    expect(await proof.verifyProvisioningReceipt(invalid)).toBeNull();
  }
  expect(
    await (await bindings({ current: 7, keys: new Map([[7, randomBytes(32)]]) })).verifyProvisioningReceipt(reference),
  ).toBeNull();
  const rotated = await bindings({ current: 8, keys: new Map([...ring.keys, [8, randomBytes(32)]]) });
  expect(await rotated.verifyProvisioningReceipt(reference)).toEqual(outcome.value);
  const newReference = (await rotated.createProvisioningReference({ input, outcome }))!;
  expect(newReference).not.toBe(reference);
  expect(await proof.verifyProvisioningReceipt(newReference)).toBeNull();
  await expect(
    createAuthBindings({ pool: reader, ...proof }).authorizeProvisioning!(`${reference}x`),
  ).rejects.toBeInstanceOf(AuthBindingDeniedError);
  const disconnected = createPool(url!);
  await disconnected.end();
  const { createRegistrationProofBindings } = await import('../../src/access/registration-proof.ts');
  expect(
    await createRegistrationProofBindings({ pool: disconnected, referenceKeys: ring }).verifyProvisioningReceipt(
      reference,
    ),
  ).toBeNull();
});
