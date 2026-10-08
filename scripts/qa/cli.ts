import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  acquireFullLock,
  acquireQaSlots,
  admissionIntervalMs,
  artifactRoots,
  backendTiers,
  command,
  commandAsync,
  concurrencyGate,
  estimatedDurations,
  expandTestPaths,
  faultRecoveryBaselineDurations,
  goalSlotDirectory,
  implementedTiers,
  isolationCandidates,
  junitSuites,
  LOAD_FIXTURE_ID,
  LOAD_PREPARATION_BUDGET_MS,
  loadFixturePlan,
  matchedNoTests,
  maximumShards,
  mergeJUnit,
  newRunId,
  parseArgs,
  planStackProjects,
  recordedFileDurations,
  selfManagedFaultFiles,
  selfManagedFaultAdmission,
  shardCount,
  stackPlanBudgetWarning,
  shardResolved,
  sourceIdentity,
  splitTestArgs,
  tierArtifactName,
  uncoveredTiers,
  writeSummary,
  withQaMemory,
  xmlForCommand,
  type IsolationRecord,
  type ShardRecord,
  type Tier,
} from './core.ts';
import {
  caseInventory,
  e2eArgs,
  failedSelection,
  junitResults,
  parseJUnit,
  testArgs,
  UNEXECUTED_FILE_TEST,
  unitHarnessFiles,
} from './acceptance.ts';
import { selectBackendCases } from './backend-scope.ts';
import { declaredCaseCoverage, missingCaseDeclarations, renderQualification,
  type QualificationRecord } from './coverage.ts';
import { readEnv } from '../dev/config.ts';
import { browserBudgets, browserFileCounts, browserProjectCount, e2eBrowserPlan } from './browser-budget.ts';
import { qaMemoryDeadline, qaMemoryNeed, type StartupSlotGate } from './memory-admission.ts';
import { runQaStartupChildAsync } from './stack-startup.ts';
import { allocateWebPort, webOrigin } from './e2e.ts';
import { discoverJourneyPreparations, preparationBudgetMs, selectJourneyPreparations } from './e2e-preparation.ts';
import { cleanupQaStacks, QA_STACK_REGISTRY, QA_STACK_TIER } from './stack-ownership.ts';
import { commandOnlyIntegrationFiles } from './isolated-integration-files.ts';
import { planIntegrationShards } from './integration-shards.ts';
import { completeFileResults, lastStartedTestFile } from './file-results.ts';
import { qaStackEnvironment, qaStackMode } from './stack-environment.ts';

import { ownerTierBudgetMs } from './owner-tier-budget.ts';
import { assertQaResourceAllocation, integrationResourceClass, integrationTierBudget, qaResourceClasses, queuedProjectsBudget } from './resource-classes.ts';
import {
  campaignCommandAccepted, campaignPhaseDeadline, campaignQualificationShard, campaignShardActiveMs,
  childStackCleanupCommand, currentSuppliedRunIds, openCampaignEvidence, phaseCommandOptions,
  type CampaignEvidenceRead, type CommandPhaseSample,
} from './campaign-envelope.ts';

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
const startedFixtureProjects: string[] = [];
const rawUpdateProjects = new Set<string>();
const childStackRegistries = new Set<string>();
const faultFixtureEnvironment: NodeJS.ProcessEnv = {};
const inventory = caseInventory(root);
const backendSelection = options.backend ? selectBackendCases(inventory) : undefined;
const cases = backendSelection?.cases ?? inventory;
const caseCoverage = declaredCaseCoverage(cases, options.backend ? 'backend' : 'all');
const selection = options.onlyFailed ? failedSelection(join(root, '.artifacts', 'qa'), options.onlyFailed) : undefined;
const selected = selection?.tiers ?? (options.tier ? [options.tier] : options.backend ? backendTiers : implementedTiers);
const chosen = options.files || options.id ? options : undefined;
const runDeadline = qaMemoryDeadline(process.env, Date.now() + 6 * 3_600_000);
process.env.REZICS_QA_MEMORY_DEADLINE = String(runDeadline);
process.env.REZICS_STACK_PROFILE = 'qa';
process.env.REZICS_QA_MEMORY_EVENTS = '1';
const admissionIntervals: { start: number; end: number }[] = [];
const admissionStarts = new Map<string, number>();
function noteMemory(message: string): void {
  const event = /^QA_MEMORY_WAIT_(BEGIN|END) (\d+-\d+)(?: (\d+))?$/.exec(message);
  if (event?.[1] === 'BEGIN') {
    if (!admissionStarts.has(event[2]!)) admissionStarts.set(event[2]!, Date.now());
  } else if (event?.[1] === 'END') {
    const start = admissionStarts.get(event[2]!);
    if (start !== undefined) {
      admissionIntervals.push({ start, end: Date.now() });
      admissionStarts.delete(event[2]!);
    }
  }
  if (!message.includes('QA memory:')) return;
  console.log(message);
  appendFileSync(join(logs, 'memory-admission.log'), `${message}\n`);
}
// Host work is admitted here; every Compose startup owns the shared VM guard.
async function admit<T>(kind: 'other' | 'browser', work: () => Promise<T>, env: NodeJS.ProcessEnv = process.env): Promise<T> {
  return withQaMemory(qaMemoryNeed(root, kind, undefined, env), {
    root, env,
    deadline: runDeadline,
    announce: noteMemory,
    onAdmissionWait: ms => { const end = Date.now(); admissionIntervals.push({ start: end - ms, end }); },
  }, work);
}
let runSlots: Awaited<ReturnType<typeof acquireQaSlots>> | undefined;
const qaSlotDirectory = process.env.GOAL_QA_SLOT_DIRECTORY ?? goalSlotDirectory(root);
// Direct task runs and their startup children publish into the same status directory as goalctl.
if (qaSlotDirectory) process.env.GOAL_QA_WAIT_DIR ??= join(qaSlotDirectory, 'waiters');
process.env.GOAL_QA_COMMAND ??= ['bun', ...process.argv.slice(1)].join(' ');
const heavyQaRun = process.env.GOAL_QA_HEAVY_RUN === '1';
async function acquireRunSlots(wanted: number, slotOptions: Parameters<typeof acquireQaSlots>[4] = {}) {
  let waitPath: string | undefined;
  const removeWait = () => { if (waitPath) rmSync(waitPath, { force: true }); };
  process.on('exit', removeWait);
  try {
    return await acquireQaSlots(heavyQaRun ? undefined : qaSlotDirectory, wanted, process.env, process.pid, {
      ...slotOptions,
      announce: message => {
        const waiterDirectory = process.env.GOAL_QA_WAIT_DIR;
        if (waiterDirectory) {
          mkdirSync(waiterDirectory, { recursive: true });
          waitPath ??= join(waiterDirectory, `slot-${process.pid}-${randomUUID()}.json`);
          const temporary = `${waitPath}.${randomUUID()}.tmp`;
          writeFileSync(temporary, JSON.stringify({ pid: process.pid, goal: process.env.GOAL_ID,
            command: process.env.GOAL_QA_COMMAND, waitingFor: 'slot', message,
            since: new Date((slotOptions.now ?? Date.now)()).toISOString() }));
          renameSync(temporary, waitPath);
        }
        (slotOptions.announce ?? console.error)(message);
      },
    });
  } finally {
    removeWait();
    process.off('exit', removeWait);
  }
}
// The child measures under the startup mutex; the runner owns the slot through cleanup.
async function withStartupSlot<T>(env: NodeJS.ProcessEnv,
  start: (environment: NodeJS.ProcessEnv, onLine: (line: string) => void) => Promise<T>,
  reserve: (slotOptions: Parameters<typeof acquireQaSlots>[4]) => Promise<void>): Promise<T> {
  const token = randomUUID();
  const gateDirectory = join(root, '.temp', 'qa-startup-gates');
  mkdirSync(gateDirectory, { recursive: true });
  const gatePath = join(gateDirectory, `${token}.json`);
  const publish = (status: StartupSlotGate['status'], requester?: string, sequence?: number, error?: string) => {
    const temporary = `${gatePath}.tmp`;
    writeFileSync(temporary, JSON.stringify({ token, status, requester, sequence, error }));
    renameSync(temporary, gatePath);
  };
  const waiterDirectory = env.GOAL_QA_WAIT_DIR;
  const waitPath = waiterDirectory && join(waiterDirectory, `slot-${process.pid}-${token}.json`);
  const removeWait = () => { if (waitPath) rmSync(waitPath, { force: true }); };
  const removeGate = () => { removeWait(); rmSync(gatePath, { force: true }); };
  process.on('exit', removeGate);
  publish('pending');
  let admission: Promise<void> | undefined;
  const requests = new Set<string>();
  try {
    return await start({ ...env, REZICS_QA_STARTUP_SLOT_GATE: gatePath }, line => {
      const request = /^QA_STARTUP_SLOT_READY (\S+) (\S+) (\d+)$/.exec(line);
      if (request?.[1] === token) {
        const requester = request[2]!;
        const sequence = Number(request[3]);
        const key = `${requester}:${sequence}`;
        // Intermediate runners can replay captured output after streaming the same request.
        if (requests.has(key)) return;
        requests.add(key);
        // A busy slot means retrying memory + startup admission, never holding a stale reading.
        admission = reserve({ deadline: Date.now(), runDeadline }).then(() => {
          removeWait();
          publish('granted', requester, sequence);
        }, error => {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.startsWith('No QA slot became free before the deadline')) {
            publish('failed', requester, sequence, message);
            return;
          }
          if (waitPath) {
            mkdirSync(waiterDirectory!, { recursive: true });
            writeFileSync(waitPath, JSON.stringify({ pid: process.pid, goal: env.GOAL_ID,
              command: env.GOAL_QA_COMMAND, waitingFor: 'slot',
              message: 'Waiting for a QA slot after memory admission', since: new Date().toISOString() }));
          }
          publish('retry', requester, sequence);
        });
      } else {
        if (line.startsWith('Waiting; QA memory:') || line.startsWith('Waiting for another QA startup;')) removeWait();
        noteMemory(line);
      }
    });
  } finally {
    try { await admission; }
    finally {
      removeGate();
      process.off('exit', removeGate);
    }
  }
}

