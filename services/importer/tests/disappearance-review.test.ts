import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runImportCli } from '../src/cli.ts';
import { parseDisappearanceReviewArgs, runDisappearanceReviewCli } from '../src/disappearance-review-cli.ts';
import { RunStore, type Run, type SourceProjection } from '../src/run-store.ts';

const temporaryRoot = resolve(import.meta.dir, '../../../.temp');

function digest(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

function temporaryState() {
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(join(temporaryRoot, 'disappearance-review-'));
  const path = join(directory, 'state.sqlite');
  const store = new RunStore<SourceProjection>(path, { projectionMode: 'source-record' });
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

function staged(source: string, key: string, kind: SourceProjection['sourceKind'] = 'wikidata') {
  return {
    row: {
      source,
      recordKey: key,
      recordRevision: 'revision-1',
      digest: digest(`${source}:${key}`),
      converter_revision: 'test@1',
      state: 'present' as const,
    },
    projection: { sourceKind: kind, normalizedRecord: { id: key } },
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

function stopHalf(
  store: RunStore<SourceProjection>,
  source: string,
  keys: string[],
  kind: SourceProjection['sourceKind'],
) {
  const baseline = store.begin(source);
  if (baseline === 'busy') throw new Error('baseline');
  for (const key of keys) store.stage(baseline, staged(source, key, kind));
  complete(store, baseline, keys);
  const stopped = store.begin(source);
  if (stopped === 'busy') throw new Error('stopped');
  for (const key of keys.slice(0, Math.ceil(keys.length * 0.6))) store.stage(stopped, staged(source, key, kind));
  expect(store.seal(stopped, { complete: true }).status).toBe('mass-disappearance');
  return { baseline: baseline.id, stopped: stopped.id };
}

async function review(path: string, args: string[]) {
  return runImportCli(['disappearance-review', '--state', path, ...args], {
    fetch: (async () => {
      throw new Error('disappearance-review network');
    }) as unknown as typeof fetch,
  });
}

test('disappearance-review help is self-contained and rejects every import-only option', async () => {
  expect(parseDisappearanceReviewArgs(['--help'])).toBe('help');
  expect(() =>
    parseDisappearanceReviewArgs([
      '--state',
      'state.sqlite',
      '--source',
      'wikidata',
      '--generation',
      '2',
      '--account-key',
      'account.key',
    ]),
  ).toThrow('Unknown, import-only or repeated disappearance-review flag');
  expect(() =>
    parseDisappearanceReviewArgs(['--state', 'state.sqlite', '--source', 'wikidata', '--generation', '020']),
  ).toThrow('positive stored generation ID');
  const help = await runDisappearanceReviewCli(['--help']);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain('local and read-only');
  expect(help.stdout).toContain('never');
  expect(help.openHandles).toBe(0);
});

test('an operator pages exact missing identities, repairs locally, and is handed ordinary import', async () => {
  const fixture = temporaryState();
  try {
    const sources: Array<{
      source: string;
      kind: SourceProjection['sourceKind'];
      keys: string[];
    }> = [
      { source: 'bangumi', kind: 'bangumi', keys: ['1', '2', '3', '4', '5'] },
      { source: 'vndb', kind: 'vndb', keys: ['v1', 'v2', 'v3', 'v4', 'v5'] },
      {
        source: 'openlibrary',
        kind: 'openlibrary',
        keys: ['/works/OL1W', '/works/OL2W', '/works/OL3W', '/works/OL4W', '/works/OL5W'],
      },
      { source: 'wikidata', kind: 'wikidata', keys: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'] },
    ];
    const stopped: Record<string, string> = {};
    for (const row of sources) {
      const ids = stopHalf(fixture.store, row.source, row.keys, row.kind);
      stopped[row.source] = ids.stopped;
    }

    const first = await review(fixture.path, [
      '--source',
      'wikidata',
      '--generation',
      stopped.wikidata!,
      '--limit',
      '1',
      '--json',
    ]);
    expect(first.code, first.stdout + first.stderr).toBe(0);
    expect(first.openHandles).toBe(0);
    const document = JSON.parse(first.stdout) as {
      source: string;
      generation: {
        id: string;
        status: string;
        input: string;
        counts: { prior: number; missing: number };
        comparedBaseline: { generation: string };
      };
      evidence: { availability: string; identity: string };
      page: { rows: { recordKey: string }[]; end: string; nextCursor: string; storedMissing: number };
      authority: { disappearanceApproval: string; thresholdChange: string; transport: string };
      ordinaryImport: string;
    };
    expect(document.generation.status).toBe('mass-disappearance');
    expect(document.generation.input).toBe('complete');
    expect(document.generation.counts).toMatchObject({ prior: 5, missing: 2 });
    expect(document.evidence.availability).toBe('complete');
    expect(document.page.rows).toHaveLength(1);
    expect(document.page.storedMissing).toBe(2);
    expect(document.authority).toMatchObject({
      disappearanceApproval: 'none',
      thresholdChange: 'none',
      transport: 'none',
    });
    expect(document.ordinaryImport).toContain('--dump');
    expect(document.ordinaryImport).not.toContain('disappearance-threshold');

    const next = await review(fixture.path, [
      '--source',
      'wikidata',
      '--generation',
      stopped.wikidata!,
      '--limit',
      '1',
      '--cursor',
      document.page.nextCursor,
      '--json',
    ]);
    expect(next.code).toBe(0);
    const second = JSON.parse(next.stdout) as { page: { rows: { recordKey: string }[]; end: string } };
    expect(second.page.rows[0]!.recordKey).not.toBe(document.page.rows[0]!.recordKey);
    expect(second.page.end).toBe('end');

    const mismatch = await review(fixture.path, [
      '--source',
      'wikidata',
      '--generation',
      stopped.wikidata!,
      '--cursor',
      document.page.nextCursor.replace(/.$/, document.page.nextCursor.endsWith('A') ? 'B' : 'A'),
      '--json',
    ]);
    expect(mismatch.code).toBe(2);

    const exact = await review(fixture.path, [
      '--source',
      'wikidata',
      '--generation',
      stopped.wikidata!,
      '--record',
      document.page.rows[0]!.recordKey,
      '--json',
    ]);
    expect(JSON.parse(exact.stdout).record.found).toBe(true);
    expect(JSON.parse(exact.stdout).record.nativeDeletion).toBe('not-established');
    expect(JSON.parse(exact.stdout).page).toBeNull();

    const human = await review(fixture.path, ['--source', 'bangumi', '--generation', stopped.bangumi!]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('complete capture halted for mass loss');
    expect(human.stdout).toContain('does not approve disappearance');
    expect(human.stdout).not.toContain('--disappearance-threshold');

    fixture.store.database
      .query('UPDATE run_generations SET status=? WHERE source=? AND id=?')
      .run('retired', 'vndb', stopped.vndb!);
    const retired = await review(fixture.path, ['--source', 'vndb', '--generation', stopped.vndb!, '--json']);
    expect(retired.code).toBe(0);
    expect(JSON.parse(retired.stdout).evidence.availability).toBe('retired');

    fixture.store.database.query('DELETE FROM run_disappearance_stops WHERE source=?').run('openlibrary');
    fixture.store.database.query('DELETE FROM run_disappearance_missing WHERE source=?').run('openlibrary');
    const unavailable = await review(fixture.path, [
      '--source',
      'openlibrary',
      '--generation',
      stopped.openlibrary!,
      '--json',
    ]);
    expect(JSON.parse(unavailable.stdout).evidence.availability).toBe('unavailable');
    expect(JSON.parse(unavailable.stdout).generation.counts.missing).toBe(2);
    expect(JSON.parse(unavailable.stdout).page.rows).toEqual([]);
  } finally {
    fixture.close();
  }
});

test('older unsupported schema and malformed input stay honest', async () => {
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(join(temporaryRoot, 'disappearance-review-schema-'));
  try {
    const empty = join(directory, 'empty.sqlite');
    writeFileSync(empty, '');
    const missing = await runDisappearanceReviewCli([
      '--state',
      empty,
      '--source',
      'wikidata',
      '--generation',
      '1',
      '--json',
    ]);
    expect(missing.code).toBe(2);

    const path = join(directory, 'state.sqlite');
    const store = new RunStore<SourceProjection>(path, { projectionMode: 'source-record' });
    const source = 'wikidata';
    const baseline = store.begin(source);
    if (baseline === 'busy') throw new Error('baseline');
    store.stage(baseline, staged(source, 'Q1'));
    complete(store, baseline, ['Q1']);
    const invalid = store.begin(source);
    if (invalid === 'busy') throw new Error('invalid');
    expect(store.seal(invalid, { complete: false, reason: 'truncated' }).status).toBe('invalid-input');
    store.close();
    const truncated = await runDisappearanceReviewCli([
      '--state',
      path,
      '--source',
      source,
      '--generation',
      invalid.id,
      '--json',
    ]);
    expect(truncated.code).toBe(0);
    expect(JSON.parse(truncated.stdout).generation.input).toBe('malformed-or-truncated');
    expect(JSON.parse(truncated.stdout).evidence.availability).toBe('unavailable');

    const raw = new Database(path);
    raw.exec('DROP TABLE run_disappearance_missing');
    raw.close();
    const unsupported = await runDisappearanceReviewCli([
      '--state',
      path,
      '--source',
      source,
      '--generation',
      invalid.id,
      '--json',
    ]);
    expect(unsupported.code).toBe(2);
    expect(JSON.parse(unsupported.stdout).error).toContain('Unsupported');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
