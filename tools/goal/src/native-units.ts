import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { migrate } from './db.ts';
import { type NativeUnitContext, nativeUnitContext, NATIVE_UNIT_CONTEXT_VARIABLE } from './native-unit-context.ts';

export const nativeUnitMigrations = [
  {
    module: 'native-units',
    version: 1,
    sql: `CREATE TABLE native_execution_units (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL UNIQUE,
    pane TEXT NOT NULL UNIQUE,
    worktree TEXT NOT NULL UNIQUE,
    body TEXT NOT NULL
  );
  CREATE TABLE native_unit_runs (
    id TEXT PRIMARY KEY,
    unit TEXT NOT NULL REFERENCES native_execution_units(id),
    started_at TEXT NOT NULL,
    ended_at TEXT,
    exit_code INTEGER,
    requested_source_commit TEXT,
    source_commit TEXT,
    context TEXT NOT NULL,
    command TEXT NOT NULL
  );
  CREATE INDEX native_unit_runs_unit_started ON native_unit_runs(unit, started_at);
  CREATE TABLE native_unit_run_sources (
    run_id TEXT NOT NULL REFERENCES native_unit_runs(id),
    invocation_id TEXT NOT NULL,
    source_commit TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    host TEXT NOT NULL,
    physical_run TEXT NOT NULL,
    receipt_sha256 TEXT NOT NULL,
    native_exit_code INTEGER NOT NULL,
    PRIMARY KEY(run_id, invocation_id)
  );`,
  },
] as const;

export type NativeUnit = {
  version: 1;
  id: string;
  threadId: string;
  goalId: string;
  pane: string;
  worktree: string;
  briefPath: string;
  briefHash: string;
  codexHome: string;
  pool: string;
  registeredAt: string;
  registry: string;
  acceptance: { command: string[]; requires: NativeUnitContext['requires'] };
};

type NativeGoal = { goal_id: string; objective: string; status: string; updated_at_ms: number };
type NativeThread = { id: string; cwd: string; rollout_path: string; source: string };

export function readNativeGoal(codexHome: string, threadId: string): { goal: NativeGoal; thread: NativeThread } {
  const goals = new Database(join(codexHome, 'goals_1.sqlite'), { readonly: true });
  let threads: Database | undefined;
  try {
    threads = new Database(join(codexHome, 'state_5.sqlite'), { readonly: true });
    const goal = goals
      .query('SELECT goal_id, objective, status, updated_at_ms FROM thread_goals WHERE thread_id=?')
      .get(threadId) as NativeGoal | null;
    const thread = threads
      .query('SELECT id, cwd, rollout_path, source FROM threads WHERE id=?')
      .get(threadId) as NativeThread | null;
    if (!goal || !thread) throw new Error('Native unit needs an existing Codex thread and native Goal');
    return { goal, thread };
  } finally {
    goals.close();
    threads?.close();
  }
}

