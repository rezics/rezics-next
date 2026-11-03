import { defaultPolicy } from './policy.ts';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import type { ProcessIdentity } from './process.ts';
import type { AttemptRef } from './contracts.ts';

export type OwnerConflictOperation = 'rebase' | 'merge';
export type OwnerConflictState =
  | 'prepared'
  | 'running'
  | 'resolved'
  | 'rerere'
  | 'integrated'
  | 'blocked'
  | 'cancelled'
  | 'superseded';
export type OwnerConflictResolution = 'owner' | 'rerere';

/** Durable input for one conflict-only continuation of the existing worker session. */
export type OwnerConflictHandoff = AttemptRef & {
  id: string;
  owner: string;
  sessionId: string | null;
  sourceCommit: string;
  acceptanceCommit: string;
  devHead: string;
  originalBase: string;
  conflictFiles: string[];
  /** Candidate task owners when a shared-workspace merge cannot name one resolver safely. */
  attributedTaskIds: string[];
  worktree: string;
  originalContract: string;
  operation: OwnerConflictOperation;
  createdAt: string;
};

/** Receipt records exactly which source was resolved and which original source acceptance had checked. */
export type OwnerConflictReceipt = AttemptRef & {
  handoffId: string;
  status: 'resolved' | 'rerere' | 'blocked' | 'stale';
  resolution?: OwnerConflictResolution;
  owner: string;
  sessionId: string | null;
  sourceCommit: string;
  acceptanceCommit: string;
  devHead: string;
  conflictFiles: string[];
  attributedTaskIds: string[];
  resolvedCommit?: string;
  at: string;
  detail?: string;
};

/** Persisted lifecycle record. Worker process identities make handoffs attachable after a train restart. */
export type OwnerConflictRecord = OwnerConflictHandoff & {
  state: OwnerConflictState;
  updatedAt: string;
  workerProcess?: ProcessIdentity | null;
  logStartOffset?: number;
  receipt?: OwnerConflictReceipt;
};

const transitions: Record<OwnerConflictState, readonly OwnerConflictState[]> = {
  prepared: ['running', 'rerere', 'blocked', 'cancelled', 'superseded'],
  running: ['resolved', 'blocked', 'cancelled', 'superseded'],
  resolved: ['integrated', 'cancelled', 'superseded'],
  rerere: ['integrated', 'cancelled', 'superseded'],
  integrated: [],
  blocked: [],
  cancelled: [],
  superseded: [],
};

export function transitionOwnerConflict(
  record: OwnerConflictRecord,
  state: OwnerConflictState,
  changes: Partial<Pick<OwnerConflictRecord, 'workerProcess' | 'logStartOffset' | 'receipt'>> = {},
  at = new Date().toISOString(),
): OwnerConflictRecord {
  if (record.state !== state && !transitions[record.state].includes(state))
    throw new Error(`invalid owner-conflict transition ${record.state} -> ${state}`);
  return { ...record, ...changes, state, updatedAt: at };
}

export function ownerConflictFiles(paths: readonly string[]): string[] {
  const normalized = [...new Set(paths)].sort();
  for (const path of normalized) {
    if (!path || isAbsolute(path) || path.split(/[\\/]/).some((part) => part === '..'))
      throw new Error(`invalid owner-conflict path: ${path}`);
  }
  return normalized;
}

export function newOwnerConflictHandoff(
  input: Omit<OwnerConflictHandoff, 'id' | 'createdAt' | 'conflictFiles' | 'attributedTaskIds'> & {
    conflictFiles: readonly string[];
    attributedTaskIds?: readonly string[];
  },
  now = new Date(),
): OwnerConflictHandoff {
  if (!input.taskId || !Number.isInteger(input.attempt) || input.attempt < 1)
    throw new Error('owner-conflict handoff requires a current attempt');
  if (!input.sourceCommit || !input.acceptanceCommit || !input.devHead || !input.originalBase)
    throw new Error('owner-conflict handoff requires source and integration commits');
  if (!input.worktree || !input.owner || !input.originalContract)
    throw new Error('owner-conflict handoff requires its owner, worktree and original contract');
  const conflictFiles = ownerConflictFiles(input.conflictFiles);
  if (!conflictFiles.length) throw new Error('owner-conflict handoff requires conflict files');
  return {
    ...input,
    conflictFiles,
    attributedTaskIds: [...new Set(input.attributedTaskIds ?? [input.taskId])].sort(),
    id: randomUUID(),
    createdAt: now.toISOString(),
  };
}

