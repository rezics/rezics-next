import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { ownedTemporaryDirectory } from '../../../scripts/tmp-janitor.ts';
import { offHostFixtureParent } from '../test-support/off-host-fixture.ts';
import { checkScriptFixture, harness, reading } from './test-support.ts';
import { git, WorkerTasks } from './tasks.ts';

const devScripts = checkScriptFixture();

function briefText(
  command: string[],
  options: { placement?: string; after?: string[]; urgent?: boolean } = {},
): string {
  return `---
goal: fixture
manager: fixture
kind: implementation
${options.urgent ? 'urgent: true\n' : ''}paths: [result.txt]
riskAreas: []
acceptance:
  command: ${JSON.stringify(command)}
  tests: [local acceptance]
  failing: true
  placement: ${options.placement ?? 'local'}
estimate:
  lines: 1
  files: 1
criticalPath: false
waiting: []
${options.after?.length ? `after: ${JSON.stringify(options.after)}\n` : ''}---
Run the acceptance command.
`;
}

function localCheckEnvironment(root: string): NodeJS.ProcessEnv {
  const hosts = join(root, '.temp/goal/fake-hosts.json');
  mkdirSync(join(root, '.temp/goal'), { recursive: true });
  writeFileSync(
    hosts,
    JSON.stringify({
      hosts: [
        {
          name: 'must-not-run',
          address: 'tester@192.0.2.1',
          identity: '/dev/null',
          memoryMaxGiB: 8,
          cpuQuotaPercent: 100,
          slots: 1,
          performance: false,
        },
      ],
    }),
  );
  return {
    PATH: '/usr/bin:/bin',
    GOAL_MAIN_CHECKOUT: root,
    KERNEL_CHECK_REMOTE: hosts,
    REZICS_CHECK_LEDGER_DIR: join(root, '.temp/goal/check-ledger'),
    REZICS_CHECK_MEMORY_GIB: '4',
    REZICS_CHECK_MEMORY_DIR: join(root, '.temp/goal/check-memory'),
    REZICS_STACK_SLOTS: '4',
    REZICS_STACK_LEASE_DIR: join(root, '.temp/goal/stack-lease'),
    REZICS_CHECK_SCOPE: 'off',
  };
}

function commandStatus(result: ReturnType<typeof spawnSync>): string {
  return (
    result.error?.message ||
    result.stderr?.toString().trim() ||
    result.stdout?.toString().trim() ||
    `status ${result.status}`
  );
}

function workerCheck(root: string, env: NodeJS.ProcessEnv, args: readonly string[]) {
  return spawnSync(process.execPath, [join(root, 'scripts/worker-check.ts'), ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 15_000,
  });
}

function startCheck(root: string, env: NodeJS.ProcessEnv, argv: readonly string[]): string {
  const start = workerCheck(root, env, argv);
  if (start.status !== 0) throw new Error(`worker-check start failed: ${commandStatus(start)}`);
  const id = /check: id ([0-9a-f-]{36})/i.exec(start.stdout)?.[1];
  if (!id) throw new Error(`worker-check did not publish a check id: ${commandStatus(start)}`);
  return id;
}

