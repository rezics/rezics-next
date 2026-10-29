import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveMechanicalConflicts } from './merge-train.ts';
import { git } from './merge.ts';
import { integrationHarness } from './test-support.ts';

function setWorkerContent(task: { worktree: string }, content: string): void {
  const path = join(task.worktree, '.temp/worker-plan.json');
  const plan = JSON.parse(readFileSync(path, 'utf8')) as { file: string; content: string };
  writeFileSync(path, JSON.stringify({ ...plan, content }));
}

test('a Markdown union with no effect on dev returns the task to its worker and names the file', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const task = h.dispatch('README.md');
    setWorkerContent(task, 'Fixture\n\n# Repeated section\n\nOne paragraph.\n');
    await h.start(task);
    const dev = h.advanceDev('README.md', 'Fixture\n\n# Repeated section\n\nOne paragraph.\n\nOne paragraph.\n');

    await h.train();

    const outcome = h.outcomes[0]!;
    expect(outcome.passed).toBe(false);
    expect(outcome.stage).toBe('merge');
    expect(outcome.firstFailure?.assertion).toContain('Change had no effect on dev');
    expect(outcome.conflictedFiles).toContain('README.md');
    expect(outcome.mergedCommit).toBeUndefined();
    expect(h.store.task(task.id).currentAttempt).toBeGreaterThan(1);
    expect(h.store.task(task.id).state).not.toBe('integrated');
    expect(h.head('dev')).toBe(dev);
  } finally {
    h.dispose();
  }
});

test('a Markdown union that keeps only dev’s changed hunk is left for the worker', () => {
  const h = integrationHarness();
  try {
    const file = '.temp/union-conflict.md';
    mkdirSync(join(h.root, '.temp'), { recursive: true });
    writeFileSync(join(h.root, file), 'unmerged content\n');
    const blobs = [
      'before\nbase hunk\nafter\n',
      'before\ndev hunk\nafter\n',
      'before\nafter\n',
    ].map((content) => {
      const path = join(h.root, '.temp/blob');
      writeFileSync(path, content);
      return git(h.root, 'hash-object', '-w', path);
    });
    const indexInfo = blobs
      .map((blob, index) => `100644 ${blob} ${index + 1}\t${file}`)
      .join('\n');
    const staged = spawnSync('git', ['update-index', '--index-info'], {
      cwd: h.root,
      encoding: 'utf8',
      input: `${indexInfo}\n`,
    });
    expect(staged.status).toBe(0);
    expect(() => resolveMechanicalConflicts(h.root, [file], undefined, 'union')).toThrow(
      'Worker change conflicts with dev',
    );
  } finally {
    h.dispose();
  }
});

test('a JSON message deletion that conflicts with a dev edit is left unresolved for the worker', () => {
  const h = integrationHarness();
  try {
    const file = 'apps/web/messages/en.json';
    mkdirSync(join(h.root, '.temp'), { recursive: true });
    mkdirSync(join(h.root, 'apps/web/messages'), { recursive: true });
    writeFileSync(join(h.root, file), '{"shared":"unmerged"}\n');
    const blobs = ['{"shared":"base"}\n', '{"shared":"dev"}\n', '{}\n'].map((content) => {
      const path = join(h.root, '.temp/blob');
      writeFileSync(path, content);
      return git(h.root, 'hash-object', '-w', path);
    });
    const indexInfo = blobs
      .map((blob, index) => `100644 ${blob} ${index + 1}\t${file}`)
      .join('\n');
    const staged = spawnSync('git', ['update-index', '--index-info'], {
      cwd: h.root,
      encoding: 'utf8',
      input: `${indexInfo}\n`,
    });
    expect(staged.status).toBe(0);
    expect(resolveMechanicalConflicts(h.root, [file], undefined, 'union')).toBe(false);
    expect(git(h.root, 'diff', '--name-only', '--diff-filter=U')).toContain(file);
  } finally {
    h.dispose();
  }
});

test('an empty landing tree is not attributed to an existing dev commit', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const task = h.dispatch('result.txt');
    await h.start(task);
    h.advanceDev('result.txt', 'result.txt');

    await h.train();

    const outcome = h.outcomes[0]!;
    expect(outcome.passed).toBe(false);
    expect(outcome.stage).toBe('merge');
    expect(outcome.mergedCommit).toBeUndefined();
    expect(h.store.task(task.id).currentAttempt).toBeGreaterThan(1);
    expect(h.store.task(task.id).state).not.toBe('integrated');
  } finally {
    h.dispose();
  }
});
