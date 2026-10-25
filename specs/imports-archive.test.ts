import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { VndbTablesStore } from '../services/importer/src/vndb-tables.ts';
import { loadArchiveDriver, type ArchiveDriver, type ArchiveOptions } from './imports-archive-driver.ts';
import type { Entry } from './imports-vndb-tables-driver.ts';

// Independent synthetic POSIX ustar writer, NOT a parser or product substitute.
// Layout: name[100], mode[8], uid/gid[8], size[12], mtime[12], checksum[8],
// type[1], link[100], magic[6], version[2], uname/gname[32], dev[8+8], prefix[155].
const enc = new TextEncoder();
const text = (value: string) => enc.encode(value);
const names = ['vn.header', 'vn', 'vn_titles.header', 'vn_titles', 'entry_meta.header', 'entry_meta'];
const limits = { maxTotalBytes: 2 ** 20, maxChunkBytes: 4096, maxMetadataBytes: 1024 };
function join(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
function checksum(h: Uint8Array) {
  h.fill(32, 148, 156);
  const sum = h.reduce((n, byte) => n + byte, 0);
  h.set(text(`${sum.toString(8).padStart(6, '0')}\0 `), 148);
  return h;
}
function header(path: string, size: number, type = '0', prefix = '') {
  const h = new Uint8Array(512);
  h.set(text(path), 0);
  h.set(text('0000644\0'), 100);
  h.set(text('0000000\0'), 108);
  h.set(text('0000000\0'), 116);
  h.set(text(`${size.toString(8).padStart(11, '0')}\0`), 124);
  h.set(text('00000000000\0'), 136);
  h[156] = type.charCodeAt(0);
  h.set(text('ustar\0' + '00'), 257);
  h.set(text(prefix), 345);
  return checksum(h);
}
function member(path: string, payload: Uint8Array = new Uint8Array(0), type = '0', prefix = '') {
  return join([
    header(path, payload.length, type, prefix),
    payload,
    new Uint8Array((512 - (payload.length % 512)) % 512),
  ]);
}
const tar = (...members: Uint8Array[]) => join([...members, new Uint8Array(1024)]);
const fixtures = () =>
  names.map((name) => ({
    path: `db/${name}`,
    payload: new Uint8Array(readFileSync(new URL(`./fixtures/imports/vndb-tables/db/${name}`, import.meta.url))),
  }));
const valid = () => tar(...fixtures().map((f) => member(f.path, f.payload)));

/** Input instrumentation counts actual pulls/bytes, not declared header sizes. */
function source(bytes: Uint8Array, chunk = 257, failAt = Infinity) {
  let offset = 0;
  let reads = 0;
  let closed = false;
  const error = new Error('upstream archive failure');
  const input: AsyncIterableIterator<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      reads++;
      if (offset >= failAt) throw error;
      if (offset === bytes.length) {
        closed = true;
        return { done: true, value: undefined };
      }
      const value = bytes.slice(offset, Math.min(bytes.length, offset + chunk));
      offset += value.length;
      return { done: false, value };
    },
    async return() {
      closed = true;
      return { done: true, value: undefined };
    },
  };
  return {
    input,
    error,
    get bytes() {
      return offset;
    },
    get reads() {
      return reads;
    },
    get closed() {
      return closed;
    },
  };
}
function open(d: ArchiveDriver, bytes: Uint8Array, chunk = 257, override: Partial<ArchiveOptions> = {}) {
  const s = source(bytes, chunk);
  let peak = 0;
  let visited = 0;
  let samples = 0;
  const entries = d.read(s.input, {
    ...limits,
    ...override,
    onProgress(sample) {
      expect(Number.isSafeInteger(sample.retainedBytes) && sample.retainedBytes >= 0).toBe(true);
      expect(sample.visitedBytes).toBeGreaterThanOrEqual(visited);
      peak = Math.max(peak, sample.retainedBytes);
      visited = sample.visitedBytes;
      samples++;
    },
  });
  return {
    s,
    entries,
    get peak() {
      return peak;
    },
    get visited() {
      return visited;
    },
    get samples() {
      return samples;
    },
  };
}
async function consume(entries: AsyncIterable<Entry>) {
  const files: Array<{ path: string; kind: string; declaredBytes: number; payload: Uint8Array }> = [];
  for await (const entry of entries) {
    const parts: Uint8Array[] = [];
    for await (const chunk of entry.bytes) {
      expect(chunk).toBeInstanceOf(Uint8Array);
      parts.push(chunk.slice()); // Test-only capture of SMALL fixtures, never scale inputs.
    }
    files.push({ path: entry.path, kind: entry.kind, declaredBytes: entry.declaredBytes, payload: join(parts) });
  }
  return files;
}
async function rejects(d: ArchiveDriver, bytes: Uint8Array, options: Partial<ArchiveOptions> = {}) {
  const probe = open(d, bytes, 257, options);
  await expect(consume(probe.entries)).rejects.toThrow();
  expect(probe.s.closed).toBe(true);
}
async function staging(entries: AsyncIterable<Entry>, succeeds: boolean) {
  const db = new Database(':memory:');
  try {
    const store = new VndbTablesStore(db);
    store.begin('vndb', 'archive');
    if (succeeds) {
      await store.stage('vndb', 'archive', entries);
      expect(store.inspect('vndb', 'archive').state).toBe('ready');
      expect(store.page('vndb', 'archive', { after: null, limit: 16 }).records).toHaveLength(2);
    } else {
      await expect(store.stage('vndb', 'archive', entries)).rejects.toThrow();
      expect(store.inspect('vndb', 'archive')).toMatchObject({ state: 'failed', sourceRecords: 0, stagedRows: 0 });
      expect(() => store.page('vndb', 'archive', { after: null, limit: 16 })).toThrow();
      expect(db.query('SELECT * FROM vndb_table_rows').all()).toHaveLength(0);
      expect(db.query('SELECT * FROM vndb_table_spool').all()).toHaveLength(0);
    }
  } finally {
    db.close();
  }
}

