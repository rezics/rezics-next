import { historyArtifact, encodeRoles, validateRoleMask, type HistoryArtifactType } from './contracts.ts';
import { routeOf } from '../route/route.ts';

export const MAX_LOCATOR_BYTES = 256;
export const MAX_SCOPE_ACCOUNTS = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$(?![\s\S])/;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const TYPES = ['command-receipt/v1', 'outbox-event/v1', 'durable-work/v1'] as const;
const MAX_POSITION = 9223372036854775807n;

type ReceiptLocator = Readonly<{
  artifactType: 'command-receipt/v1';
  partitionNo: number;
  principalKind: 'account' | 'anonymous';
  principalId: string;
  commandKindId: number;
  keyVersion: number;
  keyToken: string;
}>;
type OutboxLocator = Readonly<{
  artifactType: 'outbox-event/v1';
  partitionNo: number;
  position: bigint;
  eventSeq: number;
}>;
type WorkLocator = Readonly<{ artifactType: 'durable-work/v1'; workId: string }>;
export type HistoryLocator = ReceiptLocator | OutboxLocator | WorkLocator;
export type AccountReference = Readonly<{ accountRoute: number; accountId: string; roles: number }>;
export type HistoryScope = Readonly<{ artifactType: HistoryArtifactType; accounts: readonly AccountReference[] }>;

function invalid(): never {
  throw new TypeError('Invalid history locator or scope');
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== keys.length || keys.some((key) => !Object.hasOwn(object, key))) invalid();
  return object;
}
function integer(value: unknown, min: number, max: number): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) invalid();
}
function uuid(value: unknown): void {
  if (typeof value !== 'string' || value.length !== 36 || !UUID.test(value)) invalid();
}

/** Closed key shapes exclude raw command keys, handles, payloads and authorization material. */
export function validateLocator(type: HistoryArtifactType, value: unknown): HistoryLocator {
  historyArtifact(type);
  const keys =
    type === 'command-receipt/v1'
      ? ['artifactType', 'partitionNo', 'principalKind', 'principalId', 'commandKindId', 'keyVersion', 'keyToken']
      : type === 'outbox-event/v1'
        ? ['artifactType', 'partitionNo', 'position', 'eventSeq']
        : ['artifactType', 'workId'];
  const key = record(value, keys);
  if (key.artifactType !== type) invalid();
  if (type !== 'durable-work/v1') integer(key.partitionNo, 0, 4095);
  if (type === 'command-receipt/v1') {
    uuid(key.principalId);
    if (key.principalKind !== 'account' && key.principalKind !== 'anonymous') invalid();
    if ((key.principalKind === 'anonymous') !== (key.principalId === ZERO_UUID)) invalid();
    integer(key.commandKindId, 1, 0xffffffff);
    integer(key.keyVersion, 1, 0xffff);
    if (typeof key.keyToken !== 'string' || key.keyToken.length !== 64 || !/^[0-9a-f]{64}$/.test(key.keyToken))
      invalid();
  } else if (type === 'outbox-event/v1') {
    if (typeof key.position !== 'bigint' || key.position < 1n || key.position > MAX_POSITION) invalid();
    integer(key.eventSeq, 0, 999);
  } else {
    // Opaque UUIDs or hex identifiers, never arbitrary DBOS names or caller text. No normalization: exact identity.
    if (
      typeof key.workId !== 'string' ||
      key.workId.length > MAX_LOCATOR_BYTES - 2 ||
      !(UUID.test(key.workId) || /^(?:[0-9a-f]{2}){16,127}$(?![\s\S])/.test(key.workId))
    )
      invalid();
  }
  return value as HistoryLocator;
}

/** Binary v1: version:u8, artifact-tag:u8; integers are unsigned big endian. Receipt: partition:u16,
 * principal-kind:u8 (account=1, anonymous=0), UUID:16, command-kind:u32, key-version:u16, HMAC:32.
 * Outbox: partition:u16, position:u64, sequence:u16. Work: opaque ASCII ID (remainder). */
