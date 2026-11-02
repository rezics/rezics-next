import {
  libraryIdentitySelectedFootprint,
  isNativeIdentitySourceBasisSQL,
  nativeIdentitySourceBasisFootprint,
} from './identity-native-planner-selected-pricing.ts';
import type { Pool } from 'pg';
import { ProblemError } from '../http/problem.ts';
import { currentCommandResources, type CommandTransaction } from '../command/command.ts';
import {
  activeIdentitySourceConsumerMaintenance,
  currentIdentitySourceConsumerMaintenance,
  identitySourceConsumerLibraryWork,
  isPrepaidIdentitySourceConsumerMaintenance,
  identitySourceConsumerScheduleReceipt,
} from '../semantic/identity-source-consumer-maintenance.ts';
import { NativeCollectionWork, instrumentNativeCollectionWork } from './collection-source-work.ts';
import type { WorkAllowance, WorkDimensions } from './collection-source.ts';
import { libraryIdentitySQL, libraryIdentitySQLCost } from './identity-native-planner-statements.ts';
import plan from './identity-native-planner-read.sql';
import current from './identity-native-planner-current.sql';
import job from './identity-native-planner-job.sql';
import seal from './identity-scope-effects-seal.sql';
import time from '../command/time.sql';
import fence from '../command/fence.sql';
import noEffectFence from '../command/no-effect-fence.sql';
import partition from '../partition/read.sql';
import account from '../access/account-share.sql';
import commit from '../semantic/identity-epoch-store-insert-native-commit.sql';
import savedJob from '../semantic/identity-epoch-store-select-job-4.sql';
import libraryTransform from '../semantic/identity-epoch-store-library-transform.sql';
import { identityEpochLibraryInputsSQL } from '../semantic/identity-epoch-store.ts';
import inputs from '../semantic/identity-epoch-store-select-input.sql';
import originals from '../semantic/identity-epoch-store-select-original.sql';
import owners from '../semantic/identity-epoch-read-owners.sql';
import sources from '../semantic/identity-epoch-read-sources.sql';
import pending from '../semantic/identity-epoch-read-pending.sql';
import mapping from '../semantic/identity-epoch-read-current.sql';
import facts from './collection-source-native-facts.sql';
import labels from './owner-index-native-label-originals.sql';
import {
  libraryIdentityBoundedPlanSQL,
  libraryIdentityBoundedJobSQL,
  libraryIdentityBoundedEffectPageSQL,
  libraryIdentitySelectedBindBound,
  LIBRARY_IDENTITY_PLAN_RESULT_BYTES,
} from './identity-native-planner-projection.ts';

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
const normalize = (sql: string) =>
  sql
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/;$/, '')
    .trim();
