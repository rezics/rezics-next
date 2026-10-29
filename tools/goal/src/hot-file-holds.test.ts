import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
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
  const realBun = Bun.which('bun')!;
  try {
    h.ensureDev();
    mkdirSync(bin, { recursive: true });
    const shim = join(bin, 'bun');
    writeFileSync(
      shim,
      `#!/bin/sh\nif [ "$1" = install ]; then\n  printf '%s\\n' "$*" >> ${JSON.stringify(installLog)}\n  printf 'installed from integration\\n' > bun.lock\nelse\n  exec ${JSON.stringify(realBun)} "$@"\nfi\n`,
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
      const current = h.store.task(task.id);
      h.store.updateTask({ taskId: task.id, attempt: current.currentAttempt }, (current) => {
        current.state = 'stopped';
      });

      const retried = await h.tasks.retry(task.id);

      expect(retried.attempt.attempt).toBe(current.currentAttempt + 1);
      expect(git(task.worktree, 'show', `${task.branch}:bun.lock`)).toBe('installed from integration');
      expect((await Bun.file(installLog).text()).trim().split('\n')).toEqual([
        'install',
      ]);
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
    try {
      const task = h.dispatch('bun.lock');
      await h.start(task);
      h.advanceDev('bun.lock', 'integration lock\n');
      process.env.PATH = `${bin}:${originalPath}`;

      await h.train();

      expect(h.outcomes[0]).toMatchObject({ passed: true, stage: 'merge' });
      expect(h.store.task(task.id).state).toBe('integrated');
      expect(git(h.root, 'show', 'dev:bun.lock')).toBe('installed from integration');
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
    mkdirSync(join(task.worktree, '.temp'), { recursive: true });
    writeFileSync(join(task.worktree, '.temp/worker-plan.json'), JSON.stringify({ file: 'bun.lock', content: 'worker lock\n' }));
    await h.start(task);
    git(task.worktree, 'reset', '--soft', 'HEAD^');
    writeFileSync(join(task.worktree, 'bun.lock'), 'worker lock\n');
    writeFileSync(join(task.worktree, ordinary), 'worker other\n');
    git(task.worktree, 'add', '--', 'bun.lock', ordinary);
    git(task.worktree, 'commit', '-m', 'Add another worker change');
    h.advanceDev('bun.lock', 'integration lock\n');
    h.advanceDev(ordinary, 'integration other\n');

    await h.train(undefined, false);

    expect(h.outcomes[0]?.stage).toBe('rebase');
    expect(h.outcomes[0]?.conflictedFiles).toEqual(expect.arrayContaining(['bun.lock', ordinary]));
    expect(git(h.root, 'show', 'dev:bun.lock')).toBe('integration lock');
    expect(git(h.root, 'show', `dev:${ordinary}`)).toBe('integration other');
  } finally {
    h.dispose();
  }
});

