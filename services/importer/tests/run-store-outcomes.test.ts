import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RecordRow } from '../src/record-store.ts';
import { RunStore, type Run } from '../src/run-store.ts';

// Run the entire immutable suite in a child, including its storage evidence tests.
test('the complete durable run-state outcomes pass with production indexed storage', async () => {
  const spec = resolve(import.meta.dir, '../../../specs/imports-run-store.test.ts');
  const driver = resolve(import.meta.dir, 'run-store-driver.ts');
  const declarations = (await Bun.file(spec).text()).match(/^test\(/gm)?.length ?? 0;
  expect(declarations).toBeGreaterThanOrEqual(16);
  const cwd = mkdtempSync(join(tmpdir(), 'run-store-outcomes-'));
  try {
    const child = Bun.spawn([process.execPath, 'test', spec], {
      cwd,
      env: { ...process.env, IMPORT_RUN_STORE_DRIVER: driver },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const output = stdout + stderr;
    if (exit !== 0) console.error(output);
    expect(exit).toBe(0);
    expect(output).toMatch(new RegExp(`\\b${declarations} pass\\b`));
    expect(output).toMatch(/\b0 fail\b/);
    expect(output).not.toMatch(/\b[1-9]\d* (?:skip|todo)\b/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 180_000);

test('selected acquisition updates named records without replacing the complete comparison base', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'selected-run-store-'));
  const store = new RunStore(join(cwd, 'runs.sqlite'));
  const record = (recordKey: string, revision: number): RecordRow => ({
    source: 'wikidata',
    recordKey,
    recordRevision: String(revision),
    digest: 'a'.repeat(64),
    converter_revision: 'wikidata@6',
    state: 'present',
  });
  const begin = (mode?: 'complete' | 'selected') => {
    const run = store.begin('wikidata', mode ? { acquisitionMode: mode } : {});
    if (run === 'busy') throw new Error('Unexpected run-store lease');
    return run;
  };
  const classifyWithoutEffects = (run: Run, row: RecordRow) =>
    store.classify(run, row.recordKey, {
      commands: [],
      omissions: [{ field_group: 'facts', disposition: 'fenced', securityRevision: '1' }],
    });
  const complete = (run: Run, rows: RecordRow[]) => {
    for (const row of rows) store.stage(run, { row, projection: [] });
    expect(store.seal(run, { complete: true }).status).toBe('ready');
    for (const row of rows) classifyWithoutEffects(run, row);
    expect(store.finalize(run, 100)).toBe('complete');
  };

  try {
    const baselineRun = begin();
    complete(baselineRun, [record('Q100', 1), record('Q200', 1)]);
    const comparison = store.source('wikidata');
    expect(comparison).toEqual({ generation: baselineRun.id, count: 2 });

    const selected = begin('selected');
    const selectedRecord = record('Q200', 2);
    store.stage(selected, { row: selectedRecord, projection: [] });
    const seal = store.seal(selected, { complete: true });
    expect(seal).toMatchObject({ status: 'ready', prior: 2, seenSurvivors: 1, supplied: 1 });
    expect(store.pageVanished(selected, { limit: 100 })).toEqual([]);
    expect(classifyWithoutEffects(selected, selectedRecord)).toBe('changed');
    expect(store.finalize(selected, 100)).toBe('complete');

    expect(store.source('wikidata')).toEqual(comparison);
    expect(store.key('wikidata', 'Q100').baseline?.recordRevision).toBe('1');
    expect(store.key('wikidata', 'Q200').baseline?.recordRevision).toBe('1');
    expect(store.key('wikidata', 'Q200').acknowledged?.recordRevision).toBe('2');

    const completeSubset = begin();
    store.stage(completeSubset, { row: record('Q200', 3), projection: [] });
    expect(store.seal(completeSubset, { complete: true }).status).toBe('mass-disappearance');
    expect(store.source('wikidata')).toEqual(comparison);
  } finally {
    store.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
