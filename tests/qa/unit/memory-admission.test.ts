import { afterAll, afterEach, expect, test } from 'bun:test';
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
import { observeChild } from '../support/child-readiness.ts';
import { processStartTime } from '../../../scripts/qa/process/identity.ts';
import { tryAcquireDirectoryLease } from '../../../scripts/qa/process/lease.ts';
import { startupChildEnvironment } from '../../../scripts/qa/stack-startup.ts';
import { qaSlotAdmission, qaWaitStatusLines } from '../../../scripts/goal/qa-slots.ts';
import { admissionCpuLimit, admissionCpuPressure, GiB, measuredAdmissionMessage, memoryBytes, parseMemoryReading, qaMemoryNeed, waitForMemory as waitForMemoryImpl,
  isLocalQaRun, qaMemoryDeadline, withMemoryStartup as withMemoryStartupImpl, withQaStackStartup,
  type MemoryReading, type MemoryWaitOptions, type StartupMemoryOptions } from '../../../scripts/qa/memory-admission.ts';

const root = resolve(import.meta.dir, '../../..');
const need = qaMemoryNeed(root, 'other', 'ordinary', {});
const loadFixture = join(root, '.temp', `qa-loadavg-${process.pid}`);
const privateSettings = mkdtempSync(join(root, '.temp', 'qa-admission-settings-'));
const qaEnv = { REZICS_STACK_PROFILE: 'qa', GOAL_QA_SLOT_DIRECTORY: join(privateSettings, 'slots'), REZICS_QA_LOADAVG_FILE: loadFixture,
  REZICS_QA_CPU_PRESSURE_FILE: `${loadFixture}-missing-pressure` };
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
writeFileSync(loadFixture, '0.00 0.00 0.00 1/1 1\n');
afterAll(() => {
  rmSync(loadFixture, { force: true });
  rmSync(privateSettings, { recursive: true, force: true });
});

