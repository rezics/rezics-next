import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { acquireQaSlots, commandAsync, concurrencyGate, LOAD_PREPARATION_BUDGET_MS, QaRunDeadline, withQaMemory } from '../../../scripts/qa/core.ts';

const root = resolve(import.meta.dir, '../../..');
mkdirSync(join(root, '.temp'), { recursive: true });
const scratch = mkdtempSync(join(root, '.temp', 'run-deadline-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const need = { vm: 0, vmReserve: 0, host: 1, hostReserve: 0 };
const env = { REZICS_STACK_PROFILE: 'qa' };

function heldSlot(name: string): string {
  const directory = join(scratch, name);
  mkdirSync(join(directory, '0'), { recursive: true });
  writeFileSync(join(directory, '0', 'pid'), String(process.pid));
  return directory;
}

test('admission after a wait longer than the work bound retains the whole bound', async () => {
  let clock = 0;
  const now = () => clock;
  const deadline = new QaRunDeadline(600_000, now, 6 * 3_600_000);
  await withQaMemory(need, {
    env, now, deadline: deadline.waitDeadline, lockFile: join(scratch, 'late.sqlite'), readingMaxAgeMs: 1,
    read: async () => ({ vmTotal: 0, vmUsed: 0, hostAvailable: clock ? 1 : 0 }),
    sleep: async ms => { clock += ms; }, pollMs: 700_000, announce: () => {},
  }, async () => {
    expect(clock).toBe(700_000);
    expect(deadline.remainingMs()).toBe(600_000);
    clock += 600_001;
    expect(deadline.remainingMs()).toBe(0);
  }, deadline);
});

test('memory followed by a lease wait pauses the same run clock twice', async () => {
  let clock = 0;
  const now = () => clock;
  const deadline = new QaRunDeadline(600_000, now, 6 * 3_600_000);
  const slots = heldSlot('two-waits');
  await withQaMemory(need, {
    env, now, deadline: deadline.waitDeadline, lockFile: join(scratch, 'twice.sqlite'), readingMaxAgeMs: 1,
    read: async () => ({ vmTotal: 0, vmUsed: 0, hostAvailable: clock ? 1 : 0 }),
    sleep: async ms => { clock += ms; }, pollMs: 700_000, announce: () => {},
  }, async () => {
    const lease = await acquireQaSlots(slots, 1, { GOAL_QA_SLOTS: '1' }, process.pid, {
      inherit: false, now, runDeadline: deadline, deadline: deadline.waitDeadline, pollMs: 700_000, announce: () => {},
      sleep: async ms => { clock += ms; rmSync(join(slots, '0'), { recursive: true }); },
    });
    try {
      expect(clock).toBe(1_400_000);
      expect(deadline.remainingMs()).toBe(600_000);
    } finally { lease.release(); }
  }, deadline);
});

test('overlapping waits pause their union, while work before and after still spends the bound', () => {
  let clock = 0;
  const deadline = new QaRunDeadline(100, () => clock);
  clock = 10;
  const memory = deadline.wait();
  clock = 50;
  const lease = deadline.wait();
  clock = 150;
  memory(); memory();
  expect(deadline.remainingMs()).toBe(Infinity);
  clock = 250;
  lease();
  expect(deadline.remainingMs()).toBe(90);
  clock += 89;
  expect(deadline.remainingMs()).toBe(1);
  clock++;
  expect(deadline.remainingMs()).toBe(0);
  expect(deadline.waitDeadline).toBe(100);
  expect(deadline.sample()).toEqual({ budgetMs: 100, activeElapsedMs: 100, admissionWaitMs: 240, waitDeadline: 100 });
});

test('waiting for its local startup turn preserves the work bound and records the wait', async () => {
  let clock = 0;
  const deadline = new QaRunDeadline(100, () => clock, 10_000);
  const spans: { start: number; end: number }[] = [];
  const start = concurrencyGate(1, { runDeadline: deadline, now: () => clock, onAdmissionWait: span => spans.push(span) });
  let finish!: () => void;
  const first = start(() => new Promise<void>(resolve => { finish = resolve; }));
  const next = start(async () => { expect(deadline.remainingMs()).toBe(100); });
  clock = 1_000;
  finish();
  await Promise.all([first, next]);
  expect(spans).toEqual([{ start: 0, end: 1_000 }]);
});

test('a memory waiter never admitted stops on its own bound and reports the wait', async () => {
  let clock = 0;
  let worked = false;
  const deadline = new QaRunDeadline(100, () => clock, 900);
  await expect(withQaMemory(need, {
    env, now: () => clock, deadline: deadline.waitDeadline, lockFile: join(scratch, 'never.sqlite'), readingMaxAgeMs: 1,
    read: async () => ({ vmTotal: 0, vmUsed: 0, hostAvailable: 0 }),
    sleep: async ms => { clock += ms; }, pollMs: 300, announce: () => {},
  }, async () => { worked = true; }, deadline)).rejects.toThrow('QA waited for memory for 900 ms; admission deadline reached; no work started');
  expect(clock).toBe(900);
  expect(worked).toBe(false);
  expect(deadline.remainingMs()).toBe(100);
});

test('a slot waiter never admitted reports the slot and elapsed wait, without expiring work', async () => {
  let clock = 0;
  const deadline = new QaRunDeadline(100, () => clock, 900);
  await expect(acquireQaSlots(heldSlot('never-slot'), 1, { GOAL_QA_SLOTS: '1' }, process.pid, {
    inherit: false, now: () => clock, runDeadline: deadline, deadline: deadline.waitDeadline,
    pollMs: 300, sleep: async ms => { clock += ms; }, announce: () => {},
  })).rejects.toThrow('QA waited for a QA slot for 900 ms; admission deadline reached; no work started');
  expect(clock).toBe(900);
  expect(deadline.remainingMs()).toBe(100);
});

test('the preparation ceiling remains 600 seconds of admitted work', () => {
  let clock = 0;
  const preparation = new QaRunDeadline(LOAD_PREPARATION_BUDGET_MS, () => clock);
  const resume = preparation.wait();
  clock = 700_000;
  resume();
  expect(preparation.remainingMs()).toBe(600_000);
  clock += 600_001;
  expect(preparation.remainingMs()).toBe(0);
  expect(LOAD_PREPARATION_BUDGET_MS).toBe(600_000);
});

test('command and lifetime lease timers both pause during child admission, then still stop overdue work', async () => {
  const slots = join(scratch, 'child-slots');
  mkdirSync(slots);
  const source = `
    import { acquireQaSlots, commandAsync, QaRunDeadline } from ${JSON.stringify(join(root, 'scripts/qa/core.ts'))};
    const deadline = new QaRunDeadline(Date.now() + 400, Date.now, Date.now() + 5000);
    const lease = await acquireQaSlots(${JSON.stringify(slots)}, 1, { GOAL_QA_SLOTS: '1' }, process.pid, { runDeadline: deadline });
    const result = await commandAsync(${JSON.stringify(scratch)}, ${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(`
      console.log('QA_MEMORY_WAIT_BEGIN 1-1');
      await Bun.sleep(700);
      console.log('QA_MEMORY_WAIT_END 1-1 700');
      await Bun.sleep(40);
    `)}], 2000, {}, undefined, { runDeadline: deadline });
    lease.release();
    console.log(JSON.stringify(result));
    if (!result.ok) process.exit(1);
  `;
  const survived = await commandAsync(scratch, 'bun', ['-e', source], 5_000);
  expect(survived.output).not.toContain('error:');
  expect(survived.ok).toBe(true);
  expect(survived.output).not.toContain('reached its deadline');
  const over = await commandAsync(scratch, process.execPath, ['-e', 'await Bun.sleep(5000)'], 5_000,
    {}, undefined, { runDeadline: Date.now() + 150 });
  expect(over.timedOut).toBe(true);
  expect(over.output).toContain('reached its run deadline');
});

test('a child that never finishes admission reports elapsed waiting instead of a run deadline', async () => {
  const result = await commandAsync(scratch, process.execPath, ['-e', `console.log('QA_MEMORY_WAIT_BEGIN 1-1'); await Bun.sleep(5000);`],
    5_000, {}, undefined, { runDeadline: new QaRunDeadline(Date.now() + 100, Date.now, Date.now() + 350) });
  expect(result.timedOut).toBe(true);
  expect(result.output).toMatch(/QA waited for memory, a startup turn or a QA lease for \d+ ms/);
  expect(result.output).not.toContain('reached its run deadline');
});

test('a nested command inherits remaining work separately from the fixed admission instant', async () => {
  const result = await commandAsync(scratch, process.execPath, ['-e', 'await Bun.sleep(20);'], 1_000,
    { REZICS_QA_MEMORY_DEADLINE: '1', REZICS_QA_RUN_REMAINING_MS: '1000' }, undefined, { runDeadline: 1 });
  expect(result.ok).toBe(true);
  const expired = await commandAsync(scratch, process.execPath, ['-e', 'await Bun.sleep(5000);'], 5_000,
    { REZICS_QA_MEMORY_DEADLINE: '1', REZICS_QA_RUN_REMAINING_MS: '150' }, undefined, { runDeadline: 1 });
  expect(expired.timedOut).toBe(true);
  expect(expired.output).toContain('reached its run deadline');
});
