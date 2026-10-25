import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { loadReaderBounds, type BoundsProbe, type RetainedSample } from './imports-reader-bounds-driver.ts';
import type { DumpRecord, DumpSource } from './imports-dumps-driver.ts';
import type { SourceProjection } from '../services/importer/src/run-store.ts';

const sources: DumpSource[] = ['bangumi', 'vndb', 'openlibrary', 'wikidata'];
const encoder = new TextEncoder();
const HARD = 1048576;
const DEFAULT = 262144;
const RECORD = 4096;
type Harness = Awaited<ReturnType<typeof loadReaderBounds>>;
async function scenario(work: (h: Harness) => Promise<void>) {
  const h = await loadReaderBounds(); // First action in EVERY outcome, before fixtures/product imports.
  try {
    await work(h);
    expect(await h.probe.transportAttempts()).toEqual([]);
  } finally {
    await h.probe.close();
  }
}
async function drain(input: AsyncIterable<unknown>) {
  for await (const _ of input) {
    /* no retained output */
  }
}
async function collect<T>(input: AsyncIterable<T>) {
  const out: T[] = [];
  for await (const value of input) out.push(value);
  return out;
}
async function rejected(work: () => Promise<unknown>) {
  let failure: unknown;
  try {
    await work();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message.length).toBeGreaterThan(0);
}
async function measured<T>(probe: BoundsProbe, work: () => Promise<T>) {
  const result = await probe.measure(work);
  expect(result.effects).toEqual({ sql: [], requests: [], fileWrites: [] });
  return result;
}
function peaks(samples: RetainedSample[]) {
  expect(samples.length).toBeGreaterThan(0);
  for (const sample of samples) {
    for (const bytes of Object.values(sample)) {
      expect(Number.isSafeInteger(bytes) && bytes >= 0).toBe(true);
    }
    expect(sample.total).toBe(sample.input + sample.line + sample.scratch + sample.metadata);
  }
  return Object.fromEntries(
    ['input', 'line', 'scratch', 'metadata', 'total', 'keyEntries'].map((key) => [
      key,
      Math.max(...samples.map((sample) => sample[key as keyof RetainedSample])),
    ]),
  ) as unknown as RetainedSample;
}
// One deterministic seed; fixed-width identities/titles keep line capacity equal
// at all three scales. No source-wide allocation or retained expected key list.
function fixture(source: DumpSource, index = 0, title = 'Public 🌙 title') {
  const id = String(100000 + index);
  const payload: Record<string, unknown> =
    source === 'bangumi'
      ? { id: Number(id), type: 2, name: title }
      : source === 'vndb'
        ? { id: `v${id}`, description: title, image: null }
        : source === 'openlibrary'
          ? { key: `/works/OL${id}W`, type: { key: '/type/work' }, revision: 7, title }
          : {
              id: `Q${id}`,
              type: 'item',
              lastrevid: 101,
              labels: { en: { language: 'en', value: title } },
              claims: {},
            };
  const key = source === 'bangumi' ? id : source === 'openlibrary' ? String(payload.key) : String(payload.id);
  const line =
    source === 'vndb'
      ? `${key}\t${title.replaceAll('\\', '\\\\').replaceAll('\t', '\\t').replaceAll('\n', '\\n')}\t\\N`
      : source === 'openlibrary'
        ? `/type/work\t${key}\t7\t2024-01-02T03:04:05\t${JSON.stringify(payload)}`
        : JSON.stringify(payload);
  const record: DumpRecord = {
    source,
    key,
    revision: source === 'openlibrary' ? '7' : source === 'wikidata' ? '101' : null,
    payload,
  };
  return { line, record };
}
function feed(
  source: DumpSource,
  count: number,
  size: number,
  options: { duplicate?: boolean; conflicting?: boolean; array?: boolean; title?: string } = {},
) {
  const stats = { pulls: 0, bytes: 0, closed: false };
  async function* parts() {
    if (source === 'vndb') yield 'COPY public.vn (id, description, image) FROM stdin;\n';
    if (options.array) yield '[\n';
    let seed = 0x51a7;
    for (let i = 0; i < count; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      yield (
        fixture(
          source,
          options.duplicate ? 0 : i,
          options.title === undefined
            ? `Public 🌙 ${seed.toString(16).padStart(8, '0')}`
            : `${options.conflicting && i > 0 ? 'Changed ' : ''}${options.title}`,
        ).line + (options.array && i + 1 < count ? ',\n' : '\n')
      );
    }
    if (source === 'vndb') yield '\\.\n';
    if (options.array) yield ']\n';
  }
  async function* input() {
    try {
      for await (const part of parts()) {
        const bytes = encoder.encode(part); // One record only, never the dump.
        for (let start = 0; start < bytes.length; start += size) {
          const chunk = bytes.slice(start, start + size); // Own bounded backing allocation.
          stats.pulls++;
          stats.bytes += chunk.byteLength;
          yield chunk;
        }
      }
    } finally {
      stats.closed = true;
    }
  }
  return { input: input(), stats };
}

