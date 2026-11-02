import pg from 'pg';
import type { Pool } from 'pg';
import { createSeedValueEncoder, encodeSeedRow, SEED_BATCH_BYTE_LIMIT } from './growth-seed-values.ts';

export type SeedRow = Readonly<Record<string, unknown>>;
type TableRows = {
  readonly schema: string;
  readonly table: string;
  readonly columns: string[];
  readonly rows: SeedRow[];
};

export const SEED_BATCH_ROW_LIMIT = 500;
export { SEED_BATCH_BYTE_LIMIT };

const ORDINAL_BATCH_SIZE = 1_000;
const TABLE_NAME = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;

function stringBytes(value: string, limit: number): number | undefined {
  let bytes = 2;
  if (bytes > limit) return undefined;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    let extra: number;
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    )
      extra = 2;
    else if (code < 0x20) extra = 6;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        extra = 4;
        index++;
      } else extra = 6;
    } else if (code >= 0xd800 && code <= 0xdfff) extra = 6;
    else if (code <= 0x7f) extra = 1;
    else if (code <= 0x7ff) extra = 2;
    else extra = 3;
    if (extra > limit - bytes) return undefined;
    bytes += extra;
  }
  return bytes;
}

function omittedJsonValue(value: unknown): boolean {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol';
}

function addBytes(left: number, right: number, limit: number): number | undefined {
  return right > limit - left ? undefined : left + right;
}

function jsonBytes(value: unknown, limit: number, inArray: boolean, seen: WeakSet<object>): number | undefined {
  if (omittedJsonValue(value)) return inArray ? (limit >= 4 ? 4 : undefined) : 0;
  if (value === null) return limit >= 4 ? 4 : undefined;
  if (typeof value === 'string') return stringBytes(value, limit);
  if (typeof value === 'boolean') {
    const bytes = value ? 4 : 5;
    return bytes <= limit ? bytes : undefined;
  }
  if (typeof value === 'number') {
    const encoded = Number.isFinite(value) ? JSON.stringify(value)! : 'null';
    return encoded.length <= limit ? encoded.length : undefined;
  }
  if (typeof value === 'bigint') return stringBytes(value.toString(10), limit);
  if (value instanceof Date) return stringBytes(value.toISOString(), limit);
  if (value instanceof Uint8Array) {
    const bytes = 5 + value.byteLength * 2;
    return bytes <= limit ? bytes : undefined;
  }
  if (typeof value !== 'object') return inArray ? (limit >= 4 ? 4 : undefined) : 0;
  if (seen.has(value)) throw new TypeError('Cannot encode a circular growth seed row');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      let bytes = 2;
      if (bytes > limit) return undefined;
      for (let index = 0; index < value.length; index++) {
        if (index > 0) {
          const withComma = addBytes(bytes, 1, limit);
          if (withComma === undefined) return undefined;
          bytes = withComma;
        }
        const itemBytes = jsonBytes(value[index], limit - bytes, true, seen);
        if (itemBytes === undefined) return undefined;
        const withItem = addBytes(bytes, itemBytes, limit);
        if (withItem === undefined) return undefined;
        bytes = withItem;
      }
      return bytes;
    }
    let bytes = 2;
    let hasProperty = false;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      const item = (value as Record<string, unknown>)[key];
      if (key === 'toJSON' && typeof item === 'function') return undefined;
      if (omittedJsonValue(item)) continue;
      const keyBytes = stringBytes(key, limit - bytes);
      if (keyBytes === undefined) return undefined;
      let withKey = addBytes(bytes, keyBytes, limit);
      if (withKey === undefined) return undefined;
      withKey = addBytes(withKey, 1, limit);
      if (withKey === undefined) return undefined;
      const itemBytes = jsonBytes(item, limit - withKey, false, seen);
      if (itemBytes === undefined) return undefined;
      withKey = addBytes(withKey, itemBytes, limit);
      if (withKey === undefined) return undefined;
      if (hasProperty) {
        withKey = addBytes(bytes, 1, limit);
        if (withKey === undefined) return undefined;
        withKey = addBytes(withKey, keyBytes + 1 + itemBytes, limit);
        if (withKey === undefined) return undefined;
      }
      bytes = withKey;
      hasProperty = true;
    }
    return bytes;
  } finally {
    seen.delete(value);
  }
}

