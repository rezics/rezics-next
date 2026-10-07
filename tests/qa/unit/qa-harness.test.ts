import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Script } from 'node:vm';
import ts from 'typescript-6';
import { devStackStopArgs, rememberDevStack, startedDevStacks, stopDevSession }
  from '../../../scripts/dev/stack-session.ts';
import { browserBudgets, browserFileCounts, browserProjectCount } from '../../../scripts/qa/browser-budget.ts';
import { dispatchTest, selectTestCommand } from '../../../scripts/qa/test.ts';
import { acquireQaSlots, commandAsync } from '../../../scripts/qa/core.ts';
import { waitForMemory } from '../../../scripts/qa/memory-admission.ts';
import { qaWaitStatusLines } from '../../../scripts/goal/goalctl.ts';
import { cleanupQaStacks, forgetQaStack, QA_STACK_REGISTRY, rememberQaStack }
  from '../../../scripts/qa/stack-ownership.ts';

const root = resolve(import.meta.dir, '../../..');

/** Exercise direct-run admission without starting the harness's unrelated tiers. */
function harnessAdmission(env: NodeJS.ProcessEnv, slotDirectory: string) {
  const source = ts.createSourceFile('cli.ts', readFileSync(join(root, 'scripts/qa/cli.ts'), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = new Set(['qaSlotDirectory', 'heavyQaRun']);
  const statements = source.statements.filter(node =>
    ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
      ts.isIdentifier(declaration.name) && names.has(declaration.name.text))
    || ts.isFunctionDeclaration(node) && node.name?.text === 'acquireRunSlots'
    || ts.isIfStatement(node) && node.getText(source).startsWith('if (qaSlotDirectory)')
    || ts.isExpressionStatement(node) && node.getText(source).startsWith('process.env.GOAL_QA_COMMAND ??='));
  if (statements.length !== 5) throw new Error('Missing QA CLI admission boundary');
  const boundary = ts.transpileModule(statements.map(node => node.getText(source)).join('\n')
    + '\nacquireRunSlots;', { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None } }).outputText;
  return new Script(boundary).runInNewContext({
    process: { env, pid: process.pid, argv: ['bun', 'scripts/qa/cli.ts', '--tier', 'model'],
      on: process.on.bind(process), off: process.off.bind(process) },
    goalSlotDirectory: () => slotDirectory, root, join, randomUUID, mkdirSync, renameSync, rmSync, writeFileSync,
    acquireQaSlots, Date, console,
  }) as (wanted: number, options?: Parameters<typeof acquireQaSlots>[4]) => ReturnType<typeof acquireQaSlots>;
}