test('ustar six public table and header entries preserve exact raw bytes and reach the existing loader', async () => {
  const d = await loadArchiveDriver();
  const files = fixtures();
  const result = await consume(open(d, valid()).entries);
  expect(result).toEqual(
    files.map((f) => ({ path: f.path, kind: 'file', declaredBytes: f.payload.length, payload: f.payload })),
  );
  await staging(open(d, valid()).entries, true);
});

test('one-byte chunks cross every header payload padding and terminator boundary', async () => {
  const d = await loadArchiveDriver();
  const bytes = Uint8Array.from({ length: 513 }, (_, i) => i % 256);
  const archive = tar(member('db/opaque', bytes), member('db/empty'));
  const result = await consume(open(d, archive, 1).entries);
  expect(result.map((f) => f.declaredBytes)).toEqual([513, 0]);
  expect(result[0]!.payload).toEqual(bytes);
  expect(result[1]!.payload).toHaveLength(0);
});

test('ustar prefix UTF8 names and NUL regular typeflag are interpreted without rewriting paths', async () => {
  const d = await loadArchiveDriver();
  const result = await consume(open(d, tar(member('未知', text('opaque'), '\0', 'db'))).entries);
  expect(result).toEqual([{ path: 'db/未知', kind: 'file', declaredBytes: 6, payload: text('opaque') }]);
});

test('directories and unknown private bytes are drained without COPY SQL or record materialization', async () => {
  const d = await loadArchiveDriver();
  const marker = text('PRIVATE-ARCHIVE-MARKER\0\xff\nDROP TABLE vndb_table_rows;\n');
  const archive = tar(
    member('db/', undefined, '5'),
    member('db/private', marker),
    ...fixtures().map((f) => member(f.path, f.payload)),
  );
  const observed = await d.observe(async () => staging(open(d, archive, 1).entries, true));
  // Positive control: the same observer must see real loader SQL, not static zeros.
  expect(observed.io.sqlite).toBeGreaterThan(0);
  expect(observed.io).toMatchObject({ partitions: 0, network: 0, filesystem: 0, subprocess: 0, logs: 0 });
  // Existing store owns discard policy: unknown entries must reach it as raw streams.
  const files = await consume(open(d, archive).entries);
  expect(files.find((f) => f.path === 'db/private')!.payload).toEqual(marker);
});