const equal = (a: string, b: string) => normalize(a) === normalize(b);
const count = (value: unknown, max: number): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= max ? value : undefined;
function cost(
  sql: string,
  values: readonly unknown[],
  rows: number,
  points: number,
  metadata: number,
  output: number,
  candidates = 0,
  seeks = 0,
): WorkDimensions {
  // Bound includes SQL, all original binds and the schema/admitted result projection, even on failure.
  const binds = JSON.stringify(values, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
  return {
    candidateKeys: candidates,
    nativeRows: rows,
    identityMetadataRows: metadata,
    nativePoints: points,
    witnessKeys: 0,
    statements: 1,
    bytes: Buffer.byteLength(sql) + Buffer.byteLength(binds) + output,
    emptySeeks: seeks,
  };
}
export const libraryIdentityJobSizeSQL = `SELECT octet_length(intent::text) AS bytes FROM semantic.identity_epoch_job WHERE partition_no=$1 AND job_id=$2 AND epoch=$3`;
/** Literal normal-receiving cost declaration for Source's SQL owner to recognize. Undefined stays unknown.
 * No table-name fallback. Bound includes one indexed EOF slot per bounded range and all joined/FK probes.
 * Cleanup slots are reserved by instrumentNativeCollectionWork BEFORE BEGIN; dispatched failure/rollback
 * and repeats stay charged. Zero identity rows on native-only SQL, zero witnesses everywhere, are intentional.
 */
export function libraryIdentityFootprint(
  sql: string,
  values: readonly unknown[],
  work?: NativeCollectionWork,
): WorkDimensions | undefined {
  if (work) assertLibraryIdentityWork(work);
  if (isNativeIdentitySourceBasisSQL(sql)) return nativeIdentitySourceBasisFootprint(sql, values);
  if (!libraryIdentitySelectedBindBound(sql, values)) return undefined;
  const selected = libraryIdentitySelectedFootprint(sql, values);
  if (selected) return selected;
  const text = normalize(sql);
  const point = (rows: number, points: number, metadata: number, output: number, seeks = 0) =>
    cost(sql, values, rows, points, metadata, output, 0, seeks);
  if (
    [
      'BEGIN ISOLATION LEVEL SERIALIZABLE',
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY',
      'COMMIT',
      'ROLLBACK',
      "SET LOCAL lock_timeout = '200ms'",
    ].includes(text) ||
    /^SET LOCAL statement_timeout = '[1-9][0-9]*ms'$/.test(text)
  )
    return point(0, 0, 0, 0);
  if (equal(sql, time.sql)) return point(0, 0, 0, 128);
  if (equal(sql, partition.sql)) {
    // Core's full command projection includes unbounded node/moved_to text and
    // supplies no same-snapshot size point. Its legacy estimate cannot price an
    // authentic original. Keep ordinary execution's existing behavior separate.
    if (work && bindings.get(work)?.assertLive) return undefined;
    return point(1, 1, 1, 256, 1);
  }
  if (equal(sql, account.sql)) return point(1, 1, 0, 64, 1);
  if (equal(sql, noEffectFence.sql) && values[2] === null) return point(1, 1, 1, 64, 1);
  if (equal(sql, fence.sql) && values[3] === null && values[4] === null) {
    const events = typeof values[1] === 'string' ? JSON.parse(values[1]) : values[1];
    if (
      !Array.isArray(events) ||
      events.length !== 1 ||
      events[0]?.type !== 'com.rezics.semantic.identity-epoch.admitted.v1'
    )
      return undefined;
    return point(2, 2, 1, 64);
  }
  if (equal(sql, commit.sql) && values[2] === 'library-private-follow-counts') return point(2, 2, 1, 64);
  if (equal(sql, plan.sql) || equal(sql, plan.sql.replace(/;\s*$/, ' FOR UPDATE'))) return point(1, 1, 0, 12288, 1);
  if (
    equal(sql, libraryIdentityBoundedPlanSQL) ||
    equal(sql, libraryIdentityBoundedPlanSQL.replace(/;\s*$/, ' FOR UPDATE'))
  )
    return point(1, 1, 0, LIBRARY_IDENTITY_PLAN_RESULT_BYTES, 1);
  if (equal(sql, current.sql)) return point(7, 7, 1, 64, 1);
  // Admission input cardinality is contractually <=2. EXISTS and NOT EXISTS each use that prefix.
  if (equal(sql, job.sql)) return point(16, 13, 16, 2048, 4);
  if (equal(sql, libraryIdentityBoundedJobSQL)) return point(16, 13, 16, 2048, 4);
  if (equal(sql, libraryIdentityBoundedEffectPageSQL)) {
    const n = count(values[5], 100);
    return n === undefined ? undefined : cost(sql, values, n + 1, 1, 0, 512 * n, n, 1);
  }
  if (equal(sql, seal.sql)) return point(5, 5, 2, 256, 1);
  if (equal(sql, libraryIdentityJobSizeSQL)) return point(1, 1, 1, 32, 1);
  // Three native primary-key joins; projection is closed kind plus four UUID-or-null fields.
  if (equal(sql, libraryTransform.sql)) return point(3, 3, 2, 256, 3);
  if (equal(sql, identityEpochLibraryInputsSQL)) return point(3, 1, 3, 512, 1);
  if (equal(sql, savedJob.sql)) {
    const bytes = work?.resultByteBound(`library-job:${values[1]}:${values[2]}`);
    return bytes === undefined ? undefined : point(1, 1, 1, bytes + 256, 1);
  }
  if (equal(sql, inputs.sql)) return point(3, 1, 3, 512, 1);
  if (equal(sql, originals.sql)) {
    const n = count(values[2], 100);
    return n === undefined ? undefined : point(n + 1, 1, n + 1, 256 * n, 1);
  }
  for (const [identity, perRow, points, output] of [
    [owners.sql, 1, 1, 256],
    [sources.sql, 4, 4, 1024],
    [pending.sql, 1, 1, 256],
    [mapping.sql, 2, 2, 256],
  ] as const) {
    if (!equal(sql, identity)) continue;
    const n = Array.isArray(values[0]) ? count(values[0].length, 100) : undefined;
    return n === undefined ? undefined : point(n * perRow, n * points, n * perRow, n * output, n);
  }
  if (equal(sql, facts.sql) || equal(sql, labels.sql)) {
    const n = count(values[4], 100);
    return n === undefined ? undefined : cost(sql, values, n + 1, 1, 0, n * 256, n, 1);
  }
  for (const name of Object.keys(libraryIdentitySQL) as (keyof typeof libraryIdentitySQL)[]) {
    if (!equal(sql, libraryIdentitySQL[name])) continue;
    const spec = libraryIdentitySQLCost[name];
    const n = spec.rows === 'range' ? count(values[spec.limitParameter - 1], 100) : undefined;
    if (spec.rows === 'range' && n === undefined) return undefined;
    return cost(
      sql,
      values,
      n === undefined ? (spec.rows as number) : n + 1,
      spec.nativePoints,
      spec.identityMetadataRows,
      spec.resultBytes * (n ?? 1),
      n ?? 0,
      spec.seek ? 1 : 0,
    );
  }
  return undefined;
}