async function reserveRunSlot(slotOptions: Parameters<typeof acquireQaSlots>[4]): Promise<void> {
  runSlots ??= await acquireRunSlots(1, slotOptions);
}

/** Finished host work and stopped fixture sources must not reserve capacity for later startups. */
async function withWorkSlot<T>(work: (reserve: typeof reserveRunSlot) => Promise<T>): Promise<T> {
  let slots: Awaited<ReturnType<typeof acquireQaSlots>> | undefined;
  try {
    return await work(async slotOptions => {
      // An earlier live stack retains its lease through the run's final cleanup.
      if (runSlots) return;
      slots ??= await acquireRunSlots(1, slotOptions);
    });
  } finally { slots?.release(); }
}

/** Host-only tiers also own a lease, but retries never hold one through admission. */
async function admitRun<T>(work: () => Promise<T>, env: NodeJS.ProcessEnv = process.env,
  reserve?: typeof reserveRunSlot): Promise<T> {
  if (!reserve) return withWorkSlot(reserveWork => admitRun(work, env, reserveWork));
  for (;;) {
    try {
      return await admit('other', async () => {
        await reserve({ deadline: Date.now(), runDeadline });
        return work();
      }, env);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('No QA slot became free before the deadline')) throw error;
      if (Date.now() >= runDeadline) throw error;
      await Bun.sleep(Math.min(3_000, runDeadline - Date.now()));
    }
  }
}

async function startRunStack(args: string[], budget: number, env: NodeJS.ProcessEnv = process.env,
  reserve = reserveRunSlot) {
  return withStartupSlot(env,
    (environment, onLine) => runQaStartupChildAsync(root, args, budget, environment, onLine), reserve);
}

const release = options.tier || options.onlyFailed ? () => {} : acquireFullLock(root, runId);

function campaignEvidenceRead(projectRunId: string, commandStartedAt: number, sample: CommandPhaseSample): CampaignEvidenceRead {
  const evidencePath = join(directory, 'erasure-campaign-qualification.json');
  const observedAt = Date.now();
  if (!existsSync(evidencePath)) {
    return {
      parsed: undefined, readError: false, modifiedAt: commandStartedAt, commandStartedAt,
      projectRunId, activeElapsedMs: sample.activeElapsedMs, observedAt,
    };
  }
  let parsed: unknown, readError = false;
  try { parsed = JSON.parse(readFileSync(evidencePath, 'utf8')); }
  catch { readError = true; }
  return {
    parsed, readError, modifiedAt: statSync(evidencePath).mtimeMs, commandStartedAt,
    projectRunId, activeElapsedMs: sample.activeElapsedMs, observedAt,
  };
}

async function resetChildStacks(registry: string): Promise<string[]> {
  // Only ids validated from the current source list keep their volumes. Timeout and
  // the final cleanup both come through here. A caller-owned copy is stopped, not reset.
  const supplied = currentSuppliedRunIds(process.env.ERASURE_CAMPAIGN_SOURCES);
  const failures = await cleanupQaStacks(registry, async args => {
    const command = childStackCleanupCommand(args, supplied);
    const down = await commandAsync(root, 'bun', ['scripts/dev/cli.ts', command, ...args], 120_000);
    if (!down.ok) throw new Error(down.output);
  });
  if (!failures.length) childStackRegistries.delete(registry);
  return failures;
}

