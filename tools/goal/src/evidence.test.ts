import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evidenceBundle } from './evidence.ts';
import { workerPrompt } from './launch.ts';
import type { Attempt, Task } from './types.ts';

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

test('retry evidence is a bounded manifest that names recoverable full evidence', () => {
  const tempRoot = join(import.meta.dir, '../../../.temp');
  mkdirSync(tempRoot, { recursive: true });
  const root = mkdtempSync(join(tempRoot, 'goal-evidence-repo-'));
  const evidencePath = join(tempRoot, `goal-evidence-output-${Date.now()}`);
  try {
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'goal@example.test');
    git(root, 'config', 'user.name', 'Goal test');
    const changedName = '資料 whitespace\nline\t"tracked".ts';
    const untrackedName = 'new 文件\nline with space.ts';
    writeFileSync(join(root, 'tracked.ts'), 'base\n');
    writeFileSync(join(root, changedName), 'base\n');
    git(root, 'add', '--', 'tracked.ts', changedName);
    git(root, 'commit', '-qm', 'base');
    const base = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'tracked.ts'), 'changed\n');
    writeFileSync(join(root, changedName), 'changed\n');
    writeFileSync(join(root, 'new.ts'), 'new file\n');
    writeFileSync(join(root, untrackedName), 'new file\n');

    const logPath = join(root, 'runs', '1.jsonl');
    mkdirSync(join(root, 'runs'));
    writeFileSync(logPath, 'complete session log\n');
    const task = {
      id: 'task',
      worktree: root,
      base,
      taskClass: 'implementation',
      brief: { markdown: 'Unchanged contract contents.', acceptance: { command: ['bun', 'test', 'src/a.test.ts'] } },
    } as unknown as Task;
    const attempt = {
      taskId: 'task',
      attempt: 4,
      logPath,
      evidencePath,
      failure: {
        fingerprint: 'fingerprint',
        assertion: 'AssertionError: expected 2 to equal 1',
        excerpt: Array.from({ length: 90 }, (_, index) => `failure output line ${index + 1}`).join('\n'),
      },
      failureCommand: ['bun', 'test', 'src/failing.test.ts'],
      failureOnBase: false,
      failureLogPath: logPath,
      approaches: [
        { approach: 'first discarded', result: 'did not help' },
        { approach: 'second approach', result: 'still failed' },
        { approach: 'third approach', result: 'also failed' },
        { approach: 'fourth approach', result: 'hypothesis: the async teardown is racing' },
      ],
      result: '{"hypothesis":"the async teardown is racing"}',
    } as unknown as Attempt;

    const directory = evidenceBundle(task, attempt);
    const manifest = JSON.parse(readFileSync(join(directory, 'failure.json'), 'utf8')).manifest as string;
    expect(manifest).toContain('contract.md');
    expect(manifest).toContain(`Base commit: ${base}`);
    expect(manifest).toContain(`Head commit: ${git(root, 'rev-parse', 'HEAD')}`);
    expect(manifest).toContain('Worktree status: dirty');
    expect(manifest).toContain('bun test src/failing.test.ts');
    expect(manifest).toContain('AssertionError: expected 2 to equal 1');
    expect(manifest).toContain('tracked.ts');
    expect(manifest).toContain('new.ts');
    const retainedPaths = (manifest.split('Changed paths:\n')[1]?.split('\n\n')[0] ?? '')
      .split('\n')
      .map((path) => JSON.parse(path) as string)
      .sort();
    expect(retainedPaths).toEqual([changedName, 'new.ts', 'tracked.ts', untrackedName].sort());
    expect(manifest).toContain('the async teardown is racing');
    expect(manifest).toContain('Failure also occurs on base: no');
    expect(manifest).toContain(logPath);
    expect(manifest).toContain(join(directory, 'diff.patch'));
    expect(manifest).not.toContain('first discarded');
    expect(manifest).toContain('second approach — still failed');
    expect(manifest).toContain('fourth approach — hypothesis: the async teardown is racing');
    const excerpt = manifest.split('Failure output:\n')[1]?.split('\n\n')[0] ?? '';
    expect(excerpt.split('\n').length).toBeLessThanOrEqual(60);
    expect(manifest.length).toBeLessThanOrEqual(8_000);
    expect(readFileSync(join(directory, 'diff.patch'), 'utf8')).toContain('changed');
    expect(readFileSync(logPath, 'utf8')).toBe('complete session log\n');
    expect(readdirSync(directory).sort()).toEqual(['approaches.json', 'contract.md', 'diff.patch', 'failure.json']);
    const prompt = workerPrompt({ ...task, branch: 'worker/task' } as Task, directory, undefined, [], '/repo/main');
    expect(prompt).toContain('# Retry manifest');
    expect(prompt).toContain('First failing command: bun test src/failing.test.ts');
    expect(prompt).not.toContain(`Continue from this retry manifest:\n${directory}`);
    expect(prompt).toContain(
      'Finish with one JSON object: status, summary, blocker (null or kind and detail), checks, approaches.',
    );
    expect(prompt).not.toContain('"additionalProperties"');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(evidencePath, { recursive: true, force: true });
  }
});
