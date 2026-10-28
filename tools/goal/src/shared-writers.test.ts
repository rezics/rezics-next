import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkerJob } from './job.ts';
import { git } from './merge.ts';
import { harness, markdown } from './test-support.ts';
import type { Task, TaskState } from './types.ts';

function briefFile(
  h: ReturnType<typeof harness>,
  name: string,
  paths: string[],
  options: { goal?: string; after?: string[] } = {},
): string {
  const path = join(h.settings.stateDirectory, `${name}.md`);
  let content = markdown
    .replace('goal: fixture', `goal: ${options.goal ?? 'fixture'}`)
    .replace('paths: [result.txt]', `paths: ${JSON.stringify(paths)}`)
    .replace('command: [bun, test]', 'command: ["true"]');
  if (options.after) content = content.replace('waiting: []', `waiting: []\nafter: ${JSON.stringify(options.after)}`);
  writeFileSync(path, content);
  return path;
}

for (const state of ['running', 'landing'] as const satisfies readonly TaskState[]) {
  test(`dispatch holds after the earliest ${state} writer from another Goal and reports its file`, () => {
    const h = harness();
    try {
      const sharedFile = 'services/kernel/src/library/entries.ts';
      const writer = h.tasks.dispatch(briefFile(h, 'writer', [sharedFile], { goal: 'kernel' }));
      const laterWriter = h.tasks.dispatch(briefFile(h, 'later-writer', [sharedFile], { goal: 'api' }));
      h.store.updateTask({ taskId: writer.id, attempt: 0 }, (task) => {
        task.state = state;
      });
      h.store.updateTask({ taskId: laterWriter.id, attempt: 0 }, (task) => {
        task.state = state === 'running' ? 'landing' : 'running';
      });

      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...messages: Parameters<typeof console.warn>) => warnings.push(messages.map(String).join(' '));
      let dispatched: Task;
      try {
        dispatched = h.tasks.dispatch(briefFile(h, 'later', [sharedFile], { goal: 'docs' }));
      } finally {
        console.warn = originalWarn;
      }

      expect(dispatched.state).toBe('held');
      expect(dispatched.brief.after).toEqual([writer.id]);
      expect(dispatched.brief.after).not.toContain(laterWriter.id);
      expect(dispatched.brief.markdown).toContain(writer.id);
      expect(readFileSync(dispatched.briefPath, 'utf8')).toContain(writer.id);
      expect(warnings.join('\n')).toContain(writer.id);
      expect(warnings.join('\n')).toContain(sharedFile);
    } finally {
      h.dispose();
    }
  });
}

test('directory globs and declared derived files do not hold dispatch', () => {
  const h = harness();
  try {
    const directoryWriter = h.tasks.dispatch(briefFile(h, 'directory-writer', ['docs/*.md']));
    h.store.updateTask({ taskId: directoryWriter.id, attempt: 0 }, (task) => {
      task.state = 'running';
    });
    const inDirectory = h.tasks.dispatch(briefFile(h, 'in-directory', ['docs/guide.md']));
    expect(inDirectory.state).toBe('ready');
    expect(inDirectory.brief.after).toEqual([]);

    const generatedWriter = h.tasks.dispatch(briefFile(h, 'generated-writer', ['bun.lock']));
    h.store.updateTask({ taskId: generatedWriter.id, attempt: 0 }, (task) => {
      task.state = 'landing';
    });
    const generated = h.tasks.dispatch(briefFile(h, 'generated', ['bun.lock']));
    expect(generated.state).toBe('ready');
    expect(generated.brief.after).toEqual([]);
  } finally {
    h.dispose();
  }
});

test('a stopped task with an earlier attempt does not hold a later writer', async () => {
  const blockedWorker = `#!/usr/bin/env bun
import { readSync } from 'node:fs';
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-session'}));
const byte = Buffer.alloc(1);
readSync(0, byte, 0, 1, null);
`;
  const h = harness(blockedWorker);
  try {
    const sharedFile = 'history.txt';
    const previous = h.tasks.dispatch(briefFile(h, 'previous', [sharedFile]));
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await job.start(previous.id);
    await h.tasks.stop(previous.id);
    expect(h.store.task(previous.id).currentAttempt).toBe(1);
    expect(h.store.attempt({ taskId: previous.id, attempt: 1 }).state).toBe('stopped');

    const later = h.tasks.dispatch(briefFile(h, 'later', [sharedFile]));
    expect(later.state).toBe('ready');
    expect(later.brief.after).toEqual([]);
  } finally {
    h.dispose();
  }
});

test('an automatically held writer starts when its shared-file dependency integrates', async () => {
  const h = harness();
  try {
    h.settings.gate = ['true'];
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const first = h.tasks.dispatch(briefFile(h, 'first', ['result.txt'], { goal: 'kernel' }));
    await job.start(first.id);
    const later = h.tasks.dispatch(briefFile(h, 'later', ['result.txt'], { goal: 'docs' }));
    expect(later.state).toBe('held');
    expect(later.brief.after).toEqual([first.id]);
    expect(h.store.task(later.id).currentAttempt).toBe(0);

    const firstCommit = git(h.store.task(first.id).worktree, 'rev-parse', 'HEAD');
    const devBeforeFirst = git(h.root, 'rev-parse', 'dev');
    git(h.root, 'update-ref', 'refs/heads/dev', firstCommit, devBeforeFirst);
    job.onGateOutcome({
      taskId: first.id,
      attempt: 1,
      passed: true,
      stage: 'merge',
      mergedCommit: firstCommit,
      logPath: 'fixture',
      hostMs: 1,
      changedFiles: ['result.txt'],
      diffLines: 1,
    });
    await job.drain();

    expect(h.store.task(first.id).state).toBe('integrated');
    expect(h.store.task(later.id).currentAttempt).toBe(1);
  } finally {
    h.dispose();
  }
});
