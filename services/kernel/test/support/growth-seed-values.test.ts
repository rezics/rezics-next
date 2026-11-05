import { expect, test } from 'bun:test';
import { seed, type Population } from './growth-seed.ts';
import {
  createSeedValueEncoder,
  encodeSeedRow,
  MAX_SEED_VALUE_BYTE_ARRAY_BYTES_PER_ORDINAL,
  MAX_SEED_VALUE_DEPTH,
  MAX_SEED_VALUE_NODES_PER_BATCH,
} from './growth-seed-values.ts';

const table = 'public.seed_values';

test('preserves JSON values and existing special-value encodings, including repeated references', () => {
  const shared = { label: 'shared' };
  const input = {
    json: [null, true, 17, 'text', { child: shared }],
    shared: [shared, shared],
    integer: 9_007_199_254_740_993n,
    createdAt: new Date('2025-01-02T03:04:05.000Z'),
    bytes: new Uint8Array([0, 15, 255]),
  };
  const row = encodeSeedRow(input, table, 3, Object.keys(input), createSeedValueEncoder());

  expect(JSON.parse(JSON.stringify(row))).toEqual({
    json: [null, true, 17, 'text', { child: shared }],
    shared: [shared, shared],
    integer: '9007199254740993',
    createdAt: '2025-01-02T03:04:05.000Z',
    bytes: '\\x000fff',
  });
});

test('rejects unsupported values with their table, row and column location', () => {
  const unsupported: unknown[] = [
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    () => 1,
    Symbol('seed'),
    new Map(),
    new Date(Number.NaN),
    [,],
  ];
  for (const value of unsupported) {
    const input = { value };
    expect(() => encodeSeedRow(input, table, 7, ['value'], createSeedValueEncoder())).toThrow(
      /table public\.seed_values, row 7, column "value"/,
    );
  }
});

test('rejects cycles before opening the affected seed batch', async () => {
  const cycle: Record<string, unknown> = {};
  cycle.child = cycle;
  let connections = 0;
  const population: Population = {
    name: 'invalid',
    hotPartition: 0,
    rows: () => ({ [table]: [{ payload: cycle }] }),
  };
  const admin = {
    connect: () => {
      connections++;
      throw new Error('unexpected connection');
    },
  } as never;

  await expect(seed({ pool: {} as never, admin }, population, { from: 0, to: 1 })).rejects.toThrow(
    /table public\.seed_values, row 1, column "payload".*cyclic reference/,
  );
  let tooDeep: unknown = null;
  for (let depth = 0; depth <= MAX_SEED_VALUE_DEPTH; depth++) tooDeep = [tooDeep];
  const deepPopulation: Population = {
    ...population,
    rows: () => ({ [table]: [{ payload: tooDeep }] }),
  };
  await expect(seed({ pool: {} as never, admin }, deepPopulation, { from: 0, to: 1 })).rejects.toThrow(
    /table public\.seed_values, row 1, column "payload".*depth 64/,
  );
  const bytesPerRow = Math.ceil(MAX_SEED_VALUE_BYTE_ARRAY_BYTES_PER_ORDINAL / 2);
  const oversizedByteRows = Array.from({ length: 2 }, () => ({ payload: new Uint8Array(bytesPerRow) }));
  const byteLimitedPopulation: Population = {
    ...population,
    rows: () => ({ [table]: oversizedByteRows }),
  };
  await expect(seed({ pool: {} as never, admin }, byteLimitedPopulation, { from: 0, to: 1 })).rejects.toThrow(
    /table public\.seed_values, row 2, column "payload".*byte arrays exceed 524,285 bytes per ordinal/,
  );
  expect(connections).toBe(0);
});

test('bounds nesting depth and total traversal work per batch', () => {
  let withinDepth: unknown = 'value';
  for (let depth = 0; depth < MAX_SEED_VALUE_DEPTH; depth++) withinDepth = [withinDepth];
  const accepted = { value: withinDepth };
  expect(() => encodeSeedRow(accepted, table, 1, ['value'], createSeedValueEncoder())).not.toThrow();

  const tooDeep = { value: [withinDepth] };
  expect(() => encodeSeedRow(tooDeep, table, 1, ['value'], createSeedValueEncoder())).toThrow(/depth 64/);

  const tooMuchWork = Array.from({ length: MAX_SEED_VALUE_NODES_PER_BATCH }, () => 0);
  expect(() => createSeedValueEncoder()(tooMuchWork, { table, row: 1, column: 'value' })).toThrow(
    /100,000 visited values/,
  );
});
