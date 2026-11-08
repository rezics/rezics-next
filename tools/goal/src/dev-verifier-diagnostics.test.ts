import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  classifyRun,
  reconcileDiagnosticOwner,
  recordVerifierResults,
  type DevVerifierOptions,
} from './dev-verifier.ts';
import {
  commandMetadata,
  extractNamedTestFiles,
  extractTestFileOutcomes,
  extractTypeScriptDiagnostics,
  extractVerifierDiagnostics,
} from './dev-verifier-diagnostics.ts';
import { assertionLines, stableAssertions, verifierCauses } from './dev-verifier-classification.ts';
import type { CheckRun } from './dev-verifier-comparison.ts';
import type { DevVerifierFinding, Settings, Task } from './types.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function sourceRepo(): {
  root: string;
  revision: string;
  authFile: string;
  libraryFile: string;
  producerFile: string;
  firstTest: string;
  secondTest: string;
  authTest: string;
  secondAuthTest: string;
} {
  const temporaryRoot = join(import.meta.dir, '../../../.temp');
  mkdirSync(temporaryRoot, { recursive: true });
  const root = mkdtempSync(join(temporaryRoot, 'goal-verifier-diagnostics-'));
  roots.push(root);
  git(root, 'init', '-b', 'dev');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'Test');
  const authFile = 'services/auth/scripts/dev-stack.ts';
  const libraryFile = 'services/kernel/test/library/support/profile-entry-fixture.ts';
  const producerFile = 'services/importer/src/producer.ts';
  const firstTest = 'services/kernel/test/first.test.ts';
  const secondTest = 'services/kernel/test/second.test.ts';
  const authTest = 'services/auth/test/erasure-history.test.ts';
  const secondAuthTest = 'services/auth/test/second.test.ts';
  const files: [string, string][] = [
    [authFile, 'const worker = true;\n'],
    [
      libraryFile,
      "import { composeLibraryDomain } from './compose.js';\nimport { composeLibraryDomain } from './compose.js';\n",
    ],
    [producerFile, 'export const producer = true;\n'],
    [firstTest, 'test("first", () => {});\n'],
    [secondTest, 'test("second", () => {});\n'],
    [authTest, 'test("erasure history", () => {});\n'],
    [secondAuthTest, 'test("second Auth test", () => {});\n'],
    ['scripts/typecheck.ts', 'process.exit(0);\n'],
  ];
  for (const [path, source] of files) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'captured compiler inputs');
  const revision = git(root, 'rev-parse', 'HEAD');
  git(root, 'branch', 'dev-verified');
  return { root, revision, authFile, libraryFile, producerFile, firstTest, secondTest, authTest, secondAuthTest };
}

function task(id: string, state: string, paths: string[], goal = id): Task {
  return {
    id,
    state,
    sequence: 1,
    brief: { id, goal, manager: `${goal}-manager`, paths, riskAreas: [] },
  } as unknown as Task;
}

function options(root: string, tasks: Task[]) {
  const findings = new Map<string, DevVerifierFinding>();
  const settings = { mainCheckout: root, integrationBranch: 'dev' } as unknown as Settings;
  const store = {
    tasks: () => tasks,
    saveDevVerifierFinding: (finding: DevVerifierFinding) => findings.set(finding.rangeKey, finding),
  };
  return {
    findings,
    settings,
    options: { settings, store } as unknown as DevVerifierOptions,
  };
}

function checkRun(revision: string, output: string, taskId = 'library'): CheckRun {
  const command = [
    'env',
    'TYPECHECK_CHANGED=.temp/continuation/example.test.ts\nservices/kernel/test/library/support/profile-entry-fixture.ts',
    'bun',
    'scripts/typecheck.ts',
  ];
  return {
    check: { command, closure: ['**'], taskId, index: 0, signature: 'fixture' },
    evidence: {
      commit: revision,
      command,
      passed: false,
      timedOut: false,
      output,
      logPath: 'original-check.log',
    },
  };
}

