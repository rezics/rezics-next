import { expect, test } from 'bun:test';
import { startDevCompose } from '../../../scripts/dev/cli.ts';
import { startSearchFuseki } from '../../../scripts/operations/search-startup.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';


import { Database } from 'bun:sqlite';
import { GiB, withMemoryStartup } from '../../../scripts/qa/memory-admission.ts';

const root = resolve(import.meta.dir, '../../..');
const scratch = join(root, '.temp');
mkdirSync(scratch, { recursive: true });
const plenty = { vmTotal: 24 * GiB, vmUsed: 0, hostAvailable: 20 * GiB };
// Memory and ordering cases control load too: a real busy host otherwise adds
// deadline admission and a 20-second load queue to their injected timelines.
const idleHost = { readLoad: () => 0, processors: 1 };
// Admission policy lookup must stay in the fixture too. Its worktree fallback
// shells out to Git on every poll and reads the live orchestration policy.
const startupEnvironment = (dir: string): NodeJS.ProcessEnv => ({
  REZICS_STACK_PROFILE: 'qa', GOAL_QA_SLOT_DIRECTORY: join(dir, 'slots'),
});

for (const [name, start, readinessMs] of [
  ['dev CLI', startDevCompose, 180_000],
  ['search rebuild', startSearchFuseki, 300_000],
] as const) {
  test(`${name} waits past its readiness budget and gives Compose the full timeout after admission`, async () => {
    const dir = mkdtempSync(join(scratch, 'qa-startup-budget-'));
    let now = 0;
    const readings: number[] = [];
    try {
      const result = await start(root, { ...startupEnvironment(dir), REZICS_QA_MEMORY_DEADLINE: '900000' },
        'qa', timeout => {
          expect(now).toBe(400_000);
          expect(timeout).toBe(readinessMs);
          now += timeout;
          return 'ready';
        }, { ...idleHost, now: () => now, pollMs: 400_000,
          sleep: async ms => { now += ms; }, announce: () => {},
          read: async remaining => {
            readings.push(remaining);
            return now === 0 ? { ...plenty, vmUsed: plenty.vmTotal } : plenty;
          } });
      expect(result).toBe('ready');
      expect(readings).toEqual([900_000, 500_000]);
      expect(now).toBe(400_000 + readinessMs);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test(`${name} stops admission at the parent run deadline without starting Compose`, async () => {
    const dir = mkdtempSync(join(scratch, 'qa-startup-deadline-'));
    let now = 0, starts = 0;
    try {
      await expect(start(root, { ...startupEnvironment(dir), REZICS_QA_MEMORY_DEADLINE: '900000' },
        'qa', () => { starts++; }, { ...idleHost, now: () => now,
          pollMs: 400_000, sleep: async ms => { now += ms; }, announce: () => {},
          read: async () => ({ ...plenty, vmUsed: plenty.vmTotal }) })).rejects.toThrow('Memory admission deadline');
      expect(now).toBe(900_000);
      expect(starts).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function orderedStartups() {
  const dir = mkdtempSync(join(scratch, 'ordered-startups-'));
  const lockFile = join(dir, 'startup.sqlite');
  let now = 0, available = false;
  const order: number[] = [];
  const sleepers = new Map<number, ReturnType<typeof deferred<void>>>();
  const sleeping = new Map<number, ReturnType<typeof deferred<void>>>();
  const runs = new Map<number, Promise<void>>();
  const start = (id: number, vm = GiB) => {
    const paused = deferred<void>();
    sleeping.set(id, paused);
    const run = withMemoryStartup({ vm, host: GiB, vmReserve: 0, hostReserve: 8 * GiB }, {
      env: startupEnvironment(dir), root, lockFile, deadline: 1_000,
      ...idleHost, now: () => now, pollMs: 1, readingMaxAgeMs: 0, announce: () => {},
      read: async () => {
        // A slow Docker reader must not block another request's registration.
        const probe = new Database(lockFile);
        try { probe.exec('BEGIN IMMEDIATE'); probe.exec('ROLLBACK'); }
        finally { probe.close(); }
        return { vmTotal: 24 * GiB, vmUsed: available ? 20 * GiB : 24 * GiB, hostAvailable: 20 * GiB };
      },
      sleep: async () => {
        const wake = deferred<void>(); sleepers.set(id, wake); sleeping.get(id)!.resolve(); await wake.promise;
      },
    }, () => { order.push(id); });
    runs.set(id, run);
    return run;
  };
  return { dir, lockFile, order, start,
    paused: (id: number) => Promise.race([sleeping.get(id)!.promise,
      runs.get(id)!.then(() => { throw new Error(`Startup ${id} proceeded instead of waiting`); })]),
    nextPause: (id: number) => { const paused = deferred<void>(); sleeping.set(id, paused); return paused.promise; },
    wake: (id: number) => { now++; sleepers.get(id)!.resolve(); },
    fit: () => { available = true; },
    expire: () => { now = 1_000; },
  };
}

test('three startup waiters start in arrival order even when the newest polls first', async () => {
  const queue = orderedStartups();
  try {
    const first = queue.start(1); await queue.paused(1);
    const second = queue.start(2); await queue.paused(2);
    const third = queue.start(3); await queue.paused(3);
    queue.fit();
    // A fresh later arrival cannot take the fitting head's place.
    const fourth = queue.start(4); await queue.paused(4);
    expect(queue.order).toEqual([]);
    const thirdWaits = queue.nextPause(3); queue.wake(3); await thirdWaits;
    const secondWaits = queue.nextPause(2); queue.wake(2); await secondWaits;
    expect(queue.order).toEqual([]);
    queue.wake(1); await first;
    queue.wake(2); await second;
    queue.wake(3); await third;
    queue.wake(4); await fourth;
    expect(queue.order).toEqual([1, 2, 3, 4]);
  } finally { rmSync(queue.dir, { recursive: true, force: true }); }
});

test('the oldest fitting startup passes a larger waiter and keeps its place before later arrivals', async () => {
  const queue = orderedStartups();
  try {
    const tooLarge = queue.start(1, 30 * GiB); await queue.paused(1);
    const fitting = queue.start(2); await queue.paused(2);
    queue.fit();
    const later = queue.start(3); await queue.paused(3);
    expect(queue.order).toEqual([]);
    queue.wake(2); await fitting;
    queue.wake(3); await later;
    expect(queue.order).toEqual([2, 3]);
    queue.expire(); queue.wake(1);
    await expect(tooLarge).rejects.toThrow('Memory admission deadline');
  } finally { rmSync(queue.dir, { recursive: true, force: true }); }
});

test('dead and reused startup waiters release their ordered place', async () => {
  const queue = orderedStartups();
  try {
    const first = queue.start(1); await queue.paused(1);
    const db = new Database(queue.lockFile);
    db.query(`INSERT INTO startup_waiters
      (id, pid, start_time, vm, host, vm_reserve, host_reserve, admitted_at, arrival_seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('dead', 2_147_483_647, 'gone', GiB, GiB, 0, 8 * GiB, -1, '0');
    // Make the dead request oldest in the actual queue, independently of wall time.
    db.query('UPDATE startup_waiters SET seq = -1 WHERE id = ?').run('dead');
    queue.fit(); queue.wake(1); await first;
    expect(queue.order).toEqual([1]);
    expect(db.query('SELECT * FROM startup_waiters').all()).toEqual([]);
    db.close();
  } finally { rmSync(queue.dir, { recursive: true, force: true }); }
});

test('a provisional ordinary slot is returned when memory no longer fits before startup', async () => {
  const dir = mkdtempSync(join(scratch, 'startup-slot-retry-'));
  const gatePath = join(dir, 'gate.json'), slot = join(dir, 'ordinary-slot');
  let now = 0, reads = 0, request: string[] | undefined;
  writeFileSync(gatePath, JSON.stringify({ token: 'test', status: 'pending' }));
  try {
    await withMemoryStartup({ vm: GiB, host: GiB, vmReserve: 0, hostReserve: 8 * GiB }, {
      root, env: { ...startupEnvironment(dir), REZICS_QA_STARTUP_SLOT_GATE: gatePath },
      ...idleHost, deadline: 100, now: () => now, pollMs: 1, readingMaxAgeMs: 0,
      read: async () => ({ ...plenty, vmUsed: ++reads === 2 ? plenty.vmTotal : 0 }),
      announce: line => {
        const parts = line.split(' ');
        if (parts[0] === 'QA_STARTUP_SLOT_READY') {
          request = parts;
          if (reads > 2) {
            mkdirSync(slot);
            writeFileSync(gatePath, JSON.stringify({ token: 'test', status: 'granted',
              requester: parts[2], sequence: Number(parts[3]) }));
          }
        }
        if (parts[0] === 'QA_STARTUP_SLOT_CANCEL') rmSync(slot, { recursive: true, force: true });
      },
      sleep: async () => {
        now++;
        if (reads === 1) {
          mkdirSync(slot);
          writeFileSync(gatePath, JSON.stringify({ token: 'test', status: 'granted',
            requester: request![2], sequence: Number(request![3]) }));
        } else expect(existsSync(slot)).toBe(false);
      },
    }, () => { expect(existsSync(slot)).toBe(true); });
    expect(reads).toBe(3);
    expect(JSON.parse(readFileSync(gatePath, 'utf8')).status).toBe('granted');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
