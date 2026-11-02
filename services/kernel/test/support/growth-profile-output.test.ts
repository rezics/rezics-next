import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GROWTH_PROFILE_OUTPUT_LIMITS,
  GrowthProfileExportError,
  appendGrowthProfile,
  growthProfileExportMode,
} from './growth-profile-output.ts';

let directory = '';

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'growth-profile-output-'));
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('GROWTH_PROFILE_REQUIRED is best-effort unless set to 1', () => {
  expect(growthProfileExportMode(undefined)).toBe('best-effort');
  expect(growthProfileExportMode('1')).toBe('required');
  expect(() => growthProfileExportMode('true')).toThrow("GROWTH_PROFILE_REQUIRED must be '1' when set");
});

test('required export cannot succeed when the artifact cannot be written', () => {
  const destination = join(directory, 'missing', 'required.jsonl');
  try {
    appendGrowthProfile({ destination, record: { check: 'required' }, mode: 'required' });
    throw new Error('expected required export to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(GrowthProfileExportError);
    if (!(error instanceof GrowthProfileExportError)) throw error;
    expect(error.destination).toBe(destination);
    expect(error.message).toContain(`GROWTH_PROFILE ${destination} was not written:`);
    expect(error.cause).toBeInstanceOf(Error);
  }
  expect(existsSync(destination)).toBe(false);
});

test('best-effort export warns once per destination and does not throw', () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  const first = join(directory, 'missing-a', 'profile.jsonl');
  const second = join(directory, 'missing-b', 'profile.jsonl');
  try {
    expect(appendGrowthProfile({ destination: first, record: { check: 'a' } })).toBeUndefined();
    expect(appendGrowthProfile({ destination: first, record: { check: 'a-again' } })).toBeUndefined();
    expect(appendGrowthProfile({ destination: second, record: { check: 'b' } })).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]![0]).toContain(`GROWTH_PROFILE ${first} was not written:`);
    expect(warn.mock.calls[1]![0]).toContain(`GROWTH_PROFILE ${second} was not written:`);
  } finally {
    warn.mockRestore();
  }
});

test('required export appends a complete JSONL record', async () => {
  const destination = join(directory, 'delivered.jsonl');
  const first = appendGrowthProfile({ destination, record: { check: 'one', scales: [1, 8, 64] }, mode: 'required' });
  const second = appendGrowthProfile({ destination, record: { check: 'two' }, mode: 'required' });
  expect(first?.destination).toBe(destination);
  expect(second?.bytes).toBeGreaterThan(0);
  const lines = (await readFile(destination, 'utf8')).split('\n');
  expect(lines.at(-1)).toBe('');
  expect(lines.slice(0, -1).map((line) => JSON.parse(line))).toEqual([
    { check: 'one', scales: [1, 8, 64] },
    { check: 'two' },
  ]);
});

test('an oversized record is refused before any bytes are written', () => {
  const destination = join(directory, 'too-large.jsonl');
  const record = { payload: 'x'.repeat(GROWTH_PROFILE_OUTPUT_LIMITS.lineBytes) };
  expect(() => appendGrowthProfile({ destination, record, mode: 'required' })).toThrow(
    `exceeds the ${GROWTH_PROFILE_OUTPUT_LIMITS.lineBytes} byte profile line limit`,
  );
  expect(existsSync(destination)).toBe(false);
});

test('supported native values round-trip with JSON.stringify bytes', async () => {
  const destination = join(directory, 'round-trip.jsonl');
  const inner = { shared: 1 };
  const records: unknown[] = [
    { omit: undefined, keep: null, skipFn: () => {}, skipSym: Symbol('s'), later: 2 },
    [undefined, null, 1, 'x'],
    { text: '"\\\n\t\u0001', cafe: 'café', grin: '😀', lone: '\uD800', pair: '\uD800\uDC00' },
    { n: [0, -0, 1.5, 1e21, Number.NaN, Infinity, -Infinity] },
    { toJSON: () => ({ ok: true, key: '' }) },
    new Date('2020-01-01T00:00:00.000Z'),
    { n: Object(5), s: Object('a'), b: Object(false) },
    { a: inner, b: inner },
    (() => {
      const extra = [1] as number[] & { foo: number };
      extra.foo = 2;
      return extra;
    })(),
    Array(2),
  ];
  for (const record of records) appendGrowthProfile({ destination, record, mode: 'required' });
  expect(await readFile(destination)).toEqual(
    Buffer.from(`${records.map((record) => JSON.stringify(record)).join('\n')}\n`),
  );
});

