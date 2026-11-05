export type RefUpdate = { ref: string; previous: string; next: string };

export type RefPlan = { updates: RefUpdate[]; warnings: string[] };

export type RefTransactionResult = { status: number; stdout: string; stderr: string };

export type CpSyncRefTransactionContext = {
  checkout: string;
  main: string;
  dev: string;
  stabilize?: string;
  conflictPathLimit: number;
  git: (...args: string[]) => string;
  run: (args: readonly string[], options?: { input?: string }) => RefTransactionResult;
  head: (branch: string) => string | undefined;
  isAncestor: (ancestor: string, descendant: string) => boolean;
  changedPaths: (from: string, to: string, paths: readonly string[]) => string[];
  replacePaths: (base: string, source: string, paths: readonly string[]) => string;
  commitTree: (tree: string, parents: readonly string[], message: string) => string;
  assertCheckoutReady: (expectedHead: string, paths: readonly string[]) => void;
  refuse: (message: string) => never;
  short: (revision: string) => string;
  redact: (text: string) => string;
};

function transact(context: CpSyncRefTransactionContext, updates: readonly RefUpdate[]): RefTransactionResult {
  const input = updates.map((update) => `update ${update.ref} ${update.next} ${update.previous}\n`).join('');
  return context.run(['update-ref', '-m', 'cp-sync', '--stdin'], { input });
}

/**
 * Main gets `next`; stabilize (when present) and dev merge it so main stays inside both and promotion can still
 * fast-forward. Dev keeps its own tree: everything the new main commit holds is already on dev (a sync) or is a
 * main-only emergency measure dev supersedes (a rollback). Stabilize takes the control-plane paths from main.
 */
export function planCpSyncRefs(
  context: CpSyncRefTransactionContext,
  mode: 'sync' | 'rollback',
  previous: string,
  next: string,
  paths: readonly string[],
  source?: string,
): RefPlan {
  const updates: RefUpdate[] = [{ ref: `refs/heads/${context.main}`, previous, next }];
  const warnings: string[] = [];
  const dev = context.head(context.dev);
  if (!dev) context.refuse(`Branch ${context.dev} does not exist.`);
  if (source && !context.isAncestor(source, dev))
    context.refuse(`${context.dev} no longer contains the synced source ${context.short(source)}; run again.`);
  let devParent = next;
  const stabilize = context.stabilize ? context.head(context.stabilize) : undefined;
  if (context.stabilize && stabilize && !context.isAncestor(next, stabilize)) {
    let keep = false;
    if (mode === 'sync') {
      const own = context.changedPaths(context.git('merge-base', stabilize, source!), stabilize, paths);
      if (own.length)
        context.refuse(
          `${context.stabilize} changed ${own.slice(0, context.conflictPathLimit).join(', ')} without ${context.dev}; syncing would drop those changes.`,
        );
    } else if (context.changedPaths(previous, stabilize, paths).length) {
      keep = true;
      warnings.push(
        `${context.stabilize} has newer control-plane code than main; it keeps it, so its next promotion republishes it.`,
      );
    }
    const tree = keep ? context.git('rev-parse', `${stabilize}^{tree}`) : context.replacePaths(stabilize, next, paths);
    const merged = context.commitTree(tree, [stabilize, next], `Merge ${context.main} into ${context.stabilize}`);
    updates.push({ ref: `refs/heads/${context.stabilize}`, previous: stabilize, next: merged });
    if (context.isAncestor(stabilize, dev)) devParent = merged;
  }
  if (!context.isAncestor(devParent, dev)) {
    const from = devParent === next || !context.stabilize ? context.main : context.stabilize;
    const merged = context.commitTree(
      context.git('rev-parse', `${context.dev}^{tree}`),
      [dev, devParent],
      `Merge ${from} into ${context.dev}`,
    );
    updates.push({ ref: `refs/heads/${context.dev}`, previous: dev, next: merged });
  }
  return { updates, warnings };
}

/**
 * Move the checkout files before the atomic ref transaction. Rebuild the plan after a stale ref compare so unrelated
 * dev or stabilize advances are retained; restore the files if no transaction lands.
 */
export function publishCpSyncRefs(
  context: CpSyncRefTransactionContext,
  mode: 'sync' | 'rollback',
  previous: string,
  next: string,
  paths: readonly string[],
  source: string | undefined,
  print: (line: string) => void,
): RefPlan {
  context.assertCheckoutReady(previous, paths);
  const moved = context.run(['read-tree', '-m', '-u', previous, next]);
  if (moved.status !== 0)
    context.refuse(`Could not update the main checkout's files: ${context.redact(moved.stderr.trim())}`);
  let published: RefPlan | undefined;
  let failure = '';
  try {
    for (let attempt = 0; attempt < 5 && !published; attempt++) {
      if (context.head(context.main) !== previous) {
        failure = `${context.main} moved during publication`;
        break;
      }
      const candidate = planCpSyncRefs(context, mode, previous, next, paths, source);
      const result = transact(context, candidate.updates);
      if (result.status === 0) published = candidate;
      else failure = context.redact(result.stderr.trim());
    }
  } finally {
    if (!published) {
      const back = context.run(['read-tree', '-m', '-u', next, previous]);
      if (back.status !== 0)
        print(
          `cp-sync: could not restore the main checkout's files; run \`git -C ${context.checkout} read-tree -m -u ${next} ${previous}\`: ${context.redact(back.stderr.trim())}`,
        );
    }
  }
  if (!published) context.refuse(`No ref moved: ${failure}`);
  if (
    context.git('rev-parse', 'HEAD') !== next ||
    context.run(['diff', '--quiet', 'HEAD', '--', ...paths]).status !== 0 ||
    context.run(['diff', '--cached', '--quiet', 'HEAD', '--', ...paths]).status !== 0
  )
    print(`cp-sync: WARNING: the main checkout does not match ${context.short(next)} under ${paths.join(', ')}; inspect it.`);
  return published;
}
