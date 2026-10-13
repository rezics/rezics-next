import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBrief } from './briefs.ts';
import { checkChangedFiles, checkFailureLines, parseCheckArgs, runCheckCommand, workerCheck, type CheckRunner } from './check.ts';

const scratch = join(import.meta.dir, '../../.temp/worker-check-tests');
const fixtures: string[] = [];
function fixture() {
  mkdirSync(scratch, { recursive: true });
  const cwd = mkdtempSync(join(scratch, 'case-'));
  fixtures.push(cwd);
  for (const file of ['scripts/example.ts', 'scripts/example.test.ts', 'scripts/qa/repository-guards.test.ts']) {
    mkdirSync(join(cwd, file, '..'), { recursive: true });
    writeFileSync(join(cwd, file), 'export {};\n');
  }
  const lines: string[] = [];
  const commands: string[][] = [];
  const runner: CheckRunner = async command => {
    commands.push([...command]);
    return { code: 0, output: '(pass) passing case\nall passing output\n' };
  };
  return { cwd, lines, commands, runner, print: (line: string) => { lines.push(line); },
    changed: ['scripts/example.ts'], tests: ['scripts/example.test.ts'] };
}

afterEach(() => {
  for (const cwd of fixtures.splice(0)) rmSync(cwd, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

test('one passing invocation prints five ok lines and retains every command output on disk', async () => {
  const f = fixture();
  const result = await workerCheck(f);
  expect(result.code).toBe(0);
  expect(f.lines.filter(line => /: ok \(\d+\.\ds\)/.test(line))).toHaveLength(5);
  expect(new Set(result.checks.map(check => check.name))).toEqual(new Set(['types', 'lint', 'ast', 'tests', 'guards']));
  expect(f.lines.join('\n')).not.toContain('all passing output');
  expect(readFileSync(result.log, 'utf8')).toContain('all passing output');
  expect(result.log.startsWith(join(f.cwd, '.temp/goal/check/'))).toBe(true);
  expect(f.lines.at(-1)).toBe(`Full output: ${result.log}`);
  expect(f.commands).toContainEqual(['task', 'scripts:typecheck']);
  expect(f.commands).toContainEqual(['node_modules/.bin/oxlint', '--type-aware', 'scripts']);
  expect(f.commands).toContainEqual(['task', 'ast-grep', '--', 'scan', 'scripts/example.ts']);
  expect(f.commands.find(command => command.includes('test'))?.slice(0, 4))
    .toEqual(['bun', 'scripts/goal/goalctl.ts', 'test', 'scripts/example.test.ts']);
  expect(f.commands).toContainEqual(['task', 'goal:unit-files', '--', 'scripts/qa/repository-guards.test.ts']);
});

test('a failing type check prints its diagnostic and returns failure without passing transcripts', async () => {
  const f = fixture();
  const runner: CheckRunner = async (command, cwd, log) => command[1] === 'scripts:typecheck'
    ? { code: 2, output: "compiler startup noise\nscripts/example.ts(2,3): error TS2322: Type 'string' is not assignable to type 'number'.\n  Details of this error\n" }
    : f.runner(command, cwd, log);
  const result = await workerCheck({ ...f, runner });
  expect(result.code).toBe(1);
  expect(f.lines.join('\n')).toContain('types: failed');
  expect(f.lines.join('\n')).toContain('error TS2322');
  expect(f.lines.join('\n')).not.toContain('compiler startup noise');
  expect(f.lines.join('\n')).not.toContain('passing case');
  expect(result.checks.filter(check => check.code !== 0).map(check => check.name)).toEqual(['types']);
});

test('a failed test prints the case name with its error and never passing cases', async () => {
  const f = fixture();
  const runner: CheckRunner = async (command, cwd, log) => command.includes('test')
    ? { code: 1, output: 'bun test\n(pass) unrelated case\nerror: expected 2 to be 3\n\n(fail) explicit proof > preserves the person\n(pass) next case\n1 fail\n' }
    : f.runner(command, cwd, log);
  const result = await workerCheck({ ...f, runner });
  expect(result.code).toBe(1);
  expect(f.lines.join('\n')).toContain('(fail) explicit proof > preserves the person');
  expect(f.lines.join('\n')).toContain('error: expected 2 to be 3');
  expect(f.lines.join('\n')).not.toContain('(pass)');
});

test('tests frontmatter accepts inline and multiline lists and defaults to an empty list', () => {
  expect(parseBrief('---\ntests: [scripts/a.test.ts, scripts/b.test.ts]\n---\n').tests)
    .toEqual(['scripts/a.test.ts', 'scripts/b.test.ts']);
  expect(parseBrief('---\ntests:\n  - scripts/a.test.ts\n  - scripts/b.test.ts\n---\n').tests)
    .toEqual(['scripts/a.test.ts', 'scripts/b.test.ts']);
  expect(parseBrief('---\nid: example\n---\n').tests).toEqual([]);
});

test('the default brief supplies all test files to one QA call, and an absent list starts no test command', async () => {
  const f = fixture();
  const brief = join(f.cwd, '.temp/goal/brief.md');
  mkdirSync(join(brief, '..'), { recursive: true });
  writeFileSync(brief, '---\ntests: [scripts/example.test.ts, scripts/another.test.ts]\n---\n');
  await workerCheck({ ...f, tests: undefined, only: ['tests'] });
  expect(f.commands).toHaveLength(1);
  expect(f.commands[0]?.slice(0, 5)).toEqual(['bun', 'scripts/goal/goalctl.ts', 'test', 'scripts/example.test.ts', 'scripts/another.test.ts']);
  f.commands.length = 0;
  writeFileSync(brief, '---\nid: example\n---\n');
  const result = await workerCheck({ ...f, tests: undefined, only: ['tests'] });
  expect(f.commands).toHaveLength(0);
  expect(result.code).toBe(0);
  expect(f.lines.join('\n')).toContain('no test files named in brief');
});

test('failed diagnostics are bounded to sixty lines per check while the disk log remains complete', async () => {
  const f = fixture();
  const output = Array.from({ length: 100 }, (_, i) => `error: diagnostic ${i}`).join('\n');
  const result = await workerCheck({ ...f, only: ['types'], runner: async () => ({ code: 1, output }) });
  expect(f.lines.filter(line => line.startsWith('error:'))).toHaveLength(60);
  expect(readFileSync(result.log, 'utf8')).toContain('error: diagnostic 99');
  expect(result.code).toBe(1);
});

test('compiler and lint commands are serialized while proofs and guards may run beside them', async () => {
  const f = fixture();
  let activeHeavy = 0;
  let maxHeavy = 0;
  let testsDuringTypes = false;
  let guardsDuringTypes = false;
  let releaseTypes: () => void = () => {};
  const typesBlocked = new Promise<void>(resolve => { releaseTypes = resolve; });
  const runner: CheckRunner = async command => {
    const heavy = command[1]?.endsWith(':typecheck') || command[0]?.endsWith('/oxlint');
    if (heavy) { activeHeavy++; maxHeavy = Math.max(maxHeavy, activeHeavy); }
    if (command.includes('test')) testsDuringTypes = activeHeavy === 1;
    if (command.includes('goal:unit-files')) { guardsDuringTypes = activeHeavy === 1; releaseTypes(); }
    if (command[1]?.endsWith(':typecheck')) await typesBlocked;
    if (heavy) activeHeavy--;
    return { code: 0, output: '' };
  };
  await workerCheck({ ...f, changed: ['scripts/example.ts', 'apps/web/example.ts'], runner });
  expect(maxHeavy).toBe(1);
  expect(testsDuringTypes).toBe(true);
  expect(guardsDuringTypes).toBe(true);
});

test('only runs the requested groups, with ast-grep included in lint', async () => {
  const f = fixture();
  expect(parseCheckArgs([])).toEqual(['types', 'lint', 'tests', 'guards']);
  expect(parseCheckArgs(['--only', 'lint,tests,lint'])).toEqual(['lint', 'tests']);
  expect(() => parseCheckArgs(['--only', 'unknown'])).toThrow();
  expect(() => parseCheckArgs(['--only'])).toThrow();
  const result = await workerCheck({ ...f, only: ['lint'] });
  expect(result.checks.map(check => check.name)).toEqual(['lint', 'ast']);
  expect(f.commands).toHaveLength(2);
});

test('empty and deleted changes never turn an empty file list into a repository-wide scan', async () => {
  const f = fixture();
  const result = await workerCheck({ ...f, changed: ['scripts/deleted.ts'], only: ['lint'] });
  expect(result.code).toBe(0);
  expect(f.commands).toHaveLength(0);
});

test('a runner startup failure still runs the remaining checks and fails the invocation', async () => {
  const f = fixture();
  const result = await workerCheck({ ...f, runner: async (command, cwd, log) => {
    if (command[1] === 'scripts:typecheck') throw new Error('compiler unavailable');
    return f.runner(command, cwd, log);
  } });
  expect(result.code).toBe(1);
  expect(result.checks).toHaveLength(5);
  expect(f.lines.join('\n')).toContain('error: compiler unavailable');
});

test('changed files include committed branch edits, staged and unstaged edits, untracked files and deletions', () => {
  const f = fixture();
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: f.cwd, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  };
  git('init', '-b', 'main');
  git('config', 'user.email', 'check@example.invalid');
  git('config', 'user.name', 'Worker check test');
  writeFileSync(join(f.cwd, '.gitignore'), '.temp/\n');
  git('add', '.'); git('commit', '-m', 'base');
  git('switch', '-c', 'worker');
  writeFileSync(join(f.cwd, 'scripts/committed.ts'), 'export {};\n');
  git('add', '.'); git('commit', '-m', 'branch');
  writeFileSync(join(f.cwd, 'scripts/staged.ts'), 'export {};\n');
  git('add', '.');
  writeFileSync(join(f.cwd, 'scripts/example.ts'), 'export const changed = true;\n');
  writeFileSync(join(f.cwd, 'scripts/untracked.ts'), 'export {};\n');
  rmSync(join(f.cwd, 'scripts/example.test.ts'));
  expect(checkChangedFiles(f.cwd)).toEqual(['scripts/committed.ts', 'scripts/example.test.ts', 'scripts/example.ts',
    'scripts/staged.ts', 'scripts/untracked.ts']);
});

test('diagnostic summaries strip terminal escapes and handle an unclassified command failure', () => {
  expect(checkFailureLines('\x1b[31merror: unavailable\x1b[0m\n')).toEqual(['error: unavailable']);
  expect(checkFailureLines('command unavailable\n')).toEqual(['command unavailable']);
  const longFailure = `${Array.from({ length: 100 }, (_, i) => `error: diagnostic ${i}`).join('\n')}\n(fail) proof case`;
  expect(checkFailureLines(longFailure)).toHaveLength(60);
  expect(checkFailureLines(longFailure)[0]).toBe('(fail) proof case');
});

test('the process runner preserves stdout, stderr and the exit status in its log', async () => {
  const f = fixture();
  const log = join(f.cwd, 'command.log');
  const result = await runCheckCommand([process.execPath, '-e',
    'console.log("full stdout"); console.error("error: full stderr"); process.exit(7);'], f.cwd, log);
  expect(result.code).toBe(7);
  expect(result.output).toContain('full stdout');
  expect(result.output).toContain('error: full stderr');
  expect(readFileSync(log, 'utf8')).toBe(result.output);
  const missing = await runCheckCommand(['worker-check-missing-command'], f.cwd, log);
  expect(missing.code).toBe(1);
  expect(missing.output).toContain('error:');
});

test('test paths cannot direct the proof invocation outside the worktree', async () => {
  const f = fixture();
  await expect(workerCheck({ ...f, tests: ['../elsewhere.test.ts'] })).rejects.toThrow('outside worktree');
  await expect(workerCheck({ ...f, tests: ['/tmp/elsewhere.test.ts'] })).rejects.toThrow('outside worktree');
});

test('hosted QA failures print attributed JUnit case names and preserve full case logs', async () => {
  const f = fixture();
  const artifacts = join(f.cwd, '.artifacts/qa/selected-proof');
  mkdirSync(join(artifacts, 'logs'), { recursive: true });
  writeFileSync(join(artifacts, 'logs/owner.log'), '(pass) hidden passing case\ncomplete hosted transcript\n');
  writeFileSync(join(artifacts, 'owner.xml'),
    '<testsuites><testsuite name="proof"><testcase name="person &amp; program" file="scripts/example.test.ts"><failure message="expected authority"/></testcase></testsuite></testsuites>');
  const runner: CheckRunner = async command => {
    const at = command.indexOf('--result-file');
    writeFileSync(command[at + 1]!, JSON.stringify({ artifactPaths: [artifacts] }));
    return { code: 1, output: `QA artifacts: ${artifacts}\n` };
  };
  const result = await workerCheck({ ...f, only: ['tests'], runner });
  expect(result.code).toBe(1);
  expect(f.lines.join('\n')).toContain('(fail) person & program');
  expect(f.lines.join('\n')).toContain('error: expected authority');
  expect(f.lines.join('\n')).not.toContain('hidden passing case');
  expect(readFileSync(result.log, 'utf8')).toContain('complete hosted transcript');
});

test('the discovered goal command exits zero for a passing subset and nonzero for invalid arguments', async () => {
  const f = fixture();
  for (const args of [['init', '-b', 'main'], ['-c', 'user.name=Worker check test', '-c', 'user.email=check@example.invalid',
    'commit', '--allow-empty', '-m', 'base']]) {
    const result = spawnSync('git', args, { cwd: f.cwd, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  }
  const command = join(import.meta.dir, 'goalctl.ts');
  const passing = await runCheckCommand([process.execPath, command, 'check', '--only', 'tests'], f.cwd, join(f.cwd, 'cli.log'));
  expect(passing.code).toBe(0);
  expect(passing.output).toContain('tests: ok');
  expect(passing.output).toContain('no test files named in brief');
  const failing = await runCheckCommand([process.execPath, command, 'check', '--only', 'invalid'], f.cwd, join(f.cwd, 'cli.log'));
  expect(failing.code).toBe(1);
  expect(failing.output).toContain('Unknown check group');
});
