import { SEED_BATCH_BYTE_LIMIT } from './growth-seed-batches.ts';

export const MAX_SEED_VALUE_DEPTH = 64;
export const MAX_SEED_VALUE_NODES_PER_BATCH = 100_000;
export const MAX_SEED_VALUE_BYTE_ARRAY_BYTES_PER_ORDINAL = Math.floor((SEED_BATCH_BYTE_LIMIT - 5) / 2);

export type SeedValueLocation = {
  readonly table: string;
  /** One-based row number for this table in the current batch. */
  readonly row: number;
  readonly column: string;
};

export type SeedValueByteBudget = { byteArrayBytes: number };
export type SeedValueEncoder = (
  value: unknown,
  location: SeedValueLocation,
  byteBudget?: SeedValueByteBudget,
) => unknown;
export type SeedRow = Readonly<Record<string, unknown>>;

function fail(location: SeedValueLocation, path: string, reason: string): never {
  const nested = path === '$' ? '' : ` at ${path}`;
  throw new TypeError(
    `Unsupported seed value at table ${location.table}, row ${location.row}, column ${JSON.stringify(location.column)}${nested}: ${reason}`,
  );
}

function propertyPath(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function isArrayIndex(key: string, length: number): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}

export function createSeedValueEncoder(): SeedValueEncoder {
  let visited = 0;

  const encode = (
    value: unknown,
    location: SeedValueLocation,
    depth: number,
    path: string,
    ancestors: WeakSet<object>,
    byteBudget: SeedValueByteBudget,
  ): unknown => {
    visited++;
    if (visited > MAX_SEED_VALUE_NODES_PER_BATCH)
      return fail(location, path, `batch exceeds ${MAX_SEED_VALUE_NODES_PER_BATCH} visited values`);
    if (depth > MAX_SEED_VALUE_DEPTH) return fail(location, path, `value exceeds depth ${MAX_SEED_VALUE_DEPTH}`);

    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return fail(location, path, 'number must be finite');
      return value;
    }
    if (typeof value === 'bigint') return value.toString(10);
    if (typeof value === 'undefined') return fail(location, path, 'undefined is not supported');
    if (typeof value === 'function') return fail(location, path, 'functions are not supported');
    if (typeof value === 'symbol') return fail(location, path, 'symbols are not supported');

    if (value instanceof Date) {
      const timestamp = Date.prototype.getTime.call(value);
      if (!Number.isFinite(timestamp)) return fail(location, path, 'Date must be valid');
      return Date.prototype.toISOString.call(value);
    }
    if (value instanceof Uint8Array) {
      if (value.byteLength > MAX_SEED_VALUE_BYTE_ARRAY_BYTES_PER_ORDINAL - byteBudget.byteArrayBytes)
        return fail(
          location,
          path,
          `byte arrays exceed ${MAX_SEED_VALUE_BYTE_ARRAY_BYTES_PER_ORDINAL} bytes per ordinal`,
        );
      byteBudget.byteArrayBytes += value.byteLength;
      let hex = '';
      for (let index = 0; index < value.length; index++) hex += value[index]!.toString(16).padStart(2, '0');
      return `\\x${hex}`;
    }

    if (typeof value !== 'object') return fail(location, path, `${typeof value} is not supported`);
    if (ancestors.has(value)) return fail(location, path, 'cyclic reference');

    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const length = value.length;
        for (const key of Reflect.ownKeys(value)) {
          if (typeof key !== 'string') return fail(location, path, 'symbol-keyed array properties are not supported');
          if (key !== 'length' && !isArrayIndex(key, length))
            return fail(location, propertyPath(path, key), 'extra array properties are not supported');
        }

        const result: unknown[] = [];
        for (let index = 0; index < length; index++) {
          const itemPath = `${path}[${index}]`;
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor) return fail(location, itemPath, 'sparse arrays are not supported');
          if (!('value' in descriptor)) return fail(location, itemPath, 'accessor properties are not supported');
          result.push(encode(descriptor.value, location, depth + 1, itemPath, ancestors, byteBudget));
        }
        return result;
      }

      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null)
        return fail(location, path, 'only plain objects are supported');
      const result = Object.create(null) as Record<string, unknown>;
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') return fail(location, path, 'symbol-keyed object properties are not supported');
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable) continue;
        if (!('value' in descriptor))
          return fail(location, propertyPath(path, key), 'accessor properties are not supported');
        result[key] = encode(descriptor.value, location, depth + 1, propertyPath(path, key), ancestors, byteBudget);
      }
      return result;
    } finally {
      ancestors.delete(value);
    }
  };

  return (value, location, byteBudget = { byteArrayBytes: 0 }) =>
    encode(value, location, 0, '$', new WeakSet(), byteBudget);
}

export function encodeSeedRow(
  row: SeedRow,
  table: string,
  rowNumber: number,
  columns: readonly string[],
  encode: SeedValueEncoder,
  byteBudget: SeedValueByteBudget = { byteArrayBytes: 0 },
): SeedRow {
  if (Object.getOwnPropertySymbols(row).length)
    return fail({ table, row: rowNumber, column: '<symbol>' }, '$', 'symbol-keyed columns are not supported');

  const result = Object.create(null) as Record<string, unknown>;
  for (const column of columns) {
    const location = { table, row: rowNumber, column };
    const descriptor = Object.getOwnPropertyDescriptor(row, column);
    if (!descriptor || !descriptor.enumerable) return fail(location, '$', 'column must be an enumerable data property');
    if (!('value' in descriptor)) return fail(location, '$', 'accessor properties are not supported');
    result[column] = encode(descriptor.value, location, byteBudget);
  }
  return result;
}