test('absolute traversal backslash drive and percent-encoded unsafe paths are rejected', async () => {
  const d = await loadArchiveDriver();
  for (const path of [
    '/db/vn',
    '../db/vn',
    'db/../vn',
    'db/./vn',
    'db//vn',
    'db\\vn',
    'C:/db/vn',
    'db/%2e%2e/vn',
    'db/%00vn',
  ])
    await rejects(d, tar(member(path)));
  await rejects(d, tar(member('vn', undefined, '0', '../db')));
});

test('NUL path suffixes invalid UTF8 and unsafe control encoding are rejected', async () => {
  const d = await loadArchiveDriver();
  for (const path of ['db/vn\0suffix', 'db/\nvn', 'db/\u007fvn']) await rejects(d, tar(member(path)));
  for (const bytes of [[0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xff]]) {
    const h = header('db/', 0);
    h.set(bytes, 3);
    await rejects(d, tar(checksum(h)));
  }
});

test('symlink and hardlink headers targeting or naming supported tables fail before yielding entries', async () => {
  const d = await loadArchiveDriver();
  for (const type of ['1', '2'])
    for (const path of ['db/vn', 'db/alias']) {
      const h = header(path, 0, type);
      h.set(text('db/vn'), 157);
      const iterator = open(d, tar(checksum(h))).entries[Symbol.asyncIterator]();
      await expect(iterator.next()).rejects.toThrow();
    }
});

