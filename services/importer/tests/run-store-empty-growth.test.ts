import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand, BatchWriteResult } from '@rezics/definitions/bulk';
import { countedSample, countedViolations, type CountedCheck } from '../../kernel/test/support/growth-counters.ts';

import { RUN_TABLES, RunStore, type Run, type SourceProjection } from '../src/run-store.ts';
import { createSqliteProbe } from './support/sqlite-growth.ts';

type Sample = { scale: number; counted: ReturnType<typeof countedSample> };

const constant: CountedCheck = {
  read: (value) => value as Record<string, number>,
  bounds: { 'sqlite returned rows': 'constant', 'sqlite statements': 'constant' },
};

const source = 'wikidata';
const disposition = { reason: 'converter-ignored' } as const;
const noCandidates = { reason: 'no-owned-candidates' } as const;
const record = (key = 'Q1', revision = 1) => ({
  row: {
    source,
    recordKey: key,
    recordRevision: String(revision),
    digest: 'a'.repeat(64),
    converter_revision: 'test@1',
    state: 'present' as const,
  },
  projection: { sourceKind: 'wikidata' as const, normalizedRecord: { id: key, revision } },
});
function begin(store: RunStore<SourceProjection>): Run {
  const run = store.begin(source, { disappearanceThreshold: 1 });
  if (run === 'busy') throw new Error('Unexpected busy source');
  return run;
}
function finish(store: RunStore<SourceProjection>, run: Run) {
  let result = store.finalize(run, 8);
  while (result === 'more') result = store.finalize(run, 8);
  return result;
}
function commands(r = record()): BatchCommand[] {
  return [0, 1].map((i) => ({
    op: 'propose',
    key: `${r.row.recordKey}:${r.row.recordRevision}:${i}`,
    source: {
      source,
      external_id: r.row.recordKey,
      record_revision: r.row.recordRevision,
      digest: r.row.digest,
      converter_revision: r.row.converter_revision,
      field_group: 'facts',
    },
    subject: '00000000-0000-4000-8000-000000000001',
    statement: {
      property: { id: 'schema:name' },
      value: { type: 'value', content: `Name ${i}` },
      references: [
        {
          parts: [
            {
              property: { id: 'schema:sameAs' },
              value: { type: 'value', content: `https://www.wikidata.org/entity/${r.row.recordKey}` },
            },
          ],
        },
      ],
    },
  }));
}
// Portable proposal responses are fixtures only for genuinely nonempty command plans.
const success = (key: string): BatchWriteResult => ({
  results: [{ key, status: 200, value: { candidate: '00000000-0000-4000-8000-000000000002', revision: 1 } }],
});
const failure = (key: string): BatchWriteResult => ({
  results: [{ key, status: 409, problem: { type: 'conflict', title: 'Conflict', status: 409 } }],
});

test('original prepared commands cannot be bypassed pending, partially failed, acknowledged or fenced', () => {
  for (const method of ['classify', 'prepare'] as const) {
    for (const fenced of [false, true]) {
      const store = new RunStore<SourceProjection>(':memory:', { projectionMode: 'source-record' });
      try {
        const run = begin(store);
        store.stage(run, record());
        store.seal(run, { complete: true });
        const plan = commands();
        store[method](run, 'Q1', { commands: plan });
        const refuse = () => {
          for (const input of [disposition, noCandidates])
            expect(() => store.acknowledgeNoEffects(run, 'Q1', input)).toThrow();
        };
        refuse();
        store.acknowledge(run, failure(plan[0]!.key), { recordKey: 'Q1' });
        refuse();
        store.acknowledge(run, success(plan[0]!.key), { recordKey: 'Q1' });
        store.acknowledge(run, failure(plan[1]!.key), { recordKey: 'Q1' });
        store.classify(run, 'Q1', { commands: [] });
        refuse();
        expect(store.finalize(run, 8)).toBe('incomplete');
        expect(store.key(source, 'Q1').acknowledged).toBeNull();
        expect(store.pagePending(run, { limit: 8 })[0]!.bytes).toBe(JSON.stringify({ commands: plan }));
        if (fenced) {
          store.classify(run, 'Q1', {
            commands: [],
            omissions: [{ field_group: 'facts', disposition: 'fenced', securityRevision: '9' }],
          });
        } else store.acknowledge(run, success(plan[1]!.key), { recordKey: 'Q1' });
        refuse();
        expect(store.pagePending(run, { limit: 8 })).toEqual([]);
        expect(finish(store, run)).toBe('complete');
      } finally {
        store.close();
      }
    }
  }
});

