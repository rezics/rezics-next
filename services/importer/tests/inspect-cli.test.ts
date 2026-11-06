import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseInspectionArgs, runInspectCli } from '../src/inspect-cli.ts';
import { RunStore, type Run, type SourceProjection } from '../src/run-store.ts';

const KIND_COLUMNS = [
  'kind_new',
  'kind_changed',
  'kind_unchanged',
  'kind_vanished',
  'kind_backfill_cursor',
  'kind_backfill_done',
] as const;

const temporaryRoot = resolve(import.meta.dir, '../../../.temp');

function temporaryState() {
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(join(temporaryRoot, 'inspect-cli-'));
  const path = join(directory, 'state.sqlite');
  const database = new Database(path, { create: true, strict: true });
  const store = new RunStore<SourceProjection>(database, { projectionMode: 'source-record' });
  return {
    directory,
    path,
    store,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function staged(source: string, key: string, digest = 'a'.repeat(64)) {
  return {
    row: {
      source,
      recordKey: key,
      recordRevision: digest === 'a'.repeat(64) ? 'revision-1' : 'revision-2',
      digest,
      converter_revision: 'test@1',
      state: 'present' as const,
    },
    projection: {
      sourceKind: 'wikidata' as const,
      normalizedRecord: { id: key, type: 'item', labels: {}, descriptions: {}, aliases: {}, claims: {} },
    },
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

function dropKindColumns(path: string, extra: readonly string[] = []): void {
  const database = new Database(path);
  try {
    const names = new Set(
      database
        .query('PRAGMA table_info(run_generations)')
        .all()
        .map((row) => (row as { name: string }).name),
    );
    for (const column of [...KIND_COLUMNS, ...extra]) {
      if (names.has(column)) database.exec(`ALTER TABLE run_generations DROP COLUMN ${column}`);
    }
  } finally {
    database.close();
  }
}

function addZeroKindColumns(path: string): void {
  const database = new Database(path);
  try {
    database.exec('ALTER TABLE run_generations ADD COLUMN kind_new INTEGER NOT NULL DEFAULT 0');
    database.exec('ALTER TABLE run_generations ADD COLUMN kind_changed INTEGER NOT NULL DEFAULT 0');
    database.exec('ALTER TABLE run_generations ADD COLUMN kind_unchanged INTEGER NOT NULL DEFAULT 0');
    database.exec('ALTER TABLE run_generations ADD COLUMN kind_vanished INTEGER NOT NULL DEFAULT 0');
  } finally {
    database.close();
  }
}

async function inspectCounts(path: string, source: string) {
  const json = await runInspectCli(['--state', path, '--source', source, '--json']);
  expect(json.code).toBe(0);
  const document = JSON.parse(json.stdout) as {
    generation: {
      counts: {
        classified: number;
        new: number | null;
        changed: number | null;
        unchanged: number | null;
        vanished: number | null;
      };
    };
  };
  return document.generation.counts;
}

test('inspection help is self-contained and rejects every import-only option', async () => {
  expect(parseInspectionArgs(['--help'])).toBe('help');
  expect(() =>
    parseInspectionArgs(['--state', 'state.sqlite', '--source', 'wikidata', '--account-key', 'account.key']),
  ).toThrow('Unknown, import-only or repeated inspection flag');
  expect(() => parseInspectionArgs(['--state', 'state.sqlite', '--source', 'wikidata', '--limit', '20'])).toThrow(
    '--limit requires --page',
  );
  expect(() =>
    parseInspectionArgs(['--state', 'state.sqlite', '--source', 'wikidata', '--page', 'pending', '--limit', '020']),
  ).toThrow('integer from 1 through 100');
  const help = await runInspectCli(['--help']);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain('local and read-only');
  expect(help.stdout).toContain('recorded API origin');
  expect(help.openHandles).toBe(0);
});

test('inspect reports stored classified new/changed/unchanged/vanished without a journal COUNT', async () => {
  const fixture = temporaryState();
  try {
    const source = 'wikidata';
    const baseline = fixture.store.begin(source);
    if (baseline === 'busy') throw new Error('Expected a new baseline generation');
    const prior = ['Q-GONE', 'Q-STABLE', 'Q-CHANGED', 'Q-KEEP1', 'Q-KEEP2', 'Q-KEEP3'];
    for (const key of prior) fixture.store.stage(baseline, staged(source, key));
    complete(fixture.store, baseline, prior);

    const run = fixture.store.begin(source);
    if (run === 'busy') throw new Error('Expected an active generation');
    fixture.store.stage(run, staged(source, 'Q-STABLE'));
    fixture.store.stage(run, staged(source, 'Q-CHANGED', 'b'.repeat(64)));
    for (const key of ['Q-KEEP1', 'Q-KEEP2', 'Q-KEEP3']) fixture.store.stage(run, staged(source, key));
    fixture.store.stage(run, staged(source, 'Q-NEW'));
    expect(fixture.store.seal(run, { complete: true }).status).toBe('ready');
    expect(fixture.store.classify(run, 'Q-NEW', { commands: [] })).toBe('new');
    expect(fixture.store.classify(run, 'Q-CHANGED', { commands: [] })).toBe('changed');
    expect(fixture.store.classify(run, 'Q-STABLE', { commands: [] })).toBe('unchanged');
    for (const key of ['Q-KEEP1', 'Q-KEEP2', 'Q-KEEP3'])
      expect(fixture.store.classify(run, key, { commands: [] })).toBe('unchanged');
    expect(fixture.store.classify(run, 'Q-GONE', { commands: [] })).toBe('vanished');

    const json = await runInspectCli(['--state', fixture.path, '--source', source, '--json']);
    expect(json.code).toBe(0);
    expect(json.stderr).toBe('');
    const document = JSON.parse(json.stdout) as {
      generation: { counts: { classified: number; new: number; changed: number; unchanged: number; vanished: number } };
    };
    expect(document.generation.counts).toMatchObject({
      classified: 7,
      new: 1,
      changed: 1,
      unchanged: 4,
      vanished: 1,
    });

    const text = await runInspectCli(['--state', fixture.path, '--source', source]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('classified records: new=1 changed=1 unchanged=4 vanished=1');
    expect(text.stdout).not.toContain('Private');
  } finally {
    fixture.close();
  }
});

test('inspect stays scan-free on an unrecovered pre-column journal and reopen rebuilds exact kinds', async () => {
  const fixture = temporaryState();
  try {
    const source = 'wikidata';
    const baseline = fixture.store.begin(source);
    if (baseline === 'busy') throw new Error('Expected a new baseline generation');
    const prior = ['Q-GONE', 'Q-STABLE', 'Q-CHANGED', 'Q-KEEP1', 'Q-KEEP2', 'Q-KEEP3'];
    for (const key of prior) fixture.store.stage(baseline, staged(source, key));
    complete(fixture.store, baseline, prior);

    const run = fixture.store.begin(source);
    if (run === 'busy') throw new Error('Expected an active generation');
    fixture.store.stage(run, staged(source, 'Q-STABLE'));
    fixture.store.stage(run, staged(source, 'Q-CHANGED', 'b'.repeat(64)));
    for (const key of ['Q-KEEP1', 'Q-KEEP2', 'Q-KEEP3']) fixture.store.stage(run, staged(source, key));
    fixture.store.stage(run, staged(source, 'Q-NEW'));
    expect(fixture.store.seal(run, { complete: true }).status).toBe('ready');
    expect(fixture.store.classify(run, 'Q-NEW', { commands: [] })).toBe('new');
    expect(fixture.store.classify(run, 'Q-CHANGED', { commands: [] })).toBe('changed');
    expect(fixture.store.classify(run, 'Q-STABLE', { commands: [] })).toBe('unchanged');
    for (const key of ['Q-KEEP1', 'Q-KEEP2', 'Q-KEEP3'])
      expect(fixture.store.classify(run, key, { commands: [] })).toBe('unchanged');
    expect(fixture.store.classify(run, 'Q-GONE', { commands: [] })).toBe('vanished');
    fixture.store.close();
    dropKindColumns(fixture.path);
    addZeroKindColumns(fixture.path);

    const unrecovered = await inspectCounts(fixture.path, source);
    expect(unrecovered).toMatchObject({ classified: 7, new: 0, changed: 0, unchanged: 0, vanished: 0 });

    const recovered = new RunStore<SourceProjection>(fixture.path, { projectionMode: 'source-record' });
    recovered.close();
    expect(await inspectCounts(fixture.path, source)).toMatchObject({
      classified: 7,
      new: 1,
      changed: 1,
      unchanged: 4,
      vanished: 1,
    });
    const text = await runInspectCli(['--state', fixture.path, '--source', source]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('classified records: new=1 changed=1 unchanged=4 vanished=1');
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('interrupted kind recovery resumes from the stored cursor', async () => {
  const fixture = temporaryState();
  try {
    const source = 'wikidata';
    const baseline = fixture.store.begin(source);
    if (baseline === 'busy') throw new Error('Expected a new baseline generation');
    fixture.store.stage(baseline, staged(source, 'Q1'));
    complete(fixture.store, baseline, ['Q1']);
    const run = fixture.store.begin(source);
    if (run === 'busy') throw new Error('Expected an active generation');
    for (const key of ['Q1', 'Q2', 'Q3', 'Q4', 'Q5']) fixture.store.stage(run, staged(source, key));
    expect(fixture.store.seal(run, { complete: true }).status).toBe('ready');
    for (const key of ['Q1', 'Q2', 'Q3', 'Q4', 'Q5']) fixture.store.classify(run, key, { commands: [] });
    fixture.store.close();
    dropKindColumns(fixture.path);

    const partial = new RunStore<SourceProjection>(fixture.path, {
      projectionMode: 'source-record',
      kindBackfillPageSize: 2,
      kindBackfillMaxPages: 1,
    });
    const paused = partial.database
      .query(
        'SELECT kind_new,kind_changed,kind_unchanged,kind_vanished,kind_backfill_cursor,kind_backfill_done FROM run_generations WHERE source=? AND id=?',
      )
      .get(source, '2') as {
      kind_new: number;
      kind_changed: number;
      kind_unchanged: number;
      kind_vanished: number;
      kind_backfill_cursor: string;
      kind_backfill_done: number;
    };
    expect(paused.kind_backfill_done).toBe(0);
    expect(paused.kind_backfill_cursor).toBe('Q2');
    expect(paused.kind_new + paused.kind_changed + paused.kind_unchanged + paused.kind_vanished).toBe(2);
    partial.close();
    expect(await inspectCounts(fixture.path, source)).toMatchObject({ classified: 5, new: 2, unchanged: 0 });

    const resumed = new RunStore<SourceProjection>(fixture.path, { projectionMode: 'source-record' });
    resumed.close();
    expect(await inspectCounts(fixture.path, source)).toMatchObject({
      classified: 5,
      new: 4,
      changed: 0,
      unchanged: 1,
      vanished: 0,
    });
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('classification interleaves with partial kind recovery without double-counting', async () => {
  const fixture = temporaryState();
  try {
    const source = 'wikidata';
    const baseline = fixture.store.begin(source);
    if (baseline === 'busy') throw new Error('Expected a new baseline generation');
    const prior = ['Q-GONE', 'Q-STABLE', 'Q-CHANGED', 'Q-KEEP1'];
    for (const key of prior) fixture.store.stage(baseline, staged(source, key));
    complete(fixture.store, baseline, prior);

    const run = fixture.store.begin(source);
    if (run === 'busy') throw new Error('Expected an active generation');
    fixture.store.stage(run, staged(source, 'Q-STABLE'));
    fixture.store.stage(run, staged(source, 'Q-CHANGED', 'b'.repeat(64)));
    fixture.store.stage(run, staged(source, 'Q-KEEP1'));
    fixture.store.stage(run, staged(source, 'Q-NEW'));
    expect(fixture.store.seal(run, { complete: true }).status).toBe('ready');
    expect(fixture.store.classify(run, 'Q-CHANGED', { commands: [] })).toBe('changed');
    expect(fixture.store.classify(run, 'Q-KEEP1', { commands: [] })).toBe('unchanged');
    expect(fixture.store.classify(run, 'Q-STABLE', { commands: [] })).toBe('unchanged');
    expect(fixture.store.classify(run, 'Q-GONE', { commands: [] })).toBe('vanished');
    fixture.store.close();
    dropKindColumns(fixture.path);

    const store = new RunStore<SourceProjection>(fixture.path, {
      projectionMode: 'source-record',
      kindBackfillPageSize: 2,
      kindBackfillMaxPages: 1,
    });
    const active = store.peekActive(source);
    if (!active) throw new Error('Expected the sealed generation to remain leased');
    expect(store.classify(active.run, 'Q-NEW', { commands: [] })).toBe('new');
    expect(store.classify(active.run, 'Q-GONE', { commands: [] })).toBe('vanished');
    while (store.recoverClassifiedKindCounters(2) === 'more') {
      /* finish remaining classified keys */
    }
    store.close();
    expect(await inspectCounts(fixture.path, source)).toMatchObject({
      classified: 5,
      new: 1,
      changed: 1,
      unchanged: 2,
      vanished: 1,
    });
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
