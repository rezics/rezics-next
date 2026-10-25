import { expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as net from 'node:net';
import * as http from 'node:http';
import * as https from 'node:https';
import { checkBatchWrite } from '@rezics/definitions/bulk';
import { ConversionError } from '../src/index.ts';
import { convertOpenLibrary } from '../src/open-library.ts';

const subjectId = '00000000-0000-4000-8000-000000000001';
// The source module's declared relation cap is 64 and record byte cap is 2 MiB.
const fieldCap = 64;
const byteCap = 2 * 1024 * 1024;

function seed(fields: number) {
  return {
    type: { key: '/type/work' },
    key: '/works/OL1W',
    revision: 1,
    last_modified: { type: '/type/datetime', value: '2025-01-02T03:04:05.123456' },
    title: 'A bounded book',
    authors: Array.from({ length: fields }, (_, i) => ({ author: { key: `/authors/OL${i + 1}A` } })),
  };
}

const input = (record: ReturnType<typeof seed>) => ({
  external_id: record.key,
  record_revision: String(record.revision),
  record,
});

/** Count actual source reads, including descriptor-based safe projection. */
function measure(record: ReturnType<typeof seed>) {
  let visits = 0;
  const copies = new WeakMap<object, object>();
  const wrap = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value;
    const known = copies.get(value);
    if (known) return known;
    const wrapped = new Proxy(value, {
      get(target, key, receiver) {
        if (Object.hasOwn(target, key)) visits++;
        return wrap(Reflect.get(target, key, receiver));
      },
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (descriptor && 'value' in descriptor) {
          visits++;
          return { ...descriptor, value: wrap(descriptor.value) };
        }
        return descriptor;
      },
    });
    copies.set(value, wrapped);
    return wrapped;
  };
  const bytes = Buffer.byteLength(JSON.stringify(record));
  const measured = wrap(record) as ReturnType<typeof seed>;
  const output = convertOpenLibrary({ ...input(record), record: measured }, { subjectId });
  return { visits, bytes, output };
}

test('pure converter growth stays within its declared field and byte cap', () => {
  const runs = [1, 8, 64].map((fields) => ({ fields, ...measure(seed(fields)) }));
  for (const { fields, visits, bytes, output } of runs) {
    expect(bytes).toBeGreaterThan(fields * 30);
    expect(bytes).toBeLessThanOrEqual(512 + fields * 64);
    expect(visits).toBeGreaterThanOrEqual(fields);
    expect(visits).toBeLessThanOrEqual(256 + fields * 32);
    expect(output.proposals.length).toBeGreaterThanOrEqual(fields);
    expect(output.proposals.length).toBeLessThanOrEqual(fields + 4);
    expect(checkBatchWrite({ commands: output.proposals })).toEqual([]);
  }
  expect(runs[2]!.visits).toBeGreaterThan(runs[0]!.visits);
  expect(runs[2]!.bytes).toBeGreaterThan(runs[0]!.bytes);
  expect(() => convertOpenLibrary(input(seed(fieldCap + 1)), { subjectId })).toThrow(ConversionError);
  expect(() => convertOpenLibrary(input({ ...seed(1), title: 'x'.repeat(byteCap + 1) }), { subjectId })).toThrow(
    ConversionError,
  );
});

test('fixed conversion touches zero SQL and network across unrelated catalogue and history growth', () => {
  const attempts: string[] = [];
  const guards: { mockRestore(): void }[] = [];
  const guard = <T extends object>(target: T, key: keyof T) => {
    guards.push(
      spyOn(target, key as never).mockImplementation((() => {
        attempts.push(String(key));
        throw new Error('Unexpected source conversion I/O');
      }) as never),
    );
  };
  const record = seed(8);
  const baseline = convertOpenLibrary(input(record), { subjectId });
  try {
    guard(globalThis, 'fetch');
    for (const key of ['query', 'prepare', 'run', 'exec'] as const) guard(Database.prototype, key);
    for (const key of ['connect', 'createConnection'] as const) guard(net, key);
    for (const key of ['request', 'get'] as const) {
      guard(http, key);
      guard(https, key);
    }
    for (const key of ['connect', 'listen', 'spawn', 'spawnSync'] as const) guard(Bun, key);
    for (const scale of [1, 8, 64]) {
      // These populations are deliberately inaccessible to the pure source function.
      const catalogue = Array.from({ length: scale }, (_, n) => ({ key: `unrelated-${n}` }));
      const history = Array.from({ length: scale }, () => Array.from({ length: scale }, () => 'old revision'));
      expect(convertOpenLibrary(input(record), { subjectId })).toEqual(baseline);
      expect(catalogue.length).toBe(scale);
      expect(history.flat().length).toBe(scale * scale);
    }
  } finally {
    guards.reverse().forEach((guard) => guard.mockRestore());
  }
  expect(attempts).toEqual([]);
});

test('source scalar edits change the digest while private pollution and native binding do not', () => {
  const record = seed(1);
  const baseline = convertOpenLibrary(input(record), { subjectId });
  expect(convertOpenLibrary(input(record), { subjectId })).toEqual(baseline);
  const polluted = { ...record, user_posts: [{ text: 'private' }], converter_revision: 'forged' };
  expect(convertOpenLibrary(input(polluted), { subjectId })).toEqual(baseline);
  const changed = convertOpenLibrary(input({ ...record, title: 'Another bounded book' }), { subjectId });
  expect(changed.digest).not.toBe(baseline.digest);
  const resolved = convertOpenLibrary(input(record), {
    subjectId: '00000000-0000-4000-8000-000000000002',
    resolvedReferences: { '/authors/OL1A': '00000000-0000-4000-8000-000000000003' },
  });
  expect(resolved.digest).toBe(baseline.digest);
  expect(resolved.proposals).not.toEqual(baseline.proposals);
});
