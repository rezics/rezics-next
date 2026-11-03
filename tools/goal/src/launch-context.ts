import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { StaleAttemptError, type AttemptRef } from './contracts.ts';
import type { WorkerStore } from './store.ts';
import type { Task } from './types.ts';

export type LaunchBoundary = 'fresh' | 'retry' | 'held-release' | 'wake' | 'adopted-legacy';
export type Presence = 'present' | 'absent' | 'unknown' | 'not-checked';
export type DependencyReceipt = {
  id: string;
  state: string;
  completion: 'integrated' | 'not-integrated' | 'unknown';
  commit: string | null;
  sourcePresence: Presence;
  basePresence: Presence;
  precondition: 'satisfied' | 'unmet' | 'unknown';
  reason?: string;
};
export type LaunchContext = {
  version: 1;
  boundary: LaunchBoundary;
  origin: 'managed' | 'adopted-legacy';
  task: {
    id: string;
    attempt: number;
    state: string;
    branch: string | null;
    worktree: string | null;
    contractPath: string | null;
    contractSha256: string | null;
    contractProof: 'verified' | 'mismatch' | 'unknown';
    base: string | null;
    sourceHead: string | null;
    sourceBranch: string | null;
    sourceProof: 'verified' | 'unknown';
    sourceReason?: string;
  };
  dependencies: {
    required: number | null;
    included: number;
    omitted: number;
    completeness: 'complete' | 'truncated' | 'unknown';
    receipts: DependencyReceipt[];
  };
};

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const MAX_DEPENDENCIES = 48;
const MAX_TEXT = 512;
const MAX_RENDERED_BYTES = 12_000;

function bounded(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== 'string') return null;
  return value.replace(/[\r\n\0]/g, ' ').slice(0, max);
}

function briefHash(markdown: string): string {
  return createHash('sha256').update(markdown.replace(/\r\n?/g, '\n').trimEnd()).digest('hex');
}

type GitValue = { value?: string; reason?: string };
function gitValue(cwd: string, args: string[]): GitValue {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 });
  if (result.status !== 0) {
    const reason = result.error?.message ?? result.stderr?.trim() ?? `git exited ${result.status}`;
    return { reason: bounded(reason, 300) ?? 'git command failed' };
  }
  return { value: result.stdout.trim() };
}

function isCommit(cwd: string, value: string | null): boolean {
  if (!value || !OBJECT_ID.test(value)) return false;
  const result = spawnSync('git', ['cat-file', '-e', `${value}^{commit}`], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024,
  });
  return result.status === 0;
}

type Ancestry = { presence: Exclude<Presence, 'not-checked'>; reason?: string };
function ancestorPresence(cwd: string, commit: string, tip: string): Ancestry {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', commit, tip], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024,
  });
  if (result.status === 0) return { presence: 'present' };
  if (result.status === 1) return { presence: 'absent' };
  const reason = result.error?.message ?? result.stderr?.trim() ?? `git exited ${result.status}`;
  return { presence: 'unknown', reason: bounded(reason, 300) ?? 'Git could not verify dependency ancestry' };
}

