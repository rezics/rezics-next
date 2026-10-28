import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { runWorkerCheck, startWorkerCheck, waitWorkerCheck } from './worker-check.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function withQuietAdmission<T>(run: () => Promise<T>): Promise<T> {
  const old = { ...process.env };
  process.env.REZICS_CHECK_MEMORY = 'off';
  process.env.REZICS_CHECK_MEMORY_DIR = '/tmp/worker-check-test-memory';
  process.env.REZICS_CHECK_SCOPE = 'off';
  return run().finally(() => {
    for (const key of ['REZICS_CHECK_MEMORY', 'REZICS_CHECK_MEMORY_DIR', 'REZICS_CHECK_SCOPE']) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
  });
}

test('worker-check keeps exit status and writes a log plus failure summary with admission disabled', async () => {
  const directory = mkdtempSync('/tmp/worker-check-test-');
  dirs.push(directory);
  const old = { ...process.env };
  process.env.REZICS_CHECK_MEMORY = 'off';
  process.env.REZICS_CHECK_MEMORY_DIR = directory;
  process.env.REZICS_CHECK_MEMORY_GIB = '4';
  process.env.REZICS_CHECK_SCOPE = 'off';
  const out: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    expect(await runWorkerCheck(['bun', '-e', 'console.error("failure marker"); process.exit(7)'])).toBe(7);
  } finally {
    process.stdout.write = write;
    for (const key of [
      'REZICS_CHECK_MEMORY',
      'REZICS_CHECK_MEMORY_DIR',
      'REZICS_CHECK_MEMORY_GIB',
      'REZICS_CHECK_SCOPE',
    ]) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
  }
  expect(out.join('')).toContain('check: exit status 7');
  expect(out.join('')).toContain('failure marker');
  const log = out
    .join('')
    .match(/check: log (.+)/)?.[1]
    ?.trim();
  expect(log).toBeTruthy();
  expect(readFileSync(log!, 'utf8')).toContain('failure marker');
});

test('a timed out wait can wait again by id and receives the same check result', async () => {
  const directory = mkdtempSync('/tmp/worker-check-rewait-');
  dirs.push(directory);
  await withQuietAdmission(async () => {
    const marker = `${directory}/runs`;
    const id = startWorkerCheck(
      [
        'bun',
        '-e',
        `await Bun.sleep(180); const { openSync, writeSync, closeSync } = await import('node:fs'); const fd = openSync(${JSON.stringify(marker)}, 'wx'); writeSync(fd, 'ran\\n'); closeSync(fd); console.error('completed marker')`,
      ],
      directory,
    );
    await expect(waitWorkerCheck(id, directory, 20)).rejects.toThrow('Wait timed out');
    const out: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await waitWorkerCheck(id, directory)).toBe(0);
    } finally {
      process.stdout.write = write;
    }
    expect(readFileSync(marker, 'utf8')).toBe('ran\n');
    expect(out.join('')).toContain('check: exit status 0');
    expect(out.join('')).toContain('check: log .temp/goal/checks/worker-check-');
  });
});

test('a finished check result remains readable by id after its worker session ends', async () => {
  const directory = mkdtempSync('/tmp/worker-check-finished-');
  dirs.push(directory);
  await withQuietAdmission(async () => {
    const id = startWorkerCheck(['bun', '-e', 'console.error("finished failure marker"); process.exit(9)'], directory);
    // A separate invocation models a retry after the original worker has ended.
    const record = `${directory}/.temp/goal/checks/results/${id}.json`;
    for (
      let attempt = 0;
      attempt < 200 && (!existsSync(record) || !readFileSync(record, 'utf8').includes('"finished"'));
      attempt++
    ) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    expect(readFileSync(record, 'utf8')).toContain('"finished"');
    const out: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await waitWorkerCheck(id, directory)).toBe(9);
    } finally {
      process.stdout.write = write;
    }
    expect(out.join('')).toContain('check: exit status 9');
    expect(out.join('')).toContain('finished failure marker');
    expect(out.join('')).toContain(`check: log .temp/goal/checks/worker-check-`);
  });
});