/** Run the CLI entrypoint; replace only disposable stack lifecycle commands. */
function startupHarness(directory: string) {
  const executable = join(directory, 'bun');
  const slots = join(directory, 'slots');
  const control = join(directory, 'control');
  const lockFile = join(directory, 'startup.sqlite');
  mkdirSync(slots);
  mkdirSync(control);
  writeFileSync(executable, `#!${process.execPath}
    import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { withQaStackStartup } from ${JSON.stringify(join(root, 'scripts/qa/memory-admission.ts'))};
    import { commandAsync } from ${JSON.stringify(join(root, 'scripts/qa/core.ts'))};
    const args = process.argv.slice(2);
    if (args[0] === 'test') {
      const result = await commandAsync(${JSON.stringify(root)}, 'bun', ['scripts/dev/cli.ts', 'stack:up'], 10000,
        { ...process.env, QA_HARNESS_SLOT_OWNER: process.env.QA_HARNESS_SLOT_OWNER ?? String(process.ppid) });
      console.log(result.output);
      if (process.env.QA_HARNESS_REPEAT === '1') {
        const next = await commandAsync(${JSON.stringify(root)}, 'bun', ['scripts/dev/cli.ts', 'stack:up'], 10000,
          { ...process.env, QA_HARNESS_SLOT_OWNER: process.env.QA_HARNESS_SLOT_OWNER ?? String(process.ppid) });
        console.log(next.output);
      }
      process.exitCode = 1;
    } else {
    if (args[0] !== 'scripts/dev/cli.ts') throw new Error('Unexpected non-stack command: ' + args.join(' '));
    if (args[1] === 'stack:up') {
      const control = process.env.QA_HARNESS_CONTROL;
      const name = process.env.QA_HARNESS_NAME;
      await withQaStackStartup(${JSON.stringify(root)}, process.env, undefined, async () => {
        const leases = readdirSync(process.env.GOAL_QA_SLOT_DIRECTORY).filter(name => /^\\d+$/.test(name));
        if (!leases.some(name => Number(readFileSync(join(process.env.GOAL_QA_SLOT_DIRECTORY, name, 'pid'), 'utf8')) === Number(process.env.QA_HARNESS_SLOT_OWNER ?? process.ppid)))
          throw new Error('Stack started without its runner slot');
        writeFileSync(join(control, name + '-started'), String(process.ppid));
        while (!existsSync(join(control, name + '-finish'))) await Bun.sleep(10);
        throw new Error('Intentional stack startup stub failure');
      }, { lockFile: ${JSON.stringify(lockFile)}, pollMs: 10,
        announce: message => {
          console.log(message);
          // Captured output can be replayed in the same chunk before reservation finishes.
          if (message.startsWith('QA_STARTUP_SLOT_READY')) console.log(message);
        },
        read: async () => ({ vmTotal: 64 * 1024 ** 3, vmUsed: existsSync(join(control, name + '-memory')) ? 0 : 64 * 1024 ** 3,
          hostAvailable: 64 * 1024 ** 3 }) });
    } else if (!['stack:reset', 'stack:logs'].includes(args[1])) throw new Error('Unexpected stack operation');
    }
  `);
  chmodSync(executable, 0o755);
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const start = (name: string, tier = 'model', files: string[] = [], extraEnv: NodeJS.ProcessEnv = {}) => {
    const child = Bun.spawn([process.execPath, 'scripts/qa/cli.ts', '--tier', tier,
      ...files.flatMap(file => ['--file', file])], {
      cwd: root, stdout: 'pipe', stderr: 'pipe', env: { ...process.env,
        PATH: `${directory}:${process.env.PATH}`, GOAL_QA_SLOT_DIRECTORY: slots, GOAL_QA_SLOTS: '1',
        GOAL_QA_WAIT_DIR: join(slots, 'waiters'), GOAL_QA_HEAVY_RUN: '0', GOAL_IN_SLOT: '0',
        REZICS_QA_MEMORY_DEADLINE: String(Date.now() + 15_000),
        QA_HARNESS_CONTROL: control, QA_HARNESS_NAME: name, ...extraEnv,
      },
    });
    children.push(child);
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { child, output };
  };
  return { slots, control, lockFile, start, async stop() {
    for (const child of children) { if (child.exitCode === null) child.kill(); }
    await Promise.all(children.map(child => child.exited));
  } };
}

async function until(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await Bun.sleep(10);
  }
}

for (const tier of ['model', 'integration', 'fault/recovery']) {
  test(`real QA CLI ${tier} holds no slot during memory shortage and starts after admission`, async () => {
    const directory = mkdtempSync(join(root, '.temp', 'qa-cli-memory-order-'));
    const harness = startupHarness(directory);
    try {
      const run = harness.start('waiting', tier, tier === 'integration' ? ['tests/qa/integration/access-download-api.test.ts']
        : tier === 'fault/recovery' ? ['tests/qa/fault-recovery/content-rebuild.test.ts'] : []);
      await until(() => qaWaitStatusLines(harness.slots).some(line => line.includes('Waiting; QA memory:')), 'memory wait');
      expect(existsSync(join(harness.slots, '0'))).toBe(false);
      const other = await acquireQaSlots(harness.slots, 1, { GOAL_QA_SLOTS: '1' }, process.pid, { deadline: Date.now() });
      expect(other.count).toBe(1);
      other.release();
      writeFileSync(join(harness.control, 'waiting-memory'), '');
      await until(() => existsSync(join(harness.control, 'waiting-started')), 'admitted stack startup');
      expect(readFileSync(join(harness.slots, '0', 'pid'), 'utf8')).toBe(String(run.child.pid));
      // Readiness is still running: the lifetime lease remains held.
      expect(qaWaitStatusLines(harness.slots)).toEqual([]);
      writeFileSync(join(harness.control, 'waiting-finish'), '');
      expect(await run.child.exited).toBe(1);
      const output = (await run.output).join('\n');
      expect(output).toContain('QA artifacts:');
      expect(existsSync(join(harness.slots, '0'))).toBe(false);
    } finally { await harness.stop(); rmSync(directory, { recursive: true, force: true }); }
  }, 20_000);
}

