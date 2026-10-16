import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform } from 'node:os';
import { join, resolve } from 'node:path';

export const inferenceProjects = {
  main: 'services/main/tsconfig.json',
  web: 'apps/web/tsconfig.json',
  eden: 'tests/qa/client/tsconfig.json',
} as const;
export type InferenceProject = keyof typeof inferenceProjects;
const projects = Object.keys(inferenceProjects) as InferenceProject[];
// Unchanged Eden counters accompanied 9.363s and 24.618s checks on the shared
// host. Allow 3x check time; deterministic graph metrics retain 5% margins and
// the existing Eden process still has its independent 30-second wall deadline.
export const inferenceMargins = { instantiations: 0.05, checkSeconds: 2, appBytes: 0.05, routesBytes: 0.05 } as const;
export type InferenceMetrics = Record<keyof typeof inferenceMargins, number>;
export type Measurements = Record<InferenceProject, InferenceMetrics>;
export interface Baseline {
  format: 1;
  versions: Record<string, string>;
  measurements: Measurements;
}
const baselinePath = 'scripts/api/inference-cost-baseline.json';
export const inferenceCompilerFlags = ['--extendedDiagnostics', '--pretty', 'false', '--incremental', 'false', '--noEmit'];
// The native web compiler peaked near 8 GiB in the audit. Serialize large host
// admissions and leave room for its process overhead; this is the gate's owner.
export const inferenceGateCommand = ['bun', 'scripts/qa/host-admission.ts', '--cpu', '--gib', '9.5', '--', 'bun', 'scripts/api/inference-cost.ts'];

/** Include shared contract/schema inputs and dependency/config changes, including
 * deletions. A web consumer can inflate its graph without changing MainApp. */
export function needsInferenceGate(changed: readonly string[]): boolean {
  return changed.some(file => /^(?:services\/main\/|apps\/web\/|packages\/|model\/|generated\/|scripts\/api\/|tests\/qa\/client\/)/.test(file)
    || /^(?:package\.json|yarn\.lock|tsconfig[^/]*\.json|Taskfile\.yml|scripts\/goal\/check\.ts)$/.test(file));
}

export function parseInferenceDiagnostics(output: string): Pick<InferenceMetrics, 'instantiations' | 'checkSeconds'> {
  const instantiations = /^Instantiations:\s+(\d+)\s*$/m.exec(output);
  const check = /^Check time:\s+([\d.]+)s\s*$/m.exec(output);
  if (!instantiations || !check) throw new Error('Missing inference extended diagnostics');
  const result = { instantiations: Number(instantiations[1]), checkSeconds: Number(check[1]) };
  if (Object.values(result).some(value => !Number.isFinite(value) || value <= 0))
    throw new Error('Invalid inference extended diagnostics');
  return result;
}

export function parseInferenceBaseline(input: unknown): Baseline {
  const baseline = input as Baseline | undefined;
  if (baseline?.format !== 1 || !baseline.versions || !Object.keys(baseline.versions).length
    || Object.values(baseline.versions).some(value => typeof value !== 'string'))
    throw new Error('Invalid inference baseline metadata');
  for (const project of projects) for (const metric of Object.keys(inferenceMargins) as (keyof InferenceMetrics)[]) {
    const value = baseline.measurements?.[project]?.[metric];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
      throw new Error(`Invalid inference baseline ${project}.${metric}`);
  }
  return baseline;
}

export function inferenceRegressions(baseline: Baseline, current: Measurements, versions = baseline.versions): string[] {
  const failures: string[] = [];
  for (const [name, version] of Object.entries(baseline.versions))
    if (versions[name] !== version) failures.push(`inference compiler environment changed: ${name} ${version} -> ${versions[name] ?? 'missing'}; review and record a new baseline`);
  for (const project of projects) for (const metric of Object.keys(inferenceMargins) as (keyof InferenceMetrics)[]) {
    const before = baseline.measurements[project][metric];
    const value = current[project]?.[metric];
    const limit = before * (1 + inferenceMargins[metric]);
    if (!Number.isFinite(value) || value <= 0 || value > limit)
      failures.push(`${project}.${metric}: ${value} exceeds ${limit} (baseline ${before}, +${inferenceMargins[metric] * 100}%)`);
  }
  return failures;
}

