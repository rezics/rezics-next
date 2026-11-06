import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reapContainersAsync } from './containers.ts';
import { dispatchDailyStepAudit } from './flow.ts';
import { newestWorktreeMtime } from './job.ts';
import { openDb } from './db.ts';
import { stopRecordedAppServers } from './manager-host.ts';
import { defaultPolicy } from './policy.ts';
import { processGroupCpuTicks, processIdentity, sameProcess, type ProcessIdentity } from './process.ts';
import { startHostHeartbeat } from './service.ts';
import { WorkerStore } from './store.ts';

/** Largest gap between event-loop turns while `work` runs; a synchronous step shows up as one large gap. */
async function maxLoopGap(work: () => Promise<unknown>, intervalMs = 10): Promise<number> {
  let last = performance.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, intervalMs);
  try {
    await work();
  } finally {
    clearInterval(timer);
  }
  return worst;
}

/** Counts event-loop turns while `work` runs; a function that never yields completes with zero turns. */
async function loopTurns(work: () => Promise<unknown>): Promise<number> {
  let turns = 0;
  let running = true;
  const spin = () => {
    if (!running) return;
    turns++;
    setImmediate(spin);
  };
  setImmediate(spin);
  try {
    await work();
  } finally {
    running = false;
  }
  return turns;
}