test('compiler locations use the emitting workspace and argv values never become test names', () => {
  const output = [
    'Workspace @rezics/web type-errors after 64.98s',
    '$ bun run typecheck:root (apps/web)',
    "../../services/auth/scripts/dev-stack.ts(1108,92): error TS2448: Block-scoped variable 'worker' used before its declaration.",
    '$ bun scripts/typecheck.ts (services/kernel)',
    "test/library/support/profile-entry-fixture.ts(28,10): error TS2300: Duplicate identifier 'composeLibraryDomain'.",
  ].join('\n');
  const diagnostics = extractTypeScriptDiagnostics(output, { repositoryRoot: '/checkout' });
  expect(diagnostics.map(({ code, location }) => [code, location?.file, location?.line, location?.workspace])).toEqual([
    ['TS2448', 'services/auth/scripts/dev-stack.ts', 1108, 'apps/web'],
    ['TS2300', 'services/kernel/test/library/support/profile-entry-fixture.ts', 28, 'services/kernel'],
  ]);
  expect(
    extractTypeScriptDiagnostics(
      "$ bun run typecheck (services/auth)\nscripts/dev-stack.ts(1108,92): error TS2448: Block-scoped variable 'worker' used before its declaration.",
      { repositoryRoot: '/checkout' },
    )[0]?.location,
  ).toMatchObject({ file: 'services/auth/scripts/dev-stack.ts', workspace: 'services/auth', resolved: true });
  const unresolved = extractTypeScriptDiagnostics('test/support/fixture.ts(9,2): error TS2300: Duplicate identifier.', {
    repositoryRoot: '/checkout',
  });
  expect(unresolved[0]?.location).toMatchObject({ file: 'test/support/fixture.ts', resolved: false });

  const check = checkRun('captured', output).check;
  expect(commandMetadata(check)).toEqual({ argv: check.command });
  expect(commandMetadata({ command: ['bun', 'test', 'tests/a.test.ts'], cwd: 'services/kernel' })).toEqual({
    argv: ['bun', 'test', 'tests/a.test.ts'],
    cwd: 'services/kernel',
  });
  expect(extractNamedTestFiles(check, { output }, { repositoryRoot: '/checkout' })).toEqual([]);
  expect(
    extractNamedTestFiles(
      check,
      { output: 'Total bytes received: 12\nsent 17 bytes received 12 bytes 11.60 bytes/sec' },
      { repositoryRoot: '/checkout' },
    ),
  ).toEqual([]);
});

test('assertions survive while rsync totals and cleanup remain separately classified', () => {
  const transfer = 'Total bytes received: 12\nsent 17 bytes received 12 bytes 11.60 bytes/sec';
  expect(assertionLines(transfer)).toEqual([]);
  expect(stableAssertions(transfer)).toEqual([]);
  expect(classifyRun({ passed: false, timedOut: false, output: transfer })).toBe('infrastructure');

  const assertion =
    'FAIL services/kernel/test/account.test.ts:12\nAssertionError: expected true\nExpected: true\nReceived: false';
  expect(
    extractNamedTestFiles(
      { command: ['bun', 'test'], cwd: 'services/kernel' },
      { output: assertion },
      { repositoryRoot: '/checkout' },
    ),
  ).toEqual(['services/kernel/test/account.test.ts']);
  expect(stableAssertions(assertion)).toContain('Expected: true');
  expect(stableAssertions(assertion)).toContain('Received: false');
  expect(classifyRun({ passed: false, timedOut: false, output: assertion })).toBe('fail');
  expect(verifierCauses({ timedOut: false, output: assertion })).toContain('product-runtime');

  const mixed = [
    "test/library/support/profile-entry-fixture.ts(28,10): error TS2300: Duplicate identifier 'composeLibraryDomain'.",
    'Total bytes received: 12',
    'Compiler database cleanup could not be proven for PID 624699: owner identity was malformed.',
  ].join('\n');
  expect(
    extractVerifierDiagnostics(
      { output: mixed, timedOut: false },
      { repositoryRoot: '/checkout', workspace: 'services/kernel' },
    ).map(({ cause }) => cause),
  ).toEqual(['compiler', 'cleanup']);
  expect(verifierCauses({ timedOut: false, output: mixed })).toEqual(['compiler', 'cleanup']);
  expect(classifyRun({ passed: false, timedOut: false, output: mixed })).toBe('fail');
  expect(
    extractVerifierDiagnostics({
      output: `${mixed}\nssh: connect to host check.invalid port 22: Connection timed out`,
      timedOut: false,
    }).map(({ cause }) => cause),
  ).toEqual(['compiler', 'cleanup', 'transport']);
});

