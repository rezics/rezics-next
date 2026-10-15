import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBrief } from './briefs.ts';
import { checkChangedFiles, checkFailureLines, parseCheckArgs, runCheckCommand, workerCheck, type CheckRunner } from './check.ts';
import { tierBunTestArgs } from '../qa/core.ts';
import { withSlot } from './qa-slots.ts';
import { type SlowTestRecord } from './unit-gate.ts';
import { inferenceGateCommand } from '../api/inference-cost.ts';
import { runSurfaceGate } from './surface-gate.ts';

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
    slotOptions: { slotDirectory: join(cwd, '.temp/slots'), slots: 1, reap: () => {}, announce: () => {} },
    historyDirectory: join(cwd, '.temp/history'),
    changed: ['scripts/example.ts', 'tests/qa/integration/outcomes/example.test.ts'], tests: ['scripts/example.test.ts'] };
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
  expect(f.commands).toContainEqual(['node_modules/.bin/oxlint', 'scripts/example.ts']);
  expect(f.commands).toContainEqual(['task', 'ast-grep', '--', 'scan', 'scripts/example.ts']);
  expect(f.commands.find(command => command[1] === 'scripts/qa/test.ts')?.slice(0, 3))
    .toEqual(['bun', 'scripts/qa/test.ts', 'scripts/example.test.ts']);
  expect(f.commands.find(command => command[1] === 'guards')?.slice(0, 5))
    .toEqual(['task', 'guards', '--', '--timeout=5000', 'scripts/qa/repository-guards.test.ts']);
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

test('API changes run the inference gate in the types lane and propagate a planted regression', async () => {
  const f = fixture();
  const changed = ['services/main/src/app.ts', 'tests/qa/client/main-contract.ts'];
  const runner: CheckRunner = async (command, cwd, log) => command.includes('scripts/api/inference-cost.ts')
    ? { code: 1, output: 'error: Inference cost regression:\neden.instantiations: 1100 exceeds 1050 (baseline 1000, +5%)' }
    : f.runner(command, cwd, log);
  const result = await workerCheck({ ...f, changed, only: ['types'], runner });
  expect(result.code).toBe(1);
  expect(result.checks.find(check => check.name === 'inference')?.code).toBe(1);
  expect(f.lines.join('\n')).toContain('eden.instantiations: 1100 exceeds 1050');
  const passing = await workerCheck({ ...f, changed, only: ['types'] });
  expect(passing.code).toBe(0);
  expect(f.commands).toContainEqual(inferenceGateCommand);
});

test('merge evidence covers only its completed types and files while newly selected checks still run', async () => {
  const f = fixture();
  const result = await workerCheck({ ...f, changed: ['services/main/src/app.ts'],
    tests: ['scripts/example.test.ts', 'scripts/another.test.ts'],
    completed: { typeWorkspaces: ['main'], testFiles: ['scripts/example.test.ts'] } });
  expect(result.code).toBe(0);
  expect(f.commands.some(command => command[1] === 'main:typecheck')).toBe(false);
  expect(f.commands).toContainEqual(inferenceGateCommand);
  expect(f.commands.find(command => command[1] === 'scripts/qa/test.ts')?.slice(2, 3))
    .toEqual(['scripts/another.test.ts']);
  expect(f.commands.flat()).not.toContain('scripts/example.test.ts');
});

