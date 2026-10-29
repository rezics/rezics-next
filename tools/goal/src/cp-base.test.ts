import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './tasks.ts';
import { integrationHarness, markdown } from './test-support.ts';

function briefFile(h: ReturnType<typeof integrationHarness>, paths: string): string {
  const file = join(h.settings.stateDirectory, `brief-${crypto.randomUUID()}.md`);
  writeFileSync(
    file,
    markdown
      .replace('goal: fixture', 'goal: control-plane')
      .replace('paths: [result.txt]', `paths: [${paths}]`),
  );
  return file;
}

test("a control-plane task's worktree starts from main even when dev's tools/goal differs", () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const main = h.head('main');
    const devTree = join(h.settings.worktreeRoot, `dev-${crypto.randomUUID()}`);
    mkdirSync(h.settings.worktreeRoot, { recursive: true });
    git(h.root, ['worktree', 'add', '-b', 'dev-change', devTree, 'dev']);
    try {
      mkdirSync(join(devTree, 'tools/goal/src'), { recursive: true });
      writeFileSync(join(devTree, 'tools/goal/src/version.ts'), 'dev version\n');
      git(devTree, ['add', 'tools/goal/src/version.ts']);
      git(devTree, ['commit', '-m', 'Change tools/goal on dev']);
      git(h.root, ['branch', '-f', 'dev', 'dev-change']);
    } finally {
      git(h.root, ['worktree', 'remove', '--force', devTree]);
      git(h.root, ['branch', '-D', 'dev-change']);
    }

    const task = h.tasks.dispatch(briefFile(h, 'tools/goal/src/task.ts'));

    expect(task.base).toBe(main);
    expect(git(task.worktree, ['rev-parse', 'HEAD'])).toBe(main);
    expect(git(task.worktree, ['ls-tree', '--name-only', 'HEAD', 'tools/goal/src/version.ts'])).toBe('');
  } finally {
    h.dispose();
  }
});

test("a control-plane target still starts from main instead of stabilize", () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const main = h.head('main');
    git(h.root, ['branch', 'stabilize', main]);
    const stabilizeTree = join(h.settings.worktreeRoot, `stabilize-${crypto.randomUUID()}`);
    mkdirSync(h.settings.worktreeRoot, { recursive: true });
    git(h.root, ['worktree', 'add', '-b', 'stabilize-change', stabilizeTree, 'stabilize']);
    try {
      mkdirSync(join(stabilizeTree, 'tools/goal/src'), { recursive: true });
      writeFileSync(join(stabilizeTree, 'tools/goal/src/version.ts'), 'stabilize version\n');
      git(stabilizeTree, ['add', 'tools/goal/src/version.ts']);
      git(stabilizeTree, ['commit', '-m', 'Change tools/goal on stabilize']);
      git(h.root, ['branch', '-f', 'stabilize', 'stabilize-change']);
    } finally {
      git(h.root, ['worktree', 'remove', '--force', stabilizeTree]);
      git(h.root, ['branch', '-D', 'stabilize-change']);
    }

    const file = briefFile(h, 'tools/goal/src/task.ts');
    writeFileSync(file, readFileSync(file, 'utf8').replace('waiting: []', 'waiting: []\ntarget: stabilize'));
    const task = h.tasks.dispatch(file);

    expect(task.base).toBe(main);
    expect(git(task.worktree, ['rev-parse', 'HEAD'])).toBe(main);
    expect(git(task.worktree, ['ls-tree', '--name-only', 'HEAD', 'tools/goal/src/version.ts'])).toBe('');
  } finally {
    h.dispose();
  }
});

test('a control-plane task that declares paths outside tools/goal is refused with a split message', () => {
  const h = integrationHarness();
  try {
    const file = briefFile(h, 'tools/goal/src/task.ts, docs/plan.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace('waiting: []', 'waiting: []\ntarget: stabilize'));
    expect(() => h.tasks.dispatch(file)).toThrow(
      'split outside paths into a dev task: docs/plan.md',
    );
  } finally {
    h.dispose();
  }
});