function dependencyReceipt(
  store: WorkerStore,
  id: string,
  source: { worktree: string | null; head: string | null; base: string | null; verified: boolean },
): DependencyReceipt {
  const name = bounded(id) ?? '<unknown dependency>';
  const dependency = store.dependency(id);
  if (!dependency)
    return {
      id: name,
      state: 'missing',
      completion: 'unknown',
      commit: null,
      sourcePresence: 'unknown',
      basePresence: 'unknown',
      precondition: 'unknown',
      reason: 'no task record exists for this declared dependency',
    };

  const state = bounded(dependency.state, 80) ?? 'unknown';
  const commit =
    typeof dependency.task_commit === 'string' && OBJECT_ID.test(dependency.task_commit)
      ? dependency.task_commit
      : null;
  const complete = state === 'integrated' || state === 'merged';
  if (!complete)
    return {
      id: name,
      state,
      completion: 'not-integrated',
      commit,
      sourcePresence: 'not-checked',
      basePresence: 'not-checked',
      precondition: 'unmet',
      reason: state === 'cancelled' ? 'dependency is cancelled' : 'dependency is not integrated or merged',
    };

  if (!commit)
    return {
      id: name,
      state,
      completion: 'integrated',
      commit: null,
      sourcePresence: 'unknown',
      basePresence: 'unknown',
      precondition: 'unknown',
      reason: 'the current task record has no valid integrated or merged commit',
    };
  if (!source.verified || !source.worktree || !source.head)
    return {
      id: name,
      state,
      completion: 'integrated',
      commit,
      sourcePresence: 'unknown',
      basePresence: 'unknown',
      precondition: 'unknown',
      reason: 'the current task source identity could not be verified',
    };
  if (!isCommit(source.worktree, commit))
    return {
      id: name,
      state,
      completion: 'integrated',
      commit,
      sourcePresence: 'unknown',
      basePresence: 'unknown',
      precondition: 'unknown',
      reason: 'the dependency commit is not available in the current task checkout',
    };

  const sourceSeen = ancestorPresence(source.worktree, commit, source.head);
  const baseSeen =
    source.base && source.base !== source.head
      ? ancestorPresence(source.worktree, commit, source.base)
      : source.base
        ? sourceSeen
        : { presence: 'unknown' as const, reason: 'prepared task base is unavailable' };
  const sourcePresence = sourceSeen.presence;
  const basePresence = baseSeen.presence;
  const precondition =
    basePresence === 'present'
      ? 'satisfied'
      : sourcePresence === 'unknown' && basePresence === 'unknown'
        ? 'unknown'
        : 'unmet';
  const reason =
    basePresence === 'present'
      ? undefined
      : sourcePresence === 'present' && basePresence === 'absent'
        ? 'the dependency commit is in the current task source but not an ancestor of the prepared base'
        : sourcePresence === 'absent'
          ? 'the dependency commit is not an ancestor of the current task source'
          : (baseSeen.reason ?? sourceSeen.reason);
  return {
    id: name,
    state,
    completion: 'integrated',
    commit,
    sourcePresence,
    basePresence,
    precondition,
    ...(reason ? { reason } : {}),
  };
}

function sourceFacts(task: Task) {
  const worktree = bounded(task.worktree);
  const base = bounded(task.base, 128);
  if (!task.worktree || !task.branch)
    return {
      worktree,
      base,
      head: null,
      branch: null,
      verified: false,
      reason: 'historical task record has no dispatchable worktree or branch identity',
    };
  try {
    const expectedRoot = realpathSync(task.worktree);
    const root = gitValue(task.worktree, ['rev-parse', '--show-toplevel']);
    const head = gitValue(task.worktree, ['rev-parse', '--verify', 'HEAD']);
    const branch = gitValue(task.worktree, ['branch', '--show-current']);
    if (!root.value || resolve(root.value) !== expectedRoot)
      return {
        worktree,
        base,
        head: head.value ?? null,
        branch: branch.value ?? null,
        verified: false,
        reason: 'Git root does not match the stored worktree identity',
      };
    if (!head.value || !OBJECT_ID.test(head.value) || !isCommit(task.worktree, head.value))
      return {
        worktree,
        base,
        head: null,
        branch: branch.value ?? null,
        verified: false,
        reason: head.reason ?? 'current source HEAD is unavailable',
      };
    if (branch.value !== task.branch)
      return {
        worktree,
        base,
        head: head.value,
        branch: branch.value ?? null,
        verified: false,
        reason: 'current Git branch does not match the stored task branch',
      };
    if (!base || !isCommit(task.worktree, base))
      return {
        worktree,
        base,
        head: head.value,
        branch: branch.value,
        verified: false,
        reason: 'stored task base is unavailable in the current checkout',
      };
    return { worktree, base, head: head.value, branch: branch.value, verified: true };
  } catch (error) {
    return {
      worktree,
      base,
      head: null,
      branch: null,
      verified: false,
      reason: bounded(error instanceof Error ? error.message : String(error), 300) ?? 'source identity is unavailable',
    };
  }
}

