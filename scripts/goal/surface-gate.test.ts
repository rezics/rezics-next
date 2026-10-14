import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBrief } from './briefs.ts';
import { workerCheck, type CheckRunner } from './check.ts';
import { preMergeSurfaceGate, UNIT_JUNIT_MARKER } from './unit-gate.ts';
import { selectSurface, runSurfaceGate, type SurfaceSelection, type SurfaceExcusedTest } from './surface-gate.ts';

const roots: string[] = [];
const previousPlan = process.env.GOAL_TEST_PLAN;
afterEach(() => {
  if (previousPlan === undefined) delete process.env.GOAL_TEST_PLAN;
  else process.env.GOAL_TEST_PLAN = previousPlan;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  // Exercise the gate's nested checkout paths, where the ancestor itself contains "unit-gate-".
  const parent = join(import.meta.dir, '../../.temp/unit-gate-fixtures/surface-gate-tests');
  mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(join(parent, 'case-')); roots.push(cwd);
  const write = (file: string, value: string) => {
    mkdirSync(join(cwd, file, '..'), { recursive: true }); writeFileSync(join(cwd, file), value);
  };
  const git = (...args: string[]) => {
    const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (run.status) throw new Error(run.stderr);
    return run.stdout.trim();
  };
  const row = 'books/catalogue';
  for (const file of ['outcomes.ts', 'outcome-cells.ts']) {
    write(`scripts/qa/cases/${file}`, readFileSync(join(import.meta.dir, '../qa/cases', file), 'utf8'));
  }
  write('scripts/qa/cases/launch-coverage.ts', `export interface LaunchCoverage { kind: string; capability: string; hardCase?: string }
export const launchCoverage = [{kind:'books', capability:'catalogue'}];`);
  const personas = ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'];
  write(`scripts/qa/cases/outcomes/${row}.ts`, `import { rowOutcomes, proved } from '../../outcome-cells.ts';
export default rowOutcomes('${row}', {${personas.map(persona => `${persona}: proved('reads catalogue')`).join(',')}});`);
  write(`tests/qa/integration/outcomes/${row}.test.ts`, `import { test } from 'bun:test';
${personas.map(persona => `test('${row} / ${persona}: reads catalogue', () => {});`).join('\n')}`);
  write(`tests/qa/fixtures/outcomes/${row}.json`, '{}');
  write('apps/web/features/zones/catalogue.ts', 'export const count = 1;');
  write('apps/web/features/zones/catalogue.test.ts', "import { test } from 'bun:test'; test('count', () => {});");
  write('apps/web/features/zones/catalogue.stories.tsx', 'export default {};');
  write('scripts/static/web-continuations.test.ts', 'export {};');
  write('.gitignore', '.temp/');
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Surface tests'); git('config', 'user.email', 'surface@example.invalid');
  git('add', '.'); git('commit', '-qm', 'Prove catalogue'); git('switch', '-qc', 'surface');
  const plan = join(cwd, '.temp/plan');
  write('.temp/plan', '  unit: apps/web/features/zones/catalogue.test.ts\n'); process.env.GOAL_TEST_PLAN = plan;
  const brief = parseBrief(`---\nkind: surface\nrows: [${row}]\ntests: [apps/web/features/zones/catalogue.test.ts, apps/web/features/zones/catalogue.stories.tsx]\n---\n`);
  write('.temp/goal/brief.md', `---\nkind: surface\nrows: [${row}]\ntests: [${brief.tests!.join(', ')}]\n---\n`);
  const changed = ['apps/web/features/zones/catalogue.ts'];
  const commands: string[][] = [];
  const runner: CheckRunner = async command => { commands.push([...command]); return { code: 0, output: '' }; };
  const slotOptions = { slotDirectory: join(cwd, '.temp/slots'), slots: 1, reap: () => {}, announce: () => {} };
  const gateLaneOptions = { directory: join(cwd, '.temp/gate-lanes'), lanes: 1, announce: () => {} };
  return { cwd, row, brief, changed, write, git, commands, runner, slotOptions, gateLaneOptions, print: () => {} };
}

test('surface guards follow changed inputs and cannot reappear through the affected transcript', async () => {
  const f = fixture();
  f.write('services/main/tests/api-contract.test.ts', 'export {};');
  f.write('scripts/qa/repository-guards.test.ts', 'export {};');
  f.write('.temp/plan', '  unit: services/main/tests/api-contract.test.ts\n  unit: scripts/static/web-continuations.test.ts\n');
  const web = (await selectSurface(f.cwd, f.brief, f.changed))!.selection!;
  expect(web.guards).toEqual(['scripts/static/web-continuations.test.ts']);
  expect(web.units).not.toContain('services/main/tests/api-contract.test.ts');
  const service = (await selectSurface(f.cwd, f.brief, ['services/main/src/modules/work/read.ts']))!.selection!;
  expect(service.guards).toEqual(['services/main/tests/api-contract.test.ts']);
  expect(service.units).not.toContain('scripts/static/web-continuations.test.ts');
  expect((await selectSurface(f.cwd, f.brief, []))!.selection!.guards).toEqual([]);
  const registry = (await selectSurface(f.cwd, f.brief, ['scripts/qa/repository-guards.ts']))!.selection!;
  expect(registry.guards).toHaveLength(3);
});

test('surface selection reports every missing requirement on its own line', async () => {
  const f = fixture();
  rmSync(join(f.cwd, `tests/qa/fixtures/outcomes/${f.row}.json`));
  const selected = await selectSurface(f.cwd, { ...f.brief, tests: [] }, f.changed);
  expect(selected?.selection).toBeUndefined();
  expect(selected?.refusals).toEqual([
    `missing row record: tests/qa/fixtures/outcomes/${f.row}.json`,
    'surface requires tests: naming at least one web *.stories.tsx',
  ]);
  expect((await selectSurface(f.cwd, { ...f.brief, rows: [] }, f.changed))?.refusals)
    .toContain('surface requires rows: naming outcomes proved on main');
});

test('a branch cannot prove its own row; absent, pending and missing-persona main declarations refuse', async () => {
  for (const state of ['absent', 'pending', 'missing']) {
    const f = fixture();
    const file = `scripts/qa/cases/outcomes/${f.row}.ts`;
    const proved = readFileSync(join(f.cwd, file), 'utf8');
    if (state === 'absent') f.git('rm', file);
    else f.write(file, readFileSync(join(f.cwd, file), 'utf8').replace(state === 'pending' ? 'visitor: proved' : "visitor: proved('reads catalogue'),", state === 'pending' ? 'visitor: pending' : '').replace('rowOutcomes, proved', 'rowOutcomes, proved, pending'));
    if (state === 'pending') {
      const proof = `tests/qa/integration/outcomes/${f.row}.test.ts`;
      f.write(proof, readFileSync(join(f.cwd, proof), 'utf8').replace("test('books/catalogue / visitor", "test.failing('books/catalogue / visitor"));
    }
    f.git('add', '.'); f.git('commit', '-qm', 'Unproved main'); f.git('branch', '-f', 'main', 'HEAD');
    // Even a fresh branch declaration cannot replace main's proof.
    f.write(file, proved);
    expect((await selectSurface(f.cwd, f.brief, f.changed))?.refusals)
      .toContain(`row is not declared proved on main: ${f.row}`);
  }
});

test('declaration helpers and their transitive dependencies are read from pinned main', async () => {
  const f = fixture();
  const declaration = `scripts/qa/cases/outcomes/${f.row}.ts`;
  f.write('packages/fixture/proof.ts', "export const proofName = 'reads catalogue';");
  f.write('services/main/src/modules/access/fixture-authority.ts', "export { proofName } from '../../../../../packages/fixture/proof.ts';");
  f.write(declaration, "import { proofName } from '../../../../../services/main/src/modules/access/fixture-authority.ts';\n" +
    readFileSync(join(f.cwd, declaration), 'utf8').replaceAll("proved('reads catalogue')", 'proved(proofName)'));
  f.git('add', '.'); f.git('commit', '-qm', 'Declare with fixture helper'); f.git('branch', '-f', 'main', 'HEAD');
  f.write('packages/fixture/proof.ts', "export const proofName = 'unproved branch claim';");
  const selected = await selectSurface(f.cwd, f.brief, f.changed);
  expect(selected?.refusals).toEqual([]);
  expect(selected?.selection?.main).toBe(f.git('rev-parse', 'main'));
});

test('bad rows, missing tests, foreign paths and browser journeys are refused', async () => {
  const f = fixture();
  f.write('tests/qa/e2e/catalogue.test.ts', 'export {};');
  const selected = await selectSurface(f.cwd, { ...f.brief, rows: ['../bad'], tests: ['../outside.test.ts', '/outside.test.ts', 'apps/web/missing.stories.tsx', 'tests/qa/e2e/catalogue.test.ts'] }, f.changed);
  expect(selected?.refusals).toContain('invalid surface row: ../bad');
  expect(selected?.refusals.filter(line => /outside|missing named|must be a unit/.test(line))).toHaveLength(4);
});

test('frontend dependency units and widened unit files come from the affected owner', async () => {
  const f = fixture();
  delete process.env.GOAL_TEST_PLAN;
  f.write('packages/ui/src/catalogue.test.tsx', 'export {};');
  f.write('tests/qa/unit/extra.test.ts', 'export {};');
  f.write('scripts/qa/affected.ts', `export function affectedPlanForChanges() { return {
    tests: { unit: ['tests/qa/unit/extra.test.ts'] }, widened: [{ tier: 'unit' }],
    frontend: [{ tests: ['apps/web/features/zones/catalogue.test.ts', 'packages/ui/src/catalogue.test.tsx'] }]
  }; }`);
  const selected = await selectSurface(f.cwd, f.brief, f.changed);
  expect(selected?.refusals).toEqual([]);
  // A consumer the brief did not name runs once, beside the test it did name.
  expect(selected?.selection?.units).toEqual(['apps/web/features/zones/catalogue.test.ts', 'packages/ui/src/catalogue.test.tsx', 'tests/qa/unit/extra.test.ts']);
});

test('units, guards and only named stories run in order in one QA slot, with persisted timings', async () => {
  const f = fixture();
  const selected = (await selectSurface(f.cwd, f.brief, f.changed))!;
  expect(selected.refusals).toEqual([]);
  const environments: string[] = [];
  const result = await runSurfaceGate(f.cwd, selected.selection!, { ...f, runner: async (command, cwd, log, env) => {
    if (['scripts/qa/test.ts', 'goal:unit-files'].includes(command[1]!)) {
      const { REZICS_QA_ARTIFACT_ROOT: _artifacts, ...slotEnv } = env ?? {};
      environments.push(JSON.stringify(slotEnv));
    }
    return f.runner(command, cwd, log, env);
  } });
  expect(result.code).toBe(0);
  expect(result.checks.map(check => check.name)).toEqual(['contract', 'types', 'lint', 'ast', 'tests', 'guards', 'stories']);
  expect(f.commands.at(-1)).toEqual(['bun', 'scripts/qa/test.ts', 'apps/web/features/zones/catalogue.stories.tsx']);
  expect(new Set(environments).size).toBe(1);
  expect(JSON.parse(readFileSync(result.evidence, 'utf8')).checks).toEqual(result.checks);
  expect(result.checks.every(check => check.seconds >= check.waitSeconds && check.waitSeconds >= 0)).toBe(true);
});

test.each(['contract', 'types', 'lint', 'ast', 'tests', 'guards', 'stories'])('a failing %s stops both check and landing on the same part without retry', async failed => {
  const f = fixture();
  const commands: Record<string, (command: readonly string[]) => boolean> = {
    contract: command => command[1] === 'gen', types: command => command[1] === 'web:typecheck',
    lint: command => command[0]!.includes('oxlint'), ast: command => command[1] === 'ast-grep',
    tests: command => command.includes('apps/web/features/zones/catalogue.test.ts'),
    guards: command => command.includes('scripts/static/web-continuations.test.ts'),
    stories: command => command.includes('apps/web/features/zones/catalogue.stories.tsx'),
  };
  const runner: CheckRunner = async command => {
    f.commands.push([...command]); return { code: commands[failed]!(command) ? 1 : 0, output: 'error: fixture failure' };
  };
  const check = await workerCheck({ ...f, runner });
  expect(check.code).toBe(1); expect(check.checks.at(-1)?.name).toBe(failed);
  const checkCommands = [...f.commands]; f.commands.length = 0;
  expect(await preMergeSurfaceGate(f.cwd, 'main', f.brief, f.changed, new Set(), { ...f, runner })).toContain('surface gate failed');
  const stableCommands = (commands: string[][]) => commands.filter(command => command[0] !== 'node_modules/.bin/oxlint' && command[1] !== 'ast-grep')
    .map(command => command.filter(arg => !arg.startsWith('--reporter-outfile=')).map((arg, index) => index === 1 && arg === 'guards' ? 'goal:unit-files' : arg));
  expect(stableCommands(f.commands)).toEqual(stableCommands(checkCommands));
  expect(f.commands.filter(commands[failed]!)).toHaveLength(1);
});

test('a non-surface brief never enters selection', async () => {
  const f = fixture();
  expect(await selectSurface(f.cwd, { ...f.brief, kind: 'implementation', rows: [], tests: [] }, f.changed)).toBeUndefined();
});

function gateFixture(part: 'tests' | 'guards' = 'tests') {
  const f = fixture();
  const file = part === 'tests' ? 'apps/web/features/zones/catalogue.test.ts' : 'scripts/static/web-continuations.test.ts';
  const story = 'apps/web/features/zones/catalogue.stories.tsx';
  const selection: SurfaceSelection = { main: f.git('rev-parse', 'main'), rows: [f.row],
    units: part === 'tests' ? [file] : [], guards: part === 'guards' ? [file] : [],
    stories: [story], changed: f.changed, proofs: [] };
  const lines: string[] = [];
  const attempts: { cwd: string; command: readonly string[] }[] = [];
  const run = async (decide: (root: string, command: readonly string[], env?: NodeJS.ProcessEnv) => { code: number; output: string }) => {
    const runner: CheckRunner = async (command, root, _log, env) => {
      attempts.push({ cwd: root, command });
      return ['scripts/qa/test.ts', 'goal:unit-files'].includes(command[1]!) ? decide(root, command, env) : { code: 0, output: '' };
    };
    const result = await runSurfaceGate(f.cwd, selection, { ...f, runner, only: ['tests', 'guards'], print: line => lines.push(line) });
    const evidence = JSON.parse(readFileSync(result.evidence, 'utf8')) as { excused: SurfaceExcusedTest[] };
    return { ...result, excused: evidence.excused };
  };
  return { ...f, file, story, selection, attempts, lines, run };
}

function report(file: string, state: 'pass' | 'timeout' | 'assertion', name = 'busy surface guard', seconds = 5) {
  return { code: state === 'pass' ? 0 : 1,
    output: `${UNIT_JUNIT_MARKER}\n<testsuites><testsuite><testcase file="${file}" name="${name}" time="${seconds}">${
      state === 'pass' ? '' : `<failure type="${state === 'timeout' ? 'TimeoutError' : 'AssertionError'}" message="${state === 'timeout' ? 'test timed out after 5000ms' : 'expected 2'}"/>`
    }</testcase></testsuite></testsuites>` };
}

test.each(['tests', 'guards'] as const)('%s timeout reruns only its file with the longer limit and records both durations', async part => {
  const f = gateFixture(part);
  const sibling = 'apps/web/features/zones/other.test.ts';
  f.write(sibling, 'export {};');
  f.selection[part === 'tests' ? 'units' : 'guards'].push(sibling);
  const result = await f.run((_root, command) => {
    if (!command.includes(f.file)) return { code: 0, output: '' };
    return report(f.file, command.includes('--timeout=30000') ? 'pass' : 'timeout', undefined,
      command.includes('--timeout=30000') ? 5.2 : 5.001);
  });
  expect(result.code).toBe(0);
  const attempts = f.attempts.filter(attempt => attempt.command.includes(f.file));
  expect(attempts).toHaveLength(2);
  expect(attempts[0]!.command).toContain(sibling);
  expect(attempts[1]!.command).not.toContain(sibling);
  expect(attempts[1]!.command).toContain('--timeout=30000');
  expect(f.attempts.every(attempt => attempt.cwd === f.cwd)).toBe(true);
  expect(result.excused).toEqual([{ part, file: f.file, test: 'busy surface guard', reason: 'timeout-retry',
    revision: f.git('rev-parse', 'HEAD'), originalSeconds: 5.001, retrySeconds: 5.2 }]);
  expect(f.lines.join('\n')).toContain(`Timeout retry passed: ${f.file} > busy surface guard (5.200s); first attempt 5.001s, retry 5.200s`);
});

test('a timeout that fails alone blocks when the same test passes on main', async () => {
  const f = gateFixture();
  const result = await f.run((root, command) => {
    if (!command.includes(f.file)) return { code: 0, output: '' };
    return report(f.file, root !== f.cwd ? 'pass' : command.includes('--timeout=30000') ? 'assertion' : 'timeout');
  });
  expect(result.code).toBe(1);
  expect(result.checks.at(-1)?.name).toBe('tests');
  expect(result.excused).toEqual([]);
  expect(f.attempts.filter(attempt => attempt.command.includes(f.file))).toHaveLength(3);
});

test.each(['tests', 'guards'] as const)('%s failure also on pinned main is reported without charging the surface', async part => {
  const f = gateFixture(part);
  // A moving main ref must not change the gate's baseline.
  f.write('apps/web/features/zones/catalogue.ts', 'export const count = 2;');
  f.git('add', '.'); f.git('commit', '-qm', 'Advance main'); f.git('branch', '-f', 'main', 'HEAD');
  const result = await f.run((root, command) => {
    if (!command.includes(f.file)) return { code: 0, output: '' };
    if (root !== f.cwd) {
      expect(readFileSync(join(root, 'apps/web/features/zones/catalogue.ts'), 'utf8')).toBe('export const count = 1;');
      expect(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()).toBe(f.selection.main);
    }
    return report(f.file, 'assertion');
  });
  expect(result.code).toBe(0);
  expect(result.excused).toEqual([{ part, file: f.file, test: 'busy surface guard', reason: 'fails-on-main', revision: f.selection.main }]);
  expect(f.lines.join('\n')).toContain(`Failure on main: ${f.file} > busy surface guard (${f.selection.main})`);
  expect(f.attempts.filter(attempt => attempt.command.includes(f.file))).toHaveLength(2);
  expect(f.git('worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')))
    .toEqual([`worktree ${f.cwd}`]);
});

