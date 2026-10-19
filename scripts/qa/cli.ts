import { qaFailure, recordQaFailure, testFailureClass, type FailureClass } from './failure.ts';
import { randomUUID } from 'node:crypto';
import { createOwnerErasureCleanupClock, ownerErasureCleanupShard } from './owner-erasure-cleanup.ts';
import { assertRetainedSources } from './retained-preflight.ts';
import { independentRestorePreparationOptions, ownerErasurePreparationOptions } from './retained-source.ts';
import { realmSourceBuildDeadlineMs } from '../../tests/qa/support/realm-discussion-budget.ts';
import { activeTestWallMs } from './test-wall.ts';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { redactCommandOutput } from '../fixture/command-output.ts';
import {
  acquireFullLock,
  acquireQaSlots, configuredQaSlots,
  admissionIntervalMs,
  artifactRoots,
  backendTiers,
  command,
  commandAsync,
  concurrencyGate,
  qaRunDeadline,
  qaWaitFailure,
  estimatedDurations,
  expandTestPaths,
  faultRecoveryBaselineDurations,
  formatTierRunLine,
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
  qaArtifactDirectory,
  planStackProjects,
  recordedFileDurations,
  selfManagedFaultFiles,
  selfManagedFaultAdmission,
  serialRestoreDrillFiles,
  shardCount,
  stackPlanBudgetWarning,
  shardResolved,
  sourceIdentity,
  splitTestArgs,
  tierArtifactName,
  tierBunTestArgs,
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
  selectedTestExecuted,
  testArgs,
  unitHarnessFiles,
} from './acceptance.ts';
import { selectBackendCases } from './backend-scope.ts';
import { declaredCaseCoverage, missingCaseDeclarations, renderQualification,
  type QualificationRecord } from './coverage.ts';
import { readEnv, replacePrivate } from '../dev/config.ts';
import { fusekiBuildInputs } from '../dev/fuseki-image.ts';
import { preserveReapEnvironment } from './container-reaper.ts';
import { stageQaBootstrap } from './bootstrap.ts';
import { browserBudgets, browserFileCounts, browserProjectCount, e2eBrowserPlan } from './browser-budget.ts';
import { qaMemoryDeadline, qaMemoryNeed, type StartupSlotGate } from './memory-admission.ts';
import { admitIntegrationWorkScope, runQaStartupChildAsync } from './stack-startup.ts';
import { allocateWebPort, measuredBrowserStep, runPreparedJourneys, startBrowserStack, webOrigin,
  type BrowserStack, type BrowserStepResult, type JourneyPreparationFailure } from './e2e.ts';
import { discoverJourneyPreparations, preparationBudgetMs, selectJourneyPreparations } from './e2e-preparation.ts';
import { cleanupQaStacks, forgetQaStack, QA_STACK_REGISTRY, QA_STACK_TIER } from './stack-ownership.ts';
import { commandOnlyIntegrationFiles } from './isolated-integration-files.ts';
import {
  integrationBudgetSummary, integrationOverBudgetFiles, integrationStackPoolEligible, integrationTierWallMs, planIntegrationShards,
  runQueuedProjects,
} from './integration-shards.ts';
import { completeFileResults, lastStartedTestFile } from './file-results.ts';
import { filesKeptAfterResetFailure, integrationResetHarnessFailure } from './integration-reset.ts';
import { exclusiveWorkScopeAssembler, integrationStackAdmitsWorkScope, qaStackEnvironment, qaStackMode } from './stack-environment.ts';

import { ownerTierBudgetMs } from './owner-tier-budget.ts';
import { assertQaResourceAllocation, integrationResourceClass, qaResourceClasses, queuedProjectsBudget } from './resource-classes.ts';
import { exclusivePreparationWallMs, needsRealmDiscussionSource, preparationTestFiles, restoreDrillSchedule, smallRecoveryFixtureConsumers, WORK_PROFILE_SEED_BUILD_FILE } from './preparation-selection.ts';
import {
  campaignCommandAccepted, campaignPhaseDeadline, campaignQualificationShard, campaignShardActiveMs,
  childStackCleanupCommand, currentSuppliedRunIds, openCampaignEvidence,
  type CampaignEvidenceRead, type CommandPhaseSample,
} from './campaign-envelope.ts';
import { createQaStackPool, destroyHeldQaStacks, qaStackFingerprint, qaStackPoolEnabled } from './stack-pool.ts';

const root = resolve(import.meta.dir, '../..');
const options = parseArgs(process.argv.slice(2));
const runId = newRunId();
const directory = join(qaArtifactDirectory(root), runId);
const logs = join(directory, 'logs');
mkdirSync(logs, { recursive: true });
const sourceBefore = sourceIdentity(root);
const tiers: { name: Tier; status: 'passed' | 'failed' | 'uncovered'; elapsedMs?: number; shards?: ShardRecord[] }[] = [];
const isolation: IsolationRecord[] = [];
const errors: string[] = [];
let firstFailure: FailureClass | undefined;
const tierFailures = new Map<Tier, FailureClass>();
function noteFailure(failureClass: FailureClass, tier?: Tier): void {
  firstFailure ??= failureClass;
  if (tier && !tierFailures.has(tier)) tierFailures.set(tier, failureClass);
  recordQaFailure(failureClass, '');
}
function fail(message: string, failureClass: FailureClass = 'harness', tier?: Tier): void {
  noteFailure(failureClass, tier);
  errors.push(`${failureClass}: ${message}`);
}
function testFailure(result: { timedOut?: boolean; output?: string }, tier: Tier): FailureClass {
  const xml = join(directory, `${tierArtifactName(tier)}.xml`);
  return testFailureClass(result, existsSync(xml) ? parseJUnit(readFileSync(xml, 'utf8'), tier) : []);
}
const integrationBudgetNotes: string[] = [];
const stackLeaseNotes: string[] = [];
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
// Explicit tiers keep the files named for them. An owner file stays out of the unit
// command, and each stack tier starts only its own projects.
const tierGroups = options.groups ?? (options.tier ? [{ tier: options.tier,
  ...(options.files ? { files: options.files } : {}), ...(options.id ? { id: options.id } : {}) }] : undefined);
const selected = selection?.tiers ?? (tierGroups ? tierGroups.map(group => group.tier)
  : options.backend ? backendTiers : implementedTiers);
function chosenFor(tier: Tier): { files?: string[]; id?: string } | undefined {
  const group = tierGroups?.find(item => item.tier === tier);
  if (!group || (!group.files?.length && !group.id)) return undefined;
  return { files: group.files, id: group.id };
}
const admissionDeadline = qaMemoryDeadline(process.env, Date.now() + 6 * 3_600_000);
const runDeadline = qaRunDeadline(admissionDeadline);
const finishInitialWait = runDeadline.wait();
process.env.REZICS_QA_MEMORY_DEADLINE = String(admissionDeadline);
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
    deadline: admissionDeadline,
    announce: noteMemory,
    onAdmissionWait: ms => { const end = Date.now(); admissionIntervals.push({ start: end - ms, end }); },
  }, work, runDeadline);
}
let runSlots: Awaited<ReturnType<typeof acquireQaSlots>> | undefined;
const qaSlotDirectory = process.env.GOAL_QA_SLOT_DIRECTORY ?? goalSlotDirectory(root);
// Direct task runs and their startup children publish into the same status directory as goalctl.
if (qaSlotDirectory) process.env.GOAL_QA_WAIT_DIR ??= join(qaSlotDirectory, 'waiters');
process.env.GOAL_QA_COMMAND ??= ['bun', ...process.argv.slice(1)].join(' ');
const heavyQaRun = process.env.GOAL_QA_HEAVY_RUN === '1';
let releaseDeferredHeavy: (() => void) | undefined;
let deferredHeavyUsers = 0;
const stackPool = createQaStackPool({ root, slotDirectory: qaSlotDirectory,
  slots: configuredQaSlots(qaSlotDirectory) });

