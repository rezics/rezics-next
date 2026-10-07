import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { legacyHostJenaGateFiles, ownerGateFiles, testArgs, testExclusions, unitHarnessFiles, unitOwnerFiles } from '../../../scripts/qa/acceptance.ts';
import { expandTestPaths, isolatedIntegrationFiles, planStackProjects, selfManagedFaultFiles, splitTestArgs } from '../../../scripts/qa/core.ts';

const root = resolve(import.meta.dir, '../../..');

test('migrated Main runtime fixtures stay registered in the integration tier and receive independent projects', () => {
  const integration = ['edit', 'outbox'].map(name => `services/main/tests/${name}.integration.test.ts`);
  const blocked = ['activate', 'recovery'].map(name => `services/main/tests/${name}.integration.test.ts`);
  const owners = ownerGateFiles(root);
  const units = unitOwnerFiles(root);
  for (const file of [...integration, ...blocked]) {
    expect(owners).not.toContain(file);
    expect(units).not.toContain(file);
    for (const tier of ['unit', 'owner', 'model'] as const) {
      expect(() => testArgs(tier, undefined, { files: [file] })).toThrow('not registered');
    }
  }
  for (const file of integration) {
    expect(legacyHostJenaGateFiles as readonly string[]).not.toContain(file);
    expect(testExclusions.some(item => item.file === file)).toBe(false);
    expect(testArgs('integration')).toContain(file);
    expect(testArgs('integration', undefined, { files: [file] })).toEqual([file]);
    expect(() => testArgs('fault/recovery', undefined, { files: [file] })).toThrow('not registered');
    expect(isolatedIntegrationFiles.has(file)).toBe(true);
  }
  const shared = 'tests/qa/integration/shared-stack.test.ts';
  const integrationProjects = planStackProjects(new Map([
    [shared, 1], ...integration.map(file => [file, 10] as const),
  ]), 2, 'integration');
  expect(integrationProjects).toHaveLength(3);
  for (const file of [shared, ...integration]) expect(integrationProjects).toContainEqual([file]);

  // Activation and recovery assert contracts the product contradicts: they run in no tier.
  for (const file of blocked) {
    expect(legacyHostJenaGateFiles as readonly string[]).toContain(file);
    expect(testExclusions.some(item => item.file === file)).toBe(true);
    expect(isolatedIntegrationFiles.has(file)).toBe(false);
    expect(selfManagedFaultFiles.has(file)).toBe(false);
    for (const tier of ['integration', 'fault/recovery'] as const) {
      expect(testArgs(tier)).not.toContain(file);
      expect(() => testArgs(tier, undefined, { files: [file] })).toThrow('not registered');
    }
  }
});

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
    const unit = 'apps/web/tests/nested/behavior.test.tsx';
    const service = 'services/main/tests/resource.test.ts';
    const retained = 'services/main/tests/context-schema.test.ts';
    const script = 'scripts/static/contract.test.ts';
    const packageFile = 'packages/document/tests/checker.test.ts';
    for (const file of [unit, service, retained, 'services/main/tests/unregistered.integration.test.ts', 'services/main/tests/unregistered.integration.test.tsx',
      'model/tests/daily-rating.test.ts', 'apps/web/node_modules/dependency.test.ts', script, packageFile]) {
      mkdirSync(dirname(join(fixture, file)), { recursive: true });
      writeFileSync(join(fixture, file), '');
    }
    expect(unitOwnerFiles(fixture)).toEqual([unit, retained]);
    expect(ownerGateFiles(fixture)).toEqual([packageFile, script, service]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
