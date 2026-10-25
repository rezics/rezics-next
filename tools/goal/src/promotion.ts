import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import defaults from '../defaults.json';
import { acquireDirectoryLease, LeaseHeldError } from './lease.ts';
import { matchesPath } from './briefs.ts';
import { firstFailure, gateRunner, git, type GateRunner } from './merge.ts';
import { stopProcessesUnder } from './process.ts';
import type { DerivedFile } from './merge-train.ts';
import type { FirstFailure } from './contracts.ts';
import type { PromotionGateResult, PromotionRun, Task } from './types.ts';
import type { WorkerJob } from './job.ts';
import type { Settings } from './types.ts';

const defaultDerivedFiles = defaults.derivedFiles as DerivedFile[];
export type PromotionOptions = { settings: Settings; job: WorkerJob; runGate?: GateRunner; beforeAdvance?: () => void; derivedFiles?: DerivedFile[] };

const ref = (branch: string) => `refs/heads/${branch}`;
function isAncestor(cwd: string, older: string, newer: string): boolean {
  try { git(cwd, 'merge-base', '--is-ancestor', older, newer); return true; } catch { return false; }
}
function head(cwd: string, branch: string): string { return git(cwd, 'rev-parse', '--verify', ref(branch)); }
function workingFiles(cwd: string): string[] {
  const tracked = spawnSync('git', ['diff', '--name-only', '-z', 'HEAD', '--'], { cwd, encoding: 'utf8' });
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd, encoding: 'utf8' });
  if (tracked.status !== 0 || untracked.status !== 0) throw new Error('Cannot read generated file changes');
  return [...new Set([...tracked.stdout.split('\0'), ...untracked.stdout.split('\0')].filter(Boolean))];
}

async function regenerateDerivedHead(options: PromotionOptions, expected: string): Promise<{ head: string; retry: boolean }> {
  const settings = options.settings, checkout = settings.mainCheckout;
  const files = (options.derivedFiles ?? defaultDerivedFiles).filter(file => file.stage === 'promotion');
  if (!files.length) return { head: expected, retry: head(checkout, settings.integrationBranch) !== expected };

  const tree = join(settings.worktreeRoot, `promotion-derived-${randomUUID()}`);
  const logPath = join(settings.stateDirectory, `promotion-derived-${randomUUID()}.log`);
  mkdirSync(settings.worktreeRoot, { recursive: true }); mkdirSync(settings.stateDirectory, { recursive: true });
  git(checkout, 'worktree', 'add', '--detach', tree, expected);
  try {
    const tracked = git(tree, 'ls-files', '-z').split('\0').filter(Boolean);
    const commands = new Map<string, string[]>();
    for (const file of files) if (tracked.some(path => matchesPath(path, [file.path])))
      commands.set(JSON.stringify(file.command), file.command);
    // A fresh worktree has no node_modules, and generators such as the kernel's run its installed tools.
    const install = commands.size && existsSync(join(tree, 'package.json')) ? [['bun', 'install', '--frozen-lockfile']] : [];
    for (const command of [...install, ...commands.values()]) {
      const result = spawnSync(command[0]!, command.slice(1), { cwd: tree, encoding: 'utf8' });
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      appendFileSync(logPath, `$ ${command.join(' ')} (cwd: ${tree})\n${output}`);
      if (result.status !== 0) throw new Error(`Failed to regenerate derived files: ${output || result.error?.message || 'command failed'}`);
    }

    const changes = workingFiles(tree);
    const outside = changes.filter(path => !files.some(file => matchesPath(path, [file.path])));
    if (outside.length) throw new Error(`Derived generator changed non-derived files: ${outside.join(', ')}`);
    let candidate = expected;
    if (changes.length) {
      git(tree, 'add', '-A', '--', ...changes);
      git(tree, 'commit', '-m', 'chore: regenerate derived files');
      candidate = git(tree, 'rev-parse', 'HEAD');
    }

    if (head(checkout, settings.integrationBranch) !== expected) return { head: head(checkout, settings.integrationBranch), retry: true };
    if (candidate !== expected) {
      try { git(checkout, 'update-ref', ref(settings.integrationBranch), candidate, expected); }
      catch (error) {
        const current = head(checkout, settings.integrationBranch);
        if (current !== expected) return { head: current, retry: true };
        throw error;
      }
    }
    const current = head(checkout, settings.integrationBranch);
    return current === candidate ? { head: candidate, retry: false } : { head: current, retry: true };
  } finally { git(checkout, 'worktree', 'remove', '--force', tree); }
}

