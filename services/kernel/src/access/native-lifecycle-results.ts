import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool, PoolClient } from 'pg';
import type {
  OriginalLifecycleRequest,
  OriginalLifecycleResult,
  OriginalLifecycleSource,
  OriginalLifecycleSourcePort,
} from '@rezics/auth-contract';
export type { OriginalLifecycleRequest, OriginalLifecycleResult } from '@rezics/auth-contract';
import { nativeReceiptKeyCandidates } from '../command/receipt-key.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { unseal, type KeyRing } from '../tokens/seal.ts';
import read from './native-lifecycle-results-read.sql';
import fence from './native-lifecycle-results-fence.sql';

const SERVICE_ID = '00000000-0000-8000-8000-000000000001';
const BASIS = { actorAccountId: SERVICE_ID, clientId: 'internal-access', requestedBy: null };
type Config = { pool: Pool; referenceKeys: KeyRing; source: Partial<OriginalLifecycleSourcePort> };
type Receipt = NonNullable<Awaited<ReturnType<typeof read.run>>>;
const equal = (left: unknown, right: unknown) => canonicalize(left) === canonicalize(right);
const bounded = (value: unknown, max = 1024): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
const epoch = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const iso = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length === 24 &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const keys = (value: object, expected: string[]) => equal(Object.keys(value).sort(), expected.sort());

function decode(value: OriginalLifecycleRequest): OriginalLifecycleRequest | null {
  // Capture immutable primitives before checkout; no request object is a proof.
  try {
    const input = structuredClone(value);
    if (
      !input ||
      routeOf(input.accountId) === null ||
      !bounded(input.operationKey, 256) ||
      [...`${routeOf(input.accountId)}:${input.operationKey}`].length > 255 ||
      !input.source
    )
      return null;
    if (
      input.kind === 'activation' &&
      keys(input, ['kind', 'accountId', 'reservationId', 'operationKey', 'source']) &&
      routeOf(input.reservationId) !== null &&
      keys(input.source, ['registrationId', 'provisioningReceiptKey']) &&
      bounded(input.source.registrationId) &&
      bounded(input.source.provisioningReceiptKey)
    )
      return input;
    if (
      input.kind === 'recovery' &&
      keys(input, ['kind', 'accountId', 'operationKey', 'source']) &&
      keys(input.source, ['establishmentReference']) &&
      /^[a-f0-9]{64}$/.test(input.source.establishmentReference)
    )
      return input;
  } catch {
    /* Invalid native lookup hints are not authority. */
  }
  return null;
}

function digest(accountId: string, kind: string, input: unknown) {
  return createHash('sha256')
    .update(canonicalize([routeOf(accountId), accountId, kind, BASIS, input])!)
    .digest();
}

async function receipt(client: PoolClient, accountId: string, kind: string, key: string) {
  return read.run(client, {
    partition_no: partitionOf(routeOf(accountId)!),
    service_id: SERVICE_ID,
    command_kind: `access.${kind}`,
    receipt_keys: nativeReceiptKeyCandidates(client, `access.${kind}`, SERVICE_ID, `${routeOf(accountId)}:${key}`),
  });
}

async function snapshot<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return withConnection(pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const value = await work(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollback) {
        discardConnection(client, rollback as Error);
      }
      throw error;
    }
  });
}

function matches(row: Receipt, accountId: string, kind: string, proof: unknown, value: unknown) {
  return (
    epoch(row.epoch) &&
    /^[1-9][0-9]{0,18}$/.test(row.position) &&
    routeOf(row.transactionId) !== null &&
    Buffer.from(row.requestDigest).equals(digest(accountId, kind, proof)) &&
    equal(row.response, value)
  );
}

async function activationSource(
  client: PoolClient,
  config: Config,
  input: Extract<OriginalLifecycleRequest, { kind: 'activation' }>,
  source: Extract<OriginalLifecycleSource, { kind: 'activation' }>,
  target: Receipt,
) {
  const proof = source.proof;
  if (
    !equal(proof, {
      accountId: input.accountId,
      registrationId: input.reservationId,
      authIdentityId: input.accountId,
      authnEpoch: 1,
    }) ||
    !iso(source.expiresAt)
  )
    return false;
  // Read the exact sealed original pending command, ignoring only its lifetime.
  // No current account or handle allocation can reconstruct an absent receipt.
  const pending = unseal(config.referenceKeys, 'access.registration-proof.v1', source.pendingReference) as
    | {
        accountId: string;
        key: string;
        handle: string;
        reservationId: string;
        expiresAt: string;
        epoch: number;
        position: string;
        transactionId: string;
      }
    | undefined;
  if (
    !pending ||
    !keys(pending, [
      'accountId',
      'key',
      'handle',
      'reservationId',
      'expiresAt',
      'epoch',
      'position',
      'transactionId',
    ]) ||
    pending.accountId !== input.accountId ||
    pending.reservationId !== input.reservationId ||
    pending.expiresAt !== source.expiresAt ||
    !bounded(pending.key, 256) ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(pending.handle) ||
    !epoch(pending.epoch) ||
    !/^[1-9][0-9]{0,18}$/.test(pending.position) ||
    routeOf(pending.transactionId) === null
  )
    return false;
  const original = await receipt(client, input.accountId, 'actor-pending', pending.key);
  return (
    !!original &&
    original.epoch === pending.epoch &&
    original.position === pending.position &&
    original.transactionId === pending.transactionId &&
    original.epoch <= target.epoch &&
    BigInt(original.position) < BigInt(target.position) &&
    matches(
      original,
      input.accountId,
      'actor-pending',
      { handle: pending.handle, reservationId: pending.reservationId },
      { accountId: input.accountId, registrationId: input.reservationId, expiresAt: pending.expiresAt },
    )
  );
}