function versions(root: string): Record<string, string> {
  return Object.fromEntries([['bun', Bun.version], ...['typescript', 'typescript-6', 'elysia', '@elysia/eden', 'typebox'].map(name =>
    [name, (JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')) as { version: string }).version])]);
}

async function command(root: string, args: string[], log: string): Promise<void> {
  const child = Bun.spawn(args, { cwd: root, stdout: Bun.file(log), stderr: 'pipe' });
  const error = await new Response(child.stderr).text();
  const code = await child.exited;
  if (code !== 0) throw new Error(`Inference measurement failed: ${args.join(' ')}\n${error}\n${readFileSync(log, 'utf8')}`);
}

async function measure(root: string, output: string): Promise<Measurements> {
  const result = {} as Measurements;
  // Fresh processes and disabled incremental state make counters independent of
  // previous checks. Type display uses a separate process to release each graph.
  for (const project of projects) {
    const log = join(output, `${project}-tsc.log`);
    await command(root, project === 'eden' ? ['bun', 'scripts/api/eden-gate.ts', '--diagnostics']
      : ['bun', 'node_modules/typescript/bin/tsc', '-p', inferenceProjects[project], ...inferenceCompilerFlags], log);
    const sizeFile = join(output, `${project}-size.json`);
    await command(root, ['bun', 'scripts/api/inference-cost.ts', '--type-size', project, sizeFile], join(output, `${project}-size.log`));
    const size = JSON.parse(readFileSync(sizeFile, 'utf8')) as { appBytes: number; routesBytes: number };
    result[project] = { ...parseInferenceDiagnostics(readFileSync(log, 'utf8')), appBytes: size.appBytes, routesBytes: size.routesBytes };
    console.log(`${project}: ${JSON.stringify(result[project])}`);
  }
  return result;
}

async function main(args: string[]) {
  const root = resolve(import.meta.dir, '../..');
  if (args[0] === '--type-size' && args.length === 3 && projects.includes(args[1] as InferenceProject)) {
    const { inferenceTypeSize } = await import('./inference-type-size.ts');
    const { appBytes, routesBytes } = await inferenceTypeSize(root, inferenceProjects[args[1] as InferenceProject]);
    writeFileSync(args[2]!, JSON.stringify({ appBytes, routesBytes }));
    return;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--record'))
    throw new Error('Usage: task goal -- job -- bun scripts/qa/host-admission.ts --cpu --gib 9.5 -- bun scripts/api/inference-cost.ts [--record]');
  const record = args[0] === '--record';
  const currentVersions = versions(root);
  const baseline = record ? undefined : parseInferenceBaseline(JSON.parse(readFileSync(join(root, baselinePath), 'utf8')));
  const directory = join(root, '.temp/api-inference');
  mkdirSync(directory, { recursive: true });
  const output = mkdtempSync(join(directory, 'run-'));
  console.log(`Inference artifacts: ${output}`);
  const samples: Measurements[] = [];
  for (let sample = 0; sample < (record ? 3 : 1); sample++) {
    const directory = join(output, `sample-${sample + 1}`);
    mkdirSync(directory);
    samples.push(await measure(root, directory));
  }
  const measurements = Object.fromEntries(projects.map(project => [project, Object.fromEntries(
    (Object.keys(inferenceMargins) as (keyof InferenceMetrics)[]).map(metric => [metric,
      samples.map(sample => sample[project][metric]).sort((a, b) => a - b)[Math.floor(samples.length / 2)]!]))])) as Measurements;
  writeFileSync(join(output, 'measurements.json'), JSON.stringify({ versions: currentVersions, measurements, samples }, null, 2) + '\n');
  if (record) {
    const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (revision.status !== 0) throw new Error('Cannot record inference source revision');
    writeFileSync(join(root, baselinePath), JSON.stringify({ format: 1, sourceRevision: revision.stdout.trim(),
      recordedAt: new Date().toISOString(), versions: currentVersions,
      host: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
      method: 'Median of three sequential fresh tsc --extendedDiagnostics --incremental false --noEmit runs per project; compiler-rendered MainApp and ~Routes UTF-8 bytes with NoTruncation | InTypeAlias in each project. Display size is not declaration or heap size.',
      margins: inferenceMargins, measurements, samples }, null, 2) + '\n');
    console.log(`Recorded ${baselinePath}; review changes before committing.`);
  } else {
    const failures = inferenceRegressions(baseline!, measurements, currentVersions);
    if (failures.length) throw new Error(`Inference cost regression:\n${failures.join('\n')}`);
    console.log('Inference cost: ok (counts/display +5%, check time +200%; Eden wall limit 30s)');
  }
}

if (import.meta.main) await main(Bun.argv.slice(2));
