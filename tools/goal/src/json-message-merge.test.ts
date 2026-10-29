import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { rebaseOnto } from './merge-train.ts';
import { git as gitCommand } from './merge.ts';
import { integrationHarness, markdown } from './test-support.ts';

const catalog = 'apps/web/messages/en.json';
const format = (value: Record<string, string>) => `${JSON.stringify(value, null, 2)}\n`;
const git = (cwd: string, args: string[]) => gitCommand(cwd, ...args);

async function catalogTask() {
  const h = integrationHarness();
  h.ensureDev();
  const baseContent = format({ existing: 'base', shared: 'base' });
  mkdirSync(dirname(join(h.root, catalog)), { recursive: true });
  writeFileSync(join(h.root, catalog), baseContent);
  git(h.root, ['add', '--', catalog]);
  git(h.root, ['commit', '-m', 'Add base message catalog']);
  git(h.root, ['branch', '-f', 'dev', 'HEAD']);
  const base = h.head();
  const briefPath = join(h.settings.stateDirectory, `catalog-${crypto.randomUUID()}.md`);
  writeFileSync(briefPath, markdown.replace('paths: [result.txt]', `paths: [${catalog}]`));
  const task = h.tasks.dispatch(briefPath);
  mkdirSync(join(task.worktree, '.temp'), { recursive: true });
  writeFileSync(
    join(task.worktree, '.temp/worker-plan.json'),
    JSON.stringify({ file: catalog, content: format({ existing: 'base', shared: 'base', worker: 'worker value' }) }),
  );
  await h.start(task);
  return { h, task, base };
}

test('train resolves conflicting flat message catalog appends and keeps both sides in catalog order', async () => {
  const { h, task } = await catalogTask();
  try {
    h.advanceDev(catalog, format({ existing: 'base', shared: 'base', target: 'target value' }));

    await h.train();

    expect(h.store.task(task.id).state).toBe('integrated');
    expect(h.outcomes[0]?.passed).toBe(true);
    expect(git(h.root, ['show', `dev:${catalog}`])).toBe(
      format({ existing: 'base', shared: 'base', target: 'target value', worker: 'worker value' }).trimEnd(),
    );
  } finally {
    h.dispose();
  }
}, 30_000);

test('retry rebase resolves a flat message catalog conflict and continues', async () => {
  const { h, task, base } = await catalogTask();
  try {
    h.advanceDev(catalog, format({ existing: 'base', shared: 'base', target: 'target value' }));

    rebaseOnto(task.worktree, h.head(), base, join(h.settings.stateDirectory, 'retry.rebase.log'));

    expect(git(task.worktree, ['status', '--porcelain'])).toBe('');
    expect(git(task.worktree, ['show', `HEAD:${catalog}`])).toBe(
      format({ existing: 'base', shared: 'base', target: 'target value', worker: 'worker value' }).trimEnd(),
    );
  } finally {
    h.dispose();
  }
}, 30_000);

test('two different values for the same message key refuse and name that key', async () => {
  const { h, task, base } = await catalogTask();
  try {
    h.advanceDev(catalog, format({ existing: 'base', shared: 'target value' }));
    git(task.worktree, ['reset', '--soft', 'HEAD^']);
    writeFileSync(join(task.worktree, catalog), format({ existing: 'base', shared: 'worker value' }));
    git(task.worktree, ['add', '--', catalog]);
    git(task.worktree, ['commit', '-m', 'Update message catalog']);

    expect(() =>
      rebaseOnto(task.worktree, h.head(), base, join(h.settings.stateDirectory, 'conflict.rebase.log')),
    ).toThrow(/JSON message conflict in apps\/web\/messages\/en\.json: key shared/);
  } finally {
    h.dispose();
  }
}, 30_000);