test('no-effect acknowledgement validates hostile input without invoking accessors or changing state', () => {
  const store = new RunStore<SourceProjection>(':memory:', { projectionMode: 'source-record' });
  let invoked = 0;
  try {
    const run = begin(store);
    store.stage(run, record());
    expect(() => store.acknowledgeNoEffects(run, 'Q1', disposition)).toThrow();
    store.seal(run, { complete: true });
    expect(() => store.acknowledgeNoEffects(run, 'Q1', disposition)).toThrow();
    store.classify(run, 'Q1', { commands: [] });
    const getter = {
      get reason() {
        invoked++;
        return 'converter-ignored';
      },
    };
    for (const input of [
      null,
      [],
      {},
      { reason: 'unknown' },
      { reason: 1 },
      { reason: null },
      getter,
      { ...disposition, evidence: true },
      Object.create(disposition),
      Object.defineProperty({}, 'reason', { value: disposition.reason }),
      { ...disposition, [Symbol('extra')]: true },
    ])
      expect(() => store.acknowledgeNoEffects(run, 'Q1', input as never)).toThrow();
    for (const invalidRun of [
      null,
      { ...run, lease: '0'.repeat(48) },
      { ...run, id: '999' },
      { ...run, source: 'other' },
      { ...run, extra: true },
      {
        ...run,
        get lease() {
          invoked++;
          return run.lease;
        },
      },
    ])
      expect(() => store.acknowledgeNoEffects(invalidRun as never, 'Q1', disposition)).toThrow();
    for (const key of [null, '', 'Q1\n', 'Q404', 'x'.repeat(513)])
      expect(() => store.acknowledgeNoEffects(run, key as never, disposition)).toThrow();
    expect(invoked).toBe(0);
    expect(store.key(source, 'Q1').acknowledged).toBeNull();
    expect(store.source(source)).toEqual({ generation: null, count: 0 });
    expect(finish(store, run)).toBe('incomplete');
  } finally {
    store.close();
  }
});

