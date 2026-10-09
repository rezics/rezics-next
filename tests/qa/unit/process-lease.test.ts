import { expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { processAlive, processIdentity } from '../../../scripts/qa/process/identity.ts';
import { directoryLeaseHeld, directoryLeaseState, leaseInitializingMs, releaseDirectoryLease,
  tryAcquireDirectoryLease } from '../../../scripts/qa/process/lease.ts';
import { terminateProcessGroup } from '../../../scripts/qa/process/terminate.ts';

const scratch = join(import.meta.dir, '../../../.temp/process-lease');
mkdirSync(scratch, { recursive: true });

function workspace(): string {
  return mkdtempSync(join(scratch, 'case-'));
}

function statStart(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const start = stat.slice(stat.lastIndexOf(')') + 2).trim().split(' ')[19];
  if (!start) throw new Error(`missing start time for ${pid}`);
  return start;
}

function childExit(child: ChildProcess): Promise<number | null> {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(child.exitCode); return; }
    child.once('exit', code => resolve(code));
  });
}

function firstLine(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      data += chunk;
      const newline = data.indexOf('\n');
      if (newline >= 0) resolve(data.slice(0, newline));
    });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`process exited ${code} before printing a pid`)));
  });
}

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await Bun.sleep(10);
  }
}

test('a reused pid does not release the process that now owns that pid', () => {
  const root = workspace();
  try {
    const directory = join(root, 'slot');
    const self = processIdentity(process.pid)!;
    mkdirSync(directory);
    writeFileSync(join(directory, 'identity.json'), JSON.stringify({
      pid: process.pid, start: '1', boot: self.boot, token: 'previous-owner',
    }));
    writeFileSync(join(directory, 'lease'), 'previous-owner');
    writeFileSync(join(directory, 'pid'), String(process.pid));
    expect(() => process.kill(process.pid, 0)).not.toThrow();
    expect(directoryLeaseHeld(directory)).toBe(false);
    const acquired = tryAcquireDirectoryLease(directory);
    expect(acquired).not.toBe('held');
    if (acquired === 'held') return;
    releaseDirectoryLease(directory, 'previous-owner');
    expect(JSON.parse(readFileSync(join(directory, 'identity.json'), 'utf8')).token).toBe(acquired.token);
    expect(processIdentity(process.pid)?.start).toBe(self.start);
    acquired.release();
    expect(directoryLeaseState(directory)).toBe('free');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a zombie is not a live owner and cannot drop another process lease', async () => {
  const root = workspace();
  const parent = spawn('python3', ['-c', `
import os, sys, time
pid = os.fork()
if pid == 0:
    os._exit(0)
sys.stdout.write(f"{pid}\\n")
sys.stdout.flush()
time.sleep(30)
`], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const zombie = Number(await firstLine(parent));
    const deadline = Date.now() + 2_000;
    let state = '';
    while (Date.now() < deadline) {
      const stat = readFileSync(`/proc/${zombie}/stat`, 'utf8');
      state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] ?? '';
      if (state === 'Z' || state === 'X') break;
      await Bun.sleep(10);
    }
    expect(state === 'Z' || state === 'X').toBe(true);
    if (state === 'Z') expect(() => process.kill(zombie, 0)).not.toThrow();
    const self = processIdentity(process.pid)!;
    expect(processAlive({ pid: zombie, start: statStart(zombie), boot: self.boot })).toBe(false);
    const directory = join(root, 'slot');
    mkdirSync(directory);
    writeFileSync(join(directory, 'identity.json'), JSON.stringify({
      pid: zombie, start: statStart(zombie), boot: self.boot, token: 'zombie-owner',
    }));
    writeFileSync(join(directory, 'lease'), 'zombie-owner');
    writeFileSync(join(directory, 'pid'), String(zombie));
    expect(directoryLeaseHeld(directory)).toBe(false);
    const acquired = tryAcquireDirectoryLease(directory);
    expect(acquired).not.toBe('held');
    if (acquired === 'held') return;
    releaseDirectoryLease(directory, 'zombie-owner');
    expect(JSON.parse(readFileSync(join(directory, 'identity.json'), 'utf8')).token).toBe(acquired.token);
    acquired.release();
  } finally {
    parent.kill('SIGKILL');
    await childExit(parent);
    rmSync(root, { recursive: true, force: true });
  }
});

