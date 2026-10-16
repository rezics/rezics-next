import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { inferenceGateCommand, inferenceMargins, inferenceProjects, inferenceRegressions,
  parseInferenceBaseline, type Baseline } from '../api/inference-cost.ts';
import { type CheckCommandResult, type CheckRunner } from './check.ts';
import { checkBaseRevision } from './tree-currency.ts';

function measurement(cwd: string, result: CheckCommandResult): Baseline {
  const artifact = /^Inference artifacts: (.+)$/m.exec(result.output)?.[1];
  const parent = resolve(cwd, '.temp/api-inference') + sep;
  if (!artifact || !resolve(artifact).startsWith(parent)) throw new Error('Missing inference measurement artifacts');
  return parseInferenceBaseline({ ...JSON.parse(readFileSync(join(artifact, 'measurements.json'), 'utf8')), format: 1 });
}

/** Relax only budgets the base itself exceeds; a newly failing budget retains its recorded limit. */
export function inheritedInferenceRegressions(recorded: Baseline, head: Baseline, base: Baseline): string[] {
  const reference = structuredClone(recorded);
  for (const project of Object.keys(inferenceProjects) as (keyof typeof inferenceProjects)[]) {
    for (const metric of Object.keys(inferenceMargins) as (keyof typeof inferenceMargins)[]) {
      if (base.measurements[project][metric] > recorded.measurements[project][metric] * (1 + inferenceMargins[metric]))
        reference.measurements[project][metric] = base.measurements[project][metric];
    }
  }
  return inferenceRegressions(reference, head.measurements, head.versions);
}

/** The passing path is exactly one gate invocation. Failed budget measurements alone qualify for comparison. */
export async function workerInferenceCheck(cwd: string, log: string, env: NodeJS.ProcessEnv,
  run: CheckRunner, print: (line: string) => void, pinnedBase?: string): Promise<CheckCommandResult> {
  const headResult = await run(inferenceGateCommand, cwd, log, env);
  if (!headResult.code || !headResult.output.includes('Inference cost regression:')) return headResult;
  let snapshot: string | undefined;
  let output = headResult.output;
  try {
    const recorded = parseInferenceBaseline(JSON.parse(readFileSync(join(cwd, 'scripts/api/inference-cost-baseline.json'), 'utf8')));
    const head = measurement(cwd, headResult);
    // Version changes require an explicit new recorded baseline, including when inherited.
    if (inferenceRegressions(recorded, recorded.measurements, head.versions).length) return headResult;
    const revision = pinnedBase ?? checkBaseRevision(cwd);
    const parent = join(dirname(log), 'inference-base');
    mkdirSync(parent, { recursive: true });
    snapshot = mkdtempSync(join(parent, 'tree-'));
    // A local clone keeps all writes in this check's directory, including git metadata and workspace links.
    for (const args of [['clone', '--quiet', '--shared', '--no-checkout', '--', cwd, snapshot],
      ['-C', snapshot, 'checkout', '--quiet', '--detach', revision]]) {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000 });
      if (result.status !== 0) throw new Error(`Cannot prepare inference base: ${result.error?.message ?? result.stderr}`);
    }
    const install = await run(['task', 'install'], snapshot, `${log}.base-install.log`, env);
    output += `\n=== Base ${revision} dependency install ===\n${install.output}`;
    if (install.code) throw new Error('Inference base dependency install failed');
    const baseResult = await run(inferenceGateCommand, snapshot, `${log}.base.log`, env);
    output += `\n=== Base ${revision} inference ===\n${baseResult.output}`;
    const base = measurement(snapshot, baseResult);
    if (baseResult.code && !baseResult.output.includes('Inference cost regression:'))
      throw new Error('Inference base failed without a budget verdict');
    if (inferenceRegressions(head, head.measurements, base.versions).length
      || inferenceRegressions(base, base.measurements, head.versions).length)
      throw new Error('Inference base compiler environment differs from head');
    const note = (line: string) => { print(line); output += `\n${line}`; };
    for (const [side, data] of [['head', head], [`base ${revision}`, base]] as const)
      for (const project of Object.keys(inferenceProjects) as (keyof typeof inferenceProjects)[])
        note(`Inference ${side} ${project}: ${JSON.stringify(data.measurements[project])}`);
    const baseFailures = inferenceRegressions(recorded, base.measurements, base.versions);
    if (!baseFailures.length) {
      note('Inference base passes the recorded baseline; head regression is blocking.');
      return { code: headResult.code, output };
    }
    note(`Inference failures inherited from base ${revision}:\n${baseFailures.join('\n')}`);
    const failures = inheritedInferenceRegressions(recorded, head, base);
    if (failures.length) note(`Inference cost regression after base comparison:\n${failures.join('\n')}`);
    else note('Inference task change: ok within margins over the base; merge still requires the recorded baseline.');
    return { code: failures.length ? 1 : 0, output };
  } catch (error) {
    return { code: headResult.code, output: `${output}\nerror: Inference base comparison inconclusive: ${String(error)}` };
  } finally {
    if (snapshot) rmSync(snapshot, { recursive: true, force: true });
  }
}
