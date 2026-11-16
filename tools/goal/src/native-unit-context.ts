export const NATIVE_UNIT_CONTEXT_VARIABLE = 'REZICS_NATIVE_UNIT_CONTEXT';
export const NATIVE_UNIT_RUN_VARIABLE = 'REZICS_NATIVE_UNIT_RUN_ID';

/** Desktop commands use the caller's Codex thread, which still requires state and registry verification. */
export function desktopCodexCaller(env: Record<string, string | undefined>): string {
  const threadId = env.CODEX_THREAD_ID;
  if (
    !threadId ||
    (env.CODEX_SESSION_ID && env.CODEX_SESSION_ID !== threadId) ||
    env.CLAUDE_CODE_SESSION_ID ||
    env.GOAL_TASK_ID ||
    env.GOAL_ATTEMPT
  )
    throw new Error('Native desktop units require an unambiguous Codex caller');
  return threadId;
}

/** Original launcher context carried unchanged into an admitted remote check. */
export type NativeUnitContext = {
  version: 1;
  unit: string;
  threadId: string;
  goalId: string;
  worktree: string;
  registry: string;
  /** Requested checkpoint; observation requires a matched immutable check receipt. */
  sourceRevision: string;
  briefHash: string;
  registeredAt: string;
  goalObservedAt: string;
  requires: ('native' | 'browser' | 'root')[];
};

export function nativeUnitContext(env: Record<string, string | undefined>): NativeUnitContext | undefined {
  const text = env[NATIVE_UNIT_CONTEXT_VARIABLE];
  if (text === undefined) return undefined;
  let value: NativeUnitContext;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Invalid native unit check context');
  }
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  if (
    value?.version !== 1 ||
    typeof value.unit !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(value.unit) ||
    !uuid.test(value.threadId) ||
    !uuid.test(value.goalId) ||
    typeof value.worktree !== 'string' ||
    !value.worktree.startsWith('/') ||
    typeof value.registry !== 'string' ||
    !value.registry.startsWith('/') ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.sourceRevision) ||
    !/^[0-9a-f]{64}$/.test(value.briefHash) ||
    !Number.isFinite(Date.parse(value.registeredAt)) ||
    !Number.isFinite(Date.parse(value.goalObservedAt)) ||
    !Array.isArray(value.requires) ||
    value.requires.some((item) => !['native', 'browser', 'root'].includes(item))
  )
    throw new Error('Invalid native unit check context');
  if (env.GOAL_TASK_ID || env.GOAL_ATTEMPT)
    throw new Error('A native unit check cannot also claim a managed task attempt');
  return value;
}
