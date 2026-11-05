import { expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as net from 'node:net';
import * as http from 'node:http';
import * as https from 'node:https';
import { checkBatchWrite } from '@rezics/definitions/bulk';
import { ConversionError } from '../src/index.ts';
import { convertOpenLibrary } from '../src/open-library.ts';

const subjectId = '00000000-0000-4000-8000-000000000001';
const calendar = 'http://www.wikidata.org/entity/Q1985727';
// The source module's declared relation cap is 64 and record byte cap is 2 MiB.
const fieldCap = 64;
const byteCap = 2 * 1024 * 1024;

function seed(fields: number, first_publish_date?: string) {
  return {
    type: { key: '/type/work' },
    key: '/works/OL1W',
    revision: 1,
    last_modified: { type: '/type/datetime', value: '2025-01-02T03:04:05.123456' },
    title: 'A bounded book',
    ...(first_publish_date === undefined ? {} : { first_publish_date }),
    authors: Array.from({ length: fields }, (_, i) => ({ author: { key: `/authors/OL${i + 1}A` } })),
  };
}

const input = (record: ReturnType<typeof seed>) => ({
  external_id: record.key,
  record_revision: String(record.revision),
  record,
});

// Whole-return byte slopes and unrelated conversions are proved in logical-growth.test.ts.
test('native relation caps preserve valid proposals', () => {
  for (const fields of [1, 8, 64]) {
    const output = convertOpenLibrary(input(seed(fields)), { subjectId });
    expect(output.proposals.length).toBeGreaterThanOrEqual(fields);
    expect(output.proposals.length).toBeLessThanOrEqual(fields + 4);
    expect(checkBatchWrite({ commands: output.proposals })).toEqual([]);
  }
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
  const record = seed(8, '1853');
  const baseline = convertOpenLibrary(input(record), { subjectId });
  const withoutDateRecord = { ...record };
  delete withoutDateRecord.first_publish_date;
  const withoutDate = convertOpenLibrary(input(withoutDateRecord), { subjectId });
  expect(baseline.normalizedRecord.first_publish_date).toBe('1853');
  expect(
    Buffer.byteLength(JSON.stringify(baseline.normalizedRecord)) -
      Buffer.byteLength(JSON.stringify(withoutDate.normalizedRecord)),
  ).toBe(Buffer.byteLength(',"first_publish_date":"1853"'));
  expect(
    baseline.proposals.filter(
      (command) =>
        command.op === 'propose' &&
        command.statement.property.id === 'schema:datePublished' &&
        command.statement.value.type === 'value' &&
        JSON.stringify(command.statement.value.content) ===
          JSON.stringify({ time: '+1853-00-00T00:00:00Z', precision: 9, calendarmodel: calendar }),
    ),
  ).toHaveLength(1);
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