test('registered local placement survives dispatch, retry, held reshape, and task publication', async () => {
  const h = harness();
  try {
    mkdirSync(join(h.root, 'scripts'), { recursive: true });
    writeFileSync(join(h.root, 'scripts/worker-check.ts'), '');
    git(h.root, ['add', 'scripts/worker-check.ts']);
    git(h.root, ['commit', '-m', 'Seed wrapper for placement fixture']);

    const prompts: string[] = [];
    const tasks = new WorkerTasks(
      h.settings,
      h.store,
      (pool) => reading(pool),
      async (_store, _task, attempt, _pool, prompt) => {
        prompts.push(prompt);
        return { exited: Promise.resolve({ code: 0, signal: null }), attempt };
      },
    );
    const firstBrief = join(h.settings.stateDirectory, 'placement-local.md');
    const freshCommand = [
      'bun',
      'test',
      'apps/web/tests/shell-menus.test.ts',
      '-t',
      'the signed-out account action opens a sheet on phones and a dropdown on desktop',
    ];
    writeFileSync(firstBrief, briefText(freshCommand));
    const task = tasks.dispatch(firstBrief);
    expect(h.store.task(task.id).brief.acceptance).toMatchObject({ placement: 'local', command: freshCommand });

    // The ordinary check-host budget selects minimal verification even without an explicit mode.
    const first = await tasks.retry(task.id);
    await first.exited;
    expect(first.attempt).toMatchObject({ taskId: task.id, attempt: 1 });
    expect(prompts[0]).toContain('Verification is minimal. Defer ordinary acceptance');
    expect(prompts[0]).not.toContain('bun scripts/worker-check.ts --local --');

    const dependency = tasks.dispatch(h.briefFile);
    const retryBrief = join(h.settings.stateDirectory, 'placement-retry.md');
    const retryCommand = [
      'bun',
      'test',
      'apps/web/tests/shell-menus.test.ts',
      '-t',
      'the phone navigation and every shell menu use the responsive bottom sheet',
    ];
    writeFileSync(retryBrief, briefText(retryCommand));
    writeFileSync(join(h.settings.stateDirectory, 'verification-mode'), 'source-only\n');
    const second = await tasks.retry(task.id, { brief: retryBrief });
    await second.exited;
    expect(second.attempt).toMatchObject({ taskId: task.id, attempt: 2 });
    expect(h.store.task(task.id).brief.acceptance).toMatchObject({ placement: 'local', command: retryCommand });
    expect(prompts[1]).toContain('Source-only delivery is authorized for this attempt.');
    expect(prompts[1]).not.toContain('Verification is minimal');
    expect(prompts[1]).not.toContain('bun scripts/worker-check.ts --local --');

    h.store.updateTask({ taskId: task.id, attempt: second.attempt.attempt }, (current) => {
      current.state = 'stopped';
    });
    h.store.updateAttempt({ taskId: task.id, attempt: second.attempt.attempt }, (attempt) => {
      attempt.state = 'stopped';
    });
    const heldBrief = join(h.settings.stateDirectory, 'placement-held.md');
    writeFileSync(heldBrief, briefText(['bun', 'run', '--cwd', 'apps/web', 'typecheck'], { after: [dependency.id] }));
    tasks.queueRetry(task.id, { brief: heldBrief });
    const published = h.store.task(task.id);
    expect(published).toMatchObject({ id: task.id, state: 'held', currentAttempt: second.attempt.attempt });
    expect(published.brief.acceptance).toMatchObject({
      placement: 'local',
      command: ['bun', 'run', '--cwd', 'apps/web', 'typecheck'],
    });
    expect(published.brief.markdown).toContain('placement: local');
    expect(h.store.retryIntent({ taskId: task.id, attempt: second.attempt.attempt })?.status).toBe('pending');

    const invalidBrief = join(h.settings.stateDirectory, 'placement-invalid.md');
    writeFileSync(invalidBrief, briefText(freshCommand, { placement: 'remote' }));
    const beforeTask = h.store.task(task.id);
    const beforeIntent = h.store.retryIntent({ taskId: task.id, attempt: second.attempt.attempt });
    expect(() => tasks.queueRetry(task.id, { brief: invalidBrief })).toThrow(
      'acceptance.placement must be local or default',
    );
    expect(h.store.task(task.id)).toEqual(beforeTask);
    expect(h.store.retryIntent({ taskId: task.id, attempt: second.attempt.attempt })).toEqual(beforeIntent);
  } finally {
    h.dispose();
  }
});

