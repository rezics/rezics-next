import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSettings } from './config.ts';
import { failingTestFiles } from './merge-train.ts';
import { settle } from './settle.ts';
import { integrationHarness } from './test-support.ts';

type Harness = ReturnType<typeof integrationHarness>;
const command = (script: string) => ['bun', '-e', script];
const lines = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []);
async function until(condition: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Fake check did not start');
    await Bun.sleep(10);
  }
}
function failureCheck(h: Harness, file: string, output: string, shared = false) {
  const runs = join(h.settings.stateDirectory, 'affected-runs');
  const argv = command(`
    const fs = require('node:fs');
    fs.appendFileSync(${JSON.stringify(runs)}, JSON.stringify({ cwd: process.cwd(), affected: process.env.KERNEL_CHECK_AFFECTED }) + '\\n');
    if (${shared} || fs.existsSync(${JSON.stringify(file)})) {
      console.error(${JSON.stringify(output)});
      process.exit(1);
    }
  `);
  h.settings.affectedTests = [{ paths: ['**'], command: argv }];
  return { runs, argv };
}

test('a finished attempt runs the configured affected-test commands in its own worktree before it requests landing, and records each result', async () => {
  const h = integrationHarness();
  const started = join(h.settings.stateDirectory, 'started');
  const release = join(h.settings.stateDirectory, 'release');
  let running: Promise<void>[] = [];
  try {
    h.ensureDev();
    writeFileSync(join(h.settings.stateDirectory, 'remote-check-hosts.json'), '{}');
    const checks = [0, 1].map((index) => ({
      paths: ['**'],
      command: command(`
      const fs = require('node:fs');
      fs.appendFileSync(${JSON.stringify(started)}, JSON.stringify({index: ${index}, cwd: process.cwd(),
        base: process.env.KERNEL_CHECK_AFFECTED, task: process.env.GOAL_TASK_ID,
        attempt: process.env.GOAL_ATTEMPT, hosts: process.env.KERNEL_CHECK_REMOTE,
        config: process.env.CODEX_HOME, cleanup: process.env.KERNEL_CHECK_SKIP_STALE_CLEANUP}) + '\\n');
      while (!fs.existsSync(${JSON.stringify(release)})) await Bun.sleep(10);
      ${index === 0 ? "console.error('Kernel tests failed for 1 file(s):\\ntest/access.test.ts'); process.exit(1);" : "console.log('passed');"}
    `),
    }));
    h.settings.affectedTests = [...checks, { paths: ['unrelated/**'], command: ['false'] }];
    const tasks = [h.dispatch('first'), h.dispatch('second')];
    running = tasks.map((task) => h.job.start(task.id));
    await until(() => lines(started).length === 4);
    expect(h.queue.next()).toBeUndefined();
    for (const observation of lines(started).map((line) => JSON.parse(line))) {
      const task = tasks.find((task) => task.id === observation.task)!;
      expect(observation.cwd).toBe(task.worktree);
      expect(observation.base).toBe(task.base);
      expect(observation.attempt).toBe('1');
      expect(observation.hosts).toBe(join(h.settings.stateDirectory, 'remote-check-hosts.json'));
      expect(observation.config).toBe(h.settings.pools[0]!.configDirectory);
      expect(observation.cleanup).toBe('1');
    }
    writeFileSync(release, 'go');
    await Promise.all(running);
    await h.job.drain();
    for (const task of tasks) {
      const attempt = h.store.attempt({ taskId: task.id, attempt: 1 });
      expect(attempt.affectedTests).toHaveLength(2);
      const failed = attempt.affectedTests!.find((result) => result.status === 'failed')!;
      expect(failed.command).toEqual(checks[0]!.command);
      expect(failed.failingFiles).toEqual(['test/access.test.ts']);
      expect(failed.durationMs).toBeGreaterThan(0);
      expect(attempt.affectedTests!.find((result) => result.status === 'passed')!.failingFiles).toEqual([]);
      expect(h.store.events(task.id).filter((event) => event.kind === 'landing-requested')).toHaveLength(1);
      await settle(h.tasks, { attempt, exited: Promise.resolve({ code: 0, signal: null }) }, h.queue);
    }
    expect(h.queue.next()!.request.affectedTests).toHaveLength(2);
    expect(lines(started)).toHaveLength(4);
  } finally {
    writeFileSync(release, 'go');
    await Promise.all(running);
    await h.job.drain();
    h.dispose();
  }
}, 60_000);

