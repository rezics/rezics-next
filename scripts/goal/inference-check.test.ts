import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inferenceGateCommand, inferenceMargins, type Baseline } from '../api/inference-cost.ts';
import { workerCheck, type CheckRunner } from './check.ts';
import { inheritedInferenceRegressions, workerInferenceCheck } from './inference-check.ts';
import { runSurfaceGate } from './surface-gate.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const metrics = { instantiations: 1000, checkSeconds: 10, appBytes: 2000, routesBytes: 3000 };
function sample(cost = 1000): Baseline {
  return { format: 1, versions: { typescript: 'test' }, measurements: {
    main: { ...metrics, instantiations: cost }, web: { ...metrics }, eden: { ...metrics },
  } };
}

function fixture(baseCost: number, headCost: number) {
  const parent = join(import.meta.dir, '../../.temp/inference-check-tests');
  mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(join(parent, 'case-'));
  roots.push(cwd);
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git('init', '-qb', 'main');
  git('config', 'user.name', 'Inference fixture');
  git('config', 'user.email', 'inference@example.invalid');
  writeFileSync(join(cwd, '.gitignore'), '.temp/\n');
  mkdirSync(join(cwd, 'scripts/api'), { recursive: true });
  writeFileSync(join(cwd, 'scripts/api/inference-cost-baseline.json'), JSON.stringify(sample()));
  writeFileSync(join(cwd, 'scripts/api/cost'), '1000');
  git('add', '.'); git('commit', '-qm', 'Recorded baseline');
  git('checkout', '-qb', 'wave/fixture');
  writeFileSync(join(cwd, 'scripts/api/cost'), String(baseCost));
  git('add', '.'); git('commit', '--allow-empty', '-qm', 'Wave base');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'goal/fixture');
  // The head measurement includes uncommitted work; the base must remain the pinned wave commit.
  writeFileSync(join(cwd, 'scripts/api/cost'), String(headCost));
  writeFileSync(join(cwd, 'scripts/api/task.ts'), 'export {};\n');
  const calls: { command: readonly string[]; cwd: string }[] = [];
  const runner: CheckRunner = async (command, root) => {
    calls.push({ command: [...command], cwd: root });
    if (!command.includes('scripts/api/inference-cost.ts')) return { code: 0, output: '' };
    const cost = Number(readFileSync(join(root, 'scripts/api/cost'), 'utf8'));
    const artifacts = join(root, '.temp/api-inference/run-test');
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, 'measurements.json'), JSON.stringify(sample(cost)));
    return { code: cost > 1050 ? 1 : 0, output: `Inference artifacts: ${artifacts}\n`
      + (cost > 1050 ? `error: Inference cost regression:\nmain.instantiations: ${cost} exceeds 1050 (baseline 1000, +5%)` : 'Inference cost: ok') };
  };
  const directory = join(cwd, '.temp/check');
  mkdirSync(directory, { recursive: true });
  const lines: string[] = [];
  return { cwd, base, git, calls, runner, log: join(directory, 'inference.log'), lines,
    print: (line: string) => { lines.push(line); } };
}

for (const [name, baseCost, headCost, code, runs] of [
  ['passing head', 2000, 1000, 0, 1],
  ['failing head on passing base', 1000, 1100, 1, 2],
  ['unchanged inherited cost', 2000, 2000, 0, 2],
  ['inherited cost exactly at the growth margin', 2000, 2100, 0, 2],
  ['inherited cost with task regression', 2000, 2101, 1, 2],
] as const) {
  test(`worker inference: ${name}`, async () => {
    const f = fixture(baseCost, headCost);
    const result = await workerCheck({ cwd: f.cwd, treePrepared: true, runner: f.runner, print: f.print, only: ['types'] });
    expect(result.code).toBe(code);
    const measurements = f.calls.filter(call => call.command.includes('scripts/api/inference-cost.ts'));
    expect(measurements).toHaveLength(runs);
    expect(measurements.every(call => JSON.stringify(call.command) === JSON.stringify(inferenceGateCommand))).toBe(true);
    if (runs === 2) {
      expect(f.lines.join('\n')).toContain(`Inference base ${f.base} main:`);
      expect(f.lines.join('\n')).toContain(`"instantiations":${headCost}`);
      expect(f.lines.join('\n')).toContain(`"instantiations":${baseCost}`);
      expect(existsSync(measurements[1]!.cwd)).toBe(false);
    } else expect(f.calls.some(call => call.command[1] === 'install')).toBe(false);
    if (baseCost > 1050 && runs === 2) expect(f.lines.join('\n')).toContain('inherited from base');
  });
}