/** Explicit per-command rerere configuration keeps all owned worktrees on one common-dir cache. */
export function ownerConflictGitConfig(cwd: string, policy = defaultPolicy.merge): string[] {
  const common = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8', timeout: policy.commandTimeoutMs, maxBuffer: policy.gitBufferBytes });
  if (common.status !== 0)
    throw new Error(common.stderr?.trim() || common.error?.message || 'Cannot locate Git common directory');
  const rrCache = resolve(cwd, common.stdout.trim(), 'rr-cache');
  return ['-c', 'rerere.enabled=true', '-c', 'rerere.autoupdate=true', '-c', `rerere.dir=${rrCache}`];
}

/** Caps inherited pairs so validation cannot walk an unbounded GIT_CONFIG_COUNT. */
const MAX_INHERITED_GIT_CONFIG_COUNT = 65_536;
/** Matches the three `-c` rerere settings from ownerConflictGitConfig. */
const OWNER_CONFLICT_APPENDED_CONFIG_PAIRS = 3;

function inheritedGitConfigOffset(env: NodeJS.ProcessEnv, added: number): number {
  const raw = env.GIT_CONFIG_COUNT;
  if (raw === undefined || raw === '') return 0;
  if (!/^\d+$/.test(raw)) throw new Error('inherited GIT_CONFIG_COUNT is not a decimal integer');
  const count = Number(raw);
  if (!Number.isSafeInteger(count) || count > MAX_INHERITED_GIT_CONFIG_COUNT || !Number.isSafeInteger(count + added))
    throw new Error('inherited GIT_CONFIG_COUNT overflows the appendable range');
  for (let index = 0; index < count; index++) {
    if (env[`GIT_CONFIG_KEY_${index}`] === undefined) throw new Error(`inherited GIT_CONFIG_KEY_${index} is missing`);
    if (env[`GIT_CONFIG_VALUE_${index}`] === undefined)
      throw new Error(`inherited GIT_CONFIG_VALUE_${index} is missing`);
  }
  return count;
}

/** Git settings for commands started by a resumed worker, scoped to that process tree. */
export function ownerConflictEnvironment(cwd: string, policy = defaultPolicy.merge): Record<string, string> {
  const offset = inheritedGitConfigOffset(process.env, OWNER_CONFLICT_APPENDED_CONFIG_PAIRS);
  const config = ownerConflictGitConfig(cwd, policy);
  const pairs: [string, string][] = [];
  for (let index = 0; index < config.length; index += 2) {
    if (config[index] !== '-c') continue;
    const spec = config[index + 1]!;
    const separator = spec.indexOf('=');
    pairs.push([spec.slice(0, separator), spec.slice(separator + 1)]);
  }
  const environment: Record<string, string> = {
    GIT_CONFIG_COUNT: String(offset + pairs.length),
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
  };
  pairs.forEach(([key, value], index) => {
    environment[`GIT_CONFIG_KEY_${offset + index}`] = key;
    environment[`GIT_CONFIG_VALUE_${offset + index}`] = value;
  });
  return environment;
}

export type OwnerConflictGitResult = { status: number | null; stdout: string; stderr: string; error?: Error };

export function ownerConflictGit(cwd: string, ...args: string[]): OwnerConflictGitResult {
  return policyOwnerConflictGit(cwd, args);
}

export function policyOwnerConflictGit(cwd: string, args: string[], policy = defaultPolicy.merge): OwnerConflictGitResult {
  const result = spawnSync('git', [...ownerConflictGitConfig(cwd, policy), ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: policy.gitBufferBytes,
    timeout: policy.commandTimeoutMs,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error ? { error: result.error } : {}),
  };
}

export function ownerConflictGitOrThrow(cwd: string, ...args: string[]): string {
  const result = ownerConflictGit(cwd, ...args);
  if (result.status !== 0) throw new Error(result.stderr.trim() || result.error?.message || `git ${args[0]} failed`);
  return result.stdout.trim();
}

export function rerereAppliedFiles(output: string): string[] {
  return ownerConflictFiles(
    [...output.matchAll(/(?:Resolved|Staged) '([^']+)' using previous resolution\./g)].map((match) => match[1]!),
  );
}

export function ownerConflictReceipt(
  record: OwnerConflictRecord,
  status: OwnerConflictReceipt['status'],
  fields: Partial<Pick<OwnerConflictReceipt, 'resolution' | 'resolvedCommit' | 'detail'>> = {},
  at = new Date().toISOString(),
): OwnerConflictReceipt {
  return {
    taskId: record.taskId,
    attempt: record.attempt,
    handoffId: record.id,
    status,
    owner: record.owner,
    sessionId: record.sessionId,
    sourceCommit: record.sourceCommit,
    acceptanceCommit: record.acceptanceCommit,
    devHead: record.devHead,
    conflictFiles: [...record.conflictFiles],
    attributedTaskIds: [...record.attributedTaskIds],
    at,
    ...fields,
  };
}