test('58201 aggregate reporter sections keep passing files clean and route each failed file its own assertions', () => {
  const { root, revision, firstTest, secondTest } = sourceRepo();
  const owner = task('kernel-owner', 'running', ['services/kernel/test/**'], 'kernel');
  const fixture = options(root, [owner]);
  const command = [
    'bun',
    'test',
    'scripts/docs-check.test.ts',
    'tools/goal/src/dev-verifier-diagnostics.test.ts',
    'tools/goal/src/store.test.ts',
    firstTest,
    secondTest,
  ];
  const aggregateFailures = Array.from(
    { length: 106 },
    (_, index) => `AssertionError: unrelated aggregate failure ${index + 1}`,
  ).join('\n');
  const output = [
    aggregateFailures,
    'scripts/docs-check.test.ts:',
    '(pass) docs checks [2.1ms]',
    '15 pass',
    'tools/goal/src/dev-verifier-diagnostics.test.ts:',
    '(pass) diagnostic tests [1.8ms]',
    '3 pass',
    'tools/goal/src/store.test.ts:',
    '(pass) store lifecycle [0.9ms]',
    '1 pass',
    `${firstTest}:`,
    '(fail) first producer assertion [1.1ms]',
    'AssertionError: first-file assertion',
    'Expected: first-file-value',
    'Received: false',
    `${secondTest}:`,
    '(fail) second producer assertion [1.3ms]',
    'AssertionError: second-file assertion',
    'Expected: second-file-value',
    'Received: false',
  ].join('\n');
  const check = {
    command,
    closure: ['**'],
    taskId: owner.id,
    index: 0,
    signature: '58201-aggregate-excerpt',
  };
  const attribution = extractTestFileOutcomes(check, { output }, { repositoryRoot: root });
  expect(attribution.outcomes.map(({ file, result }) => [file, result])).toEqual([
    ['scripts/docs-check.test.ts', 'pass'],
    ['tools/goal/src/dev-verifier-diagnostics.test.ts', 'pass'],
    ['tools/goal/src/store.test.ts', 'pass'],
    [firstTest, 'fail'],
    [secondTest, 'fail'],
  ]);

  const recorded = recordVerifierResults(fixture.options, revision, revision, [
    {
      check,
      evidence: {
        commit: revision,
        command,
        passed: false,
        timedOut: false,
        output,
        logPath: '.temp/goal/58201-aggregate-excerpt.log',
      },
    },
  ]);
  expect(recorded.repairs.map(({ test }) => test).sort()).toEqual([firstTest, secondTest]);
  const first = [...fixture.findings.values()].find(({ test }) => test === firstTest)!;
  const second = [...fixture.findings.values()].find(({ test }) => test === secondTest)!;
  expect(first.assertion).toContain('first-file assertion');
  expect(first.assertion).not.toContain('second-file assertion');
  expect(second.assertion).toContain('second-file assertion');
  expect(second.assertion).not.toContain('first-file assertion');
  expect([...fixture.findings.values()].some(({ test }) => test?.includes('docs-check'))).toBe(false);
  expect(
    [...fixture.findings.values()].some(
      ({ test, status, assertion }) =>
        test === undefined && status === 'unknown' && assertion.includes('file-local attribution'),
    ),
  ).toBe(true);

  const mixedFile = extractTestFileOutcomes(
    { command: ['bun', 'test', firstTest] },
    {
      output: [
        '(fail) initial focused failure [1.0ms]',
        'AssertionError: focused failure',
        '(pass) later focused success [0.8ms]',
      ].join('\n'),
    },
    { repositoryRoot: root },
  );
  expect(mixedFile.outcomes).toMatchObject([
    { file: firstTest, result: 'fail', failureOutputs: [expect.stringContaining('focused failure')] },
  ]);
  expect(mixedFile.outcomes[0]?.failureOutputs.join('\n')).not.toContain('later focused success');
});

