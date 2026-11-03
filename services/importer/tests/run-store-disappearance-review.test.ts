import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DISAPPEARANCE_EVIDENCE_TABLES, RunStore, type Run, type SourceProjection } from '../src/run-store.ts';

const temporaryRoot = resolve(import.meta.dir, '../../../.temp');

function digest(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

function staged(source: string, key: string) {
  return {
    row: {
      source,
      recordKey: key,
      recordRevision: 'revision-1',
      digest: digest(`${source}:${key}`),
      converter_revision: 'test@1',
      state: 'present' as const,
    },
    projection: { sourceKind: 'wikidata' as const, normalizedRecord: { id: key } },
  };
}

function complete(store: RunStore<SourceProjection>, run: Run, keys: string[]): void {
  expect(store.seal(run, { complete: true }).status).toBe('ready');
  for (const key of keys) {
    store.classify(run, key, { commands: [] });
    store.acknowledgeNoEffects(run, key, { reason: 'no-owned-candidates' });
  }
  while (true) {
    const result = store.finalize(run, 100);
    if (result === 'complete') return;
    if (result === 'incomplete') throw new Error('Generation could not finalize');
  }
}

test('seal captures immutable missing identities and later staging cannot rewrite them', () => {
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(join(temporaryRoot, 'run-store-disappearance-'));
  const path = join(directory, 'state.sqlite');
  const store = new RunStore<SourceProjection>(path, { projectionMode: 'source-record' });
  try {
    const source = 'wikidata';
    const baseline = store.begin(source);
    if (baseline === 'busy') throw new Error('baseline');
    for (const key of ['Q1', 'Q2', 'Q3', 'Q4', 'Q5']) store.stage(baseline, staged(source, key));
    complete(store, baseline, ['Q1', 'Q2', 'Q3', 'Q4', 'Q5']);

    const stopped = store.begin(source);
    if (stopped === 'busy') throw new Error('stopped');
    store.stage(stopped, staged(source, 'Q1'));
    store.stage(stopped, staged(source, 'Q2'));
    store.stage(stopped, staged(source, 'Q3'));
    expect(store.seal(stopped, { complete: true })).toMatchObject({
      status: 'mass-disappearance',
      prior: 5,
      seenSurvivors: 3,
      supplied: 3,
    });

    const header = store.database
      .query('SELECT * FROM run_disappearance_stops WHERE source=? AND run_id=?')
      .get(source, stopped.id) as {
      evidence_id: string;
      baseline_generation: string;
      prior: number;
      missing: number;
      threshold: number;
      input_complete: number;
    };
    expect(header).toMatchObject({
      baseline_generation: baseline.id,
      prior: 5,
      missing: 2,
      threshold: 0.2,
      input_complete: 1,
    });
    expect(header.evidence_id).toMatch(/^[a-f0-9]{48}$/);
    const missing = store.database
      .query(
        'SELECT record_key FROM run_disappearance_missing WHERE source=? AND run_id=? ORDER BY record_key',
      )
      .all(source, stopped.id) as { record_key: string }[];
    expect(missing.map((row) => row.record_key)).toEqual(['Q4', 'Q5']);

    const later = store.begin(source);
    if (later === 'busy') throw new Error('later');
    store.stage(later, staged(source, 'Q4'));
    expect(store.seal(later, { complete: false, reason: 'truncated' }).status).toBe('invalid-input');
    const after = store.database
      .query(
        'SELECT record_key FROM run_disappearance_missing WHERE source=? AND run_id=? ORDER BY record_key',
      )
      .all(source, stopped.id) as { record_key: string }[];
    expect(after.map((row) => row.record_key)).toEqual(['Q4', 'Q5']);

    const empty = store.begin(source, { disappearanceThreshold: 1 });
    if (empty === 'busy') throw new Error('empty');
    expect(store.seal(empty, { complete: true }).status).toBe('mass-disappearance');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('evidence capture failure rolls the seal back and all-missing stays blocked at threshold 1', () => {
  const database = new Database(':memory:', { strict: true });
  const original = database.prepare.bind(database);
  database.prepare = ((sql: string) => {
    if (sql.includes('INSERT INTO run_disappearance_missing')) throw new Error('injected evidence failure');
    return original(sql);
  }) as typeof database.prepare;
  const store = new RunStore<SourceProjection>(database, { projectionMode: 'source-record' });
  try {
    const source = 'wikidata';
    const baseline = store.begin(source);
    if (baseline === 'busy') throw new Error('baseline');
    store.stage(baseline, staged(source, 'Q1'));
    complete(store, baseline, ['Q1']);
    const stopped = store.begin(source, { disappearanceThreshold: 1 });
    if (stopped === 'busy') throw new Error('stopped');
    expect(() => store.seal(stopped, { complete: true })).toThrow('injected evidence failure');
    expect(store.database.query('SELECT status FROM run_generations WHERE id=?').get(stopped.id) as { status: string })
      .toMatchObject({ status: 'staging' });
    expect(store.database.query('SELECT count(*) AS n FROM run_disappearance_stops').get() as { n: number }).toEqual({
      n: 0,
    });
    expect(DISAPPEARANCE_EVIDENCE_TABLES).toEqual(['run_disappearance_stops', 'run_disappearance_missing']);
  } finally {
    store.close();
  }
});

test('retention child deletion removes only one generation and leaves pruned evidence unavailable', () => {
  const store = new RunStore<SourceProjection>(':memory:', { projectionMode: 'source-record' });
  try {
    const source = 'wikidata';
    const baseline = store.begin(source);
    if (baseline === 'busy') throw new Error('baseline');
    for (const key of ['Q1', 'Q2', 'Q3']) store.stage(baseline, staged(source, key));
    complete(store, baseline, ['Q1', 'Q2', 'Q3']);
    const first = store.begin(source);
    if (first === 'busy') throw new Error('first');
    store.stage(first, staged(source, 'Q1'));
    expect(store.seal(first, { complete: true }).status).toBe('mass-disappearance');
    const second = store.begin(source);
    if (second === 'busy') throw new Error('second');
    store.stage(second, staged(source, 'Q1'));
    expect(store.seal(second, { complete: true }).status).toBe('mass-disappearance');
    store.database.query('DELETE FROM run_disappearance_missing WHERE source=? AND run_id=?').run(source, first.id);
    store.database.query('DELETE FROM run_disappearance_stops WHERE source=? AND run_id=?').run(source, first.id);
    expect(
      store.database.query('SELECT count(*) AS n FROM run_disappearance_stops WHERE run_id=?').get(first.id) as {
        n: number;
      },
    ).toEqual({ n: 0 });
    expect(
      store.database.query('SELECT missing FROM run_disappearance_stops WHERE run_id=?').get(second.id) as {
        missing: number;
      },
    ).toEqual({ missing: 2 });
  } finally {
    store.close();
  }
});