test('a rebase conflict confined to bun.lock is resolved by taking the integration side, running bun install, staging the lockfile and continuing, at retry and in the train', async () => {
  for (const surface of ['retry', 'train'] as const) {
    const h = integrationHarness();
    const originalPath = process.env.PATH ?? '';
    let replacement: Awaited<ReturnType<typeof h.tasks.retry>> | undefined;
    try {
      h.ensureDev();
      const task = h.dispatch('bun.lock');
      await h.start(task);
      h.advanceDev('bun.lock', 'integration lock\n');
      const bin = join(h.settings.stateDirectory, 'verified-bun');
      const installed = join(h.settings.stateDirectory, 'installed');
      mkdirSync(bin);
      // Fail unless checkout --ours selected the integration side before install.
      writeFileSync(
        join(bin, 'bun'),
        `#!/bin/sh
if [ "$1" = install ]; then
  test "$#" = 1 || exit 81
  test "$(cat bun.lock)" = 'integration lock' || exit 82
  printf 'regenerated lock\\n' > bun.lock
  printf 'install\\n' >> ${JSON.stringify(installed)}
else
  exec ${JSON.stringify(process.execPath)} "$@"
fi
`,
      );
      chmodSync(join(bin, 'bun'), 0o755);
      process.env.PATH = `${bin}:${originalPath}`;
      if (surface === 'retry') {
        // The replacement worker keeps the resolved lockfile intact.
        writeFileSync(
          join(task.worktree, '.temp/worker-plan.json'),
          JSON.stringify({
            file: 'bun.lock',
            content: 'regenerated lock\n',
          }),
        );
        h.store.updateTask({ taskId: task.id, attempt: 1 }, (current) => {
          current.state = 'stopped';
        });
        replacement = await h.tasks.retry(task.id);
        await replacement.exited;
        expect(git(task.worktree, 'show', 'HEAD:bun.lock')).toBe('regenerated lock');
        expect(git(task.worktree, 'status', '--porcelain')).toBe('');
        expect(git(task.worktree, 'merge-base', '--is-ancestor', h.head(), 'HEAD')).toBe('');
      } else {
        const gated = join(h.settings.stateDirectory, 'gated');
        (
          h.settings as typeof h.settings & { integrationChecks: { paths: string[]; command: string[] }[] }
        ).integrationChecks = [{
          paths: ['bun.lock'],
          command: ['sh', '-c', `test "$(cat bun.lock)" = 'regenerated lock' && test -z "$(git diff --name-only --diff-filter=U)" && printf 'checked\\n' > ${JSON.stringify(gated)}`],
        }];
        await h.train();
        expect(readFileSync(gated, 'utf8')).toBe('checked\n');
        expect(h.outcomes[0]).toMatchObject({ passed: true, stage: 'merge' });
        expect(git(h.root, 'show', 'dev:bun.lock')).toBe('regenerated lock');
      }
      expect(readFileSync(installed, 'utf8')).toBe('install\n');
    } finally {
      if (replacement) await replacement.exited;
      process.env.PATH = originalPath;
      h.dispose();
    }
  }
}, 30_000);

test('a rebase that conflicts in bun.lock and in other files still stops at the other files', async () => {
  const h = integrationHarness();
  const originalPath = process.env.PATH ?? '';
  let replacement: Awaited<ReturnType<typeof h.tasks.retry>> | undefined;
  try {
    h.ensureDev();
    const task = h.tasks.dispatch(briefFile(h, ['bun.lock', 'ordinary.txt']));
    writeFileSync(join(task.worktree, 'bun.lock'), 'worker lock\n');
    writeFileSync(join(task.worktree, 'ordinary.txt'), 'worker text\n');
    git(task.worktree, 'add', '--', 'bun.lock', 'ordinary.txt');
    git(task.worktree, 'commit', '-m', 'Change lockfile and ordinary text');
    h.advanceDev('bun.lock', 'integration lock\n');
    h.advanceDev('ordinary.txt', 'integration text\n');
    const bin = join(h.settings.stateDirectory, 'mixed-bun');
    const installed = join(h.settings.stateDirectory, 'unexpected-install');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'bun'),
      `#!/bin/sh
if [ "$1" = install ]; then
  touch ${JSON.stringify(installed)}
  exit 83
fi
exec ${JSON.stringify(process.execPath)} "$@"
`,
    );
    chmodSync(join(bin, 'bun'), 0o755);
    // The replacement worker exits without editing the conflicts it was handed.
    writeFileSync(h.settings.pools[0]!.command, '#!/bin/sh\nexit 0\n');
    process.env.PATH = `${bin}:${originalPath}`;
    replacement = await h.tasks.retry(task.id);
    await replacement.exited;
    expect(git(task.worktree, 'diff', '--name-only', '--diff-filter=U').split('\n').sort()).toEqual([
      'bun.lock',
      'ordinary.txt',
    ]);
    expect(existsSync(installed)).toBe(false);
    expect(git(h.root, 'show', 'dev:ordinary.txt')).toBe('integration text');
  } finally {
    if (replacement) await replacement.exited;
    process.env.PATH = originalPath;
    h.dispose();
  }
}, 30_000);
