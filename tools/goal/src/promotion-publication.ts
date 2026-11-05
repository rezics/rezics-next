import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import defaults from '../defaults.json';
import { matchesPath } from './briefs.ts';
import { git } from './merge.ts';
import { defaultPolicy } from './policy.ts';
import { isAncestor } from './promotion-attribution.ts';
import type { PromotionOptions } from './promotion.ts';
import type { DerivedFile, PromotionRun } from './types.ts';

const defaultDerivedFiles = defaults.derivedFiles as DerivedFile[];
const ZERO_OID = '0000000000000000000000000000000000000000';
/** The paths main may take directly while a snapshot is gated. */
const CONTROL_PLANE_PATHS = ['tools/goal/'];

export function ref(branch: string): string {
  return `refs/heads/${branch}`;
}
export function head(cwd: string, branch: string): string {
  return git(cwd, 'rev-parse', '--verify', ref(branch));
}
export function optionalHead(cwd: string, branch: string): string | undefined {
  try {
    return head(cwd, branch);
  } catch {
    return undefined;
  }
}

function notifySupermanager(options: PromotionOptions, summary: string): void {
  options.job.inbox.deliver({
    managerId: options.settings.integration.supermanager,
    kind: 'environment',
    summary: summary.replace(/[\r\n]+/g, ' '),
  });
}

export function controlPlaneOnly(checkout: string, main: string, snapshot: string): boolean {
  const base = git(checkout, 'merge-base', main, snapshot);
  const changed = git(checkout, 'diff', '--name-only', base, main).split('\n').filter(Boolean);
  return changed.length > 0 && changed.every((path) => CONTROL_PLANE_PATHS.some((prefix) => path.startsWith(prefix)));
}

// Promotion regenerates derived files on stabilize alone, so dev can lack main's last commit. The merge keeps dev's
// side of a derived-file conflict, since the next promotion regenerates those files anyway.
function mergeMainIntoDev(
  options: PromotionOptions,
  target: string,
  branch = options.settings.integrationBranch,
): string | undefined {
  const settings = options.settings,
    checkout = settings.mainCheckout;
  const derived = (options.derivedFiles ?? defaultDerivedFiles).map((file) => file.path);
  for (let attempt = 0; attempt < (options.settings.policy ?? defaultPolicy).promotion.advanceAttempts; attempt++) {
    const current = optionalHead(checkout, branch);
    if (!current) return undefined;
    if (isAncestor(checkout, target, current)) return current;
    const tree = join(settings.worktreeRoot, `promotion-merge-${randomUUID()}`);
    mkdirSync(settings.worktreeRoot, { recursive: true });
    git(checkout, 'worktree', 'add', '--detach', tree, current);
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
        git(checkout, 'update-ref', ref(branch), commit, current);
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

/** Publish a proven prefix when main can fast-forward to it; main's own commits reach dev only through later merges. */
export function publishPrefix(
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

export function createPreparedStabilize(checkout: string, branch: string, preparedHead: string): boolean {
  try {
    git(checkout, 'update-ref', ref(branch), preparedHead, ZERO_OID);
    return true;
  } catch {
    return optionalHead(checkout, branch) !== undefined;
  }
}

export function advancePreparedStabilize(checkout: string, branch: string, expected: string, next: string): void {
  try {
    git(checkout, 'update-ref', ref(branch), next, expected);
  } catch {
    // A concurrent stabilize update must win over this stale promotion snapshot.
  }
}

async function advanceStabilizeAfterPublish(
  options: PromotionOptions,
  run: PromotionRun,
  quickGate: (snapshot: string) => Promise<boolean>,
): Promise<boolean> {
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
  if (!(await quickGate(dev))) return true;
  advancePreparedStabilize(checkout, settings.stabilizeBranch, target, dev);
  return true;
}

export async function publishMain(
  options: PromotionOptions,
  run: PromotionRun,
  quickGate: (snapshot: string) => Promise<boolean>,
): Promise<boolean> {
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
  const stabilized = await advanceStabilizeAfterPublish(options, run, quickGate);
  store.clearPromotion();
  return stabilized;
}
