import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireDirectoryLease } from './lease.ts';
import { processIdentity, sameProcess } from './process.ts';
import { temporaryDirectory } from './test-support.ts';

test('identity rejects pid reuse, reboot and zombies', () => {
  const t = temporaryDirectory();
  try {
    mkdirSync(join(t.path, '7'));
    mkdirSync(join(t.path, 'sys/kernel/random'), { recursive: true });
    writeFileSync(join(t.path, 'sys/kernel/random/boot_id'), 'boot');
    const fields = ['S', '1', '1', ...Array(16).fill('0'), '123'];
    writeFileSync(join(t.path, '7/stat'), `7 (name with (parentheses)) ${fields.join(' ')}`);
    expect(processIdentity(7, t.path)).toEqual({ pid: 7, start: '123', boot: 'boot', group: 1 });
    fields[0] = 'Z';
    writeFileSync(join(t.path, '7/stat'), `7 (zombie) ${fields.join(' ')}`);
    expect(processIdentity(7, t.path)).toBeNull();
    expect(sameProcess({ ...processIdentity()!, start: 'other' })).toBe(false);
    expect(sameProcess({ ...processIdentity()!, boot: 'other' })).toBe(false);
  } finally {
    t.close();
  }
});

test('lease excludes live owners, reclaims a dead incarnation and release cannot remove a successor', () => {
  const t = temporaryDirectory();
  try {
    const path = join(t.path, 'train.lease');
    const lease = acquireDirectoryLease(path);
    expect(() => acquireDirectoryLease(path)).toThrow('Lease held');
    const tokenFile = readdirSync(path)[0]!;
    writeFileSync(
      join(path, tokenFile),
      JSON.stringify({ ...processIdentity()!, start: 'previous incarnation', token: tokenFile.slice(0, -5) }),
    );
    const successor = acquireDirectoryLease(path);
    lease.release();
    expect(() => acquireDirectoryLease(path)).toThrow('Lease held');
    successor.release();
    const final = acquireDirectoryLease(path);
    final.release();
  } finally {
    t.close();
  }
});

test('two separate processes cannot both acquire a train lease', async () => {
  const t = temporaryDirectory();
  const source = `import { acquireDirectoryLease } from ${JSON.stringify(join(import.meta.dir, 'lease.ts'))};
    try {
      const lease = acquireDirectoryLease(process.env.TEST_LEASE!); console.log('acquired');
      await new Promise(resolve => process.stdin.once('data', resolve)); lease.release();
    } catch { console.log('held'); }`;
  const children = [0, 1].map(() =>
    Bun.spawn([process.execPath, '-e', source], {
      env: { ...process.env, TEST_LEASE: join(t.path, 'train.lease') },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }),
  );
  try {
    const messages = await Promise.all(
      children.map(async (child) => {
        const reader = child.stdout.getReader();
        const first = await reader.read();
        reader.releaseLock();
        return new TextDecoder().decode(first.value).trim();
      }),
    );
    expect(messages.sort()).toEqual(['acquired', 'held']);
    for (const child of children) {
      child.stdin.write('stop\n');
      child.stdin.end();
    }
    await Promise.all(children.map((child) => child.exited));
  } finally {
    for (const child of children) child.kill();
    t.close();
  }
});

test('concurrent dispatch processes wait for the lifecycle lease to be released', async () => {
  const t = temporaryDirectory();
  const source = `import { acquireDirectoryLeaseWaiting } from ${JSON.stringify(join(import.meta.dir, 'lease.ts'))};
    const lease = acquireDirectoryLeaseWaiting(process.env.TEST_LEASE!, 5000); console.log('acquired');
    await new Promise(resolve => setTimeout(resolve, Number(process.env.HOLD_MS)));
    lease.release();`;
  const env = { ...process.env, TEST_LEASE: join(t.path, 'dispatch.lease') };
  const first = Bun.spawn([process.execPath, '-e', source], {
    env: { ...env, HOLD_MS: '1100' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let second: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const firstReader = first.stdout.getReader();
    const started = await firstReader.read();
    firstReader.releaseLock();
    expect(new TextDecoder().decode(started.value).trim()).toBe('acquired');
    second = Bun.spawn([process.execPath, '-e', source], {
      env: { ...env, HOLD_MS: '0' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const secondOutput = second.stdout;
    if (!secondOutput || typeof secondOutput === 'number') throw new Error('second process stdout was not piped');
    const secondReader = secondOutput.getReader();
    const acquired = await secondReader.read();
    secondReader.releaseLock();
    expect(new TextDecoder().decode(acquired.value).trim()).toBe('acquired');
    expect(await first.exited).toBe(0);
    expect(await second.exited).toBe(0);
  } finally {
    first.kill();
    second?.kill();
    t.close();
  }
});

test('Initialization failures preserve their cause and remove only the failed acquisition\'s own temporary directory.', () => {
  const t = temporaryDirectory();
  try {
    const live = join(t.path, 'train.lease');
    const lease = acquireDirectoryLease(live);
    const foreign = join(t.path, 'foreign.initializing');
    mkdirSync(foreign);
    writeFileSync(join(foreign, 'keep.json'), '{}');
    const write = fs.writeFileSync;
    const cause = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    const blocked = spyOn(fs, 'writeFileSync').mockImplementation(((path: unknown, data: unknown, options?: unknown) => {
      if (String(path).startsWith(t.path) && String(path).includes('.initializing')) throw cause;
      return write(path as never, data as never, options as never);
    }) as typeof fs.writeFileSync);
    try {
      let thrown: unknown;
      try {
        acquireDirectoryLease(join(t.path, 'other.lease'));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(cause);
      expect(readdirSync(t.path).sort()).toEqual(['foreign.initializing', 'train.lease']);
      expect(readdirSync(live)[0]).toBeDefined();
      expect(readdirSync(foreign)).toEqual(['keep.json']);
    } finally {
      blocked.mockRestore();
      lease.release();
    }
  } finally {
    t.close();
  }
});
