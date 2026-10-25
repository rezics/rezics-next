import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool, PoolClient } from 'pg';
import type { CommandReceipt } from '../command/command.ts';
import readReceipt from '../command/read-receipt.sql';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { seal, unseal, type KeyRing } from '../tokens/seal.ts';
import type { AuthBindingCapabilities, AuthProvisioningReceipt } from './auth-bindings.ts';
import type { createLifecycleInternals } from './lifecycle.ts';
import registrationRead from './registration-proof-account.sql';

type Pending = ReturnType<typeof createLifecycleInternals>['createPending'];
export type RegistrationProofInput = {
  /** Exact createPending input and its awaited native CommandOutcome, including replay metadata. */
  input: Parameters<Pending>[0];
  outcome: Awaited<ReturnType<Pending>>;
};
export type RegistrationProofBindings = {
  createProvisioningReference(input: RegistrationProofInput): Promise<string | null>;
  verifyProvisioningReceipt: NonNullable<AuthBindingCapabilities['verifyProvisioningReceipt']>;
};
type Reference = {
  accountId: string;
  key: string;
  handle: string;
  reservationId: string;
  expiresAt: string;
  transactionId: string;
  epoch: number;
  position: string;
};
const SCOPE = 'access.registration-proof.v1';
const MAX_REFERENCE_LENGTH = 4096;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function decode(value: unknown): Reference | null {
  if (!record(value) || Object.keys(value).length !== 8) return null;
  const { accountId, key, handle, reservationId, expiresAt, transactionId, epoch, position } = value;
  if (
    typeof accountId !== 'string' ||
    routeOf(accountId) === null ||
    typeof key !== 'string' ||
    key.length < 1 ||
    key.length > 256 ||
    [...`${routeOf(accountId)}:${key}`].length > 255 ||
    typeof handle !== 'string' ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(handle) ||
    typeof reservationId !== 'string' ||
    routeOf(reservationId) === null ||
    typeof expiresAt !== 'string' ||
    expiresAt.length !== 24 ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    new Date(expiresAt).toISOString() !== expiresAt ||
    typeof transactionId !== 'string' ||
    routeOf(transactionId) === null ||
    typeof epoch !== 'number' ||
    !Number.isSafeInteger(epoch) ||
    epoch < 1 ||
    typeof position !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(position) ||
    BigInt(position) > 9223372036854775807n
  )
    return null;
  return { accountId, key, handle, reservationId, expiresAt, transactionId, epoch, position };
}

/** Account-only core key adapter. Keep principal/schema adaptation here when the
 * native reader gains principal namespaces; this is lifecycleExecutor's current
 * fixed internal basis, kind, canonical input and route-prefixed key, not caller SQL.
 */
