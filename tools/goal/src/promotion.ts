import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import defaults from '../defaults.json';
import { defaultPolicy } from './policy.ts';
import { acquireDirectoryLease, LeaseHeldError } from './lease.ts';
import { matchesPath } from './briefs.ts';
import { firstFailure, gateRunner, git, type GateRunner } from './merge.ts';
import { commandsFor, gateAt, rerunStabilizeInfrastructure } from './promotion-checks.ts';
import {
  boundaryTasks,
  createRun,
  isAncestor,
  narrowedFailure,
  pausedAt,
  resolveCulprit,
  resolveMainFailure,
  taskCommits,
} from './promotion-attribution.ts';
import type { DerivedFile } from './merge-train.ts';
import type { PromotionGateResult, PromotionRun } from './types.ts';
import type { WorkerJob } from './job.ts';
import type { Settings } from './types.ts';
import { recordFlow } from './flow.ts';
import {
  beginPromotionParentWindow,
  finishPromotionParentWindow,
  recoverIncompletePromotionWindows,
} from './promotion-observation.ts';

export { PROMOTION_GATE_TIMEOUT_MS, commandsFor, coveredByRootGate, promotionCommand } from './promotion-checks.ts';

const defaultDerivedFiles = defaults.derivedFiles as DerivedFile[];
export type PromotionOptions = {
  settings: Settings;
  job: WorkerJob;
  runGate?: GateRunner;
  beforeAdvance?: () => void;
  derivedFiles?: DerivedFile[];
  prepareGateCommand?: (run: PromotionRun, command: readonly string[]) => string[] | null;
  observationParentId?: string;
};

function observe<T>(action: () => T): T | undefined {
  try {
    return action();
  } catch {
    // Promotion observation is best-effort and can never alter a gate verdict.
    return undefined;
  }
}

// The root gate runs every workspace on one gate host; with every workspace grown it outlasted two hours (a timeout at
// 2 h 05 m on 2026-10-29 blocked every promotion), so it gets four.
const STABILIZE_QUICK_GATE = [
  ['bun', 'scripts/typecheck.ts'],
  ['bun', 'run', '--cwd', 'packages/definitions', 'release'],
] as const;
const ref = (branch: string) => `refs/heads/${branch}`;
function sourceDevBranch(settings: Settings): string {
  // 'dev-verified' records verifier progress and known findings; promotion always freezes the latest integration head
  // and must pass its own full candidate gate.
  return settings.integrationBranch;
}
function head(cwd: string, branch: string): string {
  return git(cwd, 'rev-parse', '--verify', ref(branch));
}
function optionalHead(cwd: string, branch: string): string | undefined {
  try {
    return head(cwd, branch);
  } catch {
    return undefined;
  }
}
function workingFiles(cwd: string): string[] {
  const tracked = spawnSync('git', ['diff', '--name-only', '-z', 'HEAD', '--'], { cwd, encoding: 'utf8' });
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd, encoding: 'utf8' });
  if (tracked.status !== 0 || untracked.status !== 0) throw new Error('Cannot read generated file changes');
  return [...new Set([...tracked.stdout.split('\0'), ...untracked.stdout.split('\0')].filter(Boolean))];
}

