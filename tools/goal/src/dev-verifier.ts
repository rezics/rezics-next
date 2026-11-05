import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type {
  DevVerifierEvidence,
  DevVerifierFinding,
  DevVerifierResult,
  DevVerifierRun,
  Settings,
  Task,
} from './types.ts';
import { defaultPolicy } from './policy.ts';
import { runBoundedInstallProcess } from './install-process.ts';
import type { WorkerStore } from './store.ts';
import type { SqliteManagerInbox } from './inbox.ts';
import { firstFailure, gateEnvironment, gateRunner, git, type GateRunner } from './merge.ts';
import { acquireDirectoryLease, LeaseHeldError } from './lease.ts';
import { recordFlow } from './flow.ts';
import type { Database } from 'bun:sqlite';
import { isTransportTimeout } from './check-failure.ts';
import { CHECK_HOST_TRANSPORT } from './records.ts';
import { hostname } from 'node:os';
import { repositoryBun } from '../../../scripts/remote-check.ts';
import {
  checkInputAreas,
  checkSourceFiles,
  checkSourceQueryPaths,
  createVerifierChecks as createChecks,
  filesInCommits,
  matches,
  mergeRevisionSource,
  placeInWorkspace,
  projectVerifierLandings,
  sourcePresentAt,
  taskCommits,
  trackedFilesAt,
  type DevVerifierCheck,
  type RevisionSource,
  type VerifierLandings,
} from './dev-verifier-plan.ts';

export {
  placeInWorkspace,
  projectChecksSource,
  projectRevisionSource,
  projectSourceInterval,
  projectVerifierLandings,
  sourcePresentAt,
} from './dev-verifier-plan.ts';
export type { DevVerifierCheck, RevisionSource, SourceInterval, VerifierLandings } from './dev-verifier-plan.ts';
import {
  cachedRun,
  knownExisting,
  readFindingCounts,
  saveFinding,
  saveRun,
  type DevVerifierStorage,
  type VerificationFindingCounts,
} from './dev-verifier-storage.ts';

