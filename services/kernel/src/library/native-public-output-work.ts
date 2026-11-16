import { memoizedValue } from '../memoized.ts';
import type { Pool, PoolClient, QueryConfig, QueryResult } from 'pg';
import type { NativeReadQueryConfig } from '../database/bounded-read-lifetime.ts';
import type { WorkDimensions } from './contract/work-dimensions.ts';
import { NativeCollectionWork, instrumentNativeCollectionWork } from './collection-native-work.ts';
import {
  nativePublicOutputStatement,
  nativePublicOutputWorkDimensions,
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

export function publicOutputPartitionSizeSQL() {
  return memoizedValue(publicOutputPartitionSizeSQL, () => PUBLIC_OUTPUT_PARTITION_SIZE_SQL);
}
export function publicOutputXidSQL() {
  return memoizedValue(publicOutputXidSQL, () => PUBLIC_OUTPUT_XID_SQL);
}

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

function requestOf(config: string | QueryConfig, params: unknown[] = []) {
  const sql = typeof config === 'string' ? config : config.text;
  const values = (typeof config === 'string' ? params : config.values) ?? [];
  return { sql, values: Array.isArray(values) ? values : [] };
}

function admitResult(entry: NativePublicOutputStatement, result: QueryResult | undefined) {
  if (!result) return;
  if (result.rows.length > entry.resultRows) throw new TypeError('Native public output result exceeds its plan');
  // PostgreSQL command results still carry command, rowCount, and fields metadata when rows is empty.
  // The descriptor budgets projected row data, so an empty result has zero bytes (not JSON's two-byte `[]`).
  const encoded = result.rows.length
    ? Buffer.byteLength(
        JSON.stringify(result.rows, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value)),
      )
    : 0;
  if (encoded > entry.resultBytes) throw new TypeError('Native public output projection exceeds its plan');
}

/**
 * Keep all native queries on the caller's connection. Pool reads already own a child
 * observer. A Core transaction exposes only a query forwarder, so observe that
 * forwarder within the transferred Library reservation.
 */
export function nativePublicOutputClient(
  tx: Pick<PoolClient, 'query'>,
  work: NativeCollectionWork,
  deadline: number,
  commandPool?: Pool,
): Pick<PoolClient, 'query'> {
  const footprint = (sql: string, values: readonly unknown[]) => nativePublicOutputFootprint(sql, values, work);
  return {
    query: (async (config: string | QueryConfig, params: unknown[] = []) => {
      const { sql, values } = requestOf(config, params);
      const entry = nativePublicOutputStatement(sql, values, work);
      if (!entry) {
        work.reserve(undefined);
        throw new TypeError('Unknown public output statement');
      }
      const query = async () => {
        const request: NativeReadQueryConfig = { text: sql, values, query_timeout: Math.max(1, deadline - Date.now()) };
        const result = await tx.query(request);
        admitResult(entry, result);
        return result;
      };
      return commandPool ? instrumentNativeCollectionWork(commandPool, work, footprint, query, tx) : query();
    }) as PoolClient['query'],
  };
}