function boundaryTasks(options: PromotionOptions, main: string, dev: string): Task[] {
  const store = options.job.tasks.store, checkout = options.settings.mainCheckout;
  const commits = git(options.settings.mainCheckout, 'rev-list', '--reverse', `${main}..${dev}`).split('\n').filter(Boolean);
  const position = new Map(commits.map((commit, index) => [commit, index]));
  for (const task of store.tasks().filter(task => task.state === 'integrated' && !task.integratedCommit && task.currentAttempt > 0)) {
    try {
      const branchCommit = git(checkout, 'rev-parse', '--verify', `refs/heads/${task.branch}^{commit}`);
      if (!position.has(branchCommit) || !isAncestor(checkout, task.base, branchCommit)) continue;
      const integratedCommits = git(checkout, 'rev-list', '--reverse', `${task.base}..${branchCommit}`).split('\n').filter(Boolean);
      store.updateTask({ taskId: task.id, attempt: task.currentAttempt }, current => {
        current.integratedCommit = branchCommit; current.integratedBase = task.base; current.integratedCommits = integratedCommits;
      });
    } catch { /* Legacy imported integration records may not have a usable worker branch. */ }
  }
  return store.tasks().filter(task => task.state === 'integrated' && task.integratedCommit
    && position.has(task.integratedCommit)).sort((a, b) => position.get(a.integratedCommit!)! - position.get(b.integratedCommit!)!);
}
function taskCommits(options: PromotionOptions, task: Task): string[] {
  if (task.integratedCommits) return [...task.integratedCommits];
  if (!task.integratedCommit) return [];
  const base = task.integratedBase ?? task.base;
  try { return git(options.settings.mainCheckout, 'rev-list', '--reverse', `${base}..${task.integratedCommit}`).split('\n').filter(Boolean); }
  catch { return []; }
}
// Specification and research tasks deliver suites that stay red until a later task binds them; the root gate covers them.
const RED_BY_DESIGN = new Set(['specification', 'research']);
const WORKSPACE = /^(?:apps|services|packages)\/[^/]+|^tools\/goal(?=\/|$)/;
// The root gate runs every workspace's full check and the control plane's gate. A test command confined to those
// trees reruns a subset of it, so a batch of hundreds of tasks costs one root gate plus the few commands that
// reach outside, such as root specs, each run once.
export function coveredByRootGate(command: readonly string[]): boolean {
  if (command[0] === 'bun' && command[1] === 'run' && command[2] === '--cwd' && command[4] === 'check')
    return WORKSPACE.exec(command[3] ?? '')?.[0] === command[3];
  const shell = command[0] === 'sh' && command[1] === '-c' ? /^cd ((?:apps|services|packages)\/[^/\s]+) && /.exec(command[2] ?? '') : null;
  if (shell) return !/[;|]|&&\s*cd\b/.test(command[2]!.slice(shell[0].length));
  if (command[0] !== 'bun' || !command.includes('test')) return false;
  const paths = command.filter(argument => argument.includes('/'));
  return paths.length > 0 && paths.every(path => WORKSPACE.test(path));
}
function commandsFor(rootGate: readonly string[], tasks: readonly Task[]): string[][] {
  const commands = new Map<string, string[]>([[JSON.stringify(rootGate), [...rootGate]]]);
  for (const task of tasks) {
    const command = task.brief.acceptance.command;
    if (RED_BY_DESIGN.has(task.taskClass) || coveredByRootGate(command)) continue;
    commands.set(JSON.stringify(command), [...command]);
  }
  return [...commands.values()];
}
function resultKey(result: PromotionGateResult): string { return `${result.commit}\n${JSON.stringify(result.command)}`; }
function appendResult(run: PromotionRun, target: 'headResults' | 'prefixResults', result: PromotionGateResult): PromotionRun {
  const key = resultKey(result), results = run[target];
  const index = results.findIndex(existing => resultKey(existing) === key);
  if (index < 0) results.push(result); else results[index] = result;
  return run;
}

