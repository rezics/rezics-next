import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
test('schema derivation rebuilds every committed dump from a fresh isolated database', async () => {
  const root = resolve(import.meta.dir, '..');
  const paths = () => Array.from(new Bun.Glob('db/**/schema.sql').scanSync({ cwd: root })).sort();
  const before = new Map(paths().map((path) => [path, readFileSync(resolve(root, path))]));
  expect(before.size).toBeGreaterThan(1);
  const chosen = [...before.keys()][0]!;
  try {
    await Bun.write(resolve(root, chosen), '-- corrupt fixture: schema mode must rebuild this file\n');
    const child = Bun.spawn([process.execPath, 'run', 'derived', 'schema'], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: 'postgres://invalid:invalid@127.0.0.1:1/not_the_dev_database' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`schema derivation exited ${code}: ${out} ${err}`);
    expect(paths()).toEqual([...before.keys()]);
    for (const [path, bytes] of before) expect(readFileSync(resolve(root, path)).equals(bytes)).toBe(true);
  } finally {
    for (const [path, bytes] of before) await Bun.write(resolve(root, path), bytes);
  }
}, 180000);
