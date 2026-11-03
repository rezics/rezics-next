import { defaultPolicy, type ControlPolicy } from './policy.ts';
import defaults from '../defaults.json';
import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { watchOrPoll, type Watching } from './watch-or-poll.ts';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { AppServer, CodexPool, Notification } from './app-server.ts';
import { connectPool, textInput } from './app-server.ts';
import { agentEnvironmentKeys } from './agents.ts';
import { migrate } from './db.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { isPendingContinuationHandshake } from './manager-continuation.ts';
import type { ProcessIdentity } from './process.ts';
import type { ManagerWindows } from './windows.ts';

// Managers run with full access, like workers; the maintainer is not there to answer approval requests.
const FULL_ACCESS = { approvalPolicy: 'never', sandbox: 'danger-full-access' } as const;
const CODEX_MANAGER_MODEL = 'gpt-6.1-sol';

function codexThreadConfig(spec: Pick<ManagerSpec, 'effort' | 'compactTokens'>) {
  return {
    model_reasoning_effort: spec.effort,
    model_auto_compact_token_limit: spec.compactTokens ?? defaults.integration.managerCompactTokens,
  };
}

function codexTurnSettings(spec: Pick<ManagerSpec, 'effort'>) {
  return { model: CODEX_MANAGER_MODEL, effort: spec.effort };
}

/** `ThreadGoalSetParams` from installed `codex-cli 0.164.0`; no idle-continuation field is acknowledged. */
function activeGoalSet(threadId: string, spec: Pick<ManagerSpec, 'objective' | 'budget'>) {
  return {
    threadId,
    origin: 'user' as const,
    objective: spec.objective,
    status: 'active' as const,
    tokenBudget: spec.budget,
  };
}

export type ManagerLimits = { turns: number; turnsWithoutDecision: number; wallMs: number };
export type ManagerSpec = {
  id: string;
  goal: string;
  objective: string;
  brief: string;
  cwd: string;
  engine: 'codex' | 'claude';
  pool: CodexPool;
  budget: number;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  supermanager: string;
  compactTokens?: number;
  limits: ManagerLimits;
};
export type GoalState = {
  status: 'active' | 'paused' | 'complete' | 'blocked' | 'usageLimited' | 'budgetLimited';
  tokensUsed: number;
  timeUsedSeconds: number;
  tokenBudget: number | null;
};
export type ManagerSessionSnapshot = ManagerSpec & {
  /** Existing persisted sessions without a kind remain managed sessions. */
  kind?: 'managed';
  threadId: string | null;
  activeTurnId: string | null;
  status: 'starting' | 'running' | 'paused' | 'complete';
  startedAt: number;
  turns: number;
  turnsWithoutDecision: number;
  decision: boolean;
  countedTurn: string | null;
  /** Host clock when the counted turn started; a backlog brief written since then is the turn's decision. */
  turnStartedAt?: number;
  goalState: GoalState | null;
  usage: unknown;
  continuationAsked?: boolean;
  continuationRenewed?: boolean;
  continuationTokensUsed?: number;
  pendingRenewal?: { tokensUsed: number; oldThreadId: string | null; ready: boolean };
};
export type ManagedManagerState = ManagerSessionSnapshot & { history?: ManagerSessionSnapshot[] };
/** An existing Claude session registered for authority only; it is not a managed model session. */
type ResidentManagedFields = Exclude<keyof ManagerSessionSnapshot, 'kind' | 'id' | 'status' | 'threadId'>;
export type ResidentSupermanagerState = Pick<ManagerSessionSnapshot, 'id' | 'status' | 'threadId'> & {
  kind: 'resident-supermanager';
  provider: 'claude';
  status: 'running';
  threadId: string;
  registeredAt: string;
} & { [Key in ResidentManagedFields]?: never } & { history?: never };
export type ManagerState = ManagedManagerState | ResidentSupermanagerState;
export type CompletionEvidence = { passed: boolean; evidencePath: string; summary: string };
export type ManagerServices = {
  policy?: ControlPolicy;
  connect?: (pool: CodexPool, onStart?: (identity: ProcessIdentity) => void) => Promise<AppServer>;
  windows: ManagerWindows;
  checkCompletion(goal: string): Promise<CompletionEvidence>;
  /** The CLI prefix includes its runtime composition module, if any. */
  command: string[];
  /** Root of the per-Goal ready-brief directories the controller dispatches from. */
  backlogDirectory?: string;
  now?: () => number;
  onAppServerStart?(identity: ProcessIdentity): void;
  onError?: (error: unknown) => void;
};

function isResidentSupermanager(state: ManagerState): state is ResidentSupermanagerState {
  return state.kind === 'resident-supermanager';
}

function assertManagedManager(state: ManagerState): asserts state is ManagedManagerState {
  if (isResidentSupermanager(state))
    throw new Error(`Resident supermanager ${state.id} is an external session and has no managed lifecycle`);
}

function isManagedManager(state: ManagerState): state is ManagedManagerState {
  return !isResidentSupermanager(state);
}

const managerDecisionMigration = {
  module: 'manager-decisions',
  version: 1,
  sql: `CREATE TABLE manager_turn_decisions (
    manager TEXT NOT NULL,
    thread_id TEXT,
    turn_id TEXT,
    decided_at INTEGER NOT NULL,
    CHECK(thread_id IS NULL OR length(thread_id) > 0),
    CHECK(turn_id IS NULL OR length(turn_id) > 0)
  );
  CREATE UNIQUE INDEX manager_turn_decision_once
    ON manager_turn_decisions(manager, thread_id, turn_id) WHERE turn_id IS NOT NULL;
  CREATE UNIQUE INDEX manager_pending_decision_once
    ON manager_turn_decisions(manager, thread_id) WHERE turn_id IS NULL AND thread_id IS NOT NULL;
  CREATE UNIQUE INDEX manager_unassigned_decision_once
    ON manager_turn_decisions(manager) WHERE turn_id IS NULL AND thread_id IS NULL;`,
} as const;