test('real QA CLI retries fresh memory admission while its slot is busy', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'qa-cli-slot-retry-'));
  const harness = startupHarness(directory);
  const holder = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)']);
  const slot = await acquireQaSlots(harness.slots, 1, { GOAL_QA_SLOTS: '1' }, holder.pid);
  try {
    writeFileSync(join(harness.control, 'waiting-memory'), '');
    const run = harness.start('waiting');
    await until(() => qaWaitStatusLines(harness.slots).some(line => line.includes('Waiting for a QA slot after memory admission')),
      'slot wait after admission');
    // Existing workloads can consume memory while slots are busy. Admission must be fresh on retry.
    rmSync(join(harness.control, 'waiting-memory'));
    slot.release();
    await until(() => qaWaitStatusLines(harness.slots).some(line => line.includes('Waiting; QA memory:')), 'fresh shortage');
    expect(existsSync(join(harness.slots, '0'))).toBe(false);
    expect(existsSync(join(harness.control, 'waiting-started'))).toBe(false);
    writeFileSync(join(harness.control, 'waiting-memory'), '');
    await until(() => existsSync(join(harness.control, 'waiting-started')), 'recovered startup');
    writeFileSync(join(harness.control, 'waiting-finish'), '');
    expect(await run.child.exited).toBe(1);
    expect((await run.output).join('\n')).toContain('QA artifacts:');
    expect(existsSync(join(harness.slots, '0'))).toBe(false);
  } finally {
    slot.release(); holder.kill(); await holder.exited;
    await harness.stop(); rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);

for (const tier of ['integration', 'fault/recovery']) {
test(`real QA CLI ${tier} shards reuse their inherited one-slot lease`, async () => {
  const directory = mkdtempSync(join(root, '.temp', 'qa-cli-inherited-'));
  const harness = startupHarness(directory);
  const inherited = await acquireQaSlots(harness.slots, 1, { GOAL_QA_SLOTS: '1' });
  try {
    writeFileSync(join(harness.control, 'inherited-memory'), '');
    const run = harness.start('inherited', tier, [tier === 'integration' ? 'tests/qa/integration/access-download-api.test.ts'
      : 'tests/qa/fault-recovery/content-rebuild.test.ts'],
      { GOAL_IN_SLOT: '1', QA_HARNESS_SLOT_OWNER: String(process.pid), QA_HARNESS_REPEAT: '1' });
    await until(() => existsSync(join(harness.control, 'inherited-started')), 'startup with inherited lease');
    writeFileSync(join(harness.control, 'inherited-finish'), '');
    expect(await run.child.exited).toBe(1);
    expect((await run.output).join('\n')).toContain('QA artifacts:');
    expect(readFileSync(join(harness.slots, '0', 'pid'), 'utf8')).toBe(String(process.pid));
  } finally {
    inherited.release(); await harness.stop(); rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);
}

test('independent projects owned by one runner keep distinct leases', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'qa-project-leases-'));
  const env = { GOAL_QA_SLOTS: '2' };
  const first = await acquireQaSlots(directory, 1, env);
  try {
    const second = await acquireQaSlots(directory, 1, env, process.pid, { inherit: false, deadline: Date.now() });
    try {
      expect(existsSync(join(directory, '0'))).toBe(true);
      expect(existsSync(join(directory, '1'))).toBe(true);
      first.release();
      expect(existsSync(join(directory, '1'))).toBe(true);
    } finally { second.release(); }
  } finally { first.release(); rmSync(directory, { recursive: true, force: true }); }
});

