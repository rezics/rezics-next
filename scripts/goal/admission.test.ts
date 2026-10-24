import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { admissionCommand, assertWideRunAllowed, borrowedBookAdmission, borrowedBookSelection, isWideRun, slotHolderLines, tryAcquireQaSlot, withTestAdmission } from './admission.ts';
import { acquireHeavy, qaSlotAdmission, withSlot } from './qa-slots.ts';
import { readDirectoryLease } from '../qa/process/lease.ts';
import { acquireQaSlots } from '../qa/core.ts';
import type { Ledger, Task } from './types.ts';
import { fixtureProcessScope } from './fixtures/process-scope.ts';

const directories: string[] = [];
function fixture(): string {
  const directory = mkdtempSync(join(process.cwd(), '.temp', 'qa-admission-'));
  directories.push(directory);
  return directory;
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const callers: [string, NodeJS.ProcessEnv, boolean][] = [
  ['worker', { GOAL_TASK_ID: 'worker', GOAL_ID: 'program' }, true],
  ['another manager', { GOAL_ID: 'catalogue' }, true],
  ['program', { GOAL_ID: 'program' }, false],
  ['terminal', {}, false],
];
const wideSelections = [[], ['--tier', 'unit'], ['--tier', 'e2e'], ['--tier', 'static'], ['--affected'], ['--affected=main'], ['--storybook', '--tier', 'e2e']];
const routes: [string, (args: string[]) => string[]][] = [
  ['goal test', args => admissionCommand(['--goalctl', 'test', ...args])],
  ['goal slot', args => admissionCommand(['--goalctl', 'slot', '--', 'bun', 'scripts/qa/cli.ts', ...args])],
  ['test', args => admissionCommand(['--', 'bun', 'scripts/qa/test.ts', ...args])],
  ['qa', args => admissionCommand(['--', 'bun', 'scripts/qa/cli.ts', ...args])],
  ['storybook', args => admissionCommand(['--', '../../node_modules/.bin/vitest', 'run', '--project', 'storybook', ...args])],
  ['accounts storybook', args => admissionCommand(['--', '../../node_modules/.bin/vitest', 'run', '--project', 'storybook', ...args])],
  ['web e2e', args => admissionCommand(['--', 'node_modules/.bin/playwright', 'test', '--config', 'apps/web/playwright.config.ts', ...args])],
  ['accounts e2e', args => admissionCommand(['--', 'node_modules/.bin/playwright', 'test', '--config', 'apps/accounts/playwright.config.ts', ...args])],
];

describe('wide admission on commands built for every entry point', () => {
  for (const [route, build] of routes) {
    for (const selection of wideSelections) {
      for (const [caller, env, refused] of callers) {
        test(`${route}: ${selection.join(' ') || 'suite'}: ${caller}`, () => {
          const command = build(selection);
          expect(isWideRun(command)).toBe(true);
          const run = () => assertWideRunAllowed(command, env);
          if (refused) expect(run).toThrow('run bun scripts/goal/goalctl.ts test <named test files> instead.');
          else expect(run).not.toThrow();
        });
      }
    }
    for (const file of ['scripts/goal/admission.test.ts', 'tests/qa/e2e/example.e2e.ts', 'features/example.stories.tsx']) {
      test(`${route}: a named ${file} is never wide, even with --heavy`, () => {
        const command = build(['--heavy', '--tier', 'e2e', '--file', file]);
        expect(isWideRun(command)).toBe(false);
        for (const [, env] of callers) expect(() => assertWideRunAllowed(command, env)).not.toThrow();
      });
    }
  }
  for (const [caller, env, refused] of callers) {
    test(`regress: ${caller}`, () => {
      const command = admissionCommand(['--goalctl', 'regress']);
      expect(isWideRun(command)).toBe(true);
      if (refused) expect(() => assertWideRunAllowed(command, env)).toThrow('Wide QA');
      else expect(() => assertWideRunAllowed(command, env)).not.toThrow();
    });
  }
  test('an affected preview is not a run', () => {
    for (const build of [routes[0]![1], routes[2]![1]]) {
      expect(isWideRun(build(['--affected', '--list']))).toBe(false);
      expect(() => assertWideRunAllowed(build(['--affected', '--list']), { GOAL_TASK_ID: 'worker' })).not.toThrow();
    }
  });
  test('slot commands that only mention QA words do not become test runs', () => {
    expect(isWideRun(['echo', 'qa', '--tier', 'unit'])).toBe(false);
    expect(isWideRun(['task', 'goal', '--', 'regress'])).toBe(true);
    expect(isWideRun(['task', 'goal', '--', 'regress', '--timing', 'a-run'])).toBe(false);
    expect(isWideRun(['task', 'goal', '--', 'test', '--affected=main'])).toBe(true);
  });
  test('Task entry points all use the admission adapter', () => {
    const taskfile = readFileSync('Taskfile.yml', 'utf8');
    for (const task of ['goal', 'test', 'qa', 'storybook:test', 'accounts:storybook:test', 'web:e2e', 'accounts:e2e']) {
      const stanza = taskfile.split(`\n  ${task}:\n`)[1]?.split(/\n  [a-z]/)[0];
      expect(stanza).toContain('scripts/goal/admission.ts');
    }
  });
});

test('the program waits for live workers before starting a wide command', async () => {
  const directory = fixture();
  let workers = ['catalogue'];
  let slept = 0;
  const messages: string[] = [];
  expect(await withSlot(['bun', 'scripts/qa/cli.ts', '--tier', 'unit'], false, undefined, {
    env: { GOAL_ID: 'program' }, slotDirectory: directory, workerGoals: () => workers,
    reap: () => {}, announce: message => messages.push(message), sleep: async () => { slept++; workers = []; },
    runCommand: async (_command, env, start) => {
      // Harness commands defer admission until after memory is ready. The
      // dispatcher must pass the policy that the harness uses to take its turn.
      expect(env.GOAL_QA_DEFERRED_HEAVY).toBe('1');
      const release = await acquireHeavy(_command, { lockDir: env.GOAL_QA_HEAVY_LOCK,
        waitForWorkers: env.GOAL_QA_WIDE_RUN === '1', besideWorkers: env.GOAL_QA_BESIDE_WORKERS === '1',
        workerGoals: () => workers, bindExit: false, announce: message => messages.push(message),
        sleep: async () => { slept++; workers = []; } });
      try {
        expect(slept).toBe(1);
        expect(readDirectoryLease(join(directory, 'heavy'))?.besideWorkers).toBe(0);
        expect(env.GOAL_QA_HEAVY_RUN).toBe('1');
        start();
        return 0;
      } finally { release(); }
    },
  })).toBe(0);
  expect(messages).toEqual(['waiting for 1 live worker before wide QA; use --beside-workers to start alongside them']);
});

test('--beside-workers records the live count and is stripped before dispatch; nested named batches reuse the lease', async () => {
  const directory = fixture();
  expect(await withSlot(['bun', 'scripts/qa/cli.ts', '--tier', 'unit', '--beside-workers'], false, undefined, {
    env: { GOAL_ID: 'program' }, slotDirectory: directory, workerGoals: () => ['a', 'a', 'b'], reap: () => {},
    sleep: async () => { throw new Error('unnecessary wait'); },
    runCommand: async (command, env, start) => {
      expect(command).not.toContain('--beside-workers');
      expect(env.GOAL_QA_DEFERRED_HEAVY).toBe('1');
      const release = await acquireHeavy(command, { lockDir: env.GOAL_QA_HEAVY_LOCK,
        waitForWorkers: env.GOAL_QA_WIDE_RUN === '1', besideWorkers: env.GOAL_QA_BESIDE_WORKERS === '1',
        workerGoals: () => ['a', 'a', 'b'], bindExit: false,
        sleep: async () => { throw new Error('unnecessary wait'); } });
      try {
        const lease = readDirectoryLease(join(directory, 'heavy'))!;
        expect(lease.besideWorkers).toBe(3);
        env.GOAL_QA_HEAVY_LEASE = lease.token;
        start();
        const result = join(directory, 'batch.json');
        const code = await withSlot(['bun', 'scripts/qa/test.ts', 'scripts/goal/admission.test.ts'], true, result, {
          env, slotDirectory: directory, reap: () => { throw new Error('nested reap'); },
          runCommand: async (_batch, _env, batchStart) => { batchStart(); return 0; },
        });
        expect(JSON.parse(readFileSync(result, 'utf8')).code).toBe(0);
        return code;
      } finally { release(); }
    },
  })).toBe(0);
});

test('two program wide runs still serialize with --beside-workers', async () => {
  const directory = fixture();
  const lockDir = join(directory, 'heavy');
  const release = await acquireHeavy(['holder'], { lockDir, bindExit: false });
  let slept = false;
  try {
    const next = await acquireHeavy(['next'], { lockDir, bindExit: false, waitForWorkers: true, besideWorkers: true,
      workerGoals: () => ['a'], announce: () => {}, sleep: async () => { slept = true; release(); } });
    expect(slept).toBe(true);
    next();
  } finally { release(); }
});

function waiting(directory: string, goal: string): void {
  mkdirSync(join(directory, 'waiters'), { recursive: true });
  writeFileSync(join(directory, 'waiters', `ordered-slot-${goal}.json`), JSON.stringify({ pid: process.pid, goal, waitingFor: 'slot' }));
}

test('a startup status without an outstanding slot request cannot head slot admission', () => {
  const directory = fixture();
  const now = () => 100;
  const ticket = qaSlotAdmission(directory, 1, { env: { GOAL_ID: 'program' }, now,
    alive: () => true, workerGoals: () => [] });
  const status = join(directory, 'waiters', 'slot-pending-startup.json');
  writeFileSync(status, JSON.stringify({ pid: process.pid + 1_000_000, goal: 'program', waitingFor: 'slot',
    since: new Date(0).toISOString(), command: 'stack:up', message: 'Waiting for a QA slot after memory admission' }));
  const lease = ticket.acquire(0);
  try {
    expect(lease).not.toBe('held');
    expect(existsSync(status)).toBe(true);
  } finally { if (lease !== 'held') lease.release(); ticket.release(); }
});

test('concurrent slot requests from one runner retain their own arrival order', () => {
  const directory = fixture();
  const options = { env: { GOAL_ID: 'program' }, now: () => 100, workerGoals: () => [] };
  const first = qaSlotAdmission(directory, 2, options);
  const second = qaSlotAdmission(directory, 2, options);
  try {
    expect(second.acquire(0)).toBe('held');
    const lease = first.acquire(0);
    expect(lease).not.toBe('held');
    try {
      const next = second.acquire(1);
      expect(next).not.toBe('held');
      if (next !== 'held') next.release();
    } finally { if (lease !== 'held') lease.release(); }
  } finally { first.release(); second.release(); }
});

test('a diagnostic startup wait cannot reserve another Goal share without an active request', () => {
  const directory = fixture();
  const options = { env: { GOAL_ID: 'a' }, now: () => 100, workerGoals: () => ['a', 'b'] };
  const first = tryAcquireQaSlot(directory, 2, 0, options);
  if (first === 'held') throw new Error('private slot already held');
  const ticket = qaSlotAdmission(directory, 2, options);
  writeFileSync(join(directory, 'waiters', 'slot-pending-startup.json'), JSON.stringify({
    pid: process.pid, goal: 'b', waitingFor: 'slot', since: new Date(0).toISOString(),
  }));
  const second = ticket.acquire(1);
  try { expect(second).not.toBe('held'); }
  finally { if (second !== 'held') second.release(); ticket.release(); first.release(); }
});

for (const goals of [['a'], ['a', 'b'], ['a', 'b', 'c']]) {
  test(`ordinary share with ${goals.length} live Goals, contention, and spare capacity`, async () => {
    const directory = fixture();
    const total = 6;
    const share = Math.floor(total / goals.length);
    const env = { GOAL_ID: 'a', GOAL_TASK_ID: 'worker-a' };
    const held = [];
    try {
      for (let slot = 0; slot < Math.min(share, total - 1); slot++) {
        const lease = tryAcquireQaSlot(directory, total, slot, { env, workerGoals: () => goals });
        expect(lease).not.toBe('held');
        if (lease !== 'held') held.push(lease);
      }
      waiting(directory, 'b');
      if (goals.length > 1) {
        expect(tryAcquireQaSlot(directory, total, share, { env, workerGoals: () => goals })).toBe('held');
        const other = await acquireQaSlots(directory, 1, { GOAL_ID: 'b', GOAL_TASK_ID: 'worker-b', GOAL_QA_SLOTS: '6' }, process.pid,
          { inherit: false, workerGoals: () => goals });
        expect(other.count).toBe(1);
        other.release();
      }
      rmSync(join(directory, 'waiters', 'ordered-slot-b.json'));
      const spare = tryAcquireQaSlot(directory, total, Math.min(share, total - 1), { env, workerGoals: () => goals });
      expect(spare).not.toBe('held');
      if (spare !== 'held') held.push(spare);
      expect(slotHolderLines(directory, total).every(line => line.includes('Goal a:') && line.includes('task worker-a'))).toBe(true);
    } finally { for (const lease of held) lease.release(); }
  });
}

test('each Goal has at least one slot and program admission is outside shares', () => {
  const directory = fixture();
  const goals = ['a', 'b', 'c'];
  waiting(directory, 'b');
  const first = tryAcquireQaSlot(directory, 2, 0, { env: { GOAL_ID: 'a' }, workerGoals: () => goals });
  expect(first).not.toBe('held');
  expect(tryAcquireQaSlot(directory, 2, 1, { env: { GOAL_ID: 'a' }, workerGoals: () => goals })).toBe('held');
  const program = tryAcquireQaSlot(directory, 2, 1, { env: { GOAL_ID: 'program' }, workerGoals: () => goals });
  expect(program).not.toBe('held');
  if (first !== 'held') first.release();
  if (program !== 'held') program.release();
});

test('ordinary dispatcher slots record their holder and --holders groups by Goal', async () => {
  const directory = fixture();
  const lines: string[] = [];
  await withSlot(['selected-command'], false, undefined, {
    slotDirectory: directory, slots: 2, env: { GOAL_ID: 'a', GOAL_TASK_ID: 'worker-a' }, workerGoals: () => ['a'], reap: () => {},
    runCommand: async () => {
      expect(readDirectoryLease(join(directory, '0'))?.task).toBe('worker-a');
      return withSlot(['--holders'], false, undefined, { slotDirectory: directory, slots: 2, announce: line => lines.push(line) });
    },
  });
  expect(lines).toEqual([`Goal a: slot 0, task worker-a (pid ${process.pid})`]);
});

async function occupyAdmission(directory: string): Promise<() => void> {
  const held = Array.from({ length: 8 }, (_, slot) => {
    const lease = tryAcquireQaSlot(directory, 8, slot, { env: { GOAL_ID: 'program' }, workerGoals: () => [] });
    if (lease === 'held') throw new Error(`Fixture slot ${slot} is already held`);
    return lease;
  });
  const releaseHeavy = await acquireHeavy(['holder'], { lockDir: join(directory, 'heavy'), bindExit: false });
  return () => { for (const lease of held) lease.release(); releaseHeavy(); };
}

for (const args of [['--affected', '--list'], ['--affected', 'HEAD', '--list'], ['--affected=HEAD', '--list'],
  ['--list', '--affected'], ['--affected', '--list', '--beside-workers']]) {
  test(`list-only plan ${args.join(' ')} bypasses full admission without a waiter`, async () => {
    const directory = fixture();
    const release = await occupyAdmission(directory);
    const env = { GOAL_ID: 'program', GOAL_TASK_ID: 'worker' };
    const command = ['bun', 'scripts/qa/test.ts', ...args];
    let ran = false;
    try {
      expect(await withTestAdmission(command, false, undefined, {
        env, slotDirectory: directory, slots: 8,
        sleep: async () => { throw new Error('A list-only plan waited for admission'); },
        reap: () => { throw new Error('A list-only plan prepared a test run'); },
        runCommand: async (selected, childEnv, start) => {
          ran = true;
          expect(selected).toEqual(command.filter(arg => arg !== '--beside-workers'));
          expect(childEnv).toEqual(env);
          expect(slotHolderLines(directory, 8)).toHaveLength(8);
          expect(existsSync(join(directory, 'waiters'))).toBe(false);
          start();
          return 7;
        },
      })).toBe(7);
      expect(ran).toBe(true);
      expect(existsSync(join(directory, 'waiters'))).toBe(false);
    } finally { release(); }
  });
}

test('--affected without --list still waits for admission', async () => {
  const directory = fixture();
  const release = await occupyAdmission(directory);
  let slept = 0;
  try {
    expect(await withTestAdmission(['bun', 'scripts/qa/test.ts', '--affected'], false, undefined, {
      env: { GOAL_ID: 'program' }, slotDirectory: directory, slots: 8, workerGoals: () => [],
      announce: () => {}, reap: () => {}, sleep: async () => {
        slept++;
        expect(readdirSync(join(directory, 'heavy-queue')).filter(name => name.endsWith('.json'))).toHaveLength(1);
        release();
      },
      runCommand: async (_command, env, start) => {
        expect(slept).toBe(1);
        expect(env.GOAL_QA_HEAVY_RUN).toBe('1');
        start();
        return 0;
      },
    })).toBe(0);
  } finally { release(); }
});

test('a list-only plan keeps the result report and bypasses an explicit heavy request', async () => {
  const directory = fixture();
  const release = await occupyAdmission(directory);
  const result = join(directory, 'result.json');
  let clock = 100;
  try {
    expect(await withTestAdmission(['bun', 'scripts/qa/test.ts', '--affected', '--list'], true, result, {
      env: { GOAL_ID: 'program' }, slotDirectory: directory, slots: 8, now: () => clock,
      sleep: async () => { throw new Error('A list-only plan waited for heavy admission'); },
      runCommand: async (_command, _env, start) => { start(); clock = 125; return 2; },
    })).toBe(2);
    expect(JSON.parse(readFileSync(result, 'utf8'))).toEqual({ code: 2, queuedAt: 100, startedAt: 100,
      finishedAt: 125, queueMs: 0, testMs: 25, totalMs: 25, artifactPaths: [] });
    expect(existsSync(join(directory, 'waiters'))).toBe(false);
  } finally { release(); }
});

for (const heavy of [false, true]) {
  test(`named files retain ${heavy ? 'heavy' : 'ordinary'} admission`, async () => {
    const directory = fixture();
    const release = await occupyAdmission(directory);
    const file = join(directory, 'selection.test.ts');
    writeFileSync(file, '');
    let slept = 0;
    try {
      expect(await withTestAdmission(['bun', 'scripts/qa/test.ts', file], heavy, undefined, {
        env: { GOAL_ID: 'program' }, slotDirectory: directory, slots: 8, workerGoals: () => [],
        announce: () => {}, reap: () => {}, sleep: async () => { slept++; release(); },
        runCommand: async (_command, env, start) => {
          expect(slept).toBe(1);
          if (heavy) expect(env.GOAL_QA_HEAVY_RUN).toBe('1');
          else expect(slotHolderLines(directory, 8)).toHaveLength(1);
          start();
          return 0;
        },
      })).toBe(0);
    } finally { release(); }
  });
}

for (const harness of [false, true]) {
  test(`${harness ? 'harness' : 'dispatcher'} waits at its share despite a free slot, then borrows when nobody else waits`, async () => {
    const directory = fixture();
    const env = { GOAL_ID: 'a', GOAL_TASK_ID: 'worker-a', GOAL_QA_SLOTS: '2' };
    const workerGoals = () => ['a', 'b'];
    const first = tryAcquireQaSlot(directory, 2, 0, { env, workerGoals });
    expect(first).not.toBe('held');
    waiting(directory, 'b');
    let slept = 0;
    const messages: string[] = [];
    const options = { workerGoals, announce: (message: string) => messages.push(message), sleep: async () => {
      slept++;
      expect(readDirectoryLease(join(directory, '1'))).toBeUndefined();
      rmSync(join(directory, 'waiters', 'ordered-slot-b.json'));
    } };
    try {
      if (harness) {
        const slots = await acquireQaSlots(directory, 1, env, process.pid, { ...options, inherit: false });
        expect(slots.count).toBe(1);
        expect(readDirectoryLease(join(directory, '1'))?.task).toBe('worker-a');
        slots.release();
      } else {
        await withSlot(['selected-command'], false, undefined, { ...options, env, slotDirectory: directory, slots: 2,
          reap: () => {}, runCommand: async () => {
            expect(readDirectoryLease(join(directory, '1'))?.task).toBe('worker-a');
            return 0;
          } });
      }
      expect(slept).toBe(1);
      expect(messages[0]).toContain('Goal share');
      expect(readDirectoryLease(join(directory, '0'))?.task).toBe('worker-a');
    } finally { if (first !== 'held') first.release(); }
  });
}

const borrowedFile = 'tests/qa/integration/catalogue-real-book-reading.test.ts';
const borrowedCommand = ['bun', join(import.meta.dir, '../qa/test.ts'), '--borrowed-public-domain-book', borrowedFile];

function borrowedFixture() {
  const root = fixture(), origin = join(root, 'origin'), worktree = join(root, 'worker');
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', '-c', 'core.hooksPath=/dev/null', ...args], { stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode) throw new Error(result.stderr.toString());
  };
  git('init', '--quiet', origin);
  git('-C', origin, '-c', 'user.name=QA fixture', '-c', 'user.email=qa@rezics.local', 'commit', '--quiet', '--allow-empty', '-m', 'Admission fixture');
  git('-C', origin, 'worktree', 'add', '--quiet', '--detach', worktree, 'HEAD');
  const directory = join(origin, '.temp/goal-orchestration/qa-slots');
  mkdirSync(directory, { recursive: true });
  const task = (id: string, goal: string): Task => ({ id, goal, title: 'Admission fixture', effort: 'low', cases: [], paths: [],
    migrations: [], shared: [], depends: [], brief: '', worktree, branch: '', base: '', state: 'running',
    attempts: [{ n: 1, effort: 'low', engine: 'bun', pid: process.pid, session: '', output: '', startedAt: new Date(0).toISOString() }] });
  const ledger: Ledger = { goals: { book: { manager: 'fixture', startedAt: '' }, peer: { manager: 'fixture', startedAt: '' } },
    tasks: { borrower: task('borrower', 'book'), peer: task('peer', 'peer') } };
  const ledgerFile = join(origin, '.temp/goal-orchestration/ledger.json');
  const save = () => writeFileSync(ledgerFile, JSON.stringify(ledger));
  save();
  const env: NodeJS.ProcessEnv = { GOAL_ID: 'book', GOAL_TASK_ID: 'borrower', GOAL_WORKTREE: worktree, GOAL_QA_SLOTS: '2' };
  return { root, origin, worktree, directory, ledger, ledgerFile, env, save };
}

