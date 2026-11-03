import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { InspectionStore } from '../src/inspection-store.ts';
import { RunStore, type SourceProjection } from '../src/run-store.ts';
import { runImportCli } from '../src/cli.ts';

const temporaryRoot = resolve(import.meta.dir, '../../../.temp');

function temporaryState() {
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(join(temporaryRoot, 'inspection-store-'));
  const path = join(directory, 'state.sqlite');
  const database = new Database(path, { create: true, strict: true });
  const store = new RunStore<SourceProjection>(database, { projectionMode: 'source-record' });
  return {
    directory,
    path,
    database,
    store,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function staged(source: string, key: string) {
  return {
    row: {
      source,
      recordKey: key,
      recordRevision: 'revision-1',
      digest: 'a'.repeat(64),
      converter_revision: 'test@1',
      state: 'present' as const,
    },
    projection: {
      sourceKind: 'wikidata' as const,
      normalizedRecord: { id: key, type: 'item', labels: {}, descriptions: {}, aliases: {}, claims: {} },
    },
  };
}

function command(source: string, recordKey: string, index = 0): BatchCommand {
  return {
    op: 'create',
    key: `cmd-${recordKey}-${String(index).padStart(3, '0')}`,
    source: {
      source,
      external_id: recordKey,
      record_revision: 'revision-1',
      digest: 'a'.repeat(64),
      converter_revision: 'test@1',
      field_group: 'facts',
    },
    subject: { type: 'item', labels: { en: 'Private request body sentinel' } },
  };
}

test('read-only inspection pages bounded work, binds cursors, and drills into original envelopes', async () => {
  const fixture = temporaryState();
  try {
    const source = 'wikidata';
    const baselineRun = fixture.store.begin(source);
    if (baselineRun === 'busy') throw new Error('Expected a new baseline generation');
    fixture.store.stage(baselineRun, staged(source, 'QBASE'));
    expect(fixture.store.seal(baselineRun, { complete: true }).status).toBe('ready');
    fixture.store.classify(baselineRun, 'QBASE', { commands: [] });
    fixture.store.acknowledgeNoEffects(baselineRun, 'QBASE', { reason: 'no-owned-candidates' });
    expect(fixture.store.finalize(baselineRun, 100)).toBe('complete');

    const run = fixture.store.begin(source);
    if (run === 'busy') throw new Error('Expected an active generation');
    const pageKeys = Array.from({ length: 22 }, (_, index) => `Q${String(index).padStart(4, '0')}`);
    for (const key of [...pageKeys, 'Q-MULTI', 'Q-SETTLED', 'QBASE']) fixture.store.stage(run, staged(source, key));
    expect(fixture.store.seal(run, { complete: true, skipped: 3 }).status).toBe('ready');
    fixture.store.classify(run, 'QBASE', { commands: [] });
    for (const key of pageKeys)
      fixture.store.prepare(run, key, { commands: [command(source, key)], deferredCover: true });
    const multiCommands = Array.from({ length: 101 }, (_, index) => command(source, 'Q-MULTI', index));
    fixture.store.prepare(run, 'Q-MULTI', { commands: multiCommands });
    fixture.store.classify(run, 'Q-SETTLED', { commands: [] });
    fixture.store.acknowledgeNoEffects(run, 'Q-SETTLED', { reason: 'no-owned-candidates' });

    const beforeRun = fixture.store.activeRun(source);
    const before = fixture.database
      .query('SELECT status,lease,prepared,resolved FROM run_generations WHERE source=? AND id=?')
      .get(source, run.id);
    const firstPending = await runImportCli([
      'inspect',
      '--state',
      fixture.path,
      '--source',
      source,
      '--page',
      'pending',
      '--limit',
      '20',
      '--json',
    ]);
    expect(firstPending.code).toBe(0);
    expect(firstPending.stderr).toBe('');
    expect(firstPending.openHandles).toBe(0);
    expect(firstPending.stdout).not.toContain('Private request body sentinel');
    const pendingDocument = JSON.parse(firstPending.stdout) as {
      baseline: { generation: string; presentCount: number; empty: boolean };
      selection: { kind: string; generation: string };
      generation: { status: string; phase: string; counts: { skipped: number } };
      page: { rows: { recordKey: string }[]; end: string; nextCursor: string };
    };
    expect(pendingDocument.baseline).toEqual({ generation: baselineRun.id, presentCount: 1, empty: false });
    expect(pendingDocument.selection).toEqual({ kind: 'active', generation: run.id });
    expect(pendingDocument.generation).toMatchObject({
      status: 'ready',
      phase: 'validated/sealed',
      counts: { skipped: 3 },
    });
    expect(pendingDocument.page.rows).toHaveLength(20);
    expect(pendingDocument.page.end).toBe('more');

    const secondPending = await runImportCli([
      'inspect',
      '--state',
      fixture.path,
      '--source',
      source,
      '--page',
      'pending',
      '--limit',
      '20',
      '--cursor',
      pendingDocument.page.nextCursor,
      '--json',
    ]);
    const secondPendingDocument = JSON.parse(secondPending.stdout) as {
      page: { rows: { recordKey: string }[]; end: string; nextCursor?: string };
    };
    expect(secondPending.code).toBe(0);
    expect(secondPendingDocument.page.rows.map((row) => row.recordKey)).toEqual(['Q0018', 'Q0019', 'Q0020', 'Q0021']);
    expect(secondPendingDocument.page.rows).toHaveLength(4);
    expect(secondPendingDocument.page.end).toBe('end');
    expect(secondPendingDocument.page.nextCursor).toBeUndefined();

    const firstCovers = await runImportCli([
      'inspect',
      '--state',
      fixture.path,
      '--source',
      source,
      '--page',
      'covers',
      '--limit',
      '20',
      '--json',
    ]);
    const firstCoverPage = JSON.parse(firstCovers.stdout) as {
      page: { rows: { recordKey: string }[]; end: string; nextCursor: string };
    };
    expect(firstCovers.code).toBe(0);
    expect(firstCoverPage.page.rows).toHaveLength(20);
    expect(firstCoverPage.page.end).toBe('more');
    const lastCovers = await runImportCli([
      'inspect',
      '--state',
      fixture.path,
      '--source',
      source,
      '--page',
      'covers',
      '--limit',
      '20',
      '--cursor',
      firstCoverPage.page.nextCursor,
      '--json',
    ]);
    const lastCoverPage = JSON.parse(lastCovers.stdout) as {
      page: { rows: { recordKey: string }[]; end: string; nextCursor?: string };
    };
    expect(lastCovers.code).toBe(0);
    expect(lastCoverPage.page.rows).toHaveLength(2);
    expect(lastCoverPage.page.end).toBe('end');
    expect(lastCoverPage.page.nextCursor).toBeUndefined();

    const crossGeneration = await runImportCli([
      'inspect',
      '--state',
      fixture.path,
      '--source',
      source,
      '--generation',
      baselineRun.id,
      '--page',
      'pending',
      '--cursor',
      pendingDocument.page.nextCursor,
      '--json',
    ]);
    expect(crossGeneration.code).toBe(2);
    expect(JSON.parse(crossGeneration.stdout).error).toContain('different source, generation or page');

    const exact = await runImportCli([
      'inspect',
      '--state',
      fixture.path,
      '--source',
      source,
      '--record',
      'Q-MULTI',
      '--json',
    ]);
    const exactDocument = JSON.parse(exact.stdout) as {
      record: {
        found: boolean;
        envelopes: { index: number; delivery: string; byteLength: number; sha256: string; commands: unknown[] }[];
      };
    };
    expect(exact.code).toBe(0);
    expect(exactDocument.record.found).toBe(true);
    expect(exactDocument.record.envelopes.map((item) => item.index)).toEqual([0, 1]);
    expect(exactDocument.record.envelopes.map((item) => item.commands.length)).toEqual([100, 1]);
    expect(exactDocument.record.envelopes.every((item) => item.delivery === 'unresolved')).toBe(true);
    expect(exact.stdout).not.toContain('Private request body sentinel');

    const settled = await runImportCli([
      'inspect',
      '--state',
      fixture.path,
      '--source',
      source,
      '--record',
      'Q-SETTLED',
      '--json',
    ]);
    expect(JSON.parse(settled.stdout).record).toMatchObject({
      found: true,
      resolved: true,
      localCompletionRetained: true,
      envelopes: [],
    });

    const after = fixture.database
      .query('SELECT status,lease,prepared,resolved FROM run_generations WHERE source=? AND id=?')
      .get(source, run.id);
    expect(after).toEqual(before);
    expect(fixture.store.activeRun(source)).toEqual(beforeRun);
  } finally {
    fixture.close();
  }
});

test('inspection rejects absent, unsupported, malformed and hostile local state without creating files', async () => {
  const fixture = temporaryState();
  try {
    const missing = join(fixture.directory, 'missing.sqlite');
    const missingResult = await runImportCli(['inspect', '--state', missing, '--source', 'wikidata', '--json']);
    expect(missingResult.code).toBe(2);
    expect(existsSync(missing)).toBe(false);
    expect(JSON.parse(missingResult.stdout).error).toContain('does not exist');

    const emptyPath = join(fixture.directory, 'unsupported.sqlite');
    const emptyDb = new Database(emptyPath, { create: true, strict: true });
    emptyDb.close();
    const unsupported = await runImportCli(['inspect', '--state', emptyPath, '--source', 'wikidata', '--json']);
    expect(unsupported.code).toBe(1);
    expect(JSON.parse(unsupported.stdout).error).toContain('Unsupported importer state schema');

    const aborted = new AbortController();
    aborted.abort();
    const cancelled = await runImportCli(['inspect', '--state', fixture.path, '--source', 'wikidata', '--json'], {
      signal: aborted.signal,
    });
    expect(cancelled.code).toBe(130);
    expect(cancelled.openHandles).toBe(0);

    let signalReads = 0;
    const cancelledAfterOpen = await runImportCli(
      ['inspect', '--state', fixture.path, '--source', 'wikidata', '--json'],
      {
        signal: {
          get aborted() {
            return ++signalReads > 1;
          },
        } as AbortSignal,
      },
    );
    expect(cancelledAfterOpen.code).toBe(130);
    expect(cancelledAfterOpen.openHandles).toBe(0);

    const hostile = await runImportCli([
      'inspect',
      '--state',
      fixture.path,
      '--source',
      `wikidata\u001b[31m`,
      '--json',
    ]);
    expect(hostile.code).toBe(2);
    expect(hostile.stdout).not.toContain('\u001b');
    expect(JSON.parse(hostile.stdout).error).toContain('source identifier');
  } finally {
    fixture.close();
  }
});

test('inspection help and exact settled lookup are local and safe on a live writer', async () => {
  const fixture = temporaryState();
  try {
    const help = await runImportCli(['inspect', '--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('read-only');
    expect(help.openHandles).toBe(0);

    const run = fixture.store.begin('wikidata');
    if (run === 'busy') throw new Error('Expected active run');
    fixture.store.stage(run, staged('wikidata', 'Q1'));
    expect(fixture.store.seal(run, { complete: true }).status).toBe('ready');
    fixture.store.classify(run, 'Q1', { commands: [] });
    fixture.store.acknowledgeNoEffects(run, 'Q1', { reason: 'no-owned-candidates' });
    const before = fixture.store.activeRun('wikidata');

    const result = await runImportCli(['inspect', '--state', fixture.path, '--source', 'wikidata', '--record', 'Q1']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Local source-key completion row retained: yes');
    expect(result.stdout).toContain('not a current selected/public read');
    expect(result.stdout).toContain('Ownership row present: unavailable');
    expect(fixture.store.activeRun('wikidata')).toEqual(before);
    expect(result.openHandles).toBe(0);
  } finally {
    fixture.close();
  }
});

test('inspection distinguishes an empty completed source, an absent source and a refused symbolic link', async () => {
  const fixture = temporaryState();
  try {
    const run = fixture.store.begin('wikidata');
    if (run === 'busy') throw new Error('Expected empty source generation');
    expect(fixture.store.seal(run, { complete: true }).status).toBe('ready');
    expect(fixture.store.finalize(run, 100)).toBe('complete');

    const empty = await runImportCli(['inspect', '--state', fixture.path, '--source', 'wikidata', '--json']);
    expect(empty.code).toBe(0);
    expect(JSON.parse(empty.stdout)).toMatchObject({
      sourceState: 'baseline',
      baseline: { generation: run.id, presentCount: 0, empty: true },
      selection: { kind: 'baseline', generation: run.id },
      generation: { status: 'complete', phase: 'terminal' },
    });

    const absent = await runImportCli(['inspect', '--state', fixture.path, '--source', 'openlibrary', '--json']);
    expect(absent.code).toBe(0);
    expect(JSON.parse(absent.stdout)).toMatchObject({ sourceState: 'absent', baseline: null, selection: null });

    const link = join(fixture.directory, 'linked.sqlite');
    symlinkSync(fixture.path, link);
    const refused = await runImportCli(['inspect', '--state', link, '--source', 'wikidata', '--json']);
    expect(refused.code).toBe(2);
    expect(JSON.parse(refused.stdout).error).toContain('symbolic link');
  } finally {
    fixture.close();
  }
});

test('malformed page journal data is reported as unavailable instead of an empty page', async () => {
  const fixture = temporaryState();
  try {
    const run = fixture.store.begin('wikidata');
    if (run === 'busy') throw new Error('Expected active generation');
    fixture.store.stage(run, staged('wikidata', 'Q1'));
    expect(fixture.store.seal(run, { complete: true }).status).toBe('ready');
    fixture.store.prepare(run, 'Q1', { commands: [command('wikidata', 'Q1')] });
    fixture.database
      .query('UPDATE run_envelopes SET keys_json=? WHERE source=? AND run_id=? AND record_key=?')
      .run('{broken', 'wikidata', run.id, 'Q1');

    const result = await runImportCli([
      'inspect',
      '--state',
      fixture.path,
      '--source',
      'wikidata',
      '--page',
      'pending',
      '--json',
    ]);
    expect(result.code).toBe(1);
    expect(result.openHandles).toBe(0);
    expect(JSON.parse(result.stdout).error).toContain('Malformed journal data');
  } finally {
    fixture.close();
  }
});
