import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  countedSample,
  countedViolations,
  type CountedCheck,
  type CountedValues,
} from '../../kernel/test/support/growth-counters.ts';
import { ConversionDiagnosticsView } from '../src/conversion-diagnostics.ts';
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

function setup() {
  const database = new Database(':memory:');
  const probe = createSqliteProbe(database, { growingTables: RUN_TABLES });
  const store = new RunStore<SourceProjection>(probe.database, { projectionMode: 'source-record' });
  return { probe, store, view: new ConversionDiagnosticsView(probe.database) };
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
      projection: { sourceKind: 'openlibrary', normalizedRecord: { key: recordKey } },
    });
    expect(store.seal(run, { complete: true }).status).toBe('ready');
    expect(store.abandon(run)).toBe('abandoned');
  }
}

function populate(store: RunStore<SourceProjection>, count: number, prefix: number) {
  const run = store.begin(source);
  if (run === 'busy') throw new Error('busy');
  for (let i = 1; i <= count; i++) {
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
      projection: { sourceKind: 'openlibrary', normalizedRecord: { key: recordKey } },
    });
    store.retainConversionDiagnostics(run, {
      recordKey,
      digest: digest(prefix + i),
      converterRevision: 'open-library@3',
      recordRevision: '1',
      phase: 'staging',
      diagnostics: [{ pointer: '/publish_date', code: 'unsupported_publication_date_format' }],
    });
  }
  expect(store.seal(run, { complete: true }).status).toBe('ready');
  return run.id;
}

function sample(
  probe: ReturnType<typeof createSqliteProbe>,
  operation: () => unknown,
): { 'sqlite statements': number; 'sqlite returned rows': number } {
  const measured = probe.measure(operation);
  const evidence = probe.verifyPlans();
  expect(evidence.some((event) => event.kind === 'write' || event.kind === 'insert')).toBe(false);
  expect(evidence.some((event) => event.plan.some((row) => /^SEARCH/.test(row.detail)))).toBe(true);
  expect(evidence.every((event) => !event.plan.some((row) => /\bSCAN\b/i.test(row.detail) && !/CONSTANT ROW/.test(row.detail)))).toBe(
    true,
  );
  return { 'sqlite statements': measured.counts['sqlite statements'], 'sqlite returned rows': measured.counts['sqlite returned rows'] };
}

test('diagnostic pages and exact lookup stay indexed as current omissions and unrelated history grow', () => {
  const groups = new Map<string, { scale: number; counted: ReturnType<typeof countedSample> }[]>();
  for (const scale of [32, 128, 512]) {
    const current = setup();
    try {
      history(current.store, 32, 1000000000);
      const generation = populate(current.store, scale, 2000000000);
      current.store.database.exec('ANALYZE');
      const first = sample(current.probe, () =>
        current.view.pageRecords({ source, generation, limit: 20 }),
      );
      const page = current.view.pageRecords({ source, generation, limit: 20 });
      const next = sample(current.probe, () =>
        current.view.pageRecords({ source, generation, limit: 20, after: page.records.at(-1)!.recordKey }),
      );
      const lastKey = key(2000000000, scale);
      const end = sample(current.probe, () => current.view.pageRecords({ source, generation, limit: 20, after: lastKey }));
      const exact = sample(current.probe, () =>
        current.view.recordDetail({ source, generation, recordKey: key(2000000000, 1) }),
      );
      for (const [name, counts] of [
        ['first', first],
        ['next', next],
        ['end', end],
        ['exact', exact],
      ] as const) {
        const group = groups.get(name) ?? [];
        group.push({ scale, counted: countedSample([counts]) });
        groups.set(name, group);
      }
    } finally {
      current.view.close();
      current.store.close();
    }
    const historic = setup();
    try {
      history(historic.store, scale, 1000000000);
      const generation = populate(historic.store, 32, 2000000000);
      historic.store.database.exec('ANALYZE');
      const first = sample(historic.probe, () => historic.view.pageRecords({ source, generation, limit: 20 }));
      const exact = sample(historic.probe, () =>
        historic.view.recordDetail({ source, generation, recordKey: key(2000000000, 1) }),
      );
      for (const [name, counts] of [
        ['history-first', first],
        ['history-exact', exact],
      ] as const) {
        const group = groups.get(name) ?? [];
        group.push({ scale, counted: countedSample([counts]) });
        groups.set(name, group);
      }
    } finally {
      historic.view.close();
      historic.store.close();
    }
  }
  for (const group of groups.values()) expect(countedViolations(check, group)).toEqual([]);
});
