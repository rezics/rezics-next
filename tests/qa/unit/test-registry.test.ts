import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ownerGateFiles, testArgs, testExclusions, unitHarnessFiles, unitOwnerFiles } from '../../../scripts/qa/acceptance.ts';
import { expandTestPaths, splitTestArgs } from '../../../scripts/qa/core.ts';

const root = resolve(import.meta.dir, '../../..');

test('every tracked Bun test belongs to a full QA tier or a reasoned exclusion', () => {
  const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  expect(tracked.status).toBe(0);
  const files = tracked.stdout.split('\0').filter(file => /\.test\.tsx?$/.test(file));
  const registered = new Set(unitHarnessFiles);
  for (const tier of ['unit', 'owner', 'integration', 'model', 'fault/recovery', 'load'] as const) {
    const paths = splitTestArgs(testArgs(tier)).paths;
    expect(paths, `Duplicate test arguments in ${tier}`).toEqual([...new Set(paths)]);
    for (const file of expandTestPaths(root, paths)) registered.add(file);
  }
  const exclusions = new Map(testExclusions.map(item => [item.file, item.reason]));
  expect(exclusions.size).toBe(testExclusions.length);
  for (const [file, reason] of exclusions) {
    expect(reason.trim().length, `Missing exclusion reason: ${file}`).toBeGreaterThan(0);
    expect(files, `Stale exclusion: ${file}`).toContain(file);
    expect(registered.has(file), `Excluded test also registered: ${file}`).toBe(false);
  }
  const missing = files.filter(file => !registered.has(file) && !exclusions.has(file));
  expect(missing, `Tests absent from every full QA tier:\n${missing.join('\n')}`).toEqual([]);
});

test('owner discovery registers nested Bun TSX tests without admitting an unregistered stack test', () => {
  const fixture = mkdtempSync(join(root, '.temp/test-registry-'));
  try {
    for (const directory of ['services', 'model', 'scripts', 'packages', 'apps/web', 'apps/accounts',
      'infra/dev/tests', 'infra/jena/tests']) mkdirSync(join(fixture, directory), { recursive: true });
    const owner = 'services/main/tests/nested/behavior.test.tsx';
    const script = 'scripts/static/contract.test.ts';
    const packageFile = 'packages/document/tests/checker.test.ts';
    for (const file of [owner, 'services/main/tests/unregistered.integration.test.ts',
      'model/tests/daily-rating.test.ts', 'apps/web/node_modules/dependency.test.ts', script, packageFile]) {
      mkdirSync(dirname(join(fixture, file)), { recursive: true });
      writeFileSync(join(fixture, file), '');
    }
    expect(unitOwnerFiles(fixture)).toEqual([owner]);
    expect(ownerGateFiles(fixture)).toEqual([packageFile, script]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
