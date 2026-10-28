import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { runWorkerCheck } from './worker-check.ts';

const dirs: string[] = [];
afterEach(() => { for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test('worker-check keeps exit status and writes a log plus failure summary with admission disabled', async () => {
  const directory = mkdtempSync('/tmp/worker-check-test-'); dirs.push(directory);
  const old = { ...process.env };
  process.env.REZICS_CHECK_MEMORY = 'off';
  process.env.REZICS_CHECK_MEMORY_DIR = directory;
  process.env.REZICS_CHECK_MEMORY_GIB = '4';
  const out: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    expect(await runWorkerCheck(['bun', '-e', 'console.error("failure marker"); process.exit(7)'])).toBe(7);
  } finally {
    process.stdout.write = write;
    for (const key of ['REZICS_CHECK_MEMORY', 'REZICS_CHECK_MEMORY_DIR', 'REZICS_CHECK_MEMORY_GIB']) {
      if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key];
    }
  }
  expect(out.join('')).toContain('check: exit status 7');
  expect(out.join('')).toContain('failure marker');
  const log = out.join('').match(/check: log (.+)/)?.[1]?.trim();
  expect(log).toBeTruthy();
  expect(readFileSync(log!, 'utf8')).toContain('failure marker');
});
