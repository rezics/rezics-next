import { defaultPolicy, type ControlPolicy } from './policy.ts';
import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { watchOrPoll, type Watching } from './watch-or-poll.ts';
import { join } from 'node:path';
import type { AppServer, CodexPool, Notification } from './app-server.ts';
import { migrate } from './db.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { isPendingContinuationHandshake } from './manager-continuation.ts';
import { ownedGoals } from './manager-ownership.ts';
import { ManagerSessionTransport } from './manager-session-transport.ts';
import { readGoalDocuments, renderManagerOpening } from './prompts.ts';
import { recordFlow } from './flow.ts';
import type { PromptBudgetManifest } from './types.ts';
import type { ProcessIdentity } from './process.ts';
import { runHostOperation } from './service.ts';
import type { ManagerWindows } from './windows.ts';

export { managerOwnership, ownedGoals, readManagerOwnership, resolveGoalManager } from './manager-ownership.ts';

export type ManagerLimits = { turns: number; turnsWithoutDecision: number; wallMs: number };
export type ManagerSpec = {
  id: string;
  goal: string;
  /** Goals this session owns. A session without the field owns only `goal`. */
  goals?: string[];
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
  /** This controller parked native Goal autonomy after a completed turn; only an admitted inbox wake resumes it. */
  waitingForInbox?: boolean;
  status: 'starting' | 'running' | 'paused' | 'complete' | 'renewal-failed';
  startedAt: number;
  turns: number;
  turnsWithoutDecision: number;
  decision: boolean;
  countedTurn: string | null;
  /** Host clock when the counted turn started; a backlog brief written since then is the turn's decision. */
  turnStartedAt?: number;
  goalState: GoalState | null;
  usage: unknown;
  promptManifest?: PromptBudgetManifest;
  continuationAsked?: boolean;
  continuationRenewed?: boolean;
  continuationTokensUsed?: number;
  pendingRenewal?: { tokensUsed: number; oldThreadId: string | null; ready: boolean };
  /** Automatic renewal attempts; `error` is the failure's first line, omitted when that attempt succeeded. */
  renewalAttempts?: { at: number; error?: string }[];
  nextRenewalRetryAt?: number;
  /** Goals whose briefs and continuations the next turn must include after ownership changes. */
  pendingGoalReads?: string[];
};
export type ManagedManagerState = ManagerSessionSnapshot & { history?: ManagerSessionSnapshot[] };
/** An existing provider session registered for authority only; it is not a managed model session. */
type ResidentManagedFields = Exclude<keyof ManagerSessionSnapshot, 'kind' | 'id' | 'status' | 'threadId'>;
export type ResidentSupermanagerState = Pick<ManagerSessionSnapshot, 'id' | 'status' | 'threadId'> & {
  kind: 'resident-supermanager';
  provider: 'codex' | 'claude';
  status: 'running';
  threadId: string;
  registeredAt: string;
} & { [Key in ResidentManagedFields]?: never } & { history?: never };
export type ManagerState = ManagedManagerState | ResidentSupermanagerState;
export type CompletionEvidence = { passed: boolean; evidencePath: string; summary: string };
export type ManagerServices = {
  policy?: ControlPolicy;
  connect?: (pool: CodexPool, onStart?: (identity: ProcessIdentity) => void) => Promise<AppServer>;
  /** Read-only admission against the current retained pool allowance before an inbox wake starts a model turn. */
  canStartTurn?: (spec: Pick<ManagerSpec, 'engine' | 'pool' | 'effort'>) => boolean;
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
  private chains = new Map<string, Promise<unknown>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private assigns: Promise<unknown> = Promise.resolve();
  private watcher: Watching;
  private closed = false;
  private readonly policy: ControlPolicy;
  private readonly transport: ManagerSessionTransport;
  constructor(
    private readonly db: Database,
    readonly inbox: SqliteManagerInbox,
    private readonly services: ManagerServices,
  ) {
    this.policy = services.policy ?? defaultPolicy;
    this.transport = new ManagerSessionTransport(
      services,
      this.policy.appServer,
      inbox.stateDirectory,
      (notification) => this.notification(notification),
    );
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
  /** Persist an external session; replacement compares the previous identity in the same write transaction. */
  registerResidentSupermanager(
    id: string,
    sessionId: string,
    options: { provider?: ResidentSupermanagerState['provider']; replaceSession?: string } = {},
  ): Promise<ResidentSupermanagerState> {
    return this.serial(id, async () => {
      if (!id || id.trim() !== id) throw new Error('Configured supermanager identity is missing or malformed');
      const provider = options.provider ?? 'claude';
      if (provider !== 'claude' && provider !== 'codex') throw new Error('Resident provider is unsupported');
      const validSession = (value: unknown) =>
        typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
      if (!validSession(sessionId)) throw new Error('Resident provider session ID is malformed');
      if (options.replaceSession !== undefined && !validSession(options.replaceSession))
        throw new Error('Previous resident session ID is malformed');
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
          const state = current?.state as Partial<ResidentSupermanagerState> | undefined;
          const resident =
            state?.kind === 'resident-supermanager' &&
            state.id === id &&
            (state.provider === 'claude' || state.provider === 'codex') &&
            state.status === 'running';
          if (options.replaceSession !== undefined && (!resident || state?.threadId !== options.replaceSession))
            throw new Error('Resident session replacement mismatch; the registered session has changed or is missing');
          if (current) {
            if (!resident)
              throw new Error(
                `Manager ${id} already has a persisted session; refusing to replace it with a resident session`,
              );
            if (state?.threadId === sessionId && state.provider === provider) {
              registered = state as ResidentSupermanagerState;
              return;
            }
            if (options.replaceSession === undefined)
              throw new Error(
                `Resident supermanager ${id} is already registered to another session; use --replace-session <previous-thread-id>`,
              );
          }

          registered = {
            kind: 'resident-supermanager',
            id,
            provider,
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
    let completedCurrentTurn = false;
    // Notifications from a retired Codex thread can already be queued when renewal swaps sessions.
    if (state.threadId && params?.threadId && state.threadId !== params.threadId) return;
    if (method === 'turn/started') {
      this.turnStarted(state, params.turn.id);
      if (state.status !== 'running' || state.waitingForInbox) await this.pauseRemote(state);
    } else if (method === 'turn/completed') {
      completedCurrentTurn = this.turnEnded(state, params.turn.id);
    } else if (method === 'thread/goal/updated') {
      state.goalState = params.goal;
      if (
        state.waitingForInbox &&
        ['blocked', 'budgetLimited', 'usageLimited', 'complete'].includes(params.goal.status)
      )
        state.waitingForInbox = false;
    } else if (method === 'thread/goal/cleared') {
      state.goalState = null;
    } else if (method === 'thread/tokenUsage/updated') state.usage = params.tokenUsage;
    else if (method === 'item/started' && params?.item?.type === 'sleep') {
      this.countSleep(state);
      return;
    } else return;
    this.save(state);
    if (state.status === 'running') {
      if (method === 'thread/goal/updated' && state.waitingForInbox && state.goalState?.status === 'active') {
        // An idle Goal should stay parked. This catches provider or external reactivation before another
        // goal-generated continuation can replace the event-driven wait.
        await this.pauseRemote(state);
        return;
      }
      if (method === 'thread/goal/updated' && (await this.handleGoalUpdate(state))) return;
      if (await this.checkLimits(state)) return;
      if (state.goalState?.status === 'complete') await this.completeInternal(state.id);
      if (
        state.status === 'running' &&
        method === 'thread/goal/updated' &&
        state.goalState?.status === 'active' &&
        this.inbox.notifications(id).length > 0
      ) {
        await this.dispatch(id);
        return;
      }
    }
    if (completedCurrentTurn) await this.markWaitingForInbox(id);
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
  private backlogRoot(spec: Pick<ManagerSpec, 'cwd'>): string {
    return this.services.backlogDirectory ?? join(spec.cwd, '.temp', 'goal', 'backlog');
  }
  private backlogPath(spec: ManagerSpec, goal = spec.goal): string {
    return join(this.backlogRoot(spec), goal);
  }
  /** Whether a ready brief in any owned Goal's backlog was written or moved there since `since`, or dispatched. */
  private backlogWrittenSince(spec: ManagerSpec, turnStart: number): boolean {
    return ownedGoals(spec).some((goal) => this.backlogWrittenForGoal(spec, goal, turnStart));
  }
  private backlogWrittenForGoal(spec: ManagerSpec, goal: string, turnStart: number): boolean {
    // File times come from the kernel's coarse clock, which can trail the process clock by a few milliseconds.
    const since = turnStart - this.policy.manager.fileClockSlackMs;
    const directory = this.backlogPath(spec, goal);
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
    const row = this.db.query('SELECT last_written_at FROM backlog_goals WHERE goal = ?').get(goal) as {
      last_written_at: number | null;
    } | null;
    return (row?.last_written_at ?? -1) >= since;
  }
  private opening(spec: ManagerSpec, continuationFile?: string) {
    const goals = ownedGoals(spec);
    return renderManagerOpening({
      spec: { ...spec, goals },
      continuationFile,
      continuationText:
        continuationFile && existsSync(continuationFile) ? readFileSync(continuationFile, 'utf8') : undefined,
      backlogPath: goals.map((goal) => join(this.backlogRoot(spec), goal)).join(', '),
      command: this.services.command.join(' '),
      policy: this.policy,
    });
  }
  private recordPromptLaunch(state: ManagedManagerState): void {
    if (!state.promptManifest) return;
    recordFlow(this.db, {
      taskId: `manager:${state.id}`,
      attempt: state.history?.length ?? 0,
      stage: 'manager',
      action: 'started',
      at: new Date(this.now()).toISOString(),
      detail: JSON.stringify({ prompt: { overBudget: state.promptManifest.overBudget } }),
    });
  }
  // A Claude manager hears its inbox through its own background watcher, so a session that exited never sees new
  // events; the next event resumes it in its window.
  private async reviveClaude(state: ManagedManagerState): Promise<void> {
    if (!state.threadId) return;
    const notified = await this.transport.reviveClaude(
      state,
      state.threadId,
      this.inbox.pending(state.id).length > 0,
      this.inbox.notifications(state.id),
    );
    for (const id of notified) this.inbox.notified(id);
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
      goals: ownedGoals(spec).length ? ownedGoals(spec) : [spec.goal],
      threadId: null,
      activeTurnId: null,
      waitingForInbox: false,
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
        const client = await this.transport.client(spec.pool);
        const threadId = await this.transport.startThread(client, spec);
        state.threadId = threadId;
        this.save(state);
        state.goalState = await this.transport.setActiveGoal(client, spec, threadId);
        state.status = 'running';
        this.save(state);
        await this.transport.registerCodexViewer(state, threadId, client);
        const continuationFile = history?.length ? this.continuationPath(spec) : undefined;
        const opening =
          continuationFile && existsSync(continuationFile) ? this.opening(spec, continuationFile) : this.opening(spec);
        state.promptManifest = opening.manifest;
        const turnId = await this.transport.startTurn(client, spec, state.threadId, opening.prompt);
        this.turnStarted(state, turnId);
        this.recordPromptLaunch(state);
        if (state.pendingRenewal) {
          state.pendingRenewal.ready = true;
          this.save(state);
          await this.deliverRenewalNotice(state.id);
          if (state.pendingRenewal?.ready) delete state.pendingRenewal;
        }
      } else {
        state.threadId = randomUUID();
        const opening = this.opening(spec);
        state.promptManifest = opening.manifest;
        await this.transport.registerClaudeSession(spec, state.threadId, opening.prompt);
        state.status = 'running';
        this.recordPromptLaunch(state);
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
      if (current.status !== 'paused' && current.status !== 'renewal-failed' && !goalCanRenew)
        throw new Error(`Manager must be paused to renew: ${id}`);
      return this.renewInternal(id, spec);
    });
  }
  private async renewInternal(id: string, spec: ManagerSpec): Promise<ManagedManagerState> {
    const current = this.get(id);
    assertManagedManager(current);
    const retryingFailed = current.status === 'renewal-failed';
    // Reapply the stop operation because a paused record can still have a live turn or viewer left behind.
    await this.stopInternal(id);
    const stopped = this.get(id);
    assertManagedManager(stopped);
    const { history: _history, renewalAttempts: _attempts, nextRenewalRetryAt: _retry, ...snapshot } = stopped;
    const history = retryingFailed ? (stopped.history ?? []) : [...(stopped.history ?? []), snapshot];
    return this.startSession(spec, history, stopped.pendingRenewal);
  }

  private specFromState(state: ManagedManagerState): ManagerSpec {
    const {
      threadId: _threadId,
      activeTurnId: _activeTurnId,
      waitingForInbox: _waitingForInbox,
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
      renewalAttempts: _renewalAttempts,
      nextRenewalRetryAt: _nextRenewalRetryAt,
      pendingGoalReads: _pendingGoalReads,
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
    try {
      await this.renewForContinuation(current.id, current.goalState.tokensUsed);
    } catch (error) {
      await this.failRenewal(current.id, error);
    }
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
  private turnEnded(state: ManagedManagerState, turn: string): boolean {
    let ended = false;
    this.db
      .transaction(() => {
        if (state.activeTurnId !== turn) return;
        ended = true;
        if (state.threadId && managerHasDecision(this.db, state.id, state.threadId, turn)) state.decision = true;
        // Ready briefs are a manager's main output; writing one is a decision even without a control-plane command.
        if (
          !state.decision &&
          state.turnStartedAt !== undefined &&
          this.backlogWrittenSince(state, state.turnStartedAt)
        )
          state.decision = true;
        state.turnsWithoutDecision = state.decision ? 0 : state.turnsWithoutDecision + 1;
        state.activeTurnId = null;
        this.save(state);
      })
      .immediate();
    return ended;
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
      try {
        await this.renewInternal(state.id, this.specFromState(state));
        return true;
      } catch (error) {
        await this.failRenewal(state.id, error);
        return true;
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
  private renewalErrorLine(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).trim().split(/\r?\n/, 1)[0] ?? '';
  }
  private async failRenewal(
    id: string,
    error: unknown,
    previousAttempts?: { at: number; error?: string }[],
  ): Promise<void> {
    this.error(error);
    const state = this.get(id);
    assertManagedManager(state);
    const line = this.renewalErrorLine(error);
    state.status = 'renewal-failed';
    state.renewalAttempts = [...(previousAttempts ?? state.renewalAttempts ?? []), { at: this.now(), error: line }];
    state.nextRenewalRetryAt = this.now() + this.policy.manager.renewalRetryMs;
    this.save(state);
    this.inbox.deliver({
      managerId: state.supermanager,
      kind: 'blocker',
      summary: `Manager ${state.id} renewal failed: ${line}`,
    });
    this.armRenewalRetry(state);
  }
  private armRenewalRetry(state: ManagedManagerState): void {
    clearTimeout(this.timers.get(state.id));
    if (this.closed) return;
    const delay = Math.max(0, Math.min(this.policy.manager.renewalRetryMs, 2_147_483_647));
    this.timers.set(
      state.id,
      setTimeout(() => this.background(state.id, () => this.retryFailedRenewal(state.id)), delay),
    );
  }
  private async retryFailedRenewal(id: string): Promise<void> {
    const state = this.get(id);
    assertManagedManager(state);
    if (state.status !== 'renewal-failed') return;
    const attempts = state.renewalAttempts ?? [];
    try {
      await this.renewInternal(id, this.specFromState(state));
      const renewed = this.get(id);
      assertManagedManager(renewed);
      renewed.renewalAttempts = [...attempts, { at: this.now() }];
      delete renewed.nextRenewalRetryAt;
      this.save(renewed);
    } catch (error) {
      await this.failRenewal(id, error, attempts);
    }
  }
  private async markWaitingForInbox(id: string): Promise<void> {
    const state = this.get(id);
    assertManagedManager(state);
    if (
      state.status !== 'running' ||
      state.engine !== 'codex' ||
      !state.threadId ||
      (state.activeTurnId !== null && !state.waitingForInbox)
    )
      return;

    const wasWaitingForInbox = state.waitingForInbox === true;
    // Persist the idle intent before consulting or pausing the provider. If this process exits
    // between these operations, host recovery can park this same thread before resuming it.
    state.waitingForInbox = true;
    this.save(state);
    const client = await this.transport.client(state.pool);
    const goal = await this.transport.getGoal(client, state.threadId);
    state.goalState = goal;
    if (goal?.status === 'active') {
      await this.pauseRemote(state);
      return;
    }
    if (goal?.status === 'paused') {
      if (!wasWaitingForInbox) state.waitingForInbox = false;
      this.save(state);
      return;
    }
    if (!goal) {
      if (!wasWaitingForInbox) state.waitingForInbox = false;
      this.save(state);
      return;
    }
    // A user or guard status is not the controller's idle park and must not be reactivated on inbox wake.
    state.waitingForInbox = false;
    this.save(state);
  }
  private async pauseRemote(state: ManagerState): Promise<void> {
    assertManagedManager(state);
    if (state.engine === 'codex' && state.threadId) {
      const client = await this.transport.client(state.pool);
      state.goalState = await this.transport.setGoalStatus(client, state.threadId, 'paused');
      this.save(state);
      if (state.activeTurnId) await this.transport.interruptTurn(client, state, state.threadId, state.activeTurnId);
    }
  }
  private async stopInternal(id: string): Promise<void> {
    const state = this.get(id);
    assertManagedManager(state);
    state.status = 'paused';
    state.waitingForInbox = false;
    this.save(state);
    clearTimeout(this.timers.get(id));
    try {
      await this.pauseRemote(state);
    } finally {
      await this.services.windows.unregister(id);
    }
  }
  stop(id: string): Promise<void> {
    return this.serial(id, () => this.stopInternal(id));
  }

  private consumeGoalReadings(state: ManagedManagerState): string {
    const goals = state.pendingGoalReads ?? [];
    if (!goals.length) return '';
    delete state.pendingGoalReads;
    this.save(state);
    return readGoalDocuments(state.cwd, goals).join('\n\n');
  }
  private async dispatch(id: string): Promise<void> {
    let state = this.get(id);
    if (isResidentSupermanager(state)) return;
    if (state.status !== 'running') return;
    if (state.engine === 'claude') return await this.reviveClaude(state);
    const events = this.inbox.notifications(id);
    // An empty inbox wake is bookkeeping only; a parked native Goal stays paused.
    if (events.length === 0) return;
    if (state.waitingForInbox) {
      // Reconcile the persisted native Goal before an inbox event may reactivate it.
      await this.markWaitingForInbox(id);
      state = this.get(id);
      assertManagedManager(state);
    }
    const idleWake = state.waitingForInbox === true;
    if (
      (idleWake || state.activeTurnId === null) &&
      this.services.canStartTurn &&
      !this.services.canStartTurn(state)
    )
      return;
    const client = await this.transport.client(state.pool);
    state.goalState = await this.transport.getGoal(client, state.threadId!);
    if (idleWake) {
      if (state.goalState?.status === 'paused')
        state.goalState = await this.transport.setGoalStatus(client, state.threadId!, 'active');
      if (state.goalState?.status !== 'active') {
        this.save(state);
        return;
      }
      state.waitingForInbox = false;
      this.save(state);
    } else if (state.goalState?.status !== 'active' && state.goalState?.status !== 'blocked') {
      // A running manager can still receive an admitted manual turn while its native Goal is blocked.
      // Keep that native state intact; only a real inbox event may take the existing explicit turn path.
      this.save(state);
      return;
    }
    let prefix = this.consumeGoalReadings(state);
    for (const event of events) {
      state = this.get(id);
      assertManagedManager(state);
      const summary = prefix ? [prefix, event.event.summary].filter(Boolean).join('\n\n') : event.event.summary;
      prefix = '';
      const delivered = await this.transport.deliverToSession(
        client,
        state,
        state.threadId!,
        state.activeTurnId,
        summary,
        (turnId) => {
          state.activeTurnId = turnId;
          this.save(state);
        },
      );
      if (delivered.kind === 'started') {
        this.turnStarted(state, delivered.turnId);
        this.save(state);
      }
      this.inbox.notified(event.id);
    }
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
        const client = await this.transport.client(state.pool);
        state.goalState = await this.transport.setGoalStatus(client, state.threadId, 'active');
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
      const client = await this.transport.client(completed.pool);
      completed.goalState = await this.transport.setGoalStatus(client, completed.threadId, 'complete');
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

  /**
   * Move a Goal to another running managed manager. Inbox history, wake-ups, width and landing notices, and
   * dispatch and retry authority follow; running tasks keep their handles. The old session for that Goal stops.
   */
  assign(goal: string, toId: string): Promise<{ goal: string; from: string; to: string; goals: string[] }> {
    const next = this.assigns.catch(() => {}).then(() => this.assignInternal(goal, toId));
    this.assigns = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  private goalOwner(goal: string): ManagedManagerState | undefined {
    const owners = this.list().filter(
      (state): state is ManagedManagerState => isManagedManager(state) && ownedGoals(state).includes(goal),
    );
    return owners.length === 1 ? owners[0] : undefined;
  }
  private reassignGoalTasks(goal: string, from: string, to: string): void {
    if (!this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'worker_tasks'").get()) return;
    this.db
      .query(`INSERT INTO worker_events(task_id,attempt,kind,at,body)
        SELECT id,current_attempt,'owner-contract-decisions-superseded',?,? FROM worker_tasks AS task
        WHERE json_extract(body, '$.brief.goal')=? AND json_extract(body, '$.brief.manager')=?
        AND EXISTS (SELECT 1 FROM worker_events WHERE task_id=task.id AND kind='owner-contract-decision-accepted')`)
      .run(new Date().toISOString(), JSON.stringify({ previousManager: from, manager: to }), goal, from);
    this.db
      .query(
        `UPDATE worker_tasks SET body = json_set(body, '$.brief.manager', ?)
         WHERE json_extract(body, '$.brief.goal') = ? AND json_extract(body, '$.brief.manager') = ?`,
      )
      .run(to, goal, from);
    if (!this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'landing_queue'").get()) return;
    this.db
      .query(
        `UPDATE landing_queue SET request = json_set(request, '$.managerLanding.managerId', ?)
         WHERE json_valid(request)
           AND json_extract(request, '$.managerLanding.managerId') = ?
           AND task IN (SELECT id FROM worker_tasks WHERE json_extract(body, '$.brief.goal') = ?)`,
      )
      .run(to, from, goal);
  }
  private async assignInternal(
    goal: string,
    toId: string,
  ): Promise<{ goal: string; from: string; to: string; goals: string[] }> {
    if (!goal || goal.trim() !== goal) throw new Error('Goal identity is missing or malformed');
    if (!toId || toId.trim() !== toId) throw new Error('Manager identity is missing or malformed');
    let target: ManagerState;
    try {
      target = this.get(toId);
    } catch {
      throw new Error(`Manager ${toId} is not a running managed manager`);
    }
    if (!isManagedManager(target) || target.status !== 'running')
      throw new Error(`Manager ${toId} is not a running managed manager`);
    const source = this.goalOwner(goal);
    if (!source) throw new Error(`No managed manager owns Goal ${goal}`);
    if (source.id === toId) throw new Error(`Goal ${goal} is already owned by manager ${toId}`);
    const remaining = ownedGoals(source).filter((owned) => owned !== goal);
    const nextGoals = [...ownedGoals(target), goal].filter((owned, index, all) => all.indexOf(owned) === index);
    const lastGoal = remaining.length === 0;
    this.db
      .transaction(() => {
        this.inbox.reassignGoal(goal, source.id, toId, lastGoal);
        this.reassignGoalTasks(goal, source.id, toId);
        const currentTarget = this.get(toId);
        assertManagedManager(currentTarget);
        currentTarget.goals = nextGoals;
        currentTarget.pendingGoalReads = nextGoals;
        this.save(currentTarget);
        const currentSource = this.get(source.id);
        assertManagedManager(currentSource);
        currentSource.goals = remaining;
        if (remaining.length && currentSource.goal === goal) currentSource.goal = remaining[0]!;
        this.save(currentSource);
        this.inbox.deliver({
          managerId: toId,
          goalId: goal,
          kind: 'instruction',
          summary: `You now own Goals ${nextGoals.join(', ')}. Read each Goal's brief and continuation.`,
        });
      })
      .immediate();
    if (lastGoal && source.status === 'running') await this.serial(source.id, () => this.stopInternal(source.id));
    await this.serial(toId, () => this.dispatch(toId));
    const assigned = this.get(toId);
    assertManagedManager(assigned);
    return { goal, from: source.id, to: toId, goals: ownedGoals(assigned) };
  }

  /** Rejoin persisted threads on host restart and retry committed, unsignalled inbox deliveries. */
  async recover(onProgress?: () => void): Promise<void> {
    return runHostOperation('manager recovery', () => this.recoverInternal(onProgress));
  }
  private async recoverInternal(onProgress?: () => void): Promise<void> {
    const states = this.list()
      .filter(isManagedManager)
      .filter(
        (state) =>
          state.status === 'running' ||
          state.status === 'starting' ||
          state.status === 'renewal-failed' ||
          state.pendingRenewal,
      );
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
          if (current.status === 'renewal-failed') {
            reportProgress();
            await this.retryFailedRenewal(current.id);
            return;
          }
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
              try {
                await this.renewInternal(current.id, this.specFromState(current));
              } catch (error) {
                await this.failRenewal(current.id, error);
              }
              return;
            }
          }
          if (current.status !== 'running' && current.status !== 'starting') {
            reportProgress();
            return;
          }
          if (current.engine === 'codex' && current.threadId) {
            const parkedIdle =
              current.status === 'running' &&
              (current.waitingForInbox || (current.activeTurnId === null && current.turns > 0));
            if (parkedIdle) {
              // Resolve the native Goal before resuming its thread. A completed idle turn must stay parked
              // across host recovery; resuming the thread could rearm provider autonomy.
              await this.markWaitingForInbox(current.id);
              current = this.get(current.id);
              assertManagedManager(current);
            } else if (
              current.goalState?.status !== 'paused' &&
              current.goalState?.status !== 'blocked' &&
              current.goalState?.status !== 'budgetLimited' &&
              current.goalState?.status !== 'usageLimited' &&
              current.goalState?.status !== 'complete'
            ) {
              const client = await this.transport.client(current.pool);
              const resumed = await this.transport.resumeThread(client, current, current.threadId);
              reportProgress();
              current.activeTurnId = resumed.activeTurnId;
              current.goalState = await this.transport.getGoal(client, current.threadId);
              if (
                current.status === 'running' &&
                current.activeTurnId === null &&
                current.turns > 0
              ) {
                await this.markWaitingForInbox(current.id);
                current = this.get(current.id);
                assertManagedManager(current);
              }
            }
          }
          reportProgress();
          if (current.status === 'starting') {
            current.status = 'paused';
            this.save(current);
            await this.pauseRemote(current);
            return;
          }
          this.save(current);
          if (
            current.engine === 'codex' &&
            current.threadId &&
            current.status === 'running' &&
            current.goalState?.status === 'active' &&
            !current.waitingForInbox
          ) {
            const client = await this.transport.client(current.pool);
            await this.services.windows.unregister(current.id);
            await this.transport.registerCodexViewer(current, current.threadId, client);
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
    this.transport.unsubscribe();
    for (const timer of this.timers.values()) clearTimeout(timer);
    await this.flush();
    await this.transport.close();
  }
}
