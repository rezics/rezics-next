import type { Pool } from 'pg';
import { currentCommandResources, type CommandTransaction } from '../command/command.ts';
import { currentIdentitySourceConsumerMaintenance, identitySourceConsumerLibraryWork } from '../semantic/identity-source-consumer-maintenance.ts';
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
import inputs from '../semantic/identity-epoch-store-select-input.sql';
import originals from '../semantic/identity-epoch-store-select-original.sql';
import owners from '../semantic/identity-epoch-read-owners.sql';
import sources from '../semantic/identity-epoch-read-sources.sql';
import pending from '../semantic/identity-epoch-read-pending.sql';
import mapping from '../semantic/identity-epoch-read-current.sql';
import facts from './collection-source-native-facts.sql';
import labels from './owner-index-native-label-originals.sql';

const bindings = new WeakMap<NativeCollectionWork, { pool?: Pool; deadline: number }>();
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
  return { reservationId: work.receipt().reservationId, remaining: {
    candidateKeys: work.available('candidateKeys'),
    nativeRows: work.available('nativeRows'),
    identityMetadataRows: work.available('identityMetadataRows'),
    nativePoints: work.available('nativePoints'),
    witnessKeys: work.available('witnessKeys'),
    statements: work.available('statements'),
    bytes: work.available('bytes'),
    emptySeeks: work.available('emptySeeks'),
  } };
}
export async function withLibraryIdentityWork<T>(pool: Pool, work: NativeCollectionWork, body: () => Promise<T>): Promise<T> {
  const binding = bindings.get(work);
  if (!binding || (binding.pool && binding.pool !== pool)) throw new TypeError('Foreign Library work pool');
  binding.pool = pool;
  work.assertReady();
  return body();
}
export async function libraryIdentityWorkFor<T>(tx: CommandTransaction, work: NativeCollectionWork, body: () => Promise<T>): Promise<T> {
  const resources = currentCommandResources(tx), binding = bindings.get(work);
  if (!binding || binding.pool !== resources.pool || resources.deadline !== binding.deadline)
    throw new TypeError('Library command changed its prepaid resources');
  transactions.set(tx, work);
  try { return await body(); } finally { transactions.delete(tx); }
}
/** Resolve an existing live allocation. No allocation, allowance or consumer frame is created here. */
export function currentLibraryIdentityWork(tx: CommandTransaction): NativeCollectionWork | null {
  const resources = currentCommandResources(tx);
  const local = transactions.get(tx);
  if (local) return Date.now() < deadlineOf(local) ? local : null;
  const token = currentIdentitySourceConsumerMaintenance(resources.pool, resources.deadline);
  return token ? identitySourceConsumerLibraryWork(resources.pool, token, resources.deadline) : null;
}
/** All statements of the nested read, including checkout, BEGIN and cleanup, use this same ledger. */
export function bounded<T>(work: NativeCollectionWork, body: () => Promise<T>): Promise<T> {
  const binding = bindings.get(work);
  if (!binding?.pool) throw new TypeError('Unbound Library read pool');
  return instrumentNativeCollectionWork(binding.pool, work, (sql, values) => libraryIdentityFootprint(sql, values, work), body);
}
const normalize = (sql: string) => sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim().replace(/;$/, '').trim();
const equal = (a: string, b: string) => normalize(a) === normalize(b);
const count = (value: unknown, max: number): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= max ? value : undefined;
function cost(sql: string, values: readonly unknown[], rows: number, points: number, metadata: number, output: number, candidates = 0, seeks = 0): WorkDimensions {
  // Bound includes SQL, all original binds and the schema/admitted result projection, even on failure.
  const binds = JSON.stringify(values, (_key, value) => typeof value === 'bigint' ? value.toString() : value);
  return { candidateKeys: candidates, nativeRows: rows, identityMetadataRows: metadata, nativePoints: points,
    witnessKeys: 0, statements: 1, bytes: Buffer.byteLength(sql) + Buffer.byteLength(binds) + output, emptySeeks: seeks };
}
export const libraryIdentityJobSizeSQL = `SELECT octet_length(intent::text) AS bytes FROM semantic.identity_epoch_job WHERE partition_no=$1 AND job_id=$2 AND epoch=$3`;
/** Literal normal-receiving cost declaration for Source's SQL owner to recognize. Undefined stays unknown.
 * No table-name fallback. Bound includes one indexed EOF slot per bounded range and all joined/FK probes.
 * Cleanup slots are reserved by instrumentNativeCollectionWork BEFORE BEGIN; dispatched failure/rollback
 * and repeats stay charged. Zero identity rows on native-only SQL, zero witnesses everywhere, are intentional.
 */
