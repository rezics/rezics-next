import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { PrincipalCommandIdentity } from '../command/command.ts';
import { PARTITIONS, partitionOf, routeOf } from '../route/route.ts';
import type { TypePreparationBinding, TypePreparationOrigin } from './type-preparation-contract.ts';

type Identity = Readonly<{
  sourceId: string;
  partition: number;
  epoch: number;
  revision: number;
  transactionId: string;
  redirect: string | null;
}>;

/** Immutable native metadata only; neither source equality evidence nor an authorization token. */
export type PreparationHeaderCommitment = Readonly<{
  version: 1;
  route: number;
  accountId: string;
  preparationId: string;
  binding: TypePreparationBinding;
  origin: TypePreparationOrigin;
  sourceIdentity: Identity;
  originIdentity: Identity;
  principalNamespace: Extract<PrincipalCommandIdentity, { principal: { kind: 'account' } }>;
  reservationId: string | null;
  inputByteLength: string;
  inputDigest: string;
  creationTransactionId: string;
  creationReceipt: Readonly<{
    partition: number;
    principalKind: 'account';
    principalId: string;
    commandKind: string;
    key: string;
    digest: string;
  }>;
  createdAt: string;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const DIGEST = /^[0-9a-f]{64}$/;

function requireValue(valid: boolean): asserts valid {
  if (!valid) throw new TypeError('Invalid preparation header metadata');
}

/** No unknown, missing, hidden or computed properties may disappear during canonicalization. */
function exact(value: unknown, keys: readonly string[]): void {
  requireValue(value !== null && typeof value === 'object');
  const prototype = Object.getPrototypeOf(value);
  requireValue(prototype === Object.prototype || prototype === null);
  const ownKeys = Reflect.ownKeys(value);
  requireValue(ownKeys.length === keys.length);
  for (const key of ownKeys) {
    requireValue(typeof key === 'string' && keys.includes(key));
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    requireValue(descriptor.enumerable === true && Object.hasOwn(descriptor, 'value'));
  }
}

function text(value: unknown, pattern?: RegExp): void {
  requireValue(typeof value === 'string' && value.isWellFormed() && (!pattern || pattern.exec(value)?.[0] === value));
}

function idRoute(id: string): number | null {
  text(id, UUID);
  return routeOf(id);
}

function positive(value: number): void {
  requireValue(Number.isSafeInteger(value) && value > 0);
}

function sourcePartition(id: string, partition: number): void {
  const route = idRoute(id);
  requireValue(route !== null && Number.isInteger(partition) && partition >= 0 && partition < PARTITIONS);
  requireValue(partitionOf(route) === partition);
}

function identity(value: Identity): void {
  exact(value, ['sourceId', 'partition', 'epoch', 'revision', 'transactionId', 'redirect']);
  sourcePartition(value.sourceId, value.partition);
  positive(value.epoch);
  positive(value.revision);
  text(value.transactionId, UUID);
  requireValue(value.redirect === null || idRoute(value.redirect) !== null);
}

function timestamp(value: string): void {
  text(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{6}Z$/.exec(value);
  requireValue(match !== null && match[0] === value);
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  requireValue(year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!);
  requireValue(hour <= 23 && minute <= 59 && second <= 59);
}

/** SHA-256 of the exact RFC 8785 header. Callers must independently authenticate native evidence. */
export function preparationHeaderCommitment(payload: PreparationHeaderCommitment): string {
  exact(payload, [
    'version',
    'route',
    'accountId',
    'preparationId',
    'binding',
    'origin',
    'sourceIdentity',
    'originIdentity',
    'principalNamespace',
    'reservationId',
    'inputByteLength',
    'inputDigest',
    'creationTransactionId',
    'creationReceipt',
    'createdAt',
  ]);
  const { route, accountId, binding, origin, sourceIdentity, originIdentity, principalNamespace, creationReceipt } =
    payload;
  requireValue(payload.version === 1);
  requireValue(Number.isInteger(route) && route >= 0 && route <= 65535);
  requireValue(idRoute(accountId) === route && idRoute(payload.preparationId) === route);
  requireValue(payload.reservationId === null || idRoute(payload.reservationId) === route);
  text(payload.inputByteLength, DECIMAL);
  text(payload.inputDigest, DIGEST);
  text(payload.creationTransactionId, UUID);
  timestamp(payload.createdAt);

  exact(binding, [
    'accountId',
    'subjectId',
    'requestKey',
    'sourceId',
    'sourcePartition',
    'sourceEpoch',
    'sourcePosition',
    'ownerEpoch',
  ]);
  requireValue(binding.accountId === accountId && idRoute(binding.subjectId) !== null);
  text(binding.requestKey);
  requireValue(binding.requestKey.length > 0);
  sourcePartition(binding.sourceId, binding.sourcePartition);
  positive(binding.sourceEpoch);
  text(binding.sourcePosition, DECIMAL);
  text(binding.ownerEpoch, DECIMAL);

  exact(origin, ['sourceId', 'partition', 'epoch', 'position', 'survivorId']);
  requireValue(origin.sourceId === binding.subjectId);
  sourcePartition(origin.sourceId, origin.partition);
  positive(origin.epoch);
  text(origin.position, DECIMAL);
  identity(sourceIdentity);
  identity(originIdentity);
  requireValue(
    sourceIdentity.sourceId === binding.sourceId &&
      sourceIdentity.partition === binding.sourcePartition &&
      sourceIdentity.epoch === binding.sourceEpoch &&
      sourceIdentity.redirect === null,
  );
  requireValue(
    originIdentity.sourceId === origin.sourceId &&
      originIdentity.partition === origin.partition &&
      originIdentity.epoch === origin.epoch &&
      originIdentity.redirect === origin.survivorId,
  );
  if (origin.sourceId === binding.sourceId) {
    requireValue(
      origin.survivorId === null &&
        origin.partition === binding.sourcePartition &&
        origin.epoch === binding.sourceEpoch &&
        origin.position === binding.sourcePosition &&
        originIdentity.revision === sourceIdentity.revision &&
        originIdentity.transactionId === sourceIdentity.transactionId,
    );
  } else requireValue(origin.survivorId === binding.sourceId);

  exact(principalNamespace, ['principal', 'basis']);
  exact(principalNamespace.principal, ['kind', 'id']);
  exact(principalNamespace.basis, ['clientId', 'requestedBy']);
  requireValue(principalNamespace.principal.kind === 'account' && principalNamespace.principal.id === accountId);
  text(principalNamespace.basis.clientId);
  requireValue(principalNamespace.basis.clientId.length > 0);
  if (principalNamespace.basis.requestedBy !== null) text(principalNamespace.basis.requestedBy);

  exact(creationReceipt, ['partition', 'principalKind', 'principalId', 'commandKind', 'key', 'digest']);
  requireValue(
    creationReceipt.partition === partitionOf(route) &&
      creationReceipt.principalKind === 'account' &&
      creationReceipt.principalId === accountId &&
      creationReceipt.commandKind === 'library.type-preparation.create',
  );
  text(creationReceipt.key);
  requireValue(creationReceipt.key.length >= 1 && creationReceipt.key.length <= 255);
  text(creationReceipt.digest, DIGEST);
  const canonical = canonicalize(payload);
  requireValue(typeof canonical === 'string');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