test('Auth setup denial and precommand remote slot failure remain custody evidence without named test failures', () => {
  const { root, revision, firstTest, authTest, secondAuthTest } = sourceRepo();
  const authLane = {
    command: [
      'bun',
      'run',
      '--cwd',
      'services/auth',
      'check',
      'test/erasure-history.test.ts',
      'test/second.test.ts',
      '--test-name-pattern',
      'erasure history',
      '--timeout',
      '12000',
    ],
  };
  expect(
    extractTestFileOutcomes(
      authLane,
      { output: 'Auth tests failed for 1 file(s):\ntest/erasure-history.test.ts' },
      { repositoryRoot: root },
    ).outcomes.map(({ file, result }) => [file, result]),
  ).toEqual([
    [authTest, 'fail'],
    [secondAuthTest, 'pass'],
  ]);
  expect(
    extractTestFileOutcomes(
      { command: ['bun', 'run', '--cwd', 'services/auth', 'check'] },
      { output: 'Auth tests failed for 1 file(s):\ntest/erasure-history.test.ts' },
      { repositoryRoot: root },
    ),
  ).toMatchObject({ outcomes: [{ file: authTest, result: 'fail', resolved: true }], ambiguous: false });
  const setup = 'Error: Auth test databases require placement; use bun run --cwd services/auth check <file>';
  const auth = {
    command: ['bun', 'test', authTest],
  };
  expect(extractNamedTestFiles(auth, { output: setup }, { repositoryRoot: root })).toEqual([]);
  expect(classifyRun({ ...auth, passed: false, timedOut: false, output: setup })).toBe('infrastructure');
  expect(verifierCauses({ timedOut: false, output: setup })).toEqual(['setup']);
  const authOwner = task('auth-owner', 'running', ['services/auth/test/**'], 'performance');
  const authFixture = options(root, [authOwner]);
  const setupCounts = recordVerifierResults(authFixture.options, revision, revision, [
    {
      check: {
        command: auth.command,
        closure: ['services/auth/**'],
        taskId: authOwner.id,
        index: 0,
        signature: 'setup',
      },
      evidence: {
        commit: revision,
        command: auth.command,
        passed: false,
        timedOut: false,
        output: setup,
        logPath: '.temp/goal/58201-auth-placement.log',
      },
    },
  ]);
  expect(setupCounts).toMatchObject({ failed: 0, unknown: 1, repairs: [] });
  const setupFinding = [...authFixture.findings.values()][0]!;
  expect(setupFinding.test).toBeUndefined();
  expect(setupFinding).toMatchObject({
    cause: 'setup',
    result: 'infrastructure',
    status: 'unknown',
  });
  const reporterSetup = options(root, [authOwner]);
  const reporterSetupCommand = ['bun', 'test', authTest];
  const reporterSetupCounts = recordVerifierResults(reporterSetup.options, revision, revision, [
    {
      check: {
        command: reporterSetupCommand,
        closure: ['services/auth/**'],
        taskId: authOwner.id,
        index: 0,
        signature: 'reporter-setup',
      },
      evidence: {
        commit: revision,
        command: reporterSetupCommand,
        passed: false,
        timedOut: false,
        output: `${authTest}:\n(fail) test bootstrap\n${setup}`,
        logPath: '.temp/goal/58201-auth-reporter-setup.log',
      },
    },
  ]);
  expect(reporterSetupCounts).toMatchObject({ failed: 0, unknown: 1, repairs: [] });
  expect([...reporterSetup.findings.values()].map(({ cause }) => cause)).toEqual(['setup']);
  expect(
    extractNamedTestFiles(
      { command: ['bun', 'test', 'services/kernel/test/first.test.ts'] },
      { output: 'AssertionError: stack only\nat services/kernel/test/first.test.ts:18' },
      { repositoryRoot: root },
    ),
  ).toEqual([]);
  expect(
    extractTestFileOutcomes(
      { command: ['bun', 'test', 'services/kernel/test/first.test.ts', 'services/kernel/test/second.test.ts'] },
      { output: '(fail) unselected reporter event' },
      { repositoryRoot: root },
    ),
  ).toMatchObject({ outcomes: [], ambiguous: true });
  const unhandled = extractTestFileOutcomes(
    { command: ['bun', 'test', firstTest] },
    {
      output: `${firstTest}:\n(fail) named test\nAssertionError: named assertion\nUnhandled error between tests\nError: independent runner error`,
    },
    { repositoryRoot: root },
  );
  expect(unhandled.unhandled).toBe(true);
  expect(unhandled.outcomes[0]?.failureOutputs.join('\n')).not.toContain('independent runner error');

  const remote = 'remote-check: connection to b failed during slot take before a result';
  const web = {
    command: ['bun', 'scripts/check.ts', '--skip-format', 'tests/browser/selected.test.ts'],
    cwd: 'apps/web',
  };
  expect(extractNamedTestFiles(web, { output: remote }, { repositoryRoot: '/checkout' })).toEqual([]);
  expect(extractVerifierDiagnostics({ output: remote, timedOut: false })).toMatchObject([
    { cause: 'transport', message: remote },
  ]);
  expect(classifyRun({ ...web, passed: false, timedOut: false, output: remote })).toBe('infrastructure');
  expect(verifierCauses({ timedOut: false, output: remote })).toEqual(['transport']);

  const truncated = `${firstTest}:\n(fail) first result\nAssertionError: first assertion\n[TRUNCATED]`;
  const truncatedOwner = task('kernel-owner', 'running', ['services/kernel/test/**'], 'kernel');
  const truncatedFixture = options(root, [truncatedOwner]);
  const truncatedCheck = ['bun', 'test', firstTest];
  const truncatedCounts = recordVerifierResults(truncatedFixture.options, revision, revision, [
    {
      check: { command: truncatedCheck, closure: ['services/kernel/**'], index: 0, signature: 'truncated' },
      evidence: {
        commit: revision,
        command: truncatedCheck,
        passed: false,
        timedOut: false,
        output: truncated,
        logPath: '.temp/goal/58201-truncated.log',
      },
    },
  ]);
  expect(truncatedCounts).toMatchObject({ failed: 0, unknown: 1, repairs: [] });
  expect([...truncatedFixture.findings.values()][0]).toMatchObject({
    test: undefined,
    diagnostic: { message: expect.stringContaining('Truncated output') },
    result: 'infrastructure',
    status: 'unknown',
  });
});

