import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { firstFailure, git } from './merge.ts';
import { gateAt } from './promotion-checks.ts';
import type { FirstFailure } from './contracts.ts';
import type { PromotionGateResult, PromotionRun, Settings, Task } from './types.ts';
import type { PromotionOptions } from './promotion.ts';

export function isAncestor(cwd: string, older: string, newer: string): boolean {
  try {
    git(cwd, 'merge-base', '--is-ancestor', older, newer);
    return true;
  } catch {
    return false;
  }
}
export function boundaryTasks(options: PromotionOptions, main: string, dev: string): Task[] {
  const store = options.job.tasks.store,
    checkout = options.settings.mainCheckout;
  const commits = git(options.settings.mainCheckout, 'rev-list', '--reverse', `${main}..${dev}`)
    .split('\n')
    .filter(Boolean);
  const position = new Map(commits.map((commit, index) => [commit, index]));
  for (const task of store
    .tasks()
    .filter((task) => task.state === 'integrated' && !task.integratedCommit && task.currentAttempt > 0)) {
    try {
      const branchCommit = git(checkout, 'rev-parse', '--verify', `refs/heads/${task.branch}^{commit}`);
      if (!position.has(branchCommit) || !isAncestor(checkout, task.base, branchCommit)) continue;
      const integratedCommits = git(checkout, 'rev-list', '--reverse', `${task.base}..${branchCommit}`)
        .split('\n')
        .filter(Boolean);
      store.updateTask({ taskId: task.id, attempt: task.currentAttempt }, (current) => {
        current.integratedCommit = branchCommit;
        current.integratedBase = task.base;
        current.integratedCommits = integratedCommits;
      });
    } catch {
      /* Legacy imported integration records may not have a usable worker branch. */
    }
  }
  return store
    .tasks()
    .filter((task) => task.state === 'integrated' && task.integratedCommit && position.has(task.integratedCommit))
    .sort((a, b) => position.get(a.integratedCommit!)! - position.get(b.integratedCommit!)!);
}
export function taskCommits(options: PromotionOptions, task: Task): string[] {
  if (task.integratedCommits) return [...task.integratedCommits];
  if (!task.integratedCommit) return [];
  const base = task.integratedBase ?? task.base;
  try {
    return git(options.settings.mainCheckout, 'rev-list', '--reverse', `${base}..${task.integratedCommit}`)
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}
async function concurrent<T>(
  items: readonly T[],
  count: number,
  action: (value: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(items.length, count) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        await action(items[index]!, index);
      }
    }),
  );
}

export function createRun(options: PromotionOptions, main: string, dev: string, tasks: readonly Task[]): PromotionRun {
  const boundaries = tasks
    .filter((task) => task.integratedCommit)
    .map((task) => ({ taskId: task.id, commit: task.integratedCommit! }));
  return {
    id: randomUUID(),
    phase: 'gate-head',
    mainBase: main,
    devHead: dev,
    taskIds: tasks.map((task) => task.id),
    rootGate: [...options.settings.gate],
    promotionParallelism: options.settings.promotionParallelism,
    boundaries,
    headResults: [],
    prefixResults: [],
  };
}

export type PromotionFlakeEvent = {
  kind: 'promotion-flake';
  taskId: string;
  commit: string;
  command: string[];
  initial: PromotionGateResult;
  confirmation: PromotionGateResult;
  logs: [string, string];
};
export type PromotionRunWithFlakes = PromotionRun & { flakeEvents?: PromotionFlakeEvent[] };
export type PromotionProbeRetry = {
  kind: 'promotion-probe-retry';
  taskId: string;
  commit: string;
  command: string[];
  initial: PromotionGateResult;
  retry: PromotionGateResult;
  logs: [string, string];
};
export type PromotionRunWithProbeRetries = PromotionRun & { probeRetries?: PromotionProbeRetry[] };

export function dependentClosure(tasks: readonly Task[], culprit: string): string[] {
  const selected = new Set([culprit]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks)
      if (!selected.has(task.id) && task.brief.after.some((dependency) => selected.has(dependency))) {
        selected.add(task.id);
        changed = true;
      }
  }
  return tasks.filter((task) => selected.has(task.id)).map((task) => task.id);
}

export function narrowedFailure(
  options: PromotionOptions,
  run: PromotionRun,
  failed: PromotionGateResult,
  label: string,
  index: number,
): { command: string[]; failure: FirstFailure } {
  const fallback = {
    command: [...failed.command],
    failure: failed.firstFailure ?? firstFailure('Promotion gate failed'),
  };
  const logPath = join(options.settings.stateDirectory, `promotion-${run.id}-${label}-${index}.log`);
  if (JSON.stringify(failed.command) !== JSON.stringify(run.rootGate) || !existsSync(logPath)) return fallback;
  const log = readFileSync(logPath, 'utf8');
  const workspace = /^Failed workspaces: (\S+)/m.exec(log)?.[1];
  if (!workspace) return fallback;
  const block = log
    .split(/^(?=Workspace )/m)
    .find((part) => part.split('\n', 2)[1]?.trimEnd().endsWith(`(${workspace})`));
  // A check that takes test files as arguments and lists the ones that failed, as the kernel's does, is bisected on
  // those files: a minute per probe instead of the whole suite's twenty.
  const listed =
    /tests failed for \d+ file\(s\):\n((?:\S+\.test\.tsx?\n?)+)/
      .exec(block ?? '')?.[1]
      ?.trim()
      .split('\n') ?? [];
  const files = listed.length && listed.length <= 50 ? listed : [];
  return { command: ['bun', 'run', '--cwd', workspace, 'check', ...files], failure: firstFailure(block ?? log) };
}

