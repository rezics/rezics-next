import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { acquireDirectoryLease } from './worker-lease.ts';
import { processIdentity, sameProcess, terminateProcessGroup, waitForProcess } from './process.ts';
import { tempDirectory } from './worker-test-support.ts';

test('directory leases refuse a live owner, reclaim a dead identity and never let old cleanup drop a successor', () => {
  const root = tempDirectory(), directory = join(root, 'lease');
  try {
    const first = acquireDirectoryLease(directory);
    expect(() => acquireDirectoryLease(directory)).toThrow('held');
    first.release();
    const second = acquireDirectoryLease(directory); first.release();
    expect(() => acquireDirectoryLease(directory)).toThrow('held'); second.release();
    mkdirSync(directory);
    const identity = processIdentity(process.pid)!;
    writeFileSync(join(directory, 'owner.json'), JSON.stringify({ token: 'stale', process: { ...identity, start: '0' } }));
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

test('stale reclamation leases are themselves recoverable after a controller crash', () => {
  const root = tempDirectory(), directory = join(root, 'lease');
  try {
    const identity = { ...processIdentity(process.pid)!, start: '0' };
    for (const path of [directory, `${directory}.reclaim`]) {
      mkdirSync(path); writeFileSync(join(path, 'owner.json'), JSON.stringify({ token: 'dead', process: identity }));
    }
    acquireDirectoryLease(directory).release();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