test('a landing whose affected tests fail where its base passes is refused with the failing test files named; a failure the base shares does not refuse it', async () => {
  for (const shared of [false, true]) {
    const h = integrationHarness();
    try {
      h.ensureDev();
      const { runs, argv } = failureCheck(
        h,
        'broken',
        'Kernel tests failed for 2 file(s):\ntest/access.test.ts\ntest/gates.test.ts',
        shared,
      );
      const task = h.dispatch('broken');
      await h.start(task);
      const dev = h.head();
      expect(lines(runs)).toHaveLength(1);
      await h.train(undefined, false);
      expect(h.outcomes[0]!.passed).toBe(shared);
      if (shared) {
        expect(h.head()).toBe(h.head(task.branch));
        expect(readFileSync(h.outcomes[0]!.logPath, 'utf8')).toContain('Base already shares');
      } else {
        expect(h.head()).toBe(dev);
        expect(h.outcomes[0]!.stage).toBe('gate');
        expect(h.outcomes[0]!.failedCommand).toEqual(argv);
        expect(h.outcomes[0]!.failsOnMain).toBe(false);
        expect(h.outcomes[0]!.firstFailure!.assertion).toContain('test/access.test.ts');
        expect(h.outcomes[0]!.firstFailure!.excerpt).toContain('test/gates.test.ts');
      }
      const observations = lines(runs).map((line) => JSON.parse(line));
      expect(observations).toHaveLength(2);
      expect(observations[0].affected).toBe(task.base);
      expect(observations[1].affected).toBe('');
      expect(observations[1].cwd).not.toBe(task.worktree);
      expect(existsSync(observations[1].cwd)).toBe(false);
    } finally {
      h.dispose();
    }
  }
});

test('an attempt with no configured affected-test command lands as before', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.settings.affectedTests = [];
    const task = h.dispatch('accepted');
    await h.start(task);
    expect(h.queue.next()!.request.affectedTests).toBeUndefined();
    await h.train(undefined, false);
    expect(h.outcomes[0]!.passed).toBe(true);
    expect(h.head()).toBe(h.head(task.branch));
  } finally {
    h.dispose();
  }
}, 60_000);

test('new failing files are refused even when the base already fails other tests, and a base result is reused', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const runs = join(h.settings.stateDirectory, 'affected-runs');
    const argv = command(`
      const fs = require('node:fs');
      fs.appendFileSync(${JSON.stringify(runs)}, process.cwd() + '\\n');
      console.error(fs.existsSync('broken')
        ? 'Kernel tests failed for 2 file(s):\\ntest/shared.test.ts\\ntest/new.test.ts'
        : 'Kernel tests failed for 1 file(s):\\ntest/shared.test.ts');
      process.exit(1);
    `);
    h.settings.affectedTests = [{ paths: ['**'], command: argv }];
    for (let index = 0; index < 2; index++) {
      const task = h.dispatch(index === 0 ? 'broken' : 'other');
      await h.start(task);
      await h.train(undefined, false);
    }
    expect(h.outcomes[0]!.passed).toBe(false);
    expect(h.outcomes[0]!.firstFailure!.assertion).toContain('test/new.test.ts');
    expect(h.outcomes[0]!.firstFailure!.assertion).not.toContain('test/shared.test.ts');
    expect(h.outcomes[1]!.passed).toBe(true);
    expect(lines(runs)).toHaveLength(4); // Two attempt checks and one baseline per distinct set of failing files.
  } finally {
    h.dispose();
  }
}, 60_000);

test('the base runs only the files that failed on the branch, and the same files reuse its result', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const runs = join(h.settings.stateDirectory, 'affected-runs');
    const argv = command(`
      const fs = require('node:fs');
      fs.appendFileSync(${JSON.stringify(runs)}, JSON.stringify(process.argv) + '\\n');
      if (!fs.existsSync('broken')) process.exit(0);
      console.error('Kernel tests failed for 1 file(s):\\ntest/new.test.ts');
      process.exit(1);
    `);
    h.settings.affectedTests = [{ paths: ['**'], command: argv }];
    for (let index = 0; index < 2; index++) {
      const task = h.dispatch('broken');
      await h.start(task);
      await h.train(undefined, false);
    }
    expect(h.outcomes.map((outcome) => outcome.passed)).toEqual([false, false]);
    const calls = lines(runs).map((line) => JSON.parse(line) as string[]);
    // Two attempt checks with no files named, and one baseline on the unchanged dev head naming the failed file.
    expect(calls.filter((args) => args.includes('test/new.test.ts'))).toHaveLength(1);
    expect(calls).toHaveLength(3);
  } finally {
    h.dispose();
  }
}, 60_000);

