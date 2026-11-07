import type { Pool } from 'pg';
import { ProblemError } from '../http/problem-error.ts';
import { currentCommandResources, type CommandTransaction } from '../command/command.ts';
import {
  activeIdentitySourceConsumerMaintenance,
  currentIdentitySourceConsumerMaintenance,
  identitySourceConsumerLibraryWork,
  isPrepaidIdentitySourceConsumerMaintenance,
  identitySourceConsumerScheduleReceipt,
} from '../semantic/identity-source-consumer-maintenance.ts';
import { NativeCollectionWork, instrumentNativeCollectionWork } from './collection-source-work.ts';
import type { WorkAllowance, WorkDimensions } from './contract/work-dimensions.ts';
import { peekLibraryDomain } from './domain-binding.ts';
import {
  isLibraryIdentityFullPartitionSQL,
  libraryIdentityNativeOperationFootprint,
} from './identity-native-bounds.ts';

type Binding = { pool?: Pool; deadline: number; assertLive?: () => void };
const bindings = new WeakMap<NativeCollectionWork, Binding>();
const selectedCalls = new WeakMap<NativeCollectionWork, Map<string, number>>();

/** Consume a claim already made by Source's genuine selected-original scheduler.
 * Copies, direct callbacks without a claim, repeats and failed dispatch cannot
 * reopen it. Ordinary independently admitted Library work keeps its existing API.
 */
export function consumeLibraryIdentitySelectedCall(
  pool: Pool,
  work: NativeCollectionWork,
  operation: 'effectPages' | 'verification' | 'discovery' | 'plannerSteps',
): void {
  assertLibraryIdentityWork(work);
  if (!isPrepaidIdentitySourceConsumerMaintenance(pool)) return;
  const active = activeIdentitySourceConsumerMaintenance(pool);
  const receipt = active && identitySourceConsumerScheduleReceipt(pool, active.identityConsumerWork, deadlineOf(work));
  const used = selectedCalls.get(work) ?? new Map<string, number>();
  const names = operation === 'verification' ? ['currentVerifications', 'exhaustedPageRechecks'] : [operation];
  const name = names.find((name) => (receipt?.calls[`Library.${name}`] ?? 0) > (used.get(name) ?? 0));
  if (!receipt?.claimed || !name) throw new TypeError(`Missing unspent selected Library ${operation} claim`);
  used.set(name, (used.get(name) ?? 0) + 1);
  selectedCalls.set(work, used);
}
/** Accounts owns original authentication; Source owns its receiving callback. Never infer
 * either from a record, reservation ID, allowance or a caller's claimed deadline. */
