import { expect, test } from 'bun:test';
import { gzipSync } from 'node:zlib';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  admitDumpCompression,
  createGzipDumpCounters,
  decodeDumpBytes,
  DEFAULT_DECODED_DUMP_BYTES,
  gunzipDumpChunks,
  parseDumpCompression,
} from '../src/compressed-dump.ts';
import { DumpInputError, fileChunks, openDump, type DumpInputFailureIdentity } from '../src/dump-input.ts';
import { readDump } from '../src/dumps.ts';

const encode = (text: string) => new TextEncoder().encode(text);
const ol = (key: number, title: string, revision = 7) =>
  `/type/work\t/works/OL${key}W\t${revision}\t2024-01-01\t${JSON.stringify({
    key: `/works/OL${key}W`,
    type: { key: '/type/work' },
    revision,
    title,
  })}\n`;
const wd = (key: number, title: string, revision = 7) =>
  JSON.stringify({
    type: 'item',
    id: `Q${key}`,
    lastrevid: revision,
    labels: { en: { language: 'en', value: title } },
  }) + '\n';

async function collected(source: 'openlibrary' | 'wikidata', input: AsyncIterable<Uint8Array>) {
  const records = [];
  for await (const record of readDump(source, input)) records.push({ key: record.key, revision: record.revision });
  return records;
}

async function drain(input: AsyncIterable<Uint8Array>) {
  const parts: Uint8Array[] = [];
  for await (const chunk of input) parts.push(chunk);
  return Buffer.concat(parts);
}

test('gzip members concatenate, empty last member completes, and gzip metadata cannot change record identity', async () => {
  const plain = encode(ol(1, 'Lantern') + ol(2, 'Harbor'));
  const first = gzipSync(encode(ol(1, 'Lantern')), { level: 1 });
  const second = gzipSync(encode(ol(2, 'Harbor')), { level: 9 });
  const empty = gzipSync(Buffer.alloc(0));
  const signal = new AbortController().signal;
  const concatenated = await collected(
    'openlibrary',
    gunzipDumpChunks(
      (async function* () {
        yield Buffer.concat([first, second, empty]);
      })(),
      { signal, decodeBudget: DEFAULT_DECODED_DUMP_BYTES },
    ),
  );
  expect(concatenated).toEqual(
    await collected(
      'openlibrary',
      (async function* () {
        yield plain;
      })(),
    ),
  );
  expect(concatenated).toEqual(
    await collected(
      'openlibrary',
      decodeDumpBytes(
        (async function* () {
          yield gzipSync(plain, { level: 9 });
        })(),
        {
          compression: 'gzip',
          signal,
        },
      ),
    ),
  );
  const utf = encode(ol(9, 'Café'));
  const split = utf.indexOf(0xc3);
  expect(split).toBeGreaterThan(0);
  expect(
    await collected(
      'openlibrary',
      gunzipDumpChunks(
        (async function* () {
          yield Buffer.concat([gzipSync(utf.subarray(0, split)), gzipSync(utf.subarray(split))]);
        })(),
        { signal, decodeBudget: DEFAULT_DECODED_DUMP_BYTES },
      ),
    ),
  ).toEqual(
    await collected(
      'openlibrary',
      (async function* () {
        yield utf;
      })(),
    ),
  );
  expect(
    await collected(
      'openlibrary',
      gunzipDumpChunks(
        (async function* () {
          yield Buffer.concat([gzipSync(encode(ol(1, 'A'))), gzipSync(encode(ol(1, 'B')))]);
        })(),
        { signal, decodeBudget: DEFAULT_DECODED_DUMP_BYTES },
      ),
    ),
  ).toEqual([
    { key: '/works/OL1W', revision: '7' },
    { key: '/works/OL1W', revision: '7' },
  ]);
});

test('truncated trailer, bad CRC, later corrupt member and trailing garbage fail after any decoded prefix', async () => {
  const signal = new AbortController().signal;
  const valid = gzipSync(encode(wd(1, 'One')));
  const later = Buffer.concat([valid, gzipSync(encode(wd(2, 'Two'))).subarray(0, 8)]);
  const truncated = valid.subarray(0, valid.byteLength - 4);
  const badCrc = Buffer.from(valid);
  const crcIndex = badCrc.length - 5;
  const previous = badCrc.at(crcIndex);
  expect(previous).toBeDefined();
  badCrc[crcIndex] = previous! ^ 0xff;
  const garbage = Buffer.concat([valid, encode('not-gzip')]);
  const fail = async (bytes: Uint8Array, identity: DumpInputFailureIdentity) => {
    try {
      await drain(
        gunzipDumpChunks(
          (async function* () {
            yield bytes;
          })(),
          { signal, decodeBudget: 1_000_000 },
        ),
      );
      throw new Error(`expected ${identity}`);
    } catch (error) {
      expect(error).toBeInstanceOf(DumpInputError);
      expect((error as DumpInputError).identity).toBe(identity);
    }
  };
  await fail(truncated, 'gzip-truncated');
  await fail(badCrc, 'gzip-integrity');
  await fail(later, 'gzip-truncated');
  await fail(garbage, 'gzip-trailing-garbage');
  await fail(encode('plain text named dump.gz'), 'gzip-integrity');
});

test('decode budget, cancellation during backpressure, repeated close and a replaced file fail the capture', async () => {
  const compressible = encode(`${wd(8, 'a'.repeat(8000))}`);
  const gzip = gzipSync(compressible);
  const budget = new AbortController().signal;
  try {
    await drain(
      gunzipDumpChunks(
        (async function* () {
          yield gzip;
        })(),
        { signal: budget, decodeBudget: 32 },
      ),
    );
    throw new Error('expected budget');
  } catch (error) {
    expect((error as DumpInputError).identity).toBe('decode-budget');
  }

  const slow = new AbortController();
  const counters = createGzipDumpCounters();
  const iterator = gunzipDumpChunks(
    (async function* () {
      yield gzipSync(encode(ol(3, 'Slow') + ol(4, 'Consumer')));
    })(),
    { signal: slow.signal, decodeBudget: 1_000_000, counters },
  );
  expect((await iterator.next()).done).toBe(false);
  slow.abort(new DOMException('Import interrupted', 'AbortError'));
  await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
  await iterator.return(undefined);
  await iterator.return(undefined);

  expect(() => admitDumpCompression('vndb', 'gzip')).toThrow(DumpInputError);
  expect(() => admitDumpCompression('bangumi', 'gzip')).toThrow(DumpInputError);
  expect(parseDumpCompression('gzip')).toBe('gzip');
  expect(() => parseDumpCompression('bzip2')).toThrow(DumpInputError);

  const directory = await mkdtemp(join(tmpdir(), 'gzip-changed-'));
  const handles = { value: 0 };
  try {
    const path = join(directory, 'ol.txt.gz');
    await writeFile(path, gzipSync(encode(ol(5, 'Original') + ol(6, 'Second'))));
    const handle = await openDump(path, handles);
    try {
      const chunks = fileChunks(handle!, new AbortController().signal);
      expect((await chunks.next()).done).toBe(false);
      await truncate(path, 4);
      await expect(
        (async () => {
          for await (const _chunk of chunks) {
            /* drain original inode or fail identity */
          }
        })(),
      ).rejects.toMatchObject({ identity: 'filesystem-changed' });
    } finally {
      await handle!.close();
      handles.value--;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  expect(handles.value).toBe(0);
});
