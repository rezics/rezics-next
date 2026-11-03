import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cleanTemporaryEntries, ownedTemporaryDirectory } from './tmp-janitor.ts';
import { fixturePool, harness, temporaryDirectory } from '../tools/goal/src/test-support.ts';
import { workerEnvironment } from '../tools/goal/src/launch.ts';
import { processGroupRunner } from '../tools/goal/src/merge.ts';

const agedNow = () => Date.now() + 3 * 24 * 60 * 60 * 1000;

test('janitor removes stale known entries, preserving recent, unknown and symlink entries', () => {
  const t = temporaryDirectory();
  const stale = ['.abc123-0.hm', 'node-compile-cache', 'goal-rollout-old', 'rezics-producer-lifecycle-old', '.tmpAb1234', 'playwright_chromiumdev_profile-old'];
  for (const name of stale) {
    const path = join(t.path, name);
    if (name.endsWith('.hm')) writeFileSync(path, '');
    else { mkdirSync(path); writeFileSync(join(path, 'file'), 'fixture'); }
  }
  writeFileSync(join(t.path, 'unrelated'), 'keep');
  symlinkSync(join(t.path, 'unrelated'), join(t.path, 'goal-db-link'));
  expect(cleanTemporaryEntries({ root: t.path }).removed).toEqual([]);
  const preview = cleanTemporaryEntries({ root: t.path, now: agedNow(), dryRun: true });
  expect(preview.errors).toEqual([]);
  expect(preview.removed.map((path) => path.slice(t.path.length + 1)).sort()).toEqual(stale.sort());
  expect(existsSync(join(t.path, stale[0]!))).toBe(true);
  const result = cleanTemporaryEntries({ root: t.path, now: agedNow() });
  expect(result.errors).toEqual([]);
  expect(readdirSync(t.path).sort()).toEqual(['goal-db-link', 'unrelated']);
  expect(cleanTemporaryEntries({ root: t.path, now: agedNow() }).removed).toEqual([]);
});

test('live cwd, descriptors, hard links and mappings reserve stale trees until released', () => {
  const t = temporaryDirectory();
  const busy = join(t.path, 'goal-db-live');
  mkdirSync(busy);
  const file = join(busy, 'open');
  writeFileSync(file, 'mapped');
  const alias = join(t.path, '.ab12-0.hm');
  linkSync(file, alias);
  const fd = openSync(file, 'r');
  const previous = process.cwd();
  try {
    process.chdir(busy);
    expect(cleanTemporaryEntries({ root: t.path, now: agedNow() }).removed).toEqual([]);
  } finally { process.chdir(previous); closeSync(fd); }
  // mmap must remain protected after the creating descriptor has closed.
  const mapped = Bun.mmap(file);
  expect(cleanTemporaryEntries({ root: t.path, now: agedNow() }).removed).toEqual([]);
  expect(mapped.toString()).toBe('mapped');
});

test('scratch removal handles read-only trees without following links', () => {
  const t = temporaryDirectory();
  const owned = ownedTemporaryDirectory(t.path, 'owned-');
  const nested = join(owned.path, 'readonly');
  mkdirSync(nested);
  writeFileSync(join(nested, 'file'), '');
  writeFileSync(join(t.path, 'keep'), 'keep');
  symlinkSync(t.path, join(nested, 'outside'));
  chmodSync(join(nested, 'file'), 0o444);
  chmodSync(nested, 0o500);
  chmodSync(owned.path, 0o500);
  owned.close(); owned.close();
  expect(existsSync(owned.path)).toBe(false);
  expect(existsSync(join(t.path, 'keep'))).toBe(true);
  const h = harness();
  chmodSync(join(h.root, 'scripts'), 0o500);
  h.dispose();
  expect(existsSync(h.root)).toBe(false);
});

test('a failing test cleans forgotten fixture trees and its invocation scratch directory', () => {
  const t = temporaryDirectory();
  const support = resolve(import.meta.dir, '../tools/goal/src/test-support.ts');
  const preload = resolve(import.meta.dir, '../tools/goal/src/test-environment.ts');
  writeFileSync(join(t.path, 'bunfig.toml'), `[test]\npreload = [${JSON.stringify(preload)}]\n`);
  writeFileSync(join(t.path, 'failure.test.ts'), `
    import { test } from 'bun:test';
    import { writeFileSync, chmodSync } from 'node:fs';
    import { temporaryDirectory } from ${JSON.stringify(support)};
    test('failure', () => {
      const t = temporaryDirectory();
      writeFileSync('paths.json', JSON.stringify([t.path, process.env.TMPDIR]));
      chmodSync(t.path, 0o500);
      throw new Error('intentional fixture failure');
    });
  `);
  const result = spawnSync(process.execPath, ['test', './failure.test.ts'], { cwd: t.path, encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('intentional fixture failure');
  const paths = JSON.parse(require('node:fs').readFileSync(join(t.path, 'paths.json'), 'utf8')) as string[];
  expect(paths.every((path) => !existsSync(path))).toBe(true);
});

test('workers and gates confine child runtime scratch and disable Node compile caching', async () => {
  const t = temporaryDirectory();
  const environment = workerEnvironment(fixturePool(), {}, process.env, t.path);
  expect(environment.TMPDIR).toBe(join(t.path, '.temp/worker-tmp'));
  expect(environment.NODE_DISABLE_COMPILE_CACHE).toBe('1');
  expect(environment.NODE_COMPILE_CACHE).toBe('');
  const runner = processGroupRunner();
  const result = await runner([process.execPath, '-e', `
    const fs = require('node:fs');
    fs.writeFileSync(process.env.TMPDIR + '/runtime-marker', '');
    console.log(JSON.stringify([process.env.TMPDIR, process.env.NODE_DISABLE_COMPILE_CACHE]));
  `], t.path, join(t.path, 'gate.log'));
  expect(result.passed).toBe(true);
  const [scratch, disabled] = JSON.parse(result.output.trim());
  expect(scratch.startsWith(join(t.path, '.temp/gate-tmp-'))).toBe(true);
  expect(disabled).toBe('1');
  expect(existsSync(scratch)).toBe(false);
  // Simulate a day's repeated runs: only the currently owned run occupies scratch entries.
  for (let hour = 0; hour < 24; hour++) {
    const run = ownedTemporaryDirectory(join(t.path, 'runs'), 'run-');
    for (let index = 0; index < 20; index++) writeFileSync(join(run.path, `.${index.toString(16)}-0.hm`), '');
    run.close();
    expect(readdirSync(join(t.path, 'runs'))).toEqual([]);
  }
});