export function libraryIdentityFootprint(sql: string, values: readonly unknown[], work?: NativeCollectionWork): WorkDimensions | undefined {
  const text = normalize(sql);
  const point = (rows: number, points: number, metadata: number, output: number, seeks = 0) => cost(sql, values, rows, points, metadata, output, 0, seeks);
  if (['BEGIN ISOLATION LEVEL SERIALIZABLE','BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY','BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY','COMMIT','ROLLBACK',"SET LOCAL lock_timeout = '200ms'"].includes(text) || /^SET LOCAL statement_timeout = '[1-9][0-9]*ms'$/.test(text)) return point(0,0,0,0);
  if (equal(sql, time.sql)) return point(0,0,0,128);
  if (equal(sql, partition.sql)) return point(1,1,1,256,1);
  if (equal(sql, account.sql)) return point(1,1,0,64,1);
  if (equal(sql, noEffectFence.sql) && values[2] === null) return point(1,1,1,64,1);
  if (equal(sql, fence.sql) && values[3] === null && values[4] === null) {
    const events = typeof values[1] === 'string' ? JSON.parse(values[1]) : values[1];
    if (!Array.isArray(events) || events.length !== 1 || events[0]?.type !== 'com.rezics.semantic.identity-epoch.admitted.v1') return undefined;
    return point(2,2,1,64);
  }
  if (equal(sql, commit.sql) && values[2] === 'library-private-follow-counts') return point(2,2,1,64);
  if (equal(sql, plan.sql) || equal(sql, plan.sql.replace(/;\s*$/, ' FOR UPDATE'))) return point(1,1,0,12288,1);
  if (equal(sql, current.sql)) return point(7,7,1,64,1);
  // Admission input cardinality is contractually <=2. EXISTS and NOT EXISTS each use that prefix.
  if (equal(sql, job.sql)) return point(16,13,16,2048,4);
  if (equal(sql, seal.sql)) return point(5,5,2,256,1);
  if (equal(sql, libraryIdentityJobSizeSQL)) return point(1,1,1,32,1);
  if (equal(sql, savedJob.sql)) {
    const bytes = work?.resultByteBound(`library-job:${values[1]}:${values[2]}`);
    return bytes === undefined ? undefined : point(1,1,1,bytes + 256,1);
  }
  if (equal(sql, inputs.sql)) return point(3,1,3,512,1);
  if (equal(sql, originals.sql)) {
    const n = count(values[2],100); return n === undefined ? undefined : point(n+1,1,n+1,256*n,1);
  }
  for (const [identity, perRow, points, output] of [[owners.sql,1,1,256],[sources.sql,4,4,1024],[pending.sql,1,1,256],[mapping.sql,2,2,256]] as const) {
    if (!equal(sql, identity)) continue;
    const n = Array.isArray(values[0]) ? count(values[0].length,100) : undefined;
    return n === undefined ? undefined : point(n*perRow,n*points,n*perRow,n*output,n);
  }
  if (equal(sql, facts.sql) || equal(sql, labels.sql)) {
    const n = count(values[4],100);
    return n === undefined ? undefined : cost(sql,values,n+1,1,0,n*256,n,1);
  }
  for (const name of Object.keys(libraryIdentitySQL) as (keyof typeof libraryIdentitySQL)[]) {
    if (!equal(sql, libraryIdentitySQL[name])) continue;
    const spec = libraryIdentitySQLCost[name];
    const n = spec.rows === 'range' ? count(values[spec.limitParameter-1],100) : undefined;
    if (spec.rows === 'range' && n === undefined) return undefined;
    return cost(sql,values,n === undefined ? spec.rows as number : n+1,spec.nativePoints,spec.identityMetadataRows,spec.resultBytes*(n ?? 1),n ?? 0,spec.seek ? 1 : 0);
  }
  return undefined;
}