test('real QA CLI startup contenders hold no slots until their startup turn', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'qa-cli-startup-order-'));
  const harness = startupHarness(directory);
  const mutex = new Database(harness.lockFile, { create: true });
  try {
    mutex.exec('BEGIN IMMEDIATE');
    writeFileSync(join(harness.control, 'first-memory'), '');
    writeFileSync(join(harness.control, 'second-memory'), '');
    const first = harness.start('first'), second = harness.start('second');
    await until(() => qaWaitStatusLines(harness.slots).filter(line => line.includes('Waiting for another QA startup')).length === 2,
      'both startup contenders');
    expect(existsSync(join(harness.slots, '0'))).toBe(false);
    mutex.exec('ROLLBACK');
    await until(() => ['first', 'second'].some(name => existsSync(join(harness.control, name + '-started'))), 'first startup');
    const leader = existsSync(join(harness.control, 'first-started')) ? 'first' : 'second';
    const follower = leader === 'first' ? 'second' : 'first';
    expect(existsSync(join(harness.control, follower + '-started'))).toBe(false);
    writeFileSync(join(harness.control, leader + '-finish'), '');
    await until(() => existsSync(join(harness.control, follower + '-started')), 'next startup');
    writeFileSync(join(harness.control, follower + '-finish'), '');
    expect(await first.child.exited).toBe(1);
    expect(await second.child.exited).toBe(1);
    for (const output of [await first.output, await second.output]) expect(output.join('\n')).toContain('QA artifacts:');
    expect(existsSync(join(harness.slots, '0'))).toBe(false);
    expect(qaWaitStatusLines(harness.slots)).toEqual([]);
  } finally { mutex.close(true); await harness.stop(); rmSync(directory, { recursive: true, force: true }); }
}, 20_000);

