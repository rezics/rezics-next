import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  countedSample,
  countedViolations,
  type CountedCheck,
  type CountedValues,
} from '../../kernel/test/support/growth-counters.ts';
import { RUN_TABLES, RunStore, type SourceProjection } from '../src/run-store.ts';
import { createSqliteProbe } from './support/sqlite-growth.ts';

const source = 'openlibrary';
const digest = (n: number) => n.toString(16).padStart(64, '0');
const key = (prefix: number, n: number) => `/books/OL${prefix + n}M`;
const check: CountedCheck = {
  read: (value: unknown) => value as CountedValues,
  bounds: { 'sqlite statements': 'constant', 'sqlite returned rows': 'constant' },
  slack: {
    'sqlite statements': { absolute: 2, relative: 0.1 },
    'sqlite returned rows': { absolute: 2, relative: 0.1 },
  },
};

function projection(recordKey: string): SourceProjection {
  return { sourceKind: 'openlibrary', normalizedRecord: { key: recordKey } };
}

function setup() {
  const database = new Database(':memory:');
  const probe = createSqliteProbe(database, { growingTables: RUN_TABLES });
  const store = new RunStore<SourceProjection>(probe.database, { projectionMode: 'source-record' });
  return { probe, store };
}

function history(store: RunStore<SourceProjection>, count: number, prefix: number) {
  for (let i = 1; i <= count; i++) {
    const run = store.begin(source);
    if (run === 'busy') throw new Error('busy');
    const recordKey = key(prefix, i);
    store.stage(run, {
      row: {
        source,
        recordKey,
        recordRevision: '1',
        digest: digest(prefix + i),
        converter_revision: 'open-library@3',
        state: 'present',
      },
      projection: projection(recordKey),
    });
    expect(store.seal(run, { complete: true }).status).toBe('ready');
    expect(store.abandon(run)).toBe('abandoned');
  }
}

function retain(
  store: RunStore<SourceProjection>,
  run: Exclude<ReturnType<RunStore['begin']>, 'busy'>,
  n: number,
  prefix: number,
) {
  const recordKey = key(prefix, n);
  store.stage(run, {
    row: {
      source,
      recordKey,
      recordRevision: '1',
      digest: digest(prefix + n),
      converter_revision: 'open-library@3',
      state: 'present',
    },
    projection: projection(recordKey),
  });
  store.retainConversionDiagnostics(run, {
    recordKey,
    digest: digest(prefix + n),
    converterRevision: 'open-library@3',
    recordRevision: '1',
    phase: 'staging',
    diagnostics: [{ pointer: '/publish_date', code: 'unsupported_publication_date_format' }],
  });
}

test('staging diagnostic retention stays indexed as diagnostic-bearing records and unrelated history grow', () => {
  const bearing: { scale: number; counted: ReturnType<typeof countedSample> }[] = [];
  const unrelated: { scale: number; counted: ReturnType<typeof countedSample> }[] = [];
  for (const scale of [32, 128, 512]) {
    const current = setup();
    try {
      history(current.store, 32, 1000000000);
      const run = current.store.begin(source);
      if (run === 'busy') throw new Error('busy');
      for (let i = 1; i < scale; i++) retain(current.store, run, i, 2000000000);
      current.store.database.exec('ANALYZE');
      const sample = current.probe.measure(() => retain(current.store, run, scale, 2000000000));
      current.probe.verifyPlans();
      expect(sample.statements.some((event) => event.plan.some((row) => /^SEARCH/.test(row.detail)))).toBe(true);
      expect(
        sample.statements.every(
          (event) => event.kind !== 'write' || event.plan.some((row) => /^SEARCH/.test(row.detail)),
        ),
      ).toBe(true);
      bearing.push({
        scale,
        counted: countedSample([
          {
            'sqlite statements': sample.counts['sqlite statements'],
            'sqlite returned rows': sample.counts['sqlite returned rows'],
          },
        ]),
      });
    } finally {
      current.store.close();
    }
    const historic = setup();
    try {
      history(historic.store, scale, 1000000000);
      const run = historic.store.begin(source);
      if (run === 'busy') throw new Error('busy');
      historic.store.database.exec('ANALYZE');
      const sample = historic.probe.measure(() => retain(historic.store, run, 1, 2000000000));
      historic.probe.verifyPlans();
      expect(sample.statements.some((event) => event.plan.some((row) => /^SEARCH/.test(row.detail)))).toBe(true);
      unrelated.push({
        scale,
        counted: countedSample([
          {
            'sqlite statements': sample.counts['sqlite statements'],
            'sqlite returned rows': sample.counts['sqlite returned rows'],
          },
        ]),
      });
    } finally {
      historic.store.close();
    }
  }
  expect(countedViolations(check, bearing)).toEqual([]);
  expect(countedViolations(check, unrelated)).toEqual([]);
});
