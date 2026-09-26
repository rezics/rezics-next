import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { acquireFullLock, acquireQaSlots, artifactRoots, backendTiers, command, commandAsync, estimatedDurations,
  expandTestPaths, goalSlotDirectory, implementedTiers, junitSuites, matchedNoTests, maximumShards, mergeJUnit,
  newRunId, parseArgs, planShards, recordedFileDurations, shardCount, sourceIdentity, splitTestArgs,
  tierArtifactName, uncoveredTiers, writeSummary, xmlForCommand, type IsolationRecord, type ShardRecord,
  type Tier } from './core.ts';
import { caseInventory, e2eArgs, failedSelection, junitResults, parseJUnit, testArgs } from './acceptance.ts';
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
const tiers: { name: Tier; status: 'passed' | 'failed' | 'uncovered'; elapsedMs?: number; shards?: ShardRecord[] }[] = [];
const isolation: IsolationRecord[] = [];
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

type StackTier = 'integration' | 'fault/recovery';
interface ShardRun { record: ShardRecord; xml?: string; timedOut: boolean; noMatch: boolean;
  ok: boolean; testStart?: number; testEnd?: number }

// One disposable QA project: start, bootstrap, run the files, then reset it
// unless --keep, so finished shards release their capacity early.
async function runShard(tier: StackTier, projectRunId: string, files: string[], flags: string[],
  budget: number, isolated = false): Promise<ShardRun> {
  const label = `${tierArtifactName(tier)}-${projectRunId.slice(runId.length + 1)}`;
  const record: ShardRecord = { project: projectRunId, files, status: 'failed', stage: 'stack',
    ...(isolated ? { isolation: true } : {}) };
  const finish = async (run: Omit<ShardRun, 'record'>): Promise<ShardRun> => {
    if (!run.ok) {
      const stackLogs = await commandAsync(root, 'corepack', ['yarn', 'stack:logs', '--profile', 'qa', '--run-id', projectRunId], 20_000);
      writeFileSync(join(logs, `${label}-stack.log`), stackLogs.output);
    }
    if (!options.keep) {
      const down = await commandAsync(root, 'corepack', ['yarn', 'stack:reset', '--profile', 'qa', '--run-id', projectRunId], 120_000);
      if (down.ok) startedProjects.splice(startedProjects.indexOf(projectRunId), 1);
    }
    record.status = run.ok ? 'passed' : 'failed';
    return { record, ...run };
  };
  startedProjects.push(projectRunId);
  const up = await commandAsync(root, 'corepack', ['yarn', 'stack:up', '--profile', 'qa', '--run-id', projectRunId], 180_000);
  if (!up.ok) {
    errors.push(`${tier} stack startup failed: ${projectRunId}`);
    return finish({ ok: false, timedOut: up.timedOut, noMatch: false,
      xml: xmlForCommand(tier, false, up.elapsedMs, up.output) });
  }
  const stackDir = join(root, '.temp', 'stack', `rezics-qa-${projectRunId}`);
  const apps = readEnv(join(stackDir, 'apps.env'));
  const compose = readEnv(join(stackDir, 'compose.env'));
  const appsPath = join(stackDir, 'qa-apps.json');
  const composePath = join(stackDir, 'qa-compose.json');
  writeFileSync(appsPath, JSON.stringify(apps), { mode: 0o600 });
  writeFileSync(composePath, JSON.stringify(compose), { mode: 0o600 });
  record.stage = 'bootstrap';
  const bootstrap = await commandAsync(root, 'bun', ['scripts/qa/bootstrap.ts', appsPath, composePath], 180_000);
  if (!bootstrap.ok) {
    errors.push(`${tier} shared bootstrap failed: ${projectRunId} (see logs/${label}-bootstrap.log)`);
    writeFileSync(join(logs, `${label}-bootstrap.log`), bootstrap.output);
    return finish({ ok: false, timedOut: bootstrap.timedOut, noMatch: false,
      xml: xmlForCommand(tier, false, bootstrap.elapsedMs, bootstrap.output) });
  }
  record.stage = 'test';
  const outfile = join(directory, 'shards', `${label}.xml`);
  const testStart = Date.now();
  const result = await commandAsync(root, 'bun', ['test', ...files, ...flags, '--reporter=junit',
    `--reporter-outfile=${outfile}`], budget,
  { ...process.env, ...apps, REZICS_QA_RUN_ID: projectRunId,
    REZICS_S3_GATE_PROJECT: projectRunId,
    REZICS_QA_ARTIFACT_DIR: directory,
    TOXIPROXY_API_URL: `http://127.0.0.1:${compose.TOXIPROXY_API_PORT}`,
    TOXIPROXY_FUSEKI_URL: `http://127.0.0.1:${compose.TOXIPROXY_FUSEKI_PORT}/rezics/` });
  const testEnd = Date.now();
  record.elapsedMs = result.elapsedMs;
  const noMatch = !result.ok && !result.timedOut && matchedNoTests(result.output);
  const ok = (result.ok || noMatch) && result.elapsedMs <= budget;
  if (!ok) writeFileSync(join(logs, `${label}.log`), result.output);
  return finish({ ok, timedOut: result.timedOut, noMatch, testStart, testEnd,
    xml: existsSync(outfile) ? readFileSync(outfile, 'utf8')
      : xmlForCommand(tier, false, result.elapsedMs, result.output) });
}

