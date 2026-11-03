import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { admitDumpCompression, decodeDumpBytes, parseDumpCompression } from '../src/compressed-dump.ts';
import { DumpInputError, fileChunks, openDump, type DumpInputFailureIdentity } from '../src/dump-input.ts';
import { readDump } from '../src/dumps.ts';
import {
  createZstdDumpCounters,
  decodeZstdDumpChunks,
  probeZstdExecutable,
  resolveZstdExecutable,
  type ZstdSpawn,
} from '../src/zstd-input.ts';

const encode = (text: string) => new TextEncoder().encode(text);
const fixture = fileURLToPath(new URL('./zstd-child-fixture.ts', import.meta.url));
const wd = (key: number, title: string, revision = 7) =>
  JSON.stringify({
    type: 'item',
    id: `Q${key}`,
    lastrevid: revision,
    labels: { en: { language: 'en', value: title } },
  }) + '\n';

async function zstdCompress(bytes: Uint8Array, extra: string[] = []): Promise<Uint8Array> {
  const child = Bun.spawn(['/usr/bin/zstd', '-c', '-q', ...extra, '-'], {
    stdin: bytes,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = await new Response(child.stdout).bytes();
  const code = await child.exited;
  if (code !== 0) throw new Error(`zstd compress failed: ${code}`);
  return out;
}

function skippable(payload = encode('skip')): Uint8Array {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(0x184d2a50, 0);
  header.writeUInt32LE(payload.byteLength, 4);
  return Buffer.concat([header, payload]);
}

async function collected(input: AsyncIterable<Uint8Array>) {
  const records = [];
  for await (const record of readDump('wikidata', input)) records.push({ key: record.key, revision: record.revision });
  return records;
}

async function drain(input: AsyncIterable<Uint8Array>) {
  const parts: Uint8Array[] = [];
  for await (const chunk of input) parts.push(chunk);
  return Buffer.concat(parts);
}

async function failIdentity(bytes: Uint8Array, identity: DumpInputFailureIdentity) {
  try {
    await drain(
      decodeZstdDumpChunks(
        (async function* () {
          yield bytes;
        })(),
        { signal: new AbortController().signal, decodeBudget: 1_000_000 },
      ),
    );
    throw new Error(`expected ${identity}`);
  } catch (error) {
    expect(error).toBeInstanceOf(DumpInputError);
    expect((error as DumpInputError).identity).toBe(identity);
  }
}

function fixtureSpawn(mode: string): ZstdSpawn {
  return (executable, argv, options) => {
    if (argv.includes('-H')) return spawn(process.execPath, [fixture, 'help'], options);
    return spawn(process.execPath, [fixture, mode, ...argv], options);
  };
}

test('concatenated frames, empty last frame and skippable frames match plain Wikidata records', async () => {
  const plain = encode(wd(1, 'Lantern') + wd(2, 'Harbor'));
  const first = await zstdCompress(encode(wd(1, 'Lantern')));
  const second = await zstdCompress(encode(wd(2, 'Harbor')));
  const empty = await zstdCompress(new Uint8Array(0));
  const signal = new AbortController().signal;
  const concatenated = await collected(
    decodeZstdDumpChunks(
      (async function* () {
        yield Buffer.concat([first, second, empty]);
      })(),
      { signal, decodeBudget: 1_000_000 },
    ),
  );
  expect(concatenated).toEqual(
    await collected(
      (async function* () {
        yield plain;
      })(),
    ),
  );
  expect(concatenated).toEqual(
    await collected(
      decodeDumpBytes(
        (async function* () {
          yield await zstdCompress(plain);
        })(),
        { compression: 'zstd', signal, decodeBudget: 1_000_000 },
      ),
    ),
  );
  const withSkip = Buffer.concat([skippable(), first, skippable(), second]);
  expect(
    await collected(
      decodeZstdDumpChunks(
        (async function* () {
          yield withSkip;
        })(),
        { signal, decodeBudget: 1_000_000 },
      ),
    ),
  ).toEqual(concatenated);
  expect(parseDumpCompression('zstd')).toBe('zstd');
  expect(() => admitDumpCompression('openlibrary', 'zstd')).toThrow(DumpInputError);
  expect(() => admitDumpCompression('bangumi', 'zstd')).toThrow(DumpInputError);
  admitDumpCompression('vndb', 'zstd');
  admitDumpCompression('wikidata', 'zstd');
});

test('raw input, trailing garbage, truncated later frame, checksum failure and oversized window fail after any prefix', async () => {
  const valid = await zstdCompress(encode(wd(1, 'One')));
  const second = await zstdCompress(encode(wd(2, 'Two')));
  await failIdentity(encode('plain text named dump.zst'), 'zstd-integrity');
  await failIdentity(Buffer.concat([valid, encode('not-zstd')]), 'zstd-trailing-garbage');
  await failIdentity(valid.subarray(0, 8), 'zstd-truncated');
  await failIdentity(Buffer.concat([valid, second.subarray(0, 8)]), 'zstd-truncated');
  const bad = Buffer.from(valid);
  bad[bad.length - 1] ^= 0xff;
  await failIdentity(bad, 'zstd-integrity');
  const long = await zstdCompress(encode('x'.repeat(200)), ['--long=31', '-19']);
  await failIdentity(long, 'zstd-window');
  const early = decodeZstdDumpChunks(
    (async function* () {
      yield Buffer.concat([valid, encode('not-zstd')]);
    })(),
    { signal: new AbortController().signal, decodeBudget: 1_000_000 },
  );
  expect((await early.next()).done).toBe(false);
  await expect(early.return(undefined)).rejects.toMatchObject({ identity: 'zstd-trailing-garbage' });
});

test('decode budget, cancellation, missing executable and ignored SIGTERM reap the child', async () => {
  const compressible = encode(wd(8, 'a'.repeat(8000)));
  const compressed = await zstdCompress(compressible);
  try {
    await drain(
      decodeZstdDumpChunks(
        (async function* () {
          yield compressed;
        })(),
        { signal: new AbortController().signal, decodeBudget: 32 },
      ),
    );
    throw new Error('expected budget');
  } catch (error) {
    expect((error as DumpInputError).identity).toBe('decode-budget');
  }

  const slow = new AbortController();
  const counters = createZstdDumpCounters();
  const iterator = decodeZstdDumpChunks(
    (async function* () {
      yield compressed;
    })(),
    { signal: slow.signal, decodeBudget: 1_000_000, counters },
  );
  expect((await iterator.next()).done).toBe(false);
  slow.abort(new DOMException('Import interrupted', 'AbortError'));
  await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
  await iterator.return(undefined);

  await expect(resolveZstdExecutable('/tmp/missing-zstd-bin')).rejects.toMatchObject({
    identity: 'zstd-missing-executable',
  });
  await expect(probeZstdExecutable('/usr/bin/true')).rejects.toMatchObject({
    identity: 'zstd-incompatible-executable',
  });

  const hang = new AbortController();
  const pids: number[] = [];
  let spawnedHang: () => void = () => {};
  const spawned = new Promise<void>((resolve) => {
    spawnedHang = resolve;
  });
  const hangSpawn: ZstdSpawn = (executable, argv, options) => {
    const child = fixtureSpawn('hang-term')(executable, argv, options);
    if (!argv.includes('-H') && typeof child.pid === 'number') {
      pids.push(child.pid);
      spawnedHang();
    }
    return child;
  };
  const hung = decodeZstdDumpChunks(
    (async function* () {
      yield compressed;
    })(),
    {
      signal: hang.signal,
      decodeBudget: 1_000_000,
      executable: process.execPath,
      spawn: hangSpawn,
      probe: true,
      terminationGraceMs: 50,
    },
  );
  const pending = hung.next();
  await spawned;
  hang.abort(new DOMException('Import interrupted', 'AbortError'));
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await hung.return(undefined);
  for (const pid of pids) {
    expect(() => process.kill(pid, 0)).toThrow();
  }
});

test('nonzero child exit after decoded bytes, stderr flood and replaced file fail without a completed stream', async () => {
  const plain = encode(wd(3, 'Late'));
  const compressed = await zstdCompress(plain);
  try {
    await drain(
      decodeZstdDumpChunks(
        (async function* () {
          yield compressed;
        })(),
        {
          signal: new AbortController().signal,
          decodeBudget: 1_000_000,
          executable: process.execPath,
          spawn: fixtureSpawn('copy-then-fail'),
          probe: true,
        },
      ),
    );
    throw new Error('expected child failure');
  } catch (error) {
    expect(error).toBeInstanceOf(DumpInputError);
    expect((error as DumpInputError).identity).toBe('zstd-integrity');
  }

  const flooded = await drain(
    decodeZstdDumpChunks(
      (async function* () {
        yield compressed;
      })(),
      {
        signal: new AbortController().signal,
        decodeBudget: 1_000_000,
        executable: process.execPath,
        spawn: fixtureSpawn('flood-stderr'),
        probe: true,
        stderrBudget: 256,
      },
    ),
  );
  expect(Buffer.from(flooded).equals(compressed) || Buffer.from(flooded).equals(plain)).toBe(true);

  const directory = await mkdtemp(join(tmpdir(), 'zstd-changed-'));
  const handles = { value: 0 };
  try {
    const path = join(directory, 'wd.json.zst');
    await writeFile(path, compressed);
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
