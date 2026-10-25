import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { convertBangumi } from '@rezics/conversion/bangumi';
import { convertVndb, vndbLimits } from '@rezics/conversion/vndb';
import { convertWikidata, wikidataLimits } from '@rezics/conversion/wikidata';
import { convertOpenLibrary } from '@rezics/conversion/open-library';
import type { ConversionInput } from '@rezics/conversion';
import { sourceDigest } from '../packages/conversion/src/support.ts';
import {
  MISSING_COST_OBSERVER_DRIVER,
  type Cost,
  type CreateImportCostObserverDriver,
  type ImportCostObserverDriver,
  type Observation,
} from './imports-cost-observer-driver.ts';

async function open(): Promise<ImportCostObserverDriver> {
  const binding = process.env.IMPORT_COST_OBSERVER_DRIVER;
  if (!binding) throw new Error(MISSING_COST_OBSERVER_DRIVER);
  const module = (await import(binding)) as { createImportCostObserverDriver: CreateImportCostObserverDriver };
  return module.createImportCostObserverDriver();
}
async function using(run: (driver: ImportCostObserverDriver) => Promise<void>) {
  const driver = await open();
  try {
    await run(driver);
  } finally {
    await driver.close();
  }
}
function success<T>(result: Observation<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  return result.value;
}
const numericKeys = [
  'fieldVisits',
  'byteVisits',
  'workUnits',
  'allocatedBytes',
  'peakRetainedBytes',
  'databaseAttempts',
  'partitionAttempts',
  'networkRequests',
  'filesystemAttempts',
] as const;
function numeric(cost: Cost) {
  expect(Object.keys(cost).sort()).toEqual([...numericKeys].sort());
  for (const key of numericKeys) {
    expect(Number.isSafeInteger(cost[key])).toBe(true);
    expect(cost[key]).toBeGreaterThanOrEqual(0);
  }
  expect(cost.workUnits).toBe(cost.fieldVisits + cost.byteVisits);
}
function pure(cost: Cost) {
  numeric(cost);
  expect([cost.databaseAttempts, cost.partitionAttempts, cost.networkRequests, cost.filesystemAttempts]).toEqual([
    0, 0, 0, 0,
  ]);
}

// One deterministic generator, native objects only. M is real source fields.
// Bangumi tags and OL publishers are capped at 64 in normalize/array; VN titles
// and WD statements expose 64. Byte caps are 64 KiB/64 KiB/128 KiB/2 MiB.
const context = { subjectId: '00000000-0000-4000-8000-000000000001' };
function seed(m: number) {
  const tag = (i: number) => `field-${String(i).padStart(3, '0')}`;
  return [
    {
      convert: convertBangumi,
      cap: 65536,
      input: {
        external_id: '42',
        record_revision: '7',
        record: {
          id: 42,
          type: 1,
          name: 'Book',
          summary: 'Literal text',
          tags: Array.from({ length: m }, (_, i) => ({ name: tag(i) })),
        },
      },
    },
    {
      convert: convertVndb,
      cap: vndbLimits.recordBytes,
      input: {
        external_id: 'v123',
        record_revision: '7',
        record: {
          vn: { id: 'v123', olang: 'en' },
          entry_meta: { id: 'v123', revision: 7 },
          vn_titles: Array.from({ length: m }, (_, i) => ({
            id: 'v123',
            lang: `en-x-t${i}`,
            official: true,
            title: tag(i),
            latin: null,
          })),
        },
      },
    },
    {
      convert: convertWikidata,
      cap: wikidataLimits.bytes,
      input: {
        external_id: 'Q571',
        record_revision: '7',
        record: {
          id: 'Q571',
          type: 'item',
          lastrevid: 7,
          labels: { en: { language: 'en', value: 'Book' } },
          aliases: {},
          descriptions: {},
          claims: {
            P31: [
              {
                type: 'statement',
                rank: 'normal',
                mainsnak: {
                  property: 'P31',
                  snaktype: 'value',
                  datatype: 'wikibase-item',
                  datavalue: {
                    type: 'wikibase-entityid',
                    value: { 'entity-type': 'item', 'numeric-id': 47461344, id: 'Q47461344' },
                  },
                },
              },
            ],
            P856: Array.from({ length: m - 1 }, (_, i) => ({
              type: 'statement',
              rank: 'normal',
              mainsnak: {
                property: 'P856',
                snaktype: 'value',
                datatype: 'url',
                datavalue: { type: 'string', value: `https://example.org/${tag(i)}` },
              },
            })),
          },
        },
      },
    },
    {
      convert: convertOpenLibrary,
      cap: 2 * 1024 * 1024,
      input: {
        external_id: '/works/OL1W',
        record_revision: '7',
        record: {
          type: { key: '/type/work' },
          key: '/works/OL1W',
          revision: 7,
          last_modified: { type: '/type/datetime', value: '2025-01-02T03:04:05.123456' },
          title: 'Book',
          publishers: Array.from({ length: m }, (_, i) => tag(i)),
        },
      },
    },
  ];
}