export function encodeLocator(locator: HistoryLocator): Uint8Array {
  if (typeof locator !== 'object' || locator === null) invalid();
  validateLocator(locator.artifactType, locator);
  const size =
    locator.artifactType === 'command-receipt/v1'
      ? 59
      : locator.artifactType === 'outbox-event/v1'
        ? 14
        : 2 + locator.workId.length;
  const bytes = Buffer.alloc(size);
  bytes[0] = 1;
  bytes[1] = TYPES.indexOf(locator.artifactType) + 1;
  if (locator.artifactType === 'durable-work/v1') bytes.write(locator.workId, 2, 'ascii');
  else {
    bytes.writeUInt16BE(locator.partitionNo, 2);
    if (locator.artifactType === 'outbox-event/v1') {
      bytes.writeBigUInt64BE(locator.position, 4);
      bytes.writeUInt16BE(locator.eventSeq, 12);
    } else {
      bytes[4] = locator.principalKind === 'account' ? 1 : 0;
      Buffer.from(locator.principalId.replaceAll('-', ''), 'hex').copy(bytes, 5);
      bytes.writeUInt32BE(locator.commandKindId, 21);
      bytes.writeUInt16BE(locator.keyVersion, 25);
      Buffer.from(locator.keyToken, 'hex').copy(bytes, 27);
    }
  }
  return bytes;
}

export function decodeLocator(type: HistoryArtifactType, input: Uint8Array): HistoryLocator {
  historyArtifact(type);
  if (!(input instanceof Uint8Array) || input.byteLength < 2 || input.byteLength > MAX_LOCATOR_BYTES) invalid();
  const bytes = Buffer.from(input);
  if (bytes[0] !== 1 || bytes[1] !== TYPES.indexOf(type) + 1) invalid();
  let key: unknown;
  if (type === 'durable-work/v1') {
    // latin1 preserves high bytes so validation rejects them instead of silently masking them to ASCII.
    key = { artifactType: type, workId: bytes.toString('latin1', 2) };
  } else if (type === 'outbox-event/v1') {
    if (bytes.length !== 14) invalid();
    key = {
      artifactType: type,
      partitionNo: bytes.readUInt16BE(2),
      position: bytes.readBigUInt64BE(4),
      eventSeq: bytes.readUInt16BE(12),
    };
  } else {
    if (bytes.length !== 59 || (bytes[4] !== 0 && bytes[4] !== 1)) invalid();
    const hex = bytes.subarray(5, 21).toString('hex');
    key = {
      artifactType: type,
      partitionNo: bytes.readUInt16BE(2),
      principalKind: bytes[4] === 1 ? 'account' : 'anonymous',
      principalId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
      commandKindId: bytes.readUInt32BE(21),
      keyVersion: bytes.readUInt16BE(25),
      keyToken: bytes.subarray(27).toString('hex'),
    };
  }
  return validateLocator(type, key);
}

export function validateScope(type: HistoryArtifactType, value: unknown): HistoryScope {
  const artifact = historyArtifact(type);
  const scope = record(value, ['artifactType', 'accounts']);
  if (scope.artifactType !== type || !Array.isArray(scope.accounts) || scope.accounts.length > MAX_SCOPE_ACCOUNTS)
    invalid();
  const seen = new Set<string>();
  for (const account of scope.accounts) {
    const ref = record(account, ['accountRoute', 'accountId', 'roles']);
    integer(ref.accountRoute, 0, 65535);
    if (typeof ref.accountId !== 'string' || ref.accountId.length !== 36 || routeOf(ref.accountId) !== ref.accountRoute)
      invalid();
    if (validateRoleMask(ref.roles, encodeRoles(artifact.roles)) === 0) invalid();
    if (seen.has(ref.accountId)) invalid();
    seen.add(ref.accountId);
  }
  return value as HistoryScope;
}
