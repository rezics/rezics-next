import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  countedSample,
  countedViolations,
  type CountedCheck,
  type CountedValues,
} from '../../kernel/test/support/growth-counters.ts';
import { ImportSession } from '../src/import-session.ts';
import { captureIdentity } from '../src/staging-checkpoint.ts';
import {
  applyStagingRetirementOnDatabase,
  buildStagingRetirementPlan,
  reviewStagingRetirementOnDatabase,
} from '../src/staging-retirement.ts';
import { retentionCatalog } from '../src/retention.ts';
import { RUN_TABLES, RunStore, type SourceProjection } from '../src/run-store.ts';
import { createSqliteProbe } from './support/sqlite-growth.ts';

const temporaryRoot = resolve(import.meta.dir, '../../../.temp');
const source = 'wikidata';
const unrelated = 'bangumi';
const constant: CountedCheck = {
  read: (value: unknown) => value as CountedValues,
  bounds: { 'sqlite statements': 'constant', 'sqlite returned rows': 'constant' },
  slack: {
    'sqlite statements': { absolute: 4, relative: 0.15 },
    'sqlite returned rows': { absolute: 4, relative: 0.15 },
  },
};
const linear: CountedCheck = {
  read: (value: unknown) => value as CountedValues,
  bounds: { 'sqlite statements': 'linear', 'sqlite returned rows': 'linear' },
  slack: {
    'sqlite statements': { absolute: 12, relative: 0.25 },
    'sqlite returned rows': { absolute: 12, relative: 0.25 },
  },
};

function staged(recordSource: string, key: string, digest: string) {
  return {
    row: {
      source: recordSource,
      recordKey: key,
      recordRevision: '1',
      digest,
      converter_revision: 'test@1',
      state: 'present' as const,
    },
    projection: {
      sourceKind: 'wikidata' as const,
      normalizedRecord: { id: key },
    } satisfies SourceProjection,
  };
}

function finish(store: RunStore<SourceProjection>, run: Exclude<ReturnType<RunStore['begin']>, 'busy'>) {
  let result = store.finalize(run, 100);
  while (result === 'more') result = store.finalize(run, 100);
  return result;
}

function complete(store: RunStore<SourceProjection>, recordSource: string, keys: readonly string[], salt: number) {
  const run = store.begin(recordSource);
  if (run === 'busy') throw new Error('busy');
  for (const [index, key] of keys.entries())
    store.stage(run, staged(recordSource, key, (salt + index).toString(16).padStart(64, '0')));
  expect(store.seal(run, { complete: true }).status).toBe('ready');
  for (const key of keys) {
    store.classify(run, key, { commands: [] });
    store.acknowledgeNoEffects(run, key, { reason: 'no-owned-candidates' });
  }
  expect(finish(store, run)).toBe('complete');
  return run;
}

function snapshot(database: import('bun:sqlite').Database) {
  return {
    sources: database.query('SELECT source,sequence,generation,present_count FROM run_sources ORDER BY source').all(),
    ack: database.query('SELECT source,record_key,row_json FROM run_acknowledged ORDER BY source,record_key').all(),
    payloads: database.query('SELECT source,command_key,body FROM run_payloads ORDER BY source,command_key').all(),
    bindings: database.query('SELECT source,external_id,state FROM binding_records ORDER BY source,external_id').all(),
  };
}

