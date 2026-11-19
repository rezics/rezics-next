import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

test('all importer CLI credential outcomes pass with the real CLI', async () => {
  const suite = resolve(import.meta.dir, '../../../specs/imports-cli-credentials.test.ts');
  const driver = resolve(import.meta.dir, 'cli-credentials-driver.ts');
  const count = readFileSync(suite, 'utf8').match(/^test\(/gm)?.length ?? 0;
  expect(count).toBeGreaterThan(0);
  // Keep the credential checks on real SQLite files without charging disk flush latency to token renewal.
  const directory = await mkdtemp('/dev/shm/importer-credentials-');
  try {
    const child = Bun.spawn([process.execPath, 'test', '--timeout', '30000', suite], {
      cwd: import.meta.dir,
      env: { ...process.env, TMPDIR: directory, IMPORT_CLI_CREDENTIALS_DRIVER: driver },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const output = stdout + stderr;
    if (code !== 0) console.error(output);
    expect(code).toBe(0);
    expect(output).toMatch(new RegExp(`^\\s*${count} pass$`, 'm'));
    expect(output).toMatch(/^\s*0 fail$/m);
    expect(output).not.toMatch(/^\s*[1-9]\d* (skip|todo)$/m);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