async function gateAt(options: PromotionOptions, run: PromotionRun, commit: string, commands: readonly string[][], label: string,
  target: 'headResults' | 'prefixResults', force = false): Promise<PromotionGateResult[]> {
  const store = options.job.tasks.store, main = options.settings.mainCheckout;
  const results: PromotionGateResult[] = [];
  const tree = join(options.settings.worktreeRoot, `promotion-${run.id}-${label}`);
  for (let index = 0; index < commands.length; index++) {
    const command = [...commands[index]!];
    const cached = force ? undefined : run[target].find(result => result.commit === commit && JSON.stringify(result.command) === JSON.stringify(command));
    if (!cached) break;
    results.push(cached);
    if (!cached.passed) return results;
  }
  if (results.length === commands.length) return results;
  const logFor = (index: number) => join(options.settings.stateDirectory, `promotion-${run.id}-${label}-${index}.log`);
  mkdirSync(options.settings.worktreeRoot, { recursive: true });
  if (existsSync(tree)) { try { git(main, 'worktree', 'remove', '--force', tree); } catch {} }
  git(main, 'worktree', 'add', '--detach', tree, commit);
  try {
    results.length = 0;
    // A fresh worktree has no node_modules; only the root gate installs by itself, and a narrowed or acceptance
    // command would fail on every commit without this.
    if (existsSync(join(tree, 'package.json'))) {
      const installed = spawnSync('bun', ['install', '--frozen-lockfile'], { cwd: tree, encoding: 'utf8' });
      appendFileSync(logFor(0), `$ bun install --frozen-lockfile (cwd: ${tree})\n${installed.stdout ?? ''}${installed.stderr ?? ''}`);
      if (installed.status !== 0) {
        const result = { commit, command: [...commands[0]!], passed: false, timedOut: false,
          firstFailure: firstFailure(`bun install --frozen-lockfile failed: ${installed.stderr || installed.error?.message || ''}`) };
        appendResult(run, target, result); store.savePromotion(run);
        return [result];
      }
    }
    for (let index = 0; index < commands.length; index++) {
      const command = [...commands[index]!];
      const cached = force ? undefined : run[target].find(result => result.commit === commit && JSON.stringify(result.command) === JSON.stringify(command));
      if (cached) { results.push(cached); if (!cached.passed) break; continue; }
      let result: PromotionGateResult;
      try {
        const outcome = await (options.runGate ?? gateRunner())(command, tree, logFor(index));
        let failure = outcome.passed ? undefined : firstFailure(outcome.output);
        if (git(tree, 'rev-parse', 'HEAD') !== commit || git(tree, 'status', '--porcelain'))
          failure = firstFailure(`${failure?.assertion ?? ''}\nGate changed the checked commit or worktree`);
        result = { commit, command, passed: outcome.passed && !failure, timedOut: outcome.timedOut,
          ...(failure ? { firstFailure: failure } : {}) };
      } catch (error) {
        result = { commit, command, passed: false, timedOut: false, firstFailure: firstFailure(String(error)) };
      }
      results.push(result);
      appendResult(run, target, result);
      store.savePromotion(run);
      // The first failure decides the run; later commands on a broken commit only cost time.
      if (!result.passed) break;
    }
  } finally {
    await stopProcessesUnder(tree, options.settings.terminationGraceMs);
    git(main, 'worktree', 'remove', '--force', tree);
  }
  return results;
}

async function concurrent<T>(items: readonly T[], count: number, action: (value: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, count) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await action(items[index]!, index);
    }
  }));
}

function createRun(options: PromotionOptions, main: string, dev: string, tasks: readonly Task[]): PromotionRun {
  const boundaries = tasks.filter(task => task.integratedCommit).map(task => ({ taskId: task.id, commit: task.integratedCommit! }));
  return { id: randomUUID(), phase: 'gate-head', mainBase: main, devHead: dev, taskIds: tasks.map(task => task.id),
    rootGate: [...options.settings.gate], promotionParallelism: options.settings.promotionParallelism,
    boundaries, headResults: [], prefixResults: [] };
}