test('successful checks reuse the same clean tree and selection, but never dirty trees or failures', async () => {
  const f = fixture();
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: f.cwd, encoding: 'utf8' });
    expect(result.status).toBe(0);
    return result.stdout.trim();
  };
  git('init', '-qb', 'main');
  git('config', 'user.name', 'Check fixture');
  git('config', 'user.email', 'check@example.invalid');
  writeFileSync(join(f.cwd, '.gitignore'), '.temp/\n');
  git('add', '.'); git('commit', '-qm', 'Initial tree');
  const options = { ...f, treePrepared: true, cache: true, only: ['lint'] as const };
  expect((await workerCheck(options)).code).toBe(0);
  const count = f.commands.length;
  git('commit', '--allow-empty', '-qm', 'Same tree under a new commit');
  expect((await workerCheck(options)).code).toBe(0);
  expect(f.commands).toHaveLength(count);
  expect(f.lines.join('\n')).toContain('reused successful check for tree');

  writeFileSync(join(f.cwd, 'scripts/example.ts'), 'export const changed = true;\n');
  await workerCheck(options);
  expect(f.commands).toHaveLength(count * 2);
  git('add', '.'); git('commit', '-qm', 'Changed tree');
  await workerCheck(options);
  expect(f.commands).toHaveLength(count * 3);
  await workerCheck({ ...options, changed: ['scripts/example.test.ts'] });
  expect(f.commands).toHaveLength(count * 4);

  git('commit', '--allow-empty', '-qm', 'Still the same tree');
  writeFileSync(join(f.cwd, 'scripts/example.ts'), 'export const fail = true;\n');
  git('add', '.'); git('commit', '-qm', 'Failing tree');
  let attempts = 0;
  const runner: CheckRunner = async () => { attempts++; return { code: 1, output: 'error: planted failure' }; };
  expect((await workerCheck({ ...options, runner })).code).toBe(1);
  expect((await workerCheck({ ...options, runner })).code).toBe(1);
  expect(attempts).toBe(count * 2);
});

test('surface check and landing also refuse an inference regression before QA', async () => {
  const f = fixture();
  const selection = { main: 'main', rows: [], changed: ['tests/qa/client/main-contract.ts'], units: [], stories: [], guards: [], proofs: [] };
  for (const workerStatic of [true, false]) {
    let qaStarted = false;
    const runner: CheckRunner = async (command, cwd, log) => {
      if (command[1] === 'scripts/qa/test.ts') qaStarted = true;
      return command.includes('scripts/api/inference-cost.ts') ? { code: 1, output: 'error: Inference cost regression' } : f.runner(command, cwd, log);
    };
    const result = await runSurfaceGate(f.cwd, selection, { ...f, runner, workerStatic, only: ['types'],
      gateLaneOptions: { directory: join(f.cwd, '.temp/gate-lanes'), announce: () => {} } });
    expect(result.code).toBe(1);
    expect(result.checks.find(check => check.name === 'types')?.code).toBe(1);
    expect(qaStarted).toBe(false);
  }
});

test('worker guards use changed inputs and report empty changes without acquiring a QA slot', async () => {
  const f = fixture();
  for (const [changed, runs] of [
    [[], false],
    [['apps/web/app/page.tsx'], false],
    [['tests/qa/integration/outcomes/new.test.ts'], true],
    [['scripts/qa/repository-guards.ts'], true],
    [['scripts/qa/repository-guards.test.ts'], true],
  ] as const) {
    f.commands.length = 0;
    f.lines.length = 0;
    const result = await workerCheck({ ...f, changed, only: ['guards'] });
    expect(result.code).toBe(0);
    expect(f.commands.some(command => command[1] === 'guards')).toBe(runs);
    expect(f.lines.filter(line => line.startsWith('Repository guards:'))).toHaveLength(1);
    if (!changed.length) expect(f.lines.join('\n')).toMatch(/Repository guards: 0\/\d+ selected for changed paths: \(none\)/);
  }
});

test('a failed test prints the case name with its error and never passing cases', async () => {
  const f = fixture();
  const runner: CheckRunner = async (command, cwd, log) => command[1] === 'scripts/qa/test.ts'
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
  expect(parseBrief('---\npaths: ["scripts/a.ts","scripts/b/**", \'scripts/c.ts\']\n---\n').paths)
    .toEqual(['scripts/a.ts', 'scripts/b/**', 'scripts/c.ts']);
  expect(parseBrief('---\nid: example\n---\n').tests).toEqual([]);
});