async function integrationInfrastructureFingerprint(environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  // Schemas and graph seeds are planned from imported code. Whole source trees
  // deliberately prefer an extra startup to reusing a different bootstrap result.
  const paths = [...new Set(['infra/dev/compose.yaml', 'infra/dev/compose.qa.yaml', 'infra/dev/compose.qa-resources.yaml',
    'infra/dev/postgres/00-owners.sh', 'services/account/package.json', 'yarn.lock',
    ...['scripts/**/*', 'services/*/src/**/*', 'packages/*/src/**/*', 'generated/**/*',
      '{package.json,.yarnrc.yml,bunfig.toml,tsconfig*.json}',
      '{services,packages}/*/{package.json,bunfig.toml,tsconfig*.json}'].flatMap(pattern =>
      [...new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true, dot: true })]),
    ...fusekiBuildInputs(root),
    ...new Bun.Glob('infra/jena/fuseki-text*.ttl').scanSync({ cwd: root }),
    ...new Bun.Glob('services/{main,account,content}/migrations/**/*.sql').scanSync({ cwd: root })])];
  const files = paths.sort().map(path => [path, readFileSync(join(root, path)).toString('base64')] as [string, string]);
  const compose = readFileSync(join(root, 'infra/dev/compose.yaml'), 'utf8');
  const images = [...compose.matchAll(/^  (?:postgres|fuseki|rustfs|mailpit):\n    image: (\S+)$/gm)].map(match => match[1]!);
  const inspected = await commandAsync(root, 'docker', ['image', 'inspect', '--format', '{{.Id}}', ...images],
    10_000, preserveReapEnvironment(environment));
  if (!inspected.ok) {
    // An empty host or a changed image pin needs ordinary startup to pull/build it.
    if (/\bNo such (?:image|object)\b/i.test(inspected.output)) return undefined;
    throw new Error(`Cannot fingerprint QA images: ${inspected.output}`);
  }
  const settings = Object.fromEntries(Object.entries(environment).filter(([key, value]) => value !== undefined
    && /^REZICS_(?:FUSEKI|POSTGRES|RUSTFS|MAILPIT|QA_STACK_MODE)/.test(key))) as Record<string, string>;
  return qaStackFingerprint({ files, images: inspected.output.trim().split('\n'),
    assembler: environment.REZICS_FUSEKI_ASSEMBLER ?? '/fuseki/fuseki-text-qa.ttl', environment: settings });
}
async function acquireRunSlots(wanted: number, slotOptions: Parameters<typeof acquireQaSlots>[4] = {}) {
  const waitStarted = Date.now();
  let waitPath: string | undefined;
  const removeWait = () => { if (waitPath) rmSync(waitPath, { force: true }); };
  process.on('exit', removeWait);
  try {
    if (heavyQaRun && process.env.GOAL_QA_DEFERRED_HEAVY === '1' && !releaseDeferredHeavy) {
      const { acquireHeavy } = await import('../goal/qa-slots.ts');
      const started = Date.now();
      const resume = runDeadline.wait();
      try {
        releaseDeferredHeavy = await acquireHeavy([process.env.GOAL_QA_COMMAND ?? 'QA'], {
          lockDir: process.env.GOAL_QA_HEAVY_LOCK, lifecycleLockDir: process.env.GOAL_QA_LIFECYCLE_LOCK,
          waitForWorkers: process.env.GOAL_QA_WIDE_RUN === '1',
          besideWorkers: process.env.GOAL_QA_BESIDE_WORKERS === '1',
          goal: process.env.GOAL_ID, deadline: admissionDeadline, signal: slotOptions.signal,
          arrivedAt: Number(process.env.GOAL_QA_ARRIVED_AT_MS) || undefined,
          now: slotOptions.now, sleep: slotOptions.sleep, announce: slotOptions.announce,
          bindExit: false,
        });
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('The heavy QA lock stayed held'))
          throw new Error(`No QA slot became free before the deadline; ${qaWaitFailure('the heavy QA turn', started, Date.now())}`);
        throw error;
      } finally { resume(); }
    }
    const lease = await acquireQaSlots(heavyQaRun ? undefined : qaSlotDirectory, wanted, process.env, process.pid, {
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
    finishInitialWait();
    if (releaseDeferredHeavy) {
      deferredHeavyUsers++;
      const release = lease.release;
      let released = false;
      lease.release = () => {
        if (released) return;
        released = true;
        release();
        if (--deferredHeavyUsers === 0) { releaseDeferredHeavy?.(); releaseDeferredHeavy = undefined; }
      };
    }
    return lease;
  } finally {
    admissionIntervals.push({ start: waitStarted, end: Date.now() });
    removeWait();
    process.off('exit', removeWait);
  }
}
// The child measures before the short admission transaction; the runner owns the slot through cleanup.
async function withStartupSlot<T>(env: NodeJS.ProcessEnv,
  start: (environment: NodeJS.ProcessEnv, onLine: (line: string) => void) => Promise<T>,
  reserve: (slotOptions: Parameters<typeof acquireQaSlots>[4]) => Promise<(() => void) | void>): Promise<T> {
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
  const admissions: Promise<void>[] = [];
  const controllers = new Map<string, AbortController>();
  const requests = new Set<string>();
  const cancellations = new Set<string>();
  const grants = new Map<string, () => void>();
  const admissionWaits = new Map<string, () => void>();
  try {
    return await start({ ...env, REZICS_QA_STARTUP_SLOT_GATE: gatePath }, line => {
      const cancellation = /^QA_STARTUP_SLOT_CANCEL (\S+) (\S+) (\d+)$/.exec(line);
      if (cancellation?.[1] === token) {
        const key = `${cancellation[2]}:${cancellation[3]}`;
        cancellations.add(key);
        controllers.get(key)?.abort();
        removeWait();
        grants.get(key)?.();
        grants.delete(key);
        return;
      }
      const request = /^QA_STARTUP_SLOT_READY (\S+) (\S+) (\d+)$/.exec(line);
      if (request?.[1] === token) {
        const requester = request[2]!;
        const sequence = Number(request[3]);
        const key = `${requester}:${sequence}`;
        // Intermediate runners can replay captured output after streaming the same request.
        if (requests.has(key)) return;
        requests.add(key);
        // A busy slot means retrying memory + startup admission, never holding a stale reading.
        const controller = new AbortController(); controllers.set(key, controller);
        const admission = reserve({ deadline: Date.now(), runDeadline, signal: controller.signal }).then(release => {
          if (cancellations.has(key)) { release?.(); return; }
          if (release) grants.set(key, release);
          removeWait();
          publish('granted', requester, sequence);
        }, error => {
          if (cancellations.has(key)) return;
          const message = error instanceof Error ? error.message : String(error);
          if (!message.startsWith('No QA slot became free before the deadline')) {
            publish('failed', requester, sequence, message);
            return;
          }
          if (waitPath) {
            mkdirSync(waiterDirectory!, { recursive: true });
            writeFileSync(waitPath, JSON.stringify({ pid: process.pid, goal: env.GOAL_ID,
              command: env.GOAL_QA_COMMAND, waitingFor: 'slot',
              message: 'Waiting for a QA slot after memory admission', since: env.GOAL_QA_ARRIVED_AT ?? new Date().toISOString() }));
          }
          publish('retry', requester, sequence);
        });
        admissions.push(admission);
      } else {
        const event = /^QA_MEMORY_WAIT_(BEGIN|END) (\d+-\d+)(?: (\d+))?$/.exec(line);
        if (event?.[1] === 'BEGIN' && !admissionWaits.has(event[2]!)) admissionWaits.set(event[2]!, runDeadline.wait());
        if (event?.[1] === 'END') { admissionWaits.get(event[2]!)?.(); admissionWaits.delete(event[2]!); }
        if (line.startsWith('Waiting; QA memory:') || line.startsWith('Waiting for another QA startup;')) removeWait();
        noteMemory(line);
      }
    });
  } finally {
    try {
      for (const [key, controller] of controllers) { cancellations.add(key); controller.abort(); }
      await Promise.allSettled(admissions);
    }
    finally {
      removeGate();
      for (const resume of admissionWaits.values()) resume();
      process.off('exit', removeGate);
    }
  }
}

type ReserveQaSlot = (options: Parameters<typeof acquireQaSlots>[4]) => Promise<(() => void) | void>;

async function reserveRunSlot(slotOptions: Parameters<typeof acquireQaSlots>[4]): Promise<() => void> {
  runSlots ??= await acquireRunSlots(1, slotOptions);
  const lease = runSlots;
  return () => { if (runSlots === lease) { lease.release(); runSlots = undefined; } };
}

/** Finished host work and stopped fixture sources must not reserve capacity for later startups. */
async function withWorkSlot<T>(work: (reserve: ReserveQaSlot) => Promise<T>): Promise<T> {
  let slots: Awaited<ReturnType<typeof acquireQaSlots>> | undefined;
  try {
    return await work(async slotOptions => {
      // An earlier live stack retains its lease through the run's final cleanup.
      if (runSlots) return;
      slots ??= await acquireRunSlots(1, slotOptions);
      const lease = slots;
      return () => { if (slots === lease) { lease.release(); slots = undefined; } };
    });
  } finally { slots?.release(); }
}

/** Host-only tiers also own a lease, but retries never hold one through admission. */
async function admitRun<T>(work: () => Promise<T>, env: NodeJS.ProcessEnv = process.env,
  reserve?: ReserveQaSlot): Promise<T> {
  if (!reserve) return withWorkSlot(reserveWork => admitRun(work, env, reserveWork));
  const started = Date.now();
  for (;;) {
    try {
      return await admit('other', async () => {
        await reserve({ deadline: Date.now(), runDeadline });
        return work();
      }, env);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('No QA slot became free before the deadline')) throw error;
      if (Date.now() >= admissionDeadline) throw new Error(qaWaitFailure('a QA slot', started, Date.now()));
      const resume = runDeadline.wait();
      const waitStarted = Date.now();
      try { await Bun.sleep(Math.min(3_000, admissionDeadline - Date.now())); }
      finally { admissionIntervals.push({ start: waitStarted, end: Date.now() }); resume(); }
    }
  }
}

async function startRunStack(args: string[], budget: number, env: NodeJS.ProcessEnv = process.env,
  reserve: ReserveQaSlot = reserveRunSlot) {
  return withStartupSlot({ ...env, REZICS_QA_RUN_REMAINING_MS: String(Math.ceil(runDeadline.activeRemainingMs())) },
    (environment, onLine) => runQaStartupChildAsync(root, args, budget, environment, onLine), reserve);
}