test('a branch-only failing test blocks even beside another test that fails on main in the same file', async () => {
  const f = gateFixture();
  const result = await f.run((root, command) => {
    if (!command.includes(f.file)) return { code: 0, output: '' };
    const inherited = report(f.file, 'assertion', 'existing failure');
    if (root !== f.cwd) return inherited;
    return { code: 1, output: inherited.output.replace('</testsuite>',
      `<testcase file="${f.file}" name="introduced failure"><failure type="AssertionError" message="expected 2"/></testcase></testsuite>`) };
  });
  expect(result.code).toBe(1);
  expect(result.excused.map(item => item.test)).toEqual(['existing failure']);
  expect(f.attempts.filter(attempt => attempt.command.includes(f.file))).toHaveLength(2);
});

test.each(['tests', 'guards'] as const)('%s file touched by the change cannot excuse main’s failure', async part => {
  const f = gateFixture(part);
  f.selection.changed.push(f.file);
  const result = await f.run((_root, command) => command.includes(f.file) ? report(f.file, 'assertion') : { code: 0, output: '' });
  expect(result.code).toBe(1);
  expect(result.excused).toEqual([]);
  expect(f.attempts.filter(attempt => attempt.command.includes(f.file))).toHaveLength(1);
  expect(f.attempts.every(attempt => attempt.cwd === f.cwd)).toBe(true);
});

