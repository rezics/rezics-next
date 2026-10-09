import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { enforceChildDeadline } from '../src/infrastructure/child-deadline.ts';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A child that stays up after SIGTERM, then yields once its handler is installed. */
async function stubbornChild(): Promise<{
  child: Bun.Subprocess;
  cleanup: () => Promise<void>;
}> {
  const root = resolve(import.meta.dir, '../../../.temp');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'child-deadline-'));
  const ready = join(directory, 'ready');
  const script = join(directory, 'ignore-sigterm.ts');
  writeFileSync(
    script,
    `process.on('SIGTERM', () => {});\nawait Bun.write(${JSON.stringify(ready)}, '1');\nsetInterval(() => {}, 1_000_000_000);\n`,
  );
  const child = Bun.spawn([process.execPath, '--no-env-file', script], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const cleanup = async () => {
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
    rmSync(directory, { recursive: true, force: true });
  };
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      if ((await Bun.file(ready).text()) === '1') return { child, cleanup };
    } catch {
      // The child has not installed its handler yet.
    }
    await Bun.sleep(5);
  }
  await cleanup();
  throw new Error('child did not install its SIGTERM handler');
}

test('a child that ignores SIGTERM is killed at the deadline', async () => {
  const { child, cleanup } = await stubbornChild();
  const timeoutMs = 500;
  const armed = performance.now();
  const deadline = enforceChildDeadline(child, timeoutMs);
  try {
    process.kill(child.pid, 'SIGTERM');
    await Bun.sleep(50);
    expect(alive(child.pid)).toBe(true);
    await child.exited;
    const elapsed = performance.now() - armed;
    expect(deadline.expired).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 50);
    expect(elapsed).toBeLessThan(3_000);
    expect(alive(child.pid)).toBe(false);
  } finally {
    await deadline.release();
    await cleanup();
  }
}, 10_000);

test('an abort kills a child that ignores SIGTERM at once', async () => {
  const { child, cleanup } = await stubbornChild();
  const controller = new AbortController();
  const deadline = enforceChildDeadline(child, 10_000, controller.signal);
  try {
    process.kill(child.pid, 'SIGTERM');
    await Bun.sleep(50);
    expect(alive(child.pid)).toBe(true);
    const aborted = performance.now();
    controller.abort();
    await child.exited;
    expect(performance.now() - aborted).toBeLessThan(1_000);
    expect(deadline.expired).toBe(false);
    expect(alive(child.pid)).toBe(false);
  } finally {
    await deadline.release();
    await cleanup();
  }
}, 10_000);
