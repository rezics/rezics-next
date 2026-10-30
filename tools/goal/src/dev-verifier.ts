import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import type { Settings, Task, DevVerifierEvidence, DevVerifierFinding, DevVerifierRun } from './types.ts';
import type { WorkerStore } from './store.ts';
import type { SqliteManagerInbox } from './inbox.ts';
import { matchesPath } from './briefs.ts';
import { firstFailure, gateEnvironment, gateRunner, git, type GateRunner } from './merge.ts';
import { acquireDirectoryLease, LeaseHeldError } from './lease.ts';
import { recordFlow } from './flow.ts';
import type { Database as DatabaseType } from 'bun:sqlite';
import { CHECK_HOST_TRANSPORT } from './records.ts';

const ref = (branch: string) => `refs/heads/${branch}`;
const verifiedBranch = 'dev-verified';
const skippedKinds = new Set(['specification', 'research']);
const MAX_FINDING_ASSERTIONS = 64;
const MAX_EXISTING_PROBES = 8;
const FINDING_LIMIT = 2000;
const RUN_LIMIT = 5000;
type Check = { command: string[]; closure: string[]; taskId?: string };
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
function changedFiles(cwd: string, base: string, target: string): string[] {
  return git(cwd, 'diff', '--name-only', '-z', `${base}..${target}`).split('\0').filter(Boolean);
}
function commits(cwd: string, base: string, target: string): string[] {
  return git(cwd, 'rev-list', '--reverse', `${base}..${target}`).split('\n').filter(Boolean);
}
function matches(file: string, paths: readonly string[]): boolean {
  return paths.some((path) => matchesPath(file, [path]));
}
function taskCommits(task: Task, cwd: string): string[] {
  if (task.integratedCommits?.length) return task.integratedCommits;
  const commit = task.integratedCommit ?? task.mergedCommit;
  if (!commit) return [];
  return git(cwd, 'rev-list', '--reverse', `${task.integratedBase ?? task.base}..${commit}`)
    .split('\n')
    .filter(Boolean);
}
function filesInCommits(cwd: string, commitList: readonly string[]): string[] {
  const files = new Set<string>();
  for (const commit of commitList)
    for (const file of git(cwd, 'diff-tree', '--root', '--no-commit-id', '--name-only', '-r', commit)
      .split('\n')
      .filter(Boolean))
      files.add(file);
  return [...files];
}
function taskLandings(settings: Settings, store: Pick<WorkerStore, 'tasks'>, base: string, target: string): Task[] {
  const landed = new Set(commits(settings.mainCheckout, base, target));
  return store
    .tasks()
    .filter(
      (task) =>
        ['integrated', 'merged'].includes(task.state) &&
        (task.integratedCommit ?? task.mergedCommit) &&
        [...(task.integratedCommits ?? []), task.integratedCommit ?? task.mergedCommit!].some((commit) =>
          landed.has(commit),
        ) &&
        task.brief.kind !== undefined &&
        !skippedKinds.has(task.brief.kind),
    );
}
function recordVerified(
  settings: Settings,
  store: Pick<WorkerStore, 'tasks'> & { db?: DatabaseType },
  base: string,
  target: string,
  passedTaskIds: ReadonlySet<string>,
): void {
  if (!store.db) return;
  const at = new Date().toISOString();
  for (const task of taskLandings(settings, store, base, target)) {
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
function createChecks(settings: Settings, store: Pick<WorkerStore, 'tasks'>, base: string, target: string): Check[] {
  const checkout = settings.mainCheckout;
  const files = changedFiles(checkout, base, target);
  if (!files.length) return [];
  const typecheck = ['bun', 'scripts/typecheck.ts'];
  const checks: Check[] = [
    { command: ['env', `TYPECHECK_CHANGED=${files.join('\n')}`, ...typecheck], closure: ['**'] },
  ];
  for (const affected of settings.affectedTests ?? []) {
    const selected = files.some((file) => matches(file, affected.paths));
    if (selected) checks.push({ command: [...affected.command], closure: [...affected.paths] });
  }
  for (const task of taskLandings(settings, store, base, target))
    checks.push({ command: [...task.brief.acceptance.command], closure: [...task.brief.paths], taskId: task.id });
  return checks;
}
function infraFailure(output: string, timedOut: boolean): boolean {
  return (
    timedOut ||
    CHECK_HOST_TRANSPORT.test(output) ||
    /ETIMEDOUT|timed out|timeout while (?:starting|creating|setting up).*docker|(?:ssh|rsync).*?(?:exit(?:ed)? 255|code 255|status 255)/i.test(
      output,
    )
  );
}
function unavailableFailure(output: string): boolean {
  return /(?:command|executable|script|module|package|dependency).{0,50}(?:not found|missing|cannot be found|not configured|unknown)|cannot find (?:module|package)|module not found|ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|no such file or directory|ENOENT|permission denied|not recognized as an internal or external command/i.test(
    output,
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
  return [...new Set(assertion.split('\n').map((line) => line.trim()).filter(Boolean))];
}
function stableAssertions(output: string): string[] {
  return assertionLines(output).slice(0, MAX_FINDING_ASSERTIONS);
}
function tooManyAssertions(output: string): boolean {
  return assertionLines(output).length > MAX_FINDING_ASSERTIONS;
}
function environmentIdentity(settings: Settings): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(gateEnvironment(process.env, settings.stateDirectory)).sort(([left], [right]) => left.localeCompare(right)),
  );
}
function toolchainIdentity(settings: Settings): unknown {
  let remoteHosts: string | null = null;
  try {
    remoteHosts = readFileSync(join(settings.stateDirectory, 'remote-check-hosts.json'), 'utf8');
  } catch {}
  return {
    bun: Bun.version,
    bunRevision: Bun.revision,
    platform: process.platform,
    arch: process.arch,
    host: hostname(),
    noCompileCache: '1',
    remoteHosts,
  };
}
function checkSignature(check: Check, index: number): string {
  return hash({
    version: 1,
    index,
    command: check.command,
    closure: [...check.closure].sort(),
    taskId: check.taskId ?? null,
  });
}
function findingSignature(check: Check, assertion: string): string {
  return hash({
    version: 1,
    command: check.command.filter((argument) => !/^TYPECHECK_CHANGED=/.test(argument)),
    closure: [...check.closure].sort(),
    taskId: check.taskId ?? null,
    assertion,
  });
}
function checkRunKey(settings: Settings, commit: string, check: Check, signature: string, selection: string): string {
  return hash({
    version: 1,
    commit,
    signature,
    selection,
    command: check.command,
    closure: [...check.closure].sort(),
    environment: environmentIdentity(settings),
    toolchain: toolchainIdentity(settings),
  });
}
function checkSourcePaths(command: readonly string[]): string[] {
  let index = 0;
  if (command[index] === 'env') {
    index++;
    while (command[index] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(command[index]!)) index++;
  }
  const program = basename(command[index] ?? '');
  if (!['bun', 'node', 'tsx', 'ts-node', 'python', 'python3', 'sh', 'bash', 'deno'].includes(program)) return [];
  const paths: string[] = [];
  for (let cursor = index + 1; cursor < command.length; cursor++) {
    const arg = command[cursor]!;
    if (arg === '--cwd' || arg === '--config' || arg === '--loader' || arg === '-r' || arg === '--require') {
      cursor++;
      continue;
    }
    if (['run', 'test', 'x', 'exec', 'check', 'fmt', 'lint', '-e', '-c', '--eval'].includes(arg)) {
      if (['-e', '-c', '--eval'].includes(arg)) cursor++;
      continue;
    }
    if (arg.startsWith('-') || arg.includes('=') || /^https?:/.test(arg)) continue;
    if (/[./\\]/.test(arg) || /\.(?:[cm]?[jt]sx?|py|sh|json)$/i.test(arg)) paths.push(arg);
  }
  return paths;
}
function sourcePresentAt(cwd: string, commit: string, command: readonly string[]): boolean {
  for (const candidate of checkSourcePaths(command)) {
    if (candidate.startsWith('/')) continue;
    const path = candidate.replace(/^[.][/\\]/, '').replaceAll('\\', '/');
    const result = spawnSync('git', ['cat-file', '-e', `${commit}:${path}`], { cwd, encoding: 'utf8' });
    if (result.status !== 0) return false;
  }
  return true;
}
function installDependencies(tree: string, stateDirectory: string): { passed: boolean; output: string; logPath: string } {
  const logPath = join(stateDirectory, `dev-verify-install-${randomUUID()}.log`);
  if (!existsSync(join(tree, 'package.json')))
    return { passed: true, output: '', logPath };
  if (!existsSync(join(tree, 'bun.lock')))
    return { passed: false, output: 'Baseline dependency setup failed: bun.lock is absent.', logPath };
  let output = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = spawnSync('bun', ['install', '--frozen-lockfile'], { cwd: tree, encoding: 'utf8' });
    const attemptOutput = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `${result.error.message}\n` : ''}`;
    output += `$ bun install --frozen-lockfile (attempt ${attempt + 1})\n${attemptOutput}`;
    appendFileSync(logPath, `$ bun install --frozen-lockfile (attempt ${attempt + 1})\n${attemptOutput}`);
    if (result.status === 0) return { passed: true, output, logPath };
  }
  return { passed: false, output, logPath };
}

export type DevVerifierOptions = {
  settings: Settings;
  store: Pick<WorkerStore, 'tasks' | 'task' | 'updateTask'> & {
    db?: DatabaseType;
    devVerifierRun?: (key: string) => DevVerifierRun | undefined;
    saveDevVerifierRun?: (run: DevVerifierRun) => void;
    devVerifierFindings?: (limit?: number) => DevVerifierFinding[];
    devVerifierHasKnownExisting?: (signature: string) => boolean;
    saveDevVerifierFinding?: (finding: DevVerifierFinding) => void;
  };
  inbox: Pick<SqliteManagerInbox, 'deliver'>;
  runGate?: GateRunner;
};

/**
 * Checks the verifier runs at once. It verifies after integration at ordinary priority, so it takes a share of the
 * check hosts, never all of them: on 2026-10-30 one run started 48 checks together and workers waited an hour.
 */
export const VERIFY_CONCURRENCY = 3;
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

function cachedRun(store: DevVerifierOptions['store'], key: string): DevVerifierEvidence | undefined {
  try {
    const run = store.devVerifierRun?.(key);
    if (run) return run.evidence;
    if (!store.db) return undefined;
    const row = store.db.query('SELECT body FROM dev_verifier_runs WHERE cache_key=?').get(key) as
      | { body: string }
      | undefined;
    return row ? (JSON.parse(row.body) as DevVerifierRun).evidence : undefined;
  } catch {
    return undefined;
  }
}
function saveRun(store: DevVerifierOptions['store'], run: DevVerifierRun): void {
  try {
    if (store.saveDevVerifierRun) {
      store.saveDevVerifierRun(run);
      return;
    }
    if (!store.db) return;
    store.db
      .query('INSERT OR REPLACE INTO dev_verifier_runs VALUES (?,?,?)')
      .run(run.key, run.createdAt, JSON.stringify(run));
    store.db
      .query(
        `DELETE FROM dev_verifier_runs WHERE cache_key IN (SELECT cache_key FROM dev_verifier_runs ORDER BY rowid DESC LIMIT -1 OFFSET ${RUN_LIMIT})`,
      )
      .run();
  } catch {
    // A failed cache write cannot change the fresh gate result.
  }
}

function installDependenciesCached(
  options: DevVerifierOptions,
  commit: string,
  tree: string,
): { passed: boolean; output: string; logPath: string } {
  const command = ['bun', 'install', '--frozen-lockfile'];
  const key = hash({
    version: 1,
    phase: 'dependency-setup',
    commit,
    command,
    closure: ['package.json', 'bun.lock'],
    environment: environmentIdentity(options.settings),
    toolchain: toolchainIdentity(options.settings),
  });
  const cached = cachedRun(options.store, key);
  if (cached) return { passed: cached.passed, output: cached.output, logPath: cached.logPath };
  const result = installDependencies(tree, options.settings.stateDirectory);
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
    },
  };
  saveRun(options.store, run);
  return result;
}
function knownExisting(store: DevVerifierOptions['store'], signature: string): boolean {
  try {
    if (store.devVerifierHasKnownExisting) return store.devVerifierHasKnownExisting(signature);
    if (store.devVerifierFindings) return store.devVerifierFindings(FINDING_LIMIT).some((item) => item.signature === signature && item.status === 'existing');
    return Boolean(
      store.db
        ?.query("SELECT 1 FROM dev_verifier_findings WHERE signature=? AND status='existing' LIMIT 1")
        .get(signature),
    );
  } catch {
    return false;
  }
}
function saveFinding(store: DevVerifierOptions['store'], finding: DevVerifierFinding): void {
  try {
    if (store.saveDevVerifierFinding) {
      store.saveDevVerifierFinding(finding);
      return;
    }
    if (!store.db) return;
    store.db
      .query('INSERT OR REPLACE INTO dev_verifier_findings VALUES (?,?,?,?,?,?,?,?)')
      .run(
        finding.rangeKey,
        finding.identity,
        finding.signature,
        finding.baseCommit,
        finding.headCommit,
        finding.status,
        finding.createdAt,
        JSON.stringify(finding),
      );
    store.db
      .query(
        `DELETE FROM dev_verifier_findings WHERE range_key IN (SELECT range_key FROM dev_verifier_findings ORDER BY rowid DESC LIMIT -1 OFFSET ${FINDING_LIMIT})`,
      )
      .run();
  } catch {
    // Findings are durable when the store is available, but persistence failure does not rewrite check outcomes.
  }
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
    check: {
      command: [...check.command],
      closure: [...check.closure],
      ...(check.taskId ? { taskId: check.taskId } : {}),
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
): DevVerifierEvidence {
  return {
    commit,
    command: [...check.command],
    passed: result.passed,
    timedOut: result.timedOut,
    output: result.output,
    logPath,
  };
}

function runCacheKey(settings: Settings, commit: string, check: IndexedCheck, selection: string): string {
  return checkRunKey(settings, commit, check, check.signature, selection);
}

async function executeCheck(
  options: DevVerifierOptions,
  run: GateRunner,
  check: IndexedCheck,
  commit: string,
  cwd: string,
  key: string,
): Promise<DevVerifierEvidence> {
  const cached = cachedRun(options.store, key);
  if (cached) return cached;
  const attempts: string[] = [];
  let final: GateOutcome = { passed: false, output: '', timedOut: false };
  let finalLog = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    finalLog = join(options.settings.stateDirectory, `dev-verify-${randomUUID()}.log`);
    try {
      final = await run(check.command, cwd, finalLog);
    } catch (error) {
      final = { passed: false, output: error instanceof Error ? error.message : String(error), timedOut: false };
    }
    attempts.push(`attempt ${attempt + 1}: ${final.output}`);
    if (final.passed || !infraFailure(final.output, final.timedOut)) break;
  }
  const fullOutput = attempts.length > 1 ? attempts.join('\n') : final.output;
  const result = evidence(commit, check, { ...final, output: fullOutput }, finalLog);
  saveRun(options.store, { key, createdAt: new Date().toISOString(), evidence: result });
  return result;
}

function selectionIdentity(checks: readonly IndexedCheck[]): string {
  return hash(checks.map(({ command, closure, taskId, signature }) => ({ command, closure, taskId, signature })));
}
function commandPresentAt(settings: Settings, commit: string, check: Check): boolean {
  return sourcePresentAt(settings.mainCheckout, commit, check.command);
}

async function compareRange(
  options: DevVerifierOptions,
  base: string,
  target: string,
): Promise<Comparison> {
  const { settings, store } = options;
  const checks: IndexedCheck[] = createChecks(settings, store, base, target).map((check, index) => ({
    ...check,
    index,
    signature: checkSignature(check, index),
  }));
  const selection = selectionIdentity(checks);
  const results: ComparedCheck[] = checks.map((check) => ({ check, baseline: null, head: null }));
  const headMissing = checks.filter((check) => !commandPresentAt(settings, target, check));
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
      (check) => !headMissing.includes(check) && !cachedRun(store, runCacheKey(settings, target, check, selection)),
    );
    let headSetup: { passed: boolean; output: string; logPath: string } | undefined;
    if (missingHeadRuns.length) {
      headTree = join(settings.worktreeRoot, `dev-verify-${randomUUID()}`);
      git(settings.mainCheckout, 'worktree', 'add', '--detach', headTree, target);
      headSetup = installDependenciesCached(options, target, headTree);
    }
    const runner = options.runGate ?? gateRunner(2 * 60 * 60_000);
    const headJobs: { check: IndexedCheck; cwd: string }[] = [];
    for (const check of checks) {
      if (!headMissing.includes(check)) {
        const key = runCacheKey(settings, target, check, selection);
        const cached = cachedRun(store, key);
        if (cached) results[check.index]!.head = cached;
        else if (headSetup?.passed && headTree) headJobs.push({ check, cwd: headTree });
        else if (headSetup && !headSetup.passed)
          results[check.index]!.headReason = `Head dependency setup failed: ${headSetup.output}`;
      }
    }
    const headResults = await mapBounded(headJobs, VERIFY_CONCURRENCY, async (job) => {
      const key = runCacheKey(settings, target, job.check, selection);
      return { check: job.check, result: await executeCheck(options, runner, job.check, target, job.cwd, key) };
    });
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
          !tooManyAssertions(result.output) &&
          stableAssertions(result.output).length > 0
        );
      })
      .map(({ check }) => check);
    const baseMissing = baselineChecks.filter((check) => !commandPresentAt(settings, base, check));
    for (const check of baseMissing)
      results[check.index]!.baselineReason = 'The selected command source is absent at the exact verified baseline.';
    const missingBaselineRuns = baselineChecks.filter(
      (check) =>
        !baseMissing.includes(check) && !cachedRun(store, runCacheKey(settings, base, check, selection)),
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
      const key = runCacheKey(settings, base, check, selection);
      const cached = cachedRun(store, key);
      if (cached) results[check.index]!.baseline = cached;
      else if (baseSetup?.passed && baseTree) baseJobs.push({ check, cwd: baseTree });
      else if (baseSetup && !baseSetup.passed)
        results[check.index]!.baselineReason = `Baseline dependency setup failed: ${baseSetup.output}`;
    }
    const baselineResults = await mapBounded(baseJobs, VERIFY_CONCURRENCY, async (job) => {
      const key = runCacheKey(settings, base, job.check, selection);
      return { check: job.check, result: await executeCheck(options, runner, job.check, base, job.cwd, key) };
    });
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
      let baseAssertions = baseResult && !baseResult.passed ? stableAssertions(baseResult.output) : [];
      const headAssertions = headResult && !headResult.passed ? stableAssertions(headResult.output) : [];
      const headUnknown =
        !headResult ||
        !!result.headReason ||
        headResult.timedOut ||
        infraFailure(headResult.output, headResult.timedOut) ||
        unavailableFailure(headResult.output) ||
        truncatedOutput(headResult.output) ||
        tooManyAssertions(headResult.output) ||
        !headAssertions.length;
      const baselineUnknown =
        !baseResult ||
        !!result.baselineReason ||
        baseResult.timedOut ||
        infraFailure(baseResult.output, baseResult.timedOut) ||
        unavailableFailure(baseResult.output) ||
        truncatedOutput(baseResult.output) ||
        tooManyAssertions(baseResult.output) ||
        (!baseResult.passed && !baseAssertions.length);
      const headEv = headResult;
      const baseEv = baseResult;
      if (headUnknown || baselineUnknown) {
        const message = headUnknown
          ? result.headReason ?? (headResult ? 'The head failure is infrastructure, unavailable, incomplete, or has no stable assertion.' : 'The head command did not run.')
          : result.baselineReason ?? (baseResult ? 'The baseline result is infrastructure, unavailable, incomplete, or has no stable assertion.' : 'The baseline command did not run.');
        const finding = makeFinding(
          result.check,
          base,
          target,
          headAssertions.join('\n') || (headResult ? firstFailure(headResult.output).assertion : 'Head check unavailable'),
          'unknown',
          baseEv,
          headEv,
          message,
        );
        saveFinding(store, finding);
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
          status === 'existing' ? 'The same stable assertion failed at the exact previous verified baseline and current head.' : 'This stable assertion failed at the head and was absent at the exact previous verified baseline.',
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

function suspectsFor(
  settings: Settings,
  store: Pick<WorkerStore, 'tasks'>,
  base: string,
  target: string,
  check: IndexedCheck,
): Suspect[] {
  const landed = commits(settings.mainCheckout, base, target);
  const position = new Map(landed.map((commit, index) => [commit, index]));
  const tasks = taskLandings(settings, store, base, target)
    .map((task) => {
      const taskCommitList = taskCommits(task, settings.mainCheckout);
      if (!taskCommitList.some((commit) => position.has(commit))) return undefined;
      if (!check.closure.includes('**') && !filesInCommits(settings.mainCheckout, taskCommitList).some((file) => matches(file, check.closure)))
        return undefined;
      const commit = (task.integratedCommit ?? task.mergedCommit)!;
      return position.has(commit) ? { task, commit, position: position.get(commit)! } : undefined;
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
): Promise<DevVerifierEvidence | null> {
  const { settings } = options;
  const key = runCacheKey(settings, commit, check, selection);
  const cached = cachedRun(options.store, key);
  if (cached) return cached;
  const tree = join(settings.worktreeRoot, `dev-verify-probe-${randomUUID()}`);
  mkdirSync(settings.worktreeRoot, { recursive: true });
  mkdirSync(settings.stateDirectory, { recursive: true });
  git(settings.mainCheckout, 'worktree', 'add', '--detach', tree, commit);
  try {
    const installed = installDependenciesCached(options, commit, tree);
    if (!installed.passed) return null;
    if (!commandPresentAt(settings, commit, check)) return null;
    const result = await executeCheck(options, options.runGate ?? gateRunner(2 * 60 * 60_000), check, commit, tree, key);
    if (
      result.timedOut ||
      infraFailure(result.output, result.timedOut) ||
      unavailableFailure(result.output) ||
      truncatedOutput(result.output) ||
      tooManyAssertions(result.output)
    )
      return null;
    return result;
  } finally {
    git(settings.mainCheckout, 'worktree', 'remove', '--force', tree);
  }
}

function containsAssertion(result: DevVerifierEvidence | null, assertion: string): boolean | null {
  if (!result) return null;
  if (
    result.timedOut ||
    infraFailure(result.output, result.timedOut) ||
    unavailableFailure(result.output) ||
    truncatedOutput(result.output) ||
    tooManyAssertions(result.output)
  )
    return null;
  return !result.passed && stableAssertions(result.output).includes(assertion);
}

async function proveExistingOrReintroduced(
  options: DevVerifierOptions,
  check: IndexedCheck,
  assertion: string,
  suspects: readonly Suspect[],
  selection: string,
): Promise<ExistingProbe> {
    if (knownExisting(options.store, findingSignature(check, assertion))) return { status: 'existing' };
  if (suspects.length < 2) return { status: 'existing' };
  const sampleIndexes = Array.from({ length: suspects.length - 1 }, (_, index) => index);
  const selected =
    sampleIndexes.length <= MAX_EXISTING_PROBES
      ? sampleIndexes
      : Array.from({ length: MAX_EXISTING_PROBES }, (_, index) =>
          Math.floor((index * (sampleIndexes.length - 1)) / (MAX_EXISTING_PROBES - 1)),
        );
  const unique = [...new Set(selected)];
  const probes = await mapBounded(unique, VERIFY_CONCURRENCY, async (index) => {
    const evidence = await probeAt(options, check, suspects[index]!.commit, selection);
    return { index, contains: containsAssertion(evidence, assertion) };
  });
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
): Promise<Task | undefined | null> {
  if (!suspects.length) return undefined;
  if (cleanIndex === undefined && suspects.length === 1) return suspects[0]!.task;
  let low = cleanIndex === undefined ? 0 : cleanIndex + 1;
  let high = suspects.length - 1;
  if (low > high) return null;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const outcome = await probeAt(options, check, suspects[middle]!.commit, selection);
    const contains = containsAssertion(outcome, assertion);
    if (contains === null) return null;
    if (contains) high = middle;
    else low = middle + 1;
  }
  const evidence = await probeAt(options, check, suspects[low]!.commit, selection);
  const contains = containsAssertion(evidence, assertion);
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

function saveComparisonFindings(store: DevVerifierOptions['store'], comparison: Comparison): void {
  for (const finding of comparison.findings) saveFinding(store, finding);
}

function advanceVerified(
  settings: Settings,
  store: DevVerifierOptions['store'],
  expectedBase: string,
  expectedDev: string,
  target: string,
  passedTaskIds: ReadonlySet<string>,
): boolean {
  try {
    if (head(settings.mainCheckout, settings.integrationBranch) !== expectedDev) return false;
    git(settings.mainCheckout, 'update-ref', ref(verifiedBranch), target, expectedBase);
    recordVerified(settings, store, expectedBase, target, passedTaskIds);
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
    saveFinding(options.store, finding);
  }
}

async function revertCulprits(
  options: DevVerifierOptions,
  base: string,
  target: string,
  culprits: readonly { task: Task; findings: DevVerifierFinding[] }[],
): Promise<string | undefined> {
  if (!culprits.length) return undefined;
  const { settings, store } = options;
  const checkout = settings.mainCheckout;
  const tree = join(settings.worktreeRoot, `dev-verify-revert-${randomUUID()}`);
  mkdirSync(settings.worktreeRoot, { recursive: true });
  git(checkout, 'worktree', 'add', '--detach', tree, target);
  try {
    git(tree, 'reset', '--hard', target);
    git(tree, 'clean', '-fdx');
    const landedOrder = new Map(commits(checkout, base, target).map((commit, index) => [commit, index]));
    const selectedCommits = [...new Set(culprits.flatMap(({ task }) => taskCommits(task, checkout)))].sort(
      (a, b) => (landedOrder.get(b) ?? -1) - (landedOrder.get(a) ?? -1),
    );
    if (!selectedCommits.length) return undefined;
    const reverted = spawnSync('git', ['revert', '--no-commit', ...selectedCommits], {
      cwd: tree,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    if (reverted.status !== 0)
      throw new Error(`Could not revert verifier culprit changes: ${reverted.stderr || reverted.stdout}`);
    const labels = culprits.map(({ task }) => task.id).join(', ');
    const committed = spawnSync('git', ['commit', '-m', `revert: ${labels} after dev verification`], {
      cwd: tree,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
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
        summary: `Landing ${task.id} was reverted from dev after ${first.check.command.join(' ')} failed. Log: ${first.head?.logPath ?? '(no log)'}\n${output.slice(-6000)}`,
      });
    }
    return revertHead;
  } finally {
    git(checkout, 'worktree', 'remove', '--force', tree);
  }
}

async function reconcile(
  options: DevVerifierOptions,
  base: string,
  target: string,
): Promise<{ comparison: Comparison; unknown: boolean; groups: FindingGroup[] }> {
  const comparison = await compareRange(options, base, target);
  const selection = selectionIdentity(comparison.checks);
  const groups = groupNewFindings(comparison.findings, comparison.checks);
  const unknownChecks = comparison.results.filter((item) => item.headReason || (item.head && !item.head.passed && comparison.findings.some((finding) => finding.check.command.join('\0') === item.check.command.join('\0') && finding.status === 'unknown')));
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
    const suspects = suspectsFor(options.settings, options.store, base, target, check);
    const result = await proveExistingOrReintroduced(options, check, finding.assertion, suspects, selection);
    proof.push({ finding, status: result.status, cleanIndex: result.cleanIndex });
  }
  for (const item of proof) {
    if (item.status === 'new') {
      item.finding.status = 'new';
      item.finding.reason = 'The same assertion passed at an intermediate landing prefix and failed again at the head.';
      const group = groups.find((candidate) => candidate.check.signature === checkSignature(item.finding.check, candidate.check.index));
      if (group) {
        group.findings.push(item.finding);
        group.targets = [...new Set([...group.targets, item.finding.assertion])];
      } else {
        const check = comparison.checks.find((candidate) => candidate.signature === checkSignature(item.finding.check, candidate.index));
        if (check) groups.push({ check, findings: [item.finding], targets: [item.finding.assertion] });
      }
    } else if (item.status === 'unknown') {
      item.finding.status = 'unknown';
      item.finding.reason = 'The bounded prefix comparison could not establish whether this matching assertion was pre-existing.';
    }
  }
  saveComparisonFindings(options.store, comparison);
  return { comparison, unknown: unknown || proof.some((item) => item.status === 'unknown'), groups };
}

/** Verify a fixed dev head; the ref moves only after a compare-and-swap against that exact head. */
export async function verifyDev(options: DevVerifierOptions): Promise<void> {
  const { settings, store } = options,
    checkout = settings.mainCheckout;
  const lock = acquireDirectoryLease(join(settings.stateDirectory, 'dev-verifier.lease'));
  try {
    const dev = head(checkout, settings.integrationBranch);
    let verified: string;
    try {
      verified = head(checkout, verifiedBranch);
    } catch {
      // The train already checked every landing before this verifier was introduced.
      try {
        git(checkout, 'update-ref', ref(verifiedBranch), dev, '');
      } catch {
        /* another verifier initialized it */
      }
      return;
    }
    if (
      verified === dev ||
      spawnSync('git', ['merge-base', '--is-ancestor', verified, dev], { cwd: checkout }).status !== 0
    )
      return;

    const initial = await reconcile(options, verified, dev);
    const initialUnknown = initial.unknown;
    let finalHead = dev;
    let finalPassedTasks = new Set(initial.comparison.passTaskIds);
    if (initial.groups.length) {
      const owned: { group: FindingGroup; owners: Task[]; unknownOwner: boolean }[] = [];
      for (const group of initial.groups) {
        const suspects = suspectsFor(settings, store, verified, dev, group.check);
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
            stableAssertions(finding.baseline.output).includes(assertion);
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
              updateFindingOwner(options, [finding], undefined, 'New failure is visible, but its owner is unknown because prefix evidence was incomplete.');
              continue;
            }
            if (proof.status === 'existing') {
              updateFindingOwner(options, [finding], undefined, 'Failure is pre-existing on the exact baseline; no landing was assigned.');
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
            owner ? `New failure attributed to the owning landing ${owner.id}.` : 'New failure has no proven owner in the captured verified range.',
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
      const postRevert = await revertCulprits(options, verified, dev, [...byTask.values()]);
      if (!postRevert) return;
      finalHead = postRevert;
      const afterRevert = await reconcile(options, verified, postRevert);
      if (afterRevert.unknown || afterRevert.groups.length) return;
      finalPassedTasks = new Set(afterRevert.comparison.passTaskIds);
    } else if (initialUnknown) {
      return;
    }
    advanceVerified(settings, store, verified, finalHead === dev ? dev : finalHead, finalHead, finalPassedTasks);
  } catch (error) {
    if (error instanceof LeaseHeldError) return;
    throw error;
  } finally {
    lock.release();
  }
}

type VerificationFindingCounts = { existing: number; new: number; unknown: number };
function readFindingCounts(stateDirectory: string | undefined): VerificationFindingCounts {
  const empty = { existing: 0, new: 0, unknown: 0 };
  if (!stateDirectory) return empty;
  const path = join(stateDirectory, 'goal.sqlite');
  if (!existsSync(path)) return empty;
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true, create: false });
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dev_verifier_findings'").get())
      return empty;
    const counts = db.query('SELECT status, count(*) AS count FROM dev_verifier_findings GROUP BY status').all() as {
      status: string;
      count: number;
    }[];
    const result = { ...empty };
    for (const row of counts) if (row.status in result) result[row.status as keyof VerificationFindingCounts] = row.count;
    return result;
  } catch {
    return empty;
  } finally {
    db?.close();
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
    const landed = new Set(commits(cwd, verified, dev));
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