test('service composition exports a fixed one MiB hard chunk cap and a 256 KiB default', async () =>
  scenario(async ({ api }) => {
    expect(api.MAX_DUMP_CHUNK_BYTES).toBe(HARD);
    expect(api.DEFAULT_DUMP_CHUNK_BYTES).toBe(DEFAULT);
  }));

test('invalid chunk settings reject before obtaining or pulling input for both real reader APIs', async () =>
  scenario(async ({ api, probe }) => {
    for (const cap of [0, -1, 1.5, NaN, Infinity, HARD + 1, Number.MAX_SAFE_INTEGER, null, '64']) {
      for (const source of [...sources, 'lines'] as const) {
        let opened = 0;
        const input = {
          [Symbol.asyncIterator]() {
            opened++;
            throw new Error('Input must remain untouched');
          },
        };
        const counters = api.createDumpCounters();
        await measured(probe, () =>
          rejected(() =>
            drain(
              source === 'lines'
                ? api.dumpLines(input, () => RECORD, counters, { maxChunkBytes: cap as number })
                : api.readDump(source, input, { maxRecordBytes: RECORD, maxChunkBytes: cap as number, counters }),
            ),
          ),
        );
        expect(opened).toBe(0);
        expect(counters.pulledChunks).toBe(0);
      }
    }
  }));

test('oversized chunks and tiny views of oversized backings reject before byte work across all sources', async () =>
  scenario(async ({ api, probe }) => {
    for (const cap of [64, DEFAULT, HARD])
      for (const view of [false, true]) {
        for (const source of [...sources, 'lines'] as const) {
          const bytes = new Uint8Array(cap + 1);
          bytes.fill(10);
          const chunk = view ? bytes.subarray(0, 1) : bytes;
          let pulls = 0;
          let closed = false;
          async function* input() {
            try {
              pulls++;
              yield chunk;
              pulls++;
              throw new Error('Tail pulled');
            } finally {
              closed = true;
            }
          }
          const counters = api.createDumpCounters();
          const options = { maxRecordBytes: RECORD, counters, ...(cap === DEFAULT ? {} : { maxChunkBytes: cap }) };
          const result = await measured(probe, () =>
            rejected(() =>
              drain(
                source === 'lines'
                  ? api.dumpLines(input(), () => RECORD, counters, cap === DEFAULT ? undefined : { maxChunkBytes: cap })
                  : api.readDump(source, input(), options),
              ),
            ),
          );
          expect(pulls).toBe(1);
          expect(closed).toBe(true);
          expect(counters.scannedBytes).toBe(0);
          expect(counters.copiedBytes).toBe(0);
          expect(counters.yieldedRecords).toBe(0);
          expect(peaks(result.samples).input).toBe(0); // Validation did not admit the backing.
          expect(peaks(result.samples).total).toBeLessThanOrEqual(4096);
        }
      }
  }));

test('the exact backing cap is accepted and retained accounting charges the full subarray backing', async () =>
  scenario(async ({ api, probe }) => {
    for (const cap of [64, DEFAULT, HARD]) {
      const backing = new Uint8Array(cap);
      backing[0] = 10;
      async function* input() {
        yield backing.subarray(0, 1);
      }
      const counters = api.createDumpCounters();
      const result = await measured(probe, () =>
        drain(api.dumpLines(input(), () => RECORD, counters, { maxChunkBytes: cap })),
      );
      expect(counters.scannedBytes).toBe(1);
      expect(counters.pulledBytes).toBe(1);
      expect(peaks(result.samples).input).toBe(cap);
      expect(counters.peakRetainedBytes).toBe(peaks(result.samples).total);
      for (const source of sources) {
        const supplied = feed(source, 1, cap);
        async function* backed() {
          for await (const chunk of supplied.input) {
            const allocation = new Uint8Array(cap);
            allocation.set(chunk);
            yield allocation.subarray(0, chunk.length);
          }
        }
        const result = await measured(probe, () =>
          drain(api.readDump(source, backed(), { maxRecordBytes: RECORD, maxChunkBytes: cap })),
        );
        expect(peaks(result.samples).input).toBe(cap);
      }
    }
  }));