test('callback runs once including nested async work and returns the actual value', async () => {
  await using(async (driver) => {
    let calls = 0;
    const value = { marker: new Uint8Array(257) };
    const result = await driver.measure(async () => {
      calls++;
      await Promise.resolve();
      return { value, copy: value.marker.slice() };
    });
    expect(calls).toBe(1);
    expect(success(result).value).toBe(value);
    expect(result.counters.byteVisits).toBeGreaterThanOrEqual(257);
    pure(result.counters);
  });
});

test('actual copies and repeated descriptor visits increase counters', async () => {
  await using(async (driver) => {
    const bytes = new Uint8Array(4096);
    const object = Object.freeze({ field: 'actual' });
    const probe = (passes: number) =>
      driver.measure(() => {
        const copies = [];
        for (let i = 0; i < passes; i++) {
          Object.getOwnPropertyDescriptor(object, 'field');
          copies.push(bytes.slice());
        }
        return copies;
      });
    const one = await probe(1),
      three = await probe(3);
    expect(success(three)).toHaveLength(3);
    success(one);
    expect(three.counters.fieldVisits).toBeGreaterThan(one.counters.fieldVisits);
    expect(three.counters.byteVisits - one.counters.byteVisits).toBeGreaterThanOrEqual(8192);
    expect(three.counters.allocatedBytes - one.counters.allocatedBytes).toBeGreaterThanOrEqual(8192);
  });
});

test('overlapping old and new backing allocations count once per identity including aliased views', async () => {
  await using(async (driver) => {
    const probe = (copy: boolean) =>
      driver.measure(() => {
        const old = new Uint8Array(16384);
        const next = copy ? old.slice() : old.subarray();
        return [old, next, next.subarray()];
      });
    const aliases = await probe(false),
      copies = await probe(true);
    expect(success(aliases)[0]!.buffer).toBe(success(aliases)[1]!.buffer);
    expect(success(copies)[0]!.buffer).not.toBe(success(copies)[1]!.buffer);
    expect(copies.counters.peakRetainedBytes - aliases.counters.peakRetainedBytes).toBe(16384);
    expect(copies.counters.allocatedBytes - aliases.counters.allocatedBytes).toBe(16384);
  });
});

test('real parsing serialization and hash passes are observed without replay', async () => {
  await using(async (driver) => {
    const text = JSON.stringify({ field: 'secret-data'.repeat(1024) });
    const probe = (passes: number) =>
      driver.measure(() => {
        let digest = '';
        for (let i = 0; i < passes; i++) {
          const parsed = JSON.parse(text);
          const serialized = JSON.stringify(parsed);
          digest = createHash('sha256').update(serialized).digest('hex') + sourceDigest(parsed);
        }
        return digest;
      });
    const one = await probe(1),
      two = await probe(2);
    expect(success(one)).toBe(success(two));
    expect(two.counters.byteVisits - one.counters.byteVisits).toBeGreaterThanOrEqual(Buffer.byteLength(text) * 3);
    expect(two.counters.allocatedBytes).toBeGreaterThan(one.counters.allocatedBytes);
    pure(two.counters);
  });
});

test('errors retain partial work restore probes and permit independent reopening', async () => {
  await using(async (driver) => {
    const original = [JSON.parse, JSON.stringify, Uint8Array.prototype.slice, Object.getOwnPropertyDescriptor];
    const callback = () => new Uint8Array(4096).slice();
    const baseline = await driver.measure(callback);
    const error = new Error('private-error-sentinel');
    for (const asynchronous of [false, true]) {
      let calls = 0;
      const result = await driver.measure(() => {
        calls++;
        callback();
        if (asynchronous) return Promise.reject(error);
        throw error;
      });
      expect(calls).toBe(1);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe(error);
      expect(result.counters.allocatedBytes).toBeGreaterThanOrEqual(8192);
      numeric(result.counters);
      callback(); // outside measurement must not contaminate the next interval
      const reopened = await open();
      try {
        const fresh = await reopened.measure(callback);
        expect(success(fresh)).toEqual(success(baseline));
        expect(fresh.counters).toEqual(baseline.counters);
      } finally {
        await reopened.close();
      }
      expect((await driver.measure(callback)).counters).toEqual(baseline.counters);
      expect([JSON.parse, JSON.stringify, Uint8Array.prototype.slice, Object.getOwnPropertyDescriptor]).toEqual(
        original,
      );
    }
  });
});

