import type { QueryResultRow } from 'pg';
import type { AccessClient } from '../request/access.ts';
import type { AccessWorkAccounting, AccessWork } from '../access/work.ts';
import type { ReadContext } from './model.ts';
import type { Partition } from '../partition/partition.ts';
import partitionRead from '../partition/read.sql';

/** Optional only inside the existing readers; the population seam requires a root. */
export type RealmSubjectReadContext = ReadContext & { readonly work?: AccessWorkAccounting };
const roots = new WeakMap<AccessClient, AccessWorkAccounting>();

export function bindRealmSubjectReadWork(client: AccessClient, work?: AccessWorkAccounting): void {
  if (work) roots.set(client, work);
}

export function realmSubjectReadRoot(client: AccessClient): AccessWorkAccounting | undefined {
  return roots.get(client);
}

function size(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, (_key, value) => (typeof value === 'bigint' ? String(value) : value)));
}

/** Each declaration describes an explicit finite point plan, never SQL-text inference.
 * Rows include intermediate unique joins, even for an empty result. Dispatched
 * native rows cannot be refunded. Bytes and empty seeks use this invocation's result.
 */
export async function realmSubjectPoint<R extends QueryResultRow>(
  client: AccessClient,
  operation: string,
  parameters: readonly unknown[],
  dispatch: () => Promise<{ rows: R[] }>,
  plan: Readonly<{ keys: number; rows: number; bytes: number }>,
): Promise<{ rows: R[] }> {
  const work = roots.get(client);
  if (!work) return dispatch();
  const bound: AccessWork = {
    keys: plan.keys,
    points: plan.keys + 1,
    witnesses: 0,
    rows: plan.rows,
    bytes: size(parameters) + plan.bytes,
    emptySeeks: plan.keys,
  };
  return work.run(operation, bound, dispatch, (result) => ({
    ...bound,
    bytes: size(parameters) + size(result.rows),
    emptySeeks: result.rows.length === 0 ? plan.keys : 0,
  }));
}

/** read-chain metadata only. A revision has <=128 subject/media identities;
 * review citations and licences are bounded by the native revision contract.
 * The 64 KiB envelope includes JSON escaping, digest, citation and those arrays.
 * A payload exceeding the declaration makes evidence unknown, never undercharged.
 */
export function realmSubjectContentPoint<R extends QueryResultRow>(
  client: AccessClient,
  kind: string,
  parameters: readonly unknown[],
  dispatch: () => Promise<{ rows: R[] }>,
): Promise<{ rows: R[] }> {
  return realmSubjectPoint(client, `content.realmSubject.${kind}`, parameters, dispatch, {
    keys: kind === 'post' ? 3 : 1,
    rows: kind === 'post' ? 9 : 4,
    bytes: 65536,
  });
}

/** One checkout, BEGIN and a precharged cleanup slot. The slot remains charged
 * on failure/deadline, so rollback can release the original connection even when
 * no further work admission is possible. COMMIT is separately debited below.
 */
export async function realmSubjectBegin(client: AccessClient, dispatched: () => void): Promise<void> {
  const work = roots.get(client);
  const dispatch = async () => {
    dispatched();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  };
  if (!work) return dispatch();
  await work.run('content.realmSubject.snapshot.begin', {
    keys: 0, points: 3, witnesses: 0, rows: 0, bytes: 128, emptySeeks: 0,
  }, dispatch);
}

export async function realmSubjectCommit(client: AccessClient): Promise<void> {
  const work = roots.get(client);
  const dispatch = async () => { await client.query('COMMIT'); };
  if (!work) return dispatch();
  await work.run('content.realmSubject.snapshot.commit', {
    keys: 0, points: 1, witnesses: 0, rows: 0, bytes: 16, emptySeeks: 0,
  }, dispatch);
}

/** Avoid generated run() catalogue preparation inside an admitted point plan. */
export async function realmSubjectPartition(client: AccessClient, partitionNo: number): Promise<Partition | null> {
  const result = await realmSubjectPoint<{
    partitionNo: number; node: string; writeState: Partition['writeState'];
    movedTo: string | null; epoch: number; position: string;
  }>(client, 'content.realmSubject.partition', [partitionNo], () =>
    client.query(partitionRead.sql, [partitionNo]), { keys: 1, rows: 1, bytes: 65536 });
  const row = result.rows[0];
  return row ? { ...row, position: BigInt(row.position) } : null;
}