for (const inherited of [false, true]) {
  test(`QA harness ${inherited ? 'inherited' : 'direct'} slot waits appear in Goal status until admitted`, async () => {
    const directory = mkdtempSync(join(root, '.temp', 'qa-harness-status-'));
    const holder = Bun.spawn(['bun', '-e', 'setInterval(() => {}, 1000)']);
    const statusDirectory = inherited ? join(directory, 'inherited') : directory;
    const env: NodeJS.ProcessEnv = { REZICS_STACK_PROFILE: 'qa', GOAL_ID: 'program', GOAL_QA_SLOTS: '1',
      ...(inherited ? { GOAL_QA_WAIT_DIR: join(statusDirectory, 'waiters'), GOAL_QA_COMMAND: 'task qa -- --tier model' } : {}) };
    try {
      mkdirSync(join(directory, '0'));
      writeFileSync(join(directory, '0', 'pid'), String(holder.pid));
      const acquire = harnessAdmission(env, directory);
      const waiterDirectory = env.GOAL_QA_WAIT_DIR!;
      const command = inherited ? 'task qa -- --tier model' : 'bun scripts/qa/cli.ts --tier model';
      let polls = 0;
      const slots = await acquire(1, { announce: () => {}, sleep: async () => {
        polls++;
        const files = readdirSync(waiterDirectory);
        expect(files).toHaveLength(1);
        expect(JSON.parse(readFileSync(join(waiterDirectory, files[0]!), 'utf8'))).toMatchObject({
          pid: process.pid, goal: 'program', command, waitingFor: 'slot',
        });
        expect(qaWaitStatusLines(statusDirectory)).toEqual([
          `QA waiting for slot: Goal program (pid ${process.pid}): ${command}; Waiting for a QA slot; all 1 slots are held`,
        ]);
        rmSync(join(directory, '0'), { recursive: true });
      } });
      try {
        expect(polls).toBe(1);
        expect(slots.count).toBe(1);
        expect(readdirSync(waiterDirectory)).toEqual([]);
      } finally { slots.release(); }
    } finally {
      holder.kill();
      await holder.exited;
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('QA harness slot failure removes its waiter record and exit hook', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'qa-harness-status-deadline-'));
  const holder = Bun.spawn(['bun', '-e', 'setInterval(() => {}, 1000)']);
  const env: NodeJS.ProcessEnv = { REZICS_STACK_PROFILE: 'qa', GOAL_QA_SLOTS: '1' };
  let now = 0;
  const exitHooks = process.listenerCount('exit');
  try {
    mkdirSync(join(directory, '0'));
    writeFileSync(join(directory, '0', 'pid'), String(holder.pid));
    const acquire = harnessAdmission(env, directory);
    await expect(acquire(1, { now: () => now, deadline: 1, announce: () => {}, sleep: async () => {
      expect(qaWaitStatusLines(directory)).toHaveLength(1);
      now = 1;
    } })).rejects.toThrow('No QA slot became free before the deadline');
    expect(qaWaitStatusLines(directory)).toEqual([]);
    expect(process.listenerCount('exit')).toBe(exitHooks);
  } finally {
    holder.kill();
    await holder.exited;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('direct QA harness publishes memory waits through its inherited startup environment', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'qa-harness-memory-status-'));
  const env: NodeJS.ProcessEnv = { REZICS_STACK_PROFILE: 'qa', GOAL_ID: 'program' };
  let now = 0;
  try {
    harnessAdmission(env, directory);
    await waitForMemory({ vm: 0, vmReserve: 0, host: 1, hostReserve: 0 }, {
      env: { ...env }, deadline: 2, now: () => now, announce: () => {}, pollMs: 1,
      read: async () => ({ vmTotal: 0, vmUsed: 0, hostAvailable: now }),
      sleep: async ms => {
        const lines = qaWaitStatusLines(directory);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toStartWith(`QA waiting for memory: Goal program (pid ${process.pid}): bun scripts/qa/cli.ts --tier model; Waiting; QA memory:`);
        now += ms;
      },
    });
    expect(qaWaitStatusLines(directory)).toEqual([]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('direct Storybook test dispatch publishes memory waits before launching browser workers', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'qa-stories-memory-status-'));
  const story = 'packages/ui/src/components/badge.stories.tsx';
  const env: NodeJS.ProcessEnv = { REZICS_STACK_PROFILE: 'qa', GOAL_ID: 'program', GOAL_QA_SLOT_DIRECTORY: directory };
  let now = 0, started = false;
  try {
    const command = selectTestCommand([story]);
    const result = await dispatchTest([story], {
      env, deadline: 2,
      admission: (need, options) => waitForMemory(need, { ...options,
        now: () => now, pollMs: 1, announce: () => {},
        read: async () => ({ vmTotal: 0, vmUsed: 0, hostAvailable: now ? need.host + need.hostReserve : 0 }),
        sleep: async ms => {
          expect(started).toBe(false);
          const lines = qaWaitStatusLines(directory);
          expect(lines).toHaveLength(1);
          expect(lines[0]).toStartWith(`QA waiting for memory: Goal program (pid ${process.pid}): ${[command[0], ...command[1]].join(' ')}; Waiting; QA memory:`);
          now += ms;
        },
      }),
      runner: async selected => { expect(selected).toEqual(command); started = true; return 0; },
    });
    expect(result).toBe(0);
    expect(started).toBe(true);
    expect(qaWaitStatusLines(directory)).toEqual([]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('QA resets every child stack after failure and retains failed resets for retry', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'qa-ownership-'));
  try {
    const live = { profile: 'qa' as const, runId: 'title-test-l' };
    const restored = { profile: 'qa' as const, runId: 'title-test-r', persistent: true };
    rememberQaStack(live, directory);
    rememberQaStack(restored, directory);
    expect(() => rememberQaStack({ profile: 'dev' }, directory)).toThrow('only start QA');
    const resets: string[][] = [];
    const failed = await cleanupQaStacks(directory, async args => {
      resets.push(args);
      if (args.includes(live.runId)) throw new Error('Docker unavailable');
    });
    expect(resets).toEqual([
      ['--profile', 'qa', '--run-id', live.runId],
      ['--profile', 'qa', '--run-id', restored.runId, '--persistent'],
    ]);
    expect(failed).toEqual(['rezics-qa-title-test-l.json: Docker unavailable']);
    expect(readdirSync(directory)).toEqual(['rezics-qa-title-test-l.json']);
    expect(await cleanupQaStacks(directory, async () => {})).toEqual([]);
    expect(readdirSync(directory)).toEqual([]);
    rememberQaStack(live, directory);
    forgetQaStack(live, directory);
    expect(await cleanupQaStacks(directory, async () => { throw new Error('already reset'); })).toEqual([]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('QA timeout kills child setup processes and the runner still resets both recorded sites', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'qa-timeout-'));
  const heartbeat = join(directory, 'heartbeat');
  try {
    const source = `import { rememberQaStack } from './scripts/qa/stack-ownership.ts';
      rememberQaStack({ profile: 'qa', runId: 'translation-test-l' });
      rememberQaStack({ profile: 'qa', runId: 'translation-test-r' });
      Bun.spawn([process.execPath, '-e', ${JSON.stringify(`import { appendFileSync } from 'node:fs';
        setInterval(() => appendFileSync(${JSON.stringify(heartbeat)}, '.'), 10);`)}],
        { stdout: 'inherit', stderr: 'inherit' });
      await Bun.sleep(10000);`;
    const result = await commandAsync(root, 'bun', ['-e', source], 500,
      { ...process.env, [QA_STACK_REGISTRY]: directory });
    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
    expect(existsSync(heartbeat)).toBe(true);
    const stopped = readFileSync(heartbeat, 'utf8');
    await Bun.sleep(50);
    expect(readFileSync(heartbeat, 'utf8')).toBe(stopped);
    const resets: string[] = [];
    expect(await cleanupQaStacks(directory, async args => { resets.push(args[3]!); })).toEqual([]);
    expect(resets).toEqual(['translation-test-l', 'translation-test-r']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('dev stop retains custom isolated backends until their cleanup succeeds', () => {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const checkout = mkdtempSync(join(root, '.temp', 'dev-session-test-'));
  try {
    expect(startedDevStacks(checkout)).toEqual([]);
    const disposable = { profile: 'qa' as const, runId: 'wt-other-id', accountsApp: true };
    const persistent = { profile: 'qa' as const, runId: 'wt-persistent', persistent: true };
    rememberDevStack(checkout, disposable);
    rememberDevStack(checkout, persistent);
    rememberDevStack(checkout, disposable);
    expect(startedDevStacks(checkout).map(stack => stack.runId).sort()).toEqual(['wt-other-id', 'wt-persistent']);
    expect(devStackStopArgs(startedDevStacks(checkout)[0]!)).toEqual(['down', '--remove-orphans']);
    expect(devStackStopArgs(disposable)).toEqual(['down', '--volumes', '--remove-orphans']);
    expect(() => stopDevSession(checkout, () => {}, () => { throw new Error('Docker unavailable'); }))
      .toThrow('Docker unavailable');
    // An interrupted cleanup has no forget call: the next stop still sees both.
    expect(startedDevStacks(checkout)).toHaveLength(2);
    const stopped: string[] = [];
    // No --backend argument: stop everything the session remembers, even if
    // AppHost never finished starting. Preserve the host failure for diagnosis.
    expect(() => stopDevSession(checkout, () => { throw new Error('AppHost absent'); },
      stack => { stopped.push(stack.runId!); })).toThrow('AppHost absent');
    expect(stopped.sort()).toEqual(['wt-other-id', 'wt-persistent']);
    expect(startedDevStacks(checkout)).toEqual([]);
    expect(() => rememberDevStack(checkout, { profile: 'dev' })).toThrow('Only isolated');
  } finally { rmSync(checkout, { recursive: true, force: true }); }
});

test('browser runners have independent budgets scaled to the selected files', () => {
  const small = browserBudgets(1, 1);
  const full = browserBudgets(18, 137);
  expect(small.playwright).toBe(300_000);
  expect(full.playwright).toBeGreaterThan(small.playwright);
  expect(full.storybook).toBeGreaterThan(180_000);
  expect(browserBudgets(1, 137).playwright).toBe(small.playwright);
  expect(browserBudgets(18, 1).storybook).toBe(small.storybook);
  expect(() => browserBudgets(0, 1)).toThrow('positive integers');
  // Each engine project repeats the files, so the Playwright budget grows with them.
  expect(browserBudgets(1, 1, 3).playwright).toBe(3 * small.playwright);
  expect([browserProjectCount(undefined), browserProjectCount('desktop-chrome'), browserProjectCount('a,b'), browserProjectCount('all')]).toEqual([1, 1, 2, 3]);
  const selected = browserFileCounts(root, ['apps/web/tests/work-page.e2e.ts']);
  expect(selected.playwright).toBe(1);
  expect(selected.storybook).toBeGreaterThan(1);
});

test('goalctl test routes explicit stories and tier runs to their owning runner', () => {
  expect(selectTestCommand(['apps/web/features/manage/members.stories.tsx', '-t', 'Give Role']))
    .toEqual(['task', ['storybook:test', '--', 'features/manage/members.stories.tsx', '-t', 'Give Role']]);
  expect(selectTestCommand(['apps/accounts/features/account/personal-info.stories.tsx'])[1][0])
    .toBe('accounts:storybook:test');
  expect(() => selectTestCommand(['apps/web/features/manage/members.stories.tsx',
    'apps/accounts/features/account/personal-info.stories.tsx'])).toThrow('separately');
  expect(selectTestCommand(['--tier', 'unit'])).toEqual(['bun', ['scripts/qa/cli.ts', '--tier', 'unit']]);
  expect(() => selectTestCommand(['--tier', 'made-up'])).toThrow();
});
