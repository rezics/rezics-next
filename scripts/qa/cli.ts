import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { acquireFullLock, command, implementedTiers, newRunId, parseArgs,
  sourceIdentity, uncoveredTiers, writeSummary, xmlForCommand, type Tier } from './core.ts';
import { caseInventory, failedSelection, junitResults, testArgs } from './acceptance.ts';
import { readEnv } from '../dev/config.ts';

const root = resolve(import.meta.dir, '../..');
const options = parseArgs(process.argv.slice(2));
const runId = newRunId();
const directory = join(root, '.artifacts', 'qa', runId);
const logs = join(directory, 'logs');
mkdirSync(logs, { recursive: true });
const sourceBefore = sourceIdentity(root);
const release = options.tier || options.onlyFailed ? () => {} : acquireFullLock(root, runId);
const tiers: { name: Tier; status: 'passed' | 'failed' | 'uncovered'; elapsedMs?: number }[] = [];
const errors: string[] = [];
let stackStarted = false;
const cases = caseInventory(root);
const selection = options.onlyFailed ? failedSelection(join(root, '.artifacts', 'qa'), options.onlyFailed) : undefined;
const selected = selection?.tiers ?? (options.tier ? [options.tier] : implementedTiers);
const chosen = options.files || options.id ? options : undefined;

function runTier(name: Tier, program: string, args: string[], budget: number,
  env: NodeJS.ProcessEnv = process.env): boolean {
  const result = command(root, program, args, budget, env);
  const ok = result.ok && result.elapsedMs <= budget;
  tiers.push({ name, status: ok ? 'passed' : 'failed', elapsedMs: result.elapsedMs });
  if (name === 'static') writeFileSync(join(directory, `${name}.xml`),
    xmlForCommand(name, ok, result.elapsedMs, result.output));
  if (!ok) {
    writeFileSync(join(logs, `${name}.log`), result.output);
    errors.push(`${name} failed or exceeded ${budget / 1000}s (see logs/${name}.log)`);
  }
  return ok;
}

try {
  if (options.record && !sourceBefore.clean) throw new Error('--record requires a clean source tree');
  if (options.record) throw new Error('--record cannot certify while model, fault/recovery, e2e and load tiers are uncovered');
  for (const tier of selected) {
    if (tier === 'static') runTier(tier, 'corepack', ['yarn', 'check'], 120_000);
    if (tier === 'unit') runTier(tier, 'bun', ['test', ...testArgs('unit', selection, chosen), '--reporter=junit',
      `--reporter-outfile=${join(directory, 'unit.xml')}`], 180_000);
    if (tier === 'integration') {
      stackStarted = true;
      const up = command(root, 'corepack', ['yarn', 'stack:up', '--profile', 'qa', '--run-id', runId], 180_000);
      if (!up.ok) { errors.push('QA stack startup failed'); writeFileSync(join(logs, 'stack.log'), up.output); tiers.push({ name: tier, status: 'failed' }); writeFileSync(join(directory, 'integration.xml'), xmlForCommand(tier, false, up.elapsedMs, up.output)); continue; }
      const stackDir = join(root, '.temp', 'stack', `rezics-qa-${runId}`);
      const apps = readEnv(join(stackDir, 'apps.env'));
      const compose = readEnv(join(stackDir, 'compose.env'));
      const appsPath = join(stackDir, 'qa-apps.json');
      const composePath = join(stackDir, 'qa-compose.json');
      writeFileSync(appsPath, JSON.stringify(apps), { mode: 0o600 });
      writeFileSync(composePath, JSON.stringify(compose), { mode: 0o600 });
      const bootstrap = command(root, 'bun', ['scripts/qa/bootstrap.ts', appsPath, composePath], 180_000);
      if (!bootstrap.ok) { errors.push('QA shared bootstrap failed'); writeFileSync(join(logs, 'bootstrap.log'), bootstrap.output); tiers.push({ name: tier, status: 'failed' }); writeFileSync(join(directory, 'integration.xml'), xmlForCommand(tier, false, bootstrap.elapsedMs, bootstrap.output)); continue; }
      const result = command(root, 'bun', ['test', ...testArgs('integration', selection, chosen), '--reporter=junit',
        `--reporter-outfile=${join(directory, 'integration.xml')}`], 480_000,
      { ...process.env, ...apps, REZICS_QA_RUN_ID: runId, REZICS_S3_GATE_PROJECT: runId });
      const ok = result.ok && result.elapsedMs <= 480_000;
      tiers.push({ name: tier, status: ok ? 'passed' : 'failed', elapsedMs: result.elapsedMs });
      if (!ok) { errors.push('integration failed or exceeded 480s'); writeFileSync(join(logs, 'integration.log'), result.output); }
    }
  }
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error));
} finally {
  if (stackStarted && !options.keep) {
    const down = command(root, 'corepack', ['yarn', 'stack:reset', '--profile', 'qa', '--run-id', runId], 120_000);
    if (!down.ok) { errors.push('QA stack cleanup failed'); writeFileSync(join(logs, 'cleanup.log'), down.output); }
  }
  try {
    const sourceAfter = sourceIdentity(root);
    if (sourceAfter.fingerprint !== sourceBefore.fingerprint) errors.push('Source changed during QA run');
    for (const tier of uncoveredTiers) tiers.push({ name: tier, status: 'uncovered' });
    const tests = junitResults(directory, selected.filter(tier => tier === 'unit' || tier === 'integration'));
    if (selection) {
      for (const expected of selection.tests) {
        if (!tests.some(actual => actual.tier === expected.tier && actual.file === expected.file
          && actual.name === expected.name)) errors.push(`Selected test was not executed: ${expected.file}: ${expected.name}`);
      }
    }
    writeSummary(directory, { runId, sourceBefore, sourceAfter, tiers,
      partial: Boolean(options.tier || selection || options.files || options.id), errors, cases, tests,
      diagnosticOf: selection?.sourceRunId });
  } finally { release(); }
  console.log(readFileSync(join(directory, 'summary.md'), 'utf8'));
  console.log(`QA artifacts: ${directory}`);
  if (errors.length) process.exitCode = 1;
}
