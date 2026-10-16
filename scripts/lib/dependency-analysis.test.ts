import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repositoryFiles } from './repository-files.ts';
import { expect, test } from 'bun:test';
import { dependencyAnalysis, dependencyAnalysisFailure } from './dependency-analysis.ts';
import type { spawnSync } from 'node:child_process';

test.each([1, null])('failed CPU admission never falls back to an unbounded analysis (%s)', status => {
  const calls: unknown[][] = [];
  const run = ((...args: unknown[]) => {
    calls.push(args);
    return { status, signal: null, stdout: '', stderr: 'admission unavailable' };
  }) as typeof spawnSync;
  expect(dependencyAnalysis('/repo', ['--output-type', 'json'], { encoding: 'utf8' }, run).status).toBe(status);
  expect(calls).toHaveLength(1);
  expect(calls[0]![0]).toBe(process.execPath);
  expect(calls[0]![1]).toEqual(['/repo/scripts/qa/host-admission.ts', '--cpu', '--gib', '2', '--',
    '/repo/node_modules/.bin/depcruise', '--output-type', 'json']);
  expect(calls[0]![2]).toMatchObject({ stdio: ['pipe', 'pipe', 'pipe', 2],
    env: { REZICS_QA_ADMISSION_LOG_FD: '3' } });
});

test.each([
  { status: 137, signal: null, stderr: '', expected: 'exit status 137; signal none' },
  { status: null, signal: 'SIGKILL' as const, stderr: '', expected: 'exit status null; signal SIGKILL' },
  { status: 2, signal: null, stderr: 'invalid graph', expected: 'exit status 2; signal none): invalid graph' },
])('failed analysis identifies its exit and signal even without stderr ($expected)', ({ expected, ...result }) => {
  expect(dependencyAnalysisFailure(result)).toContain(expected);
});

test('failed analysis includes spawn errors', () => {
  expect(dependencyAnalysisFailure({ status: null, signal: null, stderr: '', error: new Error('spawn ENOENT') }))
    .toContain('exit status null; signal none): spawn ENOENT');
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