/** Persist a manager decision locally so a public CLI command never waits on the manager host. */
export function recordManagerDecision(db: Database, id: string, at = Date.now()): void {
  migrate(db, [managerDecisionMigration]);
  db.transaction(() => {
    const hasSessions = db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'manager_sessions'")
      .get();
    const row = hasSessions
      ? (db.query('SELECT state FROM manager_sessions WHERE id = ?').get(id) as { state: string } | null)
      : null;
    if (!row) throw new Error(`Unknown manager: ${id}`);
    const state = row ? (JSON.parse(row.state) as ManagerState) : null;
    if (state && isResidentSupermanager(state)) return;
    const threadId = state?.threadId ?? null;
    const activeTurnId = state && isManagedManager(state) ? state.activeTurnId : null;
    db.query(
      'INSERT OR IGNORE INTO manager_turn_decisions(manager, thread_id, turn_id, decided_at) VALUES (?, ?, ?, ?)',
    ).run(id, threadId, threadId ? (activeTurnId ?? null) : null, at);
  }).immediate();
}

/** More `clock.sleep` calls than this in one UTC hour raise one alarm for that manager. */
export const MANAGER_SLEEP_ALARM_PER_HOUR = defaultPolicy.manager.sleepAlarmPerHour;
const HOUR_MS = 3_600_000; // Unit conversion; sleep alarms are bucketed by UTC hour.
const managerSleepMigration = {
  module: 'manager-sleep',
  version: 1,
  sql: `CREATE TABLE manager_sleep_calls (
    manager TEXT NOT NULL,
    hour INTEGER NOT NULL,
    calls INTEGER NOT NULL,
    alarmed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(manager, hour)
  );`,
} as const;

function managerHasDecision(db: Database, id: string, threadId: string, turnId: string): boolean {
  return Boolean(
    db
      .query('SELECT 1 FROM manager_turn_decisions WHERE manager = ? AND thread_id = ? AND turn_id = ?')
      .get(id, threadId, turnId),
  );
}