test('a check-host transport failure is retried once, then lands unverified with a log note', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const runs = join(h.settings.stateDirectory, 'affected-runs');
    h.settings.affectedTests = [
      {
        paths: ['**'],
        command: command(`
      require('node:fs').appendFileSync(${JSON.stringify(runs)}, 'run\\n');
      console.error('remote-check: connection to host failed during workspace upload before a result');
      process.exit(75);
    `),
      },
    ];
    const task = h.dispatch('feature');
    await h.start(task);
    expect(lines(runs)).toHaveLength(2);
    expect(h.store.attempt({ taskId: task.id, attempt: 1 }).affectedTests![0]!.status).toBe('unverified');
    await h.train(undefined, false);
    expect(lines(runs)).toHaveLength(2);
    expect(h.outcomes[0]!.passed).toBe(true);
    expect(readFileSync(h.outcomes[0]!.logPath, 'utf8')).toContain('unverified (landing allowed)');
  } finally {
    h.dispose();
  }
}, 60_000);

test('a successful transport retry records the verified result without stale failure output', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const mark = join(h.settings.stateDirectory, 'retried');
    h.settings.affectedTests = [
      {
        paths: ['**'],
        command: command(`
      const fs = require('node:fs');
      if (!fs.existsSync(${JSON.stringify(mark)})) {
        fs.writeFileSync(${JSON.stringify(mark)}, 'retry');
        console.error('remote-check: no check host answered'); process.exit(1);
      }
      console.log('passed after retry');
    `),
      },
    ];
    const task = h.dispatch('feature');
    await h.start(task);
    const result = h.store.attempt({ taskId: task.id, attempt: 1 }).affectedTests![0]!;
    expect(result.status).toBe('passed');
    expect(result.output).toBe('passed after retry\n');
    await h.train(undefined, false);
    expect(h.outcomes[0]!.passed).toBe(true);
  } finally {
    h.dispose();
  }
}, 60_000);

test('an unplaceable affected selection is recorded unverified from its announcement', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const announcement = 'Affected mode: unverified, 0 of 4 test files selected (services/kernel/scripts/check.ts)';
    h.settings.affectedTests = [{ paths: ['**'], command: command(`console.log(${JSON.stringify(announcement)})`) }];
    const task = h.dispatch('feature');
    await h.start(task);
    const result = h.store.attempt({ taskId: task.id, attempt: 1 }).affectedTests![0]!;
    expect(result.status).toBe('unverified');
    expect(result.output).toContain(announcement);
    await h.train(undefined, false);
    expect(h.outcomes[0]!.passed).toBe(true);
  } finally {
    h.dispose();
  }
}, 60_000);

test('affected-test settings use defaults, accept local overrides and reject malformed commands', () => {
  const h = integrationHarness();
  try {
    const settings = () => loadSettings({ cwd: h.root, env: {} });
    expect(settings().affectedTests).toEqual([
      {
        paths: ['services/kernel/**'],
        command: ['env', 'KERNEL_CHECK_AFFECTED_MAX=60', 'bun', 'run', '--cwd', 'services/kernel', 'check'],
      },
    ]);
    const local = JSON.parse(readFileSync(h.settings.localFile, 'utf8'));
    local.affectedTests = [{ paths: ['**'], command: ['true'] }];
    writeFileSync(h.settings.localFile, JSON.stringify(local));
    expect(settings().affectedTests).toEqual(local.affectedTests);
    local.affectedTests = [];
    writeFileSync(h.settings.localFile, JSON.stringify(local));
    expect(settings().affectedTests).toEqual([]);
    local.affectedTests = [{ paths: ['**'], command: [] }];
    writeFileSync(h.settings.localFile, JSON.stringify(local));
    expect(settings).toThrow('affectedTests[0].command');
  } finally {
    h.dispose();
  }
}, 60_000);

test('failed-file extraction ignores passing headings and stack traces and normalizes ordering', () => {
  expect(
    failingTestFiles(
      `test/passed.test.ts:\n(pass) fine\n\x1b[31mtest/z.test.ts: Error: bun test failed\x1b[0m\nFAIL ./test/a.spec.ts\nError: Kernel tests failed for 2 file(s):\ntest/z.test.ts\ntest/a.spec.ts\n  at helper (/test/stack.test.ts:1:1)`,
    ),
  ).toEqual(['test/a.spec.ts', 'test/z.test.ts']);
});

