import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { acquireDirectoryLease } from './lease.ts';
import { processIdentity, sameProcess, stopProcessesUnder, terminateProcessGroup, waitForProcess } from './process.ts';
import { tempDirectory } from './test-support.ts';

test('directory leases refuse a live owner, reclaim a dead identity and never let old cleanup drop a successor', () => {
  const root = tempDirectory(), directory = join(root, 'lease');
  try {
    const first = acquireDirectoryLease(directory);
    expect(() => acquireDirectoryLease(directory)).toThrow('Lease held');
    first.release();
    const second = acquireDirectoryLease(directory); first.release();
    expect(() => acquireDirectoryLease(directory)).toThrow('Lease held'); second.release();
    mkdirSync(directory);
    const identity = processIdentity(process.pid)!;
    writeFileSync(join(directory, 'stale.json'), JSON.stringify({ ...identity, token: 'stale', start: '0' }));
    const reclaimed = acquireDirectoryLease(directory); expect(reclaimed).toBeDefined(); reclaimed.release();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('PID start time and boot identity fence PID reuse; SIGKILL removes an uncooperative detached worker', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise<void>((resolve, reject) => { child.stdout!.once('data', () => resolve()); child.once('error', reject); });
  const identity = processIdentity(child.pid!)!;
  try {
    expect(sameProcess({ ...identity, start: '0' })).toBe(false);
    expect(sameProcess({ ...identity, boot: 'other-boot' })).toBe(false);
    await expect(terminateProcessGroup({ ...identity, start: '0' }, 20)).rejects.toThrow('identity changed');
    expect(sameProcess(identity)).toBe(true);
    const gone = waitForProcess(identity);
    await terminateProcessGroup(identity, 30); await gone;
    expect(sameProcess(identity)).toBe(false);
  } finally { await terminateProcessGroup(identity, 20); }
});
test('a server that left its group is stopped by its working directory, and processes elsewhere are spared', async () => {
  const root = tempDirectory(), inside = join(root, 'worktree', 'apps', 'web'), outside = join(root, 'other');
  mkdirSync(inside, { recursive: true }); mkdirSync(outside, { recursive: true });
  const start = async (cwd: string, script: string) => {
    const child = spawn(process.execPath, ['-e', `${script}; console.log('ready'); setInterval(() => {}, 1000)`], { cwd, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise<void>((resolve, reject) => { child.stdout!.once('data', () => resolve()); child.once('error', reject); });
    return processIdentity(child.pid!)!;
  };
  const server = await start(inside, '');
  const stubborn = await start(inside, "process.on('SIGTERM', () => {})");
  const elsewhere = await start(outside, '');
  try {
    expect(await stopProcessesUnder(join(root, 'worktree'), 100)).toBe(2);
    expect(sameProcess(server)).toBe(false);
    expect(sameProcess(stubborn)).toBe(false);
    expect(sameProcess(elsewhere)).toBe(true);
    expect(await stopProcessesUnder(join(root, 'worktree'), 100)).toBe(0);
  } finally {
    for (const identity of [server, stubborn, elsewhere]) await terminateProcessGroup(identity, 20);
    rmSync(root, { recursive: true, force: true });
  }
});
