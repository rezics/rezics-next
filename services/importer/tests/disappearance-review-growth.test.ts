import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  countedSample,
  countedViolations,
  type CountedCheck,
  type CountedValues,
} from '../../kernel/test/support/growth-counters.ts';
import { DisappearanceReview } from '../src/disappearance-review.ts';
import { RUN_TABLES, RunStore, type Run, type SourceProjection } from '../src/run-store.ts';
import { createSqliteProbe } from './support/sqlite-growth.ts';

const temporaryRoot = resolve(import.meta.dir, '../../../.temp');
const source = 'wikidata';
const check: CountedCheck = {
  read: (value: unknown) => value as CountedValues,
  bounds: { 'sqlite statements': 'constant', 'sqlite returned rows': 'constant' },
  slack: {
    'sqlite statements': { absolute: 2, relative: 0.1 },
    'sqlite returned rows': { absolute: 2, relative: 0.1 },
  },
};

function digest(n: number): string {
  return n.toString(16).padStart(64, '0');
}

function key(n: number): string {
  return `Q${n}`;
}

function staged(src: string, recordKey: string) {
  const n = Number(recordKey.slice(1));
  return {
    row: {
      source: src,
      recordKey,
      recordRevision: '1',
      digest: digest(Number.isFinite(n) ? n : 1),
      converter_revision: 'wikidata@1',
      state: 'present' as const,
    },
    projection: { sourceKind: 'wikidata' as const, normalizedRecord: { id: recordKey } },
  };
}

function complete(store: RunStore<SourceProjection>, run: Run, keys: string[]): void {
  expect(store.seal(run, { complete: true }).status).toBe('ready');
  for (const recordKey of keys) {
    store.classify(run, recordKey, { commands: [] });
    store.acknowledgeNoEffects(run, recordKey, { reason: 'no-owned-candidates' });
  }
  while (true) {
    const result = store.finalize(run, 100);
    if (result === 'complete') return;
    if (result === 'incomplete') throw new Error('Generation could not finalize');
  }
}

function history(store: RunStore<SourceProjection>, count: number, prefix: number): void {
  for (let i = 1; i <= count; i++) {
    const src = `hist${prefix}${i}`;
    const run = store.begin(src);
    if (run === 'busy') throw new Error('busy');
    const recordKey = key(prefix + i);
    store.stage(run, staged(src, recordKey));
    complete(store, run, [recordKey]);
  }
}

function populate(store: RunStore<SourceProjection>, prior: number, prefix: number): { run: Run; keep: number } {
  const baseline = store.begin(source);
  if (baseline === 'busy') throw new Error('busy');
  const keys = Array.from({ length: prior }, (_, index) => key(prefix + index + 1));
  for (const recordKey of keys) store.stage(baseline, staged(source, recordKey));
  complete(store, baseline, keys);
  const stopped = store.begin(source);
  if (stopped === 'busy') throw new Error('busy');
  const keep = Math.floor(prior / 4);
  for (const recordKey of keys.slice(0, keep)) store.stage(stopped, staged(source, recordKey));
  return { run: stopped, keep };
}

function sample(
  probe: ReturnType<typeof createSqliteProbe>,
  operation: () => unknown,
): { 'sqlite statements': number; 'sqlite returned rows': number } {
  const measured = probe.measure(operation);
  const evidence = probe.verifyPlans();
  expect(evidence.some((event) => event.plan.some((row) => /^SEARCH/.test(row.detail)))).toBe(true);
  expect(
    evidence.every(
      (event) => !event.plan.some((row) => /\bSCAN\b/i.test(row.detail) && !/CONSTANT ROW/.test(row.detail)),
    ),
  ).toBe(true);
  return {
    'sqlite statements': measured.counts['sqlite statements'],
    'sqlite returned rows': measured.counts['sqlite returned rows'],
  };
}

test('stop evidence capture and missing pages stay indexed at 32/128/512 with unrelated history', async () => {
  mkdirSync(temporaryRoot, { recursive: true });
  const groups = new Map<string, { scale: number; counted: ReturnType<typeof countedSample> }[]>();
  for (const scale of [32, 128, 512]) {
    const directory = mkdtempSync(join(temporaryRoot, 'disappearance-review-growth-'));
    const path = join(directory, 'state.sqlite');
    const writeDb = new Database(path, { create: true, strict: true });
    const writeProbe = createSqliteProbe(writeDb, { growingTables: RUN_TABLES });
    const store = new RunStore<SourceProjection>(writeProbe.database, { projectionMode: 'source-record' });
    let closed = false;
    try {
      history(store, 32, 1_000_000);
      const populated = populate(store, scale, 2_000_000);
      store.database.exec('ANALYZE');
      const capture = sample(writeProbe, () => {
        expect(store.seal(populated.run, { complete: true }).status).toBe('mass-disappearance');
      });
      const insert = writeProbe
        .verifyPlans()
        .find((event) => event.sql.includes('INSERT INTO run_disappearance_missing'));
      expect(insert?.plan.some((row) => /INDEX run_missing/i.test(row.detail))).toBe(true);
      store.close();
      closed = true;

      let readProbe: ReturnType<typeof createSqliteProbe> | undefined;
      const review = await DisappearanceReview.open(path, {
        instrumentDatabase: (database) => {
          readProbe = createSqliteProbe(database, { growingTables: RUN_TABLES });
          return readProbe.database;
        },
      });
      try {
        const probe = readProbe!;
        const first = sample(probe, () =>
          review.review({ source, generation: populated.run.id, page: 'missing', limit: 8 }),
        );
        const page = review.review({ source, generation: populated.run.id, page: 'missing', limit: 8 });
        expect(page.page?.rows).toHaveLength(8);
        expect(page.work.emittedRows).toBe(8);
        expect(page.work.probes).toBe(1);
        const middleCursor = page.page?.nextCursor;
        if (!middleCursor) throw new Error('expected missing-page continuation');
        const middle = sample(probe, () =>
          review.review({
            source,
            generation: populated.run.id,
            page: 'missing',
            limit: 8,
            cursor: middleCursor,
          }),
        );
        let endCursor = middleCursor;
        while (true) {
          const doc = review.review({
            source,
            generation: populated.run.id,
            page: 'missing',
            limit: 8,
            cursor: endCursor,
          });
          if (doc.page?.end === 'end' || !doc.page?.nextCursor) break;
          endCursor = doc.page.nextCursor;
        }
        const end = sample(probe, () =>
          review.review({
            source,
            generation: populated.run.id,
            page: 'missing',
            limit: 8,
            cursor: endCursor,
          }),
        );
        const exact = sample(probe, () =>
          review.review({
            source,
            generation: populated.run.id,
            record: key(2_000_000 + populated.keep + 1),
          }),
        );
        expect(exact['sqlite returned rows']).toBeGreaterThan(0);
        for (const [name, counts] of [
          ['capture', capture],
          ['first', first],
          ['middle', middle],
          ['end', end],
          ['exact', exact],
        ] as const) {
          const group = groups.get(name) ?? [];
          group.push({ scale, counted: countedSample([counts]) });
          groups.set(name, group);
        }
      } finally {
        await review.close();
      }
    } finally {
      if (!closed) store.close();
      writeDb.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
  for (const group of groups.values()) expect(countedViolations(check, group)).toEqual([]);
});