const readingDirectories: string[] = [];
const readingStates: Database[] = [];
afterEach(() => {
  for (const state of readingStates.splice(0)) state.close(true);
  for (const dir of readingDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixtureMemoryState(): Database {
  const state = new Database(':memory:');
  readingStates.push(state);
  return state;
}
function waitForMemory(need: Parameters<typeof waitForMemoryImpl>[0], options: MemoryWaitOptions) {
  // Synthetic accounting uses admission's private in-memory state. Only tests
  // of file sharing or locking opt into a SQLite file explicitly.
  return waitForMemoryImpl(need, { readingMaxAgeMs: 1, ...options });
}
function withMemoryStartup<T>(need: Parameters<typeof withMemoryStartupImpl>[0], options: StartupMemoryOptions,
  start: () => T | Promise<T>) {
  return withMemoryStartupImpl(need, { readingMaxAgeMs: 1, ...options }, start);
}

for (const entry of ['wait', 'startup', 'stack'] as const) {
for (const clock of [false, true]) {
  test(`${entry} admission with an injected reader${clock ? ' and clock' : ''} leaves host state untouched and reads every poll`, async () => {
    const dir = mkdtempSync(join(scratch, 'qa-private-admission-'));
    const defaultStateFile = join(dir, 'host.sqlite');
    const sentinel = 'Host admission state must never be opened by this call';
    writeFileSync(defaultStateFile, sentinel);
    let now = 0, reads = 0, sleeps = 0, starts = 0;
    const options = { root, env: qaEnv, defaultStateFile, deadline: clock ? 30 : Date.now() + 2000,
      ...(clock ? { now: () => now } : {}), pollMs: 10, readingMaxAgeMs: 3000, announce: () => {},
      read: async () => ({ ...plenty, vmUsed: ++reads % 3 === 0 ? 0 : plenty.vmTotal }),
      sleep: async (ms: number) => { sleeps++; now += ms; } };
    try {
      // Each call owns its state; the next call must measure again even inside the sharing window.
      for (let call = 0; call < 2; call++) {
        now = 0;
        if (entry === 'wait') await waitForMemoryImpl(need, options);
        else if (entry === 'startup') await withMemoryStartupImpl(need, options, () => { starts++; });
        else await withQaStackStartup(root, qaEnv, options.deadline, () => { starts++; }, options);
        expect(readFileSync(defaultStateFile, 'utf8')).toBe(sentinel);
        expect(readdirSync(dir)).toEqual(['host.sqlite']);
        expect(reads).toBe((call + 1) * 3);
        expect(sleeps).toBe((call + 1) * 2);
      }
      expect(starts).toBe(entry === 'wait' ? 0 : 2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
}

for (const entry of ['wait', 'startup'] as const) {
  test(`${entry} admission with only an injected clock leaves host state untouched`, async () => {
    const dir = mkdtempSync(join(scratch, 'qa-private-clock-'));
    const defaultStateFile = join(dir, 'host.sqlite');
    const sentinel = 'Host state sentinel';
    writeFileSync(defaultStateFile, sentinel);
    const options = { root, env: qaEnv, defaultStateFile, deadline: 10, now: () => 0, announce: () => {} };
    const hostNeed = { vm: 0, host: 0, vmReserve: 0, hostReserve: 0 };
    try {
      if (entry === 'wait') await waitForMemoryImpl(hostNeed, options);
      else expect(await withMemoryStartupImpl(hostNeed, options, () => 'started')).toBe('started');
      expect(readFileSync(defaultStateFile, 'utf8')).toBe(sentinel);
      expect(readdirSync(dir)).toEqual(['host.sqlite']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const entry of ['wait', 'startup', 'stack'] as const) {
test(`${entry} admission without injected readings or clock uses the configured host state`, async () => {
  const dir = mkdtempSync(join(scratch, 'qa-default-state-'));
  const defaultStateFile = join(dir, 'host.sqlite');
  const hostNeed = { vm: 0, host: 0, vmReserve: 0, hostReserve: 0 };
  const options = { root, env: qaEnv, defaultStateFile, deadline: Date.now() + 2000, announce: () => {} };
  try {
    if (entry === 'wait') await waitForMemoryImpl(hostNeed, options);
    else if (entry === 'startup') await withMemoryStartupImpl(hostNeed, options, () => {});
    else await withQaStackStartup(root, qaEnv, options.deadline, () => {}, { ...options, services: [] });
    const db = new Database(defaultStateFile);
    try { expect(db.query('SELECT * FROM memory_readings').all()).toHaveLength(1); }
    finally { db.close(true); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
}

for (const activeMs of [240_000, 400_000]) {
test(`a restore reports five minutes of admission separately and qualifies ${activeMs} ms of active work`, async () => {
  const dir = mkdtempSync(join(scratch, 'qa-restore-timing-'));
  let now = 0;
  const budget = new FixtureWorkBudget(600_000, () => now);
  try {
    await startRestoredFixture(budget, { ...qaEnv, REZICS_QA_MEMORY_DEADLINE: '1000000' },
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
    writeFileSync(join(dir, 'infra', 'dev', 'compose.qa-resources.yaml'), readFileSync(join(root, 'infra', 'dev', 'compose.qa-resources.yaml')));
    let now = 0, reads = 0, started = false;
    await expect(withQaStackStartup(dir, { ...qaEnv, REZICS_FUSEKI_MEMORY_LIMIT: '2g' }, 10,
      () => { started = true; }, { lockFile, now: () => now, pollMs: 10,
        sleep: async ms => { now += ms; }, announce: () => {},
        read: async () => { reads++; return { ...plenty, vmUsed: plenty.vmTotal }; },
      })).rejects.toThrow('free 0.00 GiB');
    expect(started).toBe(false);
    expect(reads).toBe(1);
    expect(now).toBe(10);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('synthetic startup ignores discovered Goal concurrency and CPU settings', async () => {
  const directory = mkdtempSync(join(scratch, 'qa-synthetic-settings-'));
  const settings = join(directory, '.temp', 'goal-orchestration');
  mkdirSync(join(settings, 'qa-slots'), { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: directory });
  writeFileSync(join(settings, 'qa-startup-concurrency'), '99');
  writeFileSync(join(settings, 'qa-load-limit'), '0');
  writeFileSync(join(settings, 'qa-cpu-pressure-limit'), '0');
  let starts = 0;
  const held = deferred<void>();
  const admitted = deferred<void>();
  const options = { root: directory, env: { REZICS_STACK_PROFILE: 'qa' },
    state: fixtureMemoryState(), deadline: 10, now: () => 0,
    read: async () => plenty, announce: () => {},
    sleep: async () => { throw new Error('Synthetic startup reached private wait'); } };
  let first: Promise<void> | undefined;
  try {
    expect(await admissionCpuLimit(options, false)).toBe(1);
    expect(await admissionCpuLimit(options, true)).toBe(12);
    first = withMemoryStartupImpl(need, options, async () => { starts++; admitted.resolve(); await held.promise; });
    await admitted.promise;
    await expect(withMemoryStartupImpl(need, options, () => { starts++; }))
      .rejects.toThrow('Synthetic startup reached private wait');
    expect(starts).toBe(1);
    expect(readdirSync(settings).sort()).toEqual(['qa-cpu-pressure-limit', 'qa-load-limit', 'qa-slots', 'qa-startup-concurrency']);
  } finally { held.resolve(); await first; rmSync(directory, { recursive: true, force: true }); }
});

test('startup preserves a measurement deadline failure on a fresh database', async () => {
  const state = fixtureMemoryState();
  let now = 0, identities = 0, reads = 0, starts = 0;
  await expect(withMemoryStartupImpl(need, {
    env: qaEnv, state, deadline: 10, now: () => now, announce: () => {},
    startTime: pid => { if (++identities === 2) now = 10; return processStartTime(pid); },
    read: async () => { reads++; return plenty; },
  }, () => { starts++; })).rejects.toThrow('measurement failed: Memory measurement deadline reached');
  expect(reads).toBe(0);
  expect(starts).toBe(0);
  expect(state.query('SELECT generation FROM memory_generation').all()).toEqual([{ generation: 0 }]);
  expect(state.query('SELECT * FROM startup_waiters').all()).toEqual([]);
});

test('independent QA processes measure after the preceding startup and wait for its memory to clear', async () => {
  const dir = mkdtempSync(join(scratch, 'qa-memory-processes-'));
  const script = join(dir, 'startup.ts');
  writeFileSync(join(dir, 'used'), String(18 * GiB));
  writeFileSync(join(dir, 'clock'), '0');
  writeFileSync(script, `
    import { withMemoryStartup } from ${JSON.stringify(join(root, 'scripts/qa/memory-admission.ts'))};
    import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const [dir, name] = process.argv.slice(2);
    writeFileSync(join(dir, name + '-ready'), 'ready');
    while (!existsSync(join(dir, name + '-arm'))) await Bun.sleep(5);
    await withMemoryStartup(${JSON.stringify(need)}, {
      env: { ...${JSON.stringify(qaEnv)}, GOAL_QA_SLOT_DIRECTORY: join(dir, 'qa-slots') },
      deadline: 10_000, now: () => Number(readFileSync(join(dir, 'clock'), 'utf8')),
      lockFile: join(dir, 'mutex.sqlite'), pollMs: 5,
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
    const firstProbe = observeChild(first);
    await firstProbe.ready(join(dir, 'first-ready'));
    // Deliberately hold startup behind a parent-controlled barrier.
    expect(existsSync(join(dir, 'mutex.sqlite'))).toBe(false);
    writeFileSync(join(dir, 'first-arm'), 'armed');
    await firstProbe.ready(join(dir, 'first-started'));
    const second = Bun.spawn(['bun', script, dir, 'second'], { stdout: 'pipe', stderr: 'pipe' });
    children.push(second);
    const secondProbe = observeChild(second);
    await secondProbe.ready(join(dir, 'second-ready'));
    writeFileSync(join(dir, 'second-arm'), 'armed');
    await secondProbe.ready(join(dir, 'second-queued'));
    expect(existsSync(join(dir, 'second-started'))).toBe(false);
    writeFileSync(join(dir, 'release'), 'ready');
    await firstProbe.exit(0);
    await secondProbe.ready(join(dir, 'second-short'));
    expect(existsSync(join(dir, 'second-started'))).toBe(false);
    expect(readFileSync(join(dir, 'reads'), 'utf8')).toContain(`second:${21 * GiB}`);
    writeFileSync(join(dir, 'used'), String(18 * GiB));
    // Expire the shared reading by advancing the simulated clock, not by sleeping.
    writeFileSync(join(dir, 'clock'), '3000');
    await secondProbe.exit(0);
    expect(existsSync(join(dir, 'second-started'))).toBe(true);
  } finally {
    for (const child of children) { child.kill(); await child.exited; }
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

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
    const defaultStateFile = join(dir, 'host.sqlite');
    const clockFile = join(dir, 'clock');
    writeFileSync(clockFile, '1000');
    writeFileSync(defaultStateFile, 'Host state sentinel');
    writeFileSync(script, `
      import { waitForMemory } from ${JSON.stringify(join(root, 'scripts/qa/memory-admission.ts'))};
      import { appendFileSync, readFileSync } from 'node:fs';
      await waitForMemory(${JSON.stringify(need)}, {
        env: ${JSON.stringify(qaEnv)}, lockFile: ${JSON.stringify(join(dir, 'state.sqlite'))},
        defaultStateFile: ${JSON.stringify(defaultStateFile)},
        deadline: 5000, now: () => Number(readFileSync(${JSON.stringify(clockFile)}, 'utf8')), readingMaxAgeMs: 3000,
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
      // Scheduling never expires the cache; the next wave observes its exact boundary.
      writeFileSync(clockFile, '4000');
      await wave(2);
      expect(readFileSync(join(dir, 'readings'), 'utf8').trim().split('\n')).toHaveLength(2);
      expect(readFileSync(defaultStateFile, 'utf8')).toBe('Host state sentinel');
    } finally {
      for (const child of children) { child.kill(); await child.exited; }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
}

for (const fails of [false, true]) {
test(`a rolled-back measurement claim waits for SQLite readers before a ${fails ? 'failed' : 'successful'} measurement`, async () => {
  const directory = mkdtempSync(join(scratch, 'qa-reading-commit-'));
  readingDirectories.push(directory);
  const lockFile = join(directory, 'state.sqlite');
  let now = 0, reads = 0, locked = false, readWhileLocked = false;
  const options = { env: qaEnv, lockFile, deadline: 1000, readingMaxAgeMs: 0,
    now: () => now, announce: () => {} };
  await waitForMemoryImpl(need, { ...options, read: async () => plenty });
  const competitor = new Database(lockFile);
  try {
    competitor.exec('BEGIN');
    competitor.query('SELECT * FROM memory_readings').all();
    locked = true;
    const lines: string[] = [];
    await expect(waitForMemoryImpl(need, { ...options,
      read: async () => {
        reads++;
        readWhileLocked ||= locked;
        if (fails) throw new Error('Docker measurement unavailable');
        return { ...plenty, vmUsed: plenty.vmTotal };
      },
      sleep: async ms => {
        if (locked) { competitor.exec('ROLLBACK'); locked = false; }
        now += ms;
      },
      announce: message => { lines.push(message); throw new Error('observed'); },
    })).rejects.toThrow('observed');
    expect(readWhileLocked).toBe(false);
    expect(reads).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(fails ? 'measurement failed: Docker measurement unavailable' : 'free 0.00 GiB');
  } finally {
    if (locked) competitor.exec('ROLLBACK');
    competitor.close(true);
  }
});
}

test('a dead measuring process leaves its turn to the next waiter', async () => {
  const dir = mkdtempSync(join(scratch, 'qa-reading-death-'));
  const lockFile = join(dir, 'state.sqlite'), ready = join(dir, 'measuring'), script = join(dir, 'measure.ts');
  writeFileSync(script, `
    import { waitForMemory } from ${JSON.stringify(join(root, 'scripts/qa/memory-admission.ts'))};
    import { writeFileSync } from 'node:fs';
    await waitForMemory(${JSON.stringify(need)}, {
      env: ${JSON.stringify(qaEnv)}, lockFile: ${JSON.stringify(lockFile)}, deadline: 100, now: () => 0,
      read: async () => { writeFileSync(${JSON.stringify(ready)}, 'ready');
        await new Promise(() => { setInterval(() => {}, 1000); }); return ${JSON.stringify(plenty)}; },
    });
  `);
  const child = Bun.spawn(['bun', script], { stdout: 'pipe', stderr: 'pipe' });
  const probe = observeChild(child);
  try {
    await probe.ready(ready);
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
    // One poll reaches the deadline after the invalidated reading is replaced.
    now: () => now, deadline: 3100, pollMs: 100, sleep: async (ms: number) => { now += ms; }, announce: () => {} };
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
        deadline: 100, now: () => 0, announce: () => {}, read: async () => (${JSON.stringify(plenty)}) }, async () => {
        writeFileSync(${JSON.stringify(ready)}, 'held');
        await new Promise(() => { setInterval(() => {}, 1000); });
      });
    `);
    const child = Bun.spawn(['bun', script], { stdout: 'pipe', stderr: 'pipe' });
    const probe = observeChild(child);
    try {
      await probe.ready(ready);
      child.kill(signal);
      await child.exited;
      expect(await withMemoryStartup(need, { env: qaEnv, lockFile, deadline: Date.now() + 5000,
        announce: () => {}, read: async () => plenty }, () => 'recovered')).toBe('recovered');
    } finally { child.kill(); await child.exited; rmSync(dir, { recursive: true, force: true }); }
  }
}, 60_000);

test('each source and restore target startup receives a fresh reading and its inherited deadline', async () => {
  const dir = mkdtempSync(join(scratch, 'qa-memory-children-'));
  let now = 0, used = 0, reads = 0;
  const starts: string[] = [];
  const env = { ...qaEnv, REZICS_QA_MEMORY_DEADLINE: '25' };
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

test('a slot-less startup stays outside the startup queue until lifetime-slot holders drain', async () => {
  const directory = mkdtempSync(join(scratch, 'qa-startup-slot-inversion-'));
  readingDirectories.push(directory);
  const slots = join(directory, 'slots');
  mkdirSync(slots);
  const state = fixtureMemoryState();
  const gate = join(directory, 'gate.json');
  writeFileSync(gate, JSON.stringify({ token: 'slot-inversion', status: 'pending' }));
  let now = 100, stop = false;
  const env = { ...qaEnv, GOAL_ID: 'program', GOAL_QA_SLOT_DIRECTORY: slots };
  const leases = [0, 1].map(slot => {
    const lease = tryAcquireDirectoryLease(join(slots, String(slot)));
    if (lease === 'held') throw new Error('private slot already held');
    return lease;
  });
  const ticket = qaSlotAdmission(slots, 2, { env, now: () => now, workerGoals: () => [] });
  const blocked = deferred<void>(), wake = deferred<void>();
  const starts: string[] = [];
  const options = { env, state, deadline: 1000, now: () => now, pollMs: 5,
    read: async () => plenty, announce: () => {} };
  const head = withMemoryStartupImpl(need, { ...options,
    env: { ...env, GOAL_IN_SLOT: '0', REZICS_QA_STARTUP_SLOT_GATE: gate },
    announce: message => {
      const match = /^QA_STARTUP_SLOT_READY (\S+) (\S+) (\d+)$/.exec(message);
      if (!match) return;
      const lease = ticket.acquire(0);
      if (lease !== 'held') leases.push(lease);
      writeFileSync(gate, JSON.stringify({ token: match[1], requester: match[2], sequence: Number(match[3]),
        status: lease === 'held' ? 'retry' : 'granted' }));
    },
    sleep: async ms => { blocked.resolve(); await wake.promise; if (stop) throw new Error('test cleanup'); now += ms; },
  }, () => { starts.push('slot-less'); });
  const result = head.catch(error => error as Error);
  try {
    await blocked.promise;
    // No promise and no queue head may belong to a request that cannot own a slot.
    const tables = state.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    if (tables.some(table => table.name === 'startup_waiters'))
      expect(state.query('SELECT id FROM startup_waiters').all()).toHaveLength(0);
    for (const [id, lease] of leases.slice().entries()) {
      await withMemoryStartupImpl(need, { ...options, env: { ...env, GOAL_IN_SLOT: '1' } }, () => {
        starts.push(`holder-${id}`); lease.release();
      });
    }
    wake.resolve();
    expect(await result).toBeUndefined();
    expect(starts).toEqual(['holder-0', 'holder-1', 'slot-less']);
    expect(state.query('SELECT id FROM startup_waiters').all()).toHaveLength(0);
    expect(state.query('SELECT id FROM startup_promises WHERE completed = 0').all()).toHaveLength(0);
  } finally {
    stop = true; wake.resolve(); await result;
    ticket.release(); for (const lease of leases) lease.release();
  }
});

test('sixteen lifetime-slot holders advance past an older startup awaiting its slot', async () => {
  const directory = mkdtempSync(join(scratch, 'qa-startup-slot-order-'));
  readingDirectories.push(directory);
  const gate = join(directory, 'gate.json');
  writeFileSync(gate, JSON.stringify({ token: 'waiting-for-lifetime-slot', status: 'pending' }));
  const blocked = deferred<void>(), releaseHead = deferred<void>();
  let now = 0, stop = false;
  const options = { env: { ...qaEnv, GOAL_QA_SLOT_DIRECTORY: join(directory, 'qa-slots') },
    state: fixtureMemoryState(), deadline: 100, now: () => now, read: async () => plenty, announce: () => {} };
  const head = withMemoryStartupImpl(need, { ...options,
    env: { ...options.env, GOAL_IN_SLOT: '0', REZICS_QA_STARTUP_SLOT_GATE: gate },
    sleep: async () => { blocked.resolve(); await releaseHead.promise; },
  }, () => { throw new Error('the pending slot must not start'); });
  const headResult = head.catch(error => error as Error);
  await blocked.promise;
  const sleeps: ReturnType<typeof deferred<void>>[] = [];
  const starts: number[] = [];
  const holders = Array.from({ length: 16 }, (_, id) => withMemoryStartupImpl(need, { ...options,
    env: { ...options.env, GOAL_IN_SLOT: '1' },
    sleep: async () => {
      if (stop) throw new Error('test cleanup');
      const wake = deferred<void>(); sleeps.push(wake); await wake.promise;
      if (stop) throw new Error('test cleanup');
    },
  }, () => { starts.push(id); }).catch(error => error as Error));
  try {
    // Advance only the cooperative waiters; elapsed host time cannot grant the head a slot.
    for (let round = 0; round < 200 && starts.length < 16; round++) {
      if (sleeps.length === 16 && starts.length === 0) break;
      for (const wake of sleeps.splice(0)) wake.resolve();
      await Promise.resolve();
    }
    expect(starts).toHaveLength(16);
    expect(new Set(starts).size).toBe(16);
    expect(JSON.parse(readFileSync(gate, 'utf8')).status).toBe('pending');
  } finally {
    stop = true;
    for (const wake of sleeps.splice(0)) wake.resolve();
    now = 100; releaseHead.resolve();
    await Promise.all(holders);
    expect((await headResult).message).toContain('deadline reached');
  }
});

test('slot arrival order survives children reaching startup admission in reverse order', async () => {
  const scenario = pressureScenario();
  const waiting = [deferred<void>(), deferred<void>()];
  const release = deferred<void>();
  const order: number[] = [];
  const runs: Promise<void>[] = [];
  try {
    for (const id of [1, 0]) {
      const env = { ...scenario.options.env, GOAL_IN_SLOT: '1',
        GOAL_QA_ARRIVED_AT: new Date(id).toISOString(), GOAL_QA_ARRIVAL_SEQUENCE: String(id).padStart(24, '0') };
      const ticket = qaSlotAdmission(join(scenario.directory, 'qa-slots'), 2, { env, workerGoals: () => [] });
      const lease = ticket.acquire(id);
      ticket.release();
      if (lease === 'held') throw new Error('private lifetime slot was not admitted');
      const run = withMemoryStartupImpl(need, { ...scenario.options, env,
        sleep: async ms => { waiting[id]!.resolve(); await release.promise; scenario.advance(ms); },
      }, () => { order.push(id); }).finally(() => lease.release());
      runs.push(run);
      await waiting[id]!.promise;
    }
    scenario.setPressure(0); release.resolve();
    await Promise.all(runs);
    expect(order).toEqual([0, 1]);
  } finally { scenario.setPressure(0); release.resolve(); await Promise.all(runs); }
});

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

test('a younger startup requests no lifetime lease while an older ready head waits for processor pressure', async () => {
  const scenario = pressureScenario();
  const gate = join(scenario.directory, 'gate.json');
  writeFileSync(gate, JSON.stringify({ token: 'younger-lifetime-slot', status: 'pending' }));
  const olderWaiting = deferred<void>(), releaseOlder = deferred<void>();
  const youngerWaiting = deferred<void>(), releaseYounger = deferred<void>();
  let requests = 0, olderStarted = false, requestedBeforeOlder = false, firstSleep = true;
  const older = withMemoryStartupImpl(need, { ...scenario.options,
    sleep: async ms => { olderWaiting.resolve(); await releaseOlder.promise; scenario.advance(ms); },
  }, () => { olderStarted = true; });
  const olderResult = older.catch(error => error as Error);
  await olderWaiting.promise;
  const younger = withMemoryStartupImpl(need, { ...scenario.options,
    env: { ...scenario.options.env, GOAL_IN_SLOT: '0', REZICS_QA_STARTUP_SLOT_GATE: gate },
    announce: message => {
      const match = /^QA_STARTUP_SLOT_READY (\S+) (\S+) (\d+)$/.exec(message);
      if (!match) return;
      requests++;
      requestedBeforeOlder ||= !olderStarted;
      writeFileSync(gate, JSON.stringify({ token: match[1], requester: match[2],
        sequence: Number(match[3]), status: 'granted' }));
    },
    sleep: async ms => {
      if (firstSleep) { firstSleep = false; youngerWaiting.resolve(); await releaseYounger.promise; }
      scenario.advance(ms);
    },
  }, () => {});
  const youngerResult = younger.catch(error => error as Error);
  try {
    await youngerWaiting.promise;
    expect(requests).toBe(0);
    expect(JSON.parse(readFileSync(gate, 'utf8')).status).toBe('pending');
    scenario.setPressure(0); releaseOlder.resolve();
    expect(await olderResult).toBeUndefined();
    releaseYounger.resolve();
    expect(await youngerResult).toBeUndefined();
    expect(requests).toBe(1);
    expect(requestedBeforeOlder).toBe(false);
  } finally {
    scenario.setPressure(0);
    releaseOlder.resolve(); releaseYounger.resolve();
    await Promise.all([olderResult, youngerResult]);
  }
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

test('startup children inherit an actual parent lifetime lease despite a stale slot flag', async () => {
  const directory = mkdtempSync(join(scratch, 'qa-startup-inherited-slot-'));
  readingDirectories.push(directory);
  const slots = join(directory, 'qa-slots');
  mkdirSync(slots);
  const env = { ...qaEnv, GOAL_QA_SLOT_DIRECTORY: slots, GOAL_IN_SLOT: '0',
    REZICS_QA_STARTUP_SLOT_GATE: join(directory, 'provisional-gate.json') };
  const child = Bun.spawn(['bun', '-e', 'setInterval(() => {}, 1000)'], { stdout: 'ignore', stderr: 'ignore' });
  const parentLease = tryAcquireDirectoryLease(join(slots, '0'));
  if (parentLease === 'held') throw new Error('private parent slot was already held');
  try {
    const inherited = startupChildEnvironment(env, child.pid);
    expect(inherited.GOAL_IN_SLOT).toBe('1');
    expect(inherited.REZICS_QA_STARTUP_SLOT_GATE).toBeUndefined();
    expect(env.GOAL_IN_SLOT).toBe('0');
    expect(env.REZICS_QA_STARTUP_SLOT_GATE).toBeDefined();
    parentLease.release();
    expect(startupChildEnvironment(env, child.pid)).toEqual(env);
    const unrelatedLease = tryAcquireDirectoryLease(join(slots, '1'), { pid: child.pid });
    if (unrelatedLease === 'held') throw new Error('private unrelated slot was already held');
    try { expect(startupChildEnvironment(env)).toEqual(env); }
    finally { unrelatedLease.release(); }
  } finally {
    parentLease.release(); child.kill(); await child.exited;
  }
});

function loadScenario() {
  const directory = mkdtempSync(join(scratch, 'qa-load-admission-'));
  readingDirectories.push(directory);
  const loadFile = join(directory, 'loadavg');
  writeFileSync(loadFile, '85.0 90.0 95.0 1/1 1\n');
  const waiters = join(directory, 'qa-slots', 'waiters');
  const lines: string[] = [];
  let clock = 0;
  const options: StartupMemoryOptions = {
    env: { ...qaEnv, GOAL_QA_SLOT_DIRECTORY: join(directory, 'qa-slots'), GOAL_QA_WAIT_DIR: waiters,
      GOAL_QA_COMMAND: 'integration run', REZICS_QA_LOADAVG_FILE: loadFile },
    state: fixtureMemoryState(), processors: 64, deadline: 100_000,
    now: () => clock, pollMs: 1000, readingMaxAgeMs: 1,
    startTime: pid => String(pid),
    read: async () => plenty, announce: message => { lines.push(message); },
    sleep: async ms => { clock += ms; },
  };
  return { directory, loadFile, waiters, lines, options, now: () => clock,
    advance: (ms: number) => { clock += ms; } };
}

test('an unchanged startup head is named at ten minutes despite a failed reading and dead status is removed', async () => {
  const scenario = pressureScenario();
  const slots = join(scenario.directory, 'qa-slots');
  let sleeps = 0, failed = false;
  await withMemoryStartupImpl(need, { ...scenario.options,
    deadline: 700_000, pollMs: 599_999,
    env: { ...scenario.options.env, GOAL_ID: 'head-goal' },
    read: async () => {
      if (scenario.now() === 599_999 && !failed) { failed = true; throw new Error('transient Docker read'); }
      return plenty;
    },
    sleep: async ms => {
      const files = readdirSync(scenario.waiters);
      expect(files).toHaveLength(1);
      const status = JSON.parse(readFileSync(join(scenario.waiters, files[0]!), 'utf8'));
      expect(status.headSince).toBe(new Date(0).toISOString());
      if (++sleeps === 1) {
        const before = qaWaitStatusLines(slots, pid => pid === process.pid, () => 599_999);
        expect(before).toHaveLength(1);
        expect(before[0]).toContain(`QA waiting for load: Goal head-goal (pid ${process.pid}): integration run`);
        expect(before[0]).not.toContain('startup queue head has not advanced');
        scenario.advance(ms);
      } else {
        expect(status.message).toContain('measurement failed: transient Docker read');
        const after = qaWaitStatusLines(slots, pid => pid === process.pid, () => 600_000);
        expect(after[0]).toContain('startup queue head has not advanced for 10 minutes');
        expect(qaWaitStatusLines(slots, () => false, () => 600_000)).toEqual([]);
        expect(readdirSync(scenario.waiters)).toEqual([]);
        scenario.advance(1); scenario.setPressure(0);
      }
    },
  }, () => { expect(scenario.now()).toBe(600_000); });
  expect(sleeps).toBe(2);
});

test('a stack waits above the processor load limit, publishes its command and admits below it', async () => {
  const scenario = loadScenario();
  await withMemoryStartupImpl(need, { ...scenario.options, sleep: async ms => {
    const files = readdirSync(scenario.waiters);
    expect(files).toHaveLength(1);
    expect(files[0]).toStartWith('load-');
    expect(JSON.parse(readFileSync(join(scenario.waiters, files[0]!), 'utf8'))).toMatchObject({
      command: 'integration run', waitingFor: 'load',
    });
    scenario.advance(ms);
    writeFileSync(scenario.loadFile, '63.0 90.0 95.0 1/1 1\n');
  } }, () => { expect(scenario.now()).toBe(1000); });
  expect(readdirSync(scenario.waiters)).toEqual([]);
  expect(scenario.lines.at(-1)).toContain('63.00 / 64 processors');
  expect(scenario.lines.at(-1)).toContain('waited 1.0 seconds for load');
});

test('load waiters retain arrival order and start at least twenty seconds apart even at startup concurrency three', async () => {
  const scenario = loadScenario();
  writeFileSync(join(scenario.directory, 'qa-startup-concurrency'), '3');
  const starts: { id: number; at: number }[] = [];
  await Promise.all([0, 1, 2].map(id => withMemoryStartupImpl(need, {
    ...scenario.options, pollMs: 5000, sleep: async ms => {
      scenario.advance(ms);
      if (scenario.now() >= 3000) writeFileSync(scenario.loadFile, '32.0 0 0 1/1 1\n');
    },
  }, () => { starts.push({ id, at: scenario.now() }); })));
  expect(starts.map(start => start.id)).toEqual([0, 1, 2]);
  expect(starts[1]!.at - starts[0]!.at).toBeGreaterThanOrEqual(20_000);
  expect(starts[2]!.at - starts[1]!.at).toBeGreaterThanOrEqual(20_000);
});

test('a load waiter starts at the memory deadline and logs it, while a memory shortage still refuses startup', async () => {
  const scenario = loadScenario();
  const options = { ...scenario.options, deadline: 2500 };
  await withMemoryStartupImpl(need, options, () => { expect(scenario.now()).toBe(2500); });
  expect(scenario.lines.at(-1)).toContain('waited 2.5 seconds for load; load deadline reached, starting');
  await expect(withMemoryStartupImpl(need, { ...options, deadline: 5000,
    read: async () => ({ ...plenty, hostAvailable: 0 }) }, () => { throw new Error('must not start'); }))
    .rejects.toThrow('Memory admission deadline reached');
});

test('unit admission and a startup with no stack never inspect load', async () => {
  const scenario = loadScenario();
  const hostNeed = { ...need, vm: 0, vmReserve: 0 };
  const options = { ...scenario.options, readLoad: () => { throw new Error('unit inspected load'); } };
  await waitForMemoryImpl(hostNeed, options);
  await withMemoryStartupImpl(hostNeed, options, () => { expect(scenario.now()).toBe(0); });
});

function pressureScenario(pressure = 12) {
  const scenario = loadScenario();
  const pressureFile = join(scenario.directory, 'cpu-pressure');
  const setPressure = (value: number) => writeFileSync(pressureFile,
    `some avg10=${value.toFixed(2)} avg60=99.00 avg300=99.00 total=123456\n`);
  setPressure(pressure);
  return { ...scenario, pressureFile, setPressure, options: { ...scenario.options, pollMs: 5000,
    env: { ...scenario.options.env, REZICS_QA_CPU_PRESSURE_FILE: pressureFile } } };
}

test('a stack holds at the CPU pressure limit and releases below it regardless of load or avg60', async () => {
  const scenario = pressureScenario();
  writeFileSync(join(scenario.directory, 'qa-load-limit'), '1');
  await withMemoryStartupImpl(need, { ...scenario.options, sleep: async ms => {
    const files = readdirSync(scenario.waiters);
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(scenario.waiters, files[0]!), 'utf8')).message)
      .toContain('CPU pressure some avg10 12.00%, limit 12%, recent starts 0');
    scenario.advance(ms);
    scenario.setPressure(11.99);
  } }, () => { expect(scenario.now()).toBe(5000); });
  expect(scenario.lines.at(-1)).toContain('CPU pressure some avg10 11.99%, limit 12%');
  expect(readdirSync(scenario.waiters)).toEqual([]);
});

test('an immediate pressure admission still counts after startup completes until its thirty-second window passes', async () => {
  const scenario = pressureScenario(0);
  const options = { ...scenario.options,
    read: async () => ({ ...plenty, vmUsed: plenty.vmTotal - need.vm }) };
  await withMemoryStartupImpl(need, options, () => { expect(scenario.now()).toBe(0); });
  await withMemoryStartupImpl(need, { ...options, sleep: async ms => {
    expect(scenario.lines.at(-1)).toContain('recent starts 1');
    scenario.advance(ms);
  } }, () => { expect(scenario.now()).toBe(30_000); });
  expect(scenario.lines.at(-1)).toContain('recent starts 0');
});

test('completed pressure starts count even after their admitting process exits or its PID is reused', async () => {
  const scenario = pressureScenario(0);
  await withMemoryStartupImpl(need, scenario.options, () => {});
  await withMemoryStartupImpl(need, { ...scenario.options, startTime: () => 'reused-process',
    sleep: async ms => { scenario.advance(ms); },
  }, () => { expect(scenario.now()).toBe(30_000); });
});

test('a lost startup owner releases its memory promise but its recent start still counts', async () => {
  const scenario = pressureScenario(0);
  const ready = deferred<void>(), finish = deferred<void>();
  const first = withMemoryStartupImpl(need, scenario.options, async () => {
    ready.resolve(); await finish.promise;
  });
  await ready.promise;
  try {
    await withMemoryStartupImpl(need, { ...scenario.options, startTime: () => 'replacement-process',
      sleep: async ms => { scenario.advance(ms); },
    }, () => { expect(scenario.now()).toBe(30_000); });
  } finally { finish.resolve(); await first; }
});

test('an invalid CPU pressure reading fails instead of silently reverting to load', async () => {
  const scenario = pressureScenario();
  writeFileSync(scenario.pressureFile, 'some avg60=0.00 total=0\n');
  await expect(withMemoryStartupImpl(need, scenario.options,
    () => { throw new Error('must not start'); })).rejects.toThrow('Cannot read host CPU pressure some avg10');
});

test('a pressure dip admits waiters in arrival order without a burst at startup concurrency three', async () => {
  const scenario = pressureScenario();
  writeFileSync(join(scenario.directory, 'qa-startup-concurrency'), '3');
  const starts: { id: number; at: number }[] = [];
  await Promise.all([0, 1, 2].map(id => withMemoryStartupImpl(need, {
    ...scenario.options, pollMs: 5000, sleep: async ms => {
      scenario.advance(ms);
      if (scenario.now() >= 3000) scenario.setPressure(0);
    },
  }, () => { starts.push({ id, at: scenario.now() }); })));
  expect(starts.map(start => start.id)).toEqual([0, 1, 2]);
  expect(starts[1]!.at - starts[0]!.at).toBeGreaterThanOrEqual(30_000);
  expect(starts[2]!.at - starts[1]!.at).toBeGreaterThanOrEqual(30_000);
});

test('the CPU pressure limit file is reread on the next poll', async () => {
  const scenario = pressureScenario(15);
  const limitFile = join(scenario.directory, 'qa-cpu-pressure-limit');
  writeFileSync(limitFile, '15');
  await withMemoryStartupImpl(need, { ...scenario.options, sleep: async ms => {
    expect(scenario.lines.at(-1)).toContain('limit 15%');
    scenario.advance(ms);
    writeFileSync(limitFile, '16');
  } }, () => { expect(scenario.now()).toBe(5000); });
  expect(scenario.lines.at(-1)).toContain('limit 16%');
});

test('missing CPU pressure falls back to the existing load limit and explains that once while waiting', async () => {
  const scenario = loadScenario();
  writeFileSync(join(scenario.directory, 'qa-cpu-pressure-limit'), '100');
  await withMemoryStartupImpl(need, { ...scenario.options, sleep: async ms => {
    scenario.advance(ms);
    if (scenario.now() === 2000) writeFileSync(scenario.loadFile, '64.0 0 0 1/1 1\n');
  } }, () => { expect(scenario.now()).toBe(2000); });
  expect(scenario.lines.filter(line => line.includes('CPU pressure unavailable; using one-minute load average')))
    .toHaveLength(1);
  expect(scenario.lines.at(-1)).toContain('limit 1');
});

test('pressure waiting keeps load deadline admission and its final memory recheck', async () => {
  const scenario = pressureScenario();
  const options = scenario.options;
  await withMemoryStartupImpl(need, { ...options, deadline: 2500 },
    () => { expect(scenario.now()).toBe(2500); });
  expect(scenario.lines.at(-1)).toContain('load deadline reached, starting');
  let started = false;
  await expect(withMemoryStartupImpl(need, { ...options, deadline: 5000,
    read: async () => scenario.now() < 5000 ? plenty : { ...plenty, hostAvailable: 0 },
  }, () => { started = true; })).rejects.toThrow('Memory admission deadline reached');
  expect(started).toBe(false);
});

test('a startup with no stack never reads CPU pressure', async () => {
  const scenario = pressureScenario();
  writeFileSync(scenario.pressureFile, 'invalid pressure');
  await withMemoryStartupImpl({ ...need, vm: 0, vmReserve: 0 }, scenario.options,
    () => { expect(scenario.now()).toBe(0); });
});

for (const limit of [undefined, '1.5', '0.5']) {
  test(`load limit ${limit ?? 'absent'} is read beside the slots with a default of one`, async () => {
    const scenario = loadScenario();
    if (limit !== undefined) writeFileSync(join(scenario.directory, 'qa-load-limit'), limit);
    await withMemoryStartupImpl(need, { ...scenario.options, sleep: async ms => {
      scenario.advance(ms);
      writeFileSync(scenario.loadFile, '0.0 0 0 1/1 1\n');
    } }, () => {});
    expect(scenario.now()).toBe(limit === '1.5' ? 0 : 1000);
    expect(scenario.lines.at(-1)).toContain(`limit ${limit ?? '1'}`);
  });
}

test('load deadline admission rechecks memory instead of starting from a stale available reading', async () => {
  const scenario = loadScenario();
  let started = false;
  await expect(withMemoryStartupImpl(need, { ...scenario.options, deadline: 2500,
    read: async () => scenario.now() < 2500 ? plenty : { ...plenty, hostAvailable: 0 },
  }, () => { started = true; })).rejects.toThrow('Memory admission deadline reached');
  expect(started).toBe(false);
  expect(readdirSync(scenario.waiters)).toEqual([]);
});

test('a simulated host takes processor pressure only from a file its environment names', () => {
  const directory = mkdtempSync(join(scratch, 'pressure-source-'));
  try {
    const file = join(directory, 'cpu');
    writeFileSync(file, 'some avg10=37.50 avg60=20.00 avg300=10.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n');
    const read = async () => ({ vmTotal: 24 * GiB, vmUsed: 0, hostAvailable: 20 * GiB });
    // No file named: the kernel of the machine running this test is not this host.
    expect(admissionCpuPressure({ read, env: { REZICS_STACK_PROFILE: 'qa' } })).toBeUndefined();
    expect(admissionCpuPressure({ read, env: { REZICS_QA_CPU_PRESSURE_FILE: file } })).toBe(37.5);
    expect(admissionCpuPressure({ env: { REZICS_QA_CPU_PRESSURE_FILE: file } })).toBe(37.5);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