test('device FIFO and unknown special types are rejected before materialization', async () => {
  const d = await loadArchiveDriver();
  for (const type of ['3', '4', '6', '7', 'S', '?']) {
    const iterator = open(d, tar(member('db/vn', undefined, type))).entries[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow();
  }
});

test('PAX global local and GNU longname longlink extensions are explicitly rejected', async () => {
  const d = await loadArchiveDriver();
  for (const type of ['x', 'g', 'L', 'K']) {
    const iterator = open(d, tar(member('extended', text('20 path=db/vn\n'), type), member('db/vn'))).entries[
      Symbol.asyncIterator
    ]();
    await expect(iterator.next()).rejects.toThrow(/unsupported|extension|PAX|GNU/i);
  }
});

test('invalid header checksum and non-ustar magic never yield an entry', async () => {
  const d = await loadArchiveDriver();
  const badSum = header('db/vn', 0);
  badSum[0] = 88;
  const badMagic = header('db/vn', 0);
  badMagic[257] = 88;
  for (const h of [badSum, checksum(badMagic)]) {
    await expect(open(d, tar(h)).entries[Symbol.asyncIterator]().next()).rejects.toThrow();
  }
});

test('negative nonnumeric overflow and binary size fields cannot bypass total byte limits', async () => {
  const d = await loadArchiveDriver();
  for (const field of ['-0000000001\0', '00000000008\0', '77777777777\0']) {
    const h = header('db/vn', 0);
    h.set(text(field), 124);
    await rejects(d, tar(checksum(h)));
  }
  const binary = header('db/vn', 0);
  binary.fill(255, 124, 136);
  await rejects(d, tar(checksum(binary)));
  await rejects(d, tar(member('db/vn', new Uint8Array(2048))), { maxTotalBytes: 1024 });
});

test('aggregate supplied byte and path metadata caps reject before unbounded retention', async () => {
  const d = await loadArchiveDriver();
  const archive = tar(...Array.from({ length: 8 }, (_, i) => member(`db/part${i}`, new Uint8Array(1024))));
  await rejects(d, archive, { maxTotalBytes: 4096 });
  await rejects(d, tar(member('db/' + 'n'.repeat(90))), { maxMetadataBytes: 32 });
});

test('truncated header data padding and each missing terminator block reject', async () => {
  const d = await loadArchiveDriver();
  const archive = tar(member('db/opaque', new Uint8Array(513)));
  for (const length of [0, 1, 511, 512, 1024, 1025, 1535, 1536, 2048, archive.length - 1])
    await rejects(d, archive.slice(0, length));
});

test('nonzero trailing bytes and a lone zero block followed by a member reject', async () => {
  const d = await loadArchiveDriver();
  await rejects(d, join([valid(), text('x')]));
  await rejects(d, join([member('db/empty'), new Uint8Array(512), member('db/other'), new Uint8Array(1024)]));
  expect(await consume(open(d, join([tar(member('db/empty')), new Uint8Array(1024)])).entries)).toHaveLength(1);
});

test('advancing drains unread prior entry and cancelling a payload preserves the next header', async () => {
  const d = await loadArchiveDriver();
  for (const cancelPayload of [false, true]) {
    const probe = open(d, tar(member('db/first', new Uint8Array(8192)), member('db/next', text('next'))), 512);
    const iterator = probe.entries[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value.path).toBe('db/first');
    if (cancelPayload) {
      const payload = first.value.bytes[Symbol.asyncIterator]();
      expect((await payload.next()).done).toBe(false);
      await payload.return?.();
    }
    const next = await iterator.next();
    expect(next.value.path).toBe('db/next');
    expect(join((await Array.fromAsync(next.value.bytes)) as Uint8Array[])).toEqual(text('next'));
    expect((await iterator.next()).done).toBe(true);
  }
});

test('backpressure after first entry bounds pulls and early outer return closes input promptly', async () => {
  const d = await loadArchiveDriver();
  const archive = tar(member('db/first', new Uint8Array(32768)), member('db/second', new Uint8Array(32768)));
  const probe = open(d, archive, 512);
  const iterator = probe.entries[Symbol.asyncIterator]();
  expect((await iterator.next()).done).toBe(false);
  const reads = probe.s.reads;
  await Promise.resolve();
  await Promise.resolve();
  expect(probe.s.reads).toBe(reads);
  expect(probe.s.bytes).toBeLessThanOrEqual(1024);
  await iterator.return?.();
  expect(probe.s.closed).toBe(true);
  expect(probe.s.bytes).toBeLessThan(archive.length);
});

test('upstream error propagates by identity and invalidates all staged rows', async () => {
  const d = await loadArchiveDriver();
  const bytes = valid();
  const failAt = bytes.length - 1024;
  const a = source(bytes, 512, failAt);
  await expect(consume(d.read(a.input, { ...limits, onProgress() {} }))).rejects.toBe(a.error);
  const b = source(bytes, 512, failAt);
  await staging(d.read(b.input, { ...limits, onProgress() {} }), false);
});

test('invalid trailing framing after all supported tables invalidates full staging', async () => {
  const d = await loadArchiveDriver();
  await staging(open(d, join([valid(), text('corrupt')])).entries, false);
});

test('abort before and during staging never publishes partial ready state', async () => {
  const d = await loadArchiveDriver();
  const before = new AbortController();
  before.abort();
  await rejects(d, valid(), { signal: before.signal });
  const controller = new AbortController();
  const s = source(valid(), 512);
  const entries = d.read(s.input, { ...limits, signal: controller.signal, onProgress() {} });
  async function* abortAfterFirst() {
    for await (const entry of entries) {
      yield entry;
      controller.abort();
    }
  }
  await staging(abortAfterFirst(), false);
  expect(s.closed).toBe(true);
});

test('abort interrupts a pending input read and closes its iterator without waiting for input', async () => {
  const d = await loadArchiveDriver();
  const controller = new AbortController();
  let closed = false;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  const input: AsyncIterableIterator<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      started();
      return new Promise(() => {});
    },
    async return() {
      closed = true;
      return { done: true, value: undefined };
    },
  };
  const iterator = d.read(input, { ...limits, signal: controller.signal, onProgress() {} })[Symbol.asyncIterator]();
  const next = iterator.next();
  await pending;
  controller.abort();
  await expect(next).rejects.toThrow();
  expect(closed).toBe(true);
});