export async function resolveMainFailure(options: PromotionOptions, run: PromotionRun): Promise<PromotionRun> {
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

export type PromotionPrefixPublisher = (target: string, taskIds: readonly string[]) => boolean;

export async function resolveCulprit(
  options: PromotionOptions,
  run: PromotionRun,
  publishPrefix: PromotionPrefixPublisher,
): Promise<PromotionRun> {
  const store = options.job.tasks.store;
  const tasks = run.taskIds.map((id) => store.task(id));
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
      saved.probeRetries = [
        ...(saved.probeRetries ?? []),
        {
          kind: 'promotion-probe-retry',
          taskId: boundary.taskId,
          commit: boundary.commit,
          command: [...command],
          initial: initial!,
          retry: result,
          logs: [initialLog, retryLog],
        },
      ];
      store.savePromotion(run);
    }
    results.set(index, result);
  };
  // A task's own acceptance command only means something from that task on; earlier prefixes cannot be its culprit.
  const owner = run.boundaries.findIndex(
    (boundary) => JSON.stringify(store.task(boundary.taskId).brief.acceptance.command) === JSON.stringify(command),
  );
  let low = owner >= 0 ? owner : 0,
    high = run.boundaries.length - 1;
  if (high < 0) {
    run.phase = 'report-environment';
    store.savePromotion(run);
    return run;
  }
  if (run.boundaries[high]!.commit !== run.devHead) {
    // Commits after the last task boundary are not tasks; when the last boundary passes, no task is to blame.
    await probe(high);
    if (results.get(high)!.passed) {
      run.phase = 'report-environment';
      store.savePromotion(run);
      return run;
    }
  }
  while (low < high) {
    // Pausing stops a bisection between rounds; its probe results stay cached for when it resumes.
    if (pausedAt(options.settings)) return run;
    const span = high - low,
      count = Math.min(run.promotionParallelism, span);
    const picks = [
      ...new Set(Array.from({ length: count }, (_, k) => low + Math.floor(((k + 1) * span) / (count + 1)))),
    ]
      .filter((index) => index < high)
      .sort((a, b) => a - b);
    if (!picks.length) picks.push(low);
    await concurrent(picks, run.promotionParallelism, async (index) => probe(index));
    for (const index of picks) {
      if (results.get(index)!.passed) low = Math.max(low, index + 1);
      else {
        high = index;
        break;
      }
    }
  }
  const culpritResult = results.get(high);
  // Every prefix before the culprit passed the root gate, so main takes it now; a flake or a second breakage later in
  // this run cannot hold back work that is already proven.
  if (
    high > 0 &&
    results.get(high - 1)?.passed &&
    JSON.stringify(command) === JSON.stringify(run.rootGate) &&
    publishPrefix(run.boundaries[high - 1]!.commit, run.taskIds.slice(0, high))
  ) {
    run.mainBase = run.boundaries[high - 1]!.commit;
    run.taskIds = run.taskIds.slice(high);
    run.boundaries = run.boundaries.slice(high);
    high = 0;
    store.savePromotion(run);
  }
  const failedBoundaryIndex = high;
  const failed = run.boundaries[failedBoundaryIndex]!;
  const initial =
    culpritResult ??
    run.headResults.find((result) => !result.passed && JSON.stringify(result.command) === JSON.stringify(command))!;
  const commandIndex = 0;
  const confirmationLabel = 'confirm-culprit';
  const confirmationLog = join(options.settings.stateDirectory, `promotion-${run.id}-${confirmationLabel}-0.log`);
  const initialLog = join(
    options.settings.stateDirectory,
    `promotion-${run.id}-prefix-${failedBoundaryIndex}-${commandIndex}.log`,
  );
  const confirmation = (
    await gateAt(options, run, failed.commit, [initial.command], confirmationLabel, 'prefixResults', true)
  )[0]!;
  if (confirmation.passed || confirmation.firstFailure?.fingerprint !== initial.firstFailure?.fingerprint) {
    const event: PromotionFlakeEvent = {
      kind: 'promotion-flake',
      taskId: failed.taskId,
      commit: failed.commit,
      command: [...initial.command],
      initial,
      confirmation,
      logs: [initialLog, confirmationLog],
    };
    const currentDev = git(
      options.settings.mainCheckout,
      'rev-parse',
      '--verify',
      `refs/heads/${options.settings.integrationBranch}`,
    );
    const currentMain = git(
      options.settings.mainCheckout,
      'rev-parse',
      '--verify',
      `refs/heads/${options.settings.mainBranch}`,
    );
    const next = createRun(
      options,
      currentMain,
      currentDev,
      boundaryTasks(options, currentMain, currentDev),
    ) as PromotionRunWithFlakes;
    next.flakeEvents = [...((run as PromotionRunWithFlakes).flakeEvents ?? []), event];
    store.savePromotion(next);
    return next;
  }
  const culprit = store.task(failed.taskId);
  const closure = dependentClosure(tasks, culprit.id);
  run.culpritTaskId = culprit.id;
  run.culpritAttempt = culprit.currentAttempt;
  run.closureTaskIds = closure;
  run.remainingTaskIds = run.taskIds.filter((id) => !closure.includes(id));
  run.revertBase = run.devHead;
  run.phase = 'revert-planned';
  store.savePromotion(run);
  return run;
}

// A local switch: while dev is known to be red, gating and bisecting it only spends the machine.
export function pausedAt(settings: Settings): boolean {
  return existsSync(join(settings.stateDirectory, 'promotion.paused'));
}
