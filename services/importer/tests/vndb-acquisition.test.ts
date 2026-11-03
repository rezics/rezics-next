import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { runImportCli } from '../src/cli.ts';
import { Importer } from '../src/importer.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';
import {
  VNDB_ACQUISITION_FAILED,
  VNDB_ACQUISITION_OLD_UNSUPPORTED,
  VNDB_ZSTD_CODEC,
  captureVndbIdentity,
  evaluateVndbResume,
  vndbCodec,
} from '../src/vndb-acquisition.ts';
import { DEFAULT_VNDB_ARCHIVE_BYTES, DEFAULT_VNDB_ARCHIVE_ENTRIES, VndbTablesStore } from '../src/vndb-tables.ts';

const names = ['vn.header', 'vn', 'vn_titles.header', 'vn_titles', 'entry_meta.header', 'entry_meta'];
const encode = (value: string) => new TextEncoder().encode(value);
const text = (name: string) =>
  readFileSync(new URL(`../../../specs/fixtures/imports/vndb-tables/db/${name}`, import.meta.url), 'utf8');

function identityOf(bytes: Uint8Array, extra: Partial<Parameters<typeof captureVndbIdentity>[0]> = {}) {
  return captureVndbIdentity({
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
    codec: vndbCodec('none'),
    sourceAlias: 'vndb',
    converterRevision: createSourceRegistration('vndb').converter_revision,
    childCap: 8,
    maxRows: 2_000_000,
    maxSourceRecords: 500_000,
    maxArchiveBytes: DEFAULT_VNDB_ARCHIVE_BYTES,
    maxArchiveEntries: DEFAULT_VNDB_ARCHIVE_ENTRIES,
    decodeBudget: 0,
    ...extra,
  });
}

function entry(path: string, value: string | Uint8Array) {
  const bytes = typeof value === 'string' ? encode(value) : value;
  return {
    path,
    kind: 'file' as const,
    declaredBytes: bytes.length,
    get bytes() {
      return (async function* () {
        yield bytes;
      })();
    },
  };
}

function fixture(order = names) {
  return order.map((name) => entry(`db/${name}`, text(name)));
}

async function* stream(entries: ReturnType<typeof entry>[]) {
  for (const item of entries) yield item;
}

function archiveBytes(): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const name of names) {
    const body = readFileSync(new URL(`../../../specs/fixtures/imports/vndb-tables/db/${name}`, import.meta.url));
    const header = new Uint8Array(512);
    const put = (offset: number, value: string) => header.set(encoder.encode(value), offset);
    put(0, `db/${name}`);
    for (const offset of [100, 108, 116]) put(offset, '0000644\0');
    put(124, `${body.length.toString(8).padStart(11, '0')}\0`);
    put(136, '00000000000\0');
    put(148, '        ');
    put(156, '0');
    put(257, 'ustar\0');
    put(263, '00');
    put(148, `${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `);
    parts.push(header, body);
    if (body.length % 512) parts.push(new Uint8Array(512 - (body.length % 512)));
  }
  parts.push(new Uint8Array(1024));
  return Buffer.concat(parts);
}

function fake() {
  const requests: BatchWriteRequest[] = [];
  return {
    requests,
    transport: {
      setSourceRecordMetadata: sourceRecordMetadataFixture().setSourceRecordMetadata,
      async batchWrite(request: BatchWriteRequest): Promise<BatchWriteResult> {
        requests.push(structuredClone(request));
        return {
          results: request.commands.map((command) => ({
            key: command.key,
            status: 200 as const,
            value:
              command.op === 'create'
                ? { id: randomUUID(), revision: 1 }
                : command.op === 'propose'
                  ? { candidate: randomUUID(), revision: 1 }
                  : { revision: 1 },
          })),
        };
      },
      async readFence() {
        return { fenced: false, securityRevision: null };
      },
      async writeSourceStatistic() {},
      async clearSourceStatistic() {},
    },
  };
}

async function keyFile(directory: string) {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const path = join(directory, 'key.jwk');
  await writeFile(
    path,
    JSON.stringify({ ...pair.privateKey.export({ format: 'jwk' }), kid: randomUUID(), alg: 'ES256' }),
    { mode: 0o600 },
  );
  return path;
}

