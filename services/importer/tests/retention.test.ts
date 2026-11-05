import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { runImportCli } from '../src/cli.ts';
import { ImportSession } from '../src/import-session.ts';
import { parseRetentionArgs } from '../src/retention-cli.ts';
import { RETENTION_DELETE_PHASES, applyRetentionPlan, type RetentionDeletePhase } from '../src/retention.ts';
import { RunStore, type SourceProjection } from '../src/run-store.ts';

const temporaryRoot = resolve(import.meta.dir, '../../../.temp');
const source = 'wikidata';
const other = 'bangumi';

function directory() {
  mkdirSync(temporaryRoot, { recursive: true });
  return mkdtempSync(join(temporaryRoot, 'retention-'));
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
  digest = 'a'.repeat(64),
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

function completePrepared(store: RunStore<SourceProjection>, recordSource: string, key: string) {
  const run = store.begin(recordSource);
  if (run === 'busy') throw new Error('busy');
  store.stage(run, staged(recordSource, key));
  store.retainConversionDiagnostics(run, {
    recordKey: key,
    digest: 'a'.repeat(64),
    converterRevision: 'test@1',
    recordRevision: 'revision-1',
    phase: 'staging',
    diagnostics: [{ pointer: '/labels', code: 'unsupported_label' }],
  });
  expect(store.seal(run, { complete: true }).status).toBe('ready');
  store.prepare(run, key, { commands: [command(recordSource, key)] });
  store.acknowledge(run, {
    results: [{ key: `cmd-${key}`, status: 201, value: { id: '00000000-0000-4000-8000-000000000001', revision: 1 } }],
  });
  expect(finish(store, run)).toBe('complete');
  return run;
}

function seedJourney(path: string) {
  const store = new RunStore<SourceProjection>(path, { projectionMode: 'source-record' });
  try {
    const retired = completePrepared(store, source, 'Q1');
    const baseline = completeIgnored(store, source, ['Q1', 'Q2'], 'b'.repeat(64));
    const otherRun = completeIgnored(store, other, ['B1']);
    const active = store.begin(source);
    if (active === 'busy') throw new Error('busy');
    store.stage(active, staged(source, 'Q1', 'b'.repeat(64)));
    store.stage(active, staged(source, 'Q2', 'b'.repeat(64)));
    store.stage(active, staged(source, 'Q3', 'c'.repeat(64)));
    expect(store.seal(active, { complete: true }).status).toBe('ready');
    for (const key of ['Q1', 'Q2']) {
      store.classify(active, key, { commands: [] });
      store.acknowledgeNoEffects(active, key, { reason: 'no-owned-candidates' });
    }
    store.prepare(active, 'Q3', { commands: [command(source, 'Q3', 'c'.repeat(64))] });
    const payload = store.database
      .query('SELECT command_key,body FROM run_payloads WHERE source=? ORDER BY command_key')
      .all(source) as { command_key: string; body: string }[];
    const ack = store.database
      .query('SELECT record_key,row_json FROM run_acknowledged WHERE source=? ORDER BY record_key')
      .all(source) as { record_key: string; row_json: string }[];
    return { retired: retired.id, baseline: baseline.id, active: active.id, other: otherRun.id, payload, ack };
  } finally {
    store.close();
  }
}

test('retention help is self-contained and rejects import-only options', async () => {
  expect(parseRetentionArgs(['--help'])).toBe('help');
  expect(() =>
    parseRetentionArgs(['--state', 'state.sqlite', '--source', 'wikidata', '--account-key', 'account.key']),
  ).toThrow('Unknown, import-only or repeated retention flag');
  expect(() => parseRetentionArgs(['--state', 'state.sqlite', '--apply'])).toThrow(
    'Apply requires --plan <path> and --confirm <plan-id>',
  );
  const help = await runImportCli(['retention', '--help']);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain('never contacts Auth');
  expect(help.openHandles).toBe(0);
});

test('operator retires a superseded complete capture, keeps authority, and resumes the live generation', async () => {
  const dir = directory();
  const state = join(dir, 'state.sqlite');
  const planPath = join(dir, 'plan.json');
  const seeded = seedJourney(state);
  const requests: string[] = [];
  const fetchBoundary = (async (input: Request | string | URL) => {
    requests.push(String(input instanceof Request ? input.url : input));
    throw new Error('retention must not use the network');
  }) as unknown as typeof fetch;
  try {
    const listed = await runImportCli(['retention', '--state', state, '--source', source, '--json'], {
      fetch: fetchBoundary,
    });
    expect(listed.code).toBe(0);
    const list = JSON.parse(listed.stdout) as {
      baseline: string;
      active: string;
      generations: { id: string; eligible: boolean; reason: string; pin: string; status: string }[];
    };
    expect(list.baseline).toBe(seeded.baseline);
    expect(list.active).toBe(seeded.active);
    const target = list.generations.find((row) => row.id === seeded.retired)!;
    expect(target).toMatchObject({ eligible: true, reason: 'superseded-complete', pin: 'none', status: 'complete' });
    expect(list.generations.find((row) => row.id === seeded.baseline)?.reason).toBe('completed-baseline');
    expect(list.generations.find((row) => row.id === seeded.active)?.reason).toBe('active-generation');
    const planned = await runImportCli(
      [
        'retention',
        '--state',
        state,
        '--source',
        source,
        '--generation',
        seeded.retired,
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
    const applied = await runImportCli(
      ['retention', '--state', state, '--plan', planPath, '--confirm', plan.planId, '--apply', '--json'],
      { fetch: fetchBoundary },
    );
    expect(applied.code).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      status: 'complete',
      retired: [seeded.retired],
      inProgress: [],
    });
    const inspect = await runImportCli([
      'inspect',
      '--state',
      state,
      '--source',
      source,
      '--generation',
      seeded.retired,
      '--json',
    ]);
    expect(inspect.code).toBe(0);
    expect(JSON.parse(inspect.stdout).generation).toMatchObject({ status: 'retired', phase: 'terminal' });
    expect(inspect.stdout).toContain('deliberately retired');
    const diagnostics = await runImportCli(
      ['diagnostics', '--state', state, '--source', source, '--generation', seeded.retired, '--format', 'json'],
      { fetch: fetchBoundary },
    );
    expect(diagnostics.code).toBe(0);
    expect(JSON.parse(diagnostics.stdout)).toMatchObject({ coverage: 'unavailable', status: 'retired' });
    const session = new ImportSession(state);
    try {
      expect(
        session.store.database
          .query('SELECT command_key,body FROM run_payloads WHERE source=? ORDER BY command_key')
          .all(source),
      ).toEqual(seeded.payload);
      expect(
        session.store.database
          .query('SELECT record_key,row_json FROM run_acknowledged WHERE source=? ORDER BY record_key')
          .all(source),
      ).toEqual(seeded.ack);
      const reopened = session.reopen(session.acquire(source) as Exclude<ReturnType<ImportSession['acquire']>, 'busy'>);
      expect(reopened?.id).toBe(seeded.active);
      session.store.acknowledge(reopened!, {
        results: [{ key: 'cmd-Q3', status: 201, value: { id: '00000000-0000-4000-8000-000000000002', revision: 1 } }],
      });
      expect(finish(session.store, reopened!)).toBe('complete');
      expect(
        session.store.database
          .query('SELECT COUNT(*) AS n FROM run_entries WHERE source=? AND run_id=?')
          .get(source, seeded.retired),
      ).toEqual({ n: 0 });
      expect(
        session.store.database
          .query('SELECT command_key,body FROM run_payloads WHERE source=? ORDER BY command_key')
          .all(source),
      ).toEqual(seeded.payload);
      const ackAfter = session.store.database
        .query('SELECT record_key,row_json FROM run_acknowledged WHERE source=? ORDER BY record_key')
        .all(source) as { record_key: string; row_json: string }[];
      expect(ackAfter.filter((row) => row.record_key !== 'Q3')).toEqual(seeded.ack);
      expect(ackAfter.some((row) => row.record_key === 'Q3')).toBe(true);
      expect(
        session.store.database
          .query('SELECT COUNT(*) AS n FROM run_entries WHERE source=? AND run_id=?')
          .get(other, seeded.other),
      ).toEqual({ n: 1 });
    } finally {
      session.close();
    }
    const again = await runImportCli(
      ['retention', '--state', state, '--plan', planPath, '--confirm', plan.planId, '--apply', '--json'],
      { fetch: fetchBoundary },
    );
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ status: 'complete', retired: [seeded.retired] });
    expect(requests).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply refuses missing confirmation, stale pins, unsafe paths, live owners and incomplete accounting', async () => {
  const dir = directory();
  const state = join(dir, 'state.sqlite');
  const seeded = seedJourney(state);
  try {
    expect(
      (await runImportCli(['retention', '--state', state, '--plan', join(dir, 'missing.json'), '--apply', '--json']))
        .code,
    ).toBe(2);
    const planPath = join(dir, 'plan.json');
    const planned = await runImportCli([
      'retention',
      '--state',
      state,
      '--source',
      source,
      '--generation',
      seeded.retired,
      '--output',
      planPath,
      '--json',
    ]);
    const plan = JSON.parse(planned.stdout) as { planId: string };
    const stale = await runImportCli([
      'retention',
      '--state',
      join(dir, 'absent.sqlite'),
      '--source',
      source,
      '--json',
    ]);
    expect(stale.code).toBe(2);
    expect(JSON.parse(stale.stdout).error).toContain('does not exist');
    const link = join(dir, 'linked.sqlite');
    symlinkSync(state, link);
    expect((await runImportCli(['retention', '--state', link, '--source', source, '--json'])).code).toBe(2);
    const unknown = await runImportCli([
      'retention',
      '--state',
      state,
      '--source',
      'openlibrary',
      '--generation',
      '1',
      '--output',
      join(dir, 'missing-source.json'),
      '--json',
    ]);
    expect(unknown.code).toBe(2);
    const later = new ImportSession(state);
    try {
      const own = later.acquire(source);
      if (own === 'busy') throw new Error('busy');
      const active = later.reopen(own);
      if (!active) throw new Error('missing active generation');
      later.store.acknowledge(active, {
        results: [{ key: 'cmd-Q3', status: 201, value: { id: '00000000-0000-4000-8000-000000000009', revision: 1 } }],
      });
      expect(finish(later.store, active)).toBe('complete');
      later.release(own);
    } finally {
      later.close();
    }
    const moved = await runImportCli([
      'retention',
      '--state',
      state,
      '--plan',
      planPath,
      '--confirm',
      plan.planId,
      '--apply',
      '--json',
    ]);
    expect(moved.code).toBe(2);
    expect(JSON.parse(moved.stdout).error).toContain('fresh explicit plan');
    const owner = new ImportSession(state);
    try {
      expect(owner.acquire(source) === 'busy' ? 'busy' : 'held').not.toBe('busy');
      const freshPlan = join(dir, 'fresh.json');
      const listed = await runImportCli(['retention', '--state', state, '--source', source, '--json']);
      const eligible = (
        JSON.parse(listed.stdout) as { generations: { id: string; eligible: boolean }[] }
      ).generations.find((row) => row.eligible);
      expect(eligible).toBeDefined();
      const rebuilt = await runImportCli([
        'retention',
        '--state',
        state,
        '--source',
        source,
        '--generation',
        eligible!.id,
        '--output',
        freshPlan,
        '--json',
      ]);
      const busy = await runImportCli([
        'retention',
        '--state',
        state,
        '--plan',
        freshPlan,
        '--confirm',
        JSON.parse(rebuilt.stdout).planId,
        '--apply',
        '--json',
      ]);
      expect(busy.code).toBe(5);
    } finally {
      owner.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tampered, ineligible and cancelled plans never expand the selected set', async () => {
  const dir = directory();
  const state = join(dir, 'state.sqlite');
  const seeded = seedJourney(state);
  try {
    const planPath = join(dir, 'plan.json');
    const planned = await runImportCli([
      'retention',
      '--state',
      state,
      '--source',
      source,
      '--generation',
      seeded.retired,
      '--output',
      planPath,
      '--json',
    ]);
    const plan = JSON.parse(planned.stdout) as Record<string, unknown>;
    writeFileSync(join(dir, 'tampered.json'), `${JSON.stringify({ ...plan, extra: true })}\n`, { mode: 0o600 });
    const tampered = await runImportCli([
      'retention',
      '--state',
      state,
      '--plan',
      join(dir, 'tampered.json'),
      '--confirm',
      plan.planId as string,
      '--apply',
      '--json',
    ]);
    expect(tampered.code).toBe(2);
    chmodSync(planPath, 0o644);
    expect(
      (
        await runImportCli([
          'retention',
          '--state',
          state,
          '--plan',
          planPath,
          '--confirm',
          plan.planId as string,
          '--apply',
          '--json',
        ])
      ).code,
    ).toBe(2);
    chmodSync(planPath, 0o600);
    const accounting = new RunStore<SourceProjection>(state, { projectionMode: 'source-record' });
    try {
      accounting.database
        .query('UPDATE run_entries SET remaining=1 WHERE source=? AND run_id=?')
        .run(source, seeded.retired);
    } finally {
      accounting.close();
    }
    const listed = await runImportCli(['retention', '--state', state, '--source', source, '--json']);
    expect(
      (JSON.parse(listed.stdout) as { generations: { id: string; reason: string }[] }).generations.find(
        (row) => row.id === seeded.retired,
      )?.reason,
    ).toBe('inconsistent-accounting');
    const ineligiblePlan = join(dir, 'ineligible.json');
    const ineligible = await runImportCli([
      'retention',
      '--state',
      state,
      '--source',
      source,
      '--generation',
      seeded.retired,
      '--output',
      ineligiblePlan,
      '--json',
    ]);
    expect(JSON.parse(ineligible.stdout).applyable).toBe(false);
    expect(
      (
        await runImportCli([
          'retention',
          '--state',
          state,
          '--plan',
          ineligiblePlan,
          '--confirm',
          JSON.parse(ineligible.stdout).planId,
          '--apply',
          '--json',
        ])
      ).code,
    ).toBe(2);
    const clean = directory();
    const cleanState = join(clean, 'state.sqlite');
    const cleanSeed = seedJourney(cleanState);
    const cleanPlan = join(clean, 'plan.json');
    const built = await runImportCli([
      'retention',
      '--state',
      cleanState,
      '--source',
      source,
      '--generation',
      cleanSeed.retired,
      '--output',
      cleanPlan,
      '--json',
    ]);
    const cancelled = await runImportCli(
      [
        'retention',
        '--state',
        cleanState,
        '--plan',
        cleanPlan,
        '--confirm',
        JSON.parse(built.stdout).planId,
        '--apply',
        '--json',
      ],
      { signal: AbortSignal.abort() },
    );
    expect(cancelled.code).toBe(130);
    expect(JSON.parse(cancelled.stdout).status).toBe('cancelled');
    rmSync(clean, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('crash in every deletion phase resumes the same plan without restoring removed rows', async () => {
  const dir = directory();
  try {
    for (const phase of RETENTION_DELETE_PHASES) {
      const state = join(dir, `${phase}.sqlite`);
      const seeded = seedJourney(state);
      const planPath = join(dir, `${phase}.json`);
      const planned = await runImportCli([
        'retention',
        '--state',
        state,
        '--source',
        source,
        '--generation',
        seeded.retired,
        '--output',
        planPath,
        '--json',
      ]);
      const planId = JSON.parse(planned.stdout).planId as string;
      let seen = false;
      try {
        await applyRetentionPlan(
          { state, plan: planPath, confirm: planId },
          {
            observer: {
              beforePage(input: { generation: string; phase: RetentionDeletePhase }) {
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
      const resumed = await applyRetentionPlan({ state, plan: planPath, confirm: planId });
      expect(resumed).toMatchObject({ status: 'complete', retired: [seeded.retired] });
      const store = new RunStore<SourceProjection>(state, { projectionMode: 'source-record' });
      try {
        expect(
          store.database
            .query('SELECT status FROM run_generations WHERE source=? AND id=?')
            .get(source, seeded.retired),
        ).toEqual({ status: 'retired' });
        expect(
          store.database
            .query('SELECT COUNT(*) AS n FROM run_entries WHERE source=? AND run_id=?')
            .get(source, seeded.retired),
        ).toEqual({ n: 0 });
        expect(
          store.database
            .query('SELECT COUNT(*) AS n FROM run_payloads WHERE source=? AND command_key=?')
            .get(source, 'cmd-Q1'),
        ).toEqual({ n: 1 });
      } finally {
        store.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