test('zero-effect resolution persists across connections and lease rotation and is idempotent', () => {
  const directory = mkdtempSync(join(tmpdir(), 'run-empty-'));
  const path = `${directory}/runs.sqlite`;
  let store = new RunStore<SourceProjection>(path, { projectionMode: 'source-record' });
  try {
    const original = begin(store);
    store.stage(original, record());
    store.seal(original, { complete: true });
    store.classify(original, 'Q1', { commands: [] });
    store.close();
    store = new RunStore<SourceProjection>(path, { projectionMode: 'source-record' });
    let run = store.reopen(original);
    expect(() => store.acknowledgeNoEffects(original, 'Q1', disposition)).toThrow();
    store.acknowledgeNoEffects(run, 'Q1', disposition);
    expect(store.begin(source)).toBe('busy');
    expect(store.source(source)).toEqual({ generation: null, count: 0 });
    store.close();
    store = new RunStore<SourceProjection>(path, { projectionMode: 'source-record' });
    const stale = run;
    run = store.reopen(run);
    expect(() => store.acknowledgeNoEffects(stale, 'Q1', noCandidates)).toThrow();
    store.acknowledgeNoEffects(run, 'Q1', noCandidates);
    expect(store.key(source, 'Q1', run).acknowledged).toEqual(record().row);
    expect(store.key(source, 'Q1', run).omissions).toEqual([]);
    expect(store.database.query('SELECT * FROM run_commands').all()).toEqual([]);
    expect(store.database.query('SELECT * FROM run_envelopes').all()).toEqual([]);
    expect(store.database.query('SELECT * FROM run_payloads').all()).toEqual([]);
    expect(finish(store, run)).toBe('complete');
    expect(store.source(source)).toEqual({ generation: run.id, count: 1 });
    expect(() => store.acknowledgeNoEffects(run, 'Q1', disposition)).toThrow();
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('vanished record with no owned candidates resolves only after classification and ordinary finalization', () => {
  const store = new RunStore<SourceProjection>(':memory:', { projectionMode: 'source-record' });
  try {
    const prior = begin(store);
    for (const key of ['Q1', 'Q2']) store.stage(prior, record(key));
    store.seal(prior, { complete: true });
    for (const key of ['Q1', 'Q2']) {
      store.classify(prior, key, { commands: [] });
      store.acknowledgeNoEffects(prior, key, disposition);
    }
    expect(finish(store, prior)).toBe('complete');
    const run = begin(store);
    store.stage(run, record('Q2'));
    store.seal(run, { complete: true });
    expect(store.pageVanished(run, { limit: 8 }).map((row) => row.recordKey)).toEqual(['Q1']);
    expect(() => store.acknowledgeNoEffects(run, 'Q1', noCandidates)).toThrow();
    store.classify(run, 'Q2', { commands: [] });
    expect(store.classify(run, 'Q1', { commands: [] })).toBe('vanished');
    expect(finish(store, run)).toBe('incomplete');
    store.acknowledgeNoEffects(run, 'Q1', noCandidates);
    expect(store.key(source, 'Q1').acknowledged?.state).toBe('vanished');
    expect(store.key(source, 'Q1').baseline?.state).toBe('present');
    expect(store.key(source, 'Q1', run).omissions).toEqual([]);
    expect(finish(store, run)).toBe('complete');
    expect(store.key(source, 'Q1').baseline?.state).toBe('vanished');
    expect(store.source(source)).toEqual({ generation: run.id, count: 1 });
  } finally {
    store.close();
  }
});

test('a failed record leaves the complete baseline intact after another record resolves without effects', () => {
  const store = new RunStore<SourceProjection>(':memory:', { projectionMode: 'source-record' });
  try {
    const prior = begin(store);
    for (const key of ['Q1', 'Q2']) store.stage(prior, record(key));
    store.seal(prior, { complete: true });
    for (const key of ['Q1', 'Q2']) {
      store.classify(prior, key, { commands: [] });
      store.acknowledgeNoEffects(prior, key, disposition);
    }
    expect(finish(store, prior)).toBe('complete');
    const run = begin(store);
    for (const key of ['Q1', 'Q2']) store.stage(run, record(key, 2));
    store.seal(run, { complete: true });
    store.classify(run, 'Q1', { commands: [] });
    store.acknowledgeNoEffects(run, 'Q1', disposition);
    const plan = commands(record('Q2', 2));
    store.prepare(run, 'Q2', { commands: plan });
    store.acknowledge(run, failure(plan[0]!.key), { recordKey: 'Q2' });
    expect(() => store.acknowledgeNoEffects(run, 'Q2', noCandidates)).toThrow();
    expect(finish(store, run)).toBe('incomplete');
    expect(store.source(source)).toEqual({ generation: prior.id, count: 2 });
    expect(store.key(source, 'Q1').acknowledged).toEqual(record('Q1', 2).row);
    for (const key of ['Q1', 'Q2']) expect(store.key(source, key).baseline).toEqual(record(key).row);
    expect(store.key(source, 'Q2').acknowledged).toEqual(record('Q2').row);
  } finally {
    store.close();
  }
});

test('no-effect resolution stays indexed with unrelated same-source history and current keys at three scales', () => {
  let probe!: ReturnType<typeof createSqliteProbe>;
  const store = new RunStore<SourceProjection>(':memory:', {
    projectionMode: 'source-record',
    instrumentDatabase(db) {
      probe = createSqliteProbe(db, { growingTables: RUN_TABLES });
      return probe.database;
    },
  });
  const samples = new Map<string, Sample[]>();
  let previous = 0;
  let step = 0;
  let cumulative = 0;
  let previousMembers = 0;
  try {
    for (const scale of [64, 512, 4096]) {
      // One deterministic seed grows historical generations/entries and live keys in the same source.
      for (; previous < scale; previous++) {
        const history = begin(store);
        store.stage(history, record(`History${previous}`));
        store.seal(history, { complete: false, reason: 'truncated' });
        expect(() => store.acknowledgeNoEffects(history, `History${previous}`, disposition)).toThrow();
      }
      const run = begin(store);
      const target = record('Target', scale);
      for (let i = 0; i < scale; i++) store.stage(run, record(`Current${i}`));
      store.stage(run, target);
      store.seal(run, { complete: true });
      for (let i = 0; i < scale; i++) {
        store.classify(run, `Current${i}`, { commands: [] });
        store.acknowledgeNoEffects(run, `Current${i}`, disposition);
      }
      store.classify(run, 'Target', { commands: [] });
      step++;
      cumulative += scale;
      expect(
        RUN_TABLES.map(
          (table) => (store.database.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n,
        ),
      ).toEqual([1, scale + step, scale + cumulative + step, previousMembers, scale + (step > 1 ? 1 : 0), 0, 0, 0]);
      store.database.exec('ANALYZE');
      const measure = <T>(name: string, operation: () => T) => {
        const sample = probe.measure(operation);
        expect(sample.counts['sqlite returned rows']).toBeLessThanOrEqual(2);
        expect(sample.counts['sqlite statements']).toBeLessThanOrEqual(7);
        const plans = probe.verifyPlans(); // Every execution, including UPSERT/control.
        expect(plans.some((event) => event.plan.some((plan) => /^SEARCH\b/.test(plan.detail)))).toBe(true);
        const group = samples.get(name) ?? [];
        group.push({ scale, counted: countedSample([sample.counts]) });
        samples.set(name, group);
        return sample;
      };
      const resolved = measure('resolve', () => store.acknowledgeNoEffects(run, 'Target', disposition));
      expect(resolved.counts).toEqual({ 'sqlite returned rows': 2, 'sqlite statements': 7 });
      expect(resolved.statements.filter((s) => s.kind === 'control').map((s) => s.sql)).toEqual([
        'BEGIN IMMEDIATE',
        'COMMIT',
      ]);
      expect(resolved.statements.filter((s) => s.kind === 'insert').map((s) => s.changes)).toEqual([1]);
      expect(resolved.statements.filter((s) => s.kind === 'read').map((s) => s.rows)).toEqual([1, 1]);
      measure('idempotent', () => store.acknowledgeNoEffects(run, 'Target', noCandidates));
      const inner = store.database.transaction(() =>
        store.database
          .query('SELECT row_json FROM run_acknowledged WHERE source=? AND record_key=?')
          .get(source, 'Target'),
      );
      const outer = store.database.transaction(() => inner());
      const nested = measure('nested-controls', () => outer.immediate());
      expect(nested.value).toEqual({ row_json: JSON.stringify(target.row) });
      expect(nested.counts).toEqual({ 'sqlite returned rows': 1, 'sqlite statements': 5 });
      expect(nested.statements.filter((s) => s.kind === 'control')).toHaveLength(4);
      expect(finish(store, run)).toBe('complete');
      expect(store.source(source)).toEqual({ generation: run.id, count: scale + 1 });
      previousMembers = scale + 1;
    }
    for (const group of samples.values()) expect(countedViolations(constant, group)).toEqual([]);
  } finally {
    probe.restore();
    store.close();
  }
});
