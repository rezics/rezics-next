import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');

test('a QA test child sees no forced color', async () => {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const directory = mkdtempSync(join(root, '.temp/uncolored-test-child-'));
  const probe = join(directory, 'child.test.ts');
  const seen = join(directory, 'color.json');
  writeFileSync(probe, `import { test } from 'bun:test';
import { writeFileSync } from 'node:fs';
test('record forced color', () => {
  writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.env.FORCE_COLOR ?? null));
});
`);
  // Bun treats a path without "./" as a name filter and never loads the probe.
  const file = `./${relative(root, probe)}`;
  try {
    const child = Bun.spawn(['bun', 'scripts/qa/test.ts', file], {
      cwd: root,
      env: { ...process.env, FORCE_COLOR: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
    expect(JSON.parse(readFileSync(seen, 'utf8'))).toBeNull();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