function rowBytes(row: SeedRow, table: string, ordinal: number): number {
  const bytes = jsonBytes(row, SEED_BATCH_BYTE_LIMIT - 2, false, new WeakSet());
  if (bytes === undefined)
    throw new RangeError(
      `Row for ${table} at ordinal ${ordinal} exceeds the ${SEED_BATCH_BYTE_LIMIT}-byte growth seed batch limit`,
    );
  return bytes;
}

function* collectBatches<TPlacement>(
  from: number,
  to: number,
  place: (ordinal: number) => TPlacement,
  rowsFor: (placement: TPlacement) => Readonly<Record<string, readonly SeedRow[]>>,
): Generator<TableRows[]> {
  const columnsByTable = new Map<string, string[]>();
  const rowNumbers = new Map<string, number>();
  const encoder = createSeedValueEncoder();
  let tables = new Map<string, TableRows>();
  let rowCount = 0;
  let byteCount = 0;

  for (let ordinal = from; ordinal < to; ordinal++) {
    const records = rowsFor(place(ordinal));
    const byteBudget = { byteArrayBytes: 0 };
    for (const name in records) {
      if (!Object.hasOwn(records, name)) continue;
      if (!TABLE_NAME.test(name)) throw new Error(`Invalid table name: ${name}`);
      const rows = records[name]!;
      const [schema, table] = name.split('.') as [string, string];
      for (const row of rows) {
        const columns = Object.keys(row);
        if (!columns.length) throw new Error(`Rows for ${name} must include at least one column`);
        const expectedColumns = columnsByTable.get(name);
        if (!expectedColumns) columnsByTable.set(name, columns);
        else if (columns.length !== expectedColumns.length || expectedColumns.some((key) => !Object.hasOwn(row, key)))
          throw new Error(`Rows for ${name} must have identical columns`);

        const rowNumber = (rowNumbers.get(name) ?? 0) + 1;
        rowNumbers.set(name, rowNumber);
        const snapshot = encodeSeedRow(row, name, rowNumber, expectedColumns ?? columns, encoder, byteBudget);
        const encodedBytes = rowBytes(snapshot, name, ordinal);

        let target = tables.get(name);
        let addedBytes = encodedBytes + (target ? 1 : 2);
        if (rowCount >= SEED_BATCH_ROW_LIMIT || addedBytes > SEED_BATCH_BYTE_LIMIT - byteCount) {
          const completed = [...tables.values()];
          tables = new Map();
          rowCount = 0;
          byteCount = 0;
          yield completed;
          target = undefined;
          addedBytes = encodedBytes + 2;
        }
        if (!target) {
          target = { schema, table, columns: expectedColumns ?? columns, rows: [] };
          tables.set(name, target);
        }
        target.rows.push(snapshot);
        rowCount++;
        byteCount += addedBytes;
      }
    }
  }
  if (rowCount > 0) yield [...tables.values()];
}

async function insertBatch(admin: Pool, tables: TableRows[]): Promise<void> {
  const client = await admin.connect();
  let failed = false;
  let failure: unknown;
  let discard: Error | undefined;
  try {
    await client.query('BEGIN');
    for (const target of tables) {
      const qualified = `${pg.escapeIdentifier(target.schema)}.${pg.escapeIdentifier(target.table)}`;
      const columns = target.columns.map((column) => pg.escapeIdentifier(column)).join(', ');
      const values = JSON.stringify(target.rows);
      await client.query(
        `INSERT INTO ${qualified} (${columns}) SELECT ${columns} FROM jsonb_populate_recordset(NULL::${qualified}, $1::jsonb)`,
        [values],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    failed = true;
    failure = error;
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      discard = rollbackError instanceof Error ? rollbackError : new Error('Failed to roll back growth seed batch');
    }
  }
  try {
    client.release(discard);
  } catch (releaseError) {
    if (!failed) throw releaseError;
  }
  if (failed) throw failure;
}

export async function seedBulkRows<TPlacement>(
  admin: Pool,
  from: number,
  to: number,
  place: (ordinal: number) => TPlacement,
  rowsFor: (placement: TPlacement) => Readonly<Record<string, readonly SeedRow[]>>,
): Promise<void> {
  for (let batchFrom = from; batchFrom < to; batchFrom += ORDINAL_BATCH_SIZE) {
    const batchTo = Math.min(batchFrom + ORDINAL_BATCH_SIZE, to);
    for (const batch of collectBatches(batchFrom, batchTo, place, rowsFor)) await insertBatch(admin, batch);
  }
}