async function runTier(name: Tier, program: string, args: string[], budget: number,
  env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const result = await admitRun(async () => command(root, program, args, budget, env), env);
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

// Bun owner suites install signal handlers too; enforce the wall deadline on
// their process group so a handled SIGTERM cannot keep QA capacity indefinitely.
async function runBunTier(name: Tier, program: string, args: string[], budget: number) {
  const logPath = join(logs, `${name}.log`);
  const progress = process.env.REZICS_QA_PROGRESS_FILE;
  // CI makes Bun omit file headers, so the preload records the current file.
  // Lines that do arrive are written as they come, before an outer kill.
  const programArgs = progress
    ? [...args, `--preload=${join(import.meta.dir, 'owner-shard-progress.ts')}`]
    : args;
  const onLine = (line: string) => {
    noteMemory(line);
    appendFileSync(logPath, `${line}\n`);
    if (progress) appendFileSync(progress, `${line}\n`);
  };
  const result = await admitRun(
    () => commandAsync(root, program, programArgs, budget, process.env, onLine, { runDeadline }));
  const ok = result.ok && result.activeElapsedMs <= budget;
  tiers.push({ name, status: ok ? 'passed' : 'failed', elapsedMs: result.activeElapsedMs });
  if (!ok) {
    writeFileSync(logPath, result.output);
    errors.push(`${name} failed or exceeded ${budget / 1000}s (see logs/${name}.log)`);
    if (result.timedOut) console.error(`QA tier budget exceeded: ${name} ${budget}ms`);
  }
  return ok;
}

// One disposable QA project: start, bootstrap, run the files, then reset it
// unless --keep, so finished shards release their capacity early.
let runSlotInUse = false;
async function runShard(
  tier: StackTier, projectRunId: string, files: string[], flags: string[], budget: number,
  isolated = false, startStack?: <T>(work: () => Promise<T>) => Promise<T>, batches: string[][] = [files],
): Promise<ShardRun> {
  let slots: Awaited<ReturnType<typeof acquireQaSlots>> | undefined;
  let usesRunSlot = false;
  try {
    return await runShardWork(tier, projectRunId, files, flags, budget, isolated, startStack, batches,
      async slotOptions => {
        if (usesRunSlot || slots) return;
        if (!runSlots && process.env.GOAL_IN_SLOT === '1' && !heavyQaRun) await reserveRunSlot(slotOptions);
        if (runSlots && !runSlotInUse) { runSlotInUse = usesRunSlot = true; return; }
        slots ??= await acquireRunSlots(1, { ...slotOptions, inherit: false });
      });
  } finally {
    slots?.release();
    if (usesRunSlot) runSlotInUse = false;
  }
}

async function runShardWork(
  tier: StackTier,
  projectRunId: string,
  files: string[],
  flags: string[],
  budget: number,
  isolated = false,
  startStack?: <T>(work: () => Promise<T>) => Promise<T>,
  batches: string[][] = [files],
  reserve: (slotOptions: Parameters<typeof acquireQaSlots>[4]) => Promise<void> = reserveRunSlot,
): Promise<ShardRun> {
  const preparationStartedAt = Date.now();
  const resourceClass = tier === 'integration' ? integrationResourceClass(files) : undefined;
  if (resourceClass) budget = qaResourceClasses[resourceClass].budgetMs;
  const environment = qaStackEnvironment({
    ...process.env,
    ...(tier === 'fault/recovery' ? faultFixtureEnvironment : {}),
  }, resourceClass && resourceClass !== 'ordinary' ? qaResourceClasses[resourceClass].storage : undefined, resourceClass);
  const needsStack = tier !== 'fault/recovery' || !files.every(file => selfManagedFaultFiles.has(file));
  const startupProtocol = !needsStack && files.every(file => selfManagedFaultAdmission.get(file) === 'startup');
  const persistent = qaStackMode(environment) === 'scale'
    || tier === 'integration' && files.some(file => commandOnlyIntegrationFiles.has(file));
  // Scale changes storage, not a fixture's endpoints. Product-only native
  // qualification keeps its closed raw-update endpoint in every storage mode.
  const rawUpdate = persistent && !files.some(file => commandOnlyIntegrationFiles.has(file));
  if (rawUpdate) rawUpdateProjects.add(projectRunId);
  const stackArgs = ['--profile', 'qa', '--run-id', projectRunId,
    ...(persistent ? ['--persistent'] : []), ...(rawUpdate ? ['--raw-update'] : [])];
  const started = persistent ? startedFixtureProjects : startedProjects;
  const label = `${tierArtifactName(tier)}-${projectRunId.slice(runId.length + 1)}`;
  const record: ShardRecord = { project: projectRunId, files, status: 'failed', stage: 'stack',
    ...(isolated ? { isolation: true } : {}),
    ...(resourceClass ? { resourceClass, budgetMs: budget } : {}) };
  const finish = async (run: Omit<ShardRun, 'record'>): Promise<ShardRun> => {
    if (record.stage !== 'test') {
      const results = completeFileResults(run.xml ?? '', files, tier, {
        interrupted: true,
        reason: `Shard ${record.stage} failed before tests ran`,
      });
      run.xml = results.xml;
      record.missingFiles = results.missing;
    }
    if (!run.ok && needsStack) {
      const stackLogs = await commandAsync(root, 'bun', ['scripts/dev/cli.ts', 'stack:logs', ...stackArgs], 20_000);
      writeFileSync(join(logs, `${label}-stack.log`), stackLogs.output);
    }
    if (!options.keep && needsStack) {
      const down = await commandAsync(root, 'bun', ['scripts/dev/cli.ts', 'stack:reset', ...stackArgs], 120_000);
      record.cleanupMs = down.elapsedMs;
      if (down.ok) started.splice(started.indexOf(projectRunId), 1);
    }
    record.status = run.ok ? 'passed' : 'failed';
    return { record, ...run };
  };
  let apps: Record<string, string> = {};
  let compose: Record<string, string> = {};
  if (needsStack) {
    started.push(projectRunId);
    const upCommand = () => startRunStack(['stack:up', ...stackArgs], 180_000, {
      ...environment, [QA_STACK_TIER]: tier,
    }, reserve);
    const up = await (startStack ? startStack(upCommand) : upCommand()).catch(error => ({
      ok: false, timedOut: true, elapsedMs: Date.now() - preparationStartedAt,
      output: error instanceof Error ? error.message : String(error),
    }));
    record.startupMs = 'activeElapsedMs' in up ? up.activeElapsedMs : 0;
    if (!up.ok) {
      writeFileSync(join(logs, `${label}-startup.log`), up.output);
      errors.push(`${tier} stack startup failed: ${projectRunId} (see logs/${label}-startup.log)`);
      return finish({ ok: false, timedOut: up.timedOut, noMatch: false,
        xml: xmlForCommand(tier, false, up.elapsedMs, up.output) });
    }
    if (resourceClass) {
      const inspected = await commandAsync(root, 'docker', ['inspect', '--format',
        '{"memory":{{.HostConfig.Memory}},"tmpfs":{{json .HostConfig.Tmpfs}},"mounts":{{json .Mounts}}}',
        `rezics-qa-${projectRunId}-fuseki-1`], 10_000);
      let failure = inspected.ok ? '' : 'Could not inspect QA Fuseki allocation';
      if (inspected.ok) {
        // Command-only files start a persistent stack in test mode too; check
        // the storage that stack:up was asked for, not the mode's default.
        try { assertQaResourceAllocation(resourceClass, JSON.parse(inspected.output), persistent ? 'scale' : 'test'); }
        catch (error) { failure = error instanceof Error ? error.message : 'Invalid QA Fuseki allocation'; }
      }
      if (failure) {
        writeFileSync(join(logs, `${label}-allocation.log`), failure);
        errors.push(`${tier} allocation failed: ${projectRunId} (see logs/${label}-allocation.log)`);
        return finish({ ok: false, timedOut: inspected.timedOut, noMatch: false,
          xml: xmlForCommand(tier, false, inspected.elapsedMs, failure) });
      }
    }
    const stackDir = join(root, '.temp', 'stack', `rezics-qa-${projectRunId}`);
    apps = readEnv(join(stackDir, 'apps.env'));
    compose = readEnv(join(stackDir, 'compose.env'));
    const appsPath = join(stackDir, 'qa-apps.json');
    const composePath = join(stackDir, 'qa-compose.json');
    writeFileSync(appsPath, JSON.stringify(apps), { mode: 0o600 });
    writeFileSync(composePath, JSON.stringify(compose), { mode: 0o600 });
    record.stage = 'bootstrap';
    const bootstrap = await commandAsync(
      root,
      'bun',
      ['scripts/qa/bootstrap.ts', appsPath, composePath],
      180_000,
      environment,
    );
    record.bootstrapMs = bootstrap.elapsedMs;
    if (!bootstrap.ok) {
      errors.push(`${tier} shared bootstrap failed: ${projectRunId} (see logs/${label}-bootstrap.log)`);
      writeFileSync(join(logs, `${label}-bootstrap.log`), bootstrap.output);
      return finish({ ok: false, timedOut: bootstrap.timedOut, noMatch: false,
        xml: xmlForCommand(tier, false, bootstrap.elapsedMs, bootstrap.output) });
    }
  }
  if (!needsStack) {
    try {
      if (startupProtocol) await admit('other', async () => {}, environment);
      else await admitRun(async () => {}, environment, reserve);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
      return finish({ ok: false, timedOut: true, noMatch: false,
        xml: xmlForCommand(tier, false, Date.now() - preparationStartedAt, message) });
    }
  }
  record.stage = 'test';
  const outfile = join(directory, 'shards', `${label}.xml`);
  const registry = join(root, '.temp', 'qa-child-stacks', projectRunId);
  childStackRegistries.add(registry);
  const testStart = Date.now();
  const testEnvironment = () => ({
    ...environment,
    ...apps,
    REZICS_QA_RUN_ID: projectRunId,
    REZICS_QA_MEMORY_DEADLINE: String(runDeadline),
    REZICS_QA_PREPARATION_STARTED_AT: String(preparationStartedAt
      + admissionIntervalMs(admissionIntervals, preparationStartedAt, testStart)),
    [QA_STACK_REGISTRY]: registry,
    REZICS_QA_ARTIFACT_DIR: directory,
    ...(needsStack ? { REZICS_S3_GATE_PROJECT: projectRunId } : {}),
    ...(needsStack && tier === 'fault/recovery' ? {
      TOXIPROXY_API_URL: `http://127.0.0.1:${compose.TOXIPROXY_API_PORT}`,
      TOXIPROXY_FUSEKI_URL: `http://127.0.0.1:${compose.TOXIPROXY_FUSEKI_PORT}/rezics/` } : {}),
  });
  let childAdmissionMs = 0;
  const activeTestMs = () => Date.now() - testStart - childAdmissionMs;
  const suites: string[] = [];
  const output: string[] = [];
  const fileDurations: Record<string, number> = {};
  let commandOk = true,
    timedOut = false,
    noMatch = true;
  const envelope = campaignQualificationShard(files);
  const activeCeiling = envelope ? campaignShardActiveMs() : budget;
  for (let index = 0; index < batches.length; index++) {
    let resetMs = 0;
    if (activeTestMs() >= budget) {
      timedOut = true;
      commandOk = false;
      break;
    }
    if (index > 0) {
      const stackDir = join(root, '.temp', 'stack', `rezics-qa-${projectRunId}`);
      const reset = await commandAsync(
        root,
        'bun',
        [
          'scripts/qa/integration-reset.ts',
          join(stackDir, 'apps.env'),
          join(stackDir, 'compose.env'),
        ],
        Math.min(180_000, budget - activeTestMs()),
        environment,
      );
      output.push(reset.output);
      resetMs = reset.elapsedMs;
      if (!reset.ok) {
        timedOut ||= reset.timedOut;
        commandOk = false;
        break;
      }
      apps = readEnv(join(stackDir, 'apps.env'));
    }
    const batch = batches[index]!;
    const batchFile =
      batches.length === 1 ? outfile : outfile.replace(/\.xml$/, `-${index + 1}.xml`);
    const runBatch = (environment: NodeJS.ProcessEnv, onLine: (line: string) => void) => commandAsync(
      root, 'bun', ['test', ...batch, ...flags, '--reporter=junit', `--reporter-outfile=${batchFile}`],
      Math.max(1, budget - activeTestMs()), environment, onLine, { runDeadline });
    const campaign = campaignQualificationShard(batch);
    const commandStartedAt = Date.now();
    const evidenceWatch = openCampaignEvidence();
    const phaseDeadline = (sample: CommandPhaseSample) => campaignPhaseDeadline(sample,
      evidenceWatch.observe(campaignEvidenceRead(projectRunId, commandStartedAt, sample)));
    const result = campaign
      ? await commandAsync(root, 'bun', ['test', ...batch, ...flags, '--reporter=junit', `--reporter-outfile=${batchFile}`],
        Math.max(1, budget - activeTestMs()), testEnvironment(), noteMemory,
        phaseCommandOptions({ runDeadline, phaseDeadline }))
      : await (startupProtocol ? withStartupSlot(testEnvironment(), runBatch, reserve)
        : runBatch(testEnvironment(), noteMemory));
    if (campaign) {
      const sample = { activeElapsedMs: result.activeElapsedMs, admissionOpen: false };
      const accepted = campaignCommandAccepted({
        exitOk: result.ok, timedOut: result.timedOut, sample,
        evidence: evidenceWatch.observe(campaignEvidenceRead(projectRunId, commandStartedAt, sample), 'final'),
      });
      if (!accepted.ok) commandOk = false;
      writeFileSync(join(directory, 'campaign-envelope.json'), `${JSON.stringify({
        projectRunId, commandStartedAt, activeElapsedMs: result.activeElapsedMs,
        admissionWaitMs: result.admissionWaitMs, ...accepted,
      }, null, 2)}\n`);
    }
    childAdmissionMs += result.admissionWaitMs;
    output.push(result.output);
    const empty = !result.ok && !result.timedOut && matchedNoTests(result.output);
    noMatch &&= empty;
    timedOut ||= result.timedOut;
    commandOk &&= result.ok || empty;
    const results = completeFileResults(
      existsSync(batchFile) ? readFileSync(batchFile, 'utf8') : '',
      batch,
      tier,
      {
        filtered: flags.includes('-t'),
        interrupted: result.timedOut,
        incompleteFiles: result.timedOut ? [lastStartedTestFile(result.output)].filter((file): file is string => Boolean(file)) : [],
        reason: result.timedOut ? 'Shard timed out before this file completed' : undefined,
      },
    );
    commandOk &&= !results.missing.length;
    suites.push(...junitSuites(results.xml).map((suite) => suite.xml));
    // Single-file commands include hooks, database cloning and process startup.
    if (batch.length === 1 && result.ok && !results.missing.length) {
      fileDurations[batch[0]!] = result.activeElapsedMs + resetMs;
    }
    if (result.timedOut) break;
  }
  const testEnd = Date.now();
  const cleanupFailures = await resetChildStacks(registry);
  if (cleanupFailures.length) writeFileSync(join(logs, `${label}-cleanup.log`), cleanupFailures.join('\n'));
  record.elapsedMs = testEnd - testStart - childAdmissionMs;
  const results = completeFileResults(mergeJUnit(suites, record.elapsedMs), files, tier, {
    filtered: flags.includes('-t'),
    interrupted: timedOut || !commandOk,
    reason: timedOut
      ? 'Shard timed out; file did not complete'
      : 'Shard stopped before this file produced results',
  });
  record.missingFiles = results.missing;
  // The campaign command timeout stays budget. activeCeiling only admits a run whose
  // phase callback already enforced 600ms preparation and 360ms operation.
  const ok =
    commandOk && !results.missing.length && record.elapsedMs <= activeCeiling && !cleanupFailures.length;
  // Retain successful logs too: they supply durations when a later command or
  // another project prevents the tier's merged reporter from being written.
  writeFileSync(join(logs, `${label}.log`), output.join('\n'));
  writeFileSync(join(logs, `${label}-durations.json`), JSON.stringify(fileDurations));
  writeFileSync(outfile, results.xml);
  return finish({ ok, timedOut, noMatch, testStart, testEnd, xml: results.xml });
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
  if (!timed.length) return 0;
  const start = Math.min(...timed.map(run => run.testStart!));
  const end = Math.max(...timed.map(run => run.testEnd!));
  return end - start - admissionIntervalMs(admissionIntervals, start, end);
}

// Integration and fault/recovery files run in parallel QA projects sized from
// recorded file durations and free Goal QA slots. A file that fails after other
// files in its project is rerun alone on a fresh project; passing there marks it
// order-dependent, and the fresh result replaces the shared-project result.
async function runStackTier(tier: StackTier): Promise<void> {
  const artifact = tierArtifactName(tier);
  const { paths, flags } = splitTestArgs(testArgs(tier, selection, chosen));
  // Only the explicitly selected exclusive drill times both 600-second commands.
  // Routine tier selections retain their existing wall and command deadlines.
  const exclusiveRecovery = tier === 'fault/recovery' && paths.length === 1
    && paths[0] === 'tests/qa/fault-recovery/g-727-launch-drill.test.ts';
  const budget = exclusiveRecovery ? 1_320_000 : tier === 'integration' ? 480_000 : 360_000;
  const recorded = recordedFileDurations(artifactRoots(root), tier);
  const local = tier === 'fault/recovery'
    ? recordedFileDurations([join(root, '.artifacts', 'qa')], tier, 60, 1) : new Map<string, number>();
  const estimates = estimatedDurations(expandTestPaths(root, paths),
    tier === 'fault/recovery' ? new Map([...recorded, ...faultRecoveryBaselineDurations, ...local]) : recorded);
  // Prepare the small retained owner cut once before any JVM shards start.
  // The launch drill restores only its isolated writable copy; medium launch
  // qualification continues to use its explicitly prepared source/fixture.
  if (
    tier === 'fault/recovery' &&
    estimates.has('tests/qa/fault-recovery/g-727-launch-drill.test.ts') &&
    !process.env.G727_LAUNCH_SOURCE_RUN_ID &&
    !process.env.G727_LAUNCH_FIXTURE &&
    (process.env.G727_LAUNCH_PROFILE ?? 'small') === 'small'
  ) {
    const fixtureRoot = process.env.REZICS_FIXTURE_ROOT ?? join(root, '.temp', 'fixture');
    const preparationFile = join(directory, 'fault-recovery-fixture-preparation.json');
    const prepared = await withWorkSlot(reserveWork => admit('other', () => withStartupSlot(
      { ...qaStackEnvironment(process.env), REZICS_FIXTURE_ROOT: fixtureRoot },
      (environment, onLine) => commandAsync(root, 'bun',
        ['scripts/fixture/cli.ts', 'build', '--prepare', '--profile', 'small', '--evidence', preparationFile],
        LOAD_PREPARATION_BUDGET_MS, environment, onLine, { runDeadline }), reserveWork), qaStackEnvironment(process.env)));
    writeFileSync(join(logs, 'fault-recovery-fixture-preparation.log'), prepared.output);
    if (!prepared.ok) {
      errors.push(
        'fault/recovery small-fixture preparation failed or exceeded 600s (see logs/fault-recovery-fixture-preparation.log)',
      );
      writeFileSync(
        join(directory, `${artifact}.xml`),
        completeFileResults('', [...estimates.keys()], tier, {
          reason: 'Small-fixture preparation failed before the tier ran',
        }).xml,
      );
      tiers.push({ name: tier, status: 'failed', elapsedMs: prepared.activeElapsedMs });
      return;
    }
    const report = JSON.parse(readFileSync(preparationFile, 'utf8')) as {
      fixture: string;
      elapsedMs: number;
    };
    faultFixtureEnvironment.REZICS_FIXTURE_ROOT = fixtureRoot;
    faultFixtureEnvironment.G727_LAUNCH_FIXTURE = report.fixture;
    faultFixtureEnvironment.G727_LAUNCH_PREPARATION_MS = String(prepared.activeElapsedMs);
  }
  const maximum = maximumShards(process.env, tier);
  const wanted =
    tier === 'fault/recovery'
      ? Math.min(maximum, estimates.size)
      : shardCount(estimates, budget, maximum);
  // Plan bounded workers without reserving leases for projects still awaiting admission.
  const capacity = heavyQaRun || !qaSlotDirectory ? wanted
    : Math.min(wanted, /^[1-9]\d*$/.test(process.env.GOAL_QA_SLOTS ?? '') ? Number(process.env.GOAL_QA_SLOTS) : 3);
  mkdirSync(join(directory, 'shards'), { recursive: true });
  {
    const prefix = tier === 'integration' ? '' : 'f';
    const integration =
      tier === 'integration' ? planIntegrationShards(estimates, capacity) : undefined;
    const planned =
      integration?.map((shard) => shard.files) ?? planStackProjects(estimates, capacity, tier);
    // In-file campaign preparation has its own active clock, so this file cannot
    // share a command whose single deadline is the operation budget.
    const projects = integration ? planned : planned.flatMap((group) => {
      if (!group.some(file => campaignQualificationShard([file]))) return [group];
      const rest = group.filter(file => !campaignQualificationShard([file]));
      return [...(rest.length ? [rest] : []), [group.find(file => campaignQualificationShard([file]))!]];
    });
    const projectBudget = (files: readonly string[]) =>
      campaignQualificationShard(files) ? campaignShardActiveMs() : budget;
    // Fault/recovery queues more projects than slots; each keeps its own deadline.
    // The campaign project's wall is the sum of its two measured phases.
    const tierBudget = integration ? integrationTierBudget(integration.map(shard => shard.resourceClass), capacity)
      : tier === 'fault/recovery' && !exclusiveRecovery ? queuedProjectsBudget(projects.map(projectBudget), capacity) : budget;
    const warning = stackPlanBudgetWarning(estimates, tierBudget, capacity, maximum, tier,
      tier === 'integration' ? count => planIntegrationShards(estimates, count).map(shard => shard.files) : undefined);
    if (warning) console.warn(warning);
    const runs = new Array<ShardRun>(projects.length);
    let project = 0;
    // Local workers bound the plan; each project takes its global lease only after admission.
    const startInitialStack = concurrencyGate(tier === 'integration' ? capacity : Math.min(capacity, 3));
    await Promise.all(
      Array.from({ length: Math.min(capacity, projects.length) }, async () => {
        while (project < projects.length) {
          const index = project++;
          runs[index] = await runShard(
            tier,
            `${runId}-${prefix}${index + 1}`,
            projects[index]!,
            flags,
            budget,
            false,
            startInitialStack,
            integration?.[index]?.batches,
          );
        }
      }),
    );
    const candidates = runs.filter(run => !run.ok && !run.timedOut && run.record.stage === 'test'
      && run.record.files.length > 1)
      .flatMap(run => isolationCandidates(run.xml ?? '', tier)
        .map(candidate => ({ run, ...candidate })));
    const reruns: (ShardRun | undefined)[] = [];
    let next = 0;
    const startRerunStack = concurrencyGate(Math.min(capacity, 3));
    await Promise.all(Array.from({ length: Math.min(capacity, candidates.length) }, async () => {
      while (next < candidates.length) {
        const index = next++;
        reruns[index] = await runShard(tier, `${runId}-${prefix}r${index + 1}`,
          [candidates[index]!.file], flags, budget, true, startRerunStack);
      }
    }));
    const replaced = new Map<string, ShardRun>();
    candidates.forEach(({ run, file, names, afterFiles, infrastructure }, index) => {
      const rerun = reruns[index];
      const observed = rerun ? parseJUnit(rerun.xml ?? '', tier) : [];
      const ranAlone = rerun?.record.stage === 'test' && !rerun.timedOut && !rerun.noMatch
        && names.every(name => observed.some(test => test.file === file && test.name === name));
      const recovered = ranAlone && rerun.ok && !failedTests(rerun, tier).size;
      const status = !ranAlone ? 'not-run' : !recovered ? 'failed-alone'
        : infrastructure ? 'infrastructure-dependent' : 'order-dependent';
      if (ranAlone) replaced.set(file, rerun);
      isolation.push({ tier, file, afterProject: run.record.project, afterFiles,
        ...(rerun ? { project: rerun.record.project } : {}), shardFailures: names, status });
    });
    const resolved = (run: ShardRun) => shardResolved(run.ok, run.record.stage, run.timedOut,
      new Set(failedTests(run, tier).keys()),
      new Set(isolation.filter(item => item.tier === tier && item.afterProject === run.record.project
        && (item.status === 'order-dependent' || item.status === 'infrastructure-dependent'))
        .map(item => item.file)));
    const suites = runs.flatMap(run => junitSuites(run.xml ?? '')
      .filter(suite => !suite.file || !replaced.has(suite.file)).map(suite => suite.xml));
    for (const rerun of replaced.values()) suites.push(...junitSuites(rerun.xml ?? '').map(suite => suite.xml));
    const completed = reruns.filter((run): run is ShardRun => run !== undefined);
    const elapsedMs = testWall(runs) + testWall(completed);
    const finalResults = completeFileResults(
      mergeJUnit(suites, elapsedMs),
      [...estimates.keys()],
      tier,
      { filtered: flags.includes('-t'), interrupted: runs.some((run) => run.timedOut), elapsedMs },
    );
    writeFileSync(join(directory, `${artifact}.xml`), finalResults.xml);
    if (finalResults.missing.length)
      errors.push(`${tier} files did not run: ${finalResults.missing.join(', ')}`);
    for (const run of [...runs, ...completed]) {
      if (run.record.stage !== 'test' || (run.record.isolation ? run.ok : resolved(run))) continue;
      const label = `${artifact}-${run.record.project.slice(runId.length + 1)}`;
      errors.push(`${tier} failed or exceeded ${(run.record.budgetMs ?? budget) / 1000}s in ${run.record.project} (see logs/${label}.log)`);
    }
    const executed = parseJUnit(mergeJUnit(suites, 0), tier).length > 0;
    if (!executed) errors.push(`${tier} executed no tests`);
    if (elapsedMs > tierBudget) errors.push(`${tier} test wall time ${(elapsedMs / 1000).toFixed(1)}s exceeded ${tierBudget / 1000}s`);
    const ok = executed && elapsedMs <= tierBudget && runs.every(resolved) && completed.every(run => run.ok);
    tiers.push({ name: tier, status: ok ? 'passed' : 'failed', elapsedMs,
      shards: [...runs, ...completed].map(run => run.record) });
  }
}

function noteBrowserPlan(artifactDirectory: string): void {
  const path = join(artifactDirectory, 'e2e-browser-plan.json');
  if (!existsSync(path)) return;
  const plan = JSON.parse(readFileSync(path, 'utf8')) as {
    stories: boolean; storySkipReason?: string; accountsJourneys: boolean; selectedFiles: string[];
  };
  const notes: string[] = [];
  if (!plan.stories) notes.push(`- Storybook: skipped (${plan.storySkipReason ?? 'not a full e2e tier'})`);
  if (!plan.accountsJourneys && plan.selectedFiles.length) {
    notes.push('- Accounts journeys: skipped (selected journey files; a full e2e tier runs them)');
  }
  if (notes.length) appendFileSync(join(artifactDirectory, 'summary.md'), `${notes.join('\n')}\n`);
}

try {
  if (options.record && !sourceBefore.clean) throw new Error('--record requires a clean source tree');
  if (options.record) {
    const missing = missingCaseDeclarations(cases, caseCoverage);
    if (missing.length) throw new Error(`--record requires complete case declarations; ${missing.length} IDs remain`);
  }
  for (const tier of selected) {
    if (tier === 'static') await runTier(tier, 'bun', ['scripts/research/storage_architecture/check.ts', ...(options.backend ? ['--backend'] : [])], 120_000);
    if (tier === 'unit' || tier === 'owner')
      await runBunTier(
        tier,
        'bun',
        [
          'test',
          ...testArgs(tier, selection, chosen),
          ...(tier === 'unit' && !selection && !chosen ? unitHarnessFiles : []),
          '--reporter=junit',
          `--reporter-outfile=${join(directory, `${tier}.xml`)}`,
        ],
        tier === 'owner' ? ownerTierBudgetMs() : 180_000,
      );
    if (tier === 'model') {
      const projectRunId = `${runId}-m`;
      startedProjects.push(projectRunId);
      const up = await startRunStack(['stack:up', '--profile', 'qa', '--run-id', projectRunId], 180_000);
      if (!up.ok) {
        errors.push('model stack startup failed');
        writeFileSync(join(logs, 'model-stack.log'), up.output);
        tiers.push({ name: tier, status: 'failed' });
        writeFileSync(join(directory, 'model.xml'), xmlForCommand(tier, false, up.elapsedMs, up.output));
        continue;
      }
      const stackDir = join(root, '.temp', 'stack', `rezics-qa-${projectRunId}`);
      const compose = readEnv(join(stackDir, 'compose.env'));
      const result = await commandAsync(root, 'bun', ['test', ...testArgs('model', selection, chosen), '--reporter=junit',
        `--reporter-outfile=${join(directory, 'model.xml')}`], 180_000,
      { ...process.env, FUSEKI_URL: `http://127.0.0.1:${compose.FUSEKI_PORT}/rezics/`,
        FUSEKI_MAINTENANCE_TOKEN: compose.FUSEKI_MAINTENANCE_TOKEN,
        FUSEKI_COMMAND_TOKEN: compose.FUSEKI_COMMAND_TOKEN,
        FUSEKI_TITLE_ADMISSION_KEY: compose.FUSEKI_TITLE_ADMISSION_KEY,
        MODEL_NATIVE_EQUIVALENCE: '1', MODEL_NATIVE_EQUIVALENCE_STRICT: '1',
        REZICS_QA_ARTIFACT_DIR: directory }, noteMemory, { runDeadline });
      const ok = result.ok && result.activeElapsedMs <= 180_000;
      tiers.push({ name: tier, status: ok ? 'passed' : 'failed', elapsedMs: result.activeElapsedMs });
      if (!ok) {
        errors.push('model failed or exceeded 180s');
        writeFileSync(join(logs, 'model.log'), result.output);
        const stackLogs = command(root, 'bun', ['scripts/dev/cli.ts', 'stack:logs', '--profile', 'qa', '--run-id', projectRunId], 20_000);
        writeFileSync(join(logs, 'model-stack.log'), stackLogs.output);
      }
    }
    if (tier === 'e2e') {
      const reserved = await allocateWebPort();
      const origin = webOrigin(reserved.port);
      console.log(`e2e web origin: ${origin}`);
      try {
        const projectRunId = `${runId}-e`;
        startedProjects.push(projectRunId);
        const up = await startRunStack(['stack:up', '--profile', 'qa', '--run-id', projectRunId,
          '--accounts-app'], 180_000, { ...process.env, REZICS_QA_MEMORY_KIND: 'browser' });
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
          '--run-id', projectRunId, '--redirect-uri', `${origin}/auth/callback`], 180_000);
        if (!webAuth.ok) {
          errors.push('e2e web authorization bootstrap failed');
          writeFileSync(join(logs, 'e2e-web-auth-bootstrap.log'), webAuth.output);
          tiers.push({ name: tier, status: 'failed' });
          writeFileSync(join(directory, 'e2e.xml'), xmlForCommand(tier, false, webAuth.elapsedMs, webAuth.output));
          continue;
        }
        const args = e2eArgs(selection, chosen);
        const plan = e2eBrowserPlan(args, options.storybook === true);
        const counts = browserFileCounts(root, args);
        const budgets = browserBudgets(counts.playwright, counts.storybook, browserProjectCount(), {
          playwright: plan.accountsJourneys ? counts.accountsPlaywright : 0,
          stories: plan.stories ? counts.accountsStories : 0,
        });
        const preparation = preparationBudgetMs(selectJourneyPreparations(
          await discoverJourneyPreparations(root), args));
        const storyBudget = plan.stories ? budgets.storybook + budgets.accountsStorybook : 0;
        const e2eEnv: NodeJS.ProcessEnv = { ...process.env, REZICS_WEB_E2E_BASE_URL: origin,
          REZICS_WEB_E2E_PORT_HOLDER: String(reserved.pid) };
        if (options.storybook) e2eEnv.REZICS_E2E_STORYBOOK = '1';
        else delete e2eEnv.REZICS_E2E_STORYBOOK;
        const result = await commandAsync(root, 'bun', ['scripts/qa/e2e.ts', appsPath, directory, projectRunId, ...args],
          preparation + budgets.setup + budgets.playwright + budgets.accountsPlaywright + storyBudget + 30_000,
          e2eEnv, noteMemory, { runDeadline });
        writeFileSync(join(logs, 'e2e.log'), result.output);
        const browserTests = junitResults(directory, ['e2e']);
        const ok = result.ok && browserTests.length > 0 && browserTests.every(test => !test.failed);
        tiers.push({ name: tier, status: ok ? 'passed' : 'failed', elapsedMs: result.elapsedMs });
        if (!ok) {
          const stepsPath = join(directory, 'e2e-steps.json');
          const steps = existsSync(stepsPath) ? JSON.parse(readFileSync(stepsPath, 'utf8')) as
            { step: string; passed: boolean; error?: string }[] : [];
          const failed = steps.filter(step => !step.passed);
          errors.push(...(failed.length ? failed.map(step => `${step.step}: ${step.error ?? 'failed'} (see logs/e2e.log)`)
            : ['e2e runner failed or exceeded its combined step budgets (see logs/e2e.log)']));
          if (!existsSync(join(directory, 'e2e.xml'))) {
            writeFileSync(join(directory, 'e2e.xml'), xmlForCommand(tier, false, result.elapsedMs, result.output));
          }
          const stackLogs = command(root, 'bun', ['scripts/dev/cli.ts', 'stack:logs', '--profile', 'qa', '--run-id', projectRunId], 20_000);
          writeFileSync(join(logs, 'e2e-stack.log'), stackLogs.output);
        }
      } finally { reserved.release(); }
    }
    if (tier === 'integration' || tier === 'fault/recovery') await runStackTier(tier);
    if (tier === 'load') {
      const projectRunId = `${runId}-l`;
      const artifact = tierArtifactName(tier);
      const preparationStarted = Date.now();
      const remainingPreparation = () => Math.max(1,
        LOAD_PREPARATION_BUDGET_MS - (Date.now() - preparationStarted
          - admissionIntervalMs(admissionIntervals, preparationStarted, Date.now())));
      const selectedFiles = expandTestPaths(root,
        splitTestArgs(testArgs(tier, selection, chosen)).paths);
      const fixturePlan = loadFixturePlan(runId, selectedFiles, chosen?.id);
      startedProjects.push(projectRunId);
      const up = await startRunStack(['stack:up', '--profile', 'qa', '--run-id', projectRunId], 180_000);
      if (!up.ok) { errors.push(`${tier} stack startup failed`); writeFileSync(join(logs, `${artifact}-stack.log`), up.output); tiers.push({ name: tier, status: 'failed' }); writeFileSync(join(directory, `${artifact}.xml`), xmlForCommand(tier, false, up.elapsedMs, up.output)); continue; }
      const stackDir = join(root, '.temp', 'stack', `rezics-qa-${projectRunId}`);
      const apps = readEnv(join(stackDir, 'apps.env'));
      const compose = readEnv(join(stackDir, 'compose.env'));
      const appsPath = join(stackDir, 'qa-apps.json');
      const composePath = join(stackDir, 'qa-compose.json');
      writeFileSync(appsPath, JSON.stringify(apps), { mode: 0o600 });
      writeFileSync(composePath, JSON.stringify(compose), { mode: 0o600 });
      const bootstrap = command(root, 'bun', ['scripts/qa/bootstrap.ts', appsPath, composePath],
        Math.min(180_000, remainingPreparation()));
      if (!bootstrap.ok) { errors.push(`${tier} shared bootstrap failed`); writeFileSync(join(logs, `${artifact}-bootstrap.log`), bootstrap.output); tiers.push({ name: tier, status: 'failed' }); writeFileSync(join(directory, `${artifact}.xml`), xmlForCommand(tier, false, bootstrap.elapsedMs, bootstrap.output)); continue; }
      const fixtureResults = await Promise.all(fixturePlan.map(async item => {
        startedFixtureProjects.push(item.runId);
        const result = await admit('other', () => commandAsync(root, 'bun', ['scripts/fixture/cli.ts', 'restore',
          '--fixture', LOAD_FIXTURE_ID, '--run-id', item.runId], remainingPreparation(), process.env, noteMemory, { runDeadline })).catch(error => ({
            ok: false, timedOut: true, elapsedMs: Date.now() - preparationStarted,
            output: error instanceof Error ? error.message : String(error),
          }));
        writeFileSync(join(logs, `${artifact}-restore-${item.caseId}.log`), result.output);
        return { ...item, ok: result.ok, elapsedMs: result.elapsedMs, timedOut: result.timedOut };
      }));
      const preparationWallMs = Date.now() - preparationStarted;
      const preparationAdmissionMs = admissionIntervalMs(admissionIntervals, preparationStarted, Date.now());
      const preparationMs = preparationWallMs - preparationAdmissionMs;
      writeFileSync(join(directory, `${artifact}-preparation.json`), JSON.stringify({
        deadlineMs: LOAD_PREPARATION_BUDGET_MS, elapsedMs: preparationMs,
        wallMs: preparationWallMs, admissionWaitMs: preparationAdmissionMs,
        stackUpMs: up.activeElapsedMs, bootstrapMs: bootstrap.elapsedMs,
        fixture: LOAD_FIXTURE_ID, copies: fixtureResults,
      }, null, 2));
      if (preparationMs > LOAD_PREPARATION_BUDGET_MS || fixtureResults.some(item => !item.ok)) {
        errors.push(`${tier} preparation failed or exceeded ${LOAD_PREPARATION_BUDGET_MS / 1000}s`);
        tiers.push({ name: tier, status: 'failed' });
        writeFileSync(join(directory, `${artifact}.xml`), xmlForCommand(tier, false, preparationMs,
          JSON.stringify(fixtureResults)));
        continue;
      }
      // docs/testing/test-harness.md#tiers-and-budgets: 5 min since the phase D probes.
      const budget = 300_000;
      const result = await commandAsync(root, 'bun', ['test', ...testArgs(tier, selection, chosen), '--reporter=junit',
        `--reporter-outfile=${join(directory, `${artifact}.xml`)}`], budget,
      { ...process.env, ...apps, REZICS_QA_RUN_ID: projectRunId,
        REZICS_S3_GATE_PROJECT: projectRunId,
        REZICS_QA_ARTIFACT_DIR: directory,
        ...Object.fromEntries(fixturePlan.map(item =>
          [`REZICS_QA_FIXTURE_${item.caseId}_RUN_ID`, item.runId])),
        TOXIPROXY_API_URL: `http://127.0.0.1:${compose.TOXIPROXY_API_PORT}`,
        TOXIPROXY_FUSEKI_URL: `http://127.0.0.1:${compose.TOXIPROXY_FUSEKI_PORT}/rezics/` }, noteMemory, { runDeadline });
      const ok = result.ok && result.activeElapsedMs <= budget;
      tiers.push({ name: tier, status: ok ? 'passed' : 'failed', elapsedMs: result.activeElapsedMs });
      if (!ok) {
        errors.push(`${tier} failed or exceeded ${budget / 1000}s`);
        writeFileSync(join(logs, `${artifact}.log`), result.output);
        const stackLogs = command(root, 'bun', ['scripts/dev/cli.ts', 'stack:logs', '--profile', 'qa', '--run-id', projectRunId], 20_000);
        writeFileSync(join(logs, `${artifact}-stack.log`), stackLogs.output);
      }
    }
  }
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error));
} finally {
  for (const registry of childStackRegistries) {
    errors.push(...(await resetChildStacks(registry)).map(error => `QA child stack cleanup failed: ${error}`));
  }
  if (!options.keep) for (const projectRunId of startedProjects) {
    const down = command(root, 'bun', ['scripts/dev/cli.ts', 'stack:reset', '--profile', 'qa', '--run-id', projectRunId], 120_000);
    if (!down.ok) { errors.push(`QA stack cleanup failed: ${projectRunId}`); writeFileSync(join(logs, `${projectRunId}-cleanup.log`), down.output); }
  }
  // Restored fixture copies hold large persistent volumes; removing one took over
  // 120 s in record run 20260927t054833-96d374, so the copies reset concurrently.
  if (!options.keep) {
    const resets = await Promise.all(startedFixtureProjects.map(async projectRunId => ({ projectRunId,
      down: await commandAsync(root, 'bun', ['scripts/dev/cli.ts', 'stack:reset', '--profile', 'qa',
        '--run-id', projectRunId, '--persistent',
        ...(rawUpdateProjects.has(projectRunId) ? ['--raw-update'] : [])], 300_000) })));
    for (const { projectRunId, down } of resets) {
      if (!down.ok) { errors.push(`Fixture stack cleanup failed: ${projectRunId}`);
        writeFileSync(join(logs, `${projectRunId}-cleanup.log`), down.output); }
    }
  }
  try {
    const sourceAfter = sourceIdentity(root);
    if (sourceAfter.fingerprint !== sourceBefore.fingerprint) errors.push('Source changed during QA run');
    for (const tier of uncoveredTiers) tiers.push({ name: tier, status: 'uncovered' });
    const tests = junitResults(directory, selected.filter(tier => tier === 'unit' || tier === 'owner' || tier === 'integration'
      || tier === 'model' || tier === 'fault/recovery' || tier === 'e2e' || tier === 'load'));
    if (selection) {
      for (const expected of selection.tests) {
        if (
          !tests.some(
            (actual) =>
              actual.tier === expected.tier && actual.file === expected.file &&
              (expected.name === UNEXECUTED_FILE_TEST
                ? actual.name !== UNEXECUTED_FILE_TEST && !actual.skipped
                : actual.name === expected.name),
          )
        )
          errors.push(`Selected test was not executed: ${expected.file}: ${expected.name}`);
      }
    }
    writeSummary(directory, { runId, sourceBefore, sourceAfter, tiers, isolation,
      partial: Boolean(options.tier || selection || options.files || options.id), errors, cases, tests,
      diagnosticOf: selection?.sourceRunId, retiredTests: selection?.retiredTests, caseCoverage,
      scope: options.backend ? 'backend' : 'all', excludedCases: backendSelection?.excluded,
      inventoryFingerprint: backendSelection?.inventoryFingerprint });
    noteBrowserPlan(directory);
    if (options.record && errors.length === 0) {
      const record = JSON.parse(readFileSync(join(directory, 'acceptance.json'), 'utf8')) as QualificationRecord;
      if (record.certifiesFull) {
        writeFileSync(join(directory, 'qualification.md'), renderQualification(record));
      } else {
        console.error('--record did not certify every retained acceptance ID; no qualification artifact written');
        process.exitCode = 1;
      }
    }
  } finally {
    runSlots?.release();
    release();
  }
  console.log(readFileSync(join(directory, 'summary.md'), 'utf8'));
  console.log(`QA artifacts: ${directory}`);
  if (errors.length) process.exitCode = 1;
}