function nativeReceipt(reference: Reference): CommandReceipt & { partition: number } {
  const route = routeOf(reference.accountId)!;
  const basis = {
    actorAccountId: '00000000-0000-8000-8000-000000000001',
    clientId: 'internal-access',
    requestedBy: null,
  };
  return {
    partition: partitionOf(route),
    actorAccountId: basis.actorAccountId,
    kind: 'access.actor-pending',
    key: `${route}:${reference.key}`,
    digest: createHash('sha256')
      .update(
        canonicalize([
          route,
          reference.accountId,
          'actor-pending',
          basis,
          { handle: reference.handle, reservationId: reference.reservationId },
        ])!,
      )
      .digest(),
  };
}
function responseMatches(value: unknown, reference: Reference): value is AuthProvisioningReceipt {
  return (
    record(value) &&
    Object.keys(value).length === 3 &&
    value.accountId === reference.accountId &&
    value.registrationId === reference.reservationId &&
    value.expiresAt === reference.expiresAt
  );
}
async function verifySnapshot(client: PoolClient, reference: Reference): Promise<AuthProvisioningReceipt | null> {
  const native = nativeReceipt(reference);
  const partition = await readPartition(client, native.partition);
  if (
    !partition ||
    partition.writeState !== 'active' ||
    partition.epoch < reference.epoch ||
    partition.position < BigInt(reference.position)
  )
    return null;
  // Use core's trusted reader and exact primary key; never search response JSON or history.
  const receipt = await readReceipt.run(client, {
    partition_no: native.partition,
    principal_kind: 'account',
    principal_id: native.actorAccountId,
    command_kind: native.kind,
    idempotency_key: native.key,
  });
  if (
    !receipt ||
    !Buffer.from(receipt.requestDigest).equals(Buffer.from(native.digest)) ||
    receipt.transactionId !== reference.transactionId ||
    receipt.epoch !== reference.epoch ||
    BigInt(receipt.position) !== BigInt(reference.position) ||
    !responseMatches(receipt.response, reference)
  )
    return null;
  // PostgreSQL supplies this read's authoritative time. Current private facts and
  // creation transaction must still agree, regardless of registration cleanup lag.
  const current = await registrationRead.run(client, {
    route: routeOf(reference.accountId)!,
    account_id: reference.accountId,
    handle: reference.handle,
    reservation_id: reference.reservationId,
    expires_at: reference.expiresAt,
    transaction_id: reference.transactionId,
  });
  return current
    ? {
        accountId: reference.accountId,
        registrationId: reference.reservationId,
        expiresAt: reference.expiresAt,
      }
    : null;
}

/** Internal, read-only capability for createAuthBindings({pool, ...bindings}).
 * Supply the actual shared KeyRing; no generated keys, environment fallback or
 * independent receipt store exists. References expose only nonsecret locator and
 * binding facts. Possession conveys no Auth authority and proves no Auth work.
 *
 * After `outcome = await lifecycle.createPending(input)`, call
 * `await bindings.createProvisioningReference({input, outcome})`, where input is
 * {accountId, key, handle, reservationId}. The creator independently verifies the
 * committed native receipt and current registration before issuing a reference;
 * even structurally forged outcomes cannot mint evidence of an absent commit.
 * The Auth host can consume this capability later; this factory mounts no workflow.
 */
export function createRegistrationProofBindings(config: {
  pool: Pool;
  referenceKeys: KeyRing;
}): RegistrationProofBindings {
  const { pool, referenceKeys } = config;
  async function verifyProvisioningReceipt(reference: string): Promise<AuthProvisioningReceipt | null> {
    try {
      const decoded = decode(unseal(referenceKeys, SCOPE, reference));
      if (!decoded) return null;
      return await withConnection(pool, async (client) => {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          const result = await verifySnapshot(client, decoded);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          try {
            await client.query('ROLLBACK');
          } catch (rollbackError) {
            discardConnection(client, rollbackError as Error);
          }
          throw error;
        }
      });
    } catch {
      return null;
    }
  }
  return {
    async createProvisioningReference({ input, outcome }) {
      try {
        if (
          typeof input.handle !== 'string' ||
          input.handle.length > 64 ||
          typeof outcome.position !== 'bigint' ||
          outcome.position < 1n ||
          outcome.position > 9223372036854775807n ||
          typeof outcome.replayed !== 'boolean'
        )
          return null;
        const reference = decode({
          accountId: input.accountId,
          key: input.key,
          handle: input.handle.toLowerCase(),
          reservationId: input.reservationId,
          expiresAt: outcome.value.expiresAt,
          transactionId: outcome.transactionId,
          epoch: outcome.epoch,
          position: outcome.position.toString(),
        });
        if (
          !reference ||
          outcome.partition !== partitionOf(routeOf(reference.accountId)!) ||
          !responseMatches(outcome.value, reference)
        )
          return null;
        const encoded = seal(referenceKeys, SCOPE, reference);
        if (encoded.length > MAX_REFERENCE_LENGTH) return null;
        return (await verifyProvisioningReceipt(encoded)) ? encoded : null;
      } catch {
        return null;
      }
    },
    verifyProvisioningReceipt,
  };
}
