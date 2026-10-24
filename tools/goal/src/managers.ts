import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import type { AppServer, CodexPool, Notification } from './app-server.ts';
import { connectPool, textInput } from './app-server.ts';
import { migrate } from './db.ts';
import { SqliteManagerInbox } from './inbox.ts';
import type { ManagerWindows } from './windows.ts';

export type ManagerLimits = { turns: number; turnsWithoutDecision: number; wallMs: number };
export type ManagerSpec = {
  id: string; goal: string; objective: string; brief: string; cwd: string;
  engine: 'codex' | 'claude'; pool: CodexPool; budget: number; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  supermanager: string; limits: ManagerLimits;
};
export type GoalState = { status: 'active' | 'paused' | 'complete' | 'blocked' | 'usageLimited' | 'budgetLimited';
  tokensUsed: number; timeUsedSeconds: number; tokenBudget: number | null };
export type ManagerState = ManagerSpec & {
  threadId: string | null; activeTurnId: string | null; status: 'starting' | 'running' | 'paused' | 'complete';
  startedAt: number; turns: number; turnsWithoutDecision: number; decision: boolean;
  countedTurn: string | null; goalState: GoalState | null; usage: unknown;
};
export type CompletionEvidence = { passed: boolean; evidencePath: string; summary: string };
export type ManagerServices = {
  connect?: (pool: CodexPool) => Promise<AppServer>;
  windows: ManagerWindows;
  checkCompletion(goal: string): Promise<CompletionEvidence>;
  /** The CLI prefix includes its runtime composition module, if any. */
  command: string[];
  now?: () => number;
  onError?: (error: unknown) => void;
};