export function bindLibraryIdentityPrepaidWork(pool: Pool, work: NativeCollectionWork, deadline: number): void {
  const active = activeIdentitySourceConsumerMaintenance(pool);
  const assertLive = () => {
    if (
      !active ||
      active.deadline !== deadline ||
      identitySourceConsumerLibraryWork(pool, active.identityConsumerWork, deadline) !== work
    )
      throw new TypeError('Missing live prepaid Library partition');
    work.assertReady(); // The Accounts proxy also validates the original grant around method calls.
  };
  assertLive();
  bindLibraryIdentityDeadline(work, deadline);
  const binding = bindings.get(work)!;
  if (binding.pool && binding.pool !== pool) throw new TypeError('Foreign Library work pool');
  binding.pool = pool;
  binding.assertLive = assertLive;
}
export function assertLibraryIdentityWork(work: NativeCollectionWork): void {
  const binding = bindings.get(work);
  if (!binding) throw new TypeError('Unbound Library work');
  binding.assertLive?.();
  work.assertReady();
  if (Date.now() >= binding.deadline) throw new ProblemError('dependency_unavailable');
}
export function assertLibraryIdentityResources(pool: Pool, work: NativeCollectionWork, deadline: number): void {
  const binding = bindings.get(work);
  if (!binding || binding.pool !== pool || binding.deadline !== deadline)
    throw new TypeError('Library command changed its prepaid resources');
  assertLibraryIdentityWork(work);
}
export function revalidateBoundLibraryIdentityWork(work: NativeCollectionWork): void {
  if (bindings.has(work)) assertLibraryIdentityWork(work);
}
const transactions = new WeakMap<CommandTransaction, NativeCollectionWork>();
export function bindLibraryIdentityDeadline(work: NativeCollectionWork, deadline: number): NativeCollectionWork {
  const prior = bindings.get(work);
  if (prior && prior.deadline !== deadline) throw new TypeError('Library work deadline changed');
  if (!prior) bindings.set(work, { deadline });
  return work;
}
export function deadlineOf(work: NativeCollectionWork): number {
  const binding = bindings.get(work);
  if (!binding) throw new TypeError('Unbound Library work');
  return binding.deadline;
}
export function allowance(work: NativeCollectionWork): WorkAllowance {
  return {
    reservationId: work.receipt().reservationId,
    remaining: {
      candidateKeys: work.available('candidateKeys'),
      nativeRows: work.available('nativeRows'),
      identityMetadataRows: work.available('identityMetadataRows'),
      nativePoints: work.available('nativePoints'),
      witnessKeys: work.available('witnessKeys'),
      statements: work.available('statements'),
      bytes: work.available('bytes'),
      emptySeeks: work.available('emptySeeks'),
    },
  };
}
export async function withLibraryIdentityWork<T>(
  pool: Pool,
  work: NativeCollectionWork,
  body: () => Promise<T>,
): Promise<T> {
  const binding = bindings.get(work);
  if (!binding || (binding.pool && binding.pool !== pool)) throw new TypeError('Foreign Library work pool');
  binding.pool = pool;
  assertLibraryIdentityWork(work);
  const result = await body();
  assertLibraryIdentityWork(work);
  return result;
}
export async function libraryIdentityWorkFor<T>(
  tx: CommandTransaction,
  work: NativeCollectionWork,
  body: () => Promise<T>,
): Promise<T> {
  const resources = currentCommandResources(tx),
    binding = bindings.get(work);
  if (!binding || binding.pool !== resources.pool || resources.deadline !== binding.deadline)
    throw new TypeError('Library command changed its prepaid resources');
  assertLibraryIdentityWork(work);
  transactions.set(tx, work);
  try {
    const result = await body();
    assertLibraryIdentityWork(work);
    return result;
  } finally {
    transactions.delete(tx);
  }
}
/** Resolve an existing live allocation. No allocation, allowance or consumer frame is created here. */
export function currentLibraryIdentityWork(tx: CommandTransaction): NativeCollectionWork | null {
  const resources = currentCommandResources(tx);
  const local = transactions.get(tx);
  if (local) {
    assertLibraryIdentityWork(local);
    return local;
  }
  const token = currentIdentitySourceConsumerMaintenance(resources.pool, resources.deadline);
  const work = token ? identitySourceConsumerLibraryWork(resources.pool, token, resources.deadline) : null;
  if (work) bindLibraryIdentityPrepaidWork(resources.pool, work, resources.deadline);
  return work;
}
/** All statements of the nested read, including checkout, BEGIN and cleanup, use this same ledger. */
export function bounded<T>(work: NativeCollectionWork, body: () => Promise<T>): Promise<T> {
  assertLibraryIdentityWork(work);
  const binding = bindings.get(work);
  if (!binding?.pool) throw new TypeError('Unbound Library read pool');
  return instrumentNativeCollectionWork(
    binding.pool,
    work,
    (sql, values) => libraryIdentityFootprint(sql, values, work),
    body,
  );
}
export { libraryIdentityJobSizeSQL } from './identity-native-bounds.ts';
/** The compatibility observation delegates to the immutable declarations actually used by Library dispatch.
 * A prepaid selected original refuses the unbounded full Core partition projection without same-snapshot size evidence.
 */
export function libraryIdentityFootprint(
  sql: string,
  values: readonly unknown[],
  work?: NativeCollectionWork,
): WorkDimensions | undefined {
  if (work) assertLibraryIdentityWork(work);
  const native = peekLibraryDomain()?.identityNative;
  const fullPartition = native?.isFullPartitionSQL ?? isLibraryIdentityFullPartitionSQL;
  if (work && bindings.get(work)?.assertLive && fullPartition(sql)) return undefined;
  return native?.footprint(sql, values, work) ?? libraryIdentityNativeOperationFootprint(sql, values, work);
}
