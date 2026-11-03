import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runImportCli } from '../src/cli.ts';
import { RunStore, type SourceProjection } from '../src/run-store.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import { Importer } from '../src/importer.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';

const source = 'openlibrary';
const digest = (n: number) => n.toString(16).padStart(64, '0');

function edition(n: number, date = 'circa 1980') {
  return {
    type: { key: '/type/edition' },
    key: `/books/OL${(900000000 + n).toString()}M`,
    revision: 1,
    last_modified: { type: '/type/datetime', value: '2025-01-01T00:00:00.000000' },
    title: `Atlas ${n}`,
    isbn_13: ['9780306406157'],
    publish_date: date,
  };
}

function dump(records: ReturnType<typeof edition>[]) {
  return (
    records
      .map((record) => [record.type.key, record.key, record.revision, record.last_modified.value, JSON.stringify(record)].join('\t'))
      .join('\n') + '\n'
  );
}

function transport() {
  return {
    async batchWrite(request: BatchWriteRequest): Promise<BatchWriteResult> {
      return {
        results: request.commands.map((command, index) =>
          command.op === 'create'
            ? {
                key: command.key,
                status: 201 as const,
                value: { id: `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`, revision: 1 },
              }
            : { key: command.key, status: 200 as const, value: { candidate: `00000000-0000-4000-8000-${(index + 11).toString(16).padStart(12, '0')}`, revision: 1 } },
        ),
      };
    },
    async readFence() {
      return { fenced: false, securityRevision: null };
    },
    setSourceRecordMetadata: sourceRecordMetadataFixture().setSourceRecordMetadata,
  };
}

function seed(path: string, count: number, extra?: { code?: string }) {
  const store = new RunStore<SourceProjection>(path, { projectionMode: 'source-record' });
  try {
    const run = store.begin(source);
    if (run === 'busy') throw new Error('busy');
    for (let i = 1; i <= count; i++) {
      const key = `/books/OL${(900000000 + i).toString()}M`;
      store.stage(run, {
        row: {
          source,
          recordKey: key,
          recordRevision: '1',
          digest: digest(i),
          converter_revision: 'open-library@3',
          state: 'present',
        },
        projection: { sourceKind: 'openlibrary', normalizedRecord: { key } },
      });
      store.retainConversionDiagnostics(run, {
        recordKey: key,
        digest: digest(i),
        converterRevision: 'open-library@3',
        recordRevision: '1',
        phase: 'staging',
        diagnostics: [{ pointer: '/publish_date', code: extra?.code ?? 'unsupported_publication_date_format' }],
      });
    }
    expect(store.seal(run, { complete: true }).status).toBe('ready');
    return run.id;
  } finally {
    store.close();
  }
}

