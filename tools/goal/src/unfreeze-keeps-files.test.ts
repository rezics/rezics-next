import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { launch } from './launch.ts';
import { git, WorkerTasks } from './tasks.ts';
import { harness, reading } from './test-support.ts';

function briefWith(blocks: string[], path: string): string {
  return `---
goal: fixture
kind: implementation
paths: [${path}]
riskAreas: []
acceptance:
  command: [bun, test]
  tests: [frozen]
  failing: true
estimate:
  lines: 100
  files: 4
criticalPath: false
waiting: []
---

${blocks.join('\n\n')}
`;
}

function frozenBlock(path: string, content: string): string {
  return `\`\`\`ts path=${path}\n${content}\n\`\`\``;
}

function fakeLauncher(): typeof launch {
  return async (_store, _task, attempt) => ({
    child: new EventEmitter() as never,
    exited: Promise.resolve({ code: 0, signal: null }),
    attempt,
  });
}

async function retryWithBrief(
  h: ReturnType<typeof harness>,
  taskId: string,
  blocks: string[],
  path: string,
): Promise<void> {
  const reshapedPath = join(h.settings.stateDirectory, 'reshaped.md');
  writeFileSync(reshapedPath, briefWith(blocks, path));
  const retryTasks = new WorkerTasks(h.settings, h.store, (pool) => reading(pool), fakeLauncher());
  await retryTasks.retry(taskId, { brief: reshapedPath });
}

test('when a reshaped brief stops freezing a file that exists on the task base, the file is restored to its base content, not deleted', async () => {
  const h = harness();
  try {
    const path = 'tools/goal/src/existing.test.ts';
    const baseContent = 'export const source = "task base";\n';
    mkdirSync(join(h.root, 'tools/goal/src'), { recursive: true });
    writeFileSync(join(h.root, path), baseContent);
    git(h.root, ['add', '--', path]);
    git(h.root, ['commit', '-m', 'Add existing acceptance file']);

    writeFileSync(h.briefFile, briefWith([frozenBlock(path, 'export const source = "frozen";')], path));
    const task = h.tasks.dispatch(h.briefFile);
    expect(readFileSync(join(task.worktree, path), 'utf8')).toContain('frozen');

    await retryWithBrief(h, task.id, [], path);

    expect(existsSync(join(task.worktree, path))).toBe(true);
    expect(readFileSync(join(task.worktree, path), 'utf8')).toBe(baseContent);
  } finally {
    h.dispose();
  }
});

test('when a reshaped brief stops freezing a file that the earlier brief created (absent on the base), the file is removed', async () => {
  const h = harness();
  try {
    const path = 'tools/goal/src/created.test.ts';
    writeFileSync(h.briefFile, briefWith([frozenBlock(path, 'export const source = "frozen";')], path));
    const task = h.tasks.dispatch(h.briefFile);
    expect(existsSync(join(task.worktree, path))).toBe(true);

    await retryWithBrief(h, task.id, [], path);

    expect(existsSync(join(task.worktree, path))).toBe(false);
  } finally {
    h.dispose();
  }
});

test('files the new brief still freezes are written from the brief as before', async () => {
  const h = harness();
  try {
    const path = 'tools/goal/src/continued.test.ts';
    writeFileSync(h.briefFile, briefWith([frozenBlock(path, 'export const source = "first";')], path));
    const task = h.tasks.dispatch(h.briefFile);

    await retryWithBrief(h, task.id, [frozenBlock(path, 'export const source = "replacement";')], path);

    expect(readFileSync(join(task.worktree, path), 'utf8')).toBe('export const source = "replacement";\n');
  } finally {
    h.dispose();
  }
});