type PromotionFlakeEvent = {
  kind: 'promotion-flake'; taskId: string; commit: string; command: string[];
  initial: PromotionGateResult; confirmation: PromotionGateResult; logs: [string, string];
};
type PromotionRunWithFlakes = PromotionRun & { flakeEvents?: PromotionFlakeEvent[] };
type PromotionProbeRetry = {
  kind: 'promotion-probe-retry'; taskId: string; commit: string; command: string[];
  initial: PromotionGateResult; retry: PromotionGateResult; logs: [string, string];
};
type PromotionRunWithProbeRetries = PromotionRun & { probeRetries?: PromotionProbeRetry[] };

function dependentClosure(tasks: readonly Task[], culprit: string): string[] {
  const selected = new Set([culprit]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) if (!selected.has(task.id) && task.brief.after.some(dependency => selected.has(dependency))) {
      selected.add(task.id); changed = true;
    }
  }
  return tasks.filter(task => selected.has(task.id)).map(task => task.id);
}

function reportEnvironment(options: PromotionOptions, run: PromotionRun): void {
  const failure = run.firstFailure ?? run.mainResult?.firstFailure;
  const task = run.taskIds.map(id => options.job.tasks.store.task(id)).find(candidate => candidate.currentAttempt > 0)
    ?? options.job.tasks.store.tasks().find(candidate => candidate.state === 'integrated' && candidate.currentAttempt > 0);
  if (failure && task) options.job.reportPromotionEnvironment(task.id, failure);
}

// The root gate names its failing workspaces on its last line. Bisecting on the first one's check costs a fraction of
// the root gate per probe, and a flake in another workspace cannot decide a probe.
function narrowedFailure(options: PromotionOptions, run: PromotionRun, failed: PromotionGateResult, label: string,
  index: number): { command: string[]; failure: FirstFailure } {
  const fallback = { command: [...failed.command], failure: failed.firstFailure ?? firstFailure('Promotion gate failed') };
  const logPath = join(options.settings.stateDirectory, `promotion-${run.id}-${label}-${index}.log`);
  if (JSON.stringify(failed.command) !== JSON.stringify(run.rootGate) || !existsSync(logPath)) return fallback;
  const log = readFileSync(logPath, 'utf8');
  const workspace = /^Failed workspaces: (\S+)/m.exec(log)?.[1];
  if (!workspace) return fallback;
  const block = log.split(/^(?=Workspace )/m).find(part => part.split('\n', 2)[1]?.trimEnd().endsWith(`(${workspace})`));
  return { command: ['bun', 'run', '--cwd', workspace, 'check'], failure: firstFailure(block ?? log) };
}

async function saveHeadDecision(options: PromotionOptions, run: PromotionRun, result: PromotionGateResult[]): Promise<PromotionRun> {
  const failed = result.find(item => !item.passed);
  if (!failed) {
    run.phase = 'publish-main'; run.promoteHead = run.devHead; run.promoteTaskIds = [...run.taskIds];
    options.job.tasks.store.savePromotion(run); return run;
  }
  const narrowed = narrowedFailure(options, run, failed, 'head', result.indexOf(failed));
  run.firstFailure = narrowed.failure;
  run.failedCommand = narrowed.command; run.phase = 'classify-main';
  options.job.tasks.store.savePromotion(run); return run;
}

async function resolveMainFailure(options: PromotionOptions, run: PromotionRun): Promise<PromotionRun> {
  const command = run.failedCommand ?? run.rootGate;
  const result = (await gateAt(options, run, run.mainBase, [command], 'main', 'prefixResults'))[0]!;
  run.mainResult = result;
  if (!result.passed && result.firstFailure?.fingerprint === run.firstFailure?.fingerprint) {
    run.phase = 'report-environment';
    options.job.tasks.store.savePromotion(run);
    return run;
  }
  run.phase = 'classify-prefixes';
  options.job.tasks.store.savePromotion(run);
  return run;
}

