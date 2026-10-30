import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { harness, reading } from './test-support.ts';
import { git, WorkerTasks } from './tasks.ts';

const repositoryRoot = resolve(import.meta.dir, '../../..');

function briefText(command: string[], options: { placement?: string; after?: string[] } = {}): string {
  return `---
goal: fixture
manager: fixture
kind: implementation
paths: [result.txt]
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

function sourceFromIntegration(path: string): string {
  const result = spawnSync('git', ['show', `refs/heads/dev:${path}`], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `Could not read dev:${path}`);
  return result.stdout;
}

function installWorkerCheck(root: string, interceptRemote = false): void {
  const files = [
    'scripts/worker-check.ts',
    'scripts/remote-check.ts',
    'scripts/check-ledger.ts',
    'scripts/stack-lease.ts',
    'scripts/check-memory.ts',
    'scripts/check-host/docker',
  ];
  for (const file of files) {
    const target = join(root, file);
    mkdirSync(resolve(target, '..'), { recursive: true });
    const source = sourceFromIntegration(file);
    const instrumented =
      interceptRemote && file === 'scripts/remote-check.ts'
        ? source.replace(
            'if (import.meta.main) {',
            "if (import.meta.main) {\n  if (process.env.REZICS_TEST_REMOTE_MARKER) appendFileSync(process.env.REZICS_TEST_REMOTE_MARKER, 'remote route used');",
          )
        : source;
    if (instrumented === source && interceptRemote && file === 'scripts/remote-check.ts')
      throw new Error('Could not instrument the worker-check remote boundary');
    writeFileSync(target, instrumented);
  }
}

function localCheckEnvironment(root: string, remoteMarker?: string): NodeJS.ProcessEnv {
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
        },
      ],
    }),
  );
  return {
    ...process.env,
    GOAL_MAIN_CHECKOUT: root,
    KERNEL_CHECK_REMOTE: hosts,
    REZICS_CHECK_MEMORY_GIB: '4',
    REZICS_CHECK_MEMORY_DIR: join(root, '.temp/goal/check-memory'),
    REZICS_STACK_SLOTS: '4',
    REZICS_STACK_LEASE_DIR: join(root, '.temp/goal/stack-lease'),
    REZICS_CHECK_SCOPE: 'off',
    ...(remoteMarker ? { REZICS_TEST_REMOTE_MARKER: remoteMarker } : {}),
  };
}

function commandStatus(result: ReturnType<typeof spawnSync>): string {
  return (
    result.stderr?.toString().trim() ||
    result.stdout?.toString().trim() ||
    result.error?.message ||
    `status ${result.status}`
  );
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
    expect(h.store.task(task.id).brief.acceptance.placement).toBe('local');

    const first = await tasks.retry(task.id);
    await first.exited;
    expect(prompts[0]).toContain(
      "bun scripts/worker-check.ts --local -- 'bun' 'test' 'apps/web/tests/shell-menus.test.ts' '-t' 'the signed-out account action opens a sheet on phones and a dropdown on desktop'",
    );

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
    const second = await tasks.retry(task.id, { brief: retryBrief });
    await second.exited;
    expect(h.store.task(task.id).brief.acceptance).toMatchObject({ placement: 'local', command: retryCommand });
    expect(prompts[1]).toContain(
      "bun scripts/worker-check.ts --local -- 'bun' 'test' 'apps/web/tests/shell-menus.test.ts' '-t' 'the phone navigation and every shell menu use the responsive bottom sheet'",
    );

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
    expect(published.state).toBe('held');
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

test('the real worker-check local route runs a pure command once and does not enter remote placement', () => {
  const temporary = mkdtempSync(join(repositoryRoot, '.temp/acceptance-placement-local-'));
  let checkId: string | undefined;
  try {
    const root = join(temporary, 'worktree');
    mkdirSync(root, { recursive: true });
    git(root, ['init', '--quiet']);
    installWorkerCheck(root, true);
    const script = join(root, 'scripts/worker-check.ts');
    const marker = join(temporary, 'command-runs.txt');
    const remoteMarker = join(temporary, 'remote-route.txt');
    const env = localCheckEnvironment(root, remoteMarker);
    const commandFile = join(root, 'apps/web/tests/local-acceptance.test.ts');
    mkdirSync(resolve(commandFile, '..'), { recursive: true });
    writeFileSync(
      commandFile,
      `import { appendFileSync } from 'node:fs';\nimport { test } from 'bun:test';\ntest('local acceptance runs once', () => appendFileSync(process.env.REZICS_TEST_LOCAL_MARKER!, 'ran\\n'));\n`,
    );
    const start = spawnSync(
      process.execPath,
      [script, '--local', '--', 'bun', 'test', 'apps/web/tests/local-acceptance.test.ts'],
      {
        cwd: root,
        env: { ...env, REZICS_TEST_LOCAL_MARKER: marker },
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    if (start.status !== 0) throw new Error(`worker-check --local start failed: ${commandStatus(start)}`);
    checkId = /check: id ([0-9a-f-]{36})/i.exec(start.stdout)?.[1];
    expect(checkId).toMatch(/^[0-9a-f-]{36}$/i);

    const wait = spawnSync(process.execPath, [script, '--wait', checkId!], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (wait.status !== 0) throw new Error(`worker-check local result failed: ${commandStatus(wait)}`);
    const record = JSON.parse(readFileSync(join(root, '.temp/goal/checks/results', `${checkId}.json`), 'utf8')) as {
      argv?: string[];
      status?: string;
      exitCode?: number;
    };
    expect(record.argv).toContain('--local');
    expect(record.status).toBe('finished');
    expect(record.exitCode).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('ran\n');
    expect(existsSync(remoteMarker)).toBe(false);
  } finally {
    if (checkId) {
      const root = join(temporary, 'worktree');
      const script = join(root, 'scripts/worker-check.ts');
      spawnSync(process.execPath, [script, '--wait', checkId], {
        cwd: root,
        env: localCheckEnvironment(root),
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
      });
    }
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('an unresolved old check prevents local policy adoption without cancelling it or launching a replacement', async () => {
  const h = harness();
  let checkId: string | undefined;
  try {
    installWorkerCheck(h.root);
    git(h.root, ['add', 'scripts']);
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
    const checkStart = spawnSync(
      process.execPath,
      [
        join(task.worktree, 'scripts/worker-check.ts'),
        '--local',
        '--',
        process.execPath,
        '-e',
        'const fs = require("node:fs"); const timer = setInterval(() => { if (fs.existsSync(process.env.REZICS_TEST_RELEASE_MARKER)) clearInterval(timer); }, 10)',
      ],
      {
        cwd: task.worktree,
        env: { ...localCheckEnvironment(task.worktree), REZICS_TEST_RELEASE_MARKER: releaseMarker },
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    if (checkStart.status !== 0) throw new Error(`old check start failed: ${commandStatus(checkStart)}`);
    checkId = /check: id ([0-9a-f-]{36})/i.exec(checkStart.stdout)?.[1];
    expect(checkId).toMatch(/^[0-9a-f-]{36}$/i);

    const first = await tasks.retry(task.id);
    await first.exited;
    h.store.updateAttempt(first.attempt, (attempt) => {
      attempt.state = 'waiting';
      attempt.checks = [checkId!];
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
    const record = JSON.parse(
      readFileSync(join(task.worktree, '.temp/goal/checks/results', `${checkId}.json`), 'utf8'),
    ) as { status?: string; exitCode?: number; runnerPid?: number; runnerHost?: string };
    expect(record.status).toBe('running');
    expect(record.exitCode).toBeUndefined();
    expect(record.runnerPid).toEqual(expect.any(Number));
    expect(record.runnerHost).toBe(hostname());
    expect(() => process.kill(record.runnerPid!, 0)).not.toThrow();

    writeFileSync(releaseMarker, 'release');
    const wait = spawnSync(process.execPath, [join(task.worktree, 'scripts/worker-check.ts'), '--wait', checkId!], {
      cwd: task.worktree,
      env: localCheckEnvironment(task.worktree),
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (wait.status !== 0) throw new Error(`test-owned old check failed: ${commandStatus(wait)}`);
    checkId = undefined;
    tasks.queueRetry(task.id, { brief: localBrief });
    expect(h.store.retryIntent(first.attempt)?.status).toBe('pending');
    expect(h.store.task(task.id).brief.acceptance.placement).toBe('local');
  } finally {
    if (checkId) {
      const task = h.store.tasks()[0];
      if (task)
        spawnSync(process.execPath, [join(task.worktree, 'scripts/worker-check.ts'), '--wait', checkId], {
          cwd: task.worktree,
          env: localCheckEnvironment(task.worktree),
          encoding: 'utf8',
          timeout: 30_000,
          maxBuffer: 2 * 1024 * 1024,
        });
    }
    h.dispose();
  }
});
