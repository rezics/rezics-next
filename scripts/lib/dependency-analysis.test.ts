import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repositoryFiles } from './repository-files.ts';
import { expect, test } from 'bun:test';
import { dependencyAnalysis } from './dependency-analysis.ts';
import type { spawnSync } from 'node:child_process';

test.each([75, null])('a busy lane or failed lock never falls back to an unbounded analysis (%s)', status => {
  const calls: unknown[][] = [];
  const run = ((...args: unknown[]) => {
    calls.push(args);
    return { status, stdout: '', stderr: 'lock unavailable' };
  }) as typeof spawnSync;
  expect(dependencyAnalysis('/repo', ['--output-type', 'json'], { encoding: 'utf8' }, run).status).toBe(status);
  expect(calls).toHaveLength(1);
  expect(calls[0]![0]).toBe('flock');
  expect(calls[0]![1]).toEqual(['-w', '60', '-E', '75', expect.stringMatching(/rezics-depcruise-[01]\.lock$/),
    '/repo/node_modules/.bin/depcruise', '--output-type', 'json']);
});

// A direct executable reference outside the admission wrapper restores the old bypass.
const directAnalysis = (source: string) => /['"`](?:[^'"`]*\/)?(?:depcruise|dependency-cruiser)['"`]/.test(source);
test('every dependency-analysis caller uses host admission', () => {
  const root = resolve(import.meta.dir, '../..');
  const bypasses = repositoryFiles(root, path => path.startsWith('scripts/') && path.endsWith('.ts')
    && !path.endsWith('.test.ts') && path !== 'scripts/lib/dependency-analysis.ts')
    .filter(path => directAnalysis(readFileSync(resolve(root, path), 'utf8')));
  expect(bypasses).toEqual([]);
  expect(directAnalysis("Bun.spawnSync({ cmd: [join(root, 'node_modules/.bin/depcruise'), '--config', 'config'] })")).toBe(true);
  expect(directAnalysis("Bun.spawn(['depcruise', '--config', 'config'])")).toBe(true);
});