test('the default brief supplies all test files to one QA call, and an absent list starts no test command', async () => {
  const f = fixture();
  const brief = join(f.cwd, '.temp/goal/brief.md');
  mkdirSync(join(brief, '..'), { recursive: true });
  writeFileSync(brief, '---\ntests: [scripts/example.test.ts, scripts/another.test.ts]\n---\n');
  await workerCheck({ ...f, tests: undefined, only: ['tests'] });
  expect(f.commands).toHaveLength(1);
  expect(f.commands[0]?.slice(0, 4)).toEqual(['bun', 'scripts/qa/test.ts', 'scripts/example.test.ts', 'scripts/another.test.ts']);
  f.commands.length = 0;
  writeFileSync(brief, '---\nid: example\n---\n');
  const result = await workerCheck({ ...f, tests: undefined, only: ['tests'] });
  expect(f.commands).toHaveLength(0);
  expect(result.code).toBe(0);
  expect(f.lines.join('\n')).toContain('no test files named in brief');
});

test('a surface cannot hide missing rows and stories behind a types-only check', async () => {
  const f = fixture();
  const brief = join(f.cwd, '.temp/goal/brief.md');
  mkdirSync(join(brief, '..'), { recursive: true });
  writeFileSync(brief, '---\nkind: surface\nrows: []\ntests: []\n---\n');
  const plan = join(f.cwd, '.temp/plan'); writeFileSync(plan, '');
  const saved = process.env.GOAL_TEST_PLAN; process.env.GOAL_TEST_PLAN = plan;
  try {
    const result = await workerCheck({ ...f, tests: undefined, changed: [], only: ['types'] });
    expect(result.code).toBe(1);
    expect(result.checks.map(check => check.name)).toEqual(['selection']);
    expect(f.commands).toHaveLength(0);
    expect(f.lines.join('\n')).toContain('surface requires rows:');
    expect(f.lines.join('\n')).toContain('at least one web *.stories.tsx');
  } finally {
    if (saved === undefined) delete process.env.GOAL_TEST_PLAN; else process.env.GOAL_TEST_PLAN = saved;
  }
});

test('a wave build surface runs only the requested stack-free groups', async () => {
  const f = fixture();
  const brief = join(f.cwd, '.temp/goal/brief.md');
  mkdirSync(join(brief, '..'), { recursive: true });
  writeFileSync(brief, '---\nkind: surface\nrows: []\ntests: []\n---\n\n## Wave\n\nBuild task of wave/1.\n');
  const result = await workerCheck({ ...f, tests: undefined, changed: [], only: ['types'] });
  expect(result.checks.map(check => check.name)).not.toContain('selection');
  expect(f.lines.join('\n')).not.toContain('surface requires rows:');
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
    if (command[1] === 'scripts/qa/test.ts') testsDuringTypes = activeHeavy === 1;
    if (command.includes('scripts/qa/repository-guards.test.ts')) { guardsDuringTypes = activeHeavy === 1; releaseTypes(); }
    if (command[1]?.endsWith(':typecheck')) await typesBlocked;
    if (heavy) activeHeavy--;
    return { code: 0, output: '' };
  };
  // A missing guard must fail the overlap assertions rather than leave a pending runner forever.
  const watchdog = setTimeout(releaseTypes, 1000);
  try { await workerCheck({ ...f, changed: [...f.changed, 'apps/web/example.ts'], runner }); }
  finally { clearTimeout(watchdog); releaseTypes(); }
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
  const runner: CheckRunner = async (_command, _cwd, _log, env) => {
    const target = env!.REZICS_QA_ARTIFACT_ROOT!;
    mkdirSync(join(target, 'logs'), { recursive: true });
    writeFileSync(join(target, 'logs/owner.log'), readFileSync(join(artifacts, 'logs/owner.log')));
    writeFileSync(join(target, 'owner.xml'), readFileSync(join(artifacts, 'owner.xml')));
    return { code: 1, output: `QA artifacts: ${artifacts}\n` };
  };
  const result = await workerCheck({ ...f, only: ['tests'], runner });
  expect(result.code).toBe(1);
  expect(f.lines.join('\n')).toContain('(fail) person & program');
  expect(f.lines.join('\n')).toContain('error: expected authority');
  expect(f.lines.join('\n')).not.toContain('hidden passing case');
  expect(readFileSync(result.log, 'utf8')).toContain('complete hosted transcript');
});