test('one byte UTF8 COPY JSONL and Wikidata array chunks preserve native values and revisions', async () =>
  scenario(async ({ api, probe }) => {
    const title = 'Public 🌙\tline\n\\path';
    for (const source of sources)
      for (const array of source === 'wikidata' ? [false, true] : [false]) {
        const supplied = feed(source, 2, 1, { title, array });
        const result = await measured(probe, () =>
          collect(api.readDump(source, supplied.input, { maxRecordBytes: RECORD, maxChunkBytes: 1 })),
        );
        expect(result.value).toEqual([fixture(source, 0, title).record, fixture(source, 1, title).record]);
        expect(supplied.stats.closed).toBe(true);
      }
  }));

test('record byte limits remain independent of chunk caps with exact acceptance and over limit rejection', async () =>
  scenario(async ({ api, probe }) => {
    const title = '🌙'.repeat(300);
    for (const source of sources) {
      const bytes = encoder.encode(fixture(source, 0, title).line).length;
      expect(bytes).toBeGreaterThan(64);
      for (const maxRecordBytes of [bytes, bytes - 1]) {
        const supplied = feed(source, 1, 64, { title });
        const read = () => collect(api.readDump(source, supplied.input, { maxRecordBytes, maxChunkBytes: 64 }));
        if (maxRecordBytes === bytes)
          expect((await measured(probe, read)).value).toEqual([fixture(source, 0, title).record]);
        else await measured(probe, () => rejected(read));
      }
    }
  }));

test('bounded input remains lazy closes on cancellation and propagates the original upstream failure', async () =>
  scenario(async ({ api, probe }) => {
    for (const source of sources) {
      const supplied = feed(source, 64, 1);
      await measured(probe, async () => {
        const iterator = api.readDump(source, supplied.input, { maxRecordBytes: RECORD, maxChunkBytes: 1 });
        try {
          expect((await iterator.next()).value.key).toBe(fixture(source).record.key);
        } finally {
          await iterator.return(undefined);
        }
      });
      expect(supplied.stats.closed).toBe(true);
      expect(supplied.stats.bytes).toBeLessThan(512);
      const failure = new Error('Original bounded source failure');
      let closed = false;
      async function* broken() {
        try {
          yield* feed(source, 1, 1).input;
          throw failure;
        } finally {
          closed = true;
        }
      }
      await measured(probe, async () => {
        await expect(drain(api.readDump(source, broken(), { maxRecordBytes: RECORD, maxChunkBytes: 1 }))).rejects.toBe(
          failure,
        );
      });
      expect(closed).toBe(true);
    }
  }));

test('three seeded unique-key scales have linear actual byte visits constant buffers and no retained source keys', async () =>
  scenario(async ({ api, probe }) => {
    for (const source of sources) {
      const observations = [];
      for (const scale of [1, 8, 64]) {
        const supplied = feed(source, 4 * scale, 64);
        const counters = api.createDumpCounters();
        const result = await measured(probe, () =>
          drain(api.readDump(source, supplied.input, { maxRecordBytes: RECORD, maxChunkBytes: 64, counters })),
        );
        const peak = peaks(result.samples);
        expect(counters.yieldedRecords).toBe(4 * scale);
        expect(counters.pulledChunks).toBe(supplied.stats.pulls);
        expect(counters.pulledBytes).toBe(supplied.stats.bytes);
        expect(counters.scannedBytes).toBe(supplied.stats.bytes);
        expect(counters.copiedBytes).toBeGreaterThan(0);
        const visits = counters.scannedBytes + counters.copiedBytes;
        expect(visits).toBeLessThanOrEqual(6 * supplied.stats.bytes);
        expect(peak.input).toBeLessThanOrEqual(64);
        const lineCap = Math.max(RECORD + 2, source === 'vndb' ? 65536 : 0);
        expect(peak.line).toBeLessThanOrEqual(2 * lineCap);
        expect(peak.scratch).toBeLessThanOrEqual(8 * lineCap);
        expect(peak.total).toBeLessThanOrEqual(64 + 10 * lineCap + 4096);
        expect(peak.metadata).toBeGreaterThan(0);
        expect(peak.metadata).toBeLessThanOrEqual(4096);
        expect(peak.keyEntries).toBe(0); // Observed actual bookkeeping, not an expected-zero stub.
        expect(counters.peakRetainedBytes).toBe(peak.total);
        observations.push({ scale, peak, visits, pulls: supplied.stats.pulls });
      }
      const first = observations[0]!;
      for (const next of observations.slice(1)) {
        expect(next.visits).toBeGreaterThan(first.visits);
        expect(next.visits).toBeLessThanOrEqual(first.visits * next.scale);
        expect(next.pulls).toBeLessThanOrEqual(first.pulls * next.scale);
        expect(next.peak).toEqual(first.peak);
      }
    }
  }));

