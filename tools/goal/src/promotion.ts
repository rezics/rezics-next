import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { acquireDirectoryLease, LeaseHeldError } from './lease.ts';
import { firstFailure, gateRunner, git, type GateRunner } from './merge.ts';
import type { PromotionGateResult, PromotionRun, Task } from './types.ts';
import type { WorkerJob } from './job.ts';
import type { Settings } from './types.ts';

export type PromotionOptions = { settings: Settings; job: WorkerJob; runGate?: GateRunner; beforeAdvance?: () => void };

const ref = (branch: string) => `refs/heads/${branch}`;
function isAncestor(cwd: string, older: string, newer: string): boolean {
  try { git(cwd, 'merge-base', '--is-ancestor', older, newer); return true; } catch { return false; }
}
function head(cwd: string, branch: string): string { return git(cwd, 'rev-parse', '--verify', ref(branch)); }
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
function commandsFor(rootGate: readonly string[], tasks: readonly Task[]): string[][] {
  return [rootGate, ...tasks.map(task => task.brief.acceptance.command)].map(command => [...command]);
}
function resultKey(result: PromotionGateResult): string { return `${result.commit}\n${JSON.stringify(result.command)}`; }
function appendResult(run: PromotionRun, target: 'headResults' | 'prefixResults', result: PromotionGateResult): PromotionRun {
  const key = resultKey(result), results = run[target];
  const index = results.findIndex(existing => resultKey(existing) === key);
  if (index < 0) results.push(result); else results[index] = result;
  return run;
}

async function gateAt(options: PromotionOptions, run: PromotionRun, commit: string, commands: readonly string[][], label: string,
  target: 'headResults' | 'prefixResults'): Promise<PromotionGateResult[]> {
  const store = options.job.tasks.store, main = options.settings.mainCheckout;
  const results: PromotionGateResult[] = [];
  const tree = join(options.settings.worktreeRoot, `promotion-${run.id}-${label}`);
  for (let index = 0; index < commands.length; index++) {
    const command = [...commands[index]!];
    const cached = run[target].find(result => result.commit === commit && JSON.stringify(result.command) === JSON.stringify(command));
    if (cached) results.push(cached);
  }
  if (results.length === commands.length) return results;
  const logFor = (index: number) => join(options.settings.stateDirectory, `promotion-${run.id}-${label}-${index}.log`);
  mkdirSync(options.settings.worktreeRoot, { recursive: true });
  if (existsSync(tree)) { try { git(main, 'worktree', 'remove', '--force', tree); } catch {} }
  git(main, 'worktree', 'add', '--detach', tree, commit);
  try {
    results.length = 0;
    for (let index = 0; index < commands.length; index++) {
      const command = [...commands[index]!];
      const cached = run[target].find(result => result.commit === commit && JSON.stringify(result.command) === JSON.stringify(command));
      if (cached) { results.push(cached); continue; }
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
    }
  } finally { git(main, 'worktree', 'remove', '--force', tree); }
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

async function saveHeadDecision(options: PromotionOptions, run: PromotionRun, result: PromotionGateResult[]): Promise<PromotionRun> {
  const failed = result.find(item => !item.passed);
  if (!failed) {
    run.phase = 'publish-main'; run.promoteHead = run.devHead; run.promoteTaskIds = [...run.taskIds];
    options.job.tasks.store.savePromotion(run); return run;
  }
  run.firstFailure = failed.firstFailure ?? firstFailure('Promotion gate failed');
  run.failedCommand = [...failed.command]; run.phase = 'classify-main';
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
  const results = new Map<string, PromotionGateResult[]>();
  await concurrent(run.boundaries, run.promotionParallelism, async (boundary, index) => {
    const currentPrefix = tasks.slice(0, index + 1);
    const checked = await gateAt(options, run, boundary.commit, commandsFor(run.rootGate, currentPrefix), `prefix-${index}`, 'prefixResults');
    results.set(boundary.taskId, checked);
  });
  const failed = run.boundaries.find(boundary => results.get(boundary.taskId)?.some(result => !result.passed));
  if (!failed) {
    run.phase = 'report-environment';
    store.savePromotion(run); return run;
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

async function publishMain(options: PromotionOptions, run: PromotionRun): Promise<void> {
  const settings = options.settings, store = options.job.tasks.store, checkout = settings.mainCheckout;
  const target = run.promoteHead!;
  if (git(checkout, 'symbolic-ref', 'HEAD') !== ref(settings.mainBranch))
    throw new Error(`The main checkout must have ${settings.mainBranch} checked out`);
  const taskIds = run.promoteTaskIds ?? [];
  store.publishPromotion(taskIds, target, () => {
    const current = head(checkout, settings.mainBranch);
    if (current !== target && !isAncestor(checkout, target, current)) {
      if (current !== run.mainBase) throw new Error('Main moved to a different history during promotion');
      options.beforeAdvance?.();
      git(checkout, 'merge', '--ff-only', '--no-edit', target);
    } else if (git(checkout, 'rev-parse', 'HEAD') !== current) {
      git(checkout, 'reset', '--hard', current);
    }
  });
  options.job.onPromotionComplete(taskIds, run.id);
  store.clearPromotion();
}

/** Gate integrated work, publish passing commits on main, or isolate the first failing task on dev. */
export async function promote(options: PromotionOptions): Promise<void> {
  const { settings, job } = options, store = job.tasks.store;
  let lease;
  try { lease = acquireDirectoryLease(join(settings.stateDirectory, 'promotion.lease')); }
  catch (error) { if (error instanceof LeaseHeldError) return; throw error; }
  try {
    for (;;) {
      let run = store.promotion();
      const main = head(settings.mainCheckout, settings.mainBranch);
      let dev: string;
      try { dev = head(settings.mainCheckout, settings.integrationBranch); } catch { return; }
      if (run?.phase === 'report-environment') {
        if (main === run.mainBase && dev === run.devHead) { reportEnvironment(options, run); return; }
        store.clearPromotion(); run = undefined;
      }
      if (!run) {
        if (main === dev || !isAncestor(settings.mainCheckout, main, dev)) return;
        const tasks = boundaryTasks(options, main, dev);
        run = createRun(options, main, dev, tasks);
        store.savePromotion(run);
      }
      if (run.phase === 'gate-head') {
        const tasks = run.taskIds.map(id => store.task(id));
        const checked = await gateAt(options, run, run.devHead, commandsFor(run.rootGate, tasks), 'head', 'headResults');
        run = await saveHeadDecision(options, run, checked);
      }
      if (run.phase === 'classify-main') run = await resolveMainFailure(options, run);
      if (run.phase === 'classify-prefixes') run = await resolveCulprit(options, run);
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
          if (!run.revertCommit) { run.revertCommit = await buildRevert(options, run); store.savePromotion(run); }
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
        const promoteHead = head(settings.mainCheckout, settings.integrationBranch);
        const remaining = (run.remainingTaskIds ?? []).map(id => store.task(id)).filter(task => task.state === 'integrated');
        const checked = await gateAt(options, run, promoteHead, commandsFor(run.rootGate, remaining), 'remainder', 'headResults');
        const failed = checked.find(result => !result.passed);
        if (failed) {
          run.devHead = promoteHead; run.taskIds = remaining.map(task => task.id); run.boundaries = remaining
            .filter(task => task.integratedCommit).map(task => ({ taskId: task.id, commit: task.integratedCommit! }));
          run.headResults = []; run.prefixResults = []; run.firstFailure = failed.firstFailure ?? firstFailure('Promotion gate failed');
          run.failedCommand = [...failed.command]; run.phase = 'classify-main'; store.savePromotion(run);
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
