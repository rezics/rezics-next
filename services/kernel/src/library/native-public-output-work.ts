import type { PoolClient, QueryConfig, QueryResult } from 'pg';
import type { WorkDimensions } from './collection-source.ts';
import { NativeCollectionWork } from './collection-source-work.ts';
import header from './collection-source-native-header.sql';
import head from './collection-source-output-head.sql';
import page from './collection-source-output-page.sql';
import partition from '../partition/read.sql';
import owner from './native-public-output-owner.sql';
import lifecycle from './native-public-output-lifecycle.sql';
import publication from './native-public-output-publication-lock.sql';
import binding from './native-public-output-binding.sql';
import bindingLock from './native-public-output-binding-lock.sql';
import identity from './native-public-output-identity.sql';
import provenance from './native-public-output-provenance.sql';
import xmin from './native-public-output-binding-xmin.sql';
import bind from './native-public-output-bind.sql';
import receiving from './native-public-output-receiving.sql';
import hold from './native-public-output-hold.sql';
import transitionRead from './native-public-output-transition-read.sql';
import transition from './native-public-output-transition.sql';
import consume from './native-public-output-consume.sql';
import fence from './native-public-output-fence.sql';
import retained from './native-public-output-retained.sql';

export const publicOutputPartitionSizeSQL =
  'SELECT octet_length(node)::bigint + COALESCE(octet_length(moved_to),0)::bigint AS bytes FROM core.partition WHERE partition_no=$1';
const referenceSQL =
  'SELECT collection_id FROM library.builtin_collection_reference WHERE route=$1 AND collection_id=$2';
export const publicOutputXidSQL = 'SELECT pg_current_xact_id()::text AS xid';
const normal = (sql: string) =>
  sql
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
type Cost = (values: readonly unknown[], work: NativeCollectionWork) => Partial<WorkDimensions> | undefined;
const costs = new Map<string, Cost>();
const add = (sql: string, rows: number, points: number, bytes: number, statements = 1) =>
  costs.set(normal(sql), () => ({ nativeRows: rows, nativePoints: points, bytes, statements }));

// Exact primary-key plan-node bounds, including joins, not visible/returned tuple counts.
add(header.sql, 4, 1, 2048);
add(head.sql, 48, 7, 1024);
add(publication.sql, 48, 7, 1024);
add(owner.sql, 16, 3, 512);
add(lifecycle.sql, 4, 1, 64);
add(publicOutputPartitionSizeSQL, 4, 1, 128);
add(referenceSQL, 4, 1, 64);
add(publicOutputXidSQL, 1, 0, 64);
for (const q of [binding, bindingLock]) add(q.sql, 16, 3, 6144);
add(identity.sql, 4, 1, 64);
add(xmin.sql, 4, 1, 64);
add(provenance.sql, 16, 3, 64);
add(retained.sql, 24, 5, 64);
// Insert cost includes indexes/FKs and the deferred same-component/publication query (13 keyed relations).
add(bind.sql, 160, 32, 32768, 3);
add(receiving.sql, 12, 3, 128);
// Immediate binding guard, predecessor/successor FKs and deferred successor/transition checks.
costs.set(normal(hold.sql), (v) => ({
  nativeRows: 96,
  nativePoints: 20,
  bytes: 4096,
  statements: v[4] === 'successor' ? 4 : 2,
}));
add(transitionRead.sql, 4, 1, 9216);
add(transition.sql, 144, 29, 16384, 3);
// Each UPDATE queues its own complete deferred check; never amortize these into the INSERT.
add(consume.sql, 96, 22, 4096, 2);
add(fence.sql, 96, 22, 4096, 2);
costs.set(normal(partition.sql), (v, work) => {
  const bytes = work.resultByteBound('partition:' + v[0]);
  return bytes === undefined ? undefined : { nativeRows: 4, nativePoints: 1, bytes };
});
costs.set(normal(page.sql), (v) => ({
  nativeRows: 4 * Number(v[4]) + 4,
  nativePoints: 1,
  candidateKeys: Number(v[4]),
  bytes: 256 * Number(v[4]),
}));

/** Guard-side SQL declarations for a writer composing this additive retention hook.
 * A rekey/update invokes OLD and NEW; a member change also invokes the header counter guard.
 * These are separate literal operations, not a claim about any writer's complete allowance.
 */
export const nativePublicOutputRetentionSQL = Object.freeze({
  owner: 'SELECT 1 FROM library.collection WHERE route=$1 AND collection_id=$2 FOR UPDATE',
  partition: 'SELECT 1 FROM core.partition WHERE partition_no=$1 FOR SHARE',
  collection:
    'SELECT EXISTS(SELECT 1 FROM library.native_public_output_hold WHERE route=$1 AND collection_id=$2 AND consumed_by IS NULL LIMIT 1)',
  output:
    'SELECT EXISTS(SELECT 1 FROM library.native_public_output_hold WHERE route=$1 AND collection_id=$2 AND output_generation=$3 AND consumed_by IS NULL LIMIT 1)',
});
for (const sql of Object.values(nativePublicOutputRetentionSQL)) add(sql, 4, 1, 64);

export function nativePublicOutputFootprint(
  sql: string,
  values: readonly unknown[],
  work: NativeCollectionWork,
): WorkDimensions | undefined {
  const control = /^(?:BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|COMMIT|ROLLBACK)$/.test(sql);
  const cost: Partial<WorkDimensions> | undefined = control ? { bytes: 0 } : costs.get(normal(sql))?.(values, work);
  if (!cost) return undefined;
  return {
    candidateKeys: 0,
    identityMetadataRows: 0,
    nativeRows: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 1,
    emptySeeks: control ? 0 : (cost.statements ?? 1),
    ...cost,
    bytes: Buffer.byteLength(sql) + Buffer.byteLength(JSON.stringify(values)) + (cost.bytes ?? 0),
  };
}

/** No checkout or new executor: all locks remain on the original caller transaction. */
export function nativePublicOutputClient(
  tx: Pick<PoolClient, 'query'>,
  work: NativeCollectionWork,
  deadline: number,
): Pick<PoolClient, 'query'> {
  return {
    query: (async (config: string | QueryConfig, params: unknown[] = []) => {
      const sql = typeof config === 'string' ? config : config.text;
      const values = (typeof config === 'string' ? params : config.values) ?? [];
      const bound = nativePublicOutputFootprint(sql, values, work);
      const reservation = work.reserve(bound);
      reservation.dispatch();
      let result: QueryResult | undefined;
      try {
        const request = { text: sql, values, query_timeout: Math.max(1, deadline - Date.now()) };
        result = await reservation.query(() => tx.query(request));
        return result;
      } finally {
        reservation.settle({
          emptySeeks:
            !result || bound!.emptySeeks > 1 ? bound!.emptySeeks : result.rows.length === 0 ? bound!.emptySeeks : 0,
          candidateKeys: result ? Math.min(bound!.candidateKeys, result.rows.length) : bound!.candidateKeys,
        });
      }
    }) as PoolClient['query'],
  };
}