const release = options.tier || options.groups || options.onlyFailed ? () => {} : acquireFullLock(root, runId);

function campaignEvidenceRead(projectRunId: string, sample: CommandPhaseSample): CampaignEvidenceRead {
  const evidencePath = join(directory, 'erasure-campaign-qualification.json');
  const observedAt = sample.observedAt;
  const commandStartedAt = sample.commandStartedAt;
  if (!existsSync(evidencePath)) {
    return {
      parsed: undefined, readError: false, modifiedAt: commandStartedAt, commandStartedAt,
      projectRunId, activeElapsedMs: sample.activeElapsedMs, observedAt, admission: sample.admission,
    };
  }
  let parsed: unknown, readError = false;
  try { parsed = JSON.parse(readFileSync(evidencePath, 'utf8')); }
  catch { readError = true; }
  return {
    parsed, readError, modifiedAt: statSync(evidencePath).mtimeMs, commandStartedAt,
    projectRunId, activeElapsedMs: sample.activeElapsedMs, observedAt, admission: sample.admission,
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
    fail(`${name} failed (budget ${budget / 1000}s; see logs/${name}.log)`,
      qaFailure({ ...result, timedOut: result.timedOut || result.elapsedMs > budget }, name === 'static' ? 'harness' : 'test', name !== 'static' && testFailure(result, name) === 'assertion'), name);
  }
  return ok;
}