test('the audited timeout, focused-runner, and environment forms survive public brief flows without widening local routes', async () => {
  const h = harness();
  try {
    mkdirSync(join(h.root, 'scripts'), { recursive: true });
    writeFileSync(join(h.root, 'scripts/worker-check.ts'), '');
    git(h.root, ['add', 'scripts/worker-check.ts']);
    git(h.root, ['commit', '-m', 'Seed wrapper for audited local placement']);

    const prompts: string[] = [];
    const tasks = new WorkerTasks(
      h.settings,
      h.store,
      (pool) => reading(pool),
      async (_store, _task, attempt, _pool, prompt) => {
        prompts.push(prompt);
        return { exited: Promise.resolve({ code: 0, signal: null }), attempt };
      },
    );
    const shellCommand = 'bun run --cwd apps/web typecheck && bun test apps/web/tests/subject-story-fake.test.ts';
    const freshCommand = ['timeout', '590', 'sh', '-c', shellCommand];
    const freshPath = join(h.settings.stateDirectory, 'audited-timeout.md');
    writeFileSync(freshPath, briefText(freshCommand, { urgent: true }));
    // The urgent verifier lane is exempt from the ordinary budget and renders the declared acceptance.
    const task = tasks.dispatch(freshPath, null, false, 'verifier');
    expect(task.brief.acceptance).toMatchObject({ placement: 'local', command: freshCommand });

    const first = await tasks.retry(task.id);
    await first.exited;
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const expected = (command: string[]) => `bun scripts/worker-check.ts --local -- ${command.map(quote).join(' ')}`;
    expect(prompts[0]!).toContain(expected(freshCommand));
    expect(prompts[0]!.match(/bun scripts\/worker-check\.ts --local --/g)).toHaveLength(1);

    const selector =
      'every non-English page story contains no untranslated message or type-name text|localized page choices|a subject page renders the subject in the page language on the server|labels fall back to English and keep their own language';
    const focusedCommand = [
      'env',
      '-u',
      'KERNEL_ORIGIN',
      'PUBLIC_ORIGIN=http://127.0.0.1:3000',
      'bun',
      'apps/web/scripts/focused.ts',
      '--private-network',
      '--',
      'bun',
      'test',
      'tests/page-stories.test.ts',
      'tests/localized-page-choices.test.ts',
      'tests/subject.test.ts',
      '-t',
      selector,
    ];
    const retryPath = join(h.settings.stateDirectory, 'audited-focused-retry.md');
    writeFileSync(retryPath, briefText(focusedCommand, { urgent: true }));
    const second = await tasks.retry(task.id, { brief: retryPath });
    await second.exited;
    expect(h.store.task(task.id).brief.acceptance).toMatchObject({
      placement: 'local',
      command: focusedCommand,
    });
    expect(prompts[1]!).toContain(expected(focusedCommand));
    expect(prompts[1]!.match(/bun scripts\/worker-check\.ts --local --/g)).toHaveLength(1);

    const dependency = tasks.dispatch(h.briefFile);
    h.store.updateTask(second.attempt, (current) => {
      current.state = 'stopped';
    });
    h.store.updateAttempt(second.attempt, (attempt) => {
      attempt.state = 'stopped';
    });
    const heldCommand = [
      'sh',
      '-c',
      `bun run --cwd apps/web typecheck && env -u KERNEL_ORIGIN PUBLIC_ORIGIN=http://127.0.0.1:3000 bun apps/web/scripts/focused.ts --private-network -- bun test tests/page-stories.test.ts -t "${selector}"`,
    ];
    const heldPath = join(h.settings.stateDirectory, 'audited-focused-held.md');
    writeFileSync(heldPath, briefText(heldCommand, { after: [dependency.id], urgent: true }));
    tasks.queueRetry(task.id, { brief: heldPath });
    expect(h.store.task(task.id)).toMatchObject({
      state: 'held',
      brief: { acceptance: { placement: 'local', command: heldCommand } },
    });
    expect(h.store.retryIntent(second.attempt)?.status).toBe('pending');

    const unsafeCommands = [
      ['timeout', '600', 'sh', '-c', shellCommand],
      [
        'env',
        '-u',
        'PATH',
        'bun',
        'apps/web/scripts/focused.ts',
        '--private-network',
        '--',
        'bun',
        'test',
        'tests/subject.test.ts',
      ],
      [
        'bun',
        'apps/web/scripts/focused.ts',
        '--private-network',
        '--',
        'bun',
        'test',
        'tests/../native/kernel.test.ts',
      ],
      ['bun', 'apps/web/scripts/focused.ts', '--private-network', '--', 'bun', 'test', 'tests/subject.browser.test.ts'],
      [
        'bun',
        'apps/web/scripts/focused.ts',
        '--private-network',
        '--',
        'bun',
        'test',
        'tests/subject.test.ts',
        '--preload',
        './setup.ts',
      ],
      ['bun', 'apps/web/scripts/focused.ts', '--private-network', '--', 'bun', 'test', 'tests/sql-compiler.test.ts'],
      ['bun', 'apps/kernel/tests/subject.test.ts'],
      ['bun', 'apps/auth/tests/subject.test.ts'],
      [
        'bun',
        'apps/web/scripts/focused.ts',
        '--private-network',
        '--',
        'bun',
        'test',
        'tests/database/subject.test.ts',
      ],
      ['sh', '-c', 'bun test apps/web/tests/subject.test.ts; bun run build'],
      ['sh', '-c', 'bun test apps/web/tests/subject.test.ts && bun test $(printf extra)'],
    ];
    for (const [index, command] of unsafeCommands.entries()) {
      const path = join(h.settings.stateDirectory, `audited-unsafe-${index}.md`);
      writeFileSync(path, briefText(command));
      expect(() => tasks.dispatch(path)).toThrow();
    }
  } finally {
    h.dispose();
  }
});

