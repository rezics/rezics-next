import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { nativeModuleSuiteTest, inputSelectedNativeTests } from './acceptance.ts';
import { planAffected } from './affected.ts';
import { ownerFilesFromPlan } from '../goal/unit-gate.ts';
import { regressionBatchCommand, regressionRegistry } from '../goal/regress.ts';
import { runNativeModuleSuite } from './native-module-suite.ts';
import { nativeModuleTestInvocation } from '../dev/fuseki-image.ts';

const root = resolve(import.meta.dir, '../..');
const dockerfile = readFileSync(join(root, 'infra/jena/Dockerfile'), 'utf8');
const plan = (path: string) => planAffected({ base: 'main', changed: [path], graph: [], sources: new Map(),
  exists: file => inputSelectedNativeTests.includes(file), nativeModuleDockerfile: dockerfile });

test('focused proofs retain the original native suite Maven flags and fixture cache', () => {
  expect(nativeModuleTestInvocation(dockerfile).split(' ')).toEqual([
    '-B', '-ntp', '-DexcludedGroups=com.rezics.jena.ExternalFixture', '-DargLine=-Xmx384m',
    '-DforkCount=1', '-DreuseForks=false',
  ]);
  expect(() => nativeModuleTestInvocation(dockerfile.replace('sharing=locked', 'sharing=shared')))
    .toThrow('unsupported native module-test Maven invocation');
});

test('every Jena edit and generated module input selects the full native suite in the merge gate', () => {
  for (const file of ['infra/jena/Dockerfile', 'infra/jena/patches/ThriftConvert.java',
    'infra/jena/command-module/src/test/java/com/rezics/jena/FailingTest.java',
    'infra/jena/fuseki-text-qa.ttl', 'generated/model/manifest.json', 'generated/model/shapes/new.ttl',
    'services/main/src/modules/query/templates/new.rq']) {
    const affected = plan(file);
    expect(affected.tests.owner).toContain(nativeModuleSuiteTest);
    expect(ownerFilesFromPlan(root, affected)).toContain(nativeModuleSuiteTest);
  }
  expect(plan('docs/development/other.md').tests.owner).not.toContain(nativeModuleSuiteTest);
});

test('wave proof discovers the full native suite exactly once and runs it as a native proof', async () => {
  const registry = await regressionRegistry(root);
  expect(registry.filter(file => file.file === nativeModuleSuiteTest)).toEqual([
    { file: nativeModuleSuiteTest, tier: 'jena:check', outcome: 'pending' },
  ]);
  expect(regressionBatchCommand({ id: 'native-suite', tier: 'jena:check', files: [nativeModuleSuiteTest],
    state: 'pending', attempts: [] }, '/tmp/report.json', '/tmp/report.xml')).toContain(nativeModuleSuiteTest);
});

test('a failing module-test build fails the native proof and preserves Maven failure output', async () => {
  const scratch = join(root, '.temp/native-suite-command-tests');
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, 'failure-'));
  const docker = join(directory, 'docker');
  writeFileSync(docker, '#!/bin/sh\nprintf "%s\\n" "$*"\necho "Tests run: 1, Failures: 1, Errors: 0"\nexit 1\n', { mode: 0o755 });
  try {
    await expect(runNativeModuleSuite(directory, { docker })).rejects.toThrow('Failures: 1');
    const logs = [...new Bun.Glob('.temp/native-module-suite/*.log').scanSync({ cwd: directory })];
    expect(logs).toHaveLength(1);
    expect(readFileSync(join(directory, logs[0]!), 'utf8')).toContain('--target module-test');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