describe('borrowed Book admission', () => {
  test('uses only the existing exact selector, retaining its supported timeout', () => {
    expect(borrowedBookSelection(borrowedCommand)).toBe(true);
    expect(borrowedBookSelection([...borrowedCommand, '--timeout', '90000'])).toBe(true);
    expect(borrowedBookSelection(['bun', 'scripts/qa/test.ts', borrowedFile])).toBe(false);
  });

  for (const extra of [['--beside-workers'], ['--heavy'], ['--tier', 'integration'], ['--affected', '--list'],
    ['tests/qa/unit/test-dispatch.test.ts'], ['--list'], ['--timeout=bad'], ['--result-file', 'report.json']]) {
    test(`refuses reserved or mixed selection before stripping ${extra.join(' ')}`, async () => {
      const options = { env: {}, runCommand: async () => { throw new Error('must not dispatch'); } };
      await expect(withTestAdmission([...borrowedCommand, ...extra], false, undefined, options)).rejects.toThrow();
      await expect(withSlot([...borrowedCommand, ...extra], false, undefined, options)).rejects.toThrow();
    });
  }
  test('refuses the outer heavy argument even after goalctl strips --heavy', async () => {
    await expect(withTestAdmission(borrowedCommand, true)).rejects.toThrow('does not accept heavy');
  });
  for (const command of [borrowedCommand.slice(0, -1), [...borrowedCommand.slice(0, -1), 'tests/qa/integration/other.test.ts'],
    ['bun', 'test', '--borrowed-public-domain-book', borrowedFile], [...borrowedCommand, '--borrowed-public-domain-book=ready']]) {
    test(`refuses incomplete, different or direct selection: ${command.join(' ')}`, async () => {
      await expect(withTestAdmission(command)).rejects.toThrow();
    });
  }

  test('binds a linked registered worker to the shared ledger instead of a proof clone directory', () => {
    const f = borrowedFixture();
    const bound = borrowedBookAdmission(f.env);
    expect(bound.directory).toBe(f.directory);
    expect(bound.workerGoals()).toEqual(['book', 'peer']);
    f.ledger.tasks.peer!.state = 'exited'; f.save();
    expect(bound.workerGoals()).toEqual(['book']);
    expect(existsSync(join(f.worktree, '.temp/goal-orchestration'))).toBe(false);
  });

  for (const [label, change] of [
    ['missing task', (f: ReturnType<typeof borrowedFixture>) => { delete f.env.GOAL_TASK_ID; }],
    ['missing worktree', f => { delete f.env.GOAL_WORKTREE; }],
    ['unknown task', f => { f.env.GOAL_TASK_ID = 'unregistered'; }],
    ['wrong Goal', f => { f.env.GOAL_ID = 'peer'; }],
    ['different registered worktree', f => { f.ledger.tasks.borrower!.worktree = f.origin; }],
    ['exited worker', f => { f.ledger.tasks.borrower!.state = 'exited'; }],
    ['dead attempt', f => { f.ledger.tasks.borrower!.attempts[0]!.pid = 2_000_000_000; }],
    ['missing attempt', f => { f.ledger.tasks.borrower!.attempts = []; }],
    ['closed Goal', f => { f.ledger.goals!.book!.closedAt = '2026-01-01'; }],
    ['clone-local owner', f => { f.env.GOAL_WORKTREE = f.origin; f.ledger.tasks.borrower!.worktree = f.origin; }],
    ['unbound admission directory', f => { f.env.GOAL_QA_SLOT_DIRECTORY = f.root; }],
    ['inherited slot', f => { f.env.GOAL_IN_SLOT = '1'; }],
    ['inherited heavy', f => { f.env.GOAL_QA_HEAVY_RUN = '1'; }],
    ['inherited heavy lock without run flag', f => { f.env.GOAL_QA_HEAVY_LOCK = join(f.directory, 'heavy'); }],
    ['inherited heavy token without run flag', f => { f.env.GOAL_QA_HEAVY_LEASE = 'inherited'; }],
    ['deferred heavy', f => { f.env.GOAL_QA_DEFERRED_HEAVY = '1'; }],
  ] satisfies [string, (f: ReturnType<typeof borrowedFixture>) => void][]) {
    test(`refuses ${label} before dispatch or lifecycle`, async () => {
      const f = borrowedFixture(); change(f); f.save();
      let calls = 0;
      await expect(withTestAdmission(borrowedCommand, false, undefined, { env: f.env,
        reap: () => { calls++; }, runCommand: async () => { calls++; return 0; } })).rejects.toThrow('Borrowed Book');
      expect(calls).toBe(0);
      expect(slotHolderLines(f.directory, 2)).toEqual([]);
    });
  }

  test('refuses missing or malformed shared state and an explicit replacement directory', async () => {
    const f = borrowedFixture();
    await expect(withTestAdmission(borrowedCommand, false, undefined, { env: f.env, slotDirectory: f.root })).rejects.toThrow('cannot replace');
    writeFileSync(f.ledgerFile, '{');
    expect(() => borrowedBookAdmission(f.env)).toThrow();
    rmSync(f.ledgerFile);
    expect(() => borrowedBookAdmission(f.env)).toThrow();
    f.save(); rmSync(f.directory, { recursive: true });
    expect(() => borrowedBookAdmission(f.env)).toThrow('shared admission');
  });

  test('keeps shared Goal share and ordering, real exit, result timing and artifact collection', async () => {
    const f = borrowedFixture(), result = join(f.root, 'result.json');
    const held = tryAcquireQaSlot(f.directory, 2, 0, { env: f.env, workerGoals: () => ['book', 'peer'] });
    if (held === 'held') throw new Error('fixture slot held');
    // A later peer is eligible while the borrower is at its share, despite the free second slot.
    mkdirSync(join(f.directory, 'waiters'), { recursive: true });
    const peer = join(f.directory, 'waiters/ordered-slot-peer.json');
    writeFileSync(peer, JSON.stringify({ pid: process.pid, goal: 'peer', waitingFor: 'slot', since: new Date(200).toISOString() }));
    let clock = 100, sleeps = 0;
    const artifact = join(process.cwd(), '.artifacts/qa', `borrowed-admission-${crypto.randomUUID()}`);
    try {
      expect(await withTestAdmission([...borrowedCommand, '--timeout=90000'], false, result, { env: f.env, now: () => clock,
        workerGoals: () => [], announce: () => {}, reap: () => { throw new Error('borrower reaped'); },
        sleep: async () => { sleeps++; clock = 120; rmSync(peer); },
        runCommand: async (command, env, start) => {
          expect(sleeps).toBe(1);
          expect(command).toEqual([...borrowedCommand, '--timeout=90000']);
          expect(env.GOAL_QA_SLOT_DIRECTORY).toBe(f.directory);
          expect(env.GOAL_IN_SLOT).toBe('1');
          expect(env.GOAL_QA_HEAVY_RUN).toBeUndefined();
          expect(slotHolderLines(f.directory, 2)).toHaveLength(2);
          start(); clock = 145; mkdirSync(artifact, { recursive: true });
          return 7;
        } })).toBe(7);
      expect(JSON.parse(readFileSync(result, 'utf8'))).toEqual({ code: 7, queuedAt: 100, startedAt: 120,
        finishedAt: 145, queueMs: 20, testMs: 25, totalMs: 45, artifactPaths: [artifact] });
      expect(readDirectoryLease(join(f.directory, '1'))).toBeUndefined();
      expect(readdirSync(join(f.directory, 'waiters'))).toEqual([]);
    } finally { held.release(); rmSync(artifact, { recursive: true, force: true }); }
  });

  test('keeps the ordinary queue deadline and refuses owner changes during a wait', async () => {
    for (const expired of [false, true]) {
      const f = borrowedFixture(), result = join(f.root, 'result.json');
      const leases = [0, 1].map(slot => tryAcquireQaSlot(f.directory, 2, slot, { env: { GOAL_ID: 'program' } }));
      let clock = 100, ran = false;
      try {
        await expect(withTestAdmission(borrowedCommand, false, result, { env: f.env, now: () => clock, timeoutMs: 10,
          announce: () => {}, reap: () => { throw new Error('borrower reaped'); }, sleep: async () => {
            clock = 111;
            if (!expired) { f.ledger.tasks.borrower!.state = 'exited'; f.save(); }
          }, runCommand: async () => { ran = true; return 0; } })).rejects.toThrow(expired ? 'No QA slot' : 'live registered Goal');
        expect(ran).toBe(false);
        expect(JSON.parse(readFileSync(result, 'utf8'))).toMatchObject({ queuedAt: 100, finishedAt: 111, testMs: 0 });
        expect(readdirSync(join(f.directory, 'waiters'))).toEqual([]);
      } finally { for (const lease of leases) if (lease !== 'held') lease.release(); }
    }
  });
});