async function resolveCulprit(options: PromotionOptions, run: PromotionRun): Promise<PromotionRun> {
  const store = options.job.tasks.store;
  const tasks = run.taskIds.map(id => store.task(id));
  // Bisect on the command that failed at the head, with up to promotionParallelism probes per round: a batch of n tasks
  // costs O(log n) runs of one command, not every prefix with every acceptance command.
  const command = [...(run.failedCommand ?? run.rootGate)];
  const results = new Map<number, PromotionGateResult>();
  const probe = async (index: number): Promise<void> => {
    const boundary = run.boundaries[index]!;
    const label = `prefix-${index}`;
    const [initial] = await gateAt(options, run, boundary.commit, [command], label, 'prefixResults');
    let result = initial!;
    if (!result.passed && result.firstFailure?.fingerprint !== run.firstFailure?.fingerprint) {
      const retryLabel = `${label}-retry`;
      const [retry] = await gateAt(options, run, boundary.commit, [command], retryLabel, 'prefixResults', true);
      result = retry!;
      const initialLog = join(options.settings.stateDirectory, `promotion-${run.id}-${label}-0.log`);
      const retryLog = join(options.settings.stateDirectory, `promotion-${run.id}-${retryLabel}-0.log`);
      const saved = run as PromotionRunWithProbeRetries;
      saved.probeRetries = [...(saved.probeRetries ?? []), { kind: 'promotion-probe-retry', taskId: boundary.taskId,
        commit: boundary.commit, command: [...command], initial: initial!, retry: result, logs: [initialLog, retryLog] }];
      store.savePromotion(run);
    }
    results.set(index, result);
  };
  // A task's own acceptance command only means something from that task on; earlier prefixes cannot be its culprit.
  const owner = run.boundaries.findIndex(boundary =>
    JSON.stringify(store.task(boundary.taskId).brief.acceptance.command) === JSON.stringify(command));
  let low = owner >= 0 ? owner : 0, high = run.boundaries.length - 1;
  if (high < 0) { run.phase = 'report-environment'; store.savePromotion(run); return run; }
  if (run.boundaries[high]!.commit !== run.devHead) {
    // Commits after the last task boundary are not tasks; when the last boundary passes, no task is to blame.
    await probe(high);
    if (results.get(high)!.passed) { run.phase = 'report-environment'; store.savePromotion(run); return run; }
  }
  while (low < high) {
    // Pausing stops a bisection between rounds; its probe results stay cached for when it resumes.
    if (pausedAt(options.settings)) return run;
    const span = high - low, count = Math.min(run.promotionParallelism, span);
    const picks = [...new Set(Array.from({ length: count }, (_, k) => low + Math.floor(((k + 1) * span) / (count + 1))))]
      .filter(index => index < high).sort((a, b) => a - b);
    if (!picks.length) picks.push(low);
    await concurrent(picks, run.promotionParallelism, async index => probe(index));
    for (const index of picks) {
      if (results.get(index)!.passed) low = Math.max(low, index + 1);
      else { high = index; break; }
    }
  }
  const culpritResult = results.get(high);
  // Every prefix before the culprit passed the root gate, so main takes it now; a flake or a second breakage later in
  // this run cannot hold back work that is already proven.
  if (high > 0 && results.get(high - 1)?.passed && JSON.stringify(command) === JSON.stringify(run.rootGate)
    && publishPrefix(options, run, run.boundaries[high - 1]!.commit, run.taskIds.slice(0, high))) {
    run.mainBase = run.boundaries[high - 1]!.commit;
    run.taskIds = run.taskIds.slice(high); run.boundaries = run.boundaries.slice(high);
    high = 0;
    store.savePromotion(run);
  }
  const failedBoundaryIndex = high;
  const failed = run.boundaries[failedBoundaryIndex]!;
  const initial = culpritResult
    ?? run.headResults.find(result => !result.passed && JSON.stringify(result.command) === JSON.stringify(command))!;
  const commandIndex = 0;
  const confirmationLabel = 'confirm-culprit';
  const confirmationLog = join(options.settings.stateDirectory, `promotion-${run.id}-${confirmationLabel}-0.log`);
  const initialLog = join(options.settings.stateDirectory, `promotion-${run.id}-prefix-${failedBoundaryIndex}-${commandIndex}.log`);
  const confirmation = (await gateAt(options, run, failed.commit, [initial.command], confirmationLabel,
    'prefixResults', true))[0]!;
  if (confirmation.passed || confirmation.firstFailure?.fingerprint !== initial.firstFailure?.fingerprint) {
    const event: PromotionFlakeEvent = { kind: 'promotion-flake', taskId: failed.taskId, commit: failed.commit,
      command: [...initial.command], initial, confirmation, logs: [initialLog, confirmationLog] };
    const currentDev = head(options.settings.mainCheckout, options.settings.integrationBranch);
    const currentMain = head(options.settings.mainCheckout, options.settings.mainBranch);
    const next = createRun(options, currentMain, currentDev, boundaryTasks(options, currentMain, currentDev)) as PromotionRunWithFlakes;
    next.flakeEvents = [...((run as PromotionRunWithFlakes).flakeEvents ?? []), event];
    store.savePromotion(next);
    return next;
  }
  const culprit = store.task(failed.taskId);
  const closure = dependentClosure(tasks, culprit.id);
  run.culpritTaskId = culprit.id; run.culpritAttempt = culprit.currentAttempt;
  run.closureTaskIds = closure; run.remainingTaskIds = run.taskIds.filter(id => !closure.includes(id));
  run.revertBase = run.devHead; run.phase = 'revert-planned';
  store.savePromotion(run);
  return run;
}

