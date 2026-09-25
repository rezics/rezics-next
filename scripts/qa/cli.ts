import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { acquireFullLock, backendTiers, command, implementedTiers, newRunId, parseArgs,
  sourceIdentity, tierArtifactName, uncoveredTiers, writeSummary, xmlForCommand, type Tier } from './core.ts';
import { caseInventory, e2eArgs, failedSelection, junitResults, testArgs } from './acceptance.ts';
import { selectBackendCases } from './backend-scope.ts';
import { declaredCaseCoverage, missingCaseDeclarations, renderQualification,
  type QualificationRecord } from './coverage.ts';
import { readEnv } from '../dev/config.ts';

const root = resolve(import.meta.dir, '../..');
const options = parseArgs(process.argv.slice(2));
const runId = newRunId();
const directory = join(root, '.artifacts', 'qa', runId);
const logs = join(directory, 'logs');
mkdirSync(logs, { recursive: true });
const sourceBefore = sourceIdentity(root);
const tiers: { name: Tier; status: 'passed' | 'failed' | 'uncovered'; elapsedMs?: number }[] = [];
const errors: string[] = [];
const startedProjects: string[] = [];
const inventory = caseInventory(root);
const backendSelection = options.backend ? selectBackendCases(inventory) : undefined;
const cases = backendSelection?.cases ?? inventory;
const caseCoverage = declaredCaseCoverage(cases, options.backend ? 'backend' : 'all');
const selection = options.onlyFailed ? failedSelection(join(root, '.artifacts', 'qa'), options.onlyFailed) : undefined;
const selected = selection?.tiers ?? (options.tier ? [options.tier] : options.backend ? backendTiers : implementedTiers);
const chosen = options.files || options.id ? options : undefined;
const release = options.tier || options.onlyFailed ? () => {} : acquireFullLock(root, runId);

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
  if (options.record) {
    const missing = missingCaseDeclarations(cases, caseCoverage);
    if (missing.length) throw new Error(`--record requires complete case declarations; ${missing.length} IDs remain`);
  }
  for (const tier of selected) {
    if (tier === 'static') runTier(tier, 'corepack', ['yarn', options.backend ? 'check:backend' : 'check'], 120_000);
    if (tier === 'unit') runTier(tier, 'bun', ['test', ...testArgs('unit', selection, chosen), '--reporter=junit',
      `--reporter-outfile=${join(directory, 'unit.xml')}`], 180_000);
    if (tier === 'model') {
      const projectRunId = `${runId}-m`;
      startedProjects.push(projectRunId);
      const up = command(root, 'corepack', ['yarn', 'stack:up', '--profile', 'qa', '--run-id', projectRunId], 180_000);
      if (!up.ok) {
        errors.push('model stack startup failed');
        writeFileSync(join(logs, 'model-stack.log'), up.output);
        tiers.push({ name: tier, status: 'failed' });
        writeFileSync(join(directory, 'model.xml'), xmlForCommand(tier, false, up.elapsedMs, up.output));
        continue;
      }
      const stackDir = join(root, '.temp', 'stack', `rezics-qa-${projectRunId}`);
      const compose = readEnv(join(stackDir, 'compose.env'));
      const result = command(root, 'bun', ['test', ...testArgs('model', selection, chosen), '--reporter=junit',
        `--reporter-outfile=${join(directory, 'model.xml')}`], 180_000,
      { ...process.env, FUSEKI_URL: `http://127.0.0.1:${compose.FUSEKI_PORT}/rezics/`,
        FUSEKI_MAINTENANCE_TOKEN: compose.FUSEKI_MAINTENANCE_TOKEN,
        FUSEKI_COMMAND_TOKEN: compose.FUSEKI_COMMAND_TOKEN,
        MODEL_NATIVE_EQUIVALENCE: '1', MODEL_NATIVE_EQUIVALENCE_STRICT: '1',
        REZICS_QA_ARTIFACT_DIR: directory });
      const ok = result.ok && result.elapsedMs <= 180_000;
      tiers.push({ name: tier, status: ok ? 'passed' : 'failed', elapsedMs: result.elapsedMs });
      if (!ok) {
        errors.push('model failed or exceeded 180s');
        writeFileSync(join(logs, 'model.log'), result.output);
        const stackLogs = command(root, 'corepack', ['yarn', 'stack:logs', '--profile', 'qa', '--run-id', projectRunId], 20_000);
        writeFileSync(join(logs, 'model-stack.log'), stackLogs.output);
      }
    }
    if (tier === 'e2e') {
      const projectRunId = `${runId}-e`;
      startedProjects.push(projectRunId);
      const up = command(root, 'corepack', ['yarn', 'stack:up', '--profile', 'qa', '--run-id', projectRunId], 180_000);
      if (!up.ok) {
        errors.push('e2e stack startup failed');
        writeFileSync(join(logs, 'e2e-stack.log'), up.output);
        tiers.push({ name: tier, status: 'failed' });
        writeFileSync(join(directory, 'e2e.xml'), xmlForCommand(tier, false, up.elapsedMs, up.output));
        continue;
      }
      const stackDir = join(root, '.temp', 'stack', `rezics-qa-${projectRunId}`);
      const apps = readEnv(join(stackDir, 'apps.env'));
      const compose = readEnv(join(stackDir, 'compose.env'));
      const appsPath = join(stackDir, 'qa-apps.json');
      const composePath = join(stackDir, 'qa-compose.json');
      writeFileSync(appsPath, JSON.stringify(apps), { mode: 0o600 });
      writeFileSync(composePath, JSON.stringify(compose), { mode: 0o600 });
      const bootstrap = command(root, 'bun', ['scripts/qa/bootstrap.ts', appsPath, composePath], 180_000);
      if (!bootstrap.ok) {
        errors.push('e2e stack bootstrap failed');
        writeFileSync(join(logs, 'e2e-bootstrap.log'), bootstrap.output);
        tiers.push({ name: tier, status: 'failed' });
        writeFileSync(join(directory, 'e2e.xml'), xmlForCommand(tier, false, bootstrap.elapsedMs, bootstrap.output));
        continue;
      }
      const webAuth = command(root, 'bun', ['scripts/dev/web-auth-bootstrap.ts',
        '--run-id', projectRunId, '--redirect-uri', 'http://127.0.0.1:3003/auth/callback'], 180_000);
      if (!webAuth.ok) {
        errors.push('e2e web authorization bootstrap failed');
        writeFileSync(join(logs, 'e2e-web-auth-bootstrap.log'), webAuth.output);
        tiers.push({ name: tier, status: 'failed' });
        writeFileSync(join(directory, 'e2e.xml'), xmlForCommand(tier, false, webAuth.elapsedMs, webAuth.output));
        continue;
      }
      const args = e2eArgs(selection, chosen);
      const result = command(root, 'bun', ['scripts/qa/e2e.ts', appsPath, directory, projectRunId, ...args], 540_000);
      const browserTests = junitResults(directory, ['e2e']);
      const ok = result.ok && browserTests.length > 0 && browserTests.every(test => !test.failed);
      tiers.push({ name: tier, status: ok ? 'passed' : 'failed', elapsedMs: result.elapsedMs });
      if (!ok) {
        errors.push('e2e failed or exceeded its setup/browser budget');
        writeFileSync(join(logs, 'e2e.log'), result.output);
        if (!existsSync(join(directory, 'e2e.xml'))) {
          writeFileSync(join(directory, 'e2e.xml'), xmlForCommand(tier, false, result.elapsedMs, result.output));
        }
        const stackLogs = command(root, 'corepack', ['yarn', 'stack:logs', '--profile', 'qa', '--run-id', projectRunId], 20_000);
        writeFileSync(join(logs, 'e2e-stack.log'), stackLogs.output);
      }
    }
    if (tier === 'integration' || tier === 'fault/recovery' || tier === 'load') {
      const projectRunId = tier === 'integration' ? runId : `${runId}-${tier === 'load' ? 'l' : 'f'}`;
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
      const budget = tier === 'integration' ? 480_000 : tier === 'load' ? 180_000 : 360_000;
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
    const tests = junitResults(directory, selected.filter(tier => tier === 'unit' || tier === 'integration'
      || tier === 'model' || tier === 'fault/recovery' || tier === 'e2e' || tier === 'load'));
    if (selection) {
      for (const expected of selection.tests) {
        if (!tests.some(actual => actual.tier === expected.tier && actual.file === expected.file
          && actual.name === expected.name)) errors.push(`Selected test was not executed: ${expected.file}: ${expected.name}`);
      }
    }
    writeSummary(directory, { runId, sourceBefore, sourceAfter, tiers,
      partial: Boolean(options.tier || selection || options.files || options.id), errors, cases, tests,
      diagnosticOf: selection?.sourceRunId, retiredTests: selection?.retiredTests, caseCoverage,
      scope: options.backend ? 'backend' : 'all', excludedCases: backendSelection?.excluded,
      inventoryFingerprint: backendSelection?.inventoryFingerprint });
    if (options.record && errors.length === 0) {
      const record = JSON.parse(readFileSync(join(directory, 'acceptance.json'), 'utf8')) as QualificationRecord;
      if (record.certifiesFull) {
        writeFileSync(join(root, 'docs/plan/qualification.md'), renderQualification(record));
      } else {
        console.error('--record did not certify every retained acceptance ID; qualification page unchanged');
        process.exitCode = 1;
      }
    }
  } finally { release(); }
  console.log(readFileSync(join(directory, 'summary.md'), 'utf8'));
  console.log(`QA artifacts: ${directory}`);
  if (errors.length) process.exitCode = 1;
}