export class ManagerSessions {
  private pools = new Map<string, Promise<AppServer>>();
  private chains = new Map<string, Promise<unknown>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private watcher: Watching;
  private closed = false;
  private readonly policy: ControlPolicy;
  private unsubscribers: (() => void)[] = [];
  constructor(
    private readonly db: Database,
    readonly inbox: SqliteManagerInbox,
    private readonly services: ManagerServices,
  ) {
    this.policy = services.policy ?? defaultPolicy;
    migrate(db, [
      {
        module: 'managers',
        version: 1,
        sql: 'CREATE TABLE manager_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL);',
      },
    ]);
    migrate(db, [managerDecisionMigration, managerSleepMigration]);
    this.watcher = watchOrPoll(
      inbox.signalDirectory,
      () => {
        for (const state of this.list())
          if (isManagedManager(state) && state.status === 'running')
            this.background(state.id, () => this.dispatch(state.id));
      },
      this.policy.manager.inboxPollMs,
    );
  }
  private now(): number {
    return (this.services.now ?? Date.now)();
  }
  private error(error: unknown): void {
    (this.services.onError ?? console.error)(error);
  }
  get(id: string): ManagerState {
    const row = this.db.query('SELECT state FROM manager_sessions WHERE id = ?').get(id) as { state: string } | null;
    if (!row) throw new Error(`Unknown manager: ${id}`);
    const state = JSON.parse(row.state) as ManagerState;
    if (
      isManagedManager(state) &&
      state.threadId &&
      state.activeTurnId &&
      managerHasDecision(this.db, id, state.threadId, state.activeTurnId)
    )
      state.decision = true;
    return state;
  }
  list(): ManagerState[] {
    return (this.db.query('SELECT state FROM manager_sessions').all() as { state: string }[]).map((row) => {
      const state = JSON.parse(row.state) as ManagerState;
      if (
        isManagedManager(state) &&
        state.threadId &&
        state.activeTurnId &&
        managerHasDecision(this.db, state.id, state.threadId, state.activeTurnId)
      )
        state.decision = true;
      return state;
    });
  }
  private save(state: ManagerState): void {
    if (
      isManagedManager(state) &&
      state.threadId &&
      state.activeTurnId &&
      managerHasDecision(this.db, state.id, state.threadId, state.activeTurnId)
    )
      state.decision = true;
    this.db
      .query(
        'INSERT INTO manager_sessions(id, state) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state',
      )
      .run(state.id, JSON.stringify(state));
  }
  /** Persist the already-running configured Claude supermanager without creating a managed session. */
  registerResidentSupermanager(id: string, sessionId: string): Promise<ResidentSupermanagerState> {
    return this.serial(id, async () => {
      if (!id || id.trim() !== id) throw new Error('Configured supermanager identity is missing or malformed');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId))
        throw new Error('Resident Claude session ID is malformed');
      let registered!: ResidentSupermanagerState;
      this.db
        .transaction(() => {
          const rows = this.db.query('SELECT id, state FROM manager_sessions').all() as {
            id: string;
            state: string;
          }[];
          const parsed = rows.map((row) => {
            try {
              return {
                row,
                state: JSON.parse(row.state) as {
                  id?: unknown;
                  kind?: unknown;
                  provider?: unknown;
                  status?: unknown;
                  threadId?: unknown;
                  sessionId?: unknown;
                },
              };
            } catch {
              return { row, state: undefined };
            }
          });
          const assignedElsewhere = parsed.find(
            ({ row, state }) => row.id !== id && (state?.threadId === sessionId || state?.sessionId === sessionId),
          );
          if (assignedElsewhere)
            throw new Error(`Provider session is already assigned to manager ${assignedElsewhere.row.id}`);

          const current = parsed.find(({ row }) => row.id === id);
          if (current) {
            const state = current.state as Partial<ResidentSupermanagerState> | undefined;
            if (
              state?.kind === 'resident-supermanager' &&
              state.id === id &&
              state.provider === 'claude' &&
              state.status === 'running' &&
              state.threadId === sessionId
            ) {
              registered = state as ResidentSupermanagerState;
              return;
            }
            if (state?.kind === 'resident-supermanager' && state.status === 'running')
              throw new Error(
                `Resident supermanager ${id} is already registered to another session; explicit session replacement is unsupported`,
              );
            throw new Error(
              `Manager ${id} already has a persisted session; refusing to replace it with a resident session`,
            );
          }

          registered = {
            kind: 'resident-supermanager',
            id,
            provider: 'claude',
            threadId: sessionId,
            status: 'running',
            registeredAt: new Date(this.now()).toISOString(),
          };
          this.save(registered);
        })
        .immediate();
      return registered;
    });
  }
  private serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
    this.chains.set(id, next);
    return next;
  }
  private background(id: string, action: () => Promise<unknown>): void {
    void this.serial(id, action).catch((error) => this.error(error));
  }
  async flush(): Promise<void> {
    for (;;) {
      const snapshot = [...this.chains.values()];
      await Promise.all(snapshot);
      if (
        snapshot.length === this.chains.size &&
        [...this.chains.values()].every((chain, index) => chain === snapshot[index])
      )
        return;
    }
  }
  private client(pool: CodexPool): Promise<AppServer> {
    const key = pool.codexHome;
    const existing = this.pools.get(key);
    if (existing) return existing;
    const tracked = new Set<string>();
    const onStart = (identity: ProcessIdentity) => {
      const key = `${identity.pid}:${identity.start}:${identity.boot}`;
      if (tracked.has(key)) return;
      tracked.add(key);
      this.services.onAppServerStart?.(identity);
    };
    const connecting = this.services.connect
      ? this.services.connect(pool, onStart)
      : connectPool(pool, onStart, undefined, this.policy.appServer);
    const client = connecting.then(async (server) => {
      try {
        if (server.identity) onStart(server.identity);
      } catch (error) {
        await server.close();
        throw error;
      }
      this.unsubscribers.push(server.onNotification((notification) => this.notification(notification)));
      return server;
    });
    this.pools.set(key, client);
    void client.catch(() => this.pools.delete(key));
    return client;
  }
  private notification(notification: Notification): void {
    if (this.closed) return;
    const state = this.list().find(
      (state) => isManagedManager(state) && state.threadId === notification.params?.threadId,
    );
    if (state) this.background(state.id, () => this.handleNotification(state.id, notification));
  }
  private async handleNotification(id: string, { method, params }: Notification): Promise<void> {
    const state = this.get(id);
    assertManagedManager(state);
    // Notifications from a retired Codex thread can already be queued when renewal swaps sessions.
    if (state.threadId && params?.threadId && state.threadId !== params.threadId) return;
    if (method === 'turn/started') {
      this.turnStarted(state, params.turn.id);
      if (state.status !== 'running') await this.pauseRemote(state);
    } else if (method === 'turn/completed') {
      this.turnEnded(state, params.turn.id);
    } else if (method === 'thread/goal/updated') {
      state.goalState = params.goal;
    } else if (method === 'thread/goal/cleared') {
      state.goalState = null;
    } else if (method === 'thread/tokenUsage/updated') state.usage = params.tokenUsage;
    else if (method === 'item/started' && params?.item?.type === 'sleep') {
      this.countSleep(state);
      return;
    } else return;
    this.save(state);
    if (state.status === 'running') {
      if (method === 'thread/goal/updated' && (await this.handleGoalUpdate(state))) return;
      if (await this.checkLimits(state)) return;
      if (state.goalState?.status === 'complete') await this.completeInternal(state.id);
    }
  }
  /** Event-driven managers sleep only by ending the turn: a `clock.sleep` loop re-reads the whole context each call. */
  private countSleep(state: ManagedManagerState): void {
    const now = this.now();
    const hour = Math.floor(now / HOUR_MS);
    this.db
      .transaction(() => {
        this.db
          .query('DELETE FROM manager_sleep_calls WHERE manager = ? AND hour < ?')
          .run(state.id, hour - this.policy.manager.sleepHistoryHours);
        const row = this.db
          .query(
            `INSERT INTO manager_sleep_calls(manager, hour, calls) VALUES (?, ?, 1)
            ON CONFLICT(manager, hour) DO UPDATE SET calls = calls + 1
            RETURNING calls, alarmed`,
          )
          .get(state.id, hour) as { calls: number; alarmed: number };
        if (row.calls <= this.policy.manager.sleepAlarmPerHour || row.alarmed) return;
        this.db.query('UPDATE manager_sleep_calls SET alarmed = 1 WHERE manager = ? AND hour = ?').run(state.id, hour);
        this.inbox.deliver({
          managerId: state.supermanager,
          kind: 'environment',
          goalId: state.goal,
          summary: `Manager ${state.id} called clock.sleep ${row.calls} times in the UTC hour from ${new Date(hour * HOUR_MS).toISOString()}; managers end the turn and are resumed by inbox events.`,
        });
        this.inbox.deliver({
          managerId: state.id,
          kind: 'instruction',
          summary:
            'Do not call clock.sleep: when no decision is pending, end the turn; the next inbox event starts a new one.',
        });
      })
      .immediate();
  }
  private continuationPath(spec: ManagerSpec): string {
    return join(spec.cwd, '.temp', 'goal', spec.id, 'CONTINUATION.md');
  }
  private backlogPath(spec: ManagerSpec): string {
    return join(this.services.backlogDirectory ?? join(spec.cwd, '.temp', 'goal', 'backlog'), spec.goal);
  }
  /** Whether a ready brief in the Goal's backlog was written or moved there since `since`, or dispatched from it. */
  private backlogWrittenSince(spec: ManagerSpec, turnStart: number): boolean {
    // File times come from the kernel's coarse clock, which can trail the process clock by a few milliseconds.
    const since = turnStart - this.policy.manager.fileClockSlackMs;
    const directory = this.backlogPath(spec);
    for (const path of [directory, join(directory, '.dispatching')]) {
      let names: string[];
      try {
        names = readdirSync(path, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
          .map((entry) => entry.name);
      } catch {
        continue;
      }
      for (const name of names) {
        try {
          // A rename back from failed/ keeps the modification time but changes the status time.
          const stat = statSync(join(path, name));
          if (Math.max(stat.mtimeMs, stat.ctimeMs) >= since) return true;
        } catch {
          // Dispatched or moved away meanwhile.
        }
      }
    }
    // The backlog run may already have dispatched a brief written in this turn; it records the brief's write time.
    if (!this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'backlog_goals'").get())
      return false;
    const row = this.db.query('SELECT last_written_at FROM backlog_goals WHERE goal = ?').get(spec.goal) as {
      last_written_at: number | null;
    } | null;
    return (row?.last_written_at ?? -1) >= since;
  }
  private opening(spec: ManagerSpec, continuationFile?: string): string {
    const command = this.services.command.join(' ');
    return (
      `${spec.brief}\n\nYou manage Goal ${spec.goal}; export GOAL_MANAGER=${spec.id} for control-plane commands. ` +
      "Synthesize your workers' reports (results, decisions, conflicts, duplicated or missing work across tasks) into decisions and the next briefs. " +
      `Your outputs are decisions and ready briefs in ${this.backlogPath(spec)}; keep at least ${this.policy.backlog.lowWater} there. ` +
      `Act on each stopped task within ${this.policy.backlog.stoppedTaskLimitMs === HOUR_MS ? 'an hour' : `${this.policy.backlog.stoppedTaskLimitMs} ms`}: retry it with a rewritten brief, split it or cancel it; leave mechanical gates, retries and merges to the controller. ` +
      `Completion is a proposal the control plane verifies: ${command} manager complete ${spec.id}. ` +
      `Send only decisions, blocking questions and handoffs, at most ${this.policy.manager.messageWords} words each. Do not write receipts, status snapshots or lists of actions not taken. ` +
      `Read your brief and ${continuationFile ? `the continuation ${continuationFile}` : 'continuation'} once per session; keep .temp/goal/${spec.id}/CONTINUATION.md under ${this.policy.manager.continuationCharacters.toLocaleString('en-US')} characters, replaced, not appended. ` +
      'Read and acknowledge inbox events. ' +
      (spec.engine === 'codex'
        ? 'When no decision is pending, end the turn; do not use clock.sleep or poll: the controller resumes this thread when an inbox event arrives.'
        : `When no decision is pending, run ${command} inbox wait ${spec.id} in the background and end the turn.`)
    );
  }
  private claudeArgv(spec: ManagerSpec, session: string[], prompt: string): string[] {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const hook = (command: string) => [...this.services.command, 'manager', command, spec.id].map(quote).join(' ');
    const settings = {
      skipDangerousModePermissionPrompt: true,
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: hook('turn-start') }] }],
        Stop: [{ hooks: [{ type: 'command', command: hook('turn-end') }] }],
      },
    };
    // Claude keeps its account state in ~/.claude.json, not in its default configuration directory; pointing
    // CLAUDE_CONFIG_DIR at that directory would start an unauthenticated, untrusted session.
    const configDirectory =
      resolve(spec.pool.codexHome) === join(homedir(), '.claude') ? [] : [`CLAUDE_CONFIG_DIR=${spec.pool.codexHome}`];
    return [
      'env',
      ...this.providerBoundaryUnsets(),
      `GOAL_MANAGER=${spec.id}`,
      ...configDirectory,
      spec.pool.executable ?? 'claude',
      ...session,
      '--model',
      'claude-opus-5-5',
      '--permission-mode',
      'bypassPermissions',
      '--name',
      `${spec.goal} manager`,
      '--autocompact',
      String(spec.compactTokens ?? defaults.integration.managerCompactTokens),
      '--settings',
      JSON.stringify(settings),
      prompt,
    ];
  }
  private providerBoundaryUnsets(): string[] {
    const keys = new Set([
      ...agentEnvironmentKeys(process.env),
      'GOAL_MANAGER',
      'GOAL_TASK_ID',
      'GOAL_ATTEMPT',
      'GOAL_CHECK_WAIT_FILE',
    ]);
    return [...keys].flatMap((key) => ['-u', key]);
  }
  // The opening goes to a file, not argv: the CLI process would otherwise match a `pgrep -f` for any command the
  // opening names, and a manager that stopped its inbox watcher by pattern once killed its own session that way.
  private openingPointer(spec: ManagerSpec): string {
    const path = join(this.inbox.stateDirectory, 'managers', `${spec.id}.opening.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, this.opening(spec));
    return `Read ${path} completely and follow it.`;
  }
  // A Claude manager hears its inbox through its own background watcher, so a session that exited never sees new
  // events; the next event resumes it in its window.
  private reviveClaude(state: ManagedManagerState): void {
    if (!state.threadId || !this.inbox.pending(state.id).length) return;
    const alive = this.services.windows.alive?.(state.id);
    if (alive === false) {
      this.services.windows.respawn?.(
        state.id,
        this.claudeArgv(
          state,
          ['--resume', state.threadId],
          'The control plane resumed your exited session. Read and acknowledge your inbox, then continue.',
        ),
        state.cwd,
      );
      return;
    }
    // A live session that ended its turn without a watcher never wakes on its own (web sat 2 h on 13 unread events on
    // 2026-10-26): type the wake into it, once per event.
    const waking = this.inbox.notifications(state.id);
    if (!waking.length || !this.services.windows.prompt) return;
    this.services.windows.prompt(
      state.id,
      `${waking.length} new inbox event(s): read them with bun tools/goal/src/cli.ts inbox read ${state.id}, act and acknowledge; start bun tools/goal/src/cli.ts inbox wait ${state.id} in the background before you end the turn.`,
    );
    for (const event of waking) this.inbox.notified(event.id);
  }
  private registerCodexViewer(state: ManagedManagerState, client: AppServer): void {
    const viewer = [state.pool.executable ?? 'codex', 'resume', state.threadId!];
    if (client.endpoint) viewer.push('--remote', client.endpoint);
    this.services.windows.register(
      state.id,
      [
        'env',
        ...this.providerBoundaryUnsets(),
        `CODEX_HOME=${state.pool.codexHome}`,
        `GOAL_MANAGER=${state.id}`,
        ...viewer,
      ],
      state.cwd,
    );
  }
  private validateSpec(spec: ManagerSpec): void {
    if (
      !Number.isSafeInteger(spec.budget) ||
      spec.budget <= 0 ||
      Object.values(spec.limits).some((n) => !Number.isFinite(n) || n <= 0)
    )
      throw new Error('Manager budget and limits must be positive');
  }
  private async startSession(
    spec: ManagerSpec,
    history?: ManagerSessionSnapshot[],
    pendingRenewal?: ManagerSessionSnapshot['pendingRenewal'],
  ): Promise<ManagedManagerState> {
    const state: ManagedManagerState = {
      kind: 'managed',
      ...spec,
      threadId: null,
      activeTurnId: null,
      status: 'starting',
      startedAt: this.now(),
      turns: 0,
      turnsWithoutDecision: 0,
      decision: false,
      countedTurn: null,
      goalState: null,
      usage: null,
      continuationAsked: false,
      continuationRenewed: false,
      ...(pendingRenewal ? { pendingRenewal } : {}),
      ...(history?.length ? { history } : {}),
    };
    this.db
      .transaction(() => {
        const row = this.db.query('SELECT state FROM manager_sessions WHERE id = ?').get(spec.id) as {
          state: string;
        } | null;
        if (row) {
          let current: { kind?: unknown } | undefined;
          try {
            current = JSON.parse(row.state) as { kind?: unknown };
          } catch {
            current = undefined;
          }
          if (current?.kind === 'resident-supermanager')
            throw new Error(`Resident supermanager ${spec.id} is an external session and cannot be started`);
        }
        this.save(state);
      })
      .immediate();
    try {
      if (spec.engine === 'codex') {
        const client = await this.client(spec.pool);
        const started = await client.request('thread/start', {
          ...FULL_ACCESS,
          cwd: spec.cwd,
          model: CODEX_MANAGER_MODEL,
          config: codexThreadConfig(spec),
        });
        const threadId = started.thread.id as string;
        state.threadId = threadId;
        this.save(state);
        const goal = await client.request('thread/goal/set', activeGoalSet(threadId, spec));
        state.goalState = goal.goal;
        state.status = 'running';
        this.save(state);
        this.registerCodexViewer(state, client);
        const continuationFile = history?.length ? this.continuationPath(spec) : undefined;
        const opening =
          continuationFile && existsSync(continuationFile) ? this.opening(spec, continuationFile) : this.opening(spec);
        const turn = await client.request('turn/start', {
          threadId: state.threadId,
          ...codexTurnSettings(spec),
          input: textInput(opening),
        });
        this.turnStarted(state, turn.turn.id);
        if (state.pendingRenewal) {
          state.pendingRenewal.ready = true;
          this.save(state);
          await this.deliverRenewalNotice(state.id);
          if (state.pendingRenewal?.ready) delete state.pendingRenewal;
        }
      } else {
        state.threadId = randomUUID();
        this.services.windows.register(
          spec.id,
          this.claudeArgv(spec, ['--session-id', state.threadId], this.openingPointer(spec)),
          spec.cwd,
        );
        state.status = 'running';
      }
      this.save(state);
      this.armDeadline(state);
      await this.dispatch(spec.id);
      const current = this.get(spec.id);
      assertManagedManager(current);
      return current;
    } catch (error) {
      state.status = 'paused';
      this.save(state);
      try {
        await this.pauseRemote(state);
      } catch (stopError) {
        this.error(stopError);
      }
      throw error;
    }
  }
  async start(spec: ManagerSpec): Promise<ManagerState> {
    return this.serial(spec.id, async () => {
      this.validateSpec(spec);
      // A start that failed before its session existed leaves a paused record without a thread; it may start again.
      const existing = this.list().find((state) => state.id === spec.id);
      if (existing && isResidentSupermanager(existing)) throw new Error(`Manager already exists: ${spec.id}`);
      if (existing && !(existing.status === 'paused' && !existing.threadId))
        throw new Error(`Manager already exists: ${spec.id}`);
      return this.startSession(spec, existing && isManagedManager(existing) ? existing.history : undefined);
    });
  }
  async renew(id: string, spec: ManagerSpec): Promise<ManagerState> {
    return this.serial(id, async () => {
      if (spec.id !== id) throw new Error(`Manager renewal id does not match: ${id}`);
      this.validateSpec(spec);
      const current = this.get(id);
      assertManagedManager(current);
      const goalCanRenew =
        current.engine === 'codex' &&
        (current.goalState?.status === 'budgetLimited' || current.goalState?.status === 'blocked');
      if (current.status !== 'paused' && !goalCanRenew) throw new Error(`Manager must be paused to renew: ${id}`);
      return this.renewInternal(id, spec);
    });
  }
  private async renewInternal(id: string, spec: ManagerSpec): Promise<ManagedManagerState> {
    // Reapply the stop operation because a paused record can still have a live turn or viewer left behind.
    await this.stopInternal(id);
    const stopped = this.get(id);
    assertManagedManager(stopped);
    const { history: _history, ...snapshot } = stopped;
    const history = [...(stopped.history ?? []), snapshot];
    return this.startSession(spec, history, stopped.pendingRenewal);
  }

  private specFromState(state: ManagedManagerState): ManagerSpec {
    const {
      threadId: _threadId,
      activeTurnId: _activeTurnId,
      status: _status,
      startedAt: _startedAt,
      turns: _turns,
      turnsWithoutDecision: _turnsWithoutDecision,
      decision: _decision,
      countedTurn: _countedTurn,
      turnStartedAt: _turnStartedAt,
      goalState: _goalState,
      usage: _usage,
      history: _history,
      continuationAsked: _continuationAsked,
      continuationRenewed: _continuationRenewed,
      continuationTokensUsed: _continuationTokensUsed,
      pendingRenewal: _pendingRenewal,
      ...spec
    } = state;
    return spec;
  }
  private async askForContinuation(state: ManagedManagerState): Promise<void> {
    if (
      state.engine !== 'codex' ||
      state.continuationAsked ||
      !state.goalState ||
      state.goalState.tokenBudget === null ||
      state.goalState.tokenBudget <= 0 ||
      state.goalState.tokensUsed < state.goalState.tokenBudget * (this.policy.manager.continuationBudgetPercent / 100)
    )
      return;
    this.db
      .transaction(() => {
        const current = this.get(state.id);
        assertManagedManager(current);
        if (
          current.continuationAsked ||
          !current.goalState ||
          current.goalState.tokenBudget === null ||
          current.goalState.tokenBudget <= 0 ||
          current.goalState.tokensUsed <
            current.goalState.tokenBudget * (this.policy.manager.continuationBudgetPercent / 100)
        )
          return;
        current.continuationAsked = true;
        this.save(current);
        this.inbox.deliver({
          managerId: current.id,
          kind: 'instruction',
          summary: `This Goal has used at least ${this.policy.manager.continuationBudgetPercent}% of its token budget. Replace .temp/goal/${current.id}/CONTINUATION.md with at most ${this.policy.manager.continuationCharacters.toLocaleString('en-US')} characters: live task IDs, decisions in force as links to owner documents, and next actions. Do not append to the old file. Then send ${current.supermanager} a message containing “continuation written”.`,
        });
      })
      .immediate();
  }
  private async handleGoalUpdate(state: ManagedManagerState): Promise<boolean> {
    if (state.engine !== 'codex') return false;
    await this.askForContinuation(state);
    const current = this.get(state.id);
    assertManagedManager(current);
    if (current.status !== 'running' || current.goalState?.status !== 'budgetLimited') return false;
    await this.renewForContinuation(current.id, current.goalState.tokensUsed);
    return true;
  }
  private async deliverRenewalNotice(id: string): Promise<void> {
    this.db
      .transaction(() => {
        const state = this.get(id);
        assertManagedManager(state);
        const pending = state.pendingRenewal;
        if (!pending || !pending.ready || !state.threadId || state.threadId === pending.oldThreadId) return;
        delete state.pendingRenewal;
        this.save(state);
        this.inbox.deliver({
          managerId: state.supermanager,
          kind: 'environment',
          summary: `Manager ${state.id} renewed after using ${pending.tokensUsed} tokens; new thread ${state.threadId}.`,
        });
      })
      .immediate();
  }
  private async renewForContinuation(id: string, tokensUsed: number): Promise<ManagerState> {
    const state = this.get(id);
    assertManagedManager(state);
    if (state.pendingRenewal) {
      if (state.threadId && state.threadId !== state.pendingRenewal.oldThreadId && state.pendingRenewal.ready) {
        await this.deliverRenewalNotice(id);
        return this.get(id);
      }
      return this.renewInternal(id, this.specFromState(state));
    }
    if (state.continuationRenewed) return state;
    state.continuationRenewed = true;
    state.continuationTokensUsed = tokensUsed;
    state.pendingRenewal = { tokensUsed, oldThreadId: state.threadId, ready: false };
    this.save(state);
    return this.renewInternal(id, this.specFromState(state));
  }
  /** Called for a manager's outgoing inbox message to its configured supermanager. */
  async outgoingMessage(id: string, recipient: string, summary: string): Promise<void> {
    return this.serial(id, async () => {
      const state = this.get(id);
      if (!isPendingContinuationHandshake(summary, recipient, state)) return;
      await this.renewForContinuation(id, state.goalState?.tokensUsed ?? 0);
    });
  }
  private turnStarted(state: ManagedManagerState, turn: string): void {
    if (state.countedTurn !== turn) {
      state.turns++;
      state.decision = false;
      state.countedTurn = turn;
      state.turnStartedAt = this.now();
    }
    state.activeTurnId = turn;
    this.db
      .transaction(() => {
        this.db
          .query(`INSERT OR IGNORE INTO manager_turn_decisions(manager, thread_id, turn_id, decided_at)
        SELECT manager, COALESCE(thread_id, ?), ?, decided_at FROM manager_turn_decisions
        WHERE manager = ? AND turn_id IS NULL AND (thread_id = ? OR thread_id IS NULL)`)
          .run(state.threadId, turn, state.id, state.threadId);
        this.db
          .query(`DELETE FROM manager_turn_decisions WHERE manager = ? AND turn_id IS NULL
        AND (thread_id = ? OR thread_id IS NULL)`)
          .run(state.id, state.threadId);
        this.save(state);
      })
      .immediate();
  }
  private turnEnded(state: ManagedManagerState, turn: string): void {
    this.db
      .transaction(() => {
        if (state.activeTurnId !== turn) return;
        if (state.threadId && managerHasDecision(this.db, state.id, state.threadId, turn)) state.decision = true;
        // Ready briefs are a manager's main output; writing one is a decision even without a control-plane command.
        if (
          !state.decision &&
          state.turnStartedAt !== undefined &&
          this.backlogWrittenSince(state, state.turnStartedAt)
        )
          state.decision = true;
        if (!state.decision) state.turnsWithoutDecision++;
        state.activeTurnId = null;
        this.save(state);
      })
      .immediate();
  }
  async noteCommand(id: string): Promise<void> {
    this.get(id);
    recordManagerDecision(this.db, id, this.now());
  }
  async claudeTurn(id: string, start: boolean): Promise<void> {
    return this.serial(id, async () => {
      const state = this.get(id);
      assertManagedManager(state);
      if (state.engine !== 'claude') throw new Error('Turn hooks are only for Claude managers');
      if (start) this.turnStarted(state, randomUUID());
      else if (state.activeTurnId) this.turnEnded(state, state.activeTurnId);
      else {
        // Background-command completion can start a Claude turn without UserPromptSubmit.
        const turn = randomUUID();
        this.turnStarted(state, turn);
        this.turnEnded(state, turn);
      }
      this.save(state);
      await this.checkLimits(state);
    });
  }
  private armDeadline(state: ManagedManagerState): void {
    clearTimeout(this.timers.get(state.id));
    if (this.closed) return;
    const remaining = state.startedAt + state.limits.wallMs - this.now();
    this.timers.set(
      state.id,
      setTimeout(
        () =>
          this.background(state.id, async () => {
            const current = this.get(state.id);
            assertManagedManager(current);
            await this.checkLimits(current);
          }),
        Math.max(0, Math.min(remaining + 1, 2_147_483_647)),
      ),
    );
  }
  private async checkLimits(state: ManagedManagerState): Promise<boolean> {
    if (state.status !== 'running') return false;
    const reason =
      state.turns > state.limits.turns
        ? 'turn limit'
        : state.turnsWithoutDecision > state.limits.turnsWithoutDecision
          ? 'turns without a decision limit'
          : this.now() - state.startedAt > state.limits.wallMs
            ? 'wall-clock limit'
            : null;
    if (!reason) {
      this.armDeadline(state);
      return false;
    }
    // Turn and wall-clock limits bound one session's context, so the host replaces the session and the brief carries
    // the work over. A manager that keeps turning without a decision stops for the supermanager to look at.
    if (reason !== 'turns without a decision limit') {
      const {
        threadId: _thread,
        activeTurnId: _turn,
        status: _status,
        startedAt: _started,
        turns: _turns,
        turnsWithoutDecision: _empty,
        decision: _decision,
        countedTurn: _counted,
        turnStartedAt: _turnStarted,
        goalState: _goal,
        usage: _usage,
        history: _history,
        ...spec
      } = state;
      try {
        await this.renewInternal(state.id, spec);
        return true;
      } catch (error) {
        this.error(error);
      }
    }
    try {
      await this.stopInternal(state.id);
    } catch (error) {
      this.error(error);
    }
    this.inbox.deliver({
      managerId: state.supermanager,
      kind: 'round-limit',
      summary: `Manager ${state.id} paused after exceeding its ${reason}.`,
    });
    return true;
  }
  private async pauseRemote(state: ManagerState): Promise<void> {
    assertManagedManager(state);
    if (state.engine === 'codex' && state.threadId) {
      const client = await this.client(state.pool);
      const goal = await client.request('thread/goal/set', {
        threadId: state.threadId,
        status: 'paused',
        origin: 'user',
      });
      state.goalState = goal.goal;
      this.save(state);
      if (state.activeTurnId) {
        try {
          await client.request('turn/interrupt', { threadId: state.threadId, turnId: state.activeTurnId });
        } catch {
          const resumed = await client.request('thread/resume', {
            ...FULL_ACCESS,
            threadId: state.threadId,
            model: CODEX_MANAGER_MODEL,
            config: codexThreadConfig(state),
          });
          const active = resumed.thread.turns?.findLast((turn: any) => turn.status === 'inProgress');
          if (active) await client.request('turn/interrupt', { threadId: state.threadId, turnId: active.id });
        }
      }
    }
  }
  private async stopInternal(id: string): Promise<void> {
    const state = this.get(id);
    assertManagedManager(state);
    state.status = 'paused';
    this.save(state);
    clearTimeout(this.timers.get(id));
    try {
      await this.pauseRemote(state);
    } finally {
      this.services.windows.unregister(id);
    }
  }
  stop(id: string): Promise<void> {
    return this.serial(id, () => this.stopInternal(id));
  }

  private async dispatch(id: string): Promise<void> {
    let state = this.get(id);
    if (isResidentSupermanager(state)) return;
    if (state.status !== 'running') return;
    if (state.engine === 'claude') return this.reviveClaude(state);
    const client = await this.client(state.pool);
    for (const event of this.inbox.notifications(id)) {
      state = this.get(id);
      assertManagedManager(state);
      if (state.activeTurnId) {
        // turn/steer has no model or effort fields, so active turns inherit the settings pinned at turn/start.
        try {
          await client.request('turn/steer', {
            threadId: state.threadId,
            expectedTurnId: state.activeTurnId,
            input: textInput(event.event.summary),
          });
        } catch {
          // A completion can race the steer precondition. Rejoin to learn the live turn, then start/steer.
          const resumed = await client.request('thread/resume', {
            ...FULL_ACCESS,
            threadId: state.threadId,
            model: CODEX_MANAGER_MODEL,
            config: codexThreadConfig(state),
          });
          const active = resumed.thread.turns?.findLast((turn: any) => turn.status === 'inProgress');
          state.activeTurnId = active?.id ?? null;
          this.save(state);
          if (active)
            await client.request('turn/steer', {
              threadId: state.threadId,
              expectedTurnId: active.id,
              input: textInput(event.event.summary),
            });
          else await this.startWakeTurn(client, state, event.event.summary);
        }
      } else await this.startWakeTurn(client, state, event.event.summary);
      this.inbox.notified(event.id);
    }
  }
  /** An idle manager has ended its turn; the delivered event starts a new turn on its persisted thread. */
  private async startWakeTurn(client: AppServer, state: ManagedManagerState, summary: string): Promise<void> {
    const start = () =>
      client.request('turn/start', {
        threadId: state.threadId,
        ...codexTurnSettings(state),
        input: textInput(summary),
      });
    let turn;
    try {
      turn = await start();
    } catch {
      // A replaced app-server has not loaded the thread, or a turn began meanwhile: rejoin it, then start or steer.
      const resumed = await client.request('thread/resume', {
        ...FULL_ACCESS,
        threadId: state.threadId,
        model: CODEX_MANAGER_MODEL,
        config: codexThreadConfig(state),
      });
      const active = resumed.thread.turns?.findLast((item: any) => item.status === 'inProgress');
      if (active) {
        state.activeTurnId = active.id;
        this.save(state);
        await client.request('turn/steer', {
          threadId: state.threadId,
          expectedTurnId: active.id,
          input: textInput(summary),
        });
        return;
      }
      turn = await start();
    }
    this.turnStarted(state, turn.turn.id);
    this.save(state);
  }
  async wake(id: string): Promise<void> {
    return this.serial(id, () => this.dispatch(id));
  }

  private async completeInternal(id: string): Promise<boolean> {
    const state = this.get(id);
    assertManagedManager(state);
    const evidence = await this.services.checkCompletion(state.goal);
    this.inbox.record(id, { kind: 'completion-check', ...evidence });
    if (!evidence.passed) {
      // A model-completed Codex goal must become active before the unmet event starts a new turn.
      if (state.engine === 'codex' && state.threadId && state.goalState?.status === 'complete') {
        const client = await this.client(state.pool);
        const updated = await client.request('thread/goal/set', {
          threadId: state.threadId,
          status: 'active',
          origin: 'user',
        });
        state.goalState = updated.goal;
        this.save(state);
      }
      this.inbox.deliver({
        managerId: id,
        kind: 'goal-unmet',
        summary: evidence.summary.replace(/[\r\n]+/g, ' '),
        evidencePath: evidence.evidencePath,
      });
      if (state.supermanager !== id)
        this.inbox.deliver({
          managerId: state.supermanager,
          kind: 'goal-unmet',
          summary: evidence.summary.replace(/[\r\n]+/g, ' '),
          evidencePath: evidence.evidencePath,
        });
      return false;
    }
    await this.stopInternal(id);
    const completed = this.get(id);
    assertManagedManager(completed);
    completed.status = 'complete';
    if (completed.engine === 'codex' && completed.threadId) {
      const client = await this.client(completed.pool);
      const updated = await client.request('thread/goal/set', {
        threadId: completed.threadId,
        status: 'complete',
        origin: 'user',
      });
      completed.goalState = updated.goal;
    }
    this.save(completed);
    const event = {
      kind: 'goal-met' as const,
      summary: evidence.summary.replace(/[\r\n]+/g, ' '),
      evidencePath: evidence.evidencePath,
    };
    this.inbox.deliver({ managerId: id, ...event });
    if (completed.supermanager !== id) this.inbox.deliver({ managerId: completed.supermanager, ...event });
    return true;
  }
  complete(id: string): Promise<boolean> {
    assertManagedManager(this.get(id));
    this.background(id, () => this.completeInternal(id));
    return Promise.resolve(true);
  }
  completeCommand(id: string): Promise<boolean> {
    assertManagedManager(this.get(id));
    return this.serial(id, () => this.completeInternal(id));
  }

  /** Rejoin persisted threads on host restart and retry committed, unsignalled inbox deliveries. */
  async recover(onProgress?: () => void): Promise<void> {
    const states = this.list()
      .filter(isManagedManager)
      .filter((state) => state.status === 'running' || state.status === 'starting' || state.pendingRenewal);
    let progressReported = false;
    const reportProgress = () => {
      if (progressReported) return;
      progressReported = true;
      onProgress?.();
    };
    if (!states.length) reportProgress();
    const results = await Promise.allSettled(
      states.map((state) =>
        this.serial(state.id, async () => {
          let current = this.get(state.id);
          assertManagedManager(current);
          if (current.pendingRenewal) {
            reportProgress();
            if (
              current.threadId &&
              current.threadId !== current.pendingRenewal.oldThreadId &&
              current.pendingRenewal.ready
            ) {
              await this.deliverRenewalNotice(current.id);
              current = this.get(current.id);
              assertManagedManager(current);
            } else {
              await this.renewInternal(current.id, this.specFromState(current));
              return;
            }
          }
          if (current.status !== 'running' && current.status !== 'starting') {
            reportProgress();
            return;
          }
          if (current.engine === 'codex' && current.threadId) {
            const client = await this.client(current.pool);
            const resume = client.request('thread/resume', {
              ...FULL_ACCESS,
              threadId: current.threadId,
              model: CODEX_MANAGER_MODEL,
              config: codexThreadConfig(current),
            });
            reportProgress();
            const resumed = await resume;
            current.activeTurnId =
              resumed.thread.turns?.findLast((turn: any) => turn.status === 'inProgress')?.id ?? null;
            const goal = await client.request('thread/goal/get', { threadId: current.threadId });
            current.goalState = goal.goal;
          }
          reportProgress();
          if (current.status === 'starting') {
            current.status = 'paused';
            this.save(current);
            await this.pauseRemote(current);
            return;
          }
          this.save(current);
          if (current.engine === 'codex' && current.threadId) {
            const client = await this.client(current.pool);
            this.services.windows.unregister(current.id);
            this.registerCodexViewer(current, client);
          }
          if (await this.handleGoalUpdate(current)) return;
          if (!(await this.checkLimits(current))) {
            if (current.goalState?.status === 'complete') await this.completeInternal(current.id);
            else await this.dispatch(current.id);
          }
        }),
      ),
    );
    for (const result of results) if (result.status === 'rejected') this.error(result.reason);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.watcher.close();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    for (const timer of this.timers.values()) clearTimeout(timer);
    await this.flush();
    for (const client of this.pools.values()) {
      try {
        await (await client).close();
      } catch {}
    }
  }
}
