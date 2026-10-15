import { expect, test } from 'bun:test';
import { inferenceCompilerFlags, inferenceMargins, inferenceProjects, inferenceRegressions,
  needsInferenceGate, parseInferenceBaseline, parseInferenceDiagnostics } from './inference-cost.ts';

const metrics = { instantiations: 1_000, checkSeconds: 10, appBytes: 2_000, routesBytes: 3_000 };
function baseline() {
  return { format: 1 as const, versions: { typescript: '7.0.2' },
    measurements: { main: { ...metrics }, web: { ...metrics }, eden: { ...metrics } } };
}

test('parses native extended diagnostics and refuses missing, zero or malformed counters', () => {
  expect(parseInferenceDiagnostics('Types: 300\nInstantiations: 12154275\nCheck time: 14.647s\nTotal time: 16.067s\n'))
    .toEqual({ instantiations: 12_154_275, checkSeconds: 14.647 });
  for (const output of ['', 'Instantiations: 1\n', 'Check time: 1s\n', 'Instantiations: 0\nCheck time: 1s',
    'Instantiations: 1\nCheck time: ..s', 'Instantiations: 1\nCheck time: 0s'])
    expect(() => parseInferenceDiagnostics(output)).toThrow();
});

test('the baseline and exact growth limits pass, with no lower bound on improvements', () => {
  const before = baseline();
  expect(parseInferenceBaseline(before)).toEqual(before);
  expect(inferenceRegressions(before, before.measurements)).toEqual([]);
  const atLimit = structuredClone(before.measurements);
  for (const project of Object.keys(inferenceProjects) as (keyof typeof inferenceProjects)[])
    for (const metric of Object.keys(inferenceMargins) as (keyof typeof metrics)[])
      atLimit[project][metric] *= 1 + inferenceMargins[metric];
  expect(inferenceRegressions(before, atLimit)).toEqual([]);
  for (const project of Object.values(atLimit)) for (const metric of Object.keys(metrics) as (keyof typeof metrics)[]) project[metric] = 1;
  expect(inferenceRegressions(before, atLimit)).toEqual([]);
});

for (const project of Object.keys(inferenceProjects) as (keyof typeof inferenceProjects)[])
  for (const metric of Object.keys(inferenceMargins) as (keyof typeof metrics)[]) {
    test(`planted ${project}.${metric} inflation fails with its baseline and margin`, () => {
      const before = baseline();
      const current = structuredClone(before.measurements);
      current[project][metric] *= 1 + inferenceMargins[metric];
      current[project][metric] += 1;
      const failures = inferenceRegressions(before, current);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain(`${project}.${metric}:`);
      expect(failures[0]).toContain(`baseline ${metrics[metric]}, +${inferenceMargins[metric] * 100}%`);
    });
  }

test('missing, nonfinite and zero metrics fail closed, as do changed compiler versions', () => {
  for (const value of [undefined, NaN, Infinity, 0, -1]) {
    const invalid = baseline();
    invalid.measurements.eden.appBytes = value as number;
    expect(() => parseInferenceBaseline(invalid)).toThrow('eden.appBytes');
    expect(inferenceRegressions(baseline(), invalid.measurements)).toHaveLength(1);
  }
  expect(() => parseInferenceBaseline({})).toThrow('metadata');
  expect(inferenceRegressions(baseline(), baseline().measurements, { typescript: 'new' })[0]).toContain('compiler environment changed');
  expect(inferenceRegressions(baseline(), baseline().measurements, {})[0]).toContain('missing');
});

test('observed shared-host timing variation fits the margin while sustained time growth fails', () => {
  const before = baseline();
  before.measurements.eden.checkSeconds = 9.363;
  const current = structuredClone(before.measurements);
  current.eden.checkSeconds = 24.618;
  expect(inferenceRegressions(before, current)).toEqual([]);
  current.eden.checkSeconds = 28.1;
  expect(inferenceRegressions(before, current)[0]).toContain('eden.checkSeconds:');
});

test('API, Eden, shared schemas, web consumers, configuration and gate edits select inference measurement', () => {
  for (const file of ['services/main/src/app.ts', 'services/main/src/routes/deleted.ts', 'services/main/tsconfig.json',
    'scripts/api/inference-cost.ts', 'scripts/api/inference-cost-baseline.json', 'tests/qa/client/main-contract.ts',
    'tests/qa/client/tsconfig.json', 'packages/model/src/shape.ts', 'model/definitions/work.ts',
    'generated/openapi/main/index.ts', 'apps/web/features/api/client.ts', 'apps/web/features/search/read.ts',
    'package.json', 'yarn.lock', 'tsconfig.json', 'Taskfile.yml', 'scripts/goal/check.ts'])
    expect(needsInferenceGate([file])).toBe(true);
  for (const file of ['docs/example.md', 'scripts/goal/briefs.ts', 'apps/accounts/app/page.tsx'])
    expect(needsInferenceGate([file])).toBe(false);
  expect(needsInferenceGate([])).toBe(false);
  expect(inferenceCompilerFlags).toContain('--incremental');
  expect(inferenceCompilerFlags).toContain('false');
  expect(inferenceCompilerFlags).toContain('--noEmit');
});
