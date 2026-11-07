import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { controlPlaneChecks } from './merge-train.ts';
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
  ['tools/goal/src/release-consumer.test.ts', "import { consume } from './release-consumer.ts';\nvoid consume;"],
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
  const result = plan(['tools/goal/src/release-contract.d.ts', 'tools/goal/src/extra.test.ts'], repairedCandidate);

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
    ['tools/goal/src/launch.ts', 'lifecycle change'],
    ['tools/goal/src/process.ts', 'lifecycle change'],
    ['tools/goal/src/orphan.ts', 'unresolved dependency impact'],
    ['tools/goal/src/generated-unowned.d.ts', 'unresolved dependency impact'],
    ['tools/goal/src/removed.test.ts', 'removed test cannot be selected'],
  ] as const;
  const allTests = [...baseFiles.keys()].filter((path) => /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path)).sort();

  for (const [path, reason] of cases) {
    const result = plan([path]);
    expect(result.scope).toBe('all');
    expect(result.tests).toEqual(allTests);
    expect(result.reasons.join('\n')).toContain(reason);
  }
});

test('documentation-only changes keep typing and compatibility with explicit bounded lifecycle coverage', () => {
  expect(plan(['tools/goal/README.md'])).toMatchObject({
    scope: 'none',
    tests: [],
    lifecycle: 'unchanged',
    entrypoints: [],
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

// These are the captured production report source and release base, not a ledger-shaped surrogate.
test('the real six-file hourly candidate selects owning report/CLI and affected consumer checks', () => {
  const cwd = join(import.meta.dir, '../../..');
  // Remote check snapshots intentionally omit Git metadata. This fixture captures the real diff,
  // tracked paths, verbatim executable sources/manifests and source import declarations at these refs.
  const { base, candidate, changedPaths, trackedFiles, files } = JSON.parse(
    gunzipSync(readFileSync(join(import.meta.dir, 'fixtures/control-plane-hourly-candidate.json.gz'))).toString(),
  ) as {
    base: string;
    candidate: string;
    changedPaths: string[];
    trackedFiles: string[];
    files: Record<string, string>;
  };
  expect(base).toBe('7d1892c56a28296bb7fb4c7e2e12a22600a783b0');
  expect(candidate).toBe('7aa069b360b676223a017d3bf93001feb8659bd6');
  expect(changedPaths).toEqual([
    'tools/goal/README.md',
    'tools/goal/scripts/efficiency-report.ts',
    'tools/goal/src/efficiency-report-delivery.ts',
    'tools/goal/src/efficiency-report-time.ts',
    'tools/goal/src/efficiency-report.test.ts',
    'tools/goal/src/efficiency-report.ts',
  ]);
  const result = selectControlPlaneCheckPlan({
    base,
    candidate,
    changedPaths,
    trackedFiles,
    readFile: (path) => files[path],
  });
  expect(result).toMatchObject({
    base,
    candidate,
    scope: 'affected',
    lifecycle: 'unchanged',
    entrypoints: ['tools/goal/scripts/efficiency-report.ts'],
    tests: [
      'tools/goal/src/efficiency-report.test.ts',
      'tools/goal/src/host-event-loop.test.ts',
      'tools/goal/src/integration-cli.test.ts',
      'tools/goal/src/maintenance.test.ts',
      'tools/goal/src/urgent-dispatch.test.ts',
    ],
  });
  expect(result.reasons.join('\n')).toContain('Executable command ownership: tools/goal/scripts/efficiency-report.ts');
  expect(controlPlaneChecks(undefined, result)).toContainEqual([
    'bun',
    'tools/goal/scripts/efficiency-report.ts',
    '--help',
  ]);
  // Exercise the installed production entrypoint's admission, without a DB or report delivery.
  for (const [args, status, output] of [
    [['--help'], 0, 'Usage: bun tools/goal/scripts/efficiency-report.ts'],
    [['--scheduled'], 1, '--scheduled requires --send'],
    [['--bucket', 'invalid'], 1, 'UTC'],
  ] as const) {
    const cli = spawnSync(process.execPath, ['tools/goal/scripts/efficiency-report.ts', ...args], {
      cwd,
      encoding: 'utf8',
    });
    expect(cli.status).toBe(status);
    expect(cli.stdout + cli.stderr).toContain(output);
  }
}, 30_000);

test('owned executables stay narrow while unknown scripts and package check commands widen', () => {
  const files = new Map(baseFiles);
  files.set(
    'tools/goal/scripts/hourly-report.ts',
    "#!/usr/bin/env bun\nimport { report } from '../src/hourly-report.ts';\nif (import.meta.main && process.argv.includes('--help')) console.log(report);",
  );
  files.set(
    'tools/goal/scripts/compiler.ts',
    "#!/usr/bin/env bun\nimport { compile } from '../src/compiler.ts';\nif (import.meta.main && process.argv.includes('--help')) console.log(compile);",
  );
  files.set('tools/goal/src/compiler.ts', 'export const compile = () => {};');
  files.set('tools/goal/src/compiler.test.ts', "import { compile } from './compiler.ts';");
  files.set('tools/goal/package.json', JSON.stringify({ scripts: { typecheck: 'bun scripts/compiler.ts' } }));
  files.set('tools/goal/scripts/report-arguments.test.ts', 'test("CLI arguments", () => {});');
  const select = (path: string) =>
    selectControlPlaneCheckPlan({
      base: 'base',
      candidate: 'head',
      changedPaths: [path],
      trackedFiles: [...files.keys()],
      readFile: (path) => files.get(path),
    });
  expect(select('tools/goal/scripts/hourly-report.ts')).toMatchObject({
    scope: 'affected',
    lifecycle: 'unchanged',
    tests: ['tools/goal/src/hourly-report.test.ts'],
    entrypoints: ['tools/goal/scripts/hourly-report.ts'],
  });
  expect(select('tools/goal/scripts/report-arguments.test.ts')).toMatchObject({
    scope: 'affected',
    tests: ['tools/goal/scripts/report-arguments.test.ts'],
  });
  for (const path of ['tools/goal/scripts/compiler.ts', 'tools/goal/scripts/unknown.ts', 'tools/goal/src/launch.ts']) {
    expect(select(path)).toMatchObject({ scope: 'all', lifecycle: 'full' });
  }
});