type StackTier = 'integration' | 'fault/recovery';
interface ShardRun { record: ShardRecord; xml?: string; timedOut: boolean; noMatch: boolean;
  ok: boolean; testStart?: number; testEnd?: number; resetBlockedFiles?: string[] }

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
    fail(`${name} failed (budget ${budget / 1000}s; see logs/${name}.log)`,
      testFailure({ ...result, timedOut: result.timedOut || result.activeElapsedMs > budget }, name), name);
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
        if (runSlots && !runSlotInUse) {
          runSlotInUse = usesRunSlot = true;
          return () => { runSlots?.release(); runSlots = undefined; runSlotInUse = usesRunSlot = false; };
        }
        slots ??= await acquireRunSlots(1, { ...slotOptions, inherit: false });
        const lease = slots;
        return () => { if (slots === lease) { lease.release(); slots = undefined; } };
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
  reserve: (slotOptions: Parameters<typeof acquireQaSlots>[4]) => Promise<(() => void) | void> = reserveRunSlot,
): Promise<ShardRun> {
  const preparationStartedAt = Date.now();
  const shardProjectRunId = projectRunId;
  const label = `${tierArtifactName(tier)}-${projectRunId.slice(runId.length + 1)}`;
  const seedBuild = tier === 'fault/recovery' && files.length === 1 && files[0] === WORK_PROFILE_SEED_BUILD_FILE;
  const resourceClass = tier === 'integration' || seedBuild ? integrationResourceClass(files) : undefined;
  if (resourceClass && !seedBuild) budget = qaResourceClasses[resourceClass].budgetMs;
  const environment = qaStackEnvironment({
    ...process.env,
    ...(tier === 'fault/recovery' ? faultFixtureEnvironment : {}),
    ...(tier === 'fault/recovery' ? {
      REZICS_FIXTURE_ROOT: process.env.REZICS_FIXTURE_ROOT ?? join(root, '.temp', 'fixture'),
    } : {}),
  }, resourceClass && resourceClass !== 'ordinary' ? qaResourceClasses[resourceClass].storage : undefined, resourceClass);
  const needsStack = tier !== 'fault/recovery' || !files.every(file => selfManagedFaultFiles.has(file));
  const startupProtocol = !needsStack && files.every(file => selfManagedFaultAdmission.get(file) === 'startup');
  const persistent = qaStackMode(environment) === 'scale'
    || files.some(file => commandOnlyIntegrationFiles.has(file));
  // Scale changes storage, not a fixture's endpoints. Product-only native
  // qualification keeps its closed raw-update endpoint in every storage mode.
  const rawUpdate = persistent && !files.some(file => commandOnlyIntegrationFiles.has(file));
  if (rawUpdate) rawUpdateProjects.add(projectRunId);
  // Only integration stacks need the derived raw-SPARQL classification; keep that scan behind tier selection.
  const admitsWorkScope = tier === 'integration' && integrationStackAdmitsWorkScope(files, rawUpdate);
  if (admitsWorkScope) environment.REZICS_FUSEKI_ASSEMBLER = exclusiveWorkScopeAssembler;
  let lease: Awaited<ReturnType<typeof stackPool.acquire>> = undefined;
  let leased = false;
  const poolEligible = integrationStackPoolEligible({ tier, files,
    keep: options.keep, backend: options.backend, persistent }) && !isolated;
  let poolFingerprint: string | undefined;
  const notePool = (outcome: string) => {
    const note = `- Integration shard ${shardProjectRunId} ${outcome}.`;
    stackLeaseNotes.push(note);
    // A deadline or SIGKILL can prevent the final summary from being written.
    appendFileSync(join(directory, 'summary.md'), `${note}\n`);
  };
  if (qaStackPoolEnabled(qaSlotDirectory) && poolEligible) {
    const fingerprint = await integrationInfrastructureFingerprint(environment);
    // A warm stack needs host work admission, but no new-container startup turn.
    const rejectionCount = stackPool.rejections.length;
    if (fingerprint !== undefined)
      lease = await admitRun(() => stackPool.acquire(fingerprint), environment, reserve);
    for (const rejection of stackPool.rejections.slice(rejectionCount)) {
      const note = `- Integration shard ${shardProjectRunId} pool miss: rezics-qa-${rejection.projectRunId} destroyed; ${rejection.scope}.${rejection.key}=${redactCommandOutput(rejection.value)} (${rejection.reason}).`;
      stackLeaseNotes.push(note);
      appendFileSync(join(directory, 'summary.md'), `${note}\n`);
    }
    if (lease) {
      leased = true;
      projectRunId = lease.entry.projectRunId;
      notePool(`leased from rezics-qa-${projectRunId}, parked for ${lease.parkedMs} ms`);
      const stackDir = join(root, '.temp', 'stack', `rezics-qa-${projectRunId}`);
      mkdirSync(stackDir, { recursive: true, mode: 0o700 });
      replacePrivate(join(stackDir, 'apps.env'), lease.entry.apps);
      replacePrivate(join(stackDir, 'compose.env'), lease.entry.compose);
    } else {
      // A known cold miss must not invalidate matching stacks parked by other shards.
      lease = await stackPool.register(projectRunId, fingerprint);
    }
  }
  // Pool ownership replaces runner ancestry for these containers. Test-created
  // containers still inherit the runner's reaper and are removed at test exit.
  const startupEnvironment = lease ? { ...environment, REZICS_REAP_OWNER: '', REZICS_REAP_SCOPE: '',
    REZICS_REAP_SCOPES: '', REZICS_REAP_STATE: '', REZICS_QA_POOL_STARTUP_PROJECT: projectRunId } : environment;
  const stackArgs = ['--profile', 'qa', '--run-id', projectRunId,
    ...(persistent ? ['--persistent'] : []), ...(rawUpdate ? ['--raw-update'] : [])];
  const started = persistent ? startedFixtureProjects : startedProjects;
  const record: ShardRecord = { project: shardProjectRunId, files, status: 'failed', stage: 'stack',
    budgetMs: budget,
    ...(isolated ? { isolation: true } : {}),
    ...(resourceClass ? { resourceClass } : {}) };
  const finish = async (run: Omit<ShardRun, 'record'>): Promise<ShardRun> => {
    if (!run.ok) {
      record.failureClass ??= qaFailure({ timedOut: run.timedOut, output: run.xml },
        record.stage === 'test' ? 'harness' : 'environment');
      noteFailure(record.failureClass, tier);
      if (record.stage !== 'test') record.fileFailures = Object.fromEntries(files.map(file => [file, record.failureClass!]));
      else for (const file of record.missingFiles ?? []) (record.fileFailures ??= {})[file] ??= run.timedOut ? 'timeout' : 'harness';
    }
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
      const cleanupStarted = Date.now();
      let parked = false;
      let destroyedReason = !run.ok || record.stage !== 'test' ? 'failed'
        : !qaStackPoolEnabled(qaSlotDirectory) ? 'switch off' : 'capacity';
      if (lease && run.ok && record.stage === 'test') {
        const stackDir = join(root, '.temp', 'stack', `rezics-qa-${projectRunId}`);
        const reset = await commandAsync(root, 'bun', ['scripts/qa/integration-reset.ts',
          join(stackDir, 'apps.env'), join(stackDir, 'compose.env'), '--release'], 180_000, environment, noteMemory, { runDeadline });
        if (reset.ok) {
          parked = await lease.park(readEnv(join(stackDir, 'apps.env')), readEnv(join(stackDir, 'compose.env')));
          destroyedReason = !qaStackPoolEnabled(qaSlotDirectory) ? 'switch off'
            : !leased && poolFingerprint === undefined ? 'fingerprint unavailable after startup' : 'capacity';
        }
        else {
          destroyedReason = 'reset failed';
          run.ok = false;
          record.failureClass ??= qaFailure(reset, 'harness');
          fail(`integration pool reset failed: ${projectRunId} (see logs/${label}-reset.log)`, record.failureClass, tier);
          writeFileSync(join(logs, `${label}-reset.log`), reset.output);
        }
      }
      if (lease) {
        if (!parked) await lease.destroy();
        started.splice(started.indexOf(projectRunId), 1);
      } else {
        const down = await commandAsync(root, 'bun', ['scripts/dev/cli.ts', 'stack:reset', ...stackArgs], 120_000, environment);
        if (down.ok) started.splice(started.indexOf(projectRunId), 1);
      }
      record.cleanupMs = Date.now() - cleanupStarted;
      if (tier === 'integration' && !leased && poolEligible)
        notePool(parked ? 'started and parked' : `started and destroyed (${destroyedReason})`);
    }
    if (tier === 'integration' && !poolEligible) notePool('not eligible');
    record.status = run.ok ? 'passed' : 'failed';
    return { record, ...run };
  };
  let apps: Record<string, string> = {};
  let compose: Record<string, string> = {};
  if (needsStack) {
    started.push(projectRunId);
    const upCommand = () => startRunStack(['stack:up', ...stackArgs], 180_000, {
      ...startupEnvironment, [QA_STACK_TIER]: tier,
    }, reserve);
    const up = leased ? { ok: true, timedOut: false, elapsedMs: 0, activeElapsedMs: 0, output: '' }
      : await (startStack ? startStack(upCommand) : upCommand()).catch(error => ({
      ok: false, timedOut: true, elapsedMs: Date.now() - preparationStartedAt,
      output: redactCommandOutput(error instanceof Error ? error.message : String(error)),
    }));
    record.startupMs = 'activeElapsedMs' in up ? up.activeElapsedMs : 0;
    if (!up.ok) {
      writeFileSync(join(logs, `${label}-startup.log`), up.output);
      fail(`${tier} stack startup failed: ${projectRunId} (see logs/${label}-startup.log)`, qaFailure(up, 'environment'), tier);
      return finish({ ok: false, timedOut: up.timedOut, noMatch: false,
        xml: xmlForCommand(tier, false, up.elapsedMs, up.output) });
    }
    if (lease && !leased) {
      // Startup may pull or rebuild images. Only its resolved images qualify a parked stack.
      poolFingerprint = await integrationInfrastructureFingerprint(environment);
      await lease.recordFingerprint(poolFingerprint);
    }
    if (resourceClass) {
      const inspected = await commandAsync(root, 'docker', ['inspect', '--format',
        '{"memory":{{.HostConfig.Memory}},"tmpfs":{{json .HostConfig.Tmpfs}},"mounts":{{json .Mounts}}}',
        `rezics-qa-${projectRunId}-fuseki-1`], 10_000, preserveReapEnvironment(process.env));
      let failure = inspected.ok ? '' : 'Could not inspect QA Fuseki allocation';
      if (inspected.ok) {
        // Command-only files start a persistent stack in test mode too.
        // Check the storage stack:up was asked for.
        try { assertQaResourceAllocation(resourceClass, JSON.parse(inspected.output),
          persistent ? 'scale' : 'test'); }
        catch (error) { failure = redactCommandOutput(error instanceof Error ? error.message : 'Invalid QA Fuseki allocation'); }
      }
      if (failure) {
        writeFileSync(join(logs, `${label}-allocation.log`), failure);
        fail(`${tier} allocation failed: ${projectRunId} (see logs/${label}-allocation.log)`, qaFailure(inspected, 'environment'), tier);
        return finish({ ok: false, timedOut: inspected.timedOut, noMatch: false,
          xml: xmlForCommand(tier, false, inspected.elapsedMs, failure) });
      }
    }
    const stackDir = join(root, '.temp', 'stack', `rezics-qa-${projectRunId}`);
    const staged = stageQaBootstrap(stackDir);
    apps = staged.apps;
    compose = readEnv(join(stackDir, 'compose.env'));
    record.stage = 'bootstrap';
    const bootstrap = leased ? { ok: true, timedOut: false, elapsedMs: 0, output: '' }
      : await commandAsync(root, 'bun', staged.args, 180_000, environment);
    record.bootstrapMs = bootstrap.elapsedMs;
    if (!bootstrap.ok) {
      fail(`${tier} shared bootstrap failed: ${projectRunId} (see logs/${label}-bootstrap.log)`, qaFailure(bootstrap, 'environment'), tier);
      writeFileSync(join(logs, `${label}-bootstrap.log`), bootstrap.output);
      return finish({ ok: false, timedOut: bootstrap.timedOut, noMatch: false,
        xml: xmlForCommand(tier, false, bootstrap.elapsedMs, bootstrap.output) });
    }
    // Bootstrap stores the text generation after Fuseki has started. The writer
    // is admitted in that process; this pages the directory Main left unfinished.
    if (admitsWorkScope) {
      try {
        await admitIntegrationWorkScope({
          root, projectRunId, fusekiUrl: apps.FUSEKI_URL!, maintenanceToken: apps.FUSEKI_MAINTENANCE_TOKEN,
          environment,
        });
      } catch (error) {
        const message = redactCommandOutput(error instanceof Error ? error.message : String(error));
        fail(`${tier} exclusive writer startup failed: ${projectRunId}`, 'environment', tier);
        writeFileSync(join(logs, `${label}-startup.log`), message);
        return finish({ ok: false, timedOut: false, noMatch: false,
          xml: xmlForCommand(tier, false, Date.now() - preparationStartedAt, message) });
      }
    }
  }
  if (!needsStack) {
    try {
      if (startupProtocol) await admit('other', async () => {}, environment);
      else await admitRun(async () => {}, environment, reserve);
    } catch (error) {
      const message = redactCommandOutput(error instanceof Error ? error.message : String(error));
      fail(message, 'timeout', tier);
      return finish({ ok: false, timedOut: true, noMatch: false,
        xml: xmlForCommand(tier, false, Date.now() - preparationStartedAt, message) });
    }
  }
  // Verify retained custody before the operation-file clock, without running its producer.
  // Each shard selects the same keyed source and restores only an isolated consumer.
  if (tier === 'fault/recovery') {
    for (const file of files) {
      const selected = independentRestorePreparationOptions(file);
      if (!selected) continue;
      const evidence = join(directory, `independent-source-${label}.json`);
      const prepared = await commandAsync(root, 'bun', [
        'tests/qa/fault-recovery/independent-restore-support.ts', '--prepare-retained-source', '--retained-only', '--evidence', evidence,
        ...(selected.withRecipe ? ['--recipe'] : []),
      ], 600_000, { ...environment, ...apps, REZICS_FIXTURE_ROOT: environment.REZICS_FIXTURE_ROOT ?? join(process.env.REZICS_QA_RETAINED_ROOT ?? root, '.temp', 'fixture'),
        REZICS_QA_RUN_ID: projectRunId, REZICS_QA_ARTIFACT_DIR: directory }, noteMemory, { runDeadline });
      writeFileSync(join(logs, `${label}-independent-source.log`), prepared.output);
      writeFileSync(join(directory, `independent-selection-${label}.json`), JSON.stringify({
        deadlineMs: 600_000, activeElapsedMs: prepared.activeElapsedMs,
        admissionWaitMs: prepared.admissionWaitMs, ok: prepared.ok,
      }));
      if (!prepared.ok) {
        fail(`independent source selection failed before operation clock (${label})`, qaFailure(prepared, 'environment'), tier);
        return finish({ ok: false, timedOut: prepared.timedOut, noMatch: false,
          xml: xmlForCommand(tier, false, prepared.activeElapsedMs, prepared.output) });
      }
      const report = JSON.parse(readFileSync(evidence, 'utf8')) as { manifest: { key: string } };
      if (environment.INDEPENDENT_RESTORE_SOURCE_KEY !== undefined
        && environment.INDEPENDENT_RESTORE_SOURCE_KEY !== report.manifest.key)
        throw new Error('supplied independent source key is incompatible');
      environment.INDEPENDENT_RESTORE_SOURCE_KEY = report.manifest.key;
      environment.REZICS_FIXTURE_ROOT ??= join(process.env.REZICS_QA_RETAINED_ROOT ?? root, '.temp', 'fixture');
    }
    const preparations = new Map(files.flatMap(file => {
      const selected = ownerErasurePreparationOptions(file);
      return selected ? [[String(selected.laterApiAdmission), selected] as const] : [];
    }));
    for (const [variant, selected] of preparations) {
      const evidence = join(directory, `owner-erasure-source-${label}-${variant}.json`);
      const prepared = await commandAsync(root, 'bun', [
        'tests/qa/fault-recovery/owner-restore-erasure-fixture.ts', '--prepare-retained-source', '--retained-only', '--evidence', evidence,
        ...(selected.laterApiAdmission ? ['--later-api-admission'] : []),
      ], 600_000, { ...environment, ...apps, REZICS_FIXTURE_ROOT: environment.REZICS_FIXTURE_ROOT ?? join(process.env.REZICS_QA_RETAINED_ROOT ?? root, '.temp', 'fixture'),
        REZICS_QA_RUN_ID: projectRunId, REZICS_QA_ARTIFACT_DIR: directory }, noteMemory, { runDeadline });
      writeFileSync(join(logs, `${label}-owner-erasure-source-${variant}.log`), prepared.output);
      writeFileSync(join(directory, `owner-erasure-selection-${label}-${variant}.json`), JSON.stringify({
        deadlineMs: 600_000, activeElapsedMs: prepared.activeElapsedMs,
        admissionWaitMs: prepared.admissionWaitMs, ok: prepared.ok,
      }));
      if (!prepared.ok) {
        fail(`owner-erasure source preparation failed before operation clock (${label}, later admission ${variant})`, qaFailure(prepared, 'environment'), tier);
        return finish({ ok: false, timedOut: prepared.timedOut, noMatch: false,
          xml: xmlForCommand(tier, false, prepared.activeElapsedMs, prepared.output) });
      }
      environment.REZICS_FIXTURE_ROOT ??= join(process.env.REZICS_QA_RETAINED_ROOT ?? root, '.temp', 'fixture');
    }
  }
  if (tier === 'integration' && needsRealmDiscussionSource(files)) {
    // This producer owns the declared build clock, followed by the unchanged
    // physical-cut clock. The consumer file only selects/restores custody.
    const prepared = await commandAsync(root, 'bun', [
      'tests/qa/support/realm-discussion-source-runtime.ts', '--prepare',
    ], realmSourceBuildDeadlineMs + 600_000, { ...environment, ...apps,
      REZICS_QA_RUN_ID: projectRunId, REZICS_QA_ARTIFACT_DIR: directory }, noteMemory, { runDeadline });
    writeFileSync(join(logs, `${label}-realm-discussion-source.log`), prepared.output);
    if (!prepared.ok) {
      fail(`Realm source preparation failed before operation clock (${label})`, qaFailure(prepared, 'environment'), tier);
      return finish({ ok: false, timedOut: prepared.timedOut, noMatch: false,
        xml: xmlForCommand(tier, false, prepared.activeElapsedMs, prepared.output) });
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
    REZICS_QA_MEMORY_DEADLINE: String(admissionDeadline),
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
  let fixtureCleanupMs = 0;
  const cleanupClock = ownerErasureCleanupShard(files) ? createOwnerErasureCleanupClock(budget) : undefined;
  const activeTestMs = () => Date.now() - testStart - childAdmissionMs - fixtureCleanupMs;
  const suites: string[] = [];
  const output: string[] = [];
  const fileDurations: Record<string, number> = {};
  const resetBlockedFiles: string[] = [];
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
        const pending = batches.slice(index).flat();
        const failure = integrationResetHarnessFailure({
          stack: `rezics-qa-${projectRunId}`,
          pendingFiles: pending,
          timedOut: reset.timedOut,
        });
        writeFileSync(join(logs, `${label}-reset.log`), reset.output);
        record.failureClass ??= qaFailure(reset, 'harness');
        fail(`${failure.message} (see logs/${label}-reset.log)`, record.failureClass, tier);
        resetBlockedFiles.push(...pending);
        commandOk = false;
        break;
      }
      apps = readEnv(join(stackDir, 'apps.env'));
      // The reset emptied the dataset. The fresh graph admits the writer again;
      // preparation completes the scope Main does not rerun.
      if (admitsWorkScope) {
        try {
          await admitIntegrationWorkScope({
            root, projectRunId, fusekiUrl: apps.FUSEKI_URL!, maintenanceToken: apps.FUSEKI_MAINTENANCE_TOKEN,
            environment,
          });
        } catch (error) {
          const message = redactCommandOutput(error instanceof Error ? error.message : String(error));
          output.push(message);
          commandOk = false;
          break;
        }
      }
    }
    const batch = batches[index]!;
    const batchFile =
      batches.length === 1 ? outfile : outfile.replace(/\.xml$/, `-${index + 1}.xml`);
    const batchArgs = tierBunTestArgs(tier, [
      ...batch.map(file => `./${file}`), ...flags, '--reporter=junit', `--reporter-outfile=${batchFile}`,
      ...(options.timeoutArgs ?? []),
    ]);
    const runBatch = (environment: NodeJS.ProcessEnv, onLine: (line: string) => void) => commandAsync(
      root, 'bun', batchArgs,
      Math.max(1, budget - activeTestMs()), environment, line => {
        cleanupClock?.observe(line);
        onLine(line);
      }, { runDeadline, ...(cleanupClock ? { phaseDeadline: (sample: CommandPhaseSample) => {
        lastSample = sample;
        return cleanupClock.sample(sample);
      } } : {}) });
    const campaign = campaignQualificationShard(batch);
    const commandStartedAt = Date.now();
    const evidenceWatch = openCampaignEvidence();
    let lastSample: CommandPhaseSample = {
      activeElapsedMs: 0, admissionOpen: false, observedAt: commandStartedAt,
      commandStartedAt, admission: [],
    };
    const phaseDeadline = (sample: CommandPhaseSample) => {
      lastSample = sample;
      return campaignPhaseDeadline(sample, evidenceWatch.observe(campaignEvidenceRead(projectRunId, sample)));
    };
    const result = campaign
      ? await commandAsync(root, 'bun', batchArgs,
        Math.max(1, budget - activeTestMs()), testEnvironment(), noteMemory,
        { runDeadline, phaseDeadline })
      : await (startupProtocol ? withStartupSlot(testEnvironment(), runBatch, reserve)
        : runBatch(testEnvironment(), noteMemory));
    if (cleanupClock) {
      const accepted = cleanupClock.sample({ ...lastSample, activeElapsedMs: result.activeElapsedMs,
        observedAt: lastSample.commandStartedAt + result.elapsedMs }, true);
      fixtureCleanupMs = accepted.cleanupMs;
      if (accepted.reason) commandOk = false;
      writeFileSync(join(directory, `owner-erasure-cleanup-${label}.json`), `${JSON.stringify({
        projectRunId, operationBudgetMs: budget, activeElapsedMs: result.activeElapsedMs,
        admissionWaitMs: result.admissionWaitMs, ...accepted,
      }, null, 2)}\n`);
    }
    if (campaign) {
      const sample = { ...lastSample, activeElapsedMs: result.activeElapsedMs, admissionOpen: false, observedAt: Date.now() };
      const accepted = campaignCommandAccepted({
        exitOk: result.ok, timedOut: result.timedOut, sample,
        evidence: evidenceWatch.observe(campaignEvidenceRead(projectRunId, sample), 'final'),
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
    const observed = existsSync(batchFile) ? parseJUnit(readFileSync(batchFile, 'utf8'), tier) : [];
    for (const file of batch) {
      const failed = observed.filter(test => test.file === file && test.failed);
      if (failed.length) (record.fileFailures ??= {})[file] ??= testFailureClass({ output: result.output }, failed);
    }
    if (!result.ok && !empty) {
      record.failureClass ??= testFailureClass(result, observed);
      noteFailure(record.failureClass, tier);
    }
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
    for (const file of results.missing) (record.fileFailures ??= {})[file] ??= result.timedOut ? 'timeout' : 'harness';
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
  record.elapsedMs = testEnd - testStart - childAdmissionMs - fixtureCleanupMs;
  if (cleanupClock) record.fixtureCleanupMs = fixtureCleanupMs;
  const results = completeFileResults(
    mergeJUnit(suites, record.elapsedMs),
    filesKeptAfterResetFailure(files, resetBlockedFiles),
    tier,
    {
      filtered: flags.includes('-t'),
      interrupted: timedOut || (!commandOk && resetBlockedFiles.length === 0),
      reason: timedOut
        ? 'Shard timed out; file did not complete'
        : 'Shard stopped before this file produced results',
    },
  );
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
  if (!ok && (timedOut || record.elapsedMs > activeCeiling)) record.failureClass ??= 'timeout';
  return finish({ ok, timedOut, noMatch, testStart, testEnd, xml: results.xml, resetBlockedFiles });
}

function failedTests(run: ShardRun, tier: StackTier): Map<string, string[]> {
  const failed = new Map<string, string[]>();
  for (const test of parseJUnit(run.xml ?? '', tier).filter(test => test.failed && test.name !== 'QA file did not complete' && !test.preparationFailure)) {
    failed.set(test.file, [...failed.get(test.file) ?? [], test.name]);
  }
  return failed;
}

function testWall(runs: ShardRun[]): number {
  const timed = runs.filter(run => run.testStart !== undefined && run.testEnd !== undefined);
  if (!timed.length) return 0;
  // These consumers run serially, one file per shard. Their disposal is measured
  // and capped separately by the live command phase clock, including on failure.
  if (timed.length === 1 && timed[0]!.record.fixtureCleanupMs !== undefined)
    return timed[0]!.record.elapsedMs!;
  return activeTestWallMs(timed.map(run => ({ start: run.testStart!, end: run.testEnd! })), admissionIntervals);
}

// Integration and fault/recovery files run in parallel QA projects sized from
// recorded file durations and free Goal QA slots. A file that fails after other
// files in its project is rerun alone on a fresh project; passing there marks it
// order-dependent, and the fresh result replaces the shared-project result.
async function runStackTier(tier: StackTier): Promise<void> {
  const artifact = tierArtifactName(tier);
  const { paths, flags } = splitTestArgs(testArgs(tier, selection, chosenFor(tier)));
  const selectedFiles = preparationTestFiles(expandTestPaths(root, paths), chosenFor(tier)?.files);
  if (!selectedFiles.length) {
    tiers.push({ name: tier, status: 'passed', elapsedMs: 0 });
    return;
  }
  // Explicit preparation owns its aggregate wall; each stage still enforces 600 seconds.
  const exclusiveWall = tier === 'fault/recovery' ? exclusivePreparationWallMs(selectedFiles) : undefined;
  const exclusiveRecovery = exclusiveWall !== undefined;
  const budget = exclusiveWall ?? (tier === 'integration' ? 480_000 : 360_000);
  const recorded = recordedFileDurations(artifactRoots(root), tier);
  const local = tier === 'fault/recovery'
    ? recordedFileDurations([join(root, '.artifacts', 'qa')], tier, 60, 1) : new Map<string, number>();
  const estimates = estimatedDurations(selectedFiles,
    tier === 'fault/recovery' ? new Map([...recorded, ...faultRecoveryBaselineDurations, ...local]) : recorded);
  // Prepare the default fixture once before shards, then share its stopped cut.
  const fixtureConsumers = smallRecoveryFixtureConsumers(selectedFiles, process.env);
  if (tier === 'fault/recovery' && Object.values(fixtureConsumers).some(Boolean)) {
    const fixtureRoot = process.env.REZICS_FIXTURE_ROOT ?? join(process.env.REZICS_QA_RETAINED_ROOT ?? root, '.temp', 'fixture');
    const preparationFile = join(directory, 'fault-recovery-fixture-preparation.json');
    const prepared = await withWorkSlot(reserveWork => admit('other', () => withStartupSlot(
      { ...qaStackEnvironment(process.env), REZICS_FIXTURE_ROOT: fixtureRoot },
      (environment, onLine) => commandAsync(root, 'bun',
        ['scripts/fixture/cli.ts', 'build', '--prepare', '--profile', 'small', '--evidence', preparationFile],
        LOAD_PREPARATION_BUDGET_MS, environment, onLine, { runDeadline }), reserveWork), qaStackEnvironment(process.env)));
    writeFileSync(join(logs, 'fault-recovery-fixture-preparation.log'), prepared.output);
    writeFileSync(join(directory, 'fault-recovery-fixture-selection.json'), JSON.stringify({
      deadlineMs: LOAD_PREPARATION_BUDGET_MS, activeElapsedMs: prepared.activeElapsedMs,
      admissionWaitMs: prepared.admissionWaitMs, ok: prepared.ok,
    }));
    if (!prepared.ok) {
      fail(
        'fault/recovery small-fixture preparation failed (budget 600s; see logs/fault-recovery-fixture-preparation.log)',
        qaFailure(prepared, 'environment'), tier,
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
    if (fixtureConsumers.launch) {
      faultFixtureEnvironment.G727_LAUNCH_FIXTURE = report.fixture;
      faultFixtureEnvironment.G727_LAUNCH_PREPARATION_MS = String(prepared.activeElapsedMs);
    }
    if (fixtureConsumers.erasure) faultFixtureEnvironment.ERASURE_CAMPAIGN_FIXTURE = report.fixture;
  }
  const maximum = maximumShards(process.env, tier);
  const wanted =
    tier === 'fault/recovery'
      ? Math.min(maximum, estimates.size)
      : shardCount(estimates, budget, maximum);
  // Plan bounded workers without reserving leases for projects still awaiting admission.
  const capacity = heavyQaRun || !qaSlotDirectory ? wanted
    : Math.min(wanted, configuredQaSlots(qaSlotDirectory));
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
    const schedule = restoreDrillSchedule(projects, tier === 'fault/recovery' ? serialRestoreDrillFiles : []);
    if (tier === 'fault/recovery') writeFileSync(join(directory, `${artifact}-schedule.json`), JSON.stringify({
      parallel: schedule.parallel, serial: schedule.serial, serialConsumers: 1,
      sourceSelection: 'retained-only',
    }, null, 2));
    // Hang detectors, not quiet-host gates: held/corruption/release measured 178/237/221 s
    // unloaded and 272/304/325 s, then 321/358/338 s busy; quiet-host regressions still matter.
    const projectBudget = (files: readonly string[]) =>
      campaignQualificationShard(files) ? campaignShardActiveMs()
        : tier === 'fault/recovery' && files.length === 1 && [
          'tests/qa/fault-recovery/erasure-restore.test.ts',
          'tests/qa/fault-recovery/erasure-restore-corruption.test.ts',
          'tests/qa/fault-recovery/erasure-restore-release.test.ts',
          'tests/qa/fault-recovery/independent-restore.test.ts',
          'tests/qa/fault-recovery/independent-restore-authority.test.ts',
          'tests/qa/fault-recovery/independent-restore-refusals.test.ts',
        ].includes(files[0]!) ? 600_000 : exclusivePreparationWallMs(files) ?? budget;
    // Integration and fault/recovery queue more projects than slots; each keeps its own deadline.
    // The campaign project's wall is the sum of its two measured phases.
    if (integration) integrationBudgetNotes.push(...integrationBudgetSummary(integrationOverBudgetFiles(estimates)));
    const tierBudget = integration
      ? integrationTierWallMs(integration.map(shard => shard.resourceClass), capacity, integration.length)
      : tier === 'fault/recovery' && !exclusiveRecovery
        ? queuedProjectsBudget(schedule.parallel.map(projectBudget), capacity)
          + schedule.serial.reduce((total, files) => total + projectBudget(files), 0) : budget;
    const warning = stackPlanBudgetWarning(estimates, tierBudget, capacity, maximum, tier,
      tier === 'integration' ? count => planIntegrationShards(estimates, count).map(shard => shard.files) : undefined);
    if (warning) console.warn(warning);
    // Local workers bound the plan; each project takes its global lease only after admission.
    const startupAdmission = { runDeadline, onAdmissionWait: (span: { start: number; end: number }) => admissionIntervals.push(span) };
    const startInitialStack = concurrencyGate(tier === 'integration' ? capacity : Math.min(capacity, 3), startupAdmission);
    const runProject = (index: number, files: string[]) => runShard(
      tier, `${runId}-${prefix}${index + 1}`, files, flags, projectBudget(files), false, startInitialStack,
      integration?.[index]?.batches,
    );
    const parallelRuns = await runQueuedProjects(schedule.parallel, capacity, budget, runProject);
    // Reuse the admitted queue with one consumer; no second scheduler or lease owner.
    const serialRuns = await runQueuedProjects(schedule.serial, 1, budget,
      (index, files) => runProject(schedule.parallel.length + index, files));
    const runs = [...parallelRuns, ...serialRuns];
    const candidates = runs.filter(run => !run.ok && !run.timedOut && run.record.stage === 'test'
      && run.record.files.length > 1)
      .flatMap(run => isolationCandidates(run.xml ?? '', tier)
        .map(candidate => ({ run, ...candidate })));
    const startRerunStack = concurrencyGate(Math.min(capacity, 3), startupAdmission);
    const reruns = await runQueuedProjects(candidates, capacity, budget, (index, candidate, commandBudget) =>
      runShard(tier, `${runId}-${prefix}r${index + 1}`, [candidate.file], flags, commandBudget, true, startRerunStack));
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
    // Serial source selection and stack preparation occur between test commands.
    // Their gaps must not spend the measured restore/operation wall.
    const elapsedMs = testWall(parallelRuns) + serialRuns.reduce((total, run) => total + testWall([run]), 0)
      + testWall(completed);
    const resetBlocked = new Set(runs.flatMap((run) => run.resetBlockedFiles ?? []));
    const finalResults = completeFileResults(
      mergeJUnit(suites, elapsedMs),
      [...estimates.keys()].filter((file) => !resetBlocked.has(file)),
      tier,
      { filtered: flags.includes('-t'), interrupted: runs.some((run) => run.timedOut), elapsedMs },
    );
    writeFileSync(join(directory, `${artifact}.xml`), finalResults.xml);
    if (finalResults.missing.length)
      fail(`${tier} files did not run: ${finalResults.missing.join(', ')}`);
    for (const run of [...runs, ...completed]) {
      if (run.record.stage !== 'test' || (run.record.isolation ? run.ok : resolved(run))) continue;
      const label = `${artifact}-${run.record.project.slice(runId.length + 1)}`;
      fail(`${tier} failed (budget ${(run.record.budgetMs ?? budget) / 1000}s) in ${run.record.project} (see logs/${label}.log)`,
        run.record.failureClass ?? 'harness', tier);
    }
    const executed = parseJUnit(mergeJUnit(suites, 0), tier).length > 0;
    if (!executed) fail(`${tier} executed no tests`);
    if (elapsedMs > tierBudget) fail(`${tier} test wall time ${(elapsedMs / 1000).toFixed(1)}s exceeded ${tierBudget / 1000}s`, 'timeout', tier);
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

function noteIntegrationBudget(artifactDirectory: string): void {
  if (!integrationBudgetNotes.length) return;
  appendFileSync(join(artifactDirectory, 'summary.md'), `${integrationBudgetNotes.join('\n')}\n`);
}

try {
  try { await assertRetainedSources(root, selected.flatMap(tier => {
    if (tier !== 'integration' && tier !== 'fault/recovery' && tier !== 'load') return [];
    return splitTestArgs(testArgs(tier, selection, chosenFor(tier))).paths.flatMap(path => expandTestPaths(root, [path]));
  })); } catch (error) {
    fail(error instanceof Error ? error.message : String(error), 'environment');
    throw error;
  }
  await stackPool.sweep();
  if (options.record && !sourceBefore.clean) throw new Error('--record requires a clean source tree');
  if (options.record) {
    const missing = missingCaseDeclarations(cases, caseCoverage);
    if (missing.length) throw new Error(`--record requires complete case declarations; ${missing.length} IDs remain`);
  }
  for (const tier of selected) {
    if (tier === 'static') await runTier(tier, 'bun', ['scripts/research/storage_architecture/check.ts', ...(options.backend ? ['--backend'] : [])], 120_000);
    if (tier === 'unit' || tier === 'owner') {
      const { runPreparedNativeProofBatch, nativeProofPreparationFailure } = await import('./native-proof-execution.ts');
      const started = Date.now();
      let args: string[] | undefined;
      try {
        args = testArgs(tier, selection, chosenFor(tier));
        const selectedArgs = args;
        await runPreparedNativeProofBatch(root, splitTestArgs(args).paths,
          tier === 'owner' ? ownerTierBudgetMs() : 180_000, budget => runBunTier(
            tier,
            'bun',
            tierBunTestArgs(tier, [
              ...selectedArgs,
              ...(tier === 'unit' && !selection && !chosenFor(tier) ? unitHarnessFiles : []),
              '--reporter=junit',
              `--reporter-outfile=${join(directory, `${tier}.xml`)}`,
              ...(options.timeoutArgs ?? []),
            ]),
            budget,
          ));
      } catch (error) {
        const elapsedMs = Date.now() - started;
        const files = args ? splitTestArgs(args).paths : chosenFor(tier)?.files
          ?? selection?.tests.filter(test => test.tier === tier).map(test => test.file) ?? [];
        const failure = nativeProofPreparationFailure(tier, files, error, elapsedMs);
        tiers.push({ name: tier, status: 'failed', elapsedMs });
        fail(failure.detail, 'environment', tier);
        writeFileSync(join(logs, `${tier}.log`), failure.detail);
        writeFileSync(join(directory, `${tier}.xml`), failure.xml);
      }
    }
    if (tier === 'model') {
      const projectRunId = `${runId}-m`;
      startedProjects.push(projectRunId);
      const up = await startRunStack(['stack:up', '--profile', 'qa', '--run-id', projectRunId], 180_000);
      if (!up.ok) {
        fail('model stack startup failed', qaFailure(up, 'environment'), tier);
        writeFileSync(join(logs, 'model-stack.log'), up.output);
        tiers.push({ name: tier, status: 'failed' });
        writeFileSync(join(directory, 'model.xml'), xmlForCommand(tier, false, up.elapsedMs, up.output));
        continue;
      }
      const stackDir = join(root, '.temp', 'stack', `rezics-qa-${projectRunId}`);
      const compose = readEnv(join(stackDir, 'compose.env'));
      const result = await commandAsync(root, 'bun', ['test', ...(options.timeoutArgs ?? []), ...testArgs('model', selection, chosenFor('model')), '--reporter=junit',
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
        fail('model failed (budget 180s)', testFailure(result, tier), tier);
        writeFileSync(join(logs, 'model.log'), result.output);
        const stackLogs = command(root, 'bun', ['scripts/dev/cli.ts', 'stack:logs', '--profile', 'qa', '--run-id', projectRunId], 20_000);
        writeFileSync(join(logs, 'model-stack.log'), stackLogs.output);
      }
    }
    if (tier === 'e2e') {
      const reserved = await allocateWebPort();
      const origin = webOrigin(reserved.port);
      console.log(`e2e web origin: ${origin}`);
      let browserStack: BrowserStack | undefined;
      try {
        const projectRunId = `${runId}-e`;
        const args = e2eArgs(selection, chosenFor('e2e'));
        const preparations = selectJourneyPreparations(await discoverJourneyPreparations(root), args);
        const restoreSteps: BrowserStepResult[] = [];
        const restoreFailures: JourneyPreparationFailure[] = [];
        const owned = await startBrowserStack(preparations, {
          root, playwrightArgs: args,
          recordFailure: async failure => {
            restoreFailures.push(failure);
            writeFileSync(join(logs, `e2e-${failure.preparation.slug}.log`), failure.error);
            // Record before even fresh storage startup can fail.
            await runPreparedJourneys([], restoreFailures.map(item => item.preparation.journey), {
              root, artifactDir: directory, initialFailures: restoreFailures,
              prepare: async () => {}, playwright: async () => {},
            });
          },
          restore: async preparation => {
            const accounts = await allocateWebPort();
            const registry = join(root, '.temp', 'qa-child-stacks', projectRunId);
            childStackRegistries.add(registry);
            const previousRegistry = process.env[QA_STACK_REGISTRY];
            process.env[QA_STACK_REGISTRY] = registry;
            let restored: BrowserStack | undefined;
            const restoreWaitStarted = Date.now();
            const resumeRestore = runDeadline.wait();
            let restoreAdmitted = false;
            try {
              await measuredBrowserStep(`${preparation.step} restore`, preparation.budgetMs, async () => {
                restoreAdmitted = true;
                resumeRestore();
                await reserveRunSlot({ deadline: admissionDeadline, runDeadline });
                restored = await preparation.restoreStack!({ runId: projectRunId, webOrigin: origin,
                  accountsPort: String(accounts.port) });
              }, { root, env: { ...process.env, REZICS_STACK_PROFILE: 'qa' }, deadline: admissionDeadline,
                record: result => {
                  restoreSteps.push(result);
                  writeFileSync(join(directory, 'e2e-steps.json'), JSON.stringify(restoreSteps, null, 2));
                } });
              const copy = restored!;
              return { ...copy, stop: async () => {
                await copy.stop();
                forgetQaStack({ profile: 'qa', runId: copy.runId, persistent: true }, registry);
              } };
            } catch (error) {
              if (!restoreAdmitted && Date.now() >= admissionDeadline)
                throw new Error(qaWaitFailure('browser memory', restoreWaitStarted, Date.now()));
              throw error;
            } finally {
              resumeRestore();
              if (previousRegistry === undefined) delete process.env[QA_STACK_REGISTRY];
              else process.env[QA_STACK_REGISTRY] = previousRegistry;
              accounts.release();
            }
          },
          fresh: async () => {
            startedProjects.push(projectRunId);
            const up = await startRunStack(['stack:up', '--profile', 'qa', '--run-id', projectRunId,
              '--accounts-app'], 180_000, { ...process.env, REZICS_QA_MEMORY_KIND: 'browser',
              REZICS_FUSEKI_ASSEMBLER: exclusiveWorkScopeAssembler });
            if (!up.ok) {
              writeFileSync(join(logs, 'e2e-stack.log'), up.output);
              throw new Error(`e2e stack startup failed: ${up.output}`);
            }
            const stackDir = join(root, '.temp', 'stack', `rezics-qa-${projectRunId}`);
            const staged = stageQaBootstrap(stackDir);
            const bootstrap = command(root, 'bun', staged.args, 180_000);
            if (!bootstrap.ok) {
              writeFileSync(join(logs, 'e2e-bootstrap.log'), bootstrap.output);
              throw new Error(`e2e stack bootstrap failed: ${bootstrap.output}`);
            }
            const webAuth = command(root, 'bun', ['scripts/dev/web-auth-bootstrap.ts',
              '--run-id', projectRunId, '--redirect-uri', `${origin}/auth/callback`], 180_000);
            if (!webAuth.ok) {
              writeFileSync(join(logs, 'e2e-web-auth-bootstrap.log'), webAuth.output);
              throw new Error(`e2e web authorization bootstrap failed: ${webAuth.output}`);
            }
            return { runId: projectRunId, apps: readEnv(join(stackDir, 'apps.env')), stop: async () => {} };
          },
        });
        browserStack = owned.stack;
        writeFileSync(join(directory, 'e2e-preparation-failures.json'), JSON.stringify(owned.failures, null, 2));
        if (!browserStack) {
          for (const item of owned.failures) fail(`${item.preparation.step}: ${item.error}`, 'environment', tier);
          tiers.push({ name: tier, status: 'failed' });
          continue;
        }
        const appsPath = join(root, '.temp', 'stack', `rezics-qa-${browserStack.runId}`, 'qa-apps.json');
        writeFileSync(appsPath, JSON.stringify(browserStack.apps), { mode: 0o600 });
        const plan = e2eBrowserPlan(args, options.storybook === true);
        const counts = browserFileCounts(root, args);
        const budgets = browserBudgets(counts.playwright, counts.storybook, browserProjectCount(), {
          playwright: plan.accountsJourneys ? counts.accountsPlaywright : 0,
          stories: plan.stories ? counts.accountsStories : 0,
        });
        const preparation = preparationBudgetMs(preparations);
        const storyBudget = plan.stories ? budgets.storybook + budgets.accountsStorybook : 0;
        const e2eEnv: NodeJS.ProcessEnv = { ...process.env, REZICS_WEB_E2E_BASE_URL: origin,
          REZICS_WEB_E2E_PORT_HOLDER: String(reserved.pid), REZICS_BROWSER_STACK_RUN_ID: browserStack.runId };
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
            { step: string; passed: boolean; error?: string; elapsedMs?: number; budgetMs?: number }[] : [];
          const failed = steps.filter(step => !step.passed);
          for (const message of failed.length ? failed.map(step => `${step.step}: ${step.error ?? 'failed'} (see logs/e2e.log)`)
            : ['e2e runner failed (see logs/e2e.log)']) fail(message, testFailure({ ...result, timedOut: result.timedOut
              || failed.some(step => (step.elapsedMs ?? 0) > (step.budgetMs ?? Infinity)) }, tier), tier);
          if (!existsSync(join(directory, 'e2e.xml'))) {
            writeFileSync(join(directory, 'e2e.xml'), xmlForCommand(tier, false, result.elapsedMs, result.output));
          }
          const stackLogs = command(root, 'bun', ['scripts/dev/cli.ts', 'stack:logs', '--profile', 'qa', '--run-id', browserStack.runId], 20_000);
          writeFileSync(join(logs, 'e2e-stack.log'), stackLogs.output);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        fail(detail, error instanceof SyntaxError ? 'harness' : 'environment', tier);
        tiers.push({ name: tier, status: 'failed' });
        if (!existsSync(join(directory, 'e2e.xml')))
          writeFileSync(join(directory, 'e2e.xml'), xmlForCommand(tier, false, 0, detail));
      } finally {
        try { await browserStack?.stop(); }
        finally { reserved.release(); }
      }
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
        splitTestArgs(testArgs(tier, selection, chosenFor(tier))).paths);
      const fixturePlan = loadFixturePlan(runId, selectedFiles, chosenFor(tier)?.id);
      startedProjects.push(projectRunId);
      const up = await startRunStack(['stack:up', '--profile', 'qa', '--run-id', projectRunId], 180_000);
      if (!up.ok) { fail(`${tier} stack startup failed`, qaFailure(up, 'environment'), tier); writeFileSync(join(logs, `${artifact}-stack.log`), up.output); tiers.push({ name: tier, status: 'failed' }); writeFileSync(join(directory, `${artifact}.xml`), xmlForCommand(tier, false, up.elapsedMs, up.output)); continue; }
      const stackDir = join(root, '.temp', 'stack', `rezics-qa-${projectRunId}`);
      const staged = stageQaBootstrap(stackDir);
      const compose = readEnv(join(stackDir, 'compose.env'));
      const bootstrap = command(root, 'bun', staged.args, Math.min(180_000, remainingPreparation()));
      if (!bootstrap.ok) { fail(`${tier} shared bootstrap failed`, qaFailure(bootstrap, 'environment'), tier); writeFileSync(join(logs, `${artifact}-bootstrap.log`), bootstrap.output); tiers.push({ name: tier, status: 'failed' }); writeFileSync(join(directory, `${artifact}.xml`), xmlForCommand(tier, false, bootstrap.elapsedMs, bootstrap.output)); continue; }
      const fixtureResults = await Promise.all(fixturePlan.map(async item => {
        startedFixtureProjects.push(item.runId);
        const result = await admit('other', () => commandAsync(root, 'bun', ['scripts/fixture/cli.ts', 'restore',
          '--fixture', LOAD_FIXTURE_ID, '--run-id', item.runId], remainingPreparation(), process.env, noteMemory, { runDeadline })).catch(error => ({
            ok: false, timedOut: true, elapsedMs: Date.now() - preparationStarted,
            output: redactCommandOutput(error instanceof Error ? error.message : String(error)),
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
        fail(`${tier} preparation failed within a budget of ${LOAD_PREPARATION_BUDGET_MS / 1000}s`, qaFailure({ timedOut: preparationMs > LOAD_PREPARATION_BUDGET_MS || fixtureResults.some(item => item.timedOut) }, 'environment'), tier);
        tiers.push({ name: tier, status: 'failed' });
        writeFileSync(join(directory, `${artifact}.xml`), xmlForCommand(tier, false, preparationMs,
          JSON.stringify(fixtureResults)));
        continue;
      }
      // docs/testing/test-harness.md#tiers-and-budgets: 5 min since the phase D probes.
      const budget = 300_000;
      const result = await commandAsync(root, 'bun', ['test', ...(options.timeoutArgs ?? []), ...testArgs(tier, selection, chosenFor(tier)), '--reporter=junit',
        `--reporter-outfile=${join(directory, `${artifact}.xml`)}`], budget,
      { ...process.env, ...staged.apps, REZICS_QA_RUN_ID: projectRunId,
        REZICS_S3_GATE_PROJECT: projectRunId,
        REZICS_QA_ARTIFACT_DIR: directory,
        ...Object.fromEntries(fixturePlan.map(item =>
          [`REZICS_QA_FIXTURE_${item.caseId}_RUN_ID`, item.runId])),
        TOXIPROXY_API_URL: `http://127.0.0.1:${compose.TOXIPROXY_API_PORT}`,
        TOXIPROXY_FUSEKI_URL: `http://127.0.0.1:${compose.TOXIPROXY_FUSEKI_PORT}/rezics/` }, noteMemory, { runDeadline });
      const ok = result.ok && result.activeElapsedMs <= budget;
      tiers.push({ name: tier, status: ok ? 'passed' : 'failed', elapsedMs: result.activeElapsedMs });
      if (!ok) {
        fail(`${tier} failed (budget ${budget / 1000}s)`, testFailure(result, tier), tier);
        writeFileSync(join(logs, `${artifact}.log`), result.output);
        const stackLogs = command(root, 'bun', ['scripts/dev/cli.ts', 'stack:logs', '--profile', 'qa', '--run-id', projectRunId], 20_000);
        writeFileSync(join(logs, `${artifact}-stack.log`), stackLogs.output);
      }
    }
  }
} catch (error) {
  fail(redactCommandOutput(error instanceof Error ? error.message : String(error)));
} finally {
  for (const registry of childStackRegistries) {
    for (const error of await resetChildStacks(registry)) fail(`QA child stack cleanup failed: ${error}`);
  }
  if (!options.keep) for (const projectRunId of startedProjects) {
    const down = command(root, 'bun', ['scripts/dev/cli.ts', 'stack:reset', '--profile', 'qa', '--run-id', projectRunId], 120_000);
    if (!down.ok) { fail(`QA stack cleanup failed: ${projectRunId}`); writeFileSync(join(logs, `${projectRunId}-cleanup.log`), down.output); }
  }
  // Restored fixture copies hold large persistent volumes; removing one took over
  // 120 s in record run 20260927t054833-96d374, so the copies reset concurrently.
  if (!options.keep) {
    const resets = await Promise.all(startedFixtureProjects.map(async projectRunId => ({ projectRunId,
      down: await commandAsync(root, 'bun', ['scripts/dev/cli.ts', 'stack:reset', '--profile', 'qa',
        '--run-id', projectRunId, '--persistent',
        ...(rawUpdateProjects.has(projectRunId) ? ['--raw-update'] : [])], 300_000) })));
    for (const { projectRunId, down } of resets) {
      if (!down.ok) { fail(`Fixture stack cleanup failed: ${projectRunId}`);
        writeFileSync(join(logs, `${projectRunId}-cleanup.log`), down.output); }
    }
  }
  destroyHeldQaStacks();
  try {
    const sourceAfter = sourceIdentity(root);
    if (sourceAfter.fingerprint !== sourceBefore.fingerprint) fail('Source changed during QA run');
    for (const tier of uncoveredTiers) tiers.push({ name: tier, status: 'uncovered' });
    const tests = junitResults(directory, selected.filter(tier => tier === 'unit' || tier === 'owner' || tier === 'integration'
      || tier === 'model' || tier === 'fault/recovery' || tier === 'e2e' || tier === 'load'));
    if (selection) {
      for (const expected of selection.tests) {
        if (!selectedTestExecuted(expected, tests))
          fail(`Selected test was not executed: ${expected.file}: ${expected.name}`);
      }
    }
    writeSummary(directory, { runId, sourceBefore, sourceAfter,
      tiers: tiers.map(tier => ({ ...tier, ...(tier.status === 'failed'
        ? { failureClass: tierFailures.get(tier.name) ?? 'harness' as const } : {}) })),
      isolation, failureClass: firstFailure,
      partial: Boolean(options.tier || options.groups || selection || options.files || options.id), errors, cases, tests,
      diagnosticOf: selection?.sourceRunId, retiredTests: selection?.retiredTests, caseCoverage,
      scope: options.backend ? 'backend' : 'all', excludedCases: backendSelection?.excluded,
      inventoryFingerprint: backendSelection?.inventoryFingerprint });
    noteBrowserPlan(directory);
    noteIntegrationBudget(directory);
    writeFileSync(join(directory, 'run-deadline.json'), JSON.stringify(runDeadline.sample(), null, 2));
    if (stackLeaseNotes.length) appendFileSync(join(directory, 'summary.md'), `${stackLeaseNotes.join('\n')}\n`);
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
    releaseDeferredHeavy?.();
    release();
  }
    console.log(readFileSync(join(directory, 'summary.md'), 'utf8'));
    console.log(`QA artifacts: ${directory}`);
    if ((options.groups?.length ?? 0) > 1) {
      console.log(selected.map(name => formatTierRunLine(name, runId,
        tiers.find(tier => tier.name === name)?.status ?? 'failed')).join('\n'));
    }
  if (errors.length) process.exitCode = 1;
}