test('staging retirement review, apply and restart stay indexed as selected rows and unrelated history grow', async () => {
  const reviewSamples: { scale: number; counted: ReturnType<typeof countedSample> }[] = [];
  const restartSamples: { scale: number; counted: ReturnType<typeof countedSample> }[] = [];
  const historySamples: { scale: number; counted: ReturnType<typeof countedSample> }[] = [];
  mkdirSync(temporaryRoot, { recursive: true });
  for (const scale of [32, 128, 512]) {
    const dir = mkdtempSync(join(temporaryRoot, 'staging-retirement-growth-'));
    const state = join(dir, 'state.sqlite');
    const planPath = join(dir, 'plan.json');
    try {
      const writer = new RunStore<SourceProjection>(state, { projectionMode: 'source-record' });
      let selectedId: string;
      try {
        complete(
          writer,
          source,
          Array.from({ length: 8 }, (_, i) => `B${i}`),
          1_000_000,
        );
        complete(
          writer,
          unrelated,
          Array.from({ length: scale }, (_, i) => `U${i}`),
          2_000_000,
        );
        const identity = captureIdentity({
          sha256: (3_000_000 + scale).toString(16).padStart(64, '0'),
          bytes: scale,
          sourceAlias: source,
          sourceKind: 'wikidata',
          converterRevision: 'test@1',
          disappearanceThreshold: 0.2,
        });
        const capture = writer.beginCheckpointed(source, identity);
        if (capture === 'busy') throw new Error('busy');
        selectedId = capture.id;
        for (let i = 0; i < scale; i++) {
          const key = `Q${i}`;
          const digest = (4_000_000 + i).toString(16).padStart(64, '0');
          writer.stage(capture, staged(source, key, digest));
          writer.commitStagingRecord(capture, { ordinal: i + 1, recordKey: key, digest });
        }
      } finally {
        writer.close();
      }
      const session = new ImportSession(state);
      try {
        const catalog = retentionCatalog(session.store.database);
        session.store.database.exec('ANALYZE');
        const before = snapshot(session.store.database);
        const probe = createSqliteProbe(session.store.database, { growingTables: RUN_TABLES });
        const reviewed = probe.measure(() =>
          reviewStagingRetirementOnDatabase(
            session.store.database,
            { source, generation: selectedId, statePath: state },
            catalog,
          ),
        );
        expect(reviewed.value.eligible).toBe(true);
        reviewSamples.push({
          scale,
          counted: countedSample([
            {
              'sqlite statements': reviewed.counts['sqlite statements'],
              'sqlite returned rows': reviewed.counts['sqlite returned rows'],
            },
          ]),
        });
        const planned = await buildStagingRetirementPlan({
          state,
          source,
          generation: selectedId,
          output: planPath,
        });
        const own = session.acquire(source);
        if (own === 'busy') throw new Error('busy');
        let crashed = false;
        try {
          probe.measure(() =>
            applyStagingRetirementOnDatabase(session.store.database, planned, session, own, state, catalog, {
              pageSize: 32,
              observer: {
                beforePage() {
                  if (!crashed) {
                    crashed = true;
                    throw new Error('growth-crash');
                  }
                },
              },
            }),
          );
        } catch (error) {
          expect((error as Error).message).toBe('growth-crash');
        }
        const restarted = probe.measure(() =>
          applyStagingRetirementOnDatabase(session.store.database, planned, session, own, state, catalog, {
            pageSize: 32,
          }),
        );
        probe.verifyPlans();
        expect(restarted.value.status).toBe('complete');
        restartSamples.push({
          scale,
          counted: countedSample([
            {
              'sqlite statements': restarted.counts['sqlite statements'],
              'sqlite returned rows': restarted.counts['sqlite returned rows'],
            },
          ]),
        });
        const after = snapshot(session.store.database);
        expect(after.sources).toEqual(before.sources);
        expect(after.ack).toEqual(before.ack);
        expect(after.payloads).toEqual(before.payloads);
        expect(after.bindings).toEqual(before.bindings);
        session.release(own);
      } finally {
        session.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const historic = mkdtempSync(join(temporaryRoot, 'staging-retirement-history-'));
    const historicState = join(historic, 'state.sqlite');
    try {
      const writer = new RunStore<SourceProjection>(historicState, { projectionMode: 'source-record' });
      try {
        for (let i = 0; i < scale; i++) {
          const run = writer.begin(source);
          if (run === 'busy') throw new Error('busy');
          writer.stage(run, staged(source, `H${i}`, (5_000_000 + i).toString(16).padStart(64, '0')));
          expect(writer.seal(run, { complete: true }).status).toBe('ready');
          expect(writer.abandon(run)).toBe('abandoned');
        }
        const identity = captureIdentity({
          sha256: 'ab'.repeat(32),
          bytes: 8,
          sourceAlias: source,
          sourceKind: 'wikidata',
          converterRevision: 'test@1',
          disappearanceThreshold: 0.2,
        });
        const capture = writer.beginCheckpointed(source, identity);
        if (capture === 'busy') throw new Error('busy');
        writer.stage(capture, staged(source, 'Q0', 'cd'.repeat(32)));
        writer.commitStagingRecord(capture, { ordinal: 1, recordKey: 'Q0', digest: 'cd'.repeat(32) });
        writer.database.exec('ANALYZE');
        const probe = createSqliteProbe(writer.database, { growingTables: RUN_TABLES });
        const catalog = retentionCatalog(writer.database);
        const reviewed = probe.measure(() =>
          reviewStagingRetirementOnDatabase(
            writer.database,
            { source, generation: capture.id, statePath: historicState },
            catalog,
          ),
        );
        probe.verifyPlans();
        expect(reviewed.value.eligible).toBe(true);
        historySamples.push({
          scale,
          counted: countedSample([
            {
              'sqlite statements': reviewed.counts['sqlite statements'],
              'sqlite returned rows': reviewed.counts['sqlite returned rows'],
            },
          ]),
        });
      } finally {
        writer.close();
      }
    } finally {
      rmSync(historic, { recursive: true, force: true });
    }
  }
  expect(countedViolations(constant, reviewSamples)).toEqual([]);
  expect(countedViolations(constant, historySamples)).toEqual([]);
  expect(countedViolations(linear, restartSamples)).toEqual([]);
});