async function recoverySource(
  client: PoolClient,
  input: Extract<OriginalLifecycleRequest, { kind: 'recovery' }>,
  source: Extract<OriginalLifecycleSource, { kind: 'recovery' }>,
  target: Receipt,
) {
  const proof = source.proof;
  if (
    proof.accountId !== input.accountId ||
    !epoch(proof.authnEpoch) ||
    !epoch(source.floor.previousEpoch) ||
    proof.authnEpoch !== source.floor.previousEpoch + 1 ||
    proof.minimumAuthnEpoch !== String(proof.authnEpoch) ||
    routeOf(proof.receiptId) !== routeOf(input.accountId) ||
    !bounded(proof.establishmentId) ||
    !iso(proof.expiresAt) ||
    !bounded(source.floor.operationKey, 128) ||
    !/^[a-f0-9]{64}$/.test(source.floor.proofDigest) ||
    createHash('sha256')
      .update(
        JSON.stringify(['access-recovery-completion-v1', input.accountId, proof.receiptId, proof.establishmentId]),
      )
      .digest('hex') !== input.operationKey
  )
    return false;
  const original = await receipt(
    client,
    input.accountId,
    'authentication-floor-advanced',
    `recovery:${source.floor.operationKey}`,
  );
  if (
    !original ||
    original.epoch > target.epoch ||
    BigInt(original.position) >= BigInt(target.position) ||
    !matches(
      original,
      input.accountId,
      'authentication-floor-advanced',
      {
        accountId: input.accountId,
        key: source.floor.operationKey,
        purpose: 'recovery',
        expectedMinimumAuthnEpoch: source.floor.previousEpoch,
        proofReference: input.source.establishmentReference,
        proofDigest: source.floor.proofDigest,
        proofExpiresAt: proof.expiresAt,
      },
      {
        accountId: input.accountId,
        receiptId: proof.receiptId,
        minimumAuthnEpoch: proof.minimumAuthnEpoch,
        kind: 'fence',
        priorOperatorAccountId: null,
      },
    )
  )
    return false;
  return !!(await fence.run(client, {
    route: routeOf(input.accountId)!,
    account_id: input.accountId,
    receipt_id: proof.receiptId,
    transaction_id: original.transactionId,
    minimum_authn_epoch: proof.minimumAuthnEpoch,
  }));
}

/** Private read-only source port. Checkout order is Access, Auth, Access. The
 * second independent native snapshot must see the same full committed receipt,
 * original source commitment and write basis. No command executor is reachable.
 * A moved/fenced partition, missing or minimized receipt stays pending as null. */
export async function readOriginalLifecycleResult(
  config: Config,
  value: OriginalLifecycleRequest,
): Promise<OriginalLifecycleResult | null> {
  const input = decode(value);
  if (!input || !config.source.readOriginalLifecycleSource) return null;
  const kind = input.kind === 'activation' ? 'actor-activated' : 'authentication-established';
  const first = await snapshot(config.pool, (client) => receipt(client, input.accountId, kind, input.operationKey));
  if (!first) return null;
  // The first checkout has ended before invoking the real Auth owner reader.
  const source = await config.source.readOriginalLifecycleSource(structuredClone(input));
  if (!source || source.kind !== input.kind) return null;
  return snapshot(config.pool, async (client) => {
    const original = await receipt(client, input.accountId, kind, input.operationKey);
    if (!original || !equal(original, first)) return null;
    const outcome = {
      partition: partitionOf(routeOf(input.accountId)!),
      epoch: original.epoch,
      position: original.position,
      transactionId: original.transactionId,
    };
    if (input.kind === 'activation' && source.kind === 'activation') {
      const result = { accountId: input.accountId };
      if (
        !matches(original, input.accountId, kind, source.proof, result) ||
        !(await activationSource(client, config, input, source, original))
      )
        return null;
      return {
        kind: 'activation',
        accountId: input.accountId,
        reservationId: input.reservationId,
        authnEpoch: source.proof.authnEpoch,
        outcome: { ...outcome, value: result },
      };
    }
    if (input.kind === 'recovery' && source.kind === 'recovery') {
      const result = {
        accountId: input.accountId,
        receiptId: source.proof.receiptId,
        minimumAuthnEpoch: source.proof.minimumAuthnEpoch,
      };
      if (
        !matches(original, input.accountId, kind, source.proof, result) ||
        !(await recoverySource(client, input, source, original))
      )
        return null;
      return {
        kind: 'recovery',
        accountId: input.accountId,
        establishmentId: source.proof.establishmentId,
        outcome: { ...outcome, value: result },
      };
    }
    return null;
  });
}