async function buildRevert(options: PromotionOptions, run: PromotionRun): Promise<string> {
  const settings = options.settings, main = settings.mainCheckout;
  const base = run.revertBase!;
  const tree = join(settings.worktreeRoot, `promotion-${run.id}-revert`);
  mkdirSync(settings.worktreeRoot, { recursive: true });
  if (existsSync(tree)) { try { git(main, 'worktree', 'remove', '--force', tree); } catch {} }
  git(main, 'worktree', 'add', '--detach', tree, base);
  try {
    const selected = new Set(run.closureTaskIds ?? []);
    const commits = new Set(run.taskIds.filter(id => selected.has(id)).flatMap(id => taskCommits(options, options.job.tasks.store.task(id))));
    const history = git(tree, 'rev-list', '--reverse', `${run.mainBase}..${base}`).split('\n').filter(Boolean);
    const ordered = history.filter(commit => commits.has(commit)).reverse();
    if (!ordered.length) throw new Error('The culprit has no recorded commits to revert');
    for (const commit of ordered) git(tree, 'revert', '--no-edit', '--no-commit', commit);
    git(tree, 'commit', '-m', `Revert failed promotion of ${(run.closureTaskIds ?? []).join(', ')}`);
    return git(tree, 'rev-parse', 'HEAD');
  } finally { git(main, 'worktree', 'remove', '--force', tree); }
}

function prepareCulpritOutcome(options: PromotionOptions, run: PromotionRun): void {
  const task = options.job.tasks.store.task(run.culpritTaskId!);
  const attempt = run.culpritAttempt ?? task.currentAttempt;
  if (task.currentAttempt !== attempt || !attempt) return;
  const failure = run.firstFailure ?? firstFailure('Promotion gate failed');
  options.job.onGateOutcome({ taskId: task.id, attempt, passed: false, stage: 'gate', firstFailure: failure,
    failsOnMain: false, logPath: join(options.settings.stateDirectory, `promotion-${run.id}.log`), hostMs: 0,
    changedFiles: [], diffLines: 0 });
}

/** Publish a proven prefix when main can fast-forward to it; main's own commits reach dev only through later merges. */
function publishPrefix(options: PromotionOptions, run: PromotionRun, target: string, taskIds: readonly string[]): boolean {
  const settings = options.settings, store = options.job.tasks.store, checkout = settings.mainCheckout;
  if (git(checkout, 'symbolic-ref', 'HEAD') !== ref(settings.mainBranch))
    throw new Error(`The main checkout must have ${settings.mainBranch} checked out`);
  if (!isAncestor(checkout, head(checkout, settings.mainBranch), target)) return false;
  store.publishPromotion(taskIds, target, () => {
    options.beforeAdvance?.();
    git(checkout, 'merge', '--ff-only', '--no-edit', target);
  });
  options.job.onPromotionComplete(taskIds, run.id);
  return true;
}

