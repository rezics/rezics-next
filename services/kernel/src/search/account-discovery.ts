import { PARTITIONS, routeOf } from '../route/route.ts';
import {
  MAX_ACCOUNT_DISCOVERY_BATCH,
  discoveryPartition,
  type AccountDiscoverySource,
  type AccountFrontier,
  type AccountPage,
  type AccountSnapshot,
  type IndexedAccount,
} from './discovery.ts';
import { accountDocumentActions } from './document.ts';
import type { SubjectSource } from './source.ts';

const MAX_NATIVE_REVISION = 9_223_372_036_854_775_807n;
const MAX_EXTERNAL_VERSION = BigInt(Number.MAX_SAFE_INTEGER);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function partitionNumber(partition: number): void {
  if (!Number.isInteger(partition) || partition < 0 || partition >= PARTITIONS)
    throw new RangeError('Invalid discovery partition');
}

function keys(partition: number, ids: readonly string[]): string[] {
  partitionNumber(partition);
  if (ids.length > MAX_ACCOUNT_DISCOVERY_BATCH) throw new RangeError('Account discovery accepts at most 100 ids');
  for (const id of ids) {
    if (discoveryPartition(id) !== partition) throw new RangeError('Account discovery key is outside its partition');
  }
  return [...new Set(ids)];
}

function position(value: unknown, obligation: bigint): bigint {
  if (
    typeof obligation !== 'bigint' ||
    obligation < 0n ||
    obligation > MAX_EXTERNAL_VERSION ||
    typeof value !== 'bigint' ||
    value < obligation ||
    value < 0n ||
    value > MAX_EXTERNAL_VERSION
  )
    throw new TypeError('Account snapshot position must cover the batch within the external version domain');
  return value;
}

function account(value: unknown, partition: number): IndexedAccount {
  if (
    !record(value) ||
    typeof value.id !== 'string' ||
    discoveryPartition(value.id) !== partition ||
    (value.accountKind !== 'actor' && value.accountKind !== 'organization') ||
    (value.handle !== null && (typeof value.handle !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.handle))) ||
    (value.displayName !== null && typeof value.displayName !== 'string') ||
    typeof value.revision !== 'bigint' ||
    value.revision < 1n ||
    value.revision > MAX_NATIVE_REVISION
  )
    throw new TypeError('Invalid native Account discovery row');
  return {
    id: value.id,
    accountKind: value.accountKind,
    handle: value.handle,
    displayName: value.displayName,
    revision: value.revision,
  };
}

/** Admit the whole native chunk before sort preparation or engine I/O; omission means keyed deletion. */
export function validateAccountSnapshot(
  value: unknown,
  partition: number,
  ids: readonly string[],
  atLeast: bigint,
): AccountSnapshot {
  const requested = new Set(keys(partition, ids));
  if (
    !record(value) ||
    value.partition !== partition ||
    !Array.isArray(value.accounts) ||
    value.accounts.length > requested.size
  )
    throw new TypeError('Account snapshot must contain unique requested rows in the requested partition');
  const observed = position(value.position, atLeast);
  if (requested.size > 0 && observed === 0n) throw new TypeError('Account write version must be positive');
  const seen = new Set<string>();
  const accounts = value.accounts.map((row) => {
    const current = account(row, partition);
    if (!requested.has(current.id) || seen.has(current.id)) throw new TypeError('Unrequested or duplicate Account row');
    seen.add(current.id);
    return current;
  });
  return { partition, position: observed, accounts };
}

function frontier(value: unknown, partition: number): AccountFrontier {
  if (
    !record(value) ||
    typeof value.id !== 'string' ||
    typeof value.route !== 'number' ||
    routeOf(value.id) !== value.route ||
    discoveryPartition(value.id) !== partition
  )
    throw new TypeError('Invalid Account population frontier');
  return { route: value.route, id: value.id };
}

