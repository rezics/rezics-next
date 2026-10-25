import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readDump } from '../src/dumps.ts';
import * as limits from '../src/dumps-bytes.ts';
import { Importer } from '../src/importer.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import { RunStore, type SourceProjection } from '../src/run-store.ts';

const encoder = new TextEncoder();
const DEFAULT = 256 * 1024;
const HARD = 1024 * 1024;
function native(textBytes: number) {
  const payload = {
    type: { key: '/type/work' },
    key: '/works/OL100000W',
    revision: 7,
    last_modified: { type: '/type/datetime', value: '2025-01-02T03:04:05.123456' },
    title: 'Book',
    description: 'x'.repeat(textBytes),
  };
  return {
    payload,
    bytes: encoder.encode(`/type/work\t${payload.key}\t7\t2025-01-02T03:04:05.123456\t${JSON.stringify(payload)}\n`),
  };
}
async function* chunks(bytes: Uint8Array) {
  for (let offset = 0; offset < bytes.length; offset += 32 * 1024) yield bytes.slice(offset, offset + 32 * 1024);
}
async function collect(bytes: Uint8Array, maxRecordBytes?: number) {
  const result = [];
  for await (const row of readDump('openlibrary', chunks(bytes), { maxRecordBytes })) result.push(row);
  return result;
}

test('source record limits are separate from chunk and public bulk limits', () => {
  expect(limits.DEFAULT_DUMP_RECORD_BYTES).toBe(DEFAULT);
  expect(limits.MAX_DUMP_RECORD_BYTES).toBe(HARD);
  expect(limits.dumpRecordLimit(undefined)).toBe(DEFAULT);
  expect(limits.dumpRecordLimit(HARD)).toBe(HARD);
  expect(limits.dumpRecordLimit(128)).toBe(128);
});

test('reader applies the default cap and accepts an explicit bounded larger record', async () => {
  const large = native(300 * 1024);
  await expect(collect(large.bytes)).rejects.toBeInstanceOf(Error);
  const accepted = await collect(large.bytes, HARD);
  expect(accepted).toHaveLength(1);
  expect(accepted[0]!.key).toBe(large.payload.key);
  expect(accepted[0]!.payload).toEqual(large.payload);
  await expect(collect(native(HARD + 1).bytes, HARD)).rejects.toBeInstanceOf(Error);
});

test('invalid record caps fail before pulling any upstream input', async () => {
  for (const maxRecordBytes of [0, -1, 1.5, NaN, Infinity, HARD + 1, Number.MAX_SAFE_INTEGER]) {
    let pulls = 0;
    async function* input() {
      pulls++;
      yield encoder.encode('{}\n');
    }
    await expect(readDump('wikidata', input(), { maxRecordBytes }).next()).rejects.toBeInstanceOf(Error);
    expect(pulls).toBe(0);
  }
});

test('durable sanitized projections admit legal larger records and reject the hard cap plus one', () => {
  const database = new Database(':memory:');
  const store = new RunStore<SourceProjection>(database, { projectionMode: 'source-record' });
  try {
    const run = store.begin('open-library');
    if (run === 'busy') throw new Error('unexpected busy');
    const row = {
      source: 'open-library',
      recordKey: '/works/OL100000W',
      recordRevision: '7',
      digest: 'a'.repeat(64),
      converter_revision: 'record-cap@1',
      state: 'present' as const,
    };
    const normalizedRecord = native(300 * 1024).payload;
    store.stage(run, { row, projection: { sourceKind: 'openlibrary', normalizedRecord } });
    expect(() =>
      store.stage(run, {
        row: { ...row, recordKey: '/works/OL100001W' },
        projection: { sourceKind: 'openlibrary', normalizedRecord: native(HARD + 1).payload },
      }),
    ).toThrow();
    expect(store.seal(run, { complete: true }).status).toBe('ready');
    const page = store.pageStaged(run, { limit: 2 });
    expect(page).toHaveLength(1);
    expect(page[0]!.projection.normalizedRecord).toEqual(normalizedRecord);
  } finally {
    store.close();
    database.close();
  }
});

test('runDump uses the default record cap before any public API effects', async () => {
  let calls = 0;
  const importer = new Importer({
    path: ':memory:',
    transport: {
      async batchWrite(): Promise<never> {
        calls++;
        throw new Error('unexpected effect');
      },
      async readFence(): Promise<never> {
        calls++;
        throw new Error('unexpected effect');
      },
    },
  });
  try {
    const result = await importer.runDump(createSourceRegistration('openlibrary'), chunks(native(300 * 1024).bytes));
    expect(result.status).toBe('invalid-dump');
    expect(calls).toBe(0);
    expect(importer.session.store.source('open-library').generation).toBeNull();
  } finally {
    await importer.close();
  }
});