test('the real off-host wrapper runs a bounded unit command once and refuses local database fallback', () => {
  const temporary = ownedTemporaryDirectory(offHostFixtureParent(), 'rezics-goal-off-host-');
  try {
    const root = temporary.path;
    git(root, ['init', '--quiet']);
    devScripts.install(root);
    const env = localCheckEnvironment(root);
    const checks = join(root, '.temp/goal/checks');
    for (const [file, marker, exitCode] of [
      ['tests/local-acceptance.test.ts', 'local acceptance executed', 0],
      ['services/kernel/tests/database.test.ts', 'database acceptance executed', 75],
    ] as const) {
      const commandFile = join(root, file);
      mkdirSync(dirname(commandFile), { recursive: true });
      writeFileSync(
        commandFile,
        `import { test } from 'bun:test';\ntest('fixture command', () => console.log(${JSON.stringify(marker)}));\n`,
      );
      const argv = ['--local', '--', 'bun', 'test', file, '-t', 'fixture command'];
      const id = startCheck(root, env, argv);
      const wait = workerCheck(root, env, ['--wait', id]);
      if (wait.status !== exitCode) throw new Error(`unexpected worker-check result: ${commandStatus(wait)}`);
      const record: unknown = JSON.parse(readFileSync(join(checks, 'results', `${id}.json`), 'utf8'));
      expect(record).toMatchObject({ argv, status: 'finished', exitCode });

      const logs = readdirSync(checks)
        .filter((name) => name.startsWith(`worker-check-${id}-`) && name.endsWith('.log'))
        .map((name) => readFileSync(join(checks, name), 'utf8'));
      expect(logs).toHaveLength(1);
      expect(logs[0]!.split('\n').filter((line) => line === marker)).toHaveLength(exitCode === 0 ? 1 : 0);
      if (exitCode !== 0) expect(logs[0]).toContain('contain no performance-approved host');
    }
  } finally {
    temporary.close();
  }
}, 35_000);

test('an unresolved old check prevents local policy adoption without cancelling it or launching a replacement', async () => {
  const h = harness();
  let releaseCheck: (() => void) | undefined;
  try {
    const files = devScripts.install(h.root);
    git(h.root, ['add', '--', ...files]);
    git(h.root, ['commit', '-m', 'Seed worker-check custody fixture']);
    const prompts: string[] = [];
    const tasks = new WorkerTasks(
      h.settings,
      h.store,
      (pool) => reading(pool),
      async (_store, _task, attempt, _pool, prompt) => {
        prompts.push(prompt);
        return { exited: Promise.resolve({ code: 0, signal: null }), attempt };
      },
    );
    const task = tasks.dispatch(h.briefFile);
    const releaseMarker = join(h.settings.stateDirectory, 'release-old-check');
    const env = localCheckEnvironment(task.worktree);
    // Stand in for a local formatter so the old check stays running until this fixture releases it.
    const formatter = join(h.settings.stateDirectory, 'oxfmt');
    writeFileSync(formatter, '#!/bin/sh\nfor i in $(seq 500); do [ ! -f "$1" ] || exit 0; sleep 0.02; done\nexit 1\n', {
      mode: 0o700,
    });
    const checkId = startCheck(task.worktree, env, ['--local', '--', formatter, releaseMarker]);
    releaseCheck = () => {
      writeFileSync(releaseMarker, 'release');
      const wait = workerCheck(task.worktree, env, ['--wait', checkId]);
      if (wait.status !== 0) throw new Error(`test-owned old check failed: ${commandStatus(wait)}`);
    };

    const first = await tasks.retry(task.id);
    await first.exited;
    h.store.updateAttempt(first.attempt, (attempt) => {
      attempt.state = 'waiting';
      attempt.checks = [checkId];
      attempt.session = 'legacy-session';
    });
    h.store.updateTask(first.attempt, (current) => {
      current.state = 'running';
    });
    const localBrief = join(h.settings.stateDirectory, 'adopt-old-check.md');
    writeFileSync(localBrief, briefText(['bun', 'test', 'apps/web/tests/shell-menus.test.ts']));
    const error = 'no supported worker-check teardown-intent/receipt API is available';

    expect(() => tasks.queueRetry(task.id, { brief: localBrief })).toThrow(error);
    await expect(tasks.retry(task.id, { brief: localBrief })).rejects.toThrow(error);
    expect(h.store.task(task.id).currentAttempt).toBe(1);
    expect(h.store.task(task.id).brief.acceptance.placement).toBeUndefined();
    expect(h.store.attempt(first.attempt).state).toBe('waiting');
    expect(h.store.retryIntent(first.attempt)).toBeUndefined();
    expect(prompts).toHaveLength(1);
    const results = join(task.worktree, '.temp/goal/checks/results');
    expect(readdirSync(results)).toEqual([`${checkId}.json`]);
    const record = JSON.parse(readFileSync(join(results, `${checkId}.json`), 'utf8')) as {
      status?: string;
      exitCode?: number;
      runnerPid?: number;
      runnerHost?: string;
    };
    expect(record.status).toBe('running');
    expect(record.exitCode).toBeUndefined();
    expect(record.runnerPid).toEqual(expect.any(Number));
    expect(record.runnerHost).toBe(hostname());
    expect(() => process.kill(record.runnerPid!, 0)).not.toThrow();

    const finish = releaseCheck;
    releaseCheck = undefined;
    finish();
    tasks.queueRetry(task.id, { brief: localBrief });
    expect(h.store.retryIntent(first.attempt)?.status).toBe('pending');
    expect(h.store.task(task.id).brief.acceptance.placement).toBe('local');
  } finally {
    try {
      releaseCheck?.();
    } finally {
      h.dispose();
    }
  }
}, 20_000);