test('compiler reconciliation routes only unchanged concrete producer errors and preserves current corrections and ambiguity', () => {
  const { root, revision, authFile, libraryFile, producerFile } = sourceRepo();
  const authOwner = task('auth-worker', 'running', [authFile], 'performance');
  const broadLibraryOwner = task('library-wide', 'integrated', ['services/kernel/**'], 'library');
  const fixture = options(root, [authOwner, broadLibraryOwner]);
  const output = [
    'Compiler database owner PID=3002447 PPID=3002160 PGID=3002160 START=130550172',
    '$ bun run typecheck:root (apps/web)',
    "../../services/auth/scripts/dev-stack.ts(1108,92): error TS2448: Block-scoped variable 'worker' used before its declaration.",
    '$ bun scripts/typecheck.ts (services/kernel)',
    "test/library/support/profile-entry-fixture.ts(28,10): error TS2300: Duplicate identifier 'composeLibraryDomain'.",
    "test/library/support/profile-entry-fixture.ts(31,10): error TS2300: Duplicate identifier 'composeLibraryDomain'.",
    '$ bun run typecheck (services/importer)',
    'src/producer.ts(44,9): error TS2322: Type string is not assignable to type number.',
    'Typecheck batch completed in 128.41s (166 changed paths; 19 workspaces).',
    'Total bytes received: 12',
    'Compiler database cleanup could not be proven for PID 1800006: owner identity was malformed.',
  ].join('\n');

  writeFileSync(join(root, libraryFile), "import { composeLibraryDomain } from './compose.js';\n");
  git(root, 'add', libraryFile);
  git(root, 'commit', '-m', 'integrated compiler correction');

  const run = checkRun(revision, output);
  const e222Cleanup = checkRun(
    revision,
    [
      'Total bytes received: 12',
      'sent 17 bytes received 12 bytes 11.60 bytes/sec',
      'Compiler database cleanup could not be proven for PID 624699: owner identity was malformed.',
    ].join('\n'),
    'commerce-origin',
  );
  const counts = recordVerifierResults(fixture.options, revision, revision, [run, e222Cleanup]);
  expect(counts).toMatchObject({ testsRun: 2, failed: 1, unknown: 1 });
  expect(counts.repairs).toHaveLength(1);
  expect(counts.repairs[0]).toMatchObject({ cause: 'compiler', sourceRevision: revision, owner: authOwner });
  expect(counts.repairs[0]!.test).toBeUndefined();

  const findings = [...fixture.findings.values()];
  const authFinding = findings.find((finding) => finding.diagnostic?.location?.file === authFile)!;
  const correctedLibraryFindings = findings.filter((finding) => finding.diagnostic?.location?.file === libraryFile);
  const unresolvedProducer = findings.find((finding) => finding.diagnostic?.location?.file === producerFile)!;
  const compilerCleanup = findings.find(
    (finding) => finding.cause === 'cleanup' && finding.head?.output.includes('1800006'),
  )!;
  const e222CleanupFinding = findings.find(
    (finding) => finding.cause === 'cleanup' && finding.head?.output.includes('624699'),
  )!;
  expect(authFinding).toMatchObject({ status: 'new', cause: 'compiler', headCommit: revision });
  expect(authFinding.check).toMatchObject({ taskId: 'library', command: run.check.command });
  expect(correctedLibraryFindings).toHaveLength(2);
  expect(correctedLibraryFindings.every((finding) => finding.status === 'unknown')).toBe(true);
  expect(unresolvedProducer).toMatchObject({ status: 'unknown', cause: 'compiler', headCommit: revision });
  expect(unresolvedProducer.reason).toContain('No established owner');
  expect(compilerCleanup).toMatchObject({ status: 'unknown', cause: 'cleanup', result: 'infrastructure' });
  expect(compilerCleanup.head?.output).toContain('TS2448');
  expect(compilerCleanup.head?.output).toContain('PID 1800006');
  expect(e222CleanupFinding).toMatchObject({ status: 'unknown', cause: 'cleanup', result: 'infrastructure' });
  expect(e222CleanupFinding.head?.output).not.toContain('TS2448');
  expect(findings.filter((finding) => finding.cause === 'cleanup')).toHaveLength(2);
  expect(findings.every((finding) => finding.test === undefined)).toBe(true);

  const ambiguous = options(root, [
    task('auth-owner-a', 'running', [authFile], 'performance'),
    task('auth-owner-b', 'ready', [authFile], 'performance'),
  ]);
  const oneCompilerError = checkRun(
    revision,
    "$ bun run typecheck (services/auth)\nscripts/dev-stack.ts(1108,92): error TS2448: Block-scoped variable 'worker' used before its declaration.",
    'unknown-origin',
  );
  const triage = recordVerifierResults(ambiguous.options, revision, revision, [oneCompilerError]);
  expect(triage.repairs).toHaveLength(0);
  const triageFinding = [...ambiguous.findings.values()][0]!;
  expect(triageFinding).toMatchObject({ status: 'unknown', cause: 'compiler', headCommit: revision });
  expect(triageFinding.reason).toContain('matches multiple owners');
  expect(triageFinding.check.command).toEqual(oneCompilerError.check.command);
  expect(triageFinding.head?.output).toContain('TS2448');

  const landedOnly = options(root, [task('landed-auth', 'integrated', [authFile], 'performance')]);
  const noActiveOwner = recordVerifierResults(landedOnly.options, revision, revision, [oneCompilerError]);
  expect(noActiveOwner.repairs).toHaveLength(0);
  expect([...landedOnly.findings.values()][0]).toMatchObject({ status: 'unknown', cause: 'compiler' });
  expect([...landedOnly.findings.values()][0]?.reason).toContain('No established owner');

  const stale = reconcileDiagnosticOwner(
    fixture.options,
    run.check,
    {
      cause: 'compiler',
      code: 'TS2300',
      message: 'Duplicate identifier',
      location: { file: libraryFile, line: 28, column: 10, resolved: true },
    },
    revision,
  );
  expect(stale).toMatchObject({ state: 'stale', currentRevision: git(root, 'rev-parse', 'dev') });
});