async function publishMain(options: PromotionOptions, run: PromotionRun): Promise<void> {
  const settings = options.settings, store = options.job.tasks.store, checkout = settings.mainCheckout;
  const target = run.promoteHead!;
  if (git(checkout, 'symbolic-ref', 'HEAD') !== ref(settings.mainBranch))
    throw new Error(`The main checkout must have ${settings.mainBranch} checked out`);
  const taskIds = run.promoteTaskIds ?? [];
  const now = head(checkout, settings.mainBranch);
  // Main took commits this snapshot does not contain: drop the run, and the next pass gates a fresh one.
  if (now !== target && !isAncestor(checkout, target, now) && !isAncestor(checkout, now, target)) { store.clearPromotion(); return; }
  store.publishPromotion(taskIds, target, () => {
    const current = head(checkout, settings.mainBranch);
    if (current !== target && !isAncestor(checkout, target, current)) {
      if (!isAncestor(checkout, current, target)) throw new Error('Main moved to a different history during promotion');
      options.beforeAdvance?.();
      git(checkout, 'merge', '--ff-only', '--no-edit', target);
    } else if (git(checkout, 'rev-parse', 'HEAD') !== current) {
      git(checkout, 'reset', '--hard', current);
    }
  });
  options.job.onPromotionComplete(taskIds, run.id);
  store.clearPromotion();
}

// A local switch: while dev is known to be red, gating and bisecting it only spends the machine.
function pausedAt(settings: Settings): boolean { return existsSync(join(settings.stateDirectory, 'promotion.paused')); }