for (const outcome of ['success', 'failure', 'cancel'] as const) {
  test(`borrowed Book real default process runner: ${outcome}, no lifecycle or settle`, async () => {
    const f = borrowedFixture(), scope = fixtureProcessScope();
    const driver = join(f.root, 'driver.ts'), childFile = join(f.root, 'stack-free-child.ts');
    const ready = join(f.root, 'ready.json'), lifecycle = join(f.root, 'lifecycle.log'), result = join(f.root, 'result.json');
    const bin = join(f.root, 'bin'); mkdirSync(bin);
    // Only unit evidence: the selected program runs a stack-free child, never the original C28 file.
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    writeFileSync(join(bin, 'bun'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(childFile)} "$@"\n`, { mode: 0o700 });
    writeFileSync(join(bin, 'docker'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(lifecycle)}\nexit 99\n`, { mode: 0o700 });
    writeFileSync(childFile, `import { writeFileSync } from 'node:fs';
      const descendant = ${outcome === 'cancel'} ? Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)']) : undefined;
      writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid, descendant: descendant?.pid,
        selected: process.argv.slice(2), directory: process.env.GOAL_QA_SLOT_DIRECTORY, inSlot: process.env.GOAL_IN_SLOT }));
      ${outcome === 'cancel' ? 'setInterval(() => {}, 1000);' : `process.exit(${outcome === 'success' ? 0 : 7});`}
    `);
    writeFileSync(driver, `import { mock } from 'bun:test';
      import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
      const ledger = JSON.parse(readFileSync(${JSON.stringify(f.ledgerFile)}, 'utf8'));
      ledger.tasks.borrower.attempts[0].pid = process.pid;
      writeFileSync(${JSON.stringify(f.ledgerFile)}, JSON.stringify(ledger));
      const reaperPath = ${JSON.stringify(join(import.meta.dir, '../qa/container-reaper.ts'))};
      const reaper = await import(reaperPath);
      const forbidden = () => { appendFileSync(${JSON.stringify(lifecycle)}, 'sweep or settle\\n'); throw new Error('borrowed lifecycle'); };
      mock.module(reaperPath, () => ({ ...reaper, sweepOrphanContainers: forbidden, reapSettleMs: 12345 }));
      const sleep = Bun.sleep;
      Bun.sleep = ((ms: number | Date) => { if (ms === 12345) forbidden(); return sleep(ms); }) as typeof Bun.sleep;
      const { withTestAdmission } = await import(${JSON.stringify(join(import.meta.dir, 'admission.ts'))});
      process.exit(await withTestAdmission(${JSON.stringify(borrowedCommand)}, false, ${JSON.stringify(result)}));
    `);
    const child = Bun.spawn([process.execPath, driver], { cwd: f.root, stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, ...scope.env, ...f.env, GOAL_IN_SLOT: '0', GOAL_QA_HEAVY_RUN: '0', GOAL_QA_DEFERRED_HEAVY: '0',
        GOAL_QA_SLOT_DIRECTORY: f.directory, PATH: `${bin}:${process.env.PATH}` } });
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(ready)) {
        if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Stack-free child did not start: ${await new Response(child.stderr).text()}`);
        await Bun.sleep(10);
      }
      const started = JSON.parse(readFileSync(ready, 'utf8'));
      expect(started.selected).toEqual(borrowedCommand.slice(1));
      expect(started.directory).toBe(f.directory);
      expect(started.inSlot).toBe('1');
      if (outcome === 'cancel') child.kill('SIGTERM');
      const code = await child.exited;
      expect(code).toBe(outcome === 'success' ? 0 : outcome === 'failure' ? 7 : 1);
      const receipt = JSON.parse(readFileSync(result, 'utf8'));
      expect(receipt.code).toBe(code);
      expect(receipt.startedAt).toBeNumber();
      expect(receipt.totalMs).toBeGreaterThanOrEqual(receipt.testMs);
      expect(slotHolderLines(f.directory, 2)).toEqual([]);
      expect(readdirSync(join(f.directory, 'waiters'))).toEqual([]);
      expect(existsSync(lifecycle)).toBe(false);
      if (outcome === 'cancel') expect(scope.processes()).toEqual([]);
    } finally { child.kill('SIGKILL'); await child.exited; scope.cleanup(); }
  }, 20_000);
}
