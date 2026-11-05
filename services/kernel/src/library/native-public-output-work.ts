import type { PoolClient, QueryConfig, QueryResult } from 'pg';
import type { WorkDimensions } from './collection-source.ts';
import { NativeCollectionWork } from './collection-source-work.ts';
import {
  nativePublicOutputStatement,
  nativePublicOutputWorkDimensions,
  nativePublicOutputRetentionSQL,
  PUBLIC_OUTPUT_PARTITION_SIZE_SQL,
  PUBLIC_OUTPUT_XID_SQL,
  type NativePublicOutputStatement,
} from './native-public-output-bounds.ts';

export {
  nativePublicOutputRetentionSQL,
  nativePublicOutputPlan,
  nativePublicOutputStatement,
  nativePublicOutputWorkDimensions,
  nativePublicOutputPageStatement,
  nativePublicOutputHoldStatement,
  nativePublicOutputPartitionStatement,
  NATIVE_PUBLIC_OUTPUT_DESCRIPTOR,
  NATIVE_PUBLIC_OUTPUT_JOURNEYS,
  NATIVE_PUBLIC_OUTPUT_COMMAND_CEILING,
  NATIVE_PUBLIC_OUTPUT_CHECKOUT,
  NATIVE_PUBLIC_OUTPUT_PAGE_LIMIT,
  PUBLIC_OUTPUT_PARTITION_SIZE_SQL,
  PUBLIC_OUTPUT_XID_SQL,
  PUBLIC_OUTPUT_REFERENCE_SQL,
  PUBLIC_OUTPUT_PARTITION_METADATA_SQL,
} from './native-public-output-bounds.ts';

export const publicOutputPartitionSizeSQL = PUBLIC_OUTPUT_PARTITION_SIZE_SQL;
export const publicOutputXidSQL = PUBLIC_OUTPUT_XID_SQL;

/** Compatibility observation for callers not yet migrated to named journeys.
 * The closed descriptor is the authority; this never invents a bound from observed rows.
 */
export function nativePublicOutputFootprint(
  sql: string,
  values: readonly unknown[],
  work?: NativeCollectionWork,
): WorkDimensions | undefined {
  const entry = nativePublicOutputStatement(sql, values, work);
  return entry ? nativePublicOutputWorkDimensions(entry.bound) : undefined;
}

type ControlSlot = {
  reservation: ReturnType<NativeCollectionWork['reserve']>;
  entry: NativePublicOutputStatement;
};

function requestOf(config: string | QueryConfig, params: unknown[] = []) {
  const sql = typeof config === 'string' ? config : config.text;
  const values = (typeof config === 'string' ? params : config.values) ?? [];
  return { sql, values: Array.isArray(values) ? values : [] };
}

function admitResult(entry: NativePublicOutputStatement, result: QueryResult | undefined) {
  if (!result) return;
  if (result.rows.length > entry.resultRows) throw new TypeError('Native public output result exceeds its plan');
  const encoded = Buffer.byteLength(
    JSON.stringify(result.rows, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value)),
  );
  if (encoded > entry.resultBytes) throw new TypeError('Native public output projection exceeds its plan');
}

/** No checkout or new executor: all locks remain on the original caller transaction.
 * Dispatch charges the closed plan-node bound. Returned row count cannot replace it.
 */
export function nativePublicOutputClient(
  tx: Pick<PoolClient, 'query'>,
  work: NativeCollectionWork,
  deadline: number,
): Pick<PoolClient, 'query'> {
  let terminal:
    | {
        commit?: ControlSlot;
        rollback?: ControlSlot;
      }
    | undefined;
  const cancelTerminal = () => {
    terminal?.commit?.reservation.cancel();
    terminal?.rollback?.reservation.cancel();
    terminal = undefined;
  };
  return {
    query: (async (config: string | QueryConfig, params: unknown[] = []) => {
      const { sql, values } = requestOf(config, params);
      const beginning = sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
      const finishing = sql === 'COMMIT' ? 'commit' : sql === 'ROLLBACK' ? 'rollback' : undefined;
      const entry = nativePublicOutputStatement(sql, values, work);
      let reservation: ReturnType<NativeCollectionWork['reserve']>;
      let planned: NativePublicOutputStatement;
      let beganReservation = false;
      try {
        if (finishing && terminal) {
          const slot = terminal[finishing];
          if (!slot) throw new TypeError('Native public output transaction control already dispatched');
          ({ reservation, entry: planned } = slot);
          delete terminal[finishing];
        } else {
          if (!entry) work.reserve(undefined);
          if (!entry) throw new TypeError('Unknown public output statement');
          planned = entry;
          if (beginning) {
            const commitEntry = nativePublicOutputStatement('COMMIT', [], work);
            const rollbackEntry = nativePublicOutputStatement('ROLLBACK', [], work);
            if (!commitEntry || !rollbackEntry) work.reserve(undefined);
            if (!commitEntry || !rollbackEntry) throw new TypeError('Public output transaction controls are missing');
            const commit = work.reserve(nativePublicOutputWorkDimensions(commitEntry.bound), true);
            try {
              const rollback = work.reserve(nativePublicOutputWorkDimensions(rollbackEntry.bound), true);
              terminal = {
                commit: { reservation: commit, entry: commitEntry },
                rollback: { reservation: rollback, entry: rollbackEntry },
              };
              beganReservation = true;
            } catch (error) {
              commit.cancel();
              throw error;
            }
          }
          reservation = work.reserve(nativePublicOutputWorkDimensions(planned.bound), finishing !== undefined);
        }
        reservation.dispatch();
      } catch (error) {
        if (beganReservation) cancelTerminal();
        if (error instanceof Error) work.failure = error;
        throw error;
      }
      let result: QueryResult | undefined;
      try {
        const request = { text: sql, values, query_timeout: Math.max(1, deadline - Date.now()) };
        result = await reservation.query(() => tx.query(request));
        admitResult(planned, result);
        return result;
      } finally {
        reservation.settle();
        if (beginning && result === undefined) cancelTerminal();
        else if (sql === 'COMMIT' && result !== undefined) {
          terminal?.rollback?.reservation.cancel();
          terminal = undefined;
        } else if (sql === 'ROLLBACK') {
          terminal?.commit?.reservation.cancel();
          terminal = undefined;
        }
      }
    }) as PoolClient['query'],
  };
}