/** Gate integrated work, publish passing commits on main, or isolate the first failing task on dev. */
export async function promote(options: PromotionOptions): Promise<void> {
  const { settings, job } = options, store = job.tasks.store;
  const paused = () => pausedAt(settings);
  if (paused()) return;
  let lease;
  try { lease = acquireDirectoryLease(join(settings.stateDirectory, 'promotion.lease')); }
  catch (error) { if (error instanceof LeaseHeldError) return; throw error; }
  try {
    for (;;) {
      if (paused()) return;
      let run = store.promotion();
      const main = head(settings.mainCheckout, settings.mainBranch);
      let dev: string;
      try { dev = head(settings.mainCheckout, settings.integrationBranch); } catch { return; }
      let derivedPrepared = false;
      if (run?.phase === 'blocked' && run.blockedOn) {
        const culprit = store.task(run.blockedOn.taskId);
        const moved = culprit.currentAttempt > run.blockedOn.attempt && ['integrated', 'merged'].includes(culprit.state);
        if (!moved && culprit.state !== 'cancelled') return;
        store.clearPromotion(); run = undefined;
      }
      if (run?.phase === 'report-environment') {
        if (main === run.mainBase && dev === run.devHead) { reportEnvironment(options, run); return; }
        store.clearPromotion(); run = undefined;
      }
      if (run?.phase === 'gate-head' && dev !== run.devHead) {
        store.clearPromotion(); run = undefined;
      }
      if (!run) {
        if (main === dev || !isAncestor(settings.mainCheckout, main, dev)) return;
        const prepared = await regenerateDerivedHead(options, dev);
        if (prepared.retry) continue;
        dev = prepared.head; derivedPrepared = true;
        const currentMain = head(settings.mainCheckout, settings.mainBranch);
        if (currentMain === dev || !isAncestor(settings.mainCheckout, currentMain, dev)) continue;
        const tasks = boundaryTasks(options, currentMain, dev);
        run = createRun(options, currentMain, dev, tasks);
        store.savePromotion(run);
      }
      if (run.phase === 'gate-head') {
        if (!derivedPrepared) {
          const currentDev = head(settings.mainCheckout, settings.integrationBranch);
          if (currentDev !== run.devHead) { store.clearPromotion(); continue; }
          const prepared = await regenerateDerivedHead(options, run.devHead);
          if (prepared.retry) { store.clearPromotion(); continue; }
          if (prepared.head !== run.devHead) {
            const currentMain = head(settings.mainCheckout, settings.mainBranch);
            if (!isAncestor(settings.mainCheckout, currentMain, prepared.head)) { store.clearPromotion(); continue; }
            run = createRun(options, currentMain, prepared.head,
              boundaryTasks(options, currentMain, prepared.head));
            store.savePromotion(run);
          }
        }
        const tasks = run.taskIds.map(id => store.task(id));
        const checked = await gateAt(options, run, run.devHead, commandsFor(run.rootGate, tasks), 'head', 'headResults');
        run = await saveHeadDecision(options, run, checked);
      }
      if (run.phase === 'classify-main') run = await resolveMainFailure(options, run);
      if (run.phase === 'classify-prefixes') {
        run = await resolveCulprit(options, run);
        if (run.phase === 'classify-prefixes') return;
      }
      // A flaky confirmation stores a fresh gate-head run; start gating that snapshot under this lease.
      if (run.phase === 'gate-head') continue;
      if (run.phase === 'report-environment') { reportEnvironment(options, run); return; }
      if (run.phase === 'revert-planned') {
        const currentDev = head(settings.mainCheckout, settings.integrationBranch);
        if (run.revertCommit && isAncestor(settings.mainCheckout, run.revertCommit, currentDev)) {
          run.phase = 'revert-published'; store.savePromotion(run);
        } else {
          if (currentDev !== run.revertBase) {
            if (!isAncestor(settings.mainCheckout, run.revertBase!, currentDev)) throw new Error('Integration branch moved before culprit reversion');
            run.revertBase = currentDev; delete run.revertCommit; store.savePromotion(run);
          }
          if (!run.revertCommit) {
            try { run.revertCommit = await buildRevert(options, run); }
            catch {
              // Later tasks build on the culprit's change, so it cannot be reverted cleanly: fix it forward instead,
              // and spend no gate until its next attempt integrates.
              prepareCulpritOutcome(options, run);
              job.resumePendingRetries();
              run.blockedOn = { taskId: run.culpritTaskId!, attempt: run.culpritAttempt ?? store.task(run.culpritTaskId!).currentAttempt };
              run.phase = 'blocked'; store.savePromotion(run);
              return;
            }
            store.savePromotion(run);
          }
          if (head(settings.mainCheckout, settings.integrationBranch) === run.revertBase)
            git(settings.mainCheckout, 'update-ref', ref(settings.integrationBranch), run.revertCommit, run.revertBase!);
          run.phase = 'revert-published'; store.savePromotion(run);
        }
      }
      if (run.phase === 'revert-published') {
        store.applyPromotionFailure(run.culpritTaskId!, (run.closureTaskIds ?? []).filter(id => id !== run.culpritTaskId));
        run.phase = 'route-culprit'; store.savePromotion(run);
      }
      if (run.phase === 'route-culprit') {
        prepareCulpritOutcome(options, run);
        // A persisted gate outcome is an outbox for the retry; the manager-host sweep can restart it.
        job.resumePendingRetries();
        run.phase = 'gate-remainder'; store.savePromotion(run);
      }
      if (run.phase === 'gate-remainder') {
        const currentDev = head(settings.mainCheckout, settings.integrationBranch);
        const prepared = await regenerateDerivedHead(options, currentDev);
        if (prepared.retry) continue;
        const promoteHead = prepared.head;
        const remaining = (run.remainingTaskIds ?? []).map(id => store.task(id)).filter(task => task.state === 'integrated');
        run.devHead = promoteHead;
        const checked = await gateAt(options, run, promoteHead, commandsFor(run.rootGate, remaining), 'remainder', 'headResults');
        const failed = checked.find(result => !result.passed);
        if (failed) {
          run.devHead = promoteHead; run.taskIds = remaining.map(task => task.id); run.boundaries = remaining
            .filter(task => task.integratedCommit).map(task => ({ taskId: task.id, commit: task.integratedCommit! }));
          const narrowed = narrowedFailure(options, run, failed, 'remainder', checked.indexOf(failed));
          run.headResults = []; run.prefixResults = []; run.firstFailure = narrowed.failure;
          run.failedCommand = narrowed.command; run.phase = 'classify-main'; store.savePromotion(run);
          continue;
        }
        run.promoteHead = promoteHead; run.promoteTaskIds = remaining.map(task => task.id); run.phase = 'publish-main'; store.savePromotion(run);
      }
      if (run.phase === 'publish-main') {
        await publishMain(options, run);
        // Another integration may have landed while this snapshot was gated. Continue under the same lease.
        continue;
      }
      if (!store.promotion()) continue;
      return;
    }
  } finally { lease.release(); }
}