test('all four actual exports preserve default results and digests with unread frozen private getters', async () => {
  await using(async (driver) => {
    for (const sample of seed(8)) {
      const input: ConversionInput = sample.input;
      const expected = sample.convert(input);
      let privateReads = 0;
      const record = Object.freeze(
        Object.defineProperty(input.record, 'account', {
          get() {
            privateReads++;
            throw new Error('credential-secret');
          },
          enumerable: true,
        }),
      );
      const measured = await driver.measure(() => sample.convert({ ...input, record }));
      expect(success(measured)).toEqual(expected);
      expect(sample.convert(input)).toEqual(expected);
      expect(privateReads).toBe(0);
      pure(measured.counters);
      expect(measured.counters.workUnits).toBeGreaterThan(0);
      expect(measured.counters.allocatedBytes).toBeGreaterThan(0);
    }
  });
});

test('one native seed at M 1 8 64 has linear work allocations and bounded retained payload independent of N and history', async () => {
  await using(async (driver) => {
    expect(vndbLimits.maxTitles).toBe(64);
    expect(wikidataLimits.statements).toBe(64);
    const runs: Cost[][] = [];
    for (const m of [1, 8, 64]) {
      const row: Cost[] = [];
      for (const sample of seed(m)) {
        expect(Buffer.byteLength(JSON.stringify(sample.input.record))).toBeLessThanOrEqual(sample.cap);
        const callback = () => sample.convert(sample.input, context);
        const expected = callback();
        const baseline = await driver.measure(callback);
        expect(success(baseline)).toEqual(expected);
        for (const [n, history] of [
          [32, 512],
          [128, 32],
          [512, 128],
        ] as const) {
          // These remain caller-private: no seed/options are passed to measure.
          const unrelated = Object.freeze({
            catalogue: Array.from({ length: n }, (_, i) => ({ key: i })),
            history: Array.from({ length: history }, (_, i) => ({ revision: i })),
            get credential() {
              throw new Error('do-not-observe');
            },
          });
          const measured = await driver.measure(callback);
          expect(success(measured)).toEqual(expected);
          expect(measured.counters).toEqual(baseline.counters);
          expect(unrelated.catalogue).toHaveLength(n);
          expect(unrelated.history).toHaveLength(history);
        }
        pure(baseline.counters);
        // Fixed portable ceilings, never calibrated from observed results. Include
        // validator/hash temporaries, but prohibit retaining catalogue/history.
        expect(baseline.counters.peakRetainedBytes).toBeLessThanOrEqual(sample.cap * 64);
        expect(baseline.counters.allocatedBytes).toBeLessThanOrEqual(1048576 * (m + 1));
        row.push(baseline.counters);
      }
      runs.push(row);
    }
    for (let source = 0; source < 4; source++) {
      const [a, b, c] = runs.map((row) => row[source]!);
      for (const key of ['fieldVisits', 'byteVisits', 'workUnits', 'allocatedBytes'] as const) {
        expect(a![key]).toBeGreaterThan(0);
        expect(b![key]).toBeGreaterThan(a![key]);
        expect(c![key]).toBeGreaterThan(b![key]);
        expect(b![key]).toBeLessThanOrEqual(a![key] * 8);
        expect(c![key]).toBeLessThanOrEqual(b![key] * 8);
      }
    }
  });
});

test('caught real database filesystem and network attempts are observed rather than assumed zero', async () => {
  await using(async (driver) => {
    const database = new Database(':memory:');
    try {
      const result = await driver.measure(async () => {
        database.query('SELECT 1').get();
        try {
          readFileSync('.temp/nonexistent-cost-observer-input');
        } catch {
          /* actual rejected read */
        }
        try {
          await fetch('http://127.0.0.1:0', { signal: AbortSignal.timeout(50) });
        } catch {
          /* actual rejected request */
        }
      });
      success(result);
      numeric(result.counters);
      expect(result.counters.databaseAttempts).toBeGreaterThan(0);
      expect(result.counters.filesystemAttempts).toBeGreaterThan(0);
      expect(result.counters.networkRequests).toBeGreaterThan(0);
    } finally {
      database.close();
    }
  });
});
