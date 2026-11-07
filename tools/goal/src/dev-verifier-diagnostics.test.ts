import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

function sourceRepo(): { root: string; revision: string; authFile: string; libraryFile: string; producerFile: string } {
  const root = mkdtempSync(join(tmpdir(), 'goal-verifier-diagnostics-'));
  roots.push(root);
  git(root, 'init', '-b', 'dev');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'Test');
  const authFile = 'services/auth/scripts/dev-stack.ts';
  const libraryFile = 'services/kernel/test/library/support/profile-entry-fixture.ts';
  const producerFile = 'services/importer/src/producer.ts';
  const files: [string, string][] = [
    [authFile, 'const worker = true;\n'],
    [libraryFile, "import { composeLibraryDomain } from './compose.js';\nimport { composeLibraryDomain } from './compose.js';\n"],
    [producerFile, 'export const producer = true;\n'],
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
  return { root, revision, authFile, libraryFile, producerFile };
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
  expect(extractTypeScriptDiagnostics(
    "$ bun run typecheck (services/auth)\nscripts/dev-stack.ts(1108,92): error TS2448: Block-scoped variable 'worker' used before its declaration.",
    { repositoryRoot: '/checkout' },
  )[0]?.location).toMatchObject({ file: 'services/auth/scripts/dev-stack.ts', workspace: 'services/auth', resolved: true });
  const unresolved = extractTypeScriptDiagnostics(
    'test/support/fixture.ts(9,2): error TS2300: Duplicate identifier.',
    { repositoryRoot: '/checkout' },
  );
  expect(unresolved[0]?.location).toMatchObject({ file: 'test/support/fixture.ts', resolved: false });

  const check = checkRun('captured', output).check;
  expect(commandMetadata(check)).toEqual({ argv: check.command });
  expect(commandMetadata({ command: ['bun', 'test', 'tests/a.test.ts'], cwd: 'services/kernel' })).toEqual({
    argv: ['bun', 'test', 'tests/a.test.ts'],
    cwd: 'services/kernel',
  });
  expect(extractNamedTestFiles(check, { output }, { repositoryRoot: '/checkout' })).toEqual([]);
  expect(extractNamedTestFiles(check, { output: 'Total bytes received: 12\nsent 17 bytes received 12 bytes 11.60 bytes/sec' }, { repositoryRoot: '/checkout' })).toEqual([]);
});

test('assertions survive while rsync totals and cleanup remain separately classified', () => {
  const transfer = 'Total bytes received: 12\nsent 17 bytes received 12 bytes 11.60 bytes/sec';
  expect(assertionLines(transfer)).toEqual([]);
  expect(stableAssertions(transfer)).toEqual([]);
  expect(classifyRun({ passed: false, timedOut: false, output: transfer })).toBe('infrastructure');

  const assertion = 'FAIL services/kernel/test/account.test.ts:12\nAssertionError: expected true\nExpected: true\nReceived: false';
  expect(extractNamedTestFiles(
    { command: ['bun', 'test'], cwd: 'services/kernel' },
    { output: assertion },
    { repositoryRoot: '/checkout' },
  )).toEqual(['services/kernel/test/account.test.ts']);
  expect(stableAssertions(assertion)).toContain('Expected: true');
  expect(stableAssertions(assertion)).toContain('Received: false');
  expect(classifyRun({ passed: false, timedOut: false, output: assertion })).toBe('fail');
  expect(verifierCauses({ timedOut: false, output: assertion })).toContain('product-runtime');

  const mixed = [
    "test/library/support/profile-entry-fixture.ts(28,10): error TS2300: Duplicate identifier 'composeLibraryDomain'.",
    'Total bytes received: 12',
    'Compiler database cleanup could not be proven for PID 624699: owner identity was malformed.',
  ].join('\n');
  expect(extractVerifierDiagnostics({ output: mixed, timedOut: false }, { repositoryRoot: '/checkout', workspace: 'services/kernel' }).map(({ cause }) => cause)).toEqual([
    'compiler',
    'cleanup',
  ]);
  expect(verifierCauses({ timedOut: false, output: mixed })).toEqual(['compiler', 'cleanup']);
  expect(classifyRun({ passed: false, timedOut: false, output: mixed })).toBe('fail');
  expect(extractVerifierDiagnostics({
    output: `${mixed}\nssh: connect to host check.invalid port 22: Connection timed out`,
    timedOut: false,
  }).map(({ cause }) => cause)).toEqual(['compiler', 'cleanup', 'transport']);
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
  const compilerCleanup = findings.find((finding) => finding.cause === 'cleanup' && finding.head?.output.includes('1800006'))!;
  const e222CleanupFinding = findings.find((finding) => finding.cause === 'cleanup' && finding.head?.output.includes('624699'))!;
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
  const oneCompilerError = checkRun(revision, "$ bun run typecheck (services/auth)\nscripts/dev-stack.ts(1108,92): error TS2448: Block-scoped variable 'worker' used before its declaration.", 'unknown-origin');
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

  const stale = reconcileDiagnosticOwner(fixture.options, run.check, {
    cause: 'compiler',
    code: 'TS2300',
    message: 'Duplicate identifier',
    location: { file: libraryFile, line: 28, column: 10, resolved: true },
  }, revision);
  expect(stale).toMatchObject({ state: 'stale', currentRevision: git(root, 'rev-parse', 'dev') });
});