test('help names VNDB acquisition resume, and unsupported producers fail before network', async () => {
  const help = await runImportCli(['--help']);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain('--checkpoint-acquisition');
  expect(help.stdout).toContain('--resume-acquisition');
  expect(help.stdout).toContain('Table acquisition IDs are distinct');
  const directory = await mkdtemp(join(tmpdir(), 'vndb-acq-cli-'));
  const requests: string[] = [];
  try {
    const keyPath = await keyFile(directory);
    const blocked = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      throw new Error('checkpoint admission reached network');
    }) as unknown as typeof fetch;
    const credentials = [
      '--state',
      join(directory, 'missing.sqlite'),
      '--api',
      'https://api.test',
      '--auth',
      'https://auth.test',
      '--account-key',
      keyPath,
      '--account',
      randomUUID(),
      '--client',
      'local',
    ];
    await writeFile(join(directory, 'dump.bin'), 'not-an-archive');
    for (const extra of [
      ['--source', 'wikidata', '--dump', join(directory, 'dump.bin'), '--checkpoint-acquisition'],
      ['--source', 'vndb', '--dump', '-', '--checkpoint-acquisition'],
      ['--source', 'vndb', '--dump', join(directory, 'dump.bin'), '--compression', 'gzip', '--checkpoint-acquisition'],
    ]) {
      const result = await runImportCli([...extra, ...credentials], { fetch: blocked });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('Checkpointed VNDB table acquisition admits');
    }
    const missing = await runImportCli(
      [
        '--source',
        'vndb',
        '--dump',
        join(directory, 'dump.bin'),
        ...credentials,
        '--resume-acquisition',
        '--acquisition',
        randomUUID(),
      ],
      { fetch: blocked },
    );
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('No importer state database');
    expect(requests).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('evaluateResume distinguishes ready publish, old staging and identity mismatch', () => {
  const identity = identityOf(encode('archive'));
  const checkpoint = {
    version: 1 as const,
    identity,
    lastCompleteOrdinal: 2,
    currentOrdinal: 0,
    currentLines: 0,
    currentRole: '',
    spoolTable: '',
    spoolAfter: 0,
    phase: 'loading' as const,
    headers: {},
    archiveComplete: false,
  };
  expect(evaluateVndbResume(checkpoint, identity, { status: 'ready', materializedGeneration: null })).toEqual({
    ok: true,
    action: 'publish',
  });
  const old = evaluateVndbResume(null, identity, { status: 'staging', materializedGeneration: null });
  expect(old.ok).toBe(false);
  if (!old.ok) expect(old.message).toBe(VNDB_ACQUISITION_OLD_UNSUPPORTED);
  expect(
    evaluateVndbResume(checkpoint, identityOf(encode('changed')), { status: 'staging', materializedGeneration: null }).ok,
  ).toBe(false);
});

test('checkpointed table load resumes without duplicate durable rows, including data before headers', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vndb-acq-store-'));
  const db = new Database(join(directory, 'stage.sqlite'));
  let committed = 0;
  const store = new VndbTablesStore(db, {
    childRowsPerVn: 8,
    observer: {
      onBeforeCheckpoint() {
        if (committed === 4) throw new DOMException('stop', 'AbortError');
      },
    },
  });
  const identity = identityOf(encode('local'), { childCap: 8 });
  const reversed = fixture([...names].reverse());
  store.beginCheckpointed('vndb', 'run-a', identity);
  await expect(
    store.stage('vndb', 'run-a', stream(reversed), {
      identity,
      onCommitted() {
        committed++;
      },
    }),
  ).rejects.toBeInstanceOf(DOMException);
  expect(store.inspect('vndb', 'run-a').state).toBe('staging');
  expect(store.inspect('vndb', 'run-a').stagedRows).toBeGreaterThan(0);
  expect(store.checkpoint('vndb', 'run-a')).toBeTruthy();
  await new VndbTablesStore(db, { childRowsPerVn: 8 }).stage('vndb', 'run-a', stream(reversed), {
    identity,
    resume: true,
  });
  const ready = new VndbTablesStore(db, { childRowsPerVn: 8 });
  expect(ready.inspect('vndb', 'run-a')).toMatchObject({ state: 'ready', sourceRecords: 2, stagedRows: 7 });
  expect(ready.checkpoint('vndb', 'run-a')).toBeNull();
  expect(ready.page('vndb', 'run-a', { after: null, limit: 2 }).records.map((row) => row.key)).toEqual(['v123', 'v124']);
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

test('changed input, uncheckpointed failure and old staging do not resume', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vndb-acq-fail-'));
  const db = new Database(join(directory, 'stage.sqlite'));
  const store = new VndbTablesStore(db, { childRowsPerVn: 8 });
  store.begin('vndb', 'old');
  await expect(store.stage('vndb', 'old', stream([entry('db/vn', 'broken\n')]))).rejects.toThrow();
  expect(store.inspect('vndb', 'old').state).toBe('failed');
  expect(store.checkpoint('vndb', 'old')).toBeNull();
  const failed = evaluateVndbResume(null, identityOf(encode('x'), { childCap: 8 }), {
    status: 'failed',
    materializedGeneration: null,
  });
  expect(failed.ok).toBe(false);
  if (!failed.ok) expect(failed.message).toBe(VNDB_ACQUISITION_FAILED);
  const identity = identityOf(encode('archive'), { childCap: 8 });
  let writes = 0;
  const gated = new VndbTablesStore(db, {
    childRowsPerVn: 8,
    observer: {
      onBeforeCheckpoint() {
        if (++writes === 5) throw new DOMException('stop', 'AbortError');
      },
    },
  });
  gated.beginCheckpointed('vndb', 'run-b', identity);
  await expect(gated.stage('vndb', 'run-b', stream(fixture()), { identity })).rejects.toBeInstanceOf(DOMException);
  await expect(
    gated.stage('vndb', 'run-b', stream(fixture()), { identity: identityOf(encode('other'), { childCap: 8 }), resume: true }),
  ).rejects.toThrow();
  expect(gated.inspect('vndb', 'run-b').state).toBe('staging');
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

test('CLI checkpointed VNDB acquisition resumes the same ID without native work until tables are ready', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vndb-acq-run-'));
  const dump = join(directory, 'vndb.tar');
  await writeFile(dump, archiveBytes());
  const keyPath = await keyFile(directory);
  const f = fake();
  const credentials = [
    '--source',
    'vndb',
    '--dump',
    dump,
    '--state',
    join(directory, 'state.sqlite'),
    '--api',
    'https://api.test',
    '--auth',
    'https://auth.test',
    '--account-key',
    keyPath,
    '--account',
    randomUUID(),
    '--client',
    'local',
  ];
  const blocked = (async () => {
    throw new Error('network during table load');
  }) as unknown as typeof fetch;
  const controller = new AbortController();
  let rows = 0;
  const interrupted = await runImportCli([...credentials, '--checkpoint-acquisition'], {
    fetch: blocked,
    signal: controller.signal,
    instrumentDatabase(database) {
      const original = database.query.bind(database);
      database.query = ((sql: string) => {
        const statement = original(sql);
        if (sql.includes('INSERT INTO vndb_table_rows')) {
          const run = statement.run.bind(statement);
          statement.run = ((...args: unknown[]) => {
            const result = run(...(args as Parameters<typeof run>));
            if (++rows === 3) controller.abort(new DOMException('stop', 'AbortError'));
            return result;
          }) as typeof statement.run;
        }
        return statement;
      }) as typeof database.query;
      return database;
    },
  });
  expect(interrupted.code).toBe(130);
  expect(interrupted.stderr).toContain('--resume-acquisition');
  expect(f.requests).toHaveLength(0);
  const id = interrupted.stderr.match(/--acquisition ([0-9a-f-]{36})/i)?.[1];
  expect(id).toBeTruthy();
  const resumed = await runImportCli([...credentials, '--resume-acquisition', '--acquisition', id!], {
    fetch: blocked,
    createImporter: (options) => new Importer({ ...options, transport: f.transport }),
  });
  expect(resumed.code).toBe(0);
  expect(resumed.stdout).toContain('Import complete');
  expect(f.requests.length).toBeGreaterThan(0);
  await rm(directory, { recursive: true, force: true });
});

test('ready table acquisition publishes once and zstd archives are admitted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vndb-acq-zstd-'));
  const plain = archiveBytes();
  const child = Bun.spawn(['/usr/bin/zstd', '-c', '-q', '-'], { stdin: plain, stdout: 'pipe', stderr: 'pipe' });
  const compressed = await new Response(child.stdout).bytes();
  expect(await child.exited).toBe(0);
  const dump = join(directory, 'vndb.tar.zst');
  await writeFile(dump, compressed);
  const keyPath = await keyFile(directory);
  const f = fake();
  const credentials = [
    '--source',
    'vndb',
    '--dump',
    dump,
    '--compression',
    'zstd',
    '--state',
    join(directory, 'state.sqlite'),
    '--api',
    'https://api.test',
    '--auth',
    'https://auth.test',
    '--account-key',
    keyPath,
    '--account',
    randomUUID(),
    '--client',
    'local',
  ];
  const first = await runImportCli([...credentials, '--checkpoint-acquisition'], {
    fetch: (async () => {
      throw new Error('native transport must not run during table load');
    }) as unknown as typeof fetch,
    createImporter: (options) => new Importer({ ...options, transport: f.transport }),
  });
  expect(first.code).toBe(0);
  const native = f.requests.length;
  expect(native).toBeGreaterThan(0);
  const db = new Database(join(directory, 'state.sqlite'), { readonly: true });
  const row = db
    .query(`SELECT run_id, codec FROM vndb_acquisition_checkpoints WHERE source='vndb'`)
    .get() as { run_id: string; codec: string } | null;
  expect(row).toBeNull();
  const linked = db
    .query(`SELECT run_id FROM vndb_table_runs WHERE source='vndb' AND materialized_generation IS NOT NULL`)
    .get() as { run_id: string };
  db.close();
  const again = await runImportCli([...credentials, '--resume-acquisition', '--acquisition', linked.run_id], {
    fetch: (async () => {
      throw new Error('linked resume must not contact Auth');
    }) as unknown as typeof fetch,
    createImporter: (options) => new Importer({ ...options, transport: f.transport }),
  });
  expect(again.code).toBe(2);
  expect(again.stderr).toContain('already linked');
  expect(f.requests.length).toBe(native);
  expect(VNDB_ZSTD_CODEC).toContain('zstd');
  await rm(directory, { recursive: true, force: true });
});