export class ManagerSessions {
  private pools = new Map<string, Promise<AppServer>>();
  private chains = new Map<string, Promise<unknown>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private watcher: FSWatcher;
  private closed = false;
  private unsubscribers: (() => void)[] = [];
  constructor(private readonly db: Database, readonly inbox: SqliteManagerInbox, private readonly services: ManagerServices) {
    migrate(db, [{ module: 'managers', version: 1, sql: 'CREATE TABLE manager_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL);' }]);
    this.watcher = watch(inbox.signalDirectory, () => {
      for (const state of this.list()) if (state.status === 'running') this.background(state.id, () => this.dispatch(state.id));
    });
    this.watcher.on('error', error => this.error(error));
  }
  private now(): number { return (this.services.now ?? Date.now)(); }
  private error(error: unknown): void { (this.services.onError ?? console.error)(error); }
  get(id: string): ManagerState {
    const row = this.db.query('SELECT state FROM manager_sessions WHERE id = ?').get(id) as { state: string } | null;
    if (!row) throw new Error(`Unknown manager: ${id}`);
    return JSON.parse(row.state);
  }
  list(): ManagerState[] {
    return (this.db.query('SELECT state FROM manager_sessions').all() as { state: string }[]).map(row => JSON.parse(row.state));
  }
  private save(state: ManagerState): void {
    this.db.query('INSERT INTO manager_sessions(id, state) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state')
      .run(state.id, JSON.stringify(state));
  }
  private serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
    this.chains.set(id, next);
    return next;
  }
  private background(id: string, action: () => Promise<unknown>): void { void this.serial(id, action).catch(error => this.error(error)); }
  async flush(): Promise<void> {
    for (;;) {
      const snapshot = [...this.chains.values()];
      await Promise.all(snapshot);
      if (snapshot.length === this.chains.size && [...this.chains.values()].every((chain, index) => chain === snapshot[index])) return;
    }
  }
  private client(pool: CodexPool): Promise<AppServer> {
    const key = pool.codexHome;
    let client = this.pools.get(key);
    if (!client) {
      client = (this.services.connect ?? connectPool)(pool).then(server => {
        this.unsubscribers.push(server.onNotification(notification => this.notification(notification))); return server;
      });
      this.pools.set(key, client);
      void client.catch(() => this.pools.delete(key));
    }
    return client;
  }
  private notification(notification: Notification): void {
    if (this.closed) return;
    const state = this.list().find(state => state.threadId === notification.params?.threadId);
    if (state) this.background(state.id, () => this.handleNotification(state.id, notification));
  }
  private async handleNotification(id: string, { method, params }: Notification): Promise<void> {
    const state = this.get(id);
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
    else return;
    this.save(state);
    if (state.status === 'running') {
      if (await this.checkLimits(state)) return;
      if (state.goalState?.status === 'complete') await this.completeInternal(state.id);
    }
  }
  private opening(spec: ManagerSpec): string {
    return `${spec.brief}\n\nYou manage Goal ${spec.goal}. Make decisions through the control plane. ` +
      `Export GOAL_MANAGER=${spec.id} for control-plane commands. Completion is a proposal: run ` +
      `${this.services.command.join(' ')} manager complete ${spec.id}; the control plane verifies every scoped task is merged and the main gate passes. ` +
      (spec.engine === 'codex'
        ? 'When no decision is pending, use clock.sleep inside the active turn; do not poll or end an empty turn. '
        : `When no decision is pending, run ${this.services.command.join(' ')} inbox wait ${spec.id} as a background command and end the turn. `) +
      'Read and acknowledge inbox events. Do not perform mechanical gates, retries or merges yourself.';
  }
  async start(spec: ManagerSpec): Promise<ManagerState> {
    return this.serial(spec.id, async () => {
      if (!Number.isSafeInteger(spec.budget) || spec.budget <= 0 || Object.values(spec.limits).some(n => !Number.isFinite(n) || n <= 0))
        throw new Error('Manager budget and limits must be positive');
      if (this.list().some(state => state.id === spec.id)) throw new Error(`Manager already exists: ${spec.id}`);
      const state: ManagerState = { ...spec, threadId: null, activeTurnId: null, status: 'starting', startedAt: this.now(),
        turns: 0, turnsWithoutDecision: 0, decision: false, countedTurn: null, goalState: null, usage: null };
      this.save(state);
      try {
        if (spec.engine === 'codex') {
          const client = await this.client(spec.pool);
          const started = await client.request('thread/start', { cwd: spec.cwd, model: 'gpt-6.1-sol',
            config: { model_reasoning_effort: spec.effort, model_auto_compact_token_limit: 300000 } });
          state.threadId = started.thread.id;
          this.save(state);
          const goal = await client.request('thread/goal/set', { threadId: state.threadId, objective: spec.objective,
            status: 'active', tokenBudget: spec.budget, origin: 'user' });
          state.goalState = goal.goal; state.status = 'running'; this.save(state);
          this.services.windows.register(spec.id, ['env', `CODEX_HOME=${spec.pool.codexHome}`, `GOAL_MANAGER=${spec.id}`,
            spec.pool.executable ?? 'codex', 'resume', state.threadId!], spec.cwd);
          const turn = await client.request('turn/start', { threadId: state.threadId, effort: spec.effort, input: textInput(this.opening(spec)) });
          this.turnStarted(state, turn.turn.id);
        } else {
          const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
          const hook = (command: string) => [...this.services.command, 'manager', command, spec.id].map(quote).join(' ');
          const settings = { hooks: {
            UserPromptSubmit: [{ hooks: [{ type: 'command', command: hook('turn-start') }] }],
            Stop: [{ hooks: [{ type: 'command', command: hook('turn-end') }] }],
          } };
          this.services.windows.register(spec.id, ['env', `GOAL_MANAGER=${spec.id}`, 'claude', '--model', 'claude-opus-5-5',
            '--autocompact', '300000', '--settings', JSON.stringify(settings), this.opening(spec)], spec.cwd);
          state.status = 'running';
        }
        this.save(state); this.armDeadline(state);
        await this.dispatch(spec.id);
        return this.get(spec.id);
      } catch (error) {
        state.status = 'paused'; this.save(state);
        try { await this.pauseRemote(state); } catch (stopError) { this.error(stopError); }
        throw error;
      }
    });
  }
  private turnStarted(state: ManagerState, turn: string): void {
    if (state.countedTurn !== turn) { state.turns++; state.decision = false; state.countedTurn = turn; }
    state.activeTurnId = turn;
  }
  private turnEnded(state: ManagerState, turn: string): void {
    if (state.activeTurnId !== turn) return;
    if (!state.decision) state.turnsWithoutDecision++;
    state.activeTurnId = null;
  }
  async noteCommand(id: string): Promise<void> {
    return this.serial(id, async () => { const state = this.get(id); state.decision = true; this.save(state); });
  }
  async claudeTurn(id: string, start: boolean): Promise<void> {
    return this.serial(id, async () => {
      const state = this.get(id);
      if (state.engine !== 'claude') throw new Error('Turn hooks are only for Claude managers');
      if (start) this.turnStarted(state, randomUUID());
      else if (state.activeTurnId) this.turnEnded(state, state.activeTurnId);
      else {
        // Background-command completion can start a Claude turn without UserPromptSubmit.
        state.turns++;
        if (!state.decision) state.turnsWithoutDecision++;
        state.decision = false;
      }
      this.save(state); await this.checkLimits(state);
    });
  }
  private armDeadline(state: ManagerState): void {
    clearTimeout(this.timers.get(state.id));
    const remaining = state.startedAt + state.limits.wallMs - this.now();
    this.timers.set(state.id, setTimeout(() => this.background(state.id, async () => {
      const current = this.get(state.id); await this.checkLimits(current);
    }), Math.max(0, Math.min(remaining + 1, 2_147_483_647))));
  }
  private async checkLimits(state: ManagerState): Promise<boolean> {
    if (state.status !== 'running') return false;
    const reason = state.turns > state.limits.turns ? 'turn limit' : state.turnsWithoutDecision > state.limits.turnsWithoutDecision
      ? 'turns without a decision limit' : this.now() - state.startedAt > state.limits.wallMs ? 'wall-clock limit' : null;
    if (!reason) { this.armDeadline(state); return false; }
    try { await this.stopInternal(state.id); }
    catch (error) { this.error(error); }
    this.inbox.deliver({ managerId: state.supermanager, kind: 'round-limit', summary: `Manager ${state.id} paused after exceeding its ${reason}.` });
    return true;
  }
  private async pauseRemote(state: ManagerState): Promise<void> {
    if (state.engine === 'codex' && state.threadId) {
      const client = await this.client(state.pool);
      await client.request('thread/goal/set', { threadId: state.threadId, status: 'paused', origin: 'user' });
      if (state.activeTurnId) {
        try { await client.request('turn/interrupt', { threadId: state.threadId, turnId: state.activeTurnId }); }
        catch {
          const resumed = await client.request('thread/resume', { threadId: state.threadId });
          const active = resumed.thread.turns?.findLast((turn: any) => turn.status === 'inProgress');
          if (active) await client.request('turn/interrupt', { threadId: state.threadId, turnId: active.id });
        }
      }
    }
  }
  private async stopInternal(id: string): Promise<void> {
    const state = this.get(id); state.status = 'paused'; this.save(state);
    clearTimeout(this.timers.get(id));
    try { await this.pauseRemote(state); } finally { this.services.windows.unregister(id); }
  }
  stop(id: string): Promise<void> { return this.serial(id, () => this.stopInternal(id)); }

  private async dispatch(id: string): Promise<void> {
    let state = this.get(id);
    if (state.status !== 'running' || state.engine !== 'codex') return;
    const client = await this.client(state.pool);
    for (const event of this.inbox.notifications(id)) {
      state = this.get(id);
      if (state.activeTurnId) {
        try {
          await client.request('turn/steer', { threadId: state.threadId, expectedTurnId: state.activeTurnId, input: textInput(event.event.summary) });
        } catch (error) {
          // A completion can race the steer precondition. Rejoin to learn the live turn, then start/steer.
          const resumed = await client.request('thread/resume', { threadId: state.threadId });
          const active = resumed.thread.turns?.findLast((turn: any) => turn.status === 'inProgress');
          state.activeTurnId = active?.id ?? null; this.save(state);
          if (active) await client.request('turn/steer', { threadId: state.threadId, expectedTurnId: active.id, input: textInput(event.event.summary) });
          else await this.startWakeTurn(client, state, event.event.summary);
        }
      } else await this.startWakeTurn(client, state, event.event.summary);
      this.inbox.notified(event.id);
    }
  }
  private async startWakeTurn(client: AppServer, state: ManagerState, summary: string): Promise<void> {
    const turn = await client.request('turn/start', { threadId: state.threadId, input: textInput(summary) });
    this.turnStarted(state, turn.turn.id); this.save(state);
  }
  async wake(id: string): Promise<void> { return this.serial(id, () => this.dispatch(id)); }

  private async completeInternal(id: string): Promise<boolean> {
    const state = this.get(id);
    const evidence = await this.services.checkCompletion(state.goal);
    this.inbox.record(id, { kind: 'completion-check', ...evidence });
    if (!evidence.passed) {
      // A model-completed Codex goal must become active before the unmet event starts a new turn.
      if (state.engine === 'codex' && state.threadId && state.goalState?.status === 'complete') {
        const client = await this.client(state.pool);
        const updated = await client.request('thread/goal/set', { threadId: state.threadId, status: 'active', origin: 'user' });
        state.goalState = updated.goal; this.save(state);
      }
      this.inbox.deliver({ managerId: id, kind: 'goal-unmet', summary: evidence.summary.replace(/[\r\n]+/g, ' '), evidencePath: evidence.evidencePath });
      return false;
    }
    await this.stopInternal(id);
    const completed = this.get(id); completed.status = 'complete';
    if (completed.engine === 'codex' && completed.threadId) {
      const client = await this.client(completed.pool);
      const updated = await client.request('thread/goal/set', { threadId: completed.threadId, status: 'complete', origin: 'user' });
      completed.goalState = updated.goal;
    }
    this.save(completed);
    return true;
  }
  complete(id: string): Promise<boolean> { return this.serial(id, () => this.completeInternal(id)); }

  /** Rejoin persisted threads on host restart and retry committed, unsignalled inbox deliveries. */
  async recover(): Promise<void> {
    for (const state of this.list().filter(state => state.status === 'running' || state.status === 'starting')) {
      await this.serial(state.id, async () => {
        if (state.engine === 'codex' && state.threadId) {
          const client = await this.client(state.pool);
          const resumed = await client.request('thread/resume', { threadId: state.threadId });
          state.activeTurnId = resumed.thread.turns?.findLast((turn: any) => turn.status === 'inProgress')?.id ?? null;
          const goal = await client.request('thread/goal/get', { threadId: state.threadId });
          state.goalState = goal.goal;
        }
        if (state.status === 'starting') { state.status = 'paused'; this.save(state); await this.pauseRemote(state); return; }
        this.save(state);
        if (!await this.checkLimits(state)) {
          if (state.goalState?.status === 'complete') await this.completeInternal(state.id);
          else await this.dispatch(state.id);
        }
      });
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; this.watcher.close();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    for (const timer of this.timers.values()) clearTimeout(timer);
    await this.flush();
    for (const client of this.pools.values()) { try { (await client).close(); } catch {} }
  }
}