function compare(a: AccountFrontier, b: AccountFrontier): number {
  return a.route - b.route || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Native keyset order/exhaustion is retained even when the exact claim produces a null handle. */
export function validateAccountPage(
  value: unknown,
  partition: number,
  after: AccountFrontier | null,
  limit: number,
): AccountPage {
  partitionNumber(partition);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ACCOUNT_DISCOVERY_BATCH)
    throw new RangeError('Account population page limit must be from 1 to 100');
  let previous = after === null ? null : frontier(after, partition);
  if (
    !record(value) ||
    value.partition !== partition ||
    !Array.isArray(value.accounts) ||
    value.accounts.length > limit
  )
    throw new TypeError('Invalid Account population page');
  const observed = position(value.position, 0n);
  const accounts = value.accounts.map((row) => {
    const current = account(row, partition);
    const key = frontier({ route: routeOf(current.id), id: current.id }, partition);
    if (previous !== null && compare(previous, key) >= 0) throw new TypeError('Account population keys must advance');
    previous = key;
    return current;
  });
  if (accounts.length > 0 && observed === 0n) throw new TypeError('Account write version must be positive');
  const next = value.next === null ? null : frontier(value.next, partition);
  if (next !== null && (accounts.length !== limit || previous === null || compare(previous, next) !== 0))
    throw new TypeError('Account population continuation must identify the last full-page key');
  return { partition, position: observed, accounts, next };
}

/** One native bootstrap page. Persist next only after the existing writer settles all returned actions. */
export async function prepareAccountPopulationPage(
  source: AccountDiscoverySource,
  partition: number,
  after: AccountFrontier | null,
  limit = MAX_ACCOUNT_DISCOVERY_BATCH,
) {
  // Validate caller input before handing it to the native owner.
  partitionNumber(partition);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ACCOUNT_DISCOVERY_BATCH)
    throw new RangeError('Account population page limit must be from 1 to 100');
  if (after !== null) frontier(after, partition);
  const snapshot = validateAccountPage(await source.page(partition, after, limit), partition, after, limit);
  return {
    snapshot,
    actions: accountDocumentActions(
      snapshot,
      snapshot.accounts.map(({ id }) => id),
    ),
  };
}

/** Event keys only; reread current native rows, retaining every tail within the same checkpoint obligation. */
export async function* prepareAccountCatchup(
  source: AccountDiscoverySource,
  partition: number,
  ids: readonly string[],
  atLeast: bigint,
) {
  partitionNumber(partition);
  const unique = [...new Set(ids)];
  // Reject foreign keys in the entire batch before admitting any prefix.
  for (const id of unique) {
    if (discoveryPartition(id) !== partition) throw new RangeError('Account discovery key is outside its partition');
  }
  position(atLeast, 0n);
  for (let offset = 0; offset < unique.length; offset += MAX_ACCOUNT_DISCOVERY_BATCH) {
    const chunk = unique.slice(offset, offset + MAX_ACCOUNT_DISCOVERY_BATCH);
    const snapshot = validateAccountSnapshot(await source.read(partition, chunk), partition, chunk, atLeast);
    yield { snapshot, actions: accountDocumentActions(snapshot, chunk) };
  }
}

export type DiscoveryCensus = {
  partition: number;
  position: bigint;
  subjects: number;
  accounts: number;
};

/** Both owners must observe the same native cut. These values never supply KindCountEvidence. */
export async function readDiscoveryCensus(
  subjects: SubjectSource,
  accounts: AccountDiscoverySource,
  partition: number,
): Promise<DiscoveryCensus> {
  partitionNumber(partition);
  const subject = await subjects.count(partition);
  const account = await accounts.count(partition);
  const valid = (value: unknown): value is { position: bigint; count: number } =>
    record(value) &&
    typeof value.position === 'bigint' &&
    value.position >= 0n &&
    value.position <= MAX_NATIVE_REVISION &&
    typeof value.count === 'number' &&
    Number.isSafeInteger(value.count) &&
    value.count >= 0;
  if (!valid(subject) || !valid(account) || account.partition !== partition)
    throw new TypeError('Both native discovery censuses are required');
  if (subject.position !== account.position) throw new Error('Discovery census observations moved; reconcile again');
  return { partition, position: subject.position, subjects: subject.count, accounts: account.count };
}
