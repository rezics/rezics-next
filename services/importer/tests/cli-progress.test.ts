import { expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import type { Invocation } from '../../../specs/imports-cli-driver.ts';
import { Importer } from '../src/importer.ts';
import type { ImportProgressObserver, ImportProgressPhase } from '../src/import-contract.ts';
import type { ImportProgressSink } from '../src/import-progress.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import { VndbMaterialization } from '../src/vndb-materialization.ts';
import { createImportCliDriver } from './cli-driver.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';

const fixtureRoot = new URL('../../../specs/fixtures/imports/', import.meta.url);
const launchDumps = [
  ['bangumi', 'dumps/bangumi-subject.jsonlines'],
  ['openlibrary', 'api/openlibrary.tsv'],
  ['wikidata', 'dumps/wikidata.json'],
] as const;

function counters() {
  const phases: ImportProgressPhase[] = [];
  let staged = 0;
  let acknowledged = 0;
  let classified = 0;
  let sourceComplete = false;
  const progress: ImportProgressObserver = {
    onPhase(phase) {
      phases.push(phase);
    },
    onStaged: (count) => (staged += count),
    onAcknowledgedEffects: (count) => (acknowledged += count),
    onClassified: () => classified++,
    onSourceCompleted: () => (sourceComplete = true),
  };
  return {
    phases,
    progress,
    get staged() {
      return staged;
    },
    get acknowledged() {
      return acknowledged;
    },
    get classified() {
      return classified;
    },
    get sourceComplete() {
      return sourceComplete;
    },
  };
}

function transport() {
  const metadata = sourceRecordMetadataFixture();
  let next = 0;
  const id = () => `00000000-0000-4000-8000-${(++next).toString(16).padStart(12, '0')}`;
  return {
    setSourceRecordMetadata: metadata.setSourceRecordMetadata,
    async readFence() { return { fenced: false, securityRevision: null }; },
    async batchWrite(request: ImportBatchRequest) {
      const results: BatchWriteResult['results'] = request.commands.map((command) => ({
        key: command.key,
        status: command.op === 'retract' ? 200 : 201,
        value: command.op === 'create' ? { id: id(), revision: 1 } : command.op === 'propose' ? { candidate: id(), revision: 1 } : { revision: 1 },
      }));
      return { results };
    },
    async writeSourceStatistic() {},
    async clearSourceStatistic() {},
  };
}

type ImportBatchRequest = BatchWriteRequest;

function importer(): Importer {
  return new Importer({
    path: ':memory:',
    transport: transport(),
    sleep: async () => {},
    mediaResolver: { async resolve() { return { status: 'rejected' }; } },
  });
}

async function* oneChunk(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

async function* emptyDump(): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode('[]');
}

test('CLI JSONL progress uses its sink and leaves the final summary on stdout', async () => {
  const temporaryRoot = resolve(import.meta.dir, '../../../.temp');
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, 'import-progress-cli-'));
  const state = join(directory, 'state.sqlite');
  const keyPath = join(directory, 'account-key');
  const origin = 'http://127.0.0.1:43179';
  const frames: string[] = [];
  const sink: ImportProgressSink = {
    write(frame) {
      frames.push(frame);
    },
  };
  let driver: Awaited<ReturnType<typeof createImportCliDriver>> | undefined;
  try {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    await writeFile(
      keyPath,
      JSON.stringify({
        ...pair.privateKey.export({ format: 'jwk' }),
        kid: 'progress-test',
        alg: 'ES256',
        key_ops: ['sign'],
      }),
      { mode: 0o600 },
    );
    await chmod(keyPath, 0o600);
    driver = await createImportCliDriver({
      directory,
      fetch: async () => new Response('', { status: 404 }),
      clock: { now: () => 1000, sleep: async () => {} },
    });
    const result = await driver.invoke(
      [
        '--source', 'wikidata', '--dump', '-', '--state', state, '--api', origin, '--account-key', keyPath,
        '--account', '6b147e8d-1762-4717-9a65-aeb435cb843e', '--client', 'progress-test', '--auth', 'https://auth.importer.test',
        '--progress', 'jsonl',
      ],
      { testOrigin: origin, stdin: emptyDump(), progressSink: sink } as Invocation & {
        progressSink: ImportProgressSink;
      },
    );
    const events = frames.map((frame) => JSON.parse(frame) as { sequence: number; phase: string; terminal: boolean; sourceComplete: boolean; counts: { inputBytes: number } });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Import complete:');
    expect(result.stdout).not.toContain('"version":1');
    expect(result.stderr).toBe('');
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events.map((event) => event.phase)).toContain('committed');
    expect(events.at(-1)).toMatchObject({ terminal: true, sourceComplete: true, counts: { inputBytes: 2 } });
  } finally {
    try {
      await driver?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('launch dump decoders report committed staging and acknowledgement transitions', async () => {
  for (const [source, path] of launchDumps) {
    const subject = importer();
    const progress = counters();
    try {
      const result = await subject.runDump(
        createSourceRegistration(source),
        oneChunk(new Uint8Array(await readFile(new URL(path, fixtureRoot)))),
        { progress: progress.progress },
      );
      expect(result.status, `${source}: ${result.diagnostic}`).toBe('committed');
      expect(progress.staged).toBeGreaterThan(0);
      expect(progress.sourceComplete).toBe(true);
      expect(progress.phases).toContain('staging');
      expect(progress.phases).toContain('reconciling');
      expect(progress.classified).toBeGreaterThan(0);
      expect(progress.acknowledged).toBeGreaterThan(0);
    } finally {
      await subject.close();
    }
  }
});

function octal(value: number, width: number): Uint8Array {
  return new TextEncoder().encode(`${value.toString(8).padStart(width - 1, '0')}\0`);
}

function tar(files: readonly { path: string; bytes: Uint8Array }[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const file of files) {
    const header = new Uint8Array(512);
    header.set(encoder.encode(file.path), 0);
    header.set(octal(0o644, 8), 100);
    header.set(octal(0, 8), 108);
    header.set(octal(0, 8), 116);
    header.set(octal(file.bytes.length, 12), 124);
    header.set(octal(0, 12), 136);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.set(encoder.encode('ustar\0'), 257);
    header.set(encoder.encode('00'), 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.set(encoder.encode(`${checksum.toString(8).padStart(6, '0')}\0 `), 148);
    parts.push(header);
    const padded = new Uint8Array(Math.ceil(file.bytes.length / 512) * 512);
    padded.set(file.bytes);
    parts.push(padded);
  }
  parts.push(new Uint8Array(1024));
  const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

async function* boundedChunks(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += 512)
    yield new Uint8Array(bytes.subarray(offset, offset + 512));
}

test('bounded VNDB archive materialization reports source pages and run-store staging', async () => {
  const names = ['vn.header', 'vn', 'vn_titles.header', 'vn_titles', 'entry_meta.header', 'entry_meta'];
  const files = await Promise.all(names.map(async (name) => ({
    path: `db/${name}`,
    bytes: new Uint8Array(await readFile(new URL(`vndb-tables/db/${name}`, fixtureRoot))),
  })));
  const importerUnderTest = importer();
  const progress = counters();
  try {
    const materialization = new VndbMaterialization(importerUnderTest, createSourceRegistration('vndb'), { pageSize: 2 });
    const acquisition = materialization.begin();
    await materialization.stageArchive(acquisition, boundedChunks(tar(files)));
    let materialized = 0;
    const result = await materialization.commit(acquisition, {
      progress: progress.progress,
      onPageRecords: (count) => (materialized += count),
    });
    expect(result.status).toBe('committed');
    expect(materialized).toBeGreaterThan(0);
    expect(progress.staged).toBe(materialized);
    expect(progress.sourceComplete).toBe(true);
    expect(progress.phases).toContain('staging');
    expect(progress.acknowledged).toBeGreaterThan(0);
  } finally {
    await importerUnderTest.close();
  }
});