test('an owner that dies during initialization cannot release a later acquisition', () => {
  const root = workspace();
  try {
    const directory = join(root, 'slot');
    mkdirSync(directory);
    const created = statSync(directory).mtimeMs;
    expect(directoryLeaseState(directory, { now: () => created })).toBe('initializing');
    expect(tryAcquireDirectoryLease(directory, { now: () => created })).toBe('held');
    expect(directoryLeaseState(directory, { now: () => created + leaseInitializingMs })).toBe('stale');
    const acquired = tryAcquireDirectoryLease(directory, { now: () => created + leaseInitializingMs });
    expect(acquired).not.toBe('held');
    if (acquired === 'held') return;
    releaseDirectoryLease(directory, 'never-published');
    expect(existsSync(directory)).toBe(true);
    expect(JSON.parse(readFileSync(join(directory, 'identity.json'), 'utf8')).token).toBe(acquired.token);
    acquired.release();
    expect(existsSync(directory)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a stale lease is reclaimed and its old token cannot release the new owner', () => {
  const root = workspace();
  try {
    const directory = join(root, 'slot');
    mkdirSync(directory);
    writeFileSync(join(directory, 'pid'), '2147483647');
    writeFileSync(join(directory, 'lease'), 'stale-token');
    expect(directoryLeaseHeld(directory)).toBe(false);
    const acquired = tryAcquireDirectoryLease(directory);
    expect(acquired).not.toBe('held');
    if (acquired === 'held') return;
    releaseDirectoryLease(directory, 'stale-token');
    expect(readFileSync(join(directory, 'pid'), 'utf8')).toBe(String(process.pid));
    acquired.release();
    expect(existsSync(directory)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a signal handler releases only the token it still owns', async () => {
  const root = workspace();
  const directory = join(root, 'slot');
  const ready = join(root, 'ready');
  const script = `
    import { writeFileSync } from 'node:fs';
    import { tryAcquireDirectoryLease } from ${JSON.stringify(join(import.meta.dir, '../../../scripts/qa/process/lease.ts'))};
    const lease = tryAcquireDirectoryLease(process.env.LEASE_DIR);
    if (lease === 'held') throw new Error('lease already held');
    writeFileSync(process.env.READY, lease.token);
    process.on('SIGTERM', () => { lease.release(); process.exit(0); });
    setInterval(() => {}, 500);
  `;
  const child = spawn(process.execPath, ['-e', script], {
    stdio: 'inherit', env: { ...process.env, LEASE_DIR: directory, READY: ready },
  });
  try {
    await waitFor(ready);
    const self = processIdentity(process.pid)!;
    const replacement = 'replacement-token';
    writeFileSync(join(directory, 'lease'), replacement);
    writeFileSync(join(directory, 'identity.json'), JSON.stringify({
      pid: self.pid, start: self.start, boot: self.boot, token: replacement,
    }));
    writeFileSync(join(directory, 'pid'), String(self.pid));
    child.kill('SIGTERM');
    expect(await childExit(child)).toBe(0);
    expect(existsSync(directory)).toBe(true);
    expect(readFileSync(join(directory, 'lease'), 'utf8')).toBe(replacement);
  } finally {
    child.kill('SIGKILL');
    await childExit(child);
    rmSync(root, { recursive: true, force: true });
  }
});

test('an old cleanup after a new acquisition leaves the new owner in place', () => {
  const root = workspace();
  try {
    const directory = join(root, 'slot');
    const first = tryAcquireDirectoryLease(directory);
    expect(first).not.toBe('held');
    if (first === 'held') return;
    rmSync(directory, { recursive: true, force: true });
    const second = tryAcquireDirectoryLease(directory);
    expect(second).not.toBe('held');
    if (second === 'held') return;
    first.release();
    expect(existsSync(directory)).toBe(true);
    expect(JSON.parse(readFileSync(join(directory, 'identity.json'), 'utf8')).token).toBe(second.token);
    second.release();
    expect(existsSync(directory)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a descendant that ignores SIGTERM stops within the grace and slots release only after that', async () => {
  const root = workspace();
  const grandPath = join(root, 'grand');
  const queue = join(root, 'queue.json');
  writeFileSync(queue, 'waiting');
  const slot = tryAcquireDirectoryLease(join(root, 'slot'));
  expect(slot).not.toBe('held');
  if (slot === 'held') return;
  const script = `
    const { spawn } = require('node:child_process');
    const { writeFileSync } = require('node:fs');
    process.on('SIGTERM', () => {});
    const grand = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 500);'],
      { stdio: 'ignore' });
    writeFileSync(process.env.GRAND, String(grand.pid));
    setInterval(() => {}, 500);
  `;
  const child = spawn(process.execPath, ['-e', script], {
    detached: true, stdio: 'ignore', env: { ...process.env, GRAND: grandPath },
  });
  try {
    await waitFor(grandPath);
    const grand = Number(readFileSync(grandPath, 'utf8'));
    const started = Date.now();
    let released = false;
    const finished = (async () => {
      await terminateProcessGroup(child.pid!, { graceMs: 400 });
      expect(processAlive({ pid: child.pid! })).toBe(false);
      expect(processAlive({ pid: grand })).toBe(false);
      expect(existsSync(slot.directory)).toBe(true);
      expect(existsSync(queue)).toBe(true);
      slot.release();
      rmSync(queue);
      released = true;
    })();
    await Bun.sleep(120);
    expect(released).toBe(false);
    expect(processAlive({ pid: child.pid! })).toBe(true);
    expect(processAlive({ pid: grand })).toBe(true);
    expect(existsSync(slot.directory)).toBe(true);
    expect(existsSync(queue)).toBe(true);
    await finished;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(existsSync(slot.directory)).toBe(false);
    expect(existsSync(queue)).toBe(false);
  } finally {
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already stopped */ }
    }
    child.unref();
    rmSync(root, { recursive: true, force: true });
  }
});
