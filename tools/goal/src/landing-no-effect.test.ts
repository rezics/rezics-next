import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
    expect(h.store.task(task.id).state).toBe('ready');
    expect(h.head('dev')).toBe(dev);
  } finally {
    h.dispose();
  }
});

test('a Markdown union that keeps only dev’s conflicting hunk is returned to the worker', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.advanceDev('README.md', 'Fixture\n\nParagraph to edit.\n');
    const task = h.dispatch('README.md');
    setWorkerContent(task, 'Fixture\n\nWorker edit.\n');
    await h.start(task);
    h.advanceDev('README.md', 'Fixture\n\nParagraph changed on dev.\n');

    await h.train();

    const outcome = h.outcomes[0]!;
    expect(outcome.passed).toBe(false);
    expect(outcome.stage).toBe('rebase');
    expect(outcome.conflictedFiles).toContain('README.md');
    expect(h.store.task(task.id).state).toBe('ready');
  } finally {
    h.dispose();
  }
});

test('an empty landing tree is not attributed to an existing dev commit', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.advanceDev('result.txt', 'already on dev');
    const task = h.dispatch('result.txt');
    await h.start(task);

    await h.train();

    const outcome = h.outcomes[0]!;
    expect(outcome.passed).toBe(false);
    expect(outcome.stage).toBe('merge');
    expect(outcome.mergedCommit).toBeUndefined();
    expect(h.store.task(task.id).state).toBe('ready');
  } finally {
    h.dispose();
  }
});