const ref = (branch: string) => `refs/heads/${branch}`;
const verifiedBranch = 'dev-verified';
type Check = DevVerifierCheck;
type IndexedCheck = Check & { index: number; signature: string };
type GateOutcome = { passed: boolean; output: string; timedOut: boolean };
type ComparedCheck = {
  check: IndexedCheck;
  baseline: DevVerifierEvidence | null;
  head: DevVerifierEvidence | null;
  baselineReason?: string;
  headReason?: string;
};
type Comparison = {
  base: string;
  head: string;
  checks: IndexedCheck[];
  results: ComparedCheck[];
  findings: DevVerifierFinding[];
  passTaskIds: string[];
};
type FindingGroup = { check: IndexedCheck; findings: DevVerifierFinding[]; targets: string[] };
type Suspect = { task: Task; commit: string };
type ExistingProbe = { status: 'existing' | 'new' | 'unknown'; cleanIndex?: number };

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function head(cwd: string, branch: string): string {
  return git(cwd, 'rev-parse', '--verify', ref(branch));
}
function recordVerified(
  store: Pick<WorkerStore, 'tasks'> & { db?: Database },
  history: VerifierLandings,
  passedTaskIds: ReadonlySet<string>,
): void {
  if (!store.db) return;
  const at = new Date().toISOString();
  for (const task of history.tasks) {
    // A verification receipt means this task's own acceptance passed on the exact head. A baseline failure on that
    // command is never converted into a receipt for the task.
    if (!passedTaskIds.has(task.id)) continue;
    recordFlow(store.db, {
      taskId: task.id,
      attempt: task.currentAttempt,
      stage: 'verification',
      action: 'verified',
      at,
    });
  }
}
function infraFailure(output: string, timedOut: boolean): boolean {
  return timedOut || CHECK_HOST_TRANSPORT.test(output) || isTransportTimeout(output);
}
function unavailableFailure(output: string): boolean {
  return (
    /(?:command|executable|script|module|package|dependency).{0,50}(?:not found|missing|cannot be found|not configured|unknown)|cannot find (?:module|package)|module not found|ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|no such file or directory|ENOENT|permission denied|not recognized as an internal or external command/i.test(
      output,
    ) || /pinned Bun: absent installed (?:package|binary)/i.test(output)
  );
}
function truncatedOutput(output: string): boolean {
  return /(?:output|log|result).{0,40}truncated|truncated.{0,40}(?:output|log|result)|\[TRUNCATED\]|<truncated>/i.test(
    output,
  );
}
function assertionLines(output: string): string[] {
  const assertion = firstFailure(output).assertion;
  if (!assertion || assertion === 'Gate exited unsuccessfully') return [];
  return [
    ...new Set(
      assertion
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}
function stableAssertions(output: string, policy = defaultPolicy.verifier): string[] {
  return assertionLines(output).slice(0, policy.findingAssertions);
}
function tooManyAssertions(output: string, policy = defaultPolicy.verifier): boolean {
  return assertionLines(output).length > policy.findingAssertions;
}
export function classifyRun(
  result: Pick<DevVerifierEvidence, 'passed' | 'timedOut' | 'output'>,
  policy = defaultPolicy.verifier,
): DevVerifierResult {
  if (result.passed) return 'pass';
  if (
    infraFailure(result.output, result.timedOut) ||
    unavailableFailure(result.output) ||
    truncatedOutput(result.output) ||
    tooManyAssertions(result.output, policy) ||
    !stableAssertions(result.output, policy).length
  )
    return 'infrastructure';
  return 'fail';
}
function environmentIdentity(settings: Settings): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(gateEnvironment(process.env, settings.stateDirectory)).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}
function packageManagerPinAt(checkout: string, commit?: string): string | undefined {
  try {
    const source = commit
      ? git(checkout, 'show', `${commit}:package.json`)
      : readFileSync(join(checkout, 'package.json'), 'utf8');
    const packageJson = JSON.parse(source) as { packageManager?: unknown };
    return typeof packageJson.packageManager === 'string' && packageJson.packageManager.startsWith('bun@')
      ? packageJson.packageManager.slice('bun@'.length)
      : undefined;
  } catch {
    return undefined;
  }
}
function toolchainIdentity(settings: Settings, commit?: string): unknown {
  let remoteHosts: string | null = null;
  const pinnedBun = packageManagerPinAt(settings.mainCheckout, commit);
  try {
    remoteHosts = readFileSync(join(settings.stateDirectory, 'remote-check-hosts.json'), 'utf8');
  } catch {}
  return {
    bun: pinnedBun ?? Bun.version,
    bunRevision: pinnedBun ? null : Bun.revision,
    platform: process.platform,
    arch: process.arch,
    host: hostname(),
    noCompileCache: '1',
    remoteHosts,
  };
}
function checkSignature(check: Check, index: number): string {
  return hash({
    version: 2,
    index,
    command: check.command,
    closure: [...check.closure].sort(),
    taskId: check.taskId ?? null,
    cwd: check.cwd ?? null,
  });
}
function findingSignature(check: Check, assertion: string): string {
  return hash({
    version: 2,
    command: check.command.filter((argument) => !/^TYPECHECK_CHANGED=/.test(argument)),
    closure: [...check.closure].sort(),
    taskId: check.taskId ?? null,
    cwd: check.cwd ?? null,
    assertion,
  });
}
function checkRunKey(settings: Settings, commit: string, check: Check, signature: string, selection: string): string {
  return hash({
    version: 2,
    commit,
    signature,
    selection,
    command: check.command,
    closure: [...check.closure].sort(),
    environment: environmentIdentity(settings),
    toolchain: toolchainIdentity(settings, commit),
  });
}
export function checkInput(
  settings: Settings,
  commit: string,
  check: Check,
  source: RevisionSource,
): string | undefined {
  const areas = checkInputAreas(check);
  if (!areas) return undefined;
  return hash({
    version: 1,
    phase: 'failed-input',
    command: check.command,
    cwd: check.cwd ?? null,
    closure: [...check.closure].sort(),
    taskId: check.taskId ?? null,
    trees: [...areas].sort().map((area) => [area, source.objects.get(area) ?? null]),
    environment: environmentIdentity(settings),
    toolchain: toolchainIdentity(settings, commit),
  });
}
function installDependencies(tree: string, stateDirectory: string, policy = defaultPolicy): boolean {
  if (!existsSync(join(tree, 'package.json')) || !existsSync(join(tree, 'bun.lock'))) return true;
  const installLog = join(stateDirectory, `dev-verify-install-${randomUUID()}.log`);
  for (let attempt = 0; attempt < policy.verifier.installAttempts; attempt++) {
    try {
      // Bootstrap installs dependencies; official check runs resolve the candidate artifact after installation.
      const executable = process.execPath;
      appendFileSync(installLog, `$ ${executable} install --frozen-lockfile (attempt ${attempt + 1})\n`);
      const result = runBoundedInstallProcess({
        command: executable,
        args: ['install', '--frozen-lockfile'],
        cwd: tree,
        step: 'bun install --frozen-lockfile',
        purpose: 'preparation',
        policy,
      });
      appendFileSync(installLog, `${result.stdout}${result.stderr}`);
      return true;
    } catch (error) {
      appendFileSync(installLog, `${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  return false;
}

export type BootSmokeRepair = {
  test: string;
  commit: string;
  error: string;
  owner: Task;
  existingTaskId?: string;
};

export type DevVerifierOptions = {
  settings: Settings;
  store: Pick<WorkerStore, 'tasks' | 'task' | 'updateTask'> & DevVerifierStorage;
  inbox: Pick<SqliteManagerInbox, 'deliver'>;
  runGate?: GateRunner;
  /** Local boot-smoke runner; defaults to `runGate` so tests can spy on one path. */
  runBootSmoke?: GateRunner;
  dispatchRepair?: (repair: BootSmokeRepair) => void;
};

const revisionSources = new WeakMap<DevVerifierOptions, Map<string, RevisionSource>>();
function revisionSource(options: DevVerifierOptions, commit: string, checks: readonly Check[]): RevisionSource {
  let cache = revisionSources.get(options);
  if (!cache) {
    cache = new Map();
    revisionSources.set(options, cache);
  }
  const existing = cache.get(commit);
  const source = mergeRevisionSource(
    options.settings.mainCheckout,
    commit,
    checks.flatMap(checkSourceQueryPaths),
    existing,
  );
  cache.set(commit, source);
  return source;
}

const OPEN_REPAIR_STATES = new Set(['ready', 'held', 'running', 'landing', 'stopped']);

function bootSmokeTestPath(check: Check): string {
  return checkSourceFiles(check)[0] ?? check.command.filter((argument) => !argument.startsWith('-')).at(-1) ?? '';
}

function bootSmokePathPattern(test: string): string {
  const [area, name] = test.split('/');
  return area && name && ['apps', 'services', 'packages'].includes(area) ? `${area}/${name}/**` : test;
}

export function bootSmokeRepairBrief(repair: BootSmokeRepair, policy = defaultPolicy.verifier): string {
  const paths = repair.owner.brief.paths.length ? repair.owner.brief.paths : [bootSmokePathPattern(repair.test)];
  const error = repair.error.slice(-policy.diagnosticCharacters);
  return `---\n${JSON.stringify(
    {
      goal: repair.owner.brief.goal,
      manager: repair.owner.brief.manager,
      kind: 'implementation',
      paths,
      riskAreas: repair.owner.brief.riskAreas ?? [],
      urgent: true,
      acceptance: { failing: true },
      criticalPath: false,
      waiting: [],
      after: [],
    },
    null,
    2,
  )}\n---\n\n# Repair the boot failure\n\nBoot-smoke repair for \`${repair.test}\`.\n\nCommit \`${repair.commit}\` broke the repository boot smoke.\n\n\`\`\`\n${error}\n\`\`\`\n`;
}

function openBootRepair(store: Pick<WorkerStore, 'tasks'>, test: string): Task | undefined {
  return store
    .tasks()
    .find(
      (task) =>
        OPEN_REPAIR_STATES.has(task.state) &&
        task.brief.urgent === true &&
        task.brief.markdown.includes(`Boot-smoke repair for \`${test}\``),
    );
}

function bootSmokeChecks(settings: Settings, commit: string): IndexedCheck[] {
  const tests = settings.bootSmoke?.tests ?? [];
  const tracked = trackedFilesAt(settings.mainCheckout, commit);
  return tests
    .filter((test) => tracked.has(test))
    .map((test, index) => {
      const check = placeInWorkspace({ command: ['bun', 'test', test], closure: ['**'] }, tracked);
      return { ...check, index, signature: checkSignature(check, index) };
    });
}

/**
 * Checks the verifier runs at once. It verifies after integration at ordinary priority, so it takes a share of the
 * check hosts, never all of them: on 2026-10-30 one run started 48 checks together and workers waited an hour.
 */
export const VERIFY_CONCURRENCY = defaultPolicy.verifier.concurrency;
async function mapBounded<T, R>(items: readonly T[], limit: number, run: (item: T, index: number) => Promise<R>) {
  const results = new Array<R>(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

function installDependenciesCached(
  options: DevVerifierOptions,
  commit: string,
  tree: string,
): { passed: boolean; output: string; logPath: string } {
  const command = ['bun', 'install', '--frozen-lockfile'];
  const key = hash({
    version: 2,
    phase: 'dependency-setup',
    commit,
    command,
    closure: ['package.json', 'bun.lock'],
    environment: environmentIdentity(options.settings),
    toolchain: toolchainIdentity(options.settings, commit),
  });
  // A previous tree's successful install cannot populate this fresh tree's node_modules.
  const { stateDirectory } = options.settings;
  const logPrefix = 'dev-verify-install-';
  const logSuffix = '.log';
  const newLogPath = join(stateDirectory, `${logPrefix}${randomUUID()}${logSuffix}`);
  let result: { passed: boolean; output: string; logPath: string };
  if (!existsSync(join(tree, 'package.json'))) {
    result = { passed: true, output: '', logPath: newLogPath };
  } else if (!existsSync(join(tree, 'bun.lock'))) {
    result = {
      passed: false,
      output: 'Baseline dependency setup failed: bun.lock is absent.',
      logPath: newLogPath,
    };
  } else {
    const previousLogs = new Set(
      readdirSync(stateDirectory).filter((name) => name.startsWith(logPrefix) && name.endsWith(logSuffix)),
    );
    const passed = installDependencies(tree, stateDirectory, options.settings.policy);
    const logName = readdirSync(stateDirectory).find(
      (name) => name.startsWith(logPrefix) && name.endsWith(logSuffix) && !previousLogs.has(name),
    );
    const logPath = logName ? join(stateDirectory, logName) : newLogPath;
    let output = '';
    try {
      output = readFileSync(logPath, 'utf8');
    } catch {}
    result = { passed, output, logPath };
  }
  const run: DevVerifierRun = {
    key,
    createdAt: new Date().toISOString(),
    evidence: {
      commit,
      command,
      passed: result.passed,
      timedOut: false,
      output: result.output,
      logPath: result.logPath,
      result: result.passed ? 'pass' : 'infrastructure',
    },
  };
  if (result.passed) saveRun(options.store, run, options.settings.policy?.verifier);
  return result;
}
function makeFinding(
  check: IndexedCheck,
  base: string,
  target: string,
  assertion: string,
  status: DevVerifierFinding['status'],
  baseline: DevVerifierEvidence | null,
  headEvidence: DevVerifierEvidence | null,
  reason: string,
  result: DevVerifierResult,
): DevVerifierFinding {
  const signature = findingSignature(check, assertion);
  const identity = signature;
  const rangeKey = hash({ signature, base, target });
  return {
    rangeKey,
    identity,
    signature,
    baseCommit: base,
    headCommit: target,
    status,
    result,
    check: {
      command: [...check.command],
      closure: [...check.closure],
      ...(check.taskId ? { taskId: check.taskId } : {}),
      ...(check.cwd ? { cwd: check.cwd } : {}),
    },
    assertion,
    baseline,
    head: headEvidence,
    reason,
    ...(check.taskId ? { taskId: check.taskId } : {}),
    createdAt: new Date().toISOString(),
  };
}

function evidence(
  commit: string,
  check: Check,
  result: GateOutcome,
  logPath: string,
  policy = defaultPolicy.verifier,
): DevVerifierEvidence {
  return {
    commit,
    command: [...check.command],
    passed: result.passed,
    timedOut: result.timedOut,
    output: result.output,
    logPath,
    result: classifyRun(result, policy),
    ...(check.cwd ? { cwd: check.cwd } : {}),
  };
}

export function withTreeBun(command: readonly string[], tree: string, fallbackRoot = tree): string[] {
  let index = command[0] === 'env' ? 1 : 0;
  while (command[index] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(command[index]!)) index++;
  if (command[index] !== 'bun') return [...command];
  const artifactRoot = existsSync(join(tree, 'node_modules/bun/package.json')) ? tree : fallbackRoot;
  const executable = repositoryBun(tree, artifactRoot).binary;
  const bins = [...new Set([join(tree, 'node_modules/.bin'), join(fallbackRoot, 'node_modules/.bin')])];
  const path = [...bins, process.env.PATH ?? ''].filter(Boolean).join(':');
  return ['env', `PATH=${path}`, ...command.map((argument, position) => (position === index ? executable : argument))];
}

function forCheckAtCommit(result: DevVerifierEvidence, commit: string, check: Check): DevVerifierEvidence {
  return {
    ...result,
    commit,
    command: [...check.command],
    ...(check.cwd ? { cwd: check.cwd } : {}),
  };
}

function reusableCheckResult(
  store: DevVerifierOptions['store'],
  settings: Settings,
  commit: string,
  check: IndexedCheck,
  selection: string,
  source: RevisionSource,
): DevVerifierEvidence | undefined {
  const cached = cachedRun(store, runCacheKey(settings, commit, check, selection));
  if (cached && classifyRun(cached, settings.policy?.verifier) !== 'infrastructure')
    return forCheckAtCommit(cached, commit, check);
  const input = checkInput(settings, commit, check, source);
  const failed = input ? cachedRun(store, input) : undefined;
  return failed && classifyRun(failed, settings.policy?.verifier) === 'fail'
    ? forCheckAtCommit(failed, commit, check)
    : undefined;
}

function runCacheKey(settings: Settings, commit: string, check: IndexedCheck, selection: string): string {
  return checkRunKey(settings, commit, check, check.signature, selection);
}

async function executeCheck(
  options: DevVerifierOptions,
  run: GateRunner,
  check: IndexedCheck,
  commit: string,
  tree: string,
  key: string,
  input?: string,
): Promise<DevVerifierEvidence> {
  const cached = cachedRun(options.store, key);
  if (cached && classifyRun(cached, options.settings.policy?.verifier) !== 'infrastructure')
    return forCheckAtCommit(cached, commit, check);
  const inputFailure = input ? cachedRun(options.store, input) : undefined;
  if (inputFailure && classifyRun(inputFailure, options.settings.policy?.verifier) === 'fail')
    return forCheckAtCommit(inputFailure, commit, check);
  const policy = options.settings.policy ?? defaultPolicy;
  const attempts: string[] = [];
  let final: GateOutcome = { passed: false, output: '', timedOut: false };
  let finalLog = '';
  for (let attempt = 0; attempt < policy.verifier.checkAttempts; attempt++) {
    finalLog = join(options.settings.stateDirectory, `dev-verify-${randomUUID()}.log`);
    try {
      final = await run(
        withTreeBun(check.command, tree, options.settings.mainCheckout),
        check.cwd ? join(tree, check.cwd) : tree,
        finalLog,
      );
    } catch (error) {
      final = { passed: false, output: error instanceof Error ? error.message : String(error), timedOut: false };
    }
    attempts.push(`attempt ${attempt + 1}: ${final.output}`);
    if (final.passed || !infraFailure(final.output, final.timedOut)) break;
  }
  const fullOutput = attempts.length > 1 ? attempts.join('\n') : final.output;
  const result = evidence(commit, check, { ...final, output: fullOutput }, finalLog, options.settings.policy?.verifier);
  const createdAt = new Date().toISOString();
  if (classifyRun(result, options.settings.policy?.verifier) !== 'infrastructure')
    saveRun(options.store, { key, createdAt, evidence: result }, options.settings.policy?.verifier);
  if (input && classifyRun(result, options.settings.policy?.verifier) === 'fail')
    saveRun(options.store, { key: input, createdAt, evidence: result }, options.settings.policy?.verifier);
  return result;
}

function selectionIdentity(checks: readonly IndexedCheck[]): string {
  return hash(checks.map(({ command, closure, taskId, signature }) => ({ command, closure, taskId, signature })));
}
function commandPresentAt(options: DevVerifierOptions, commit: string, check: Check): boolean {
  return sourcePresentAt(revisionSource(options, commit, [check]), check);
}

async function compareRange(options: DevVerifierOptions, history: VerifierLandings): Promise<Comparison> {
  const { settings, store } = options;
  const { base, target } = history.interval;
  const checks: IndexedCheck[] = createChecks(settings, history, target).map((check, index) => ({
    ...check,
    index,
    signature: checkSignature(check, index),
  }));
  const selection = selectionIdentity(checks);
  const results: ComparedCheck[] = checks.map((check) => ({ check, baseline: null, head: null }));
  const targetSource = revisionSource(options, target, checks);
  const headMissing = checks.filter((check) => !sourcePresentAt(targetSource, check));
  for (const check of headMissing) {
    const item = results[check.index]!;
    item.headReason = 'The selected command source is absent at the captured head.';
  }
  let headTree: string | undefined;
  let baseTree: string | undefined;
  mkdirSync(settings.worktreeRoot, { recursive: true });
  mkdirSync(settings.stateDirectory, { recursive: true });
  try {
    const missingHeadRuns = checks.filter(
      (check) =>
        !headMissing.includes(check) && !reusableCheckResult(store, settings, target, check, selection, targetSource),
    );
    let headSetup: { passed: boolean; output: string; logPath: string } | undefined;
    if (missingHeadRuns.length) {
      headTree = join(settings.worktreeRoot, `dev-verify-${randomUUID()}`);
      git(settings.mainCheckout, 'worktree', 'add', '--detach', headTree, target);
      headSetup = installDependenciesCached(options, target, headTree);
    }
    const runner =
      options.runGate ?? gateRunner((options.settings.policy ?? defaultPolicy).verifier.standaloneGateTimeoutMs);
    const headJobs: { check: IndexedCheck; cwd: string }[] = [];
    for (const check of checks) {
      if (!headMissing.includes(check)) {
        const cached = reusableCheckResult(store, settings, target, check, selection, targetSource);
        if (cached) results[check.index]!.head = cached;
        else if (headSetup?.passed && headTree) headJobs.push({ check, cwd: headTree });
        else if (headSetup && !headSetup.passed)
          results[check.index]!.headReason = `Head dependency setup failed: ${headSetup.output}`;
      }
    }
    const headResults = await mapBounded(
      headJobs,
      (options.settings.policy ?? defaultPolicy).verifier.concurrency,
      async (job) => {
        const key = runCacheKey(settings, target, job.check, selection);
        return {
          check: job.check,
          result: await executeCheck(
            options,
            runner,
            job.check,
            target,
            job.cwd,
            key,
            checkInput(settings, target, job.check, targetSource),
          ),
        };
      },
    );
    for (const item of headResults) results[item.check.index]!.head = item.result;

    // A baseline run is needed only for a stable product failure at the head. A recovered infrastructure retry,
    // missing command, timeout or incomplete output remains unknown and is never used as a baseline negative.
    const baselineChecks = results
      .filter(({ head: result, headReason }) => {
        if (!result || result.passed || headReason) return false;
        return (
          !result.timedOut &&
          !infraFailure(result.output, result.timedOut) &&
          !unavailableFailure(result.output) &&
          !truncatedOutput(result.output) &&
          !tooManyAssertions(result.output, settings.policy?.verifier) &&
          stableAssertions(result.output, settings.policy?.verifier).length > 0
        );
      })
      .map(({ check }) => check);
    const baseSource = revisionSource(options, base, baselineChecks);
    const baseMissing = baselineChecks.filter((check) => !sourcePresentAt(baseSource, check));
    for (const check of baseMissing)
      results[check.index]!.baselineReason = 'The selected command source is absent at the exact verified baseline.';
    const missingBaselineRuns = baselineChecks.filter(
      (check) =>
        !baseMissing.includes(check) && !reusableCheckResult(store, settings, base, check, selection, baseSource),
    );
    let baseSetup: { passed: boolean; output: string; logPath: string } | undefined;
    if (missingBaselineRuns.length) {
      baseTree = join(settings.worktreeRoot, `dev-verify-base-${randomUUID()}`);
      git(settings.mainCheckout, 'worktree', 'add', '--detach', baseTree, base);
      baseSetup = installDependenciesCached(options, base, baseTree);
    }
    const baseJobs: { check: IndexedCheck; cwd: string }[] = [];
    for (const check of baselineChecks) {
      if (baseMissing.includes(check)) continue;
      const cached = reusableCheckResult(store, settings, base, check, selection, baseSource);
      if (cached) results[check.index]!.baseline = cached;
      else if (baseSetup?.passed && baseTree) baseJobs.push({ check, cwd: baseTree });
      else if (baseSetup && !baseSetup.passed)
        results[check.index]!.baselineReason = `Baseline dependency setup failed: ${baseSetup.output}`;
    }
    const baselineResults = await mapBounded(
      baseJobs,
      (options.settings.policy ?? defaultPolicy).verifier.concurrency,
      async (job) => {
        const key = runCacheKey(settings, base, job.check, selection);
        return {
          check: job.check,
          result: await executeCheck(
            options,
            runner,
            job.check,
            base,
            job.cwd,
            key,
            checkInput(settings, base, job.check, baseSource),
          ),
        };
      },
    );
    for (const item of baselineResults) results[item.check.index]!.baseline = item.result;

    const findings: DevVerifierFinding[] = [];
    const passTaskIds: string[] = [];
    for (const result of results) {
      const headResult = result.head;
      if (headResult?.passed) {
        if (result.check.taskId) passTaskIds.push(result.check.taskId);
        continue;
      }
      if (!headResult && !result.headReason) continue;
      const baseResult = result.baseline;
      let baseAssertions =
        baseResult && !baseResult.passed ? stableAssertions(baseResult.output, settings.policy?.verifier) : [];
      const headAssertions =
        headResult && !headResult.passed ? stableAssertions(headResult.output, settings.policy?.verifier) : [];
      const headUnknown =
        !headResult ||
        !!result.headReason ||
        headResult.timedOut ||
        infraFailure(headResult.output, headResult.timedOut) ||
        unavailableFailure(headResult.output) ||
        truncatedOutput(headResult.output) ||
        tooManyAssertions(headResult.output, settings.policy?.verifier) ||
        !headAssertions.length;
      const baselineUnknown =
        !baseResult ||
        !!result.baselineReason ||
        baseResult.timedOut ||
        infraFailure(baseResult.output, baseResult.timedOut) ||
        unavailableFailure(baseResult.output) ||
        truncatedOutput(baseResult.output) ||
        tooManyAssertions(baseResult.output, settings.policy?.verifier) ||
        (!baseResult.passed && !baseAssertions.length);
      const headEv = headResult;
      const baseEv = baseResult;
      if (headUnknown || baselineUnknown) {
        const message = headUnknown
          ? (result.headReason ??
            (headResult
              ? 'The head failure is infrastructure, unavailable, incomplete, or has no stable assertion.'
              : 'The head command did not run.'))
          : (result.baselineReason ??
            (baseResult
              ? 'The baseline result is infrastructure, unavailable, incomplete, or has no stable assertion.'
              : 'The baseline command did not run.'));
        const finding = makeFinding(
          result.check,
          base,
          target,
          headAssertions.join('\n') ||
            (headResult ? firstFailure(headResult.output).assertion : 'Head check unavailable'),
          'unknown',
          baseEv,
          headEv,
          message,
          headEv ? classifyRun(headEv, settings.policy?.verifier) : 'infrastructure',
        );
        saveFinding(store, finding, settings.policy?.verifier);
        findings.push(finding);
        continue;
      }

      if (baseResult?.passed) baseAssertions = [];
      for (const assertion of headAssertions) {
        const status: DevVerifierFinding['status'] = baseAssertions.includes(assertion) ? 'existing' : 'new';
        const finding = makeFinding(
          result.check,
          base,
          target,
          assertion,
          status,
          baseEv,
          headEv,
          status === 'existing'
            ? 'The same stable assertion failed at the exact previous verified baseline and current head.'
            : 'This stable assertion failed at the head and was absent at the exact previous verified baseline.',
          'fail',
        );
        findings.push(finding);
      }
    }
    return { base, head: target, checks, results, findings, passTaskIds };
  } finally {
    if (headTree) git(settings.mainCheckout, 'worktree', 'remove', '--force', headTree);
    if (baseTree) git(settings.mainCheckout, 'worktree', 'remove', '--force', baseTree);
  }
}

function suspectsFor(settings: Settings, history: VerifierLandings, check: IndexedCheck): Suspect[] {
  const { interval } = history;
  const tasks = history.tasks
    .map((task) => {
      const taskCommitList = taskCommits(task, interval);
      if (!taskCommitList.some((commit) => interval.position.has(commit))) return undefined;
      if (
        !check.closure.includes('**') &&
        !filesInCommits(interval, taskCommitList).some((file) => matches(file, check.closure, settings.policy?.brief))
      )
        return undefined;
      const commit = (task.integratedCommit ?? task.mergedCommit)!;
      return interval.position.has(commit) ? { task, commit, position: interval.position.get(commit)! } : undefined;
    })
    .filter((item): item is { task: Task; commit: string; position: number } => item !== undefined)
    .sort((a, b) => a.position - b.position);
  if (check.taskId) {
    const direct = tasks.find((item) => item.task.id === check.taskId);
    return direct ? [{ task: direct.task, commit: direct.commit }] : [];
  }
  return tasks.map(({ task, commit }) => ({ task, commit }));
}

async function probeAt(
  options: DevVerifierOptions,
  check: IndexedCheck,
  commit: string,
  selection: string,
  missingAsPass = false,
): Promise<DevVerifierEvidence | null> {
  const { settings } = options;
  const key = runCacheKey(settings, commit, check, selection);
  const cached = cachedRun(options.store, key);
  if (cached) return cached;
  if (missingAsPass && !commandPresentAt(options, commit, check))
    return evidence(commit, check, { passed: true, output: '', timedOut: false }, '');
  const tree = join(settings.worktreeRoot, `dev-verify-probe-${randomUUID()}`);
  mkdirSync(settings.worktreeRoot, { recursive: true });
  mkdirSync(settings.stateDirectory, { recursive: true });
  git(settings.mainCheckout, 'worktree', 'add', '--detach', tree, commit);
  try {
    const installed = installDependenciesCached(options, commit, tree);
    if (!installed.passed) return null;
    if (!commandPresentAt(options, commit, check))
      return missingAsPass ? evidence(commit, check, { passed: true, output: '', timedOut: false }, '') : null;
    const result = await executeCheck(
      options,
      options.runGate ?? gateRunner((options.settings.policy ?? defaultPolicy).verifier.standaloneGateTimeoutMs),
      check,
      commit,
      tree,
      key,
    );
    if (
      result.timedOut ||
      infraFailure(result.output, result.timedOut) ||
      unavailableFailure(result.output) ||
      truncatedOutput(result.output) ||
      tooManyAssertions(result.output, settings.policy?.verifier)
    )
      return null;
    return result;
  } finally {
    git(settings.mainCheckout, 'worktree', 'remove', '--force', tree);
  }
}

function containsAssertion(
  result: DevVerifierEvidence | null,
  assertion: string,
  policy = defaultPolicy.verifier,
): boolean | null {
  if (!result) return null;
  if (
    result.timedOut ||
    infraFailure(result.output, result.timedOut) ||
    unavailableFailure(result.output) ||
    truncatedOutput(result.output) ||
    tooManyAssertions(result.output, policy)
  )
    return null;
  return !result.passed && stableAssertions(result.output, policy).includes(assertion);
}

async function proveExistingOrReintroduced(
  options: DevVerifierOptions,
  check: IndexedCheck,
  assertion: string,
  suspects: readonly Suspect[],
  selection: string,
  missingAsPass = false,
): Promise<ExistingProbe> {
  if (knownExisting(options.store, findingSignature(check, assertion), options.settings.policy?.verifier))
    return { status: 'existing' };
  if (suspects.length < 2) return { status: 'existing' };
  const probeLimit = (options.settings.policy ?? defaultPolicy).verifier.existingProbes;
  const sampleIndexes = Array.from({ length: suspects.length - 1 }, (_, index) => index);
  const selected =
    sampleIndexes.length <= probeLimit
      ? sampleIndexes
      : Array.from({ length: probeLimit }, (_, index) =>
          Math.floor((index * (sampleIndexes.length - 1)) / Math.max(1, probeLimit - 1)),
        );
  const unique = [...new Set(selected)];
  const probes = await mapBounded(
    unique,
    (options.settings.policy ?? defaultPolicy).verifier.concurrency,
    async (index) => {
      const evidence = await probeAt(options, check, suspects[index]!.commit, selection, missingAsPass);
      return { index, contains: containsAssertion(evidence, assertion, options.settings.policy?.verifier) };
    },
  );
  const clean = probes.filter((item) => item.contains === false).map((item) => item.index);
  if (!clean.length) {
    if (probes.some((item) => item.contains === null) || unique.length < sampleIndexes.length)
      return { status: 'unknown' };
    return { status: 'existing' };
  }
  return { status: 'new', cleanIndex: Math.max(...clean) };
}

async function locateNewFailure(
  options: DevVerifierOptions,
  check: IndexedCheck,
  assertion: string,
  suspects: readonly Suspect[],
  selection: string,
  cleanIndex?: number,
  missingAsPass = false,
): Promise<Task | undefined | null> {
  if (!suspects.length) return undefined;
  if (cleanIndex === undefined && suspects.length === 1) return suspects[0]!.task;
  let low = cleanIndex === undefined ? 0 : cleanIndex + 1;
  let high = suspects.length - 1;
  if (low > high) return null;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const outcome = await probeAt(options, check, suspects[middle]!.commit, selection, missingAsPass);
    const contains = containsAssertion(outcome, assertion, options.settings.policy?.verifier);
    if (contains === null) return null;
    if (contains) high = middle;
    else low = middle + 1;
  }
  const evidence = await probeAt(options, check, suspects[low]!.commit, selection, missingAsPass);
  const contains = containsAssertion(evidence, assertion, options.settings.policy?.verifier);
  return contains === null ? null : contains ? suspects[low]!.task : undefined;
}

function groupNewFindings(findings: readonly DevVerifierFinding[], checks: readonly IndexedCheck[]): FindingGroup[] {
  const groups = new Map<number, FindingGroup>();
  for (const finding of findings) {
    if (finding.status !== 'new') continue;
    const check = checks.find((candidate) => candidate.signature === checkSignature(finding.check, candidate.index));
    if (!check) continue;
    let group = groups.get(check.index);
    if (!group) {
      group = { check, findings: [], targets: [] };
      groups.set(check.index, group);
    }
    group.findings.push(finding);
    group.targets.push(finding.assertion);
  }
  return [...groups.values()].map((group) => ({ ...group, targets: [...new Set(group.targets)] }));
}

function saveComparisonFindings(
  store: DevVerifierOptions['store'],
  comparison: Comparison,
  policy = defaultPolicy.verifier,
): void {
  for (const finding of comparison.findings) saveFinding(store, finding, policy);
}

function advanceVerified(
  settings: Settings,
  store: DevVerifierOptions['store'],
  expectedBase: string,
  expectedDev: string,
  history: VerifierLandings,
  passedTaskIds: ReadonlySet<string>,
): boolean {
  try {
    if (head(settings.mainCheckout, settings.integrationBranch) !== expectedDev) return false;
    git(settings.mainCheckout, 'update-ref', ref(verifiedBranch), history.interval.target, expectedBase);
    recordVerified(store, history, passedTaskIds);
    return true;
  } catch {
    // Concurrent ref movement wins; the next verifier starts from the new exact pair.
    return false;
  }
}

function updateFindingOwner(
  options: DevVerifierOptions,
  findings: readonly DevVerifierFinding[],
  task: Task | undefined,
  reason: string,
): void {
  for (const finding of findings) {
    finding.reason = reason;
    if (task) finding.taskId = task.id;
    saveFinding(options.store, finding, options.settings.policy?.verifier);
  }
}

async function revertCulprits(
  options: DevVerifierOptions,
  history: VerifierLandings,
  culprits: readonly { task: Task; findings: DevVerifierFinding[] }[],
): Promise<string | undefined> {
  if (!culprits.length) return undefined;
  const { settings, store } = options;
  const checkout = settings.mainCheckout;
  const { interval } = history;
  const target = interval.target;
  const tree = join(settings.worktreeRoot, `dev-verify-revert-${randomUUID()}`);
  mkdirSync(settings.worktreeRoot, { recursive: true });
  git(checkout, 'worktree', 'add', '--detach', tree, target);
  try {
    git(tree, 'reset', '--hard', target);
    git(tree, 'clean', '-fdx');
    const selectedCommits = [...new Set(culprits.flatMap(({ task }) => taskCommits(task, interval)))]
      .filter((commit) => interval.position.has(commit))
      .sort((a, b) => interval.position.get(b)! - interval.position.get(a)!);
    if (!selectedCommits.length) return undefined;
    const reverted = spawnSync('git', ['revert', '--no-commit', ...selectedCommits], {
      cwd: tree,
      encoding: 'utf8',
      maxBuffer: (settings.policy ?? defaultPolicy).verifier.gitBufferBytes,
    });
    if (reverted.status !== 0)
      throw new Error(`Could not revert verifier culprit changes: ${reverted.stderr || reverted.stdout}`);
    const labels = culprits.map(({ task }) => task.id).join(', ');
    const committed = spawnSync('git', ['commit', '-m', `revert: ${labels} after dev verification`], {
      cwd: tree,
      encoding: 'utf8',
      maxBuffer: (settings.policy ?? defaultPolicy).verifier.gitBufferBytes,
    });
    if (committed.status !== 0) throw new Error(`Could not commit verifier revert: ${committed.stderr}`);
    const revertHead = git(tree, 'rev-parse', 'HEAD');
    if (head(checkout, settings.integrationBranch) !== target) return undefined;
    git(checkout, 'update-ref', ref(settings.integrationBranch), revertHead, target);
    for (const { task, findings } of culprits) {
      const current = store.task(task.id);
      store.updateTask({ taskId: task.id, attempt: current.currentAttempt }, (item) => {
        item.state = 'stopped';
        delete item.integratedCommit;
        delete item.integratedCommits;
        delete item.integratedBase;
      });
      const first = findings[0]!;
      const output = first.head?.output ?? '';
      options.inbox.deliver({
        managerId: task.brief.manager,
        taskId: task.id,
        kind: 'instruction',
        evidencePath: first.head?.logPath ?? '',
        summary: `Landing ${task.id} was reverted from dev after ${first.check.command.join(' ')} failed. Log: ${first.head?.logPath ?? '(no log)'}\n${output.slice(-(settings.policy ?? defaultPolicy).verifier.diagnosticCharacters)}`,
      });
    }
    return revertHead;
  } finally {
    git(checkout, 'worktree', 'remove', '--force', tree);
  }
}

async function reconcile(
  options: DevVerifierOptions,
  history: VerifierLandings,
): Promise<{ comparison: Comparison; unknown: boolean; groups: FindingGroup[] }> {
  const comparison = await compareRange(options, history);
  const selection = selectionIdentity(comparison.checks);
  const groups = groupNewFindings(comparison.findings, comparison.checks);
  const unknownChecks = comparison.results.filter(
    (item) =>
      item.headReason ||
      (item.head &&
        !item.head.passed &&
        comparison.findings.some(
          (finding) =>
            finding.check.command.join('\0') === item.check.command.join('\0') && finding.status === 'unknown',
        )),
  );
  const unknown = unknownChecks.length > 0 || comparison.findings.some((finding) => finding.status === 'unknown');

  // A matching baseline assertion is ordinarily pre-existing. When another landing first made that assertion pass,
  // then a later landing made it fail again, inspect bounded exact prefixes so the regression returns to its owner.
  const matchedExisting = comparison.findings.filter((finding) => finding.status === 'existing');
  const proof: { finding: DevVerifierFinding; status: ExistingProbe['status']; cleanIndex?: number }[] = [];
  for (const finding of matchedExisting) {
    const check = comparison.checks.find((item) => item.signature === checkSignature(finding.check, item.index));
    if (!check) {
      proof.push({ finding, status: 'unknown' });
      continue;
    }
    const suspects = suspectsFor(options.settings, history, check);
    const result = await proveExistingOrReintroduced(options, check, finding.assertion, suspects, selection);
    proof.push({
      finding,
      status: result.status,
      ...(result.cleanIndex !== undefined ? { cleanIndex: result.cleanIndex } : {}),
    });
  }
  for (const item of proof) {
    if (item.status === 'new') {
      item.finding.status = 'new';
      item.finding.reason = 'The same assertion passed at an intermediate landing prefix and failed again at the head.';
      const group = groups.find(
        (candidate) => candidate.check.signature === checkSignature(item.finding.check, candidate.check.index),
      );
      if (group) {
        group.findings.push(item.finding);
        group.targets = [...new Set([...group.targets, item.finding.assertion])];
      } else {
        const check = comparison.checks.find(
          (candidate) => candidate.signature === checkSignature(item.finding.check, candidate.index),
        );
        if (check) groups.push({ check, findings: [item.finding], targets: [item.finding.assertion] });
      }
    } else if (item.status === 'unknown') {
      item.finding.status = 'unknown';
      item.finding.reason =
        'The bounded prefix comparison could not establish whether this matching assertion was pre-existing.';
    }
  }
  saveComparisonFindings(options.store, comparison, options.settings.policy?.verifier);
  return { comparison, unknown: unknown || proof.some((item) => item.status === 'unknown'), groups };
}

async function dispatchBootOwner(
  options: DevVerifierOptions,
  check: IndexedCheck,
  assertion: string,
  evidence: DevVerifierEvidence,
  verified: string,
  target: string,
): Promise<void> {
  const test = bootSmokeTestPath(check);
  const selection = selectionIdentity([check]);
  const baseline = await probeAt(options, check, verified, selection, true);
  if (containsAssertion(baseline, assertion, options.settings.policy?.verifier) === true) return;
  const suspects = suspectsFor(
    options.settings,
    projectVerifierLandings(options.settings.mainCheckout, options.store, verified, target),
    check,
  );
  const owner = await locateNewFailure(options, check, assertion, suspects, selection, undefined, true);
  if (!owner) return;
  const existing = openBootRepair(options.store, test);
  options.dispatchRepair?.({
    test,
    commit: owner.integratedCommit ?? owner.mergedCommit ?? target,
    error: evidence.output,
    owner,
    ...(existing ? { existingTaskId: existing.id } : {}),
  });
}

async function smokeHead(options: DevVerifierOptions, verified: string, target: string): Promise<boolean> {
  const { settings } = options;
  const checks = bootSmokeChecks(settings, target);
  if (!checks.length) return false;
  const selection = selectionIdentity(checks);
  const runner =
    options.runBootSmoke ??
    options.runGate ??
    gateRunner((settings.policy ?? defaultPolicy).verifier.bootSmokeTimeoutMs);
  const tree = join(settings.worktreeRoot, `dev-verify-boot-${randomUUID()}`);
  mkdirSync(settings.worktreeRoot, { recursive: true });
  mkdirSync(settings.stateDirectory, { recursive: true });
  git(settings.mainCheckout, 'worktree', 'add', '--detach', tree, target);
  try {
    const setup = installDependenciesCached(options, target, tree);
    if (!setup.passed) return false;
    const source = revisionSource(options, target, checks);
    let failed = false;
    for (const check of checks) {
      const result = await executeCheck(
        options,
        runner,
        check,
        target,
        tree,
        runCacheKey(settings, target, check, selection),
        checkInput(settings, target, check, source),
      );
      const assertions = result.passed ? [] : stableAssertions(result.output, settings.policy?.verifier);
      const status = result.passed ? 'pass' : classifyRun(result, settings.policy?.verifier);
      if (status !== 'fail' || !assertions.length) {
        if (!result.passed) {
          saveFinding(
            options.store,
            makeFinding(
              check,
              verified,
              target,
              assertions.join('\n') || firstFailure(result.output).assertion,
              'unknown',
              null,
              result,
              'Boot smoke did not yield a stable product assertion.',
              status === 'pass' ? 'infrastructure' : status,
            ),
            settings.policy?.verifier,
          );
        }
        continue;
      }
      failed = true;
      const assertion = assertions[0]!;
      const finding = makeFinding(
        check,
        verified,
        target,
        assertion,
        'new',
        null,
        result,
        'Boot smoke failed at the newest dev head.',
        'fail',
      );
      saveFinding(options.store, finding, settings.policy?.verifier);
      await dispatchBootOwner(options, check, assertion, result, verified, target);
    }
    return failed;
  } finally {
    git(settings.mainCheckout, 'worktree', 'remove', '--force', tree);
  }
}

async function smokeNewestHeads(options: DevVerifierOptions, verified: string): Promise<boolean> {
  const checkout = options.settings.mainCheckout;
  let smoked: string | undefined;
  let failed = false;
  while (true) {
    const latest = head(checkout, options.settings.integrationBranch);
    if (latest === smoked || latest === verified) return failed;
    if (spawnSync('git', ['merge-base', '--is-ancestor', verified, latest], { cwd: checkout }).status !== 0)
      return failed;
    if (await smokeHead(options, verified, latest)) failed = true;
    smoked = latest;
  }
}

/** Verify a fixed dev head; the ref moves only after a compare-and-swap against that exact head. */
export async function verifyDev(options: DevVerifierOptions): Promise<void> {
  const { settings, store } = options,
    checkout = settings.mainCheckout;
  const lock = acquireDirectoryLease(join(settings.stateDirectory, 'dev-verifier.lease'), settings.policy?.leases);
  try {
    const captured = head(checkout, settings.integrationBranch);
    let verified: string;
    try {
      verified = head(checkout, verifiedBranch);
    } catch {
      // The train already checked every landing before this verifier was introduced.
      try {
        git(checkout, 'update-ref', ref(verifiedBranch), captured, '');
      } catch {
        /* another verifier initialized it */
      }
      return;
    }
    if (
      verified === captured ||
      spawnSync('git', ['merge-base', '--is-ancestor', verified, captured], { cwd: checkout }).status !== 0
    )
      return;

    const bootFailed = await smokeNewestHeads(options, verified);
    const dev = head(checkout, settings.integrationBranch);
    if (
      verified === dev ||
      spawnSync('git', ['merge-base', '--is-ancestor', verified, dev], { cwd: checkout }).status !== 0
    )
      return;

    const history = projectVerifierLandings(checkout, store, verified, dev);
    const initial = await reconcile(options, history);
    const initialUnknown = initial.unknown;
    let finalHead = dev;
    let finalHistory = history;
    let finalPassedTasks = new Set(initial.comparison.passTaskIds);
    if (initial.groups.length) {
      const owned: { group: FindingGroup; owners: Task[]; unknownOwner: boolean }[] = [];
      for (const group of initial.groups) {
        const suspects = suspectsFor(settings, history, group.check);
        const owners: Task[] = [];
        let unknownOwner = false;
        for (const assertion of group.targets) {
          const finding = group.findings.find((item) => item.assertion === assertion)!;
          if (group.check.taskId) {
            const direct = suspects.find((item) => item.task.id === group.check.taskId)?.task;
            if (direct) owners.push(direct);
            else unknownOwner = true;
            continue;
          }
          // If the baseline failed the same assertion, a clean intermediate prefix gives the lower bound for owner
          // bisection. New assertions use the ordinary first-failing-prefix search from the verified base.
          const baseHasAssertion =
            finding.baseline !== null &&
            !finding.baseline.passed &&
            stableAssertions(finding.baseline.output, settings.policy?.verifier).includes(assertion);
          let cleanIndex: number | undefined;
          if (baseHasAssertion) {
            const proof = await proveExistingOrReintroduced(
              options,
              group.check,
              assertion,
              suspects,
              selectionIdentity(initial.comparison.checks),
            );
            if (proof.status === 'unknown') {
              unknownOwner = true;
              updateFindingOwner(
                options,
                [finding],
                undefined,
                'New failure is visible, but its owner is unknown because prefix evidence was incomplete.',
              );
              continue;
            }
            if (proof.status === 'existing') {
              updateFindingOwner(
                options,
                [finding],
                undefined,
                'Failure is pre-existing on the exact baseline; no landing was assigned.',
              );
              continue;
            }
            cleanIndex = proof.cleanIndex;
          }
          const owner = await locateNewFailure(
            options,
            group.check,
            assertion,
            suspects,
            selectionIdentity(initial.comparison.checks),
            cleanIndex,
          );
          if (owner === null) unknownOwner = true;
          else if (owner) owners.push(owner);
          else unknownOwner = true;
          updateFindingOwner(
            options,
            [finding],
            owner ?? undefined,
            owner
              ? `New failure attributed to the owning landing ${owner.id}.`
              : 'New failure has no proven owner in the captured verified range.',
          );
        }
        owned.push({ group, owners: [...new Map(owners.map((task) => [task.id, task])).values()], unknownOwner });
      }
      const byTask = new Map<string, { task: Task; findings: DevVerifierFinding[] }>();
      for (const item of owned) {
        for (const task of item.owners) {
          const entry = byTask.get(task.id) ?? { task, findings: [] };
          entry.findings.push(...item.group.findings);
          byTask.set(task.id, entry);
        }
      }
      for (const entry of byTask.values()) {
        entry.findings = [...new Map(entry.findings.map((finding) => [finding.identity, finding])).values()];
      }
      if (!byTask.size) return;
      const postRevert = await revertCulprits(options, history, [...byTask.values()]);
      if (!postRevert) return;
      finalHead = postRevert;
      finalHistory = projectVerifierLandings(checkout, store, verified, postRevert);
      const afterRevert = await reconcile(options, finalHistory);
      if (afterRevert.unknown || afterRevert.groups.length) return;
      finalPassedTasks = new Set(afterRevert.comparison.passTaskIds);
    } else if (initialUnknown) {
      return;
    }
    if (bootFailed) return;
    advanceVerified(settings, store, verified, finalHead === dev ? dev : finalHead, finalHistory, finalPassedTasks);
  } catch (error) {
    if (error instanceof LeaseHeldError) return;
    throw error;
  } finally {
    lock.release();
  }
}

export function devVerificationState(
  cwd: string,
  stateDirectory?: string,
  integrationBranch = 'dev',
  tasks?: readonly Task[],
): {
  head: string | null;
  behind: number | null;
  state: string;
  findings: VerificationFindingCounts;
  releaseGate: 'full-gate-required';
} {
  try {
    const verified = head(cwd, verifiedBranch),
      dev = head(cwd, integrationBranch);
    const landed = new Set(git(cwd, 'rev-list', '--reverse', `${verified}..${dev}`).split('\n').filter(Boolean));
    const behind = tasks
      ? tasks.filter(
          (task) =>
            (task.integratedCommit ?? task.mergedCommit) && landed.has(task.integratedCommit ?? task.mergedCommit!),
        ).length
      : landed.size;
    const running = stateDirectory !== undefined && existsSync(join(stateDirectory, 'dev-verifier.lease'));
    return {
      head: verified,
      behind,
      state: running ? 'running' : behind ? 'pending' : 'current',
      findings: readFindingCounts(stateDirectory),
      releaseGate: 'full-gate-required',
    };
  } catch {
    return {
      head: null,
      behind: null,
      state: 'uninitialized',
      findings: readFindingCounts(stateDirectory),
      releaseGate: 'full-gate-required',
    };
  }
}
