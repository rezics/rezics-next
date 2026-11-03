import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSourceRegistration } from '../src/source-registry.ts';
import { Importer } from '../src/importer.ts';
import { RunStore, type SourceProjection } from '../src/run-store.ts';
import {
  ConversionDiagnosticError,
  CONVERSION_DIAGNOSTIC_LIMITS,
  sanitizeConversionDiagnostics,
} from '../src/conversion-diagnostics.ts';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';

const digest = (n: number) => n.toString(16).padStart(64, '0');
const projection = (key: string): SourceProjection => ({
  sourceKind: 'openlibrary',
  normalizedRecord: { key, title: 'Glass' },
});
const staged = (source: string, key: string, n = 1) => ({
  row: {
    source,
    recordKey: key,
    recordRevision: '11',
    digest: digest(n),
    converter_revision: 'open-library@3',
    state: 'present' as const,
  },
  projection: projection(key),
});

function store() {
  const database = new Database(':memory:');
  return new RunStore<SourceProjection>(database, { projectionMode: 'source-record' });
}

function transport() {
  return {
    async batchWrite(request: BatchWriteRequest): Promise<BatchWriteResult> {
      return {
        results: request.commands.map((command) =>
          command.op === 'create'
            ? {
                key: command.key,
                status: 201 as const,
                value: { id: '00000000-0000-4000-8000-000000000001', revision: 1 },
              }
            : {
                key: command.key,
                status: 200 as const,
                value: { candidate: '00000000-0000-4000-8000-000000000002', revision: 1 },
              },
        ),
      };
    },
    async readFence() {
      return { fenced: false, securityRevision: null };
    },
  };
}

function edition(n: number, date = 'circa 1980') {
  return {
    type: { key: '/type/edition' },
    key: `/books/OL${900000000 + n}M`,
    revision: 1,
    last_modified: { type: '/type/datetime', value: '2025-01-01T00:00:00.000000' },
    title: `Atlas ${n}`,
    isbn_13: ['9780306406157'],
    publish_date: date,
  };
}

test('sanitize admits sentence codes and pointers and rejects accessors or over-limit vectors', () => {
  expect(
    sanitizeConversionDiagnostics([{ pointer: '/publish_date', code: 'unsupported_publication_date_format' }]),
  ).toEqual([{ pointer: '/publish_date', code: 'unsupported_publication_date_format' }]);
  expect(
    sanitizeConversionDiagnostics([
      {
        pointer: '/claims/P31',
        code: 'Duplicate canonical term language; kept the first source key',
        category: 'omission',
      },
    ]),
  ).toEqual([
    {
      pointer: '/claims/P31',
      code: 'Duplicate canonical term language; kept the first source key',
      category: 'omission',
    },
  ]);
  expect(() =>
    sanitizeConversionDiagnostics([{ pointer: 'publish_date', code: 'unsupported_publication_date_format' }]),
  ).toThrow(ConversionDiagnosticError);
  const getter = {};
  Object.defineProperty(getter, '0', { enumerable: true, get: () => ({ pointer: '/a', code: 'x' }) });
  Object.defineProperty(getter, 'length', { enumerable: false, value: 1 });
  expect(() => sanitizeConversionDiagnostics(getter)).toThrow(ConversionDiagnosticError);
  const oversized = Array.from({ length: CONVERSION_DIAGNOSTIC_LIMITS.maxEntries + 1 }, () => ({
    pointer: '/x',
    code: 'y',
  }));
  expect(() => sanitizeConversionDiagnostics(oversized)).toThrow(ConversionDiagnosticError);
  expect(
    sanitizeConversionDiagnostics([
      {
        pointer: '/language',
        code: 'no_canonical_language_tag',
        sourceVocabularyGap: { path: '/language', reason: 'no_canonical_language_tag' },
      },
    ]),
  ).toEqual([{ pointer: '/language', code: 'no_canonical_language_tag' }]);
});

test('retained empty diagnostics are distinct from missing evidence and resume keeps identity', () => {
  const runStore = store();
  try {
    const source = 'openlibrary';
    const run = runStore.begin(source);
    if (run === 'busy') throw new Error('busy');
    const row = staged(source, '/books/OL900000001M');
    runStore.stage(run, row);
    runStore.retainConversionDiagnostics(run, {
      recordKey: row.row.recordKey,
      digest: row.row.digest,
      converterRevision: row.row.converter_revision,
      recordRevision: row.row.recordRevision,
      phase: 'staging',
      diagnostics: [],
    });
    const empty = runStore.database
      .query(
        'SELECT diagnostic_count,diagnostics_json,diagnostics_recorded FROM run_conversion_diagnostics d JOIN run_generations g ON g.source=d.source AND g.id=d.run_id WHERE d.record_key=?',
      )
      .get(row.row.recordKey) as { diagnostic_count: number; diagnostics_json: string; diagnostics_recorded: number };
    expect(empty.diagnostic_count).toBe(0);
    expect(empty.diagnostics_json).toBe('[]');
    expect(empty.diagnostics_recorded).toBe(1);
    expect(
      runStore.database
        .query('SELECT 1 FROM run_conversion_diagnostic_records WHERE record_key=?')
        .get(row.row.recordKey),
    ).toBeNull();
    runStore.retainConversionDiagnostics(run, {
      recordKey: row.row.recordKey,
      digest: row.row.digest,
      converterRevision: row.row.converter_revision,
      recordRevision: row.row.recordRevision,
      phase: 'staging',
      diagnostics: [{ pointer: '/publish_date', code: 'unsupported_publication_date_format' }],
    });
    expect(
      runStore.database
        .query('SELECT diagnostics_json FROM run_conversion_diagnostics WHERE record_key=?')
        .get(row.row.recordKey),
    ).toEqual({ diagnostics_json: '[]' });
    expect(() =>
      runStore.retainConversionDiagnostics(run, {
        recordKey: row.row.recordKey,
        digest: digest(2),
        converterRevision: row.row.converter_revision,
        recordRevision: row.row.recordRevision,
        phase: 'staging',
        diagnostics: [],
      }),
    ).toThrow(ConversionDiagnosticError);
  } finally {
    runStore.close();
  }
});

test('Open Library dump staging retains the real publication-date omission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'diag-stage-'));
  const importer = new Importer({ path: join(directory, 'state.sqlite'), transport: transport() });
  try {
    const record = edition(1);
    const line =
      [record.type.key, record.key, record.revision, record.last_modified.value, JSON.stringify(record)].join('\t') +
      '\n';
    const controller = new AbortController();
    const original = importer.session.store.seal.bind(importer.session.store);
    importer.session.store.seal = (...args) => {
      const outcome = original(...args);
      controller.abort();
      return outcome;
    };
    const result = await importer.runDump(
      createSourceRegistration('openlibrary'),
      (async function* () {
        yield new TextEncoder().encode(line);
      })(),
      { signal: controller.signal },
    );
    expect(result.status).toBe('interrupted');
    const retained = importer.session.store.database
      .query('SELECT diagnostics_json,phase FROM run_conversion_diagnostics WHERE record_key=?')
      .all(record.key) as { diagnostics_json: string; phase: string }[];
    expect(retained).toHaveLength(1);
    expect(retained[0]!.phase).toBe('staging');
    expect(JSON.parse(retained[0]!.diagnostics_json)).toContainEqual({
      pointer: '/publish_date',
      code: 'unsupported_publication_date_format',
    });
  } finally {
    await importer.close();
    await rm(directory, { recursive: true, force: true });
  }
});
