import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { planControlPlaneChecks, selectControlPlaneCheckPlan } from './control-plane-check-plan.ts';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
  return result.stdout.trim();
}

const baseFiles = new Map([
  ['tools/goal/src/hourly-ledger.ts', 'export const readLedger = () => 1;'],
  [
    'tools/goal/src/hourly-report.ts',
    "import { readLedger } from './hourly-ledger.ts';\nexport const report = () => readLedger();",
  ],
  ['tools/goal/src/hourly-report.test.ts', "import { report } from './hourly-report.ts';\nvoid report;"],
  ['tools/goal/src/provider-fixture.test.ts', "import { provider } from './provider.ts';\nvoid provider;"],
  ['tools/goal/src/provider.ts', 'export const provider = () => 1;'],
  ['tools/goal/src/workspace-fixture.test.ts', "import { workspace } from './workspace.ts';\nvoid workspace;"],
  ['tools/goal/src/workspace.ts', 'export const workspace = {};'],
  ['tools/goal/src/release-contract.d.ts', 'export type Release = { candidate: string };'],
  [
    'tools/goal/src/release-consumer.ts',
    "import type { Release } from './release-contract.d.ts';\n" +
      'export const consume = (value: Release) => value.candidate;',
  ],
  [
    'tools/goal/src/release-consumer.test.ts',
    "import { consume } from './release-consumer.ts';\nvoid consume;",
  ],
  ['tools/goal/src/extra.test.ts', 'test("changed", () => {});'],
  ['tools/goal/src/test-support.ts', 'export const fixture = {};'],
  ['tools/goal/src/launch-smoke.ts', 'export const launch = () => true;'],
  ['tools/goal/src/orphan.ts', 'export const isolated = true;'],
  ['tools/goal/defaults.json', '{"policy":{}}'],
  ['tools/goal/package.json', '{"name":"@rezics/goal"}'],
]);

function plan(changedPaths: readonly string[], candidate = 'final-candidate') {
  return selectControlPlaneCheckPlan({
    base: 'captured-main',
    candidate,
    changedPaths,
    trackedFiles: [...baseFiles.keys()],
    readFile: (path) => baseFiles.get(path),
  });
}

test('a ledger-only candidate selects report consumers without unrelated provider or workspace fixtures', () => {
  const result = plan(['tools/goal/src/hourly-ledger.ts']);

  expect(result).toMatchObject({
    base: 'captured-main',
    candidate: 'final-candidate',
    scope: 'affected',
    tests: ['tools/goal/src/hourly-report.test.ts'],
  });
  expect(result.tests).not.toContain('tools/goal/src/provider-fixture.test.ts');
  expect(result.tests).not.toContain('tools/goal/src/workspace-fixture.test.ts');
  expect(result.reasons.join('\n')).toContain('candidate source impact selected tests');
});

test('generated interfaces follow consumers, keep changed tests, and bind the final candidate', () => {
  const repairedCandidate = 'repaired-final-candidate';
  const result = plan(
    ['tools/goal/src/release-contract.d.ts', 'tools/goal/src/extra.test.ts'],
    repairedCandidate,
  );

  expect(result).toMatchObject({
    base: 'captured-main',
    candidate: repairedCandidate,
    scope: 'affected',
    tests: ['tools/goal/src/extra.test.ts', 'tools/goal/src/release-consumer.test.ts'],
  });
  expect(result.reasons.join('\n')).toContain('Generated interface consumers followed');
  expect(result.reasons.join('\n')).toContain('Changed Goal tests retained');
});

test('toolchain, configuration, fixture, lifecycle, and unresolved impact widen with reasons', () => {
  const cases = [
    ['tools/goal/package.json', 'shared toolchain change'],
    ['tools/goal/defaults.json', 'configuration change'],
    ['tools/goal/src/test-support.ts', 'shared fixture or harness change'],
    ['tools/goal/src/launch-smoke.ts', 'lifecycle change'],
    ['tools/goal/src/orphan.ts', 'unresolved dependency impact'],
  ] as const;
  const allTests = [...baseFiles.keys()].filter((path) => /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path)).sort();

  for (const [path, reason] of cases) {
    const result = plan([path]);
    expect(result.scope).toBe('all');
    expect(result.tests).toEqual(allTests);
    expect(result.reasons.join('\n')).toContain(reason);
  }
});

test('documentation-only changes keep Goal typing and release lifecycle proof without scheduling tests', () => {
  expect(plan(['tools/goal/README.md'])).toMatchObject({
    scope: 'none',
    tests: [],
    reasons: ['No Goal test owner changed; typecheck, compatibility and lifecycle proof remain required.'],
  });
});

test('release planning reads changed owners from the captured base to the exact candidate commit', () => {
  const temporaryRoot = join(import.meta.dir, '../../../.temp/goal-tests');
  mkdirSync(temporaryRoot, { recursive: true });
  const cwd = mkdtempSync(join(temporaryRoot, 'control-plane-check-plan-'));
  try {
    git(cwd, 'init');
    git(cwd, 'config', 'user.name', 'Goal check plan test');
    git(cwd, 'config', 'user.email', 'goal-check-plan@example.test');
    const files = new Map([
      ['tools/goal/src/hourly-ledger.ts', 'export const readLedger = () => 1;'],
      [
        'tools/goal/src/hourly-report.ts',
        "import { readLedger } from './hourly-ledger.ts';\nexport const report = () => readLedger();",
      ],
      ['tools/goal/src/hourly-report.test.ts', "import { report } from './hourly-report.ts';\nvoid report;"],
      ['tools/goal/src/provider-fixture.test.ts', 'test("provider fixture", () => {});'],
    ]);
    for (const [path, contents] of files) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), contents);
    }
    git(cwd, 'add', '--', 'tools/goal');
    git(cwd, 'commit', '-m', 'fixture: seed check planning tree');
    const base = git(cwd, 'rev-parse', 'HEAD');
    writeFileSync(join(cwd, 'tools/goal/src/hourly-ledger.ts'), 'export const readLedger = () => 2;');
    git(cwd, 'add', '--', 'tools/goal/src/hourly-ledger.ts');
    git(cwd, 'commit', '-m', 'change: update ledger owner');
    const candidate = git(cwd, 'rev-parse', 'HEAD');

    expect(planControlPlaneChecks(cwd, base, candidate)).toMatchObject({
      base,
      candidate,
      scope: 'affected',
      tests: ['tools/goal/src/hourly-report.test.ts'],
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
