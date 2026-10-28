import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './merge.ts';
import { harness, integrationHarness, markdown } from './test-support.ts';

function briefFile(h: ReturnType<typeof harness>, paths: string[], after: string[] = []): string {
  const file = join(h.settings.stateDirectory, `hot-${crypto.randomUUID()}.md`);
  writeFileSync(
    file,
    markdown
      .replace('paths: [result.txt]', `paths: ${JSON.stringify(paths)}`)
      .replace('command: [bun, test]', 'command: ["true"]')
      .replace('waiting: []', `waiting: []\nafter: ${JSON.stringify(after)}`),
  );
  return file;
}

test('a bun.lock-only rebase conflict on retry keeps integration, installs, stages and continues', async () => {
  const h = integrationHarness();
  const bin = join(h.settings.stateDirectory, 'fake-bin');
  const installLog = join(h.settings.stateDirectory, 'bun-install.log');
  try {
    h.ensureDev();
    mkdirSync(bin, { recursive: true });
    const shim = join(bin, 'bun');
    writeFileSync(
      shim,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(installLog)}\nprintf 'installed from integration\\n' > bun.lock\n`,
    );
    chmodSync(shim, 0o755);
    const originalPath = process.env.PATH ?? '';
    try {
      const task = h.dispatch('bun.lock');
      writeFileSync(
        join(task.worktree, '.temp/worker-plan.json'),
        JSON.stringify({ file: 'bun.lock', content: 'worker lock\n' }),
      );
      await h.start(task);
      h.advanceDev('bun.lock', 'integration lock\n');
      process.env.PATH = `${bin}:${originalPath}`;
      h.store.updateTask({ taskId: task.id, attempt: task.currentAttempt }, (current) => {
        current.state = 'stopped';
      });

      const retried = await h.tasks.retry(task.id);

      expect(retried.currentAttempt).toBe(task.currentAttempt + 1);
      expect(git(task.worktree, 'show', `${task.branch}:bun.lock`)).toBe('installed from integration\n');
      expect((await Bun.file(installLog).text()).trim()).toBe('install --frozen-lockfile');
      expect(git(task.worktree, 'diff', '--name-only', '--diff-filter=U')).toBe('');
    } finally {
      process.env.PATH = originalPath;
    }
  } finally {
    h.dispose();
  }
});

test('a bun.lock-only rebase conflict in the train keeps integration, installs, stages and continues', async () => {
  const h = integrationHarness();
  const bin = join(h.settings.stateDirectory, 'fake-bin');
  const installLog = join(h.settings.stateDirectory, 'bun-install.log');
  try {
    h.ensureDev();
    mkdirSync(bin, { recursive: true });
    const shim = join(bin, 'bun');
    writeFileSync(
      shim,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(installLog)}\nprintf 'installed from integration\\n' > bun.lock\n`,
    );
    chmodSync(shim, 0o755);
    const originalPath = process.env.PATH ?? '';
    process.env.PATH = `${bin}:${originalPath}`;
    try {
      const task = h.dispatch('bun.lock');
      await h.start(task);
      h.advanceDev('bun.lock', 'integration lock\n');
      h.settings.integrationChecks = [];

      await h.train();

      expect(h.store.task(task.id).state).toBe('integrated');
      expect(h.outcomes[0]?.passed).toBe(true);
      expect(git(h.root, 'show', 'dev:bun.lock')).toBe('installed from integration\n');
      expect((await Bun.file(installLog).text()).trim()).toBe('install');
    } finally {
      process.env.PATH = originalPath;
    }
  } finally {
    h.dispose();
  }
});

test('a bun.lock conflict mixed with another file stays with the worker', async () => {
  const h = integrationHarness();
  const ordinary = 'ordinary.txt';
  try {
    h.ensureDev();
    const task = h.tasks.dispatch(briefFile(h, ['bun.lock', ordinary]));
    writeFileSync(join(task.worktree, '.temp/worker-plan.json'), JSON.stringify({ file: 'bun.lock', content: 'worker lock\n' }));
    await h.start(task);
    git(task.worktree, 'reset', '--soft', 'HEAD^');
    writeFileSync(join(task.worktree, 'bun.lock'), 'worker lock\n');
    writeFileSync(join(task.worktree, ordinary), 'worker other\n');
    git(task.worktree, 'add', '--', 'bun.lock', ordinary);
    git(task.worktree, 'commit', '-m', 'Add another worker change');
    h.advanceDev('bun.lock', 'integration lock\n');
    h.advanceDev(ordinary, 'integration other\n');
    h.settings.integrationChecks = [];

    await h.train(undefined, false);

    expect(h.outcomes[0]?.stage).toBe('rebase');
    expect(h.outcomes[0]?.conflictedFiles).toEqual(expect.arrayContaining(['bun.lock', ordinary]));
    expect(git(h.root, 'show', 'dev:bun.lock')).toBe('integration lock');
    expect(git(h.root, 'show', `dev:${ordinary}`)).toBe('integration other');
  } finally {
    h.dispose();
  }
});