test('diagnostics help and missing files never create a database or touch the network', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'diag-cli-'));
  try {
    const missing = join(directory, 'missing.sqlite');
    const link = join(directory, 'state.link');
    const target = join(directory, 'state.sqlite');
    await writeFile(target, '');
    await symlink(target, link);
    let requests = 0;
    const help = await runImportCli(['diagnostics', '--help'], {
      fetch: (async () => {
        requests++;
        throw new Error('network');
      }) as unknown as typeof fetch,
    });
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('--state');
    expect(help.openHandles).toBe(0);
    const absent = await runImportCli(['diagnostics', '--source', source, '--state', missing]);
    expect(absent.code).toBe(2);
    expect(absent.openHandles).toBe(0);
    expect(
      await Bun.file(missing)
        .exists()
        .catch(() => false),
    ).toBe(false);
    const linked = await runImportCli(['diagnostics', '--source', source, '--state', link]);
    expect(linked.code).toBe(2);
    expect(linked.openHandles).toBe(0);
    expect(requests).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('pages diagnostic-bearing records, exact lookup, JSON version and hostile cursor without credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'diag-page-'));
  const state = join(directory, 'state.sqlite');
  try {
    seed(state, 21);
    const first = await runImportCli(['diagnostics', '--source', source, '--state', state, '--format', 'json']);
    expect(first.code).toBe(0);
    expect(first.openHandles).toBe(0);
    const page = JSON.parse(first.stdout) as {
      version: number;
      coverage: string;
      diagnosticRecords: number;
      records: { recordKey: string; diagnostics: { pointer: string; code: string }[] }[];
      nextCursor: string;
      resume: string;
    };
    expect(page.version).toBe(1);
    expect(page.coverage).toBe('recorded');
    expect(page.diagnosticRecords).toBe(21);
    expect(page.records).toHaveLength(20);
    expect(page.records[0]!.diagnostics).toContainEqual({
      pointer: '/publish_date',
      code: 'unsupported_publication_date_format',
    });
    expect(page.nextCursor).toBeString();
    expect(page.resume).toContain('<dump-path>');
    expect(page.resume).not.toContain('circa');
    const next = await runImportCli([
      'diagnostics',
      '--source',
      source,
      '--state',
      state,
      '--cursor',
      page.nextCursor,
      '--format',
      'json',
    ]);
    expect(next.code).toBe(0);
    const second = JSON.parse(next.stdout) as { records: unknown[]; nextCursor: string | null };
    expect(second.records).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const detail = await runImportCli([
      'diagnostics',
      '--source',
      source,
      '--state',
      state,
      '--record',
      '/books/OL900000001M',
      '--format',
      'json',
    ]);
    expect(JSON.parse(detail.stdout).records[0].recordKey).toBe('/books/OL900000001M');
    const hostile = await runImportCli(['diagnostics', '--source', source, '--state', state, '--cursor', '!!!!']);
    expect(hostile.code).toBe(2);
    expect(hostile.openHandles).toBe(0);
    const text = await runImportCli(['diagnostics', '--source', source, '--state', state, '--record', '/books/OL900000001M']);
    expect(text.stdout).toContain('unsupported_publication_date_format');
    expect(text.stdout).toContain('/publish_date');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy stores report unavailable evidence and control characters stay escaped', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'diag-legacy-'));
  try {
    const legacy = join(directory, 'legacy.sqlite');
    const db = new Database(legacy);
    db.exec(`CREATE TABLE run_sources (source TEXT PRIMARY KEY, sequence INTEGER NOT NULL, lease_run TEXT, generation TEXT, present_count INTEGER NOT NULL) WITHOUT ROWID`);
    db.exec(
      `CREATE TABLE run_generations (source TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, lease TEXT NOT NULL, status TEXT NOT NULL, threshold REAL NOT NULL, prior INTEGER NOT NULL, PRIMARY KEY(source,id)) WITHOUT ROWID`,
    );
    db.exec(`INSERT INTO run_sources VALUES('openlibrary',1,NULL,'1',1)`);
    db.exec(
      `INSERT INTO run_generations(source,id,seq,lease,status,threshold,prior) VALUES('openlibrary','1',1,'${'a'.repeat(48)}','complete',0.2,0)`,
    );
    db.close();
    const result = await runImportCli(['diagnostics', '--source', source, '--state', legacy, '--format', 'json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).coverage).toBe('unsupported');
    const current = join(directory, 'current.sqlite');
    seed(current, 1, { code: 'unsupported\nformat' });
    const text = await runImportCli(['diagnostics', '--source', source, '--state', current, '--record', '/books/OL900000001M']);
    expect(text.stdout).toContain('\\u000a');
    expect(text.stdout).not.toMatch(/\nunsupported\nformat/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('interrupted Open Library import reopens staging diagnostics without credentials then resumes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'diag-resume-'));
  const state = join(directory, 'state.sqlite');
  const dumpPath = join(directory, 'dump.tsv');
  try {
    const record = edition(2);
    await writeFile(dumpPath, dump([record]));
    const keyPath = join(directory, 'key.jwk');
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    await writeFile(
      keyPath,
      JSON.stringify({ ...pair.privateKey.export({ format: 'jwk' }), kid: randomUUID(), alg: 'ES256' }),
      { mode: 0o600 },
    );
    const controller = new AbortController();
    const first = await runImportCli(
      [
        '--source',
        source,
        '--dump',
        dumpPath,
        '--state',
        state,
        '--api',
        'https://api.import.test',
        '--auth',
        'https://auth.import.test',
        '--account-key',
        keyPath,
        '--account',
        '00000000-0000-4000-8000-000000000001',
        '--client',
        'diag',
      ],
      {
        createImporter: (options) => {
          const importer = new Importer({ ...options, transport: transport() });
          const seal = importer.session.store.seal.bind(importer.session.store);
          importer.session.store.seal = (...args) => {
            const outcome = seal(...args);
            controller.abort();
            return outcome;
          };
          return importer;
        },
        signal: controller.signal,
        fetch: (async () => {
          throw new Error('network');
        }) as unknown as typeof fetch,
      },
    );
    expect(first.code).toBe(130);
    expect(first.openHandles).toBe(0);
    const review = await runImportCli(['diagnostics', '--source', source, '--state', state, '--format', 'json']);
    expect(review.code).toBe(0);
    const body = JSON.parse(review.stdout) as { coverage: string; records: { diagnostics: { code: string }[] }[] };
    expect(body.coverage).toBe('recorded');
    expect(body.records[0]!.diagnostics.map((d) => d.code)).toContain('unsupported_publication_date_format');
    const importer = new Importer({ path: state, transport: transport() });
    try {
      const resumed = await importer.runDump(createSourceRegistration('openlibrary'), (async function* () {
        yield new TextEncoder().encode(dump([record]));
      })());
      expect(resumed.status, resumed.diagnostic).toBe('committed');
      const phases = importer.session.store.database
        .query('SELECT phase FROM run_conversion_diagnostics WHERE record_key=? ORDER BY phase')
        .all(record.key) as { phase: string }[];
      expect(phases.map((row) => row.phase)).toEqual(['application', 'staging']);
    } finally {
      await importer.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