test('a hosted owner timeout uses six times its tier budget and retains its recovered report', async () => {
  const f = fixture();
  const commands: string[][] = [];
  const runner: CheckRunner = async (command, _cwd, _log, env) => {
    commands.push([...command]);
    const failure = commands.length === 1 ? '<failure type="TimeoutError" message="test timed out"/>' : '';
    writeFileSync(join(env!.REZICS_QA_ARTIFACT_ROOT!, 'owner.xml'),
      `<testsuites><testcase file="scripts/example.test.ts" name="owner guard" time="32.5">${failure}</testcase></testsuites>`);
    return { code: failure ? 1 : 0, output: 'hosted owner report\n' };
  };
  const result = await workerCheck({ ...f, only: ['tests'], runner });
  expect(result.code).toBe(0);
  expect(commands).toHaveLength(2);
  expect(commands[0]).not.toContain('--timeout=180000');
  expect(commands[1]).toContain('--timeout=180000');
  expect(commands[1]).not.toContain('--reporter=junit');
  expect(f.lines.join('\n')).toContain('Timeout retry passed: scripts/example.test.ts > owner guard (32.500s)');
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

function sleepFixture(testBody: string, guardBody = '') {
  const f = fixture();
  const file = 'tests/qa/unit/slow.test.ts';
  const guard = 'scripts/qa/repository-guards.test.ts';
  const guardRunner = join(import.meta.dir, '../qa/repository-guards.ts');
  writeFileSync(join(f.cwd, 'Taskfile.yml'), `version: "3"\ntasks:\n  goal:unit-files:\n    cmds:\n      - bun test {{.CLI_ARGS}}\n  guards:\n    cmds:\n      - bun '${guardRunner}' {{.CLI_ARGS}}\n`);
  for (const [path, body] of [[file, testBody], [guard, guardBody]]) {
    mkdirSync(join(f.cwd, path!, '..'), { recursive: true });
    writeFileSync(join(f.cwd, path!), `import { test, expect } from 'bun:test';
import { appendFileSync } from 'node:fs';
test('busy ${path === file ? 'test' : 'guard'}', async () => {
  appendFileSync('attempts', ${JSON.stringify(path)} + ' ' + process.argv.join(' ') + '\\n');
  ${body}
});\n`);
  }
  const calls: string[][] = [];
  const runner: CheckRunner = async (command, cwd, log, env) => {
    expect(env!.GOAL_IN_SLOT).toBe('0');
    expect(env!.GOAL_QA_SLOT_DIRECTORY).toBe(f.slotOptions.slotDirectory);
    // This fixture has its own checkout's Task command, so it executes real Bun tests without the repository's hosted stack.
    const invocation = command[1] === 'scripts/qa/test.ts'
      ? ['task', 'goal:unit-files', '--', ...tierBunTestArgs('unit', command.slice(2)).slice(1)] : command;
    // The worker wrapper defers admission to the harness. This local runner
    // owns the same lease around its child instead of competing for live slots.
    let result: Awaited<ReturnType<CheckRunner>> | undefined;
    await withSlot(['fixture-proof'], false, undefined, { ...f.slotOptions, env,
      runCommand: async (_command, admitted) => {
        expect(admitted.GOAL_IN_SLOT).toBe('1');
        expect(existsSync(join(f.slotOptions.slotDirectory, '0'))).toBe(true);
        calls.push([...command]);
        result = await runCheckCommand(invocation, cwd, log, admitted);
        return result.code;
      },
    });
    return result!;
  };
  return { ...f, tests: [file], file, guard, runner, calls };
}

test('tests and guards recover with the longer retry under runner admission, tests first, leases released', async () => {
  const f = sleepFixture('await Bun.sleep(5_100);', 'await Bun.sleep(5_100);');
  const result = await workerCheck({ ...f, only: ['tests', 'guards'] });
  expect(result.code).toBe(0);
  expect(result.checks.map(check => check.name)).toEqual(['tests', 'guards']);
  expect(f.calls).toHaveLength(4);
  expect(f.calls.slice(0, 2).every(command => command[1] === 'scripts/qa/test.ts')).toBe(true);
  expect(f.calls[2]![1]).toBe('guards');
  expect(f.calls[3]![1]).toBe('goal:unit-files');
  expect(f.calls[1]).toContain('--timeout=30000');
  expect(f.calls[3]).toContain('--timeout=30000');
  expect(f.lines.filter(line => line.startsWith('Timeout retry passed:'))).toHaveLength(2);
  expect(f.lines.join('\n')).toContain(`${f.file} > busy test (`);
  expect(f.lines.join('\n')).toContain(`${f.guard} > busy guard (`);
  expect(existsSync(join(f.slotOptions.slotDirectory, '0'))).toBe(false);
  const records = JSON.parse(readFileSync(join(f.historyDirectory, 'timeout-retry-history.json'), 'utf8')) as SlowTestRecord[];
  expect(records.map(record => record.file)).toEqual([f.file, f.guard]);
  expect(records.every(record => record.seconds > 5 && record.loadAverage.length === 3)).toBe(true);
  expect(readFileSync(join(result.log, '../timeout-retries.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
}, 65_000);

test('an assertion is never retried and guards still finish inside the slot', async () => {
  const f = sleepFixture('expect(1).toBe(2);');
  const result = await workerCheck({ ...f, only: ['tests', 'guards'] });
  expect(result.code).toBe(1);
  expect(result.checks.find(check => check.name === 'guards')!.code).toBe(0);
  expect(f.calls).toHaveLength(2);
  expect(f.calls.some(command => command.includes('--timeout=30000'))).toBe(false);
  expect(f.lines.join('\n')).toContain('(fail) busy test');
  expect(existsSync(join(f.slotOptions.slotDirectory, '0'))).toBe(false);
});

test('a worker’s passing test and guard can print nested failures and timeouts without any retry', async () => {
  const body = "console.log('tests/qa/unit/slow.test.ts:\\n(fail) nested guard\\nthis test timed out after 5000ms\\n 1 fail');";
  const f = sleepFixture(body, body);
  const result = await workerCheck({ ...f, only: ['tests', 'guards'] });
  expect(result.code).toBe(0);
  expect(f.calls).toHaveLength(2);
  expect(f.calls.some(command => command.includes('--timeout=30000'))).toBe(false);
  expect(f.lines.some(line => line.startsWith('Timeout retry passed:'))).toBe(false);
});

test('a timeout beside a passing file retries only the timed out file and the check passes', async () => {
  const f = sleepFixture('await Bun.sleep(5_100);');
  const other = 'tests/qa/unit/fast.test.ts';
  writeFileSync(join(f.cwd, other), "import { test } from 'bun:test'; test('fast companion', () => {});\n");
  const result = await workerCheck({ ...f, tests: [f.file, other], only: ['tests'] });
  expect(result.code).toBe(0);
  expect(f.calls).toHaveLength(2);
  expect(f.calls[0]).toContain(other);
  expect(f.calls[1]).not.toContain(other);
}, 40_000);

test('a worker test that times out again fails after exactly one retry and releases its slot', async () => {
  const f = sleepFixture('await Bun.sleep(31_000);');
  const result = await workerCheck({ ...f, only: ['tests'] });
  expect(result.code).toBe(1);
  expect(f.calls).toHaveLength(2);
  expect(f.lines.join('\n')).toContain('(fail) busy test');
  expect(f.lines.filter(line => line.startsWith('Timeout retry passed:'))).toHaveLength(0);
  expect(existsSync(join(f.slotOptions.slotDirectory, '0'))).toBe(false);
}, 65_000);

function currencyFixture() {
  const f = fixture();
  const main = f.cwd;
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.email', 'check@example.invalid');
  git(main, 'config', 'user.name', 'worker check test');
  writeFileSync(join(main, '.gitignore'), '.temp/\n');
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'Initial tree');
  const cwd = join(main, '.temp/worker');
  git(main, 'worktree', 'add', '-qb', 'goal/worker', cwd);
  const commit = (tree: string, file: string, content: string) => {
    mkdirSync(join(tree, file, '..'), { recursive: true });
    writeFileSync(join(tree, file), content);
    git(tree, 'add', file);
    git(tree, 'commit', '-qm', `Change ${file}`);
    return git(tree, 'rev-parse', 'HEAD');
  };
  return { ...f, cwd, main, git, commit, changed: undefined, tests: [], only: ['types'] as const };
}

test('wave checks select only the worker commits and staged, unstaged and untracked edits', () => {
  const f = currencyFixture();
  f.git(f.main, 'checkout', '-qb', 'wave/1');
  const wave = f.commit(f.main, 'scripts/wave.ts', 'export {};\n');
  f.git(f.cwd, 'merge', '--ff-only', wave);
  f.git(f.main, 'checkout', 'main');
  f.commit(f.main, 'scripts/main.ts', 'export {};\n');
  f.commit(f.cwd, 'scripts/own.ts', 'export {};\n');
  writeFileSync(join(f.cwd, 'scripts/staged.ts'), 'export {};\n');
  f.git(f.cwd, 'add', 'scripts/staged.ts');
  writeFileSync(join(f.cwd, 'scripts/example.ts'), 'export const edited = true;\n');
  writeFileSync(join(f.cwd, 'scripts/untracked.ts'), 'export {};\n');
  expect(checkChangedFiles(f.cwd)).toEqual([
    'scripts/example.ts', 'scripts/own.ts', 'scripts/staged.ts', 'scripts/untracked.ts',
  ]);
});

test('a clean wave check updates to the wave and selects only worker changes', async () => {
  const f = currencyFixture();
  f.git(f.main, 'checkout', '-qb', 'wave/1');
  const wave = f.commit(f.main, 'apps/web/wave.ts', 'export {};\n');
  f.git(f.cwd, 'merge', '--ff-only', wave);
  f.commit(f.cwd, 'scripts/own.ts', 'export {};\n');
  const latest = f.commit(f.main, 'apps/web/latest.ts', 'export {};\n');
  f.git(f.main, 'checkout', 'main');
  f.commit(f.main, 'scripts/main.ts', 'export {};\n');
  const result = await workerCheck(f);
  expect(result.code).toBe(0);
  expect(f.lines[0]).toContain('1 commits behind wave/1; rebased');
  expect(f.git(f.cwd, 'rev-parse', 'HEAD^')).toBe(latest);
  expect(checkChangedFiles(f.cwd)).toEqual(['scripts/own.ts']);
  expect(f.commands).toEqual([['task', 'scripts:typecheck']]);
});

test.each([false, true])('a clean check updates to main before selecting and running checks (worker commit=%s)', async ownCommit => {
  const f = currencyFixture();
  if (ownCommit) f.commit(f.cwd, 'scripts/worker.ts', 'export const worker = true;\n');
  const before = f.git(f.cwd, 'rev-parse', 'HEAD');
  const main = f.commit(f.main, 'scripts/qa/fix.ts', 'export const fix = true;\n');
  const observed: string[] = [];
  const result = await workerCheck({ ...f, runner: async (command, cwd, log) => {
    observed.push(f.git(cwd, 'rev-parse', 'HEAD'));
    expect(readFileSync(join(cwd, 'scripts/qa/fix.ts'), 'utf8')).toContain('fix');
    return f.runner(command, cwd, log);
  } });
  const after = f.git(f.cwd, 'rev-parse', 'HEAD');
  expect(result.code).toBe(0);
  expect(after).not.toBe(before);
  expect(f.lines[0]).toBe(`worker worktree: ${before} -> ${after}; 1 commits behind main; ${ownCommit ? 'rebased' : 'fast-forwarded'}`);
  expect(observed.every(head => head === after)).toBe(true);
  if (ownCommit) {
    expect(f.git(f.cwd, 'rev-parse', 'HEAD^')).toBe(main);
    expect(f.commands).toContainEqual(['task', 'scripts:typecheck']);
  } else {
    expect(after).toBe(main);
    expect(f.commands).toEqual([]);
  }
});

test('a conflict is aborted with its files named and no checks run', async () => {
  const f = currencyFixture();
  const before = f.commit(f.cwd, 'scripts/example.ts', 'export const worker = true;\n');
  f.commit(f.main, 'scripts/example.ts', 'export const main = true;\n');
  const result = await workerCheck(f);
  expect(result.code).toBe(1);
  expect(f.commands).toEqual([]);
  expect(f.lines).toHaveLength(1);
  expect(f.lines[0]).toContain('rebase undone; conflicts: scripts/example.ts');
  expect(readFileSync(result.log, 'utf8')).toContain('scripts/example.ts');
  expect(f.git(f.cwd, 'rev-parse', 'HEAD')).toBe(before);
  expect(f.git(f.cwd, 'status', '--porcelain')).toBe('');
  expect(existsSync(f.git(f.cwd, 'rev-parse', '--git-path', 'rebase-merge'))).toBe(false);
});

test.each(['staged', 'unstaged', 'untracked'])('a check with %s changes stays on its tree and warns about the old harness', async kind => {
  const f = currencyFixture();
  const before = f.git(f.cwd, 'rev-parse', 'HEAD');
  f.commit(f.main, 'scripts/qa/fix.ts', 'export const fix = true;\n');
  const file = kind === 'untracked' ? 'scripts/untracked.ts' : 'scripts/example.ts';
  writeFileSync(join(f.cwd, file), 'export const unfinished = true;\n');
  if (kind === 'staged') f.git(f.cwd, 'add', file);
  const status = f.git(f.cwd, 'status', '--porcelain');
  const result = await workerCheck(f);
  expect(result.code).toBe(0);
  expect(f.commands).toContainEqual(['task', 'scripts:typecheck']);
  expect(f.lines[0]).toContain('Harness: 1 commits behind main');
  expect(f.lines.filter(line => line.includes('worktree:'))).toEqual([]);
  expect(f.git(f.cwd, 'rev-parse', 'HEAD')).toBe(before);
  expect(f.git(f.cwd, 'status', '--porcelain')).toBe(status);
});

test('checking the main checkout runs the selected checks without updating or warning', async () => {
  const f = currencyFixture();
  const before = f.commit(f.main, 'scripts/example.ts', 'export const main = true;\n');
  const result = await workerCheck({ ...f, cwd: f.main, changed: ['scripts/example.ts'] });
  expect(result.code).toBe(0);
  expect(f.commands).toContainEqual(['task', 'scripts:typecheck']);
  expect(f.lines.filter(line => line.includes('worktree:') || line.startsWith('Harness:'))).toEqual([]);
  expect(f.git(f.main, 'rev-parse', 'HEAD')).toBe(before);
});
