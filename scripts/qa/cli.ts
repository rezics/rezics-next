import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { acquireFullLock, command, implementedTiers, newRunId, parseArgs,
  sourceIdentity, tierArtifactName, uncoveredTiers, writeSummary, xmlForCommand, type Tier } from './core.ts';
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
const startedProjects: string[] = [];
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
  if (options.record) throw new Error('--record cannot certify while model, e2e and load tiers are uncovered');
  for (const tier of selected) {
    if (tier === 'static') runTier(tier, 'corepack', ['yarn', 'check'], 120_000);
    if (tier === 'unit') runTier(tier, 'bun', ['test', ...testArgs('unit', selection, chosen), '--reporter=junit',
      `--reporter-outfile=${join(directory, 'unit.xml')}`], 180_000);
    if (tier === 'integration' || tier === 'fault/recovery') {
      const projectRunId = tier === 'integration' ? runId : `${runId}-f`;
      const artifact = tierArtifactName(tier);
      startedProjects.push(projectRunId);
      const up = command(root, 'corepack', ['yarn', 'stack:up', '--profile', 'qa', '--run-id', projectRunId], 180_000);
      if (!up.ok) { errors.push(`${tier} stack startup failed`); writeFileSync(join(logs, `${artifact}-stack.log`), up.output); tiers.push({ name: tier, status: 'failed' }); writeFileSync(join(directory, `${artifact}.xml`), xmlForCommand(tier, false, up.elapsedMs, up.output)); continue; }
      const stackDir = join(root, '.temp', 'stack', `rezics-qa-${projectRunId}`);
      const apps = readEnv(join(stackDir, 'apps.env'));
      const compose = readEnv(join(stackDir, 'compose.env'));
      const appsPath = join(stackDir, 'qa-apps.json');
      const composePath = join(stackDir, 'qa-compose.json');
      writeFileSync(appsPath, JSON.stringify(apps), { mode: 0o600 });
      writeFileSync(composePath, JSON.stringify(compose), { mode: 0o600 });
      const bootstrap = command(root, 'bun', ['scripts/qa/bootstrap.ts', appsPath, composePath], 180_000);
      if (!bootstrap.ok) { errors.push(`${tier} shared bootstrap failed`); writeFileSync(join(logs, `${artifact}-bootstrap.log`), bootstrap.output); tiers.push({ name: tier, status: 'failed' }); writeFileSync(join(directory, `${artifact}.xml`), xmlForCommand(tier, false, bootstrap.elapsedMs, bootstrap.output)); continue; }
      const budget = tier === 'integration' ? 480_000 : 360_000;
      const result = command(root, 'bun', ['test', ...testArgs(tier, selection, chosen), '--reporter=junit',
        `--reporter-outfile=${join(directory, `${artifact}.xml`)}`], budget,
      { ...process.env, ...apps, REZICS_QA_RUN_ID: projectRunId,
        REZICS_S3_GATE_PROJECT: projectRunId,
        REZICS_QA_ARTIFACT_DIR: directory,
        TOXIPROXY_API_URL: `http://127.0.0.1:${compose.TOXIPROXY_API_PORT}`,
        TOXIPROXY_FUSEKI_URL: `http://127.0.0.1:${compose.TOXIPROXY_FUSEKI_PORT}/rezics/` });
      const ok = result.ok && result.elapsedMs <= budget;
      tiers.push({ name: tier, status: ok ? 'passed' : 'failed', elapsedMs: result.elapsedMs });
      if (!ok) {
        errors.push(`${tier} failed or exceeded ${budget / 1000}s`);
        writeFileSync(join(logs, `${artifact}.log`), result.output);
        const stackLogs = command(root, 'corepack', ['yarn', 'stack:logs', '--profile', 'qa', '--run-id', projectRunId], 20_000);
        writeFileSync(join(logs, `${artifact}-stack.log`), stackLogs.output);
      }
    }
  }
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error));
} finally {
  if (!options.keep) for (const projectRunId of startedProjects) {
    const down = command(root, 'corepack', ['yarn', 'stack:reset', '--profile', 'qa', '--run-id', projectRunId], 120_000);
    if (!down.ok) { errors.push(`QA stack cleanup failed: ${projectRunId}`); writeFileSync(join(logs, `${projectRunId}-cleanup.log`), down.output); }
  }
  try {
    const sourceAfter = sourceIdentity(root);
    if (sourceAfter.fingerprint !== sourceBefore.fingerprint) errors.push('Source changed during QA run');
    for (const tier of uncoveredTiers) tiers.push({ name: tier, status: 'uncovered' });
    const tests = junitResults(directory, selected.filter(tier => tier === 'unit' || tier === 'integration' || tier === 'fault/recovery'));
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
