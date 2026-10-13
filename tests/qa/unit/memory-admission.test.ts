import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { withQaMemory } from '../../../scripts/qa/core.ts';
import { FixtureWorkBudget } from '../../../scripts/fixture/budget.ts';
import { startRestoredFixture } from '../../../scripts/fixture/restore.ts';
import type { FixtureRestoreEvidence } from '../../../scripts/fixture/restore.ts';
import type { FixtureManifest } from '../../../scripts/fixture/manifest.ts';
import { assertPhaseDRestore, PHASE_D_FIXTURE } from '../load/fixture-phase-d.ts';
import { processStartTime } from '../../../scripts/qa/process/identity.ts';
import { GiB, measuredAdmissionMessage, memoryBytes, parseMemoryReading, qaMemoryNeed, waitForMemory as waitForMemoryImpl,
  isLocalQaRun, qaMemoryDeadline, withMemoryStartup as withMemoryStartupImpl, withQaStackStartup,
  type MemoryReading, type MemoryWaitOptions, type StartupMemoryOptions } from '../../../scripts/qa/memory-admission.ts';

const root = resolve(import.meta.dir, '../../..');
const need = qaMemoryNeed(root, 'other', 'ordinary', {});
const qaEnv = { REZICS_STACK_PROFILE: 'qa' };
const plenty: MemoryReading = { vmTotal: 24 * GiB, vmUsed: 5 * GiB, hostAvailable: 20 * GiB };

test('memory admission budgets Compose caps, resource classes and overridden thresholds', () => {
  expect(need).toEqual({ vm: 5.375 * GiB, host: GiB, hostReserve: 8 * GiB, vmReserve: 0 });
  expect(qaMemoryNeed(root, 'browser', 'large-tmpfs', {}).vm).toBe(10.375 * GiB);
  expect(qaMemoryNeed(root, 'browser', 'catalogue-disk', {}).host).toBe(4 * GiB);
  expect(qaMemoryNeed(root, 'other', undefined, {}).vm).toBe(0);
  expect(qaMemoryNeed(root, 'other', 'ordinary', { REZICS_POSTGRES_MEMORY_LIMIT: '2048MB' }).vm).toBe(need.vm);
  expect(qaMemoryNeed(root, 'browser', 'ordinary', {
    REZICS_FUSEKI_MEMORY_LIMIT: '8g', REZICS_POSTGRES_MEMORY_LIMIT: '1536m',
    REZICS_QA_BROWSER_MEMORY_GIB: '5', REZICS_QA_HOST_RESERVE_GIB: '10', REZICS_QA_VM_RESERVE_GIB: '1',
  })).toEqual({ vm: 10.875 * GiB, host: 5 * GiB, hostReserve: 10 * GiB, vmReserve: GiB });
  expect(() => qaMemoryNeed(root, 'other', 'ordinary', { REZICS_RUSTFS_MEMORY_LIMIT: '0' }))
    .toThrow('finite, positive');
  expect(() => qaMemoryNeed(root, 'other', undefined, { REZICS_QA_HOST_RESERVE_GIB: '-1' }))
    .toThrow('nonnegative');
  expect(() => qaMemoryNeed(root, 'other', undefined, { REZICS_QA_HOST_MEMORY_GIB: '' }))
    .toThrow('nonnegative');
});

test('admission inherits the run deadline without capping it to the fallback duration', () => {
  const deadline = Date.now() + 7 * 3_600_000;
  const env = { REZICS_QA_MEMORY_DEADLINE: String(deadline) };
  expect(qaMemoryDeadline(env)).toBe(deadline);
  expect(qaMemoryDeadline(env, deadline - 1)).toBe(deadline - 1);
});

const scratch = join(root, '.temp');
mkdirSync(scratch, { recursive: true });

