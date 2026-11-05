import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { DevVerifierEvidence, DevVerifierFinding, DevVerifierResult, Settings, Task } from './types.ts';
import { defaultPolicy } from './policy.ts';
import { firstFailure, gateEnvironment, gateRunner, git } from './merge.ts';
import {
  classifyRun,
  infraFailure,
  stableAssertions,
  tooManyAssertions,
  truncatedOutput,
  unavailableFailure,
} from './dev-verifier-classification.ts';
import {
  createEvidence,
  executeCheck,
  installDependenciesCached,
  reusableCheckResult,
  type DevVerifierExecution,
} from './dev-verifier-execution.ts';
import { cachedRun, knownExisting, saveFinding, saveRun } from './dev-verifier-storage.ts';
import {
  checkInputAreas,
  checkSourceQueryPaths,
  createVerifierChecks as createChecks,
  filesInCommits,
  matches,
  mergeRevisionSource,
  sourcePresentAt,
  taskCommits,
  type DevVerifierCheck,
  type RevisionSource,
  type VerifierLandings,
} from './dev-verifier-plan.ts';
import type { DevVerifierOptions } from './dev-verifier.ts';

type Check = DevVerifierCheck;
export type IndexedCheck = Check & { index: number; signature: string };
export type ComparedCheck = {
  check: IndexedCheck;
  baseline: DevVerifierEvidence | null;
  head: DevVerifierEvidence | null;
  baselineReason?: string;
  headReason?: string;
};
export type Comparison = {
  base: string;
  head: string;
  checks: IndexedCheck[];
  results: ComparedCheck[];
  findings: DevVerifierFinding[];
  passTaskIds: string[];
};
export type FindingGroup = { check: IndexedCheck; findings: DevVerifierFinding[]; targets: string[] };
export type Suspect = { task: Task; commit: string };
export type ExistingProbe = { status: 'existing' | 'new' | 'unknown'; cleanIndex?: number };

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
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
export function checkSignature(check: Check, index: number): string {
  return hash({
    version: 2,
    index,
    command: check.command,
    closure: [...check.closure].sort(),
    taskId: check.taskId ?? null,
    cwd: check.cwd ?? null,
  });
}
export function findingSignature(check: Check, assertion: string): string {
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

const revisionSources = new WeakMap<DevVerifierOptions, Map<string, RevisionSource>>();
export function revisionSource(options: DevVerifierOptions, commit: string, checks: readonly Check[]): RevisionSource {
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

export function dependencySetupKey(settings: Settings, commit: string): string {
  return hash({
    version: 2,
    phase: 'dependency-setup',
    commit,
    command: ['bun', 'install', '--frozen-lockfile'],
    closure: ['package.json', 'bun.lock'],
    environment: environmentIdentity(settings),
    toolchain: toolchainIdentity(settings, commit),
  });
}

export function verifierExecution(options: DevVerifierOptions): DevVerifierExecution {
  return {
    settings: options.settings,
    readRun: (key) => cachedRun(options.store, key),
    saveRun: (run) => saveRun(options.store, run, options.settings.policy?.verifier),
  };
}
export function makeFinding(
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

export function runCacheKey(settings: Settings, commit: string, check: IndexedCheck, selection: string): string {
  return checkRunKey(settings, commit, check, check.signature, selection);
}

function reusableAt(
  execution: DevVerifierExecution,
  settings: Settings,
  commit: string,
  check: IndexedCheck,
  selection: string,
  source: RevisionSource,
): DevVerifierEvidence | undefined {
  return reusableCheckResult(
    execution,
    commit,
    check,
    runCacheKey(settings, commit, check, selection),
    checkInput(settings, commit, check, source),
  );
}

export function selectionIdentity(checks: readonly IndexedCheck[]): string {
  return hash(checks.map(({ command, closure, taskId, signature }) => ({ command, closure, taskId, signature })));
}
function commandPresentAt(options: DevVerifierOptions, commit: string, check: Check): boolean {
  return sourcePresentAt(revisionSource(options, commit, [check]), check);
}

export async function compareRange(options: DevVerifierOptions, history: VerifierLandings): Promise<Comparison> {
  const { settings, store } = options;
  const execution = verifierExecution(options);
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
        !headMissing.includes(check) && !reusableAt(execution, settings, target, check, selection, targetSource),
    );
    let headSetup: { passed: boolean; output: string; logPath: string } | undefined;
    if (missingHeadRuns.length) {
      headTree = join(settings.worktreeRoot, `dev-verify-${randomUUID()}`);
      git(settings.mainCheckout, 'worktree', 'add', '--detach', headTree, target);
      headSetup = installDependenciesCached(execution, target, headTree, dependencySetupKey(settings, target));
    }
    const runner =
      options.runGate ?? gateRunner((options.settings.policy ?? defaultPolicy).verifier.standaloneGateTimeoutMs);
    const headJobs: { check: IndexedCheck; cwd: string }[] = [];
    for (const check of checks) {
      if (!headMissing.includes(check)) {
        const cached = reusableAt(execution, settings, target, check, selection, targetSource);
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
            execution,
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
      (check) => !baseMissing.includes(check) && !reusableAt(execution, settings, base, check, selection, baseSource),
    );
    let baseSetup: { passed: boolean; output: string; logPath: string } | undefined;
    if (missingBaselineRuns.length) {
      baseTree = join(settings.worktreeRoot, `dev-verify-base-${randomUUID()}`);
      git(settings.mainCheckout, 'worktree', 'add', '--detach', baseTree, base);
      baseSetup = installDependenciesCached(execution, base, baseTree, dependencySetupKey(settings, base));
    }
    const baseJobs: { check: IndexedCheck; cwd: string }[] = [];
    for (const check of baselineChecks) {
      if (baseMissing.includes(check)) continue;
      const cached = reusableAt(execution, settings, base, check, selection, baseSource);
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
            execution,
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

export function suspectsFor(settings: Settings, history: VerifierLandings, check: IndexedCheck): Suspect[] {
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

export async function probeAt(
  options: DevVerifierOptions,
  check: IndexedCheck,
  commit: string,
  selection: string,
  missingAsPass = false,
): Promise<DevVerifierEvidence | null> {
  const { settings } = options;
  const execution = verifierExecution(options);
  const key = runCacheKey(settings, commit, check, selection);
  const cached = cachedRun(options.store, key);
  if (cached) return cached;
  if (missingAsPass && !commandPresentAt(options, commit, check))
    return createEvidence(commit, check, { passed: true, output: '', timedOut: false }, '');
  const tree = join(settings.worktreeRoot, `dev-verify-probe-${randomUUID()}`);
  mkdirSync(settings.worktreeRoot, { recursive: true });
  mkdirSync(settings.stateDirectory, { recursive: true });
  git(settings.mainCheckout, 'worktree', 'add', '--detach', tree, commit);
  try {
    const installed = installDependenciesCached(execution, commit, tree, dependencySetupKey(settings, commit));
    if (!installed.passed) return null;
    if (!commandPresentAt(options, commit, check))
      return missingAsPass ? createEvidence(commit, check, { passed: true, output: '', timedOut: false }, '') : null;
    const result = await executeCheck(
      execution,
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

export function containsAssertion(
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

export async function proveExistingOrReintroduced(
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

export async function locateNewFailure(
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

export function groupNewFindings(
  findings: readonly DevVerifierFinding[],
  checks: readonly IndexedCheck[],
): FindingGroup[] {
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

export async function reconcileComparison(
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

export function saveComparisonFindings(
  store: DevVerifierOptions['store'],
  comparison: Comparison,
  policy = defaultPolicy.verifier,
): void {
  for (const finding of comparison.findings) saveFinding(store, finding, policy);
}