test('a timed-out story is final without retry or a main baseline', async () => {
  const f = gateFixture();
  const result = await f.run((_root, command) => command.includes(f.story)
    ? report(f.story, 'timeout') : { code: 0, output: '' });
  expect(result.code).toBe(1);
  expect(result.checks.at(-1)?.name).toBe('stories');
  expect(result.excused).toEqual([]);
  expect(f.attempts.filter(attempt => attempt.command.includes(f.story))).toHaveLength(1);
  expect(f.attempts.every(attempt => attempt.cwd === f.cwd)).toBe(true);
});

test('an owner consumer’s own artifact supplies timeout attribution even when its console only links the report', async () => {
  const f = gateFixture();
  const file = 'scripts/qa/consumer.test.ts';
  f.selection.units = [file];
  const result = await f.run((_root, command, env) => {
    if (!command.includes(file)) return { code: 0, output: '' };
    expect(command.some(arg => arg.startsWith('--reporter='))).toBe(false);
    const retried = command.includes('--timeout=180000');
    const artifact = join(env!.REZICS_QA_ARTIFACT_ROOT!, 'run');
    mkdirSync(artifact, { recursive: true });
    const state = report(file, retried ? 'pass' : 'timeout', undefined, retried ? 30.2 : 30);
    writeFileSync(join(artifact, 'owner.xml'), state.output.slice(UNIT_JUNIT_MARKER.length));
    return { code: state.code, output: `QA artifacts: ${artifact}` };
  });
  expect(result.code).toBe(0);
  expect(result.excused).toEqual([{ part: 'tests', file, test: 'busy surface guard', reason: 'timeout-retry',
    revision: f.git('rev-parse', 'HEAD'), originalSeconds: 30, retrySeconds: 30.2 }]);
  expect(f.attempts.filter(attempt => attempt.command.includes(file))).toHaveLength(2);
});