test('the container reaper runs docker in the background, not on the host loop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goal-host-loop-docker-'));
  const previousPath = process.env.PATH;
  let db: ReturnType<typeof openDb> | undefined;
  try {
    // A docker that answers after 1.5 s stands for a daemon held by btrfs maintenance.
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'docker'), '#!/bin/sh\nsleep 1.5\n');
    chmodSync(join(bin, 'docker'), 0o755);
    process.env.PATH = `${bin}:${previousPath}`;
    const state = join(root, 'state');
    mkdirSync(state);
    writeFileSync(join(state, 'containers.json'), JSON.stringify({ maxAgeHours: 1 }));
    db = openDb(join(state, 'goal.sqlite'));
    // The host always opens its store, which creates the current-attempt table the reaper reads.
    new WorkerStore(db);
    const gap = await maxLoopGap(() => reapContainersAsync(db!, state, Date.now()));
    expect(gap).toBeLessThan(500);
  } finally {
    process.env.PATH = previousPath;
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test('worktree activity walks and CPU samples yield between entries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goal-host-loop-walk-'));
  try {
    // A worktree with 2,000 files in 20 directories stands for a running worker's checkout.
    for (let dir = 0; dir < 20; dir++) {
      const path = join(root, `d${dir}`);
      mkdirSync(path);
      for (let file = 0; file < 100; file++) writeFileSync(join(path, `f${file}.txt`), `${dir}:${file}`);
    }
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'ignored.txt'), 'x');
    const expected = (function newest(dir: string): number {
      let value = 0;
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules') continue;
        const stat = statSync(join(dir, name));
        value = Math.max(value, stat.mtimeMs, stat.isDirectory() ? newest(join(dir, name)) : 0);
      }
      return value;
    })(root);
    let newest = 0;
    const turns = await loopTurns(async () => {
      newest = await newestWorktreeMtime(root);
    });
    expect(newest).toBe(expected);
    expect(turns).toBeGreaterThan(1);
    const self = processIdentity();
    expect(self).not.toBeNull();
    const cpuTurns = await loopTurns(() => processGroupCpuTicks(self));
    expect(cpuTurns).toBeGreaterThan(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test('the daily step audit reads unsettled tasks at the current scale without the full task list', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goal-host-loop-scale-'));
  try {
    const db = openDb(join(root, 'goal.sqlite'));
    try {
      const store = new WorkerStore(db);
      const insert = db.query('INSERT INTO worker_tasks(id, sequence, current_attempt, body) VALUES (?, ?, ?, ?)');
      const padding = 'b'.repeat(7_500);
      const body = (id: string, state: string, goal = 'fixture') =>
        JSON.stringify({ id, state, currentAttempt: 1, brief: { goal, manager: 'manager', markdown: padding } });
      // About 7,000 settled tasks with 7.5 KB briefs, 90 running tasks and one open audit in the verified state.
      db.transaction(() => {
        for (let i = 0; i < 7_000; i++) insert.run(`merged-${i}`, i, 1, body(`merged-${i}`, 'merged'));
        for (let i = 0; i < 90; i++) insert.run(`running-${i}`, 7_000 + i, 1, body(`running-${i}`, 'running'));
        insert.run('audit-1', 7_090, 1, body('audit-1', 'verified', 'daily-step-audit'));
      })();
      const open = store.tasksInStates(['ready', 'held', 'running', 'landing', 'verified']);
      expect(open).toHaveLength(91);
      expect(open.some((task) => task.id === 'audit-1')).toBe(true);
      let dispatched = 0;
      const started = performance.now();
      const audit = dispatchDailyStepAudit(db, open, () => {
        dispatched++;
        throw new Error('an open audit must not be dispatched again');
      });
      expect(audit).toBeNull();
      expect(dispatched).toBe(0);
      expect(performance.now() - started).toBeLessThan(5_000);
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test('the watchdog ping keeps running while a scheduler pass never finishes', async () => {
  const messages: string[] = [];
  // A pass that never completes: the heartbeat must not depend on it.
  const pendingPass = new Promise<void>(() => {});
  void pendingPass;
  const stop = await startHostHeartbeat({ NOTIFY_SOCKET: '/fixture/notify', WATCHDOG_USEC: '20000' }, async (message) => {
    messages.push(message);
  });
  await Bun.sleep(120);
  stop();
  const pings = messages.filter((message) => message === 'WATCHDOG=1').length;
  expect(messages[0]).toBe('READY=1');
  expect(pings).toBeGreaterThanOrEqual(3);
});

test('a replacement host reclaims the previous app-server group, helpers included, before resuming threads', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goal-host-loop-group-'));
  const registry = join(root, 'manager-app-servers.json');
  const leaderFile = join(root, 'leader.pid');
  const helperFile = join(root, 'helper.pid');
  // The "app-server" leads its own session and group, as connectPool starts it, and starts a helper in that group.
  // `setsid -f` detaches it from this test, so init reaps it: a zombie leader would keep the group visible.
  const leader = join(root, 'leader.ts');
  writeFileSync(
    leader,
    `import { writeFileSync } from 'node:fs';
const helper = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', 'ignore'] });
writeFileSync(${JSON.stringify(helperFile)}, String(helper.pid));
writeFileSync(${JSON.stringify(leaderFile)}, String(process.pid));
setInterval(() => {}, 1000);
`,
  );
  const started = spawnSync('setsid', ['-f', process.execPath, leader], { stdio: 'ignore' });
  expect(started.status).toBe(0);
  let identity: ProcessIdentity | null = null;
  let helperPid = 0;
  try {
    for (let attempt = 0; attempt < 300 && !(identity && helperPid); attempt++) {
      if (!identity) {
        const pid = Number(await Bun.file(leaderFile).text().catch(() => ''));
        identity = pid ? processIdentity(pid) : null;
      }
      if (!helperPid) helperPid = Number(await Bun.file(helperFile).text().catch(() => '')) || 0;
      if (!(identity && helperPid)) await Bun.sleep(20);
    }
    expect(identity).not.toBeNull();
    expect(identity!.group).toBe(identity!.pid);
    expect(processIdentity(helperPid)?.group).toBe(identity!.group);
    writeFileSync(registry, JSON.stringify([identity]));
    await stopRecordedAppServers(registry, defaultPolicy.appServer);
    // Both were gone before stop returned: the caller may resume threads now.
    expect(sameProcess(identity!)).toBe(false);
    expect(processIdentity(helperPid)).toBeNull();
    expect(await Bun.file(registry).exists()).toBe(false);
  } finally {
    const pid = identity?.pid ?? Number(await Bun.file(leaderFile).text().catch(() => ''));
    if (pid > 0) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