test('every metric retains its margin over an inherited base and newly failing budgets still block', () => {
  for (const project of ['main', 'web', 'eden'] as const) for (const metric of Object.keys(metrics) as (keyof typeof metrics)[]) {
    const base = sample();
    base.measurements[project][metric] *= 10;
    const head = structuredClone(base);
    head.measurements[project][metric] *= 1 + inferenceMargins[metric];
    expect(inheritedInferenceRegressions(sample(), head, base)).toEqual([]);
    head.measurements[project][metric] += 1;
    expect(inheritedInferenceRegressions(sample(), head, base)[0]).toContain(`${project}.${metric}`);
  }
  const base = sample(2000);
  const head = structuredClone(base);
  head.measurements.eden.appBytes = 2101;
  expect(inheritedInferenceRegressions(sample(), head, base)[0]).toContain('eden.appBytes');
});

test('merge mode cannot reuse a worker success excusing inherited inference cost', async () => {
  const f = fixture(2000, 2000);
  f.git('add', '.'); f.git('commit', '-qm', 'Task with inherited cost');
  const options = { cwd: f.cwd, treePrepared: true, runner: f.runner, print: f.print, only: ['types'] as const, cache: true };
  expect((await workerCheck(options)).code).toBe(0);
  const before = f.calls.length;
  expect((await workerCheck({ ...options, absoluteInference: true })).code).toBe(1);
  expect(f.calls.slice(before).filter(call => call.command.includes('scripts/api/inference-cost.ts'))).toHaveLength(1);
});

test('surface worker compares inherited budgets while landing enforces the recorded baseline', async () => {
  const f = fixture(2000, 2000);
  const selection = { main: 'main', rows: [], changed: ['tests/qa/client/contract.ts'], units: [], stories: [], guards: [], proofs: [] };
  const options = { runner: f.runner, print: f.print, only: ['types'] as const };
  expect((await runSurfaceGate(f.cwd, selection, { ...options, workerStatic: true })).code).toBe(0);
  expect((await runSurfaceGate(f.cwd, selection, { ...options, workerStatic: true, absoluteInference: true })).code).toBe(1);
  expect((await runSurfaceGate(f.cwd, selection, { ...options,
    gateLaneOptions: { directory: join(f.cwd, '.temp/lanes'), announce: () => {} } })).code).toBe(1);
});

for (const failure of ['missing head artifacts', 'base install', 'base crash', 'base versions', 'head versions'] as const) {
  test(`inconclusive ${failure} never excuses the head failure`, async () => {
    const f = fixture(2000, 2000);
    const runner: CheckRunner = async (command, cwd, log, env) => {
      if (failure === 'base install' && command[1] === 'install') return { code: 1, output: 'install failed' };
      const result = await f.runner(command, cwd, log, env);
      if (!command.includes('scripts/api/inference-cost.ts')) return result;
      if (failure === 'missing head artifacts' && cwd === f.cwd) return { ...result, output: 'error: Inference cost regression:' };
      if (failure === 'base crash' && cwd !== f.cwd) return { code: 1, output: 'measurement crashed' };
      if ((failure === 'base versions' && cwd !== f.cwd) || (failure === 'head versions' && cwd === f.cwd)) {
        const data = sample(2000);
        data.versions.typescript = 'different';
        writeFileSync(join(cwd, '.temp/api-inference/run-test/measurements.json'), JSON.stringify(data));
      }
      return result;
    };
    const result = await workerInferenceCheck(f.cwd, f.log, process.env, runner, f.print);
    expect(result.code).toBe(1);
    expect(result.output).toContain('Inference cost regression');
    expect(f.lines.join('\n')).not.toContain('Inference task change: ok');
  });
}
