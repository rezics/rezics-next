import { expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { runImportCli } from '../src/cli.ts';
import { ImportSession } from '../src/import-session.ts';
import { parseStagingRetirementArgs } from '../src/staging-retirement-cli.ts';
import {
  STAGING_RETIREMENT_DELETE_PHASES,
  applyStagingRetirementPlan,
  type StagingRetirementDeletePhase,
} from '../src/staging-retirement.ts';
import { captureIdentity } from '../src/staging-checkpoint.ts';
import { RETENTION_LOCAL_MAINTENANCE } from '../src/retention.ts';
import { RunStore, type SourceProjection } from '../src/run-store.ts';
import { Importer } from '../src/importer.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';
import { STAGING_RETIRED_GENERATION } from '../src/staging-checkpoint.ts';

const temporaryRoot = resolve(import.meta.dir, '../../../.temp');
const source = 'wikidata';
const other = 'bangumi';

function directory() {
  mkdirSync(temporaryRoot, { recursive: true });
  return mkdtempSync(join(temporaryRoot, 'staging-retirement-'));
}

function staged(recordSource: string, key: string, digest = 'a'.repeat(64)) {
  return {
    row: {
      source: recordSource,
      recordKey: key,
      recordRevision: 'revision-1',
      digest,
      converter_revision: 'test@1',
      state: 'present' as const,
    },
    projection: {
      sourceKind: 'wikidata' as const,
      normalizedRecord: { id: key, type: 'item', labels: {}, descriptions: {}, aliases: {}, claims: {} },
    } satisfies SourceProjection,
  };
}

function command(recordSource: string, recordKey: string, digest = 'a'.repeat(64)): BatchCommand {
  return {
    op: 'create',
    key: `cmd-${recordKey}`,
    source: {
      source: recordSource,
      external_id: recordKey,
      record_revision: 'revision-1',
      digest,
      converter_revision: 'test@1',
      field_group: 'facts',
    },
    subject: { type: 'item', labels: { en: 'Private request body sentinel' } },
  };
}

function finish(store: RunStore<SourceProjection>, run: Exclude<ReturnType<RunStore['begin']>, 'busy'>) {
  let result = store.finalize(run, 100);
  while (result === 'more') result = store.finalize(run, 100);
  return result;
}

function completeIgnored(
  store: RunStore<SourceProjection>,
  recordSource: string,
  keys: readonly string[],
  digest = 'b'.repeat(64),
) {
  const run = store.begin(recordSource);
  if (run === 'busy') throw new Error('busy');
  for (const key of keys) store.stage(run, staged(recordSource, key, digest));
  expect(store.seal(run, { complete: true }).status).toBe('ready');
  for (const key of keys) {
    store.classify(run, key, { commands: [] });
    store.acknowledgeNoEffects(run, key, { reason: 'no-owned-candidates' });
  }
  expect(finish(store, run)).toBe('complete');
  return run;
}

function identityFor(alias: string) {
  return captureIdentity({
    sha256: 'c'.repeat(64),
    bytes: 32,
    sourceAlias: alias,
    sourceKind: 'wikidata',
    converterRevision: 'test@1',
    disappearanceThreshold: 0.2,
  });
}

function seedJourney(path: string) {
  const store = new RunStore<SourceProjection>(path, { projectionMode: 'source-record' });
  try {
    const baseline = completeIgnored(store, source, ['Q1', 'Q2']);
    const otherRun = completeIgnored(store, other, ['B1'], 'd'.repeat(64));
    const pending = store.begin(other);
    if (pending === 'busy') throw new Error('busy');
    store.stage(pending, staged(other, 'B1', 'd'.repeat(64)));
    store.stage(pending, staged(other, 'B2', 'e'.repeat(64)));
    expect(store.seal(pending, { complete: true }).status).toBe('ready');
    store.classify(pending, 'B1', { commands: [] });
    store.acknowledgeNoEffects(pending, 'B1', { reason: 'no-owned-candidates' });
    store.prepare(pending, 'B2', { commands: [command(other, 'B2', 'e'.repeat(64))] });
    const capture = store.beginCheckpointed(source, identityFor(source));
    if (capture === 'busy') throw new Error('busy');
    store.stage(capture, staged(source, 'Q3', 'f'.repeat(64)));
    store.commitStagingRecord(capture, { ordinal: 1, recordKey: 'Q3', digest: 'f'.repeat(64) });
    store.retainConversionDiagnostics(capture, {
      recordKey: 'Q3',
      digest: 'f'.repeat(64),
      converterRevision: 'test@1',
      recordRevision: 'revision-1',
      phase: 'staging',
      diagnostics: [{ pointer: '/labels', code: 'unsupported_label' }],
    });
    const payload = store.database
      .query('SELECT command_key,body FROM run_payloads WHERE source=? ORDER BY command_key')
      .all(other) as { command_key: string; body: string }[];
    const ack = store.database
      .query('SELECT record_key,row_json FROM run_acknowledged WHERE source=? ORDER BY record_key')
      .all(source) as { record_key: string; row_json: string }[];
    const members = store.database
      .query('SELECT record_key,row_json FROM run_members WHERE source=? ORDER BY record_key')
      .all(source) as { record_key: string; row_json: string }[];
    const pins = store.database
      .query('SELECT generation,present_count,sequence FROM run_sources WHERE source=?')
      .get(source) as { generation: string; present_count: number; sequence: number };
    return {
      baseline: baseline.id,
      capture: capture.id,
      other: otherRun.id,
      pending: pending.id,
      payload,
      ack,
      members,
      pins,
    };
  } finally {
    store.close();
  }
}

test('staging retirement help is self-contained and rejects import-only options', async () => {
  expect(parseStagingRetirementArgs(['--help'])).toBe('help');
  expect(() =>
    parseStagingRetirementArgs(['--state', 'state.sqlite', '--source', 'wikidata', '--account-key', 'account.key']),
  ).toThrow('Unknown, import-only or repeated staging retirement flag');
  const help = await runImportCli(['retire-staging', '--help']);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain('never contacts Auth');
  expect(help.stdout).toContain('VNDB table acquisitions');
  expect(help.openHandles).toBe(0);
});

test('operator reviews and retires one unpublished capture, resumes cleanup, and keeps baseline authority', async () => {
  const dir = directory();
  const state = join(dir, 'state.sqlite');
  const planPath = join(dir, 'plan.json');
  const seeded = seedJourney(state);
  const requests: string[] = [];
  const fetchBoundary = (async (input: Request | string | URL) => {
    requests.push(String(input instanceof Request ? input.url : input));
    throw new Error('staging retirement must not use the network');
  }) as unknown as typeof fetch;
  try {
    const listedRetention = await runImportCli(['retention', '--state', state, '--source', source, '--json'], {
      fetch: fetchBoundary,
    });
    expect(
      (JSON.parse(listedRetention.stdout) as { generations: { id: string; reason: string }[] }).generations.find(
        (row) => row.id === seeded.capture,
      )?.reason,
    ).toBe('active-generation');
    const reviewed = await runImportCli(
      ['retire-staging', '--state', state, '--source', source, '--generation', seeded.capture, '--json'],
      { fetch: fetchBoundary },
    );
    expect(reviewed.code).toBe(0);
    expect(JSON.parse(reviewed.stdout)).toMatchObject({
      eligible: true,
      reason: 'unpublished-staging',
      status: 'staging',
      baseline: seeded.baseline,
    });
    const before = readFileSync(state);
    const cancelledReview = await runImportCli(
      ['retire-staging', '--state', state, '--source', source, '--generation', seeded.capture, '--json'],
      { fetch: fetchBoundary, signal: AbortSignal.abort() },
    );
    expect(cancelledReview.code).toBe(130);
    expect(readFileSync(state)).toEqual(before);
    const planned = await runImportCli(
      [
        'retire-staging',
        '--state',
        state,
        '--source',
        source,
        '--generation',
        seeded.capture,
        '--output',
        planPath,
        '--json',
      ],
      { fetch: fetchBoundary },
    );
    expect(planned.code).toBe(0);
    expect((statSync(planPath).mode & 0o777) === 0o600).toBe(true);
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as { planId: string; applyable: boolean };
    expect(plan.applyable).toBe(true);
    let crashed = false;
    try {
      await applyStagingRetirementPlan(
        { state, plan: planPath, confirm: plan.planId },
        {
          pageSize: 1,
          observer: {
            beforePage(input: { generation: string; phase: StagingRetirementDeletePhase }) {
              if (input.phase === 'entries' && !crashed) {
                crashed = true;
                throw new Error('crash:entries');
              }
            },
          },
        },
      );
      throw new Error('expected crash');
    } catch (error) {
      expect((error as Error).message).toBe('crash:entries');
    }
    const transport = {
      setSourceRecordMetadata: sourceRecordMetadataFixture().setSourceRecordMetadata,
      async batchWrite() {
        throw new Error('native must not run during local maintenance');
      },
      async readFence() {
        return { fenced: false, securityRevision: null };
      },
    };
    const importer = new Importer({ path: state, transport });
    try {
      const blocked = await importer.runRecords(createSourceRegistration(source), (async function* () {})());
      expect(blocked.status).toBe('busy');
      expect(blocked.diagnostic).toBe(RETENTION_LOCAL_MAINTENANCE);
    } finally {
      await importer.close();
    }
    const otherSession = new ImportSession(state);
    try {
      const own = otherSession.acquire(other);
      expect(own === 'busy' ? 'busy' : 'held').not.toBe('busy');
      if (own !== 'busy') otherSession.release(own);
    } finally {
      otherSession.close();
    }
    const resumed = await runImportCli(
      ['retire-staging', '--state', state, '--plan', planPath, '--confirm', plan.planId, '--apply', '--json'],
      { fetch: fetchBoundary },
    );
    expect(resumed.code).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({
      status: 'complete',
      retired: [seeded.capture],
      inProgress: [],
    });
    const inspect = await runImportCli([
      'inspect',
      '--state',
      state,
      '--source',
      source,
      '--generation',
      seeded.capture,
      '--json',
    ]);
    expect(inspect.code).toBe(0);
    expect(JSON.parse(inspect.stdout).generation).toMatchObject({ status: 'retired', phase: 'terminal' });
    expect(inspect.stdout).toContain('cannot be resumed or recreated');
    const diagnostics = await runImportCli(
      ['diagnostics', '--state', state, '--source', source, '--generation', seeded.capture, '--format', 'json'],
      { fetch: fetchBoundary },
    );
    expect(diagnostics.code).toBe(0);
    expect(JSON.parse(diagnostics.stdout)).toMatchObject({ coverage: 'unavailable', status: 'retired' });
    const session = new ImportSession(state);
    try {
      expect(
        session.store.database
          .query('SELECT generation,present_count,sequence FROM run_sources WHERE source=?')
          .get(source),
      ).toEqual(seeded.pins);
      expect(
        session.store.database
          .query('SELECT record_key,row_json FROM run_acknowledged WHERE source=? ORDER BY record_key')
          .all(source),
      ).toEqual(seeded.ack);
      expect(
        session.store.database
          .query('SELECT record_key,row_json FROM run_members WHERE source=? ORDER BY record_key')
          .all(source),
      ).toEqual(seeded.members);
      expect(
        session.store.database
          .query('SELECT command_key,body FROM run_payloads WHERE source=? ORDER BY command_key')
          .all(other),
      ).toEqual(seeded.payload);
      expect(
        session.store.database
          .query('SELECT COUNT(*) AS n FROM run_entries WHERE source=? AND run_id=?')
          .get(source, seeded.capture),
      ).toEqual({ n: 0 });
      expect(session.store.peekGeneration(source, seeded.capture)).toMatchObject({ status: 'retired', prepared: 0 });
      expect(session.store.stagingCheckpoint(source, seeded.capture)).toBeNull();
    } finally {
      session.close();
    }
    const resumeOld = new Importer({ path: state, transport });
    try {
      const refused = await resumeOld.runRecords(createSourceRegistration(source), (async function* () {})(), {
        checkpoint: { action: 'resume', generation: seeded.capture, identity: identityFor(source) },
      });
      expect(refused.status).toBe('invalid-dump');
      expect(refused.diagnostic).toBe(STAGING_RETIRED_GENERATION);
    } finally {
      await resumeOld.close();
    }
    const again = await runImportCli(
      ['retire-staging', '--state', state, '--plan', planPath, '--confirm', plan.planId, '--apply', '--json'],
      { fetch: fetchBoundary },
    );
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ status: 'complete', retired: [seeded.capture] });
    expect(requests).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test('sealed, pending, busy, incompatible and ambiguous state is refused', async () => {
  const dir = directory();
  const state = join(dir, 'state.sqlite');
  const seeded = seedJourney(state);
  try {
    const missing = await runImportCli([
      'retire-staging',
      '--state',
      state,
      '--source',
      source,
      '--generation',
      '99',
      '--json',
    ]);
    expect(JSON.parse(missing.stdout).reason).toBe('missing');
    const ineligibleDir = directory();
    const ineligibleState = join(ineligibleDir, 'state.sqlite');
    try {
      const writer = new RunStore<SourceProjection>(ineligibleState, { projectionMode: 'source-record' });
      try {
        completeIgnored(writer, source, ['Q1']);
        const readyRun = writer.begin(source);
        if (readyRun === 'busy') throw new Error('busy');
        writer.stage(readyRun, staged(source, 'Q1', 'b'.repeat(64)));
        writer.stage(readyRun, staged(source, 'Q9', '9'.repeat(64)));
        expect(writer.seal(readyRun, { complete: true }).status).toBe('ready');
        writer.classify(readyRun, 'Q1', { commands: [] });
        writer.acknowledgeNoEffects(readyRun, 'Q1', { reason: 'no-owned-candidates' });
        const readyReview = await runImportCli([
          'retire-staging',
          '--state',
          ineligibleState,
          '--source',
          source,
          '--generation',
          readyRun.id,
          '--json',
        ]);
        expect(JSON.parse(readyReview.stdout)).toMatchObject({ eligible: false, reason: 'status-ineligible' });
        writer.prepare(readyRun, 'Q9', { commands: [command(source, 'Q9', '9'.repeat(64))] });
        writer.database
          .query('UPDATE run_generations SET status=? WHERE source=? AND id=?')
          .run('staging', source, readyRun.id);
        const fabricatedReview = await runImportCli([
          'retire-staging',
          '--state',
          ineligibleState,
          '--source',
          source,
          '--generation',
          readyRun.id,
          '--json',
        ]);
        expect(JSON.parse(fabricatedReview.stdout)).toMatchObject({ eligible: false, reason: 'prepared-or-effect' });
      } finally {
        writer.close();
      }
    } finally {
      rmSync(ineligibleDir, { recursive: true, force: true });
    }
    const writer = new RunStore<SourceProjection>(state, { projectionMode: 'source-record' });
    try {
      writer.database
        .query('UPDATE run_staging_checkpoints SET sha256=? WHERE source=? AND run_id=?')
        .run('not-a-digest', source, seeded.capture);
      const corrupt = await runImportCli([
        'retire-staging',
        '--state',
        state,
        '--source',
        source,
        '--generation',
        seeded.capture,
        '--json',
      ]);
      expect(JSON.parse(corrupt.stdout)).toMatchObject({ eligible: false, reason: 'corrupt-checkpoint' });
      writer.database
        .query('UPDATE run_staging_checkpoints SET sha256=? WHERE source=? AND run_id=?')
        .run('c'.repeat(64), source, seeded.capture);
    } finally {
      writer.close();
    }
    const planPath = join(dir, 'stale.json');
    const planned = await runImportCli([
      'retire-staging',
      '--state',
      state,
      '--source',
      source,
      '--generation',
      seeded.capture,
      '--output',
      planPath,
      '--json',
    ]);
    const plan = JSON.parse(planned.stdout) as { planId: string };
    const concurrent = new RunStore<SourceProjection>(state, { projectionMode: 'source-record' });
    try {
      const active = concurrent.database
        .query('SELECT id,lease FROM run_generations WHERE source=? AND id=?')
        .get(source, seeded.capture) as { id: string; lease: string };
      concurrent.stage({ source, id: active.id, lease: active.lease }, staged(source, 'Q4', '4'.repeat(64)));
    } finally {
      concurrent.close();
    }
    const stale = await runImportCli([
      'retire-staging',
      '--state',
      state,
      '--plan',
      planPath,
      '--confirm',
      plan.planId,
      '--apply',
      '--json',
    ]);
    expect(stale.code).toBe(2);
    expect(JSON.parse(stale.stdout).error).toContain('fresh explicit plan');
    const owner = new ImportSession(state);
    try {
      expect(owner.acquire(source) === 'busy' ? 'busy' : 'held').not.toBe('busy');
      const fresh = join(dir, 'fresh.json');
      const rebuilt = await runImportCli([
        'retire-staging',
        '--state',
        state,
        '--source',
        source,
        '--generation',
        seeded.capture,
        '--output',
        fresh,
        '--json',
      ]);
      const busy = await runImportCli([
        'retire-staging',
        '--state',
        state,
        '--plan',
        fresh,
        '--confirm',
        JSON.parse(rebuilt.stdout).planId,
        '--apply',
        '--json',
      ]);
      expect(busy.code).toBe(5);
    } finally {
      owner.close();
    }
    const uninspectable = join(dir, 'uninspectable.json');
    const rebuiltBusy = await runImportCli([
      'retire-staging',
      '--state',
      state,
      '--source',
      source,
      '--generation',
      seeded.capture,
      '--output',
      uninspectable,
      '--json',
    ]);
    const planted = new RunStore<SourceProjection>(state, { projectionMode: 'source-record' });
    try {
      planted.database.exec(`CREATE TABLE IF NOT EXISTS import_owners (
        source TEXT PRIMARY KEY, pid INTEGER NOT NULL, birth TEXT NOT NULL,
        capability TEXT NOT NULL) WITHOUT ROWID`);
      planted.database
        .query('INSERT INTO import_owners(source,pid,birth,capability) VALUES(?,?,?,?)')
        .run(source, 1, 'not-a-birth', 'x'.repeat(48));
    } finally {
      planted.close();
    }
    const refused = await runImportCli([
      'retire-staging',
      '--state',
      state,
      '--plan',
      uninspectable,
      '--confirm',
      JSON.parse(rebuiltBusy.stdout).planId,
      '--apply',
      '--json',
    ]);
    expect(refused.code).toBe(5);
    const cleared = new RunStore<SourceProjection>(state, { projectionMode: 'source-record' });
    try {
      cleared.database.query('DELETE FROM import_owners WHERE source=?').run(source);
    } finally {
      cleared.close();
    }
    const missingState = await runImportCli([
      'retire-staging',
      '--state',
      join(dir, 'absent.sqlite'),
      '--source',
      source,
      '--generation',
      '1',
      '--json',
    ]);
    expect(missingState.code).toBe(2);
    expect(JSON.parse(missingState.stdout).error).toContain('does not exist');
    const copy = join(dir, 'replaced.sqlite');
    copyFileSync(state, copy);
    const replacedPlan = join(dir, 'replaced.json');
    const replaced = await runImportCli([
      'retire-staging',
      '--state',
      state,
      '--source',
      source,
      '--generation',
      seeded.capture,
      '--output',
      replacedPlan,
      '--json',
    ]);
    const moved = await runImportCli([
      'retire-staging',
      '--state',
      copy,
      '--plan',
      replacedPlan,
      '--confirm',
      JSON.parse(replaced.stdout).planId,
      '--apply',
      '--json',
    ]);
    expect(moved.code).toBe(2);
    expect(JSON.parse(moved.stdout).error).toContain('State file identity');
    const aborted = await runImportCli(
      [
        'retire-staging',
        '--state',
        state,
        '--plan',
        replacedPlan,
        '--confirm',
        JSON.parse(replaced.stdout).planId,
        '--apply',
        '--json',
      ],
      { signal: AbortSignal.abort() },
    );
    expect(aborted.code).toBe(130);
    expect(JSON.parse(aborted.stdout).status).toBe('cancelled');
    const owners = new RunStore<SourceProjection>(state, { projectionMode: 'source-record' });
    try {
      expect(owners.database.query('SELECT capability FROM import_owners WHERE source=?').get(source)).toBeNull();
    } finally {
      owners.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test('crash in every staging retirement phase resumes the same plan', async () => {
  const dir = directory();
  try {
    for (const phase of STAGING_RETIREMENT_DELETE_PHASES) {
      const state = join(dir, `${phase}.sqlite`);
      const seeded = seedJourney(state);
      const planPath = join(dir, `${phase}.json`);
      const planned = await runImportCli([
        'retire-staging',
        '--state',
        state,
        '--source',
        source,
        '--generation',
        seeded.capture,
        '--output',
        planPath,
        '--json',
      ]);
      const planId = JSON.parse(planned.stdout).planId as string;
      let seen = false;
      try {
        await applyStagingRetirementPlan(
          { state, plan: planPath, confirm: planId },
          {
            pageSize: 1,
            observer: {
              beforePage(input: { generation: string; phase: StagingRetirementDeletePhase }) {
                if (input.phase === phase && !seen) {
                  seen = true;
                  throw new Error(`crash:${phase}`);
                }
              },
            },
          },
        );
        throw new Error(`expected crash in ${phase}`);
      } catch (error) {
        expect((error as Error).message).toBe(`crash:${phase}`);
      }
      const resumed = await applyStagingRetirementPlan({ state, plan: planPath, confirm: planId });
      expect(resumed).toMatchObject({ status: 'complete', retired: [seeded.capture] });
      const store = new RunStore<SourceProjection>(state, { projectionMode: 'source-record' });
      try {
        expect(
          store.database
            .query('SELECT status FROM run_generations WHERE source=? AND id=?')
            .get(source, seeded.capture),
        ).toEqual({ status: 'retired' });
        expect(
          store.database.query('SELECT generation,present_count,sequence FROM run_sources WHERE source=?').get(source),
        ).toEqual(seeded.pins);
        expect(
          store.database
            .query('SELECT command_key,body FROM run_payloads WHERE source=? ORDER BY command_key')
            .all(other),
        ).toEqual(seeded.payload);
      } finally {
        store.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