/** Capture bounded receipts from the current store generation and its exact task checkout. Caller holds that task's lease. */
export function captureLaunchContext(
  store: WorkerStore,
  ref: AttemptRef,
  boundary: LaunchBoundary,
  origin: LaunchContext['origin'] = 'managed',
): LaunchContext {
  store.assertCurrent(ref);
  const task = store.task(ref.taskId);
  const attempt = store.attempt(ref);
  if (
    task.id !== ref.taskId ||
    task.currentAttempt !== ref.attempt ||
    attempt.taskId !== ref.taskId ||
    attempt.attempt !== ref.attempt
  )
    throw new StaleAttemptError(ref, task.currentAttempt);

  const markdown = typeof task.brief?.markdown === 'string' ? task.brief.markdown : null;
  const hash = markdown === null ? null : briefHash(markdown);
  let contractProof: LaunchContext['task']['contractProof'] = 'unknown';
  if (task.briefPath && hash) {
    try {
      contractProof = briefHash(readFileSync(task.briefPath, 'utf8')) === hash ? 'verified' : 'mismatch';
    } catch {
      contractProof = 'unknown';
    }
  }
  const source = sourceFacts(task);
  const rawAfter = (task.brief as { after?: unknown }).after;
  const after = Array.isArray(rawAfter) ? rawAfter : null;
  const receipts = (after ?? []).slice(0, MAX_DEPENDENCIES).map((value, index) => {
    if (typeof value !== 'string')
      return {
        id: `<invalid dependency ${index + 1}>`,
        state: 'unknown',
        completion: 'unknown' as const,
        commit: null,
        sourcePresence: 'unknown' as const,
        basePresence: 'unknown' as const,
        precondition: 'unknown' as const,
        reason: 'historical task record contains an invalid dependency id',
      };
    return dependencyReceipt(store, value, {
      worktree: source.worktree,
      head: source.head,
      base: source.base,
      verified: source.verified,
    });
  });
  return {
    version: 1,
    boundary,
    origin,
    task: {
      id: bounded(task.id) ?? '<unknown task>',
      attempt: ref.attempt,
      state: bounded(task.state, 80) ?? 'unknown',
      branch: bounded(task.branch),
      worktree: source.worktree,
      contractPath: bounded(task.briefPath, 1024),
      contractSha256: hash,
      contractProof,
      base: source.base,
      sourceHead: source.head,
      sourceBranch: source.branch,
      sourceProof: source.verified ? 'verified' : 'unknown',
      ...(source.reason ? { sourceReason: source.reason } : {}),
    },
    dependencies: {
      required: after?.length ?? null,
      included: receipts.length,
      omitted: after ? Math.max(0, after.length - receipts.length) : 0,
      completeness: after ? (after.length === receipts.length ? 'complete' : 'truncated') : 'unknown',
      receipts,
    },
  };
}

/** One factual line: prepared-base presence, current-source presence, or an unproven observation. */
export function dependencyLine(receipt: DependencyReceipt): string {
  const id = `\`${receipt.id}\``;
  if (receipt.basePresence === 'present' && receipt.commit)
    return `- ${id}: integrated in your base at \`${receipt.commit}\`.`;
  if (receipt.sourcePresence === 'present' && receipt.commit)
    return receipt.basePresence === 'absent'
      ? `- ${id}: present in current source at \`${receipt.commit}\`; not in your prepared base.`
      : `- ${id}: present in current source at \`${receipt.commit}\`; prepared-base presence is unavailable.`;
  if (receipt.sourcePresence === 'unknown' && receipt.basePresence !== 'absent')
    return `- ${id}: source observation is unavailable; build against its contract.`;
  return `- ${id}: not in your base; build against its contract.`;
}

/** Render the launch facts without log text, provider output, configuration, secrets or unbounded dependency lists. */
export function renderLaunchContext(context: LaunchContext | undefined): string {
  if (!context)
    return [
      '## Current controller launch context',
      'No controller launch context was supplied. Dependency status is unknown: build against each dependency contract.',
    ].join('\n');

  const json = JSON.stringify({
    version: context.version,
    boundary: context.boundary,
    origin: context.origin,
    task: context.task,
  });
  const lines = context.dependencies.receipts.map(dependencyLine);
  while (lines.length && Buffer.byteLength(lines.join('\n')) + Buffer.byteLength(json) > MAX_RENDERED_BYTES)
    lines.pop();
  const omitted = (context.dependencies.required ?? context.dependencies.receipts.length) - lines.length;
  return [
    '## Current controller launch context',
    'This prompt and these facts supersede saved sessions, retry manifests and earlier results.',
    ...(lines.length || omitted > 0 ? ['Dependencies:', ...lines] : []),
    ...(omitted > 0 ? [`- ${omitted} more: not listed; build against their contracts.`] : []),
    '```json',
    json,
    '```',
  ].join('\n');
}