function failedTests(run: ShardRun, tier: StackTier): Map<string, string[]> {
  const failed = new Map<string, string[]>();
  for (const test of parseJUnit(run.xml ?? '', tier).filter(test => test.failed)) {
    failed.set(test.file, [...failed.get(test.file) ?? [], test.name]);
  }
  return failed;
}

function testWall(runs: ShardRun[]): number {
  const timed = runs.filter(run => run.testStart !== undefined && run.testEnd !== undefined);
  return timed.length ? Math.max(...timed.map(run => run.testEnd!)) - Math.min(...timed.map(run => run.testStart!)) : 0;
}

// Integration and fault/recovery files run in parallel QA projects sized from
// recorded file durations and free Goal QA slots. A file that fails after other
// files in its project is rerun alone on a fresh project; passing there marks it
// order-dependent, and the fresh result replaces the shared-project result.
async function runStackTier(tier: StackTier): Promise<void> {
  const artifact = tierArtifactName(tier);
  const budget = tier === 'integration' ? 480_000 : 360_000;
  const { paths, flags } = splitTestArgs(testArgs(tier, selection, chosen));
  const estimates = estimatedDurations(expandTestPaths(root, paths), recordedFileDurations(artifactRoots(root), tier));
  const slots = acquireQaSlots(goalSlotDirectory(root), shardCount(estimates, budget, maximumShards(process.env)));
  mkdirSync(join(directory, 'shards'), { recursive: true });
  try {
    const prefix = tier === 'integration' ? '' : 'f';
    const runs = await Promise.all(planShards(estimates, slots.count)
      .map((files, index) => runShard(tier, `${runId}-${prefix}${index + 1}`, files, flags, budget)));
    const candidates = runs.filter(run => !run.ok && !run.timedOut && run.record.stage === 'test'
      && run.record.files.length > 1)
      .flatMap(run => [...failedTests(run, tier)].map(([file, names]) => ({ run, file, names })));
    const limit = Math.max(2, slots.count);
    const reruns: (ShardRun | undefined)[] = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(slots.count, limit, candidates.length) }, async () => {
      while (next < Math.min(limit, candidates.length)) {
        const index = next++;
        reruns[index] = await runShard(tier, `${runId}-${prefix}r${index + 1}`, [candidates[index]!.file], flags, budget, true);
      }
    }));
    const replaced = new Map<string, ShardRun>();
    candidates.forEach(({ run, file, names }, index) => {
      const rerun = reruns[index];
      const ranAlone = rerun?.record.stage === 'test' && !rerun.timedOut;
      const status = !ranAlone ? 'not-run' : rerun.ok && !failedTests(rerun, tier).size ? 'order-dependent' : 'failed-alone';
      if (ranAlone) replaced.set(file, rerun);
      isolation.push({ tier, file, afterProject: run.record.project, afterFiles: run.record.files.length - 1,
        ...(rerun ? { project: rerun.record.project } : {}), shardFailures: names, status });
    });
    const resolved = (run: ShardRun) => run.ok || (!run.timedOut && run.record.stage === 'test'
      && [...failedTests(run, tier).keys()].every(file => isolation.some(item => item.tier === tier
        && item.file === file && item.afterProject === run.record.project && item.status === 'order-dependent')));
    const suites = runs.flatMap(run => junitSuites(run.xml ?? '')
      .filter(suite => !suite.file || !replaced.has(suite.file)).map(suite => suite.xml));
    for (const rerun of replaced.values()) suites.push(...junitSuites(rerun.xml ?? '').map(suite => suite.xml));
    const completed = reruns.filter((run): run is ShardRun => run !== undefined);
    const elapsedMs = testWall(runs) + testWall(completed);
    writeFileSync(join(directory, `${artifact}.xml`), mergeJUnit(suites, elapsedMs));
    for (const run of [...runs, ...completed]) {
      if (run.record.stage !== 'test' || (run.record.isolation ? run.ok : resolved(run))) continue;
      const label = `${artifact}-${run.record.project.slice(runId.length + 1)}`;
      errors.push(`${tier} failed or exceeded ${budget / 1000}s in ${run.record.project} (see logs/${label}.log)`);
    }
    const executed = parseJUnit(mergeJUnit(suites, 0), tier).length > 0;
    if (!executed) errors.push(`${tier} executed no tests`);
    if (elapsedMs > budget) errors.push(`${tier} test wall time ${(elapsedMs / 1000).toFixed(1)}s exceeded ${budget / 1000}s`);
    const ok = executed && elapsedMs <= budget && runs.every(resolved) && completed.every(run => run.ok);
    tiers.push({ name: tier, status: ok ? 'passed' : 'failed', elapsedMs,
      shards: [...runs, ...completed].map(run => run.record) });
  } finally { slots.release(); }
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
        FUSEKI_TITLE_ADMISSION_KEY: compose.FUSEKI_TITLE_ADMISSION_KEY,
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
    if (tier === 'integration' || tier === 'fault/recovery') await runStackTier(tier);
    if (tier === 'load') {
      const projectRunId = `${runId}-l`;
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
      const budget = 180_000;
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
    writeSummary(directory, { runId, sourceBefore, sourceAfter, tiers, isolation,
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
