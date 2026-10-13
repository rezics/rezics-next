import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBrief } from './briefs.ts';
import { workerCheck, type CheckRunner } from './check.ts';
import { preMergeSurfaceGate } from './unit-gate.ts';
import { selectSurface, runSurfaceGate } from './surface-gate.ts';

const roots: string[] = [];
const previousPlan = process.env.GOAL_TEST_PLAN;
afterEach(() => {
  if (previousPlan === undefined) delete process.env.GOAL_TEST_PLAN;
  else process.env.GOAL_TEST_PLAN = previousPlan;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const parent = join(import.meta.dir, '../../.temp/surface-gate-tests');
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
  write('scripts/qa/repository-guards.test.ts', 'export {};');
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
  return { cwd, row, brief, changed, write, git, commands, runner, slotOptions, print: () => {} };
}

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
    if (command[1] === 'scripts/qa/test.ts') environments.push(JSON.stringify(env));
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
    guards: command => command.includes('scripts/qa/repository-guards.test.ts'),
    stories: command => command.includes('apps/web/features/zones/catalogue.stories.tsx'),
  };
  const runner: CheckRunner = async command => {
    f.commands.push([...command]); return { code: commands[failed]!(command) ? 1 : 0, output: 'error: fixture failure' };
  };
  const check = await workerCheck({ ...f, runner });
  expect(check.code).toBe(1); expect(check.checks.at(-1)?.name).toBe(failed);
  const checkCommands = [...f.commands]; f.commands.length = 0;
  expect(await preMergeSurfaceGate(f.cwd, 'main', f.brief, f.changed, new Set(), { ...f, runner })).toContain('surface gate failed');
  expect(f.commands).toEqual(checkCommands);
  expect(f.commands.filter(commands[failed]!)).toHaveLength(1);
});

test('a non-surface brief never enters selection', async () => {
  const f = fixture();
  expect(await selectSurface(f.cwd, { ...f.brief, kind: 'implementation', rows: [], tests: [] }, f.changed)).toBeUndefined();
});