test('a near-boundary record writes and a one-byte overflow does not', async () => {
  const destination = join(directory, 'boundary.jsonl');
  const wrapper = Buffer.byteLength('{"payload":""}\n', 'utf8');
  const payload = 'x'.repeat(GROWTH_PROFILE_OUTPUT_LIMITS.lineBytes - wrapper);
  const first = appendGrowthProfile({ destination, record: { payload }, mode: 'required' });
  expect(first?.bytes).toBe(GROWTH_PROFILE_OUTPUT_LIMITS.lineBytes);
  expect(JSON.parse((await readFile(destination, 'utf8')).slice(0, -1))).toEqual({ payload });
  expect(() => appendGrowthProfile({ destination, record: { payload: `${payload}x` }, mode: 'required' })).toThrow(
    `exceeds the ${GROWTH_PROFILE_OUTPUT_LIMITS.lineBytes} byte profile line limit`,
  );
  expect((await readFile(destination)).byteLength).toBe(GROWTH_PROFILE_OUTPUT_LIMITS.lineBytes);
});

test('serialization admission stops before later getters and never writes a partial line', () => {
  const destination = join(directory, 'admitted.jsonl');
  let later = 0;
  const oversized: Record<string, unknown> = { huge: 'x'.repeat(GROWTH_PROFILE_OUTPUT_LIMITS.lineBytes) };
  Object.defineProperty(oversized, 'later', {
    enumerable: true,
    get() {
      later++;
      return 1;
    },
  });
  expect(() => appendGrowthProfile({ destination, record: oversized, mode: 'required' })).toThrow(
    `exceeds the ${GROWTH_PROFILE_OUTPUT_LIMITS.lineBytes} byte profile line limit`,
  );
  expect(later).toBe(0);

  let nest: unknown = 1;
  for (let depth = 0; depth < GROWTH_PROFILE_OUTPUT_LIMITS.depth; depth++) nest = { nest };
  appendGrowthProfile({ destination: join(directory, 'depth-ok.jsonl'), record: nest, mode: 'required' });
  expect(() => appendGrowthProfile({ destination, record: { nest }, mode: 'required' })).toThrow(
    `exceeds the ${GROWTH_PROFILE_OUTPUT_LIMITS.depth} profile serialization depth limit`,
  );

  const wide = new Proxy([] as object[], {
    get(_target, property) {
      if (property === 'length') return GROWTH_PROFILE_OUTPUT_LIMITS.values;
      if (typeof property === 'string' && property !== 'toJSON' && /^\d+$/.test(property)) return {};
      return undefined;
    },
  });
  expect(() => appendGrowthProfile({ destination, record: wide, mode: 'required' })).toThrow(
    `exceeds the ${GROWTH_PROFILE_OUTPUT_LIMITS.values} profile serialization value limit`,
  );

  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic.self = cyclic;
  try {
    appendGrowthProfile({ destination, record: cyclic, mode: 'required' });
    throw new Error('expected cyclic export to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(GrowthProfileExportError);
    if (!(error instanceof GrowthProfileExportError)) throw error;
    expect(error.destination).toBe(destination);
    expect(error.cause).toBeInstanceOf(TypeError);
    expect((error.cause as Error).message).toBe('JSON.stringify cannot serialize cyclic structures.');
  }

  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect(appendGrowthProfile({ destination, record: { n: 1n } })).toBeUndefined();
    expect(warn.mock.calls[0]![0]).toContain('JSON.stringify cannot serialize BigInt.');
  } finally {
    warn.mockRestore();
  }
  expect(existsSync(destination)).toBe(false);

  let toJSONCalls = 0;
  appendGrowthProfile({
    destination: join(directory, 'tojson.jsonl'),
    record: {
      toJSON() {
        toJSONCalls++;
        return { once: true };
      },
    },
    mode: 'required',
  });
  expect(toJSONCalls).toBe(1);
});