test('mixed assertion and timeout failures do not qualify for retry, and main passing blocks them', async () => {
  const f = gateFixture();
  const result = await f.run((root, command) => {
    if (!command.includes(f.file)) return { code: 0, output: '' };
    if (root !== f.cwd) return report(f.file, 'pass');
    const timed = report(f.file, 'timeout');
    return { code: 1, output: timed.output.replace('</testsuite>',
      `<testcase file="${f.file}" name="assertion"><failure type="AssertionError" message="expected 2"/></testcase></testsuite>`) };
  });
  expect(result.code).toBe(1);
  expect(result.excused).toEqual([]);
  expect(f.attempts.every(attempt => !attempt.command.some(arg => arg.startsWith('--timeout=')))).toBe(true);
  expect(f.attempts.filter(attempt => attempt.command.includes(f.file))).toHaveLength(2);
});

test('a file absent from pinned main cannot gain a baseline allowance', async () => {
  const f = gateFixture();
  const file = 'apps/web/features/zones/new.test.ts';
  f.write(file, 'export {};');
  f.selection.units = [file];
  const result = await f.run((_root, command) => command.includes(file) ? report(file, 'assertion') : { code: 0, output: '' });
  expect(result.code).toBe(1);
  expect(result.excused).toEqual([]);
  expect(f.attempts.filter(attempt => attempt.command.includes(file))).toHaveLength(1);
});

test('surface workers narrow static tools while landing keeps full workspace types and type-aware lint', async () => {
  const f = fixture();
  f.write('apps/web/tsconfig.json', JSON.stringify({ compilerOptions: { noLib: true, types: [] }, include: ['features/**/*.ts', 'features/**/*.tsx'] }));
  f.write('apps/web/features/unrelated.ts', 'export {};');
  expect((await workerCheck(f)).code).toBe(0);
  expect(f.commands).toContainEqual(['task', 'goal:type-files', '--', '--project', 'apps/web/tsconfig.json', 'apps/web/features/zones/catalogue.ts']);
  expect(f.commands).toContainEqual(['node_modules/.bin/oxlint', 'apps/web/features/zones/catalogue.ts']);
  f.commands.length = 0;
  expect(await preMergeSurfaceGate(f.cwd, 'main', f.brief, f.changed, new Set(), f)).toBeUndefined();
  expect(f.commands).toContainEqual(['task', 'web:typecheck']);
  expect(f.commands).toContainEqual(['node_modules/.bin/oxlint', '--type-aware', 'apps/web/features/zones']);
});