test('identical and conflicting duplicates all reach real indexed RunStore staging and seal invalid before transport', async () =>
  scenario(async ({ api, probe }) => {
    const { RunStore } = await import('../services/importer/src/run-store.ts');
    await mkdir('.temp', { recursive: true });
    const directory = await mkdtemp('.temp/reader-bounds-');
    try {
      for (const source of sources)
        for (const conflicting of [false, true]) {
          const store = new RunStore<SourceProjection>(`${directory}/${source}-${conflicting}.sqlite`, {
            projectionMode: 'source-record',
          });
          try {
            const run = store.begin(source);
            if (run === 'busy') throw new Error('Unexpected busy run');
            const privateText = 'PRIVATE_READER_BODY_MUST_NOT_PERSIST';
            const supplied = feed(source, 3, 32, {
              duplicate: true,
              conflicting,
              title: `Public title ${privateText}`,
            });
            const iterator = api.readDump(source, supplied.input, { maxRecordBytes: RECORD, maxChunkBytes: 32 });
            let yielded = 0;
            let duplicates = 0;
            try {
              for (;;) {
                const next = (await measured(probe, () => iterator.next())).value;
                if (next.done) break;
                yielded++;
                const record = next.value;
                const rawTitle = `${conflicting && yielded > 1 ? 'Changed ' : ''}Public title ${privateText}`;
                expect(record).toEqual(fixture(source, 0, rawTitle).record);
                const title =
                  source === 'wikidata'
                    ? (record.payload.labels as { en: { value: string } }).en.value
                    : record.payload[source === 'bangumi' ? 'name' : source === 'vndb' ? 'description' : 'title'];
                expect(typeof title).toBe('string');
                const projection: SourceProjection = {
                  sourceKind: source,
                  normalizedRecord: { title: (title as string).replace(` ${privateText}`, '') },
                };
                const staged = {
                  row: {
                    source,
                    recordKey: record.key,
                    recordRevision: record.revision ?? 'unversioned',
                    digest: new Bun.CryptoHasher('sha256').update(JSON.stringify(projection)).digest('hex'),
                    converter_revision: 'fixture@1',
                    state: 'present' as const,
                  },
                  projection,
                };
                if (yielded === 1) store.stage(run, staged);
                else {
                  expect(() => store.stage(run, staged)).toThrow();
                  duplicates++;
                }
                expect(store.pagePending(run, { limit: 1 })).toEqual([]);
              }
            } finally {
              await iterator.return(undefined);
            }
            expect(yielded).toBe(3);
            expect(duplicates).toBe(2);
            expect(store.seal(run, { complete: true }).status).toBe('invalid-input');
            expect(store.source(source)).toEqual({ generation: null, count: 0 });
            expect(store.key(source, fixture(source).record.key, run).staged).toBeNull();
            expect(store.pagePending(run, { limit: 1 })).toEqual([]);
            // Test-only privacy inspection, outside parser/DB growth measurement.
            for (const table of store.database.query("SELECT name FROM sqlite_schema WHERE type='table'").all() as {
              name: string;
            }[]) {
              expect(JSON.stringify(store.database.query(`SELECT * FROM "${table.name}"`).all())).not.toContain(
                privateText,
              );
            }
          } finally {
            store.close();
          }
        }
      for await (const path of new Bun.Glob('**/*').scan({ cwd: directory, onlyFiles: true })) {
        expect(
          Buffer.from(await Bun.file(`${directory}/${path}`).arrayBuffer()).includes(
            Buffer.from('PRIVATE_READER_BODY_MUST_NOT_PERSIST'),
          ),
        ).toBe(false);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }));