export async function regenerateDerivedHead(
  options: Pick<PromotionOptions, 'settings' | 'derivedFiles'>,
  expected: string,
  branch = sourceDevBranch(options.settings),
): Promise<{ head: string; retry: boolean }> {
  const settings = options.settings,
    checkout = settings.mainCheckout;
  const files = (options.derivedFiles ?? defaultDerivedFiles).filter((file) => file.stage === 'promotion');
  if (!files.length) return { head: expected, retry: head(checkout, branch) !== expected };

  const tree = join(settings.worktreeRoot, `promotion-derived-${randomUUID()}`);
  const logPath = join(settings.stateDirectory, `promotion-derived-${randomUUID()}.log`);
  mkdirSync(settings.worktreeRoot, { recursive: true });
  mkdirSync(settings.stateDirectory, { recursive: true });
  git(checkout, 'worktree', 'add', '--detach', tree, expected);
  try {
    const tracked = git(tree, 'ls-files', '-z').split('\0').filter(Boolean);
    const commands = new Map<string, string[]>();
    for (const file of files)
      if (tracked.some((path) => matchesPath(path, [file.path], settings.policy?.brief)))
        commands.set(JSON.stringify(file.command), file.command);
    // A fresh worktree has no node_modules, and generators such as the kernel's run its installed tools.
    const install =
      commands.size && existsSync(join(tree, 'package.json')) ? [['bun', 'install', '--frozen-lockfile']] : [];
    for (const command of [...install, ...commands.values()]) {
      const result = spawnSync(command[0]!, command.slice(1), { cwd: tree, encoding: 'utf8' });
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      appendFileSync(logPath, `$ ${command.join(' ')} (cwd: ${tree})\n${output}`);
      if (result.status !== 0)
        throw new Error(`Failed to regenerate derived files: ${output || result.error?.message || 'command failed'}`);
    }

    const changes = workingFiles(tree);
    const outside = changes.filter(
      (path) => !files.some((file) => matchesPath(path, [file.path], settings.policy?.brief)),
    );
    if (outside.length) throw new Error(`Derived generator changed non-derived files: ${outside.join(', ')}`);
    let candidate = expected;
    if (changes.length) {
      git(tree, 'add', '-A', '--', ...changes);
      git(tree, 'commit', '-m', 'chore: regenerate derived files');
      candidate = git(tree, 'rev-parse', 'HEAD');
    }

    if (head(checkout, branch) !== expected) return { head: head(checkout, branch), retry: true };
    if (candidate !== expected) {
      try {
        git(checkout, 'update-ref', ref(branch), candidate, expected);
      } catch (error) {
        const current = head(checkout, branch);
        if (current !== expected) return { head: current, retry: true };
        throw error;
      }
    }
    const current = head(checkout, branch);
    return current === candidate ? { head: candidate, retry: false } : { head: current, retry: true };
  } finally {
    // Generators can leave ignored dependency trees behind. Remove their files before unregistering the worktree.
    rmSync(tree, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    git(checkout, 'worktree', 'remove', '--force', tree);
  }
}

function reportEnvironment(options: PromotionOptions, run: PromotionRun): void {
  const failure = run.firstFailure ?? run.mainResult?.firstFailure;
  const task =
    run.taskIds.map((id) => options.job.tasks.store.task(id)).find((candidate) => candidate.currentAttempt > 0) ??
    options.job.tasks.store
      .tasks()
      .find((candidate) => candidate.state === 'integrated' && candidate.currentAttempt > 0);
  if (failure && task) options.job.reportPromotionEnvironment(task.id, failure);
}

// The root gate names its failing workspaces on its last line. Bisecting on the first one's check costs a fraction of
// the root gate per probe, and a flake in another workspace cannot decide a probe.
function notifySupermanager(options: PromotionOptions, summary: string, evidencePath?: string): void {
  options.job.inbox.deliver({
    managerId: options.settings.integration.supermanager,
    kind: 'environment',
    summary: summary.replace(/[\r\n]+/g, ' '),
    ...(evidencePath ? { evidencePath } : {}),
  });
}

function blockStabilize(
  options: PromotionOptions,
  run: PromotionRun,
  failed: PromotionGateResult,
  index: number,
): void {
  const logPath = join(options.settings.stateDirectory, `promotion-${run.id}-head-${index}.log`);
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  const workspaces = /^Failed workspaces:\s*(.+)$/m.exec(log)?.[1]?.trim() ?? 'unknown';
  const narrowed = narrowedFailure(options, run, failed, 'head', index);
  const files = narrowed.command.slice(5);
  const tests = files.length ? `; failing tests: ${files.join(', ')}` : '';
  run.firstFailure = narrowed.failure;
  run.failedCommand = narrowed.command;
  run.phase = 'stabilize-blocked';
  options.job.tasks.store.savePromotion(run);
  notifySupermanager(
    options,
    `Stabilize candidate ${run.devHead} is blocked; failing workspaces: ${workspaces}${tests}; gate log: ${logPath}`,
    logPath,
  );
}

async function saveHeadDecision(
  options: PromotionOptions,
  run: PromotionRun,
  result: PromotionGateResult[],
): Promise<PromotionRun> {
  const failed = result.find((item) => !item.passed);
  if (!failed) {
    run.phase = 'publish-main';
    run.promoteHead = run.devHead;
    run.promoteTaskIds = [...run.taskIds];
    options.job.tasks.store.savePromotion(run);
    return run;
  }
  const narrowed = narrowedFailure(options, run, failed, 'head', result.indexOf(failed));
  run.firstFailure = narrowed.failure;
  run.failedCommand = narrowed.command;
  run.phase = 'classify-main';
  options.job.tasks.store.savePromotion(run);
  return run;
}

async function buildRevert(options: PromotionOptions, run: PromotionRun): Promise<string> {
  const settings = options.settings,
    main = settings.mainCheckout;
  const base = run.revertBase!;
  const tree = join(settings.worktreeRoot, `promotion-${run.id}-revert`);
  mkdirSync(settings.worktreeRoot, { recursive: true });
  if (existsSync(tree)) {
    try {
      git(main, 'worktree', 'remove', '--force', tree);
    } catch {}
  }
  git(main, 'worktree', 'add', '--detach', tree, base);
  try {
    const selected = new Set(run.closureTaskIds ?? []);
    const commits = new Set(
      run.taskIds
        .filter((id) => selected.has(id))
        .flatMap((id) => taskCommits(options, options.job.tasks.store.task(id))),
    );
    const history = git(tree, 'rev-list', '--reverse', `${run.mainBase}..${base}`).split('\n').filter(Boolean);
    const ordered = history.filter((commit) => commits.has(commit)).reverse();
    if (!ordered.length) throw new Error('The culprit has no recorded commits to revert');
    for (const commit of ordered) git(tree, 'revert', '--no-edit', '--no-commit', commit);
    git(tree, 'commit', '-m', `Revert failed promotion of ${(run.closureTaskIds ?? []).join(', ')}`);
    return git(tree, 'rev-parse', 'HEAD');
  } finally {
    git(main, 'worktree', 'remove', '--force', tree);
  }
}

function prepareCulpritOutcome(options: PromotionOptions, run: PromotionRun): void {
  const task = options.job.tasks.store.task(run.culpritTaskId!);
  const attempt = run.culpritAttempt ?? task.currentAttempt;
  if (task.currentAttempt !== attempt || !attempt) return;
  const failure = run.firstFailure ?? firstFailure('Promotion gate failed');
  options.job.onGateOutcome({
    taskId: task.id,
    attempt,
    passed: false,
    stage: 'gate',
    firstFailure: failure,
    failsOnMain: false,
    logPath: join(options.settings.stateDirectory, `promotion-${run.id}.log`),
    hostMs: 0,
    changedFiles: [],
    diffLines: 0,
  });
}

/** Publish a proven prefix when main can fast-forward to it; main's own commits reach dev only through later merges. */
function publishPrefix(
  options: PromotionOptions,
  run: PromotionRun,
  target: string,
  taskIds: readonly string[],
): boolean {
  const settings = options.settings,
    store = options.job.tasks.store,
    checkout = settings.mainCheckout;
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

// Promotion regenerates derived files on stabilize alone, so dev can lack main's last commit. The merge keeps dev's
// side of a derived-file conflict, since the next promotion regenerates those files anyway.
function mergeMainIntoDev(
  options: PromotionOptions,
  target: string,
  branch = sourceDevBranch(options.settings),
): string | undefined {
  const settings = options.settings,
    checkout = settings.mainCheckout;
  const derived = (options.derivedFiles ?? defaultDerivedFiles).map((file) => file.path);
  for (let attempt = 0; attempt < (options.settings.policy ?? defaultPolicy).promotion.advanceAttempts; attempt++) {
    const dev = optionalHead(checkout, branch);
    if (!dev) return undefined;
    if (isAncestor(checkout, target, dev)) return dev;
    const tree = join(settings.worktreeRoot, `promotion-merge-${randomUUID()}`);
    mkdirSync(settings.worktreeRoot, { recursive: true });
    git(checkout, 'worktree', 'add', '--detach', tree, dev);
    try {
      const merged = spawnSync('git', ['merge', '--no-ff', '--no-edit', '-m', `Merge main into ${branch}`, target], {
        cwd: tree,
        encoding: 'utf8',
      });
      if (merged.status !== 0) {
        const conflicts = git(tree, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
        if (!conflicts.length || conflicts.some((path) => !matchesPath(path, derived, settings.policy?.brief)))
          return undefined;
        try {
          git(tree, 'checkout', '--ours', '--', ...conflicts);
          git(tree, 'add', '--', ...conflicts);
          git(tree, '-c', 'core.editor=true', 'commit', '--no-edit');
        } catch {
          return undefined;
        }
      }
      const commit = git(tree, 'rev-parse', 'HEAD');
      try {
        git(checkout, 'update-ref', ref(branch), commit, dev);
        return commit;
      } catch {
        // Dev moved during the merge; merge again onto its new head.
      }
    } finally {
      git(checkout, 'worktree', 'remove', '--force', tree);
    }
  }
  return undefined;
}

/** The paths main may take directly while a snapshot is gated. */
const CONTROL_PLANE_PATHS = ['tools/goal/'];

function controlPlaneOnly(checkout: string, main: string, snapshot: string): boolean {
  const base = git(checkout, 'merge-base', main, snapshot);
  const changed = git(checkout, 'diff', '--name-only', base, main).split('\n').filter(Boolean);
  return changed.length > 0 && changed.every((path) => CONTROL_PLANE_PATHS.some((prefix) => path.startsWith(prefix)));
}

/** Merge main's newer control-plane commits into the gated candidate; undefined when they conflict. */
function mergeMainIntoCandidate(
  options: PromotionOptions,
  main: string,
  snapshot: string,
  branch: string,
): string | undefined {
  const settings = options.settings,
    checkout = settings.mainCheckout;
  const tree = join(settings.worktreeRoot, `promotion-candidate-${randomUUID()}`);
  mkdirSync(settings.worktreeRoot, { recursive: true });
  git(checkout, 'worktree', 'add', '--detach', tree, snapshot);
  try {
    const merged = spawnSync(
      'git',
      ['merge', '--no-ff', '--no-edit', '-m', `Merge ${settings.mainBranch} into ${settings.stabilizeBranch}`, main],
      { cwd: tree, encoding: 'utf8' },
    );
    if (merged.status !== 0) return undefined;
    const candidate = git(tree, 'rev-parse', 'HEAD');
    try {
      git(checkout, 'update-ref', ref(branch), candidate, snapshot);
      return candidate;
    } catch {
      return undefined;
    }
  } finally {
    git(checkout, 'worktree', 'remove', '--force', tree);
  }
}

async function advanceStabilizeAfterPublish(options: PromotionOptions, run: PromotionRun): Promise<boolean> {
  const settings = options.settings,
    checkout = settings.mainCheckout,
    target = run.promoteHead!;
  const stabilize = optionalHead(checkout, settings.stabilizeBranch);
  if (stabilize === undefined) return false;
  if (stabilize !== target) return true;
  const dev = mergeMainIntoDev(options, target);
  if (!dev) {
    notifySupermanager(
      options,
      `Published main at ${target}, but main does not merge into dev; stabilize remains at ${target}.`,
    );
    return true;
  }
  if (!(await stabilizeQuickGate(options, dev))) return true;
  try {
    git(checkout, 'update-ref', ref(settings.stabilizeBranch), dev, target);
  } catch {
    // A concurrent stabilize update must win over this stale promotion snapshot.
  }
  return true;
}

async function publishMain(options: PromotionOptions, run: PromotionRun): Promise<boolean> {
  const settings = options.settings,
    store = options.job.tasks.store,
    checkout = settings.mainCheckout;
  let target = run.promoteHead!;
  if (git(checkout, 'symbolic-ref', 'HEAD') !== ref(settings.mainBranch))
    throw new Error(`The main checkout must have ${settings.mainBranch} checked out`);
  const taskIds = run.promoteTaskIds ?? [];
  const now = head(checkout, settings.mainBranch);
  if (now !== target && !isAncestor(checkout, target, now) && !isAncestor(checkout, now, target)) {
    // Control-plane fixes land on main directly while a snapshot is gated; they do not touch what the gate checked, so
    // the snapshot is published merged with them. Any other commit on main drops the run for a fresh gate.
    const merged = controlPlaneOnly(checkout, now, target)
      ? mergeMainIntoCandidate(options, now, target, settings.stabilizeBranch)
      : undefined;
    if (!merged) {
      store.clearPromotion();
      return false;
    }
    run.promoteHead = target = merged;
    store.savePromotion(run);
  }
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
  // A merged main is in no candidate yet; the next window must contain it, or no later snapshot could be published.
  const stabilize = optionalHead(checkout, settings.stabilizeBranch);
  if (stabilize !== undefined && !isAncestor(checkout, target, stabilize)) {
    const advanced = mergeMainIntoDev(options, target, settings.stabilizeBranch);
    if (!advanced)
      notifySupermanager(
        options,
        `Published main at ${target}, but main does not merge into ${settings.stabilizeBranch}.`,
      );
  }
  const stabilized = await advanceStabilizeAfterPublish(options, run);
  store.clearPromotion();
  return stabilized;
}

/** Create the next frozen candidate only from a dev snapshot that passes the short preflight. */
async function stabilizeQuickGate(options: PromotionOptions, dev: string): Promise<boolean> {
  const { settings } = options;
  const checkout = settings.mainCheckout;
  const tree = join(settings.worktreeRoot, `promotion-quick-${randomUUID()}`);
  mkdirSync(settings.worktreeRoot, { recursive: true });
  git(checkout, 'worktree', 'add', '--detach', tree, dev);
  try {
    if (existsSync(join(tree, 'package.json'))) {
      const installed = spawnSync('bun', ['install', '--frozen-lockfile'], { cwd: tree, encoding: 'utf8' });
      if (installed.status !== 0) return false;
    }
    for (const command of STABILIZE_QUICK_GATE) {
      const result = await (
        options.runGate ?? gateRunner((options.settings.policy ?? defaultPolicy).promotion.gateTimeoutMs)
      )(command, tree, join(settings.stateDirectory, `promotion-quick-${dev}-${command[command.length - 1]}.log`));
      if (!result.passed || git(tree, 'rev-parse', 'HEAD') !== dev || git(tree, 'status', '--porcelain')) return false;
    }
    return head(checkout, sourceDevBranch(settings)) === dev;
  } finally {
    git(checkout, 'worktree', 'remove', '--force', tree);
  }
}

async function cutStabilizeCandidate(options: PromotionOptions, dev: string): Promise<boolean> {
  const { settings } = options;
  const checkout = settings.mainCheckout;
  const sourceBranch = sourceDevBranch(settings);
  const prepared = await regenerateDerivedHead(options, dev, sourceBranch);
  if (prepared.retry || optionalHead(checkout, settings.stabilizeBranch) !== undefined) return false;
  if (
    !(await stabilizeQuickGate(options, prepared.head)) ||
    optionalHead(checkout, settings.stabilizeBranch) !== undefined
  )
    return false;
  if (head(checkout, sourceBranch) !== prepared.head) return false;
  try {
    git(
      checkout,
      'update-ref',
      ref(settings.stabilizeBranch),
      prepared.head,
      '0000000000000000000000000000000000000000',
    );
    return true;
  } catch {
    return optionalHead(checkout, settings.stabilizeBranch) !== undefined;
  }
}

/** Gate integrated work, publish passing commits on main, or isolate the first failing task on dev. */
export async function promote(options: PromotionOptions): Promise<void> {
  const { settings, job } = options,
    store = job.tasks.store;
  const paused = () => pausedAt(settings);
  if (paused()) return;
  let lease;
  try {
    lease = acquireDirectoryLease(join(settings.stateDirectory, 'promotion.lease'), settings.policy?.leases);
  } catch (error) {
    if (error instanceof LeaseHeldError) return;
    throw error;
  }
  observe(() => recoverIncompletePromotionWindows(store.db));
  const previousParentId = options.observationParentId;
  const observationParentId = observe(() => beginPromotionParentWindow(store.db, store.promotion()?.id ?? null));
  if (observationParentId) options.observationParentId = observationParentId;
  try {
    for (;;) {
      if (paused()) return;
      let run = store.promotion();
      const main = head(settings.mainCheckout, settings.mainBranch);
      let dev: string;
      try {
        dev = head(settings.mainCheckout, sourceDevBranch(settings));
      } catch {
        return;
      }
      const stabilize = optionalHead(settings.mainCheckout, settings.stabilizeBranch);
      if (stabilize === undefined) {
        if (!(await cutStabilizeCandidate(options, dev))) return;
        continue;
      }
      if (stabilize === main && dev !== stabilize) {
        if (!(await stabilizeQuickGate(options, dev))) return;
        if (
          head(settings.mainCheckout, sourceDevBranch(settings)) !== dev ||
          optionalHead(settings.mainCheckout, settings.stabilizeBranch) !== stabilize
        )
          continue;
        try {
          git(settings.mainCheckout, 'update-ref', ref(settings.stabilizeBranch), dev, stabilize);
        } catch {
          // A concurrent stabilize update wins; re-read it under the same promotion lease.
        }
        continue;
      }
      const stabilization = stabilize !== undefined;
      const candidateBranch = stabilization ? settings.stabilizeBranch : sourceDevBranch(settings);
      let candidate = stabilize ?? dev;
      let derivedPrepared = false;
      if (run?.phase === 'blocked' && run.blockedOn) {
        const culprit = store.task(run.blockedOn.taskId);
        const moved =
          culprit.currentAttempt > run.blockedOn.attempt && ['integrated', 'merged'].includes(culprit.state);
        if (!moved && culprit.state !== 'cancelled') return;
        store.clearPromotion();
        run = undefined;
      }
      if (run?.phase === 'stabilize-blocked') {
        if (stabilize === run.devHead) return;
        store.clearPromotion();
        run = undefined;
        candidate = stabilize ?? dev;
      }
      if (run?.phase === 'report-environment') {
        if (main === run.mainBase && dev === run.devHead) {
          reportEnvironment(options, run);
          return;
        }
        store.clearPromotion();
        run = undefined;
      }
      if (run?.phase === 'gate-head' && candidate !== run.devHead) {
        store.clearPromotion();
        run = undefined;
      }
      if (!run) {
        if (
          main === candidate ||
          (!isAncestor(settings.mainCheckout, main, candidate) &&
            !controlPlaneOnly(settings.mainCheckout, main, candidate))
        )
          return;
        const prepared = await regenerateDerivedHead(options, candidate, candidateBranch);
        if (prepared.retry) continue;
        candidate = prepared.head;
        derivedPrepared = true;
        const currentMain = head(settings.mainCheckout, settings.mainBranch);
        if (currentMain === candidate || !isAncestor(settings.mainCheckout, currentMain, candidate)) continue;
        const tasks = boundaryTasks(options, currentMain, candidate);
        run = createRun(options, currentMain, candidate, tasks);
        store.savePromotion(run);
      }
      if (run.phase === 'gate-head') {
        if (!derivedPrepared) {
          const currentCandidate = head(settings.mainCheckout, candidateBranch);
          if (currentCandidate !== run.devHead) {
            store.clearPromotion();
            continue;
          }
          const prepared = await regenerateDerivedHead(options, run.devHead, candidateBranch);
          if (prepared.retry) {
            store.clearPromotion();
            continue;
          }
          if (prepared.head !== run.devHead) {
            const currentMain = head(settings.mainCheckout, settings.mainBranch);
            if (!isAncestor(settings.mainCheckout, currentMain, prepared.head)) {
              store.clearPromotion();
              continue;
            }
            run = createRun(options, currentMain, prepared.head, boundaryTasks(options, currentMain, prepared.head));
            store.savePromotion(run);
          }
        }
        const tasks = run.taskIds.map((id) => store.task(id));
        const headCommands = commandsFor(run.rootGate, tasks, options.settings.mainCheckout, run.devHead);
        let checked = await gateAt(options, run, run.devHead, headCommands, 'head', 'headResults');
        if (stabilization) checked = await rerunStabilizeInfrastructure(options, run, checked, headCommands);
        const failed = checked.find((item) => !item.passed);
        if (stabilization && failed) {
          blockStabilize(options, run, failed, checked.indexOf(failed));
          return;
        }
        run = await saveHeadDecision(options, run, checked);
      }
      if (run.phase === 'stabilize-blocked') return;
      if (run.phase === 'classify-main') run = await resolveMainFailure(options, run);
      if (run.phase === 'classify-prefixes') {
        const attributionRun = run;
        run = await resolveCulprit(
          options,
          attributionRun,
          (target, taskIds) => publishPrefix(options, attributionRun, target, taskIds),
        );
        if (run.phase === 'classify-prefixes') return;
      }
      // A flaky confirmation stores a fresh gate-head run; start gating that snapshot under this lease.
      if (run.phase === 'gate-head') continue;
      if (run.phase === 'report-environment') {
        reportEnvironment(options, run);
        return;
      }
      if (run.phase === 'revert-planned') {
        const devBranch = sourceDevBranch(settings);
        const currentDev = head(settings.mainCheckout, devBranch);
        if (run.revertCommit && isAncestor(settings.mainCheckout, run.revertCommit, currentDev)) {
          run.phase = 'revert-published';
          store.savePromotion(run);
        } else {
          if (currentDev !== run.revertBase) {
            if (!isAncestor(settings.mainCheckout, run.revertBase!, currentDev))
              throw new Error('Integration branch moved before culprit reversion');
            run.revertBase = currentDev;
            delete run.revertCommit;
            store.savePromotion(run);
          }
          if (!run.revertCommit) {
            try {
              run.revertCommit = await buildRevert(options, run);
            } catch {
              // Later tasks build on the culprit's change, so it cannot be reverted cleanly: fix it forward instead,
              // and spend no gate until its next attempt integrates.
              prepareCulpritOutcome(options, run);
              job.resumePendingRetries();
              run.blockedOn = {
                taskId: run.culpritTaskId!,
                attempt: run.culpritAttempt ?? store.task(run.culpritTaskId!).currentAttempt,
              };
              run.phase = 'blocked';
              store.savePromotion(run);
              return;
            }
            store.savePromotion(run);
          }
          if (head(settings.mainCheckout, devBranch) === run.revertBase)
            git(settings.mainCheckout, 'update-ref', ref(devBranch), run.revertCommit, run.revertBase!);
          run.phase = 'revert-published';
          store.savePromotion(run);
        }
      }
      if (run.phase === 'revert-published') {
        store.applyPromotionFailure(
          run.culpritTaskId!,
          (run.closureTaskIds ?? []).filter((id) => id !== run.culpritTaskId),
        );
        run.phase = 'route-culprit';
        store.savePromotion(run);
      }
      if (run.phase === 'route-culprit') {
        prepareCulpritOutcome(options, run);
        // A persisted gate outcome is an outbox for the retry; the manager-host sweep can restart it.
        job.resumePendingRetries();
        run.phase = 'gate-remainder';
        store.savePromotion(run);
      }
      if (run.phase === 'gate-remainder') {
        const currentDev = head(settings.mainCheckout, sourceDevBranch(settings));
        const prepared = await regenerateDerivedHead(options, currentDev);
        if (prepared.retry) continue;
        const promoteHead = prepared.head;
        const remaining = (run.remainingTaskIds ?? [])
          .map((id) => store.task(id))
          .filter((task) => task.state === 'integrated');
        run.devHead = promoteHead;
        const checked = await gateAt(
          options,
          run,
          promoteHead,
          commandsFor(run.rootGate, remaining, options.settings.mainCheckout, run.devHead),
          'remainder',
          'headResults',
        );
        const failed = checked.find((result) => !result.passed);
        if (failed) {
          run.devHead = promoteHead;
          run.taskIds = remaining.map((task) => task.id);
          run.boundaries = remaining
            .filter((task) => task.integratedCommit)
            .map((task) => ({ taskId: task.id, commit: task.integratedCommit! }));
          const narrowed = narrowedFailure(options, run, failed, 'remainder', checked.indexOf(failed));
          run.headResults = [];
          run.prefixResults = [];
          run.firstFailure = narrowed.failure;
          run.failedCommand = narrowed.command;
          run.phase = 'classify-main';
          store.savePromotion(run);
          continue;
        }
        run.promoteHead = promoteHead;
        run.promoteTaskIds = remaining.map((task) => task.id);
        run.phase = 'publish-main';
        store.savePromotion(run);
      }
      if (run.phase === 'publish-main') {
        const published = await publishMain(options, run);
        if (published) {
          for (const taskId of run.promoteTaskIds ?? []) {
            const task = store.task(taskId);
            recordFlow(store.db, {
              taskId,
              attempt: task.currentAttempt,
              stage: 'promotion',
              action: 'promoted',
              at: new Date().toISOString(),
            });
          }
          const currentMain = head(settings.mainCheckout, settings.mainBranch);
          const currentCandidate = optionalHead(settings.mainCheckout, settings.stabilizeBranch);
          // Promotion may have started on an older candidate while integrated tasks advanced dev. Gate those tasks
          // before releasing the lease; a reconciliation merge with no tasks can wait for the next promotion window.
          if (currentCandidate === undefined || !boundaryTasks(options, currentMain, currentCandidate).length) return;
        }
        // Another integration landed while this snapshot was gated. Continue under the same lease.
        continue;
      }
      if (!store.promotion()) continue;
      return;
    }
  } finally {
    observe(() => finishPromotionParentWindow(store.db, observationParentId));
    if (previousParentId === undefined) delete options.observationParentId;
    else options.observationParentId = previousParentId;
    lease.release();
  }
}
