import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './merge.ts';
import { harness, integrationHarness } from './test-support.ts';

function formatter(h: ReturnType<typeof integrationHarness>, body: string): string {
  const file = join(h.settings.stateDirectory, `formatter-${crypto.randomUUID()}.cjs`);
  writeFileSync(file, body);
  h.settings.formatCommand = [process.execPath, file];
  return file;
}

test("integration formats the task's changed files and dev receives formatted content", async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const task = h.dispatch('feature');
    await h.start(task);
    const worker = git(h.root, 'rev-parse', task.branch);
    formatter(
      h,
      `const fs=require('fs'); for (const f of process.argv.slice(2)) fs.appendFileSync(f, '\\nformatted');`,
    );
    await h.train(undefined, false);
    expect(h.outcomes[0]?.passed).toBe(true);
    expect(git(h.root, 'rev-parse', `${h.head()}^`)).toBe(worker);
    expect(git(h.root, 'log', '-1', '--format=%s', 'dev')).toBe(`style: format ${task.id}`);
    expect(git(h.root, 'show', 'dev:feature')).toBe('feature\nformatted');
    expect(h.outcomes[0]?.changedFiles).toContain('feature');
  } finally {
    h.dispose();
  }
});

test('a formatter that changes nothing adds no commit', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const task = h.dispatch('feature');
    await h.start(task);
    formatter(h, 'process.exit(0);');
    const worker = git(task.worktree, 'rev-parse', 'HEAD');
    await h.train(undefined, false);
    expect(h.head()).toBe(worker);
    expect(git(h.root, 'log', '-1', '--format=%s', 'dev')).toBe('Complete fixture');
  } finally {
    h.dispose();
  }
});

test('a formatter failure leaves dev unmoved and returns the task as a scope-free environment failure', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const task = h.dispatch('feature');
    await h.start(task);
    formatter(h, `console.error('formatter unavailable'); process.exit(7);`);
    const dev = h.head();
    await h.train();
    expect(h.head()).toBe(dev);
    expect(h.outcomes[0]?.passed).toBe(false);
    expect(h.outcomes[0]?.stage).toBe('setup');
    expect(h.outcomes[0]?.changedFiles).toEqual(['feature']);
    expect(h.inbox.some((event) => event.kind === 'scope-growth')).toBe(false);
    expect(h.store.task(task.id).state).not.toBe('stopped');
    expect(git(h.root, 'status', '--short')).toBe('');
  } finally {
    h.dispose();
  }
});

test('the default formatter does not fail a landing that changes only files it does not format', () => {
  const h = harness();
  try {
    // oxfmt exits 2 on "Expected at least one target file" for a lone .sql file unless told otherwise.
    expect(h.settings.formatCommand.at(-1)).toBe('--no-error-on-unmatched-pattern');
    expect(h.settings.formatCommand[0]).toEndWith('/node_modules/.bin/oxfmt');
  } finally {
    h.dispose();
  }
});
