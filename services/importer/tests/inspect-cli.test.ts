import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseInspectionArgs, runInspectCli } from '../src/inspect-cli.ts';
import { RunStore, type Run, type SourceProjection } from '../src/run-store.ts';

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