function gitRoot(path: string): string {
  const result = spawnSync('git', ['-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`Native unit worktree is not a Git checkout: ${path}`);
  return realpathSync(result.stdout.trim());
}

export function verifyNativeUnitPane(status: unknown, pane: string, worktree: string, threadId: string): void {
  const document = status as { protocolVersion?: number; ok?: boolean; data?: { sessions?: any[] } };
  if (document?.protocolVersion !== 1 || document.ok !== true || !Array.isArray(document.data?.sessions))
    throw new Error('Native unit registration needs valid termspaces JSON inventory');
  const matches = document.data.sessions.flatMap((session) =>
    session.owned === true && Array.isArray(session.windows)
      ? session.windows.flatMap((window: any) =>
          window.owned === true && Array.isArray(window.panes)
            ? window.panes.filter((candidate: any) => candidate.runtimeId === pane && candidate.owned === true)
            : [],
        )
      : [],
  );
  if (matches.length !== 1 || matches[0].dead !== false)
    throw new Error(`Native unit pane is not a live termspaces-owned pane: ${pane}`);
  if (typeof matches[0].cwd !== 'string' || realpathSync(matches[0].cwd) !== worktree)
    throw new Error(`Native unit pane must be in its assigned worktree: ${worktree}`);
  const argv = matches[0].spec?.argv;
  if (!Array.isArray(argv) || !/(?:^|\/)codex$/.test(argv[0]) || argv[1] !== 'resume' || argv[2] !== threadId)
    throw new Error('Native unit pane must attach its existing Codex thread');
}

function readUnitAcceptance(briefPath: string): { hash: string; acceptance: NativeUnit['acceptance'] } {
  const source = readFileSync(briefPath, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match) throw new Error('Native unit Goal brief needs acceptance front matter');
  const document = Bun.YAML.parse(match[1]!) as { acceptance?: { command?: unknown; requires?: unknown } } | null;
  const acceptance = document?.acceptance;
  const command = acceptance?.command;
  const requires = acceptance?.requires;
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some((item: unknown) => typeof item !== 'string' || !item)
  )
    throw new Error('Native unit Goal brief needs an explicit acceptance.command argv');
  if (
    !Array.isArray(requires) ||
    requires.some((item: unknown) => !['native', 'browser', 'root'].includes(String(item)))
  )
    throw new Error('Native unit Goal brief needs acceptance.requires native, browser or root');
  return {
    hash: createHash('sha256').update(source).digest('hex'),
    acceptance: { command, requires: [...new Set(requires)] as NativeUnitContext['requires'] },
  };
}

export function registeredNativeUnits(db: Database): NativeUnit[] {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_execution_units'").get()) return [];
  return (db.query('SELECT body FROM native_execution_units ORDER BY id').all() as { body: string }[]).map((row) =>
    JSON.parse(row.body),
  );
}

export function registerNativeUnit(
  db: Database,
  input: {
    id: string;
    threadId: string;
    pane: string;
    worktree: string;
    briefPath: string;
    codexHome: string;
    pool: string;
    mainCheckout: string;
    termspacesStatus: unknown;
    stateDirectory: string;
  },
  now = new Date(),
): NativeUnit {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(input.id)) throw new Error('Invalid native unit name');
  if (!/^%\d+$/.test(input.pane)) throw new Error('Native unit pane must be an actual tmux pane id');
  const worktree = realpathSync(input.worktree);
  if (gitRoot(worktree) !== gitRoot(input.mainCheckout)) throw new Error('Native unit must use this repository');
  verifyNativeUnitPane(input.termspacesStatus, input.pane, worktree, input.threadId);
  const codexHome = realpathSync(input.codexHome);
  const { goal, thread } = readNativeGoal(codexHome, input.threadId);
  if (goal.status !== 'active')
    throw new Error(`Native unit Goal is ${goal.status}; it must be active for registration`);
  if (gitRoot(thread.cwd) !== gitRoot(worktree)) throw new Error('Native unit thread belongs to another repository');
  const briefPath = realpathSync(input.briefPath);
  const brief = readUnitAcceptance(briefPath);
  const previous = registeredNativeUnits(db).find((unit) => unit.id === input.id);
  if (
    previous &&
    (previous.threadId !== input.threadId || previous.pane !== input.pane || previous.worktree !== worktree)
  )
    throw new Error('Native unit identity is already registered; preserve its thread, pane and worktree');
  const unit: NativeUnit = {
    version: 1,
    id: input.id,
    threadId: input.threadId,
    goalId: goal.goal_id,
    pane: input.pane,
    worktree,
    briefPath,
    briefHash: brief.hash,
    codexHome,
    pool: input.pool,
    registeredAt: previous?.registeredAt ?? now.toISOString(),
    acceptance: brief.acceptance,
    registry: join(realpathSync(input.stateDirectory), 'goal.sqlite'),
  };
  migrate(db, nativeUnitMigrations);
  db.query(`INSERT INTO native_execution_units(id, thread_id, pane, worktree, body) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET body=excluded.body`).run(
    unit.id,
    unit.threadId,
    unit.pane,
    unit.worktree,
    JSON.stringify(unit),
  );
  return unit;
}

/** Observe the real Goal again before giving the unit its check-launch context. */
export function nativeUnitEnvironment(
  unit: NativeUnit,
  now = new Date(),
  sourceRevision?: string,
): Record<string, string> {
  const { goal } = readNativeGoal(unit.codexHome, unit.threadId);
  if (goal.goal_id !== unit.goalId || goal.status !== 'active')
    throw new Error('Native unit Goal changed or is no longer active');
  const brief = readUnitAcceptance(unit.briefPath);
  if (brief.hash !== unit.briefHash)
    throw new Error('Native unit Goal brief changed; the root manager must update its registration');
  const head = spawnSync('git', ['-C', unit.worktree, 'rev-parse', '--verify', 'HEAD^{commit}'], { encoding: 'utf8' });
  if (head.status !== 0) throw new Error('Native unit source checkpoint is unavailable');
  const checkpoint = sourceRevision ?? head.stdout.trim();
  if (
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(checkpoint) ||
    spawnSync('git', ['-C', unit.worktree, 'merge-base', '--is-ancestor', checkpoint, head.stdout.trim()]).status !== 0
  )
    throw new Error('Native unit source checkpoint must belong to its current source history');
  const context: NativeUnitContext = {
    version: 1,
    unit: unit.id,
    threadId: unit.threadId,
    goalId: unit.goalId,
    worktree: unit.worktree,
    briefHash: unit.briefHash,
    registeredAt: unit.registeredAt,
    registry: unit.registry,
    sourceRevision: checkpoint,
    goalObservedAt: now.toISOString(),
    requires: unit.acceptance.requires,
  };
  return { [NATIVE_UNIT_CONTEXT_VARIABLE]: JSON.stringify(context) };
}

/** Local launches must match root registration and the actual still-active native Goal. */
export function observeNativeUnitContext(env: Record<string, string | undefined>): NativeUnitContext | undefined {
  const context = nativeUnitContext(env);
  if (!context) return undefined;
  const db = new Database(context.registry, { readonly: true });
  try {
    const unit = registeredNativeUnits(db).find((candidate) => candidate.id === context.unit);
    if (!unit) throw new Error('Native unit check context is not registered');
    const observed = nativeUnitContext(
      nativeUnitEnvironment(unit, new Date(context.goalObservedAt), context.sourceRevision),
    );
    if (JSON.stringify(observed) !== JSON.stringify(context))
      throw new Error('Native unit check context differs from root registration');
    return context;
  } finally {
    db.close();
  }
}