test('passed affected checks never add a train run, and the train still checks its candidate', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const { runs } = failureCheck(h, 'absent', 'unused');
    const settings = h.settings as typeof h.settings & { integrationChecks: { paths: string[]; command: string[] }[] };
    settings.integrationChecks = [{ paths: ['**'], command: ['sh', '-c', 'test -f feature'] }];
    const task = h.dispatch('feature');
    await h.start(task);
    expect(h.store.attempt({ taskId: task.id, attempt: 1 }).affectedTests![0]!.status).toBe('passed');
    await h.train(undefined, false);
    expect(h.outcomes[0]!.passed).toBe(true);
    expect(lines(runs)).toHaveLength(1);
  } finally {
    h.dispose();
  }
}, 60_000);

test('an unavailable baseline is retried once and permits landing with a note', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const runs = join(h.settings.stateDirectory, 'affected-runs');
    h.settings.affectedTests = [
      {
        paths: ['**'],
        command: command(`
      const fs = require('node:fs');
      fs.appendFileSync(${JSON.stringify(runs)}, 'run\\n');
      console.error(fs.existsSync('feature')
        ? 'Kernel tests failed for 1 file(s):\\ntest/feature.test.ts'
        : 'remote-check: no check host answered');
      process.exit(1);
    `),
      },
    ];
    const task = h.dispatch('feature');
    await h.start(task);
    await h.train(undefined, false);
    expect(h.outcomes[0]!.passed).toBe(true);
    expect(lines(runs)).toHaveLength(3);
    expect(readFileSync(h.outcomes[0]!.logPath, 'utf8')).toContain('baseline unverified (landing allowed)');
  } finally {
    h.dispose();
  }
}, 60_000);

test('the final failed-file summary excludes an earlier lane failure that passed its rerun', () => {
  expect(
    failingTestFiles(
      'test/recovered.test.ts: Error: bun test failed\nKernel tests failed for 1 file(s):\ntest/remaining.test.ts\n  at main (check.ts:1:1)',
    ),
  ).toEqual(['test/remaining.test.ts']);
});

test('settlement recovery reuses recorded checks after an interrupted landing request', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const { runs } = failureCheck(h, 'absent', 'unused');
    const task = h.dispatch('feature');
    const worker = await h.tasks.retry(task.id, {});
    await expect(
      settle(h.tasks, worker, {
        enqueue() {
          throw new Error('Interrupted enqueue');
        },
      }),
    ).rejects.toThrow('Interrupted enqueue');
    expect(h.queue.next()).toBeUndefined();
    expect(h.store.attempt({ taskId: task.id, attempt: 1 }).affectedTests).toHaveLength(1);
    await settle(h.tasks, worker, h.queue);
    expect(lines(runs)).toHaveLength(1);
    expect(h.queue.next()!.request.affectedTests).toHaveLength(1);
    await h.train(undefined, false);
    expect(h.outcomes[0]!.passed).toBe(true);
  } finally {
    h.dispose();
  }
}, 60_000);

test('plain Bun reporter failures retain their file while passing files are ignored', () => {
  expect(
    failingTestFiles(
      'test/pass.test.ts:\n(pass) works\ntest/fail.test.ts:\n(fail) breaks\ntest/other.test.ts: (fail) breaks',
    ),
  ).toEqual(['test/fail.test.ts', 'test/other.test.ts']);
});

test('a fresh local baseline installs the tools its check needs', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.advanceDev(
      'package.json',
      JSON.stringify({
        name: 'fixture',
        private: true,
        scripts: { postinstall: 'mkdir -p .temp && touch .temp/installed' },
      }),
    );
    h.settings.affectedTests = [
      {
        paths: ['**'],
        command: command(`
      const fs = require('node:fs');
      if (!fs.existsSync('.temp/installed')) { console.error('error: dependencies not installed'); process.exit(1); }
      if (fs.existsSync('feature')) { console.error('Kernel tests failed for 1 file(s):\\ntest/feature.test.ts'); process.exit(1); }
    `),
      },
    ];
    const task = h.dispatch('feature');
    await h.start(task);
    await h.train(undefined, false);
    expect(h.outcomes[0]!.passed).toBe(false);
    expect(h.outcomes[0]!.firstFailure!.assertion).toContain('test/feature.test.ts');
    expect(readFileSync(h.outcomes[0]!.logPath, 'utf8')).toContain('$ bun install --frozen-lockfile');
  } finally {
    h.dispose();
  }
}, 60_000);