const readingDirectories: string[] = [];
afterEach(() => {
  for (const dir of readingDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function waitForMemory(need: Parameters<typeof waitForMemoryImpl>[0], options: MemoryWaitOptions) {
  const dir = mkdtempSync(join(scratch, 'qa-reading-'));
  readingDirectories.push(dir);
  return waitForMemoryImpl(need, { lockFile: join(dir, 'state.sqlite'), readingMaxAgeMs: 1, ...options });
}
function withMemoryStartup<T>(need: Parameters<typeof withMemoryStartupImpl>[0], options: StartupMemoryOptions,
  start: () => T | Promise<T>) {
  return withMemoryStartupImpl(need, { readingMaxAgeMs: 1, ...options }, start);
}

for (const activeMs of [240_000, 400_000]) {
test(`a restore reports five minutes of admission separately and qualifies ${activeMs} ms of active work`, async () => {
  const dir = mkdtempSync(join(scratch, 'qa-restore-timing-'));
  let now = 0;
  const budget = new FixtureWorkBudget(600_000, () => now);
  try {
    await startRestoredFixture(budget, { REZICS_STACK_PROFILE: 'qa', REZICS_QA_MEMORY_DEADLINE: '1000000' },
      timeout => { expect(timeout).toBe(180_000); now += 120_000; }, {
        lockFile: join(dir, 'mutex.sqlite'), now: () => now, pollMs: 60_000,
        sleep: async ms => { now += ms; }, announce: () => {},
        read: async () => ({ ...plenty, vmUsed: now < 300_000 ? plenty.vmTotal : 0 }),
      });
    now += activeMs - 120_000;
    const restore: FixtureRestoreEvidence = { fixture: PHASE_D_FIXTURE, target: 'fixture-clocked',
      profile: 'medium', works: 100_000, startedAt: new Date(0).toISOString(), deadlineMs: 600_000,
      phases: {}, artifacts: dir, completedAt: new Date(now).toISOString(), ...budget.timing() };
    expect(restore).toMatchObject({ elapsedMs: activeMs, admissionWaitMs: 300_000 });
    const manifest = { entities: { works: 100_000, publicUnits: 10_000 } } as FixtureManifest;
    expect(() => assertPhaseDRestore(restore, manifest, restore.target)).not.toThrow();
    now += 600_001 - activeMs;
    expect(() => assertPhaseDRestore({ ...restore, ...budget.timing() }, manifest, restore.target))
      .toThrow('not a qualified');
    expect(() => budget.remaining()).toThrow('600 seconds');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
}

async function untilFile(path: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(5);
  expect(existsSync(path)).toBe(true);
}

test('admission uses existing Goal orchestration or the actual QA profile, never a target name', async () => {
  const dir = mkdtempSync(join(scratch, 'qa-memory-context-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: dir });
    expect(await isLocalQaRun(dir, {})).toBe(false);
    expect(await isLocalQaRun(dir, { REZICS_STACK_PROFILE: 'dev', REZICS_QA_RUN_ID: 'production-restore' })).toBe(false);
    expect(await isLocalQaRun(dir, { GOAL_TASK_ID: 'G-0' })).toBe(true);
    expect(await isLocalQaRun(dir, { REZICS_STACK_PROFILE: 'qa' })).toBe(true);
    mkdirSync(join(dir, '.temp', 'goal-orchestration', 'qa-slots'), { recursive: true });
    expect(await isLocalQaRun(dir, {})).toBe(true);
    for (const profile of ['dev', 'production', '']) {
      expect(await isLocalQaRun(dir, { REZICS_STACK_PROFILE: profile })).toBe(false);
      expect(await isLocalQaRun(dir, { REZICS_STACK_PROFILE: profile, GOAL_TASK_ID: 'G-0' })).toBe(false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('saved dev restores bypass all admission entry points even with Goal metadata, while QA still waits', async () => {
  const dir = mkdtempSync(join(scratch, 'qa-memory-production-'));
  const lockFile = join(dir, 'must-not-be-created.sqlite');
  const starts: string[] = [];
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: dir });
    mkdirSync(join(dir, '.temp', 'goal-orchestration', 'qa-slots'), { recursive: true });
    const env = { REZICS_STACK_PROFILE: 'dev', GOAL_TASK_ID: 'G-0', REZICS_QA_MEMORY_DEADLINE: 'invalid',
      REZICS_FUSEKI_MEMORY_LIMIT: '0', REZICS_QA_HOST_RESERVE_GIB: 'invalid' };
    const options = { root: dir, env, lockFile, deadline: -1, pollMs: 0,
      now: () => { throw new Error('Production inspected a QA clock'); },
      read: async () => { throw new Error('Production inspected memory'); },
      announce: () => { throw new Error('Production printed QA admission'); } };
    await waitForMemory(need, options);
    expect(await withMemoryStartup(need, options, () => { starts.push('mutex'); return 'restored'; })).toBe('restored');
    await withQaMemory(need, options, async () => { starts.push('host'); });
    await withQaStackStartup(dir, env, -1, () => { starts.push('stack'); }, options);
    expect(starts).toEqual(['mutex', 'host', 'stack']);
    expect(existsSync(lockFile)).toBe(false);

    mkdirSync(join(dir, 'infra', 'dev'), { recursive: true });
    writeFileSync(join(dir, 'infra', 'dev', 'compose.qa.yaml'), readFileSync(join(root, 'infra', 'dev', 'compose.qa.yaml')));
    let now = 0, reads = 0, started = false;
    await expect(withQaStackStartup(dir, { REZICS_STACK_PROFILE: 'qa', REZICS_FUSEKI_MEMORY_LIMIT: '2g' }, 10,
      () => { started = true; }, { lockFile, now: () => now, pollMs: 10,
        sleep: async ms => { now += ms; }, announce: () => {},
        read: async () => { reads++; return { ...plenty, vmUsed: plenty.vmTotal }; },
      })).rejects.toThrow('free 0.00 GiB');
    expect(started).toBe(false);
    expect(reads).toBe(1);
    expect(now).toBe(10);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('independent QA processes measure after the preceding startup and wait for its memory to clear', async () => {
  const dir = mkdtempSync(join(scratch, 'qa-memory-processes-'));
  const script = join(dir, 'startup.ts');
  writeFileSync(join(dir, 'used'), String(18 * GiB));
  writeFileSync(script, `
    import { withMemoryStartup } from ${JSON.stringify(join(root, 'scripts/qa/memory-admission.ts'))};
    import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const [dir, name] = process.argv.slice(2);
    await withMemoryStartup(${JSON.stringify(need)}, {
      env: { ...${JSON.stringify(qaEnv)}, GOAL_QA_SLOT_DIRECTORY: join(dir, 'qa-slots') },
      deadline: Date.now() + 5_000, lockFile: join(dir, 'mutex.sqlite'), pollMs: 5,
      announce: message => {
        if (message.startsWith('Waiting for another')) writeFileSync(join(dir, name + '-queued'), message);
        if (message.startsWith('Waiting;')) writeFileSync(join(dir, name + '-short'), message);
      },
      read: async () => {
        const vmUsed = Number(readFileSync(join(dir, 'used'), 'utf8'));
        appendFileSync(join(dir, 'reads'), name + ':' + vmUsed + '\\n');
        return { vmTotal: ${24 * GiB}, vmUsed, hostAvailable: ${20 * GiB} };
      },
    }, async () => {
      writeFileSync(join(dir, name + '-started'), 'started');
      if (name === 'first') {
        while (!existsSync(join(dir, 'release'))) await Bun.sleep(5);
        writeFileSync(join(dir, 'used'), String(${21 * GiB}));
      }
    });
  `);
  const children: ReturnType<typeof Bun.spawn>[] = [];
  try {
    const first = Bun.spawn(['bun', script, dir, 'first'], { stdout: 'pipe', stderr: 'pipe' });
    children.push(first);
    await untilFile(join(dir, 'first-started'));
    const second = Bun.spawn(['bun', script, dir, 'second'], { stdout: 'pipe', stderr: 'pipe' });
    children.push(second);
    await untilFile(join(dir, 'second-queued'));
    expect(existsSync(join(dir, 'second-started'))).toBe(false);
    writeFileSync(join(dir, 'release'), 'ready');
    expect(await first.exited).toBe(0);
    await untilFile(join(dir, 'second-short'));
    expect(existsSync(join(dir, 'second-started'))).toBe(false);
    expect(readFileSync(join(dir, 'reads'), 'utf8')).toContain(`second:${21 * GiB}`);
    writeFileSync(join(dir, 'used'), String(18 * GiB));
    expect(await second.exited).toBe(0);
    expect(existsSync(join(dir, 'second-started'))).toBe(true);
  } finally {
    for (const child of children) { child.kill(); await child.exited; }
    rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function assertStartupUnlocked(lockFile: string) {
  const competitor = new Database(lockFile);
  try { competitor.exec('BEGIN IMMEDIATE'); competitor.exec('ROLLBACK'); }
  finally { competitor.close(true); }
}

for (const fails of [false, true]) {
  test(`ten waiting processes share one ${fails ? 'failed' : 'successful'} measurement and refresh after expiry`, async () => {
    const dir = mkdtempSync(join(scratch, 'qa-reading-sharing-'));
    const script = join(dir, 'wait.ts');
    writeFileSync(script, `
      import { waitForMemory } from ${JSON.stringify(join(root, 'scripts/qa/memory-admission.ts'))};
      import { appendFileSync } from 'node:fs';
      await waitForMemory(${JSON.stringify(need)}, {
        env: ${JSON.stringify(qaEnv)}, lockFile: ${JSON.stringify(join(dir, 'state.sqlite'))},
        deadline: Date.now() + 5000, readingMaxAgeMs: 3000,
        read: async () => {
          appendFileSync(${JSON.stringify(join(dir, 'readings'))}, 'reading\\n');
          await Bun.sleep(100);
          ${fails ? "throw new Error('Docker measurement unavailable');" : `return ${JSON.stringify({ ...plenty, vmUsed: plenty.vmTotal })};`}
        },
        announce: message => { console.log(message); throw new Error('observed'); },
      });
    `);
    const children: ReturnType<typeof Bun.spawn>[] = [];
    const wave = async (count: number) => {
      const waveChildren = Array.from({ length: count }, () => Bun.spawn(['bun', script], { stdout: 'pipe', stderr: 'pipe' }));
      children.push(...waveChildren);
      const lines = await Promise.all(waveChildren.map(async child => {
        const stdout = new Response(child.stdout).text();
        const stderr = new Response(child.stderr).text();
        expect(await child.exited).toBe(1);
        expect(await stderr).toContain('observed');
        return await stdout;
      }));
      for (const line of lines) expect(line).toContain(fails ? 'measurement failed: Docker measurement unavailable' : 'free 0.00 GiB');
    };
    try {
      await wave(10);
      expect(readFileSync(join(dir, 'readings'), 'utf8').trim().split('\n')).toHaveLength(1);
      const db = new Database(join(dir, 'state.sqlite'));
      try { db.query('UPDATE memory_readings SET finished_at = ?').run(Date.now() - 3000); }
      finally { db.close(true); }
      await wave(2);
      expect(readFileSync(join(dir, 'readings'), 'utf8').trim().split('\n')).toHaveLength(2);
    } finally {
      for (const child of children) { child.kill(); await child.exited; }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
}

test('a dead measuring process leaves its turn to the next waiter', async () => {
  const dir = mkdtempSync(join(scratch, 'qa-reading-death-'));
  const lockFile = join(dir, 'state.sqlite'), ready = join(dir, 'measuring'), script = join(dir, 'measure.ts');
  writeFileSync(script, `
    import { waitForMemory } from ${JSON.stringify(join(root, 'scripts/qa/memory-admission.ts'))};
    import { writeFileSync } from 'node:fs';
    await waitForMemory(${JSON.stringify(need)}, {
      env: ${JSON.stringify(qaEnv)}, lockFile: ${JSON.stringify(lockFile)}, deadline: Date.now() + 5000,
      read: async () => { writeFileSync(${JSON.stringify(ready)}, 'ready');
        await new Promise(() => { setInterval(() => {}, 1000); }); return ${JSON.stringify(plenty)}; },
    });
  `);
  const child = Bun.spawn(['bun', script], { stdout: 'pipe', stderr: 'pipe' });
  try {
    await untilFile(ready);
    let reads = 0;
    const waiting = deferred<void>();
    const next = waitForMemoryImpl(need, { env: qaEnv, lockFile, deadline: Date.now() + 2000,
      read: async () => { reads++; return plenty; }, announce: () => {},
      sleep: async ms => { waiting.resolve(); await Bun.sleep(ms); } });
    await waiting.promise;
    expect(reads).toBe(0);
    child.kill('SIGKILL'); await child.exited;
    await next;
    expect(reads).toBe(1);
  } finally { child.kill(); await child.exited; rmSync(dir, { recursive: true, force: true }); }
});

test('a reading begun before startup completion cannot admit even when it finishes afterwards', async () => {
  const dir = mkdtempSync(join(scratch, 'qa-reading-generation-'));
  let now = 0, reads = 0, started = false;
  const ready = deferred<void>(), finish = deferred<void>();
  const options = { env: qaEnv, lockFile: join(dir, 'state.sqlite'), readingMaxAgeMs: 3000,
    now: () => now, deadline: 3100, pollMs: 5, sleep: async (ms: number) => { now += ms; }, announce: () => {} };
  try {
    const first = withMemoryStartupImpl(need, { ...options, read: async () => { reads++; return plenty; } }, async () => {
      ready.resolve(); await finish.promise;
    });
    await ready.promise;
    now = 3001;
    await expect(withMemoryStartupImpl(need, { ...options, read: async () => {
      reads++;
      assertStartupUnlocked(options.lockFile);
      if (reads === 2) { finish.resolve(); await first; return plenty; }
      return { ...plenty, vmUsed: plenty.vmTotal };
    } }, () => { started = true; })).rejects.toThrow('free 0.00 GiB');
    expect(started).toBe(false);
    expect(reads).toBe(3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

async function startupScenario(concurrency?: string) {
  const directory = mkdtempSync(join(scratch, 'qa-startup-promises-'));
  const lockFile = join(directory, 'mutex.sqlite');
  if (concurrency !== undefined) writeFileSync(join(directory, 'qa-startup-concurrency'), concurrency);
  const env = { ...qaEnv, GOAL_QA_SLOT_DIRECTORY: join(directory, 'qa-slots') };
  let now = 0;
  const sleeping = deferred<void>();
  const wake = deferred<void>();
  const lines: string[] = [];
  const options = { env, lockFile, deadline: 100, pollMs: 5, now: () => now,
    read: async () => plenty, announce: (message: string) => { lines.push(message); },
    sleep: async (ms: number) => {
      assertStartupUnlocked(lockFile);
      sleeping.resolve();
      await wake.promise;
      now += ms;
    } };
  return { directory, lockFile, options, sleeping, wake, lines };
}

for (const concurrency of [undefined, '0', '-2', '1.5', 'invalid', '9007199254740992', '1']) {
test(`startup concurrency ${concurrency ?? 'absent'} serializes starts and never holds the lock while sleeping`, async () => {
  const scenario = await startupScenario(concurrency);
  const firstReady = deferred<void>(), finishFirst = deferred<void>();
  let secondStarted = false;
  try {
    const first = withMemoryStartup(need, scenario.options, async () => {
      assertStartupUnlocked(scenario.lockFile);
      firstReady.resolve();
      await finishFirst.promise;
    });
    await firstReady.promise;
    const second = withMemoryStartup(need, scenario.options, () => {
      assertStartupUnlocked(scenario.lockFile);
      secondStarted = true;
    });
    await scenario.sleeping.promise;
    expect(secondStarted).toBe(false);
    expect(scenario.lines.some(line => line.startsWith('Waiting for another QA startup; QA memory:'))).toBe(true);
    finishFirst.resolve();
    await first;
    scenario.wake.resolve();
    await second;
    expect(secondStarted).toBe(true);
  } finally { rmSync(scenario.directory, { recursive: true, force: true }); }
});
}

test('two startup promises overlap at K=2 and a third begins after either resolves', async () => {
  const scenario = await startupScenario('2');
  const firstReady = deferred<void>(), secondReady = deferred<void>();
  const finishFirst = deferred<void>(), finishSecond = deferred<void>();
  let thirdStarted = false;
  try {
    const first = withMemoryStartup(need, scenario.options, async () => {
      assertStartupUnlocked(scenario.lockFile);
      firstReady.resolve(); await finishFirst.promise;
    });
    await firstReady.promise;
    const second = withMemoryStartup(need, scenario.options, async () => {
      assertStartupUnlocked(scenario.lockFile);
      secondReady.resolve(); await finishSecond.promise;
    });
    await secondReady.promise;
    const third = withMemoryStartup(need, scenario.options, () => {
      assertStartupUnlocked(scenario.lockFile); thirdStarted = true;
    });
    await scenario.sleeping.promise;
    expect(thirdStarted).toBe(false);
    finishSecond.resolve(); await second;
    scenario.wake.resolve(); await third;
    expect(thirdStarted).toBe(true);
    finishFirst.resolve(); await first;
  } finally { rmSync(scenario.directory, { recursive: true, force: true }); }
});

for (const constrained of ['vm', 'host'] as const) {
test(`live promises subtract ${constrained} need while memory readings include completed startups`, async () => {
  const scenario = await startupScenario('3');
  const firstReady = deferred<void>(), finishFirst = deferred<void>();
  const smallNeed = { vm: 4 * GiB, host: 3 * GiB, vmReserve: GiB, hostReserve: 2 * GiB };
  let firstFinished = false, secondStarted = false, readings = 0;
  const options = { ...scenario.options, read: async () => {
    readings++;
    return { vmTotal: 10 * GiB, vmUsed: constrained === 'vm' ? (firstFinished ? 5 : 4) * GiB : 0,
      hostAvailable: constrained === 'host' ? (firstFinished ? 6 : 7) * GiB : 20 * GiB };
  } };
  try {
    const first = withMemoryStartup(smallNeed, options, async () => {
      firstReady.resolve(); await finishFirst.promise; firstFinished = true;
    });
    await firstReady.promise;
    const second = withMemoryStartup(smallNeed, options, () => { secondStarted = true; });
    await scenario.sleeping.promise;
    expect(secondStarted).toBe(false);
    expect(scenario.lines.some(line => line.startsWith('Waiting; QA memory:'))).toBe(true);
    finishFirst.resolve(); await first;
    scenario.wake.resolve(); await second;
    expect(firstFinished).toBe(true);
    expect(secondStarted).toBe(true);
    expect(readings).toBe(2);
  } finally { rmSync(scenario.directory, { recursive: true, force: true }); }
});
}

test('old lock files gain the promise table; gone, reused and expired owners are removed', async () => {
  const scenario = await startupScenario('1');
  const db = new Database(scenario.lockFile, { create: true });
  try {
    db.exec('CREATE TABLE old_lock (id INTEGER)');
    await withMemoryStartup(need, scenario.options, () => {});
    for (const [id, pid, startTime, admitted] of [
      ['gone', 2_147_483_647, '1', 0],
      ['reused', process.pid, `${processStartTime(process.pid)}-different`, 0],
      ['expired', process.pid, processStartTime(process.pid)!, -900_001],
    ] as const) {
      db.query('INSERT INTO startup_promises (id, pid, start_time, vm, host, admitted_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, pid, startTime, 100 * GiB, 100 * GiB, admitted);
    }
    await withMemoryStartup(need, scenario.options, () => {
      expect(db.query('SELECT id FROM startup_promises').all()).toHaveLength(1);
    });
    expect(db.query('SELECT id FROM startup_promises').all()).toHaveLength(0);
    await expect(withMemoryStartup(need, scenario.options, () => { throw new Error('Compose readiness failed'); }))
      .rejects.toThrow('Compose readiness failed');
    expect(db.query('SELECT id FROM startup_promises').all()).toHaveLength(0);
  } finally { db.close(true); rmSync(scenario.directory, { recursive: true, force: true }); }
});

test('startup mutex obeys deadlines and releases after memory shortage and startup failure', async () => {
  const dir = mkdtempSync(join(scratch, 'qa-memory-release-'));
  const lockFile = join(dir, 'mutex.sqlite');
  const holder = new Database(lockFile, { create: true });
  let now = 0, started = false;
  const options = { env: qaEnv, lockFile, deadline: 25, now: () => now, pollMs: 10,
    sleep: async (ms: number) => { now += ms; }, announce: () => {}, read: async () => plenty };
  try {
    holder.exec('BEGIN IMMEDIATE');
    await expect(withMemoryStartup(need, { ...options, read: async () => { throw new Error('Read before lock'); } },
      () => { started = true; })).rejects.toThrow('deadline reached waiting for another QA startup');
    expect(now).toBe(25);
    expect(started).toBe(false);
    holder.exec('ROLLBACK');
    now = 0;
    await expect(withMemoryStartup(need, { ...options, read: async () => ({ ...plenty, vmUsed: plenty.vmTotal }) },
      () => { started = true; })).rejects.toThrow('free 0.00 GiB');
    expect(started).toBe(false);
    now = 0;
    await expect(withMemoryStartup(need, options, () => { throw new Error('Compose failed'); })).rejects.toThrow('Compose failed');
    expect(await withMemoryStartup(need, options, () => 'recovered')).toBe('recovered');
  } finally { holder.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('process death discards startup promises before the next admission', async () => {
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    const dir = mkdtempSync(join(scratch, 'qa-memory-death-'));
    const lockFile = join(dir, 'mutex.sqlite');
    const ready = join(dir, 'ready');
    const script = join(dir, 'holder.ts');
    writeFileSync(script, `
      import { withMemoryStartup } from ${JSON.stringify(join(root, 'scripts/qa/memory-admission.ts'))};
      import { writeFileSync } from 'node:fs';
      await withMemoryStartup(${JSON.stringify(need)}, { env: ${JSON.stringify(qaEnv)}, lockFile: ${JSON.stringify(lockFile)},
        deadline: Date.now() + 5_000, announce: () => {}, read: async () => (${JSON.stringify(plenty)}) }, async () => {
        writeFileSync(${JSON.stringify(ready)}, 'held');
        await new Promise(() => { setInterval(() => {}, 1000); });
      });
    `);
    const child = Bun.spawn(['bun', script], { stdout: 'pipe', stderr: 'pipe' });
    try {
      await untilFile(ready);
      child.kill(signal);
      await child.exited;
      expect(await withMemoryStartup(need, { env: qaEnv, lockFile, deadline: Date.now() + 5000,
        announce: () => {}, read: async () => plenty }, () => 'recovered')).toBe('recovered');
    } finally { child.kill(); await child.exited; rmSync(dir, { recursive: true, force: true }); }
  }
}, 10_000);

test('each source and restore target startup receives a fresh reading and its inherited deadline', async () => {
  const dir = mkdtempSync(join(scratch, 'qa-memory-children-'));
  let now = 0, used = 0, reads = 0;
  const starts: string[] = [];
  const env = { REZICS_STACK_PROFILE: 'qa', REZICS_QA_MEMORY_DEADLINE: '25' };
  const options = { lockFile: join(dir, 'mutex.sqlite'), readingMaxAgeMs: 0, now: () => now, pollMs: 10,
    announce: () => {}, sleep: async (ms: number) => { now += ms; }, read: async () => {
      reads++; return { vmTotal: 12 * GiB, vmUsed: used, hostAvailable: 20 * GiB };
    } };
  try {
    await withQaStackStartup(root, env, 100, () => { starts.push('source'); used = 3 * GiB; }, options);
    const target = (name: string) => ({ environment: env, compose: (args: string[]) => {
      expect(args).toEqual(['up', '-d', '--wait', 'postgres', 'fuseki', 'rustfs']);
      starts.push(name); return '';
    } });
    await expect(withQaStackStartup(root, env, 100, () => { target('restore-target').compose(['up', '-d', '--wait', 'postgres', 'fuseki', 'rustfs']); }, options))
      .rejects.toThrow('free 9.00 GiB');
    expect(starts).toEqual(['source']);
    expect(reads).toBeGreaterThan(1);
    expect(now).toBe(25);
    now = 0; used = 0;
    await withQaStackStartup(root, env, 100, () => { target('fresh-restore-target').compose(['up', '-d', '--wait', 'postgres', 'fuseki', 'rustfs']); }, options);
    expect(starts).toEqual(['source', 'fresh-restore-target']);
    expect(qaMemoryDeadline(env, 10)).toBe(10);
    expect(() => qaMemoryDeadline({ REZICS_QA_MEMORY_DEADLINE: 'unknown' }, 100)).toThrow('Invalid');
    expect(qaMemoryNeed(root, 'other', 'catalogue-disk', {}, ['fuseki']).vm).toBe(7 * GiB);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('host-only admission can start without Docker and still enforces its reserve', async () => {
  const previous = process.env.PATH;
  try {
    process.env.PATH = '';
    await waitForMemory({ vm: 0, vmReserve: 0, host: 0, hostReserve: 0 }, {
      env: qaEnv, deadline: Date.now() + 2000, announce: () => {},
    });
  } finally { process.env.PATH = previous; }
  let now = 0;
  await expect(waitForMemory({ vm: 0, vmReserve: 0, host: 4 * GiB, hostReserve: 8 * GiB }, {
    env: qaEnv, deadline: 10, now: () => now, sleep: async ms => { now += ms; }, pollMs: 10, announce: () => {},
    read: async () => ({ vmTotal: 0, vmUsed: 0, hostAvailable: 11 * GiB }),
  })).rejects.toThrow('host needs 4.00 GiB + 8.00 GiB reserve, available 11.00 GiB');
});

test('memory readings sum actual container use, use Docker VM total and host MemAvailable', () => {
  const stats = [JSON.stringify({ MemUsage: '2GiB / 7GiB' }), JSON.stringify({ MemUsage: '512MiB / 2GiB' })].join('\n');
  expect(parseMemoryReading(String(24 * GiB), stats, 'MemFree: 1 kB\nMemAvailable: 10485760 kB\n'))
    .toEqual({ vmTotal: 24 * GiB, vmUsed: 2.5 * GiB, hostAvailable: 10 * GiB });
  expect(parseMemoryReading(String(GiB), '', 'MemAvailable: 1024 kB').vmUsed).toBe(0);
  expect(memoryBytes('128m')).toBe(128 * 1024 ** 2);
  expect(memoryBytes('410.8MiB')).toBe(410.8 * 1024 ** 2);
  expect(memoryBytes('1MB')).toBe(1_000_000);
  expect(() => parseMemoryReading('0', '', 'MemAvailable: 1024 kB')).toThrow('Cannot read');
  expect(() => parseMemoryReading(String(GiB), '{}', 'MemAvailable: 1024 kB')).toThrow('container memory');
  expect(() => memoryBytes('unknown')).toThrow('Invalid memory size');
});

for (const short of ['vm', 'host'] as const) {
  test(`memory admission waits while ${short} is short, then admits at the boundary`, async () => {
    let now = 0, reads = 0;
    const messages: string[] = [];
    await waitForMemory(need, {
      env: qaEnv, deadline: 30, now: () => now, sleep: async ms => { now += ms; }, pollMs: 10,
      announce: message => messages.push(message),
      read: async () => {
        reads++;
        return { ...plenty,
          ...(short === 'vm' ? { vmUsed: plenty.vmTotal - need.vm + (reads === 1 ? 1 : 0) }
            : { hostAvailable: need.host + need.hostReserve - (reads === 1 ? 1 : 0) }),
        };
      },
    });
    expect(now).toBe(10);
    expect(reads).toBe(2);
    expect(messages[0]).toContain('Waiting; QA memory: Docker VM needs 5.38 GiB');
    expect(messages[0]).toContain('free ');
    expect(messages[0]).toContain('host needs 1.00 GiB + 8.00 GiB reserve, available ');
    expect(messages[1]).toStartWith('Admitted;');
  });
}

test('memory waits publish their reason for Goal status and clear it on admission', async () => {
  const dir = mkdtempSync(join(scratch, 'qa-memory-wait-status-'));
  let now = 0, reads = 0;
  const messages: string[] = [];
  const env = { ...qaEnv, GOAL_ID: 'program', GOAL_QA_COMMAND: 'bun test selected', GOAL_QA_WAIT_DIR: dir };
  try {
    await waitForMemory(need, { env, deadline: 20, now: () => now, pollMs: 5,
      sleep: async ms => {
        const files = readdirSync(dir).filter(name => name.endsWith('.json'));
        expect(files).toHaveLength(1);
        const wait = JSON.parse(readFileSync(join(dir, files[0]!), 'utf8')) as {
          pid: number; goal: string; command: string; waitingFor: string; message: string;
        };
        expect(wait).toMatchObject({ pid: process.pid, goal: 'program', command: 'bun test selected', waitingFor: 'memory' });
        expect(wait.message).toContain('Waiting; QA memory:');
        now += ms;
      },
      announce: message => messages.push(message),
      read: async () => ++reads === 1 ? { ...plenty, vmUsed: plenty.vmTotal } : plenty,
    });
    expect(messages[0]).toContain('Waiting; QA memory:');
    expect(messages[1]).toStartWith('Admitted;');
    expect(readdirSync(dir)).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('memory admission deadline reports both shortages and never admits late readings', async () => {
  let now = 0;
  const messages: string[] = [];
  await expect(waitForMemory(need, {
    env: qaEnv, deadline: 25, now: () => now, sleep: async ms => { now += ms; }, pollMs: 10,
    announce: message => messages.push(message), read: async () => ({ ...plenty, vmUsed: 24 * GiB, hostAvailable: GiB }),
  })).rejects.toThrow('Docker VM needs 5.38 GiB + 0.00 GiB reserve, free 0.00 GiB; host needs 1.00 GiB + 8.00 GiB reserve, available 1.00 GiB');
  expect(now).toBe(25);
  expect(messages.every(message => message.startsWith('Waiting;'))).toBe(true);
  now = 0;
  await expect(waitForMemory(need, { env: qaEnv, deadline: 10, now: () => now, announce: () => {},
    read: async remaining => { expect(remaining).toBe(10); now = 10; return plenty; },
  })).rejects.toThrow('deadline reached');
});

test('memory admission waits without a reading and admits only a measured one', async () => {
  let now = 0, reads = 0;
  const messages: string[] = [];
  await waitForMemory(need, {
    env: qaEnv, deadline: 30, now: () => now, sleep: async ms => { now += ms; }, pollMs: 10,
    announce: message => messages.push(message),
    read: async () => {
      if (++reads === 1) throw new Error('no reading yet');
      return plenty;
    },
  });
  expect(messages[0]).toContain('free unknown');
  expect(messages[0]).toContain('available unknown');
  expect(messages[1]).toBe('Admitted; ' + measuredAdmissionMessage(need, plenty));
  expect(messages[1]).toContain('free 19.00 GiB');
  expect(messages[1]).not.toContain('unknown');
  expect(measuredAdmissionMessage(need, plenty)).not.toContain('unknown');
  expect(() => measuredAdmissionMessage(need, { vmTotal: Number.NaN, vmUsed: 0, hostAvailable: 1 }))
    .toThrow('Invalid memory reading');
});

test('unavailable readings fail closed, retry and retain the reason at the deadline', async () => {
  let now = 0, reads = 0;
  const messages: string[] = [];
  const options = { env: qaEnv, deadline: 15, now: () => now, sleep: async (ms: number) => { now += ms; }, pollMs: 10,
    announce: (message: string) => messages.push(message) };
  await waitForMemory(need, { ...options, read: async () => {
    if (++reads === 1) throw new Error('Docker unavailable');
    return plenty;
  } });
  expect(messages[0]).toContain('free unknown; host needs');
  expect(messages[0]).toContain('Docker unavailable');
  now = 0;
  await expect(waitForMemory(need, { ...options, read: async () => { throw new Error('Docker unavailable'); } }))
    .rejects.toThrow('measurement failed: Docker unavailable; no work started');
  expect(now).toBe(15);
});

for (const outcome of ['retry', 'failed', 'late'] as const) {
  test(`startup slot ${outcome} preserves the deadline and fresh admission without locking waits`, async () => {
    const directory = mkdtempSync(join(scratch, 'qa-startup-slot-'));
    const path = join(directory, 'gate.json'), lockFile = join(directory, 'mutex.sqlite');
    const token = 'startup-test';
    writeFileSync(path, JSON.stringify({ token, status: 'pending' }));
    let now = 0, reads = 0, attempts = 0, started = false, unlocked = false;
    const options = { env: { ...qaEnv, REZICS_QA_STARTUP_SLOT_GATE: path }, lockFile,
      deadline: 100, now: () => now, pollMs: 5,
      read: async () => { reads++; return plenty; },
      sleep: async (ms: number) => {
        now = outcome === 'late' ? 100 : now + ms;
        if (ms === 5) {
          const competitor = new Database(lockFile);
          try { competitor.exec('BEGIN IMMEDIATE'); competitor.exec('ROLLBACK'); unlocked = true; }
          finally { competitor.close(true); }
        }
      },
      announce: (message: string) => {
        const match = /^QA_STARTUP_SLOT_READY (\S+) (\S+) (\d+)$/.exec(message);
        if (!match) return;
        attempts++;
        if (outcome === 'late') now = 100;
        const competitor = new Database(lockFile);
        try { expect(() => competitor.exec('BEGIN IMMEDIATE')).toThrow(); }
        finally { competitor.close(true); }
        writeFileSync(path, JSON.stringify({ token, requester: match[2], sequence: Number(match[3]),
          status: outcome === 'retry' && attempts === 1 ? 'retry' : outcome === 'failed' ? 'failed' : 'granted',
          error: 'slot allocation failed' }));
      },
    };
    try {
      const work = withMemoryStartup(need, options, () => { started = true; return 'started'; });
      if (outcome === 'retry') {
        expect(await work).toBe('started');
        expect(reads).toBe(2);
        expect(attempts).toBe(2);
        expect(unlocked).toBe(true);
      } else {
        await expect(work).rejects.toThrow(outcome === 'failed' ? 'slot allocation failed' : 'deadline reached');
        expect(started).toBe(false);
      }
      const recovered = new Database(lockFile);
      try { recovered.exec('BEGIN IMMEDIATE'); recovered.exec('ROLLBACK'); }
      finally { recovered.close(true); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

test('a startup ignores another process grant with the same sequence', async () => {
  const directory = mkdtempSync(join(scratch, 'qa-startup-foreign-grant-'));
  const path = join(directory, 'gate.json'), lockFile = join(directory, 'mutex.sqlite');
  const token = 'startup-test';
  writeFileSync(path, JSON.stringify({ token, status: 'pending' }));
  let now = 0, started = false, requester = '';
  try {
    expect(await withMemoryStartup(need, {
      env: { ...qaEnv, REZICS_QA_STARTUP_SLOT_GATE: path }, lockFile, deadline: 100,
      now: () => now, pollMs: 25, read: async () => plenty,
      announce: message => {
        const match = /^QA_STARTUP_SLOT_READY (\S+) (\S+) (\d+)$/.exec(message);
        if (!match) return;
        requester = match[2]!;
        writeFileSync(path, JSON.stringify({ token, requester: 'another-startup',
          sequence: Number(match[3]), status: 'granted' }));
      },
      sleep: async ms => {
        expect(started).toBe(false);
        const gate = JSON.parse(readFileSync(path, 'utf8'));
        expect(gate.requester).toBe('another-startup');
        writeFileSync(path, JSON.stringify({ ...gate, requester }));
        now += ms;
      },
    }, () => { started = true; return 'started'; })).toBe('started');
    expect(now).toBe(25);
    expect(started).toBe(true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a startup requests a new acknowledgement when a sibling overwrites its slot reply', async () => {
  const directory = mkdtempSync(join(scratch, 'qa-startup-overwritten-grant-'));
  const path = join(directory, 'gate.json'), lockFile = join(directory, 'mutex.sqlite');
  const token = 'startup-test';
  writeFileSync(path, JSON.stringify({ token, status: 'pending' }));
  let now = 0;
  const sequences: number[] = [];
  try {
    expect(await withMemoryStartup(need, {
      env: { ...qaEnv, REZICS_QA_STARTUP_SLOT_GATE: path }, lockFile, deadline: 100, pollMs: 5,
      now: () => now, read: async () => plenty,
      announce: message => {
        const match = /^QA_STARTUP_SLOT_READY (\S+) (\S+) (\d+)$/.exec(message);
        if (!match) return;
        sequences.push(Number(match[3]));
        writeFileSync(path, JSON.stringify({ token, requester: sequences.length === 1 ? 'sibling-startup' : match[2],
          sequence: Number(match[3]), status: 'granted' }));
      },
      sleep: async ms => { assertStartupUnlocked(lockFile); now += ms; },
    }, () => { assertStartupUnlocked(lockFile); return 'started'; })).toBe('started');
    expect(now).toBe(5);
    expect(sequences).toHaveLength(2);
    expect(sequences[1]).toBeGreaterThan(sequences[0]!);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
