import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RunStore } from '../../../importer/src/run-store.ts';
import { createGrowthLedgerPopulation } from './growth-ledger-population.ts';

test('growth seeds unrelated keys and history in the measured source without replacing its active run', () => {
  const store = new RunStore(':memory:');
  try {
    const populate = createGrowthLedgerPopulation(store.database);
    const run = store.begin('growth-source');
    const count = (table: 'run_members' | 'run_generations', source: string) =>
      (store.database.query(`SELECT count(*) AS n FROM ${table} WHERE source=?`).get(source) as { n: number }).n;
    for (const axis of ['catalogueRecords', 'historyRows'] as const)
      for (const scale of [32, 128, 512]) {
        const input = { catalogueRecords: 32, historyRows: 32, [axis]: scale };
        populate(input, 'growth-source');
        expect(count('run_members', 'growth-source')).toBe(input.catalogueRecords);
        expect(count('run_generations', 'growth-source')).toBe(input.historyRows + 1);
        expect<unknown>(store.activeRun('growth-source')).toEqual(run);
      }
    populate({ catalogueRecords: 128, historyRows: 128 }, 'g-new-1');
    expect(count('run_members', 'g-new-1')).toBe(128);
    expect(count('run_generations', 'g-new-1')).toBe(128);
    expect(count('run_generations', 'growth-source')).toBe(513);
    expect(count('run_members', 'bangumi')).toBe(0);
  } finally {
    store.close();
  }
});

// Keep explicit cold overrides out of imports' growth journeys.
test('imports growth checks measure every scale warm', () => {
  const directory = resolve(import.meta.dir);
  const cold = readdirSync(directory)
    .filter((name) => name.endsWith('.test.ts'))
    .filter((name) => /\bwarmups\s*:\s*0\b/.test(readFileSync(resolve(directory, name), 'utf8')));
  expect(cold).toEqual([]);
});

test('imports growth warmup includes native concurrent fence reads and authority checks', async () => {
  const child = Bun.spawn([process.execPath, 'test', resolve(import.meta.dir, 'api-warmup.test.ts')], {
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const output = stdout + stderr;
  if (code !== 0) console.error(output);
  expect(code).toBe(0);
  expect(output).toMatch(/^\s*1 pass$/m);
  expect(output).toMatch(/^\s*0 fail$/m);
  expect(output).not.toMatch(/^\s*[1-9]\d* (skip|todo)$/m);
}, 600_000);