test('large chunks use bounded backing allocations and abusive chunk backing stores reject', async () => {
  const d = await loadArchiveDriver();
  const bytes = tar(member('db/opaque', new Uint8Array(16384)));
  const probe = open(d, bytes, 4096);
  await consume(probe.entries);
  expect(probe.peak).toBeGreaterThanOrEqual(4096);
  expect(probe.peak).toBeLessThanOrEqual(4096 + 512 + limits.maxMetadataBytes);
  await expect(
    consume(
      d.read(
        (async function* () {
          yield bytes;
        })(),
        {
          ...limits,
          onProgress() {},
        },
      ),
    ),
  ).rejects.toThrow();
  // A tiny view cannot hide an abusive retained backing allocation.
  await expect(
    consume(
      d.read(
        (async function* () {
          yield bytes.subarray(0, 512);
        })(),
        {
          ...limits,
          onProgress() {},
        },
      ),
    ),
  ).rejects.toThrow();
});

test('one seeded payload at three scales proves linear actual input work constant retention and zero IO', async () => {
  const d = await loadArchiveDriver();
  const seed = Uint8Array.from({ length: 512 }, (_, i) => (i * 17 + 13) % 256);
  const peaks: number[] = [];
  for (const blocks of [1, 8, 64]) {
    // Fixture memory is outside reader measurement. Fresh bounded input chunks
    // ensure backing-store accounting does not charge a whole test archive.
    const archive = tar(member('db/opaque', join(Array.from({ length: blocks }, () => seed))), member('db/empty'));
    let bytes = 0;
    let reads = 0;
    let closed = false;
    const input = (async function* () {
      try {
        for (let i = 0; i < archive.length; i += 512) {
          reads++;
          const chunk = archive.slice(i, i + 512);
          bytes += chunk.length;
          yield chunk;
        }
      } finally {
        closed = true;
      }
    })();
    let peak = 0;
    let visited = 0;
    let samples = 0;
    let records = 0;
    let payloadBytes = 0;
    const result = await d.observe(async () => {
      for await (const entry of d.read(input, {
        ...limits,
        onProgress(s) {
          peak = Math.max(peak, s.retainedBytes);
          visited = s.visitedBytes;
          samples++;
        },
      })) {
        records++;
        expect(entry.declaredBytes).toBe(records === 1 ? blocks * 512 : 0);
        if (records === 1) {
          const pulled = reads;
          await Promise.resolve();
          await Promise.resolve();
          expect(reads).toBe(pulled);
          expect(bytes).toBeLessThanOrEqual(1024);
        }
        for await (const chunk of entry.bytes) {
          expect(chunk.length).toBeLessThanOrEqual(512);
          for (const byte of chunk) expect(byte).toBe(seed[payloadBytes++ % 512]!);
        }
      }
    });
    expect(result.io).toEqual({ sqlite: 0, partitions: 0, network: 0, filesystem: 0, subprocess: 0, logs: 0 });
    expect(records).toBe(2);
    expect(payloadBytes).toBe(blocks * 512);
    expect(bytes).toBe(archive.length);
    expect(reads).toBe(archive.length / 512);
    expect(closed).toBe(true);
    expect(samples).toBeGreaterThan(0);
    expect(visited).toBeGreaterThanOrEqual(bytes);
    expect(visited).toBeLessThanOrEqual(8 * bytes);
    expect(peak).toBeGreaterThanOrEqual(512);
    expect(peak).toBeLessThanOrEqual(512 + 512 + limits.maxMetadataBytes);
    peaks.push(peak);
    const cancelled = open(d, archive, 512);
    const iterator = cancelled.entries[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    expect(cancelled.s.bytes).toBeLessThanOrEqual(1024);
    await iterator.return?.();
    expect(cancelled.s.closed).toBe(true);
    expect(cancelled.s.bytes).toBeLessThan(archive.length);
  }
  expect(Math.max(...peaks) - Math.min(...peaks)).toBeLessThanOrEqual(512);
});
