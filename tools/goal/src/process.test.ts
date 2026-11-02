import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { acquireDirectoryLease } from './lease.ts';
import { processIdentity, sameProcess, stopProcessesUnder, terminateProcessGroup, waitForProcess } from './process.ts';
import { tempDirectory } from './test-support.ts';

test('directory leases refuse a live owner, reclaim a dead identity and never let old cleanup drop a successor', () => {
  const root = tempDirectory(),
    directory = join(root, 'lease');
  try {
    const first = acquireDirectoryLease(directory);
    expect(() => acquireDirectoryLease(directory)).toThrow('Lease held');
    first.release();
    const second = acquireDirectoryLease(directory);
    first.release();
    expect(() => acquireDirectoryLease(directory)).toThrow('Lease held');
    second.release();
    mkdirSync(directory);
    const identity = processIdentity(process.pid)!;
    writeFileSync(join(directory, 'stale.json'), JSON.stringify({ ...identity, token: 'stale', start: '0' }));
    const reclaimed = acquireDirectoryLease(directory);
    expect(reclaimed).toBeDefined();
    reclaimed.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('PID start time and boot identity fence PID reuse; SIGKILL removes an uncooperative detached worker', async () => {
  const child = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once('data', () => resolve());
    child.once('error', reject);
  });
  const identity = processIdentity(child.pid!)!;
  try {
    expect(sameProcess({ ...identity, start: '0' })).toBe(false);
    expect(sameProcess({ ...identity, boot: 'other-boot' })).toBe(false);
    await expect(terminateProcessGroup({ ...identity, start: '0' }, 20)).rejects.toThrow('identity changed');
    expect(sameProcess(identity)).toBe(true);
    const gone = waitForProcess(identity);
    await terminateProcessGroup(identity, 30);
    await gone;
    expect(sameProcess(identity)).toBe(false);
  } finally {
    await terminateProcessGroup(identity, 20);
  }
});
test('a server that left its group is stopped by its working directory, and processes elsewhere are spared', async () => {
  const root = tempDirectory(),
    inside = join(root, 'worktree', 'apps', 'web'),
    outside = join(root, 'other'),
    proc = join(root, 'proc');
  mkdirSync(inside, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const start = async (cwd: string, script: string) => {
    const child = spawn(process.execPath, ['-e', `${script}; console.log('ready'); setInterval(() => {}, 1000)`], {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once('data', () => resolve());
      child.once('error', reject);
    });
    return processIdentity(child.pid!)!;
  };
  const server = await start(inside, '');
  const stubborn = await start(inside, "process.on('SIGTERM', () => {})");
  const elsewhere = await start(outside, '');
  try {
    const bootFile = join(proc, 'sys/kernel/random/boot_id');
    mkdirSync(join(proc, 'sys/kernel/random'), { recursive: true });
    writeFileSync(bootFile, server.boot);
    for (const [identity, cwd] of [[server, inside], [stubborn, inside], [elsewhere, outside]] as const) {
      const entry = join(proc, String(identity.pid));
      mkdirSync(entry);
      symlinkSync(cwd, join(entry, 'cwd'));
      const fields = ['S', '1', String(identity.group), ...Array(16).fill('0'), identity.start];
      writeFileSync(join(entry, 'stat'), `${identity.pid} (owned) ${fields.join(' ')}`);
    }
    expect(await stopProcessesUnder(join(root, 'worktree'), 100, proc)).toBe(2);
    expect(sameProcess(server)).toBe(false);
    expect(sameProcess(stubborn)).toBe(false);
    expect(sameProcess(elsewhere)).toBe(true);
    rmSync(join(proc, String(server.pid)), { recursive: true });
    rmSync(join(proc, String(stubborn.pid)), { recursive: true });
    expect(await stopProcessesUnder(join(root, 'worktree'), 100, proc)).toBe(0);
  } finally {
    for (const identity of [server, stubborn, elsewhere]) await terminateProcessGroup(identity, 20);
    rmSync(root, { recursive: true, force: true });
  }
});
test('worktree cleanup skips vanished proc entries but reports unreadable cwd inspection', async () => {
  const root = tempDirectory(),
    proc = join(root, 'proc');
  mkdirSync(join(proc, '42001'), { recursive: true });
  mkdirSync(join(proc, '42002'));
  writeFileSync(join(proc, '42002', 'cwd'), 'not a symlink');
  try {
    await expect(stopProcessesUnder(join(root, 'worktree'), 0, proc)).rejects.toMatchObject({
      message: expect.stringContaining('PID 42002'),
      cause: { code: 'EINVAL' },
    });
    rmSync(join(proc, '42002'), { recursive: true });
    await expect(stopProcessesUnder(join(root, 'worktree'), 0, proc)).resolves.toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('a failing pidfd waiter falls back to the identity and resolves only once the process is gone', async () => {
  const root = tempDirectory(),
    bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'python3'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const child = spawn(process.execPath, ['-e', "console.log('ready'); setTimeout(() => {}, 300)"], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once('data', () => resolve());
    child.once('error', reject);
  });
  const identity = processIdentity(child.pid!)!;
  const path = process.env.PATH;
  try {
    process.env.PATH = `${bin}:${path}`;
    const started = Date.now();
    await waitForProcess(identity);
    process.env.PATH = path;
    expect(sameProcess(identity)).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  } finally {
    process.env.PATH = path;
    await terminateProcessGroup(identity, 20).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

import { spyOn } from 'bun:test';
test('a reused leader PID with an empty recorded group permits recovery without signalling the unrelated process', async () => {
  const child = spawn(process.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1000)"], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once('data', () => resolve());
    child.once('error', reject);
  });
  const unrelated = processIdentity(child.pid!)!;
  const stale = { ...unrelated, start: '0', group: unrelated.pid };
  try {
    expect(stale.group).not.toBe(unrelated.group);
    await expect(terminateProcessGroup(stale, 20)).resolves.toBeUndefined();
    expect(sameProcess(unrelated)).toBe(true);
  } finally {
    child.kill('SIGKILL');
    await waitForProcess(unrelated);
  }
});
test('a reused leader with a surviving detached group is refused without signalling its member', async () => {
  const child = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once('data', () => resolve());
    child.once('error', reject);
  });
  const identity = processIdentity(child.pid!)!;
  try {
    await expect(terminateProcessGroup({ ...identity, start: '0' }, 20)).rejects.toThrow(
      'process identity changed; refusing to signal reused PID',
    );
    expect(sameProcess(identity)).toBe(true);
  } finally {
    await terminateProcessGroup(identity, 20);
  }
});
test('a reused leader with an ambiguous group inspection is fenced without signalling the unrelated process', async () => {
  const child = spawn(process.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1000)"], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once('data', () => resolve());
    child.once('error', reject);
  });
  const unrelated = processIdentity(child.pid!)!;
  const stale = { ...unrelated, start: '0', group: unrelated.pid };
  const kill = process.kill.bind(process);
  const killSpy = spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === -stale.group && signal === 0)
      throw Object.assign(new Error('group inspection denied'), { code: 'EPERM' });
    return kill(pid, signal);
  });
  try {
    await expect(terminateProcessGroup(stale, 20)).rejects.toThrow('visibility unknown');
    expect(killSpy).toHaveBeenCalledWith(-stale.group, 0);
    expect(sameProcess(unrelated)).toBe(true);
  } finally {
    killSpy.mockRestore();
    child.kill('SIGKILL');
    await waitForProcess(unrelated);
  }
});
