import type { ControlPolicy } from './policy.ts';
import defaults from '../defaults.json';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { AppServer, CodexPool, Notification } from './app-server.ts';
import { connectPool, textInput } from './app-server.ts';
import { agentEnvironmentKeys } from './agents.ts';
import type { ManagerServices, ManagerSpec, GoalState, ManagerTurnDisposition } from './managers.ts';
import type { ProcessIdentity } from './process.ts';

// Managers run with full access, like workers; the maintainer is not there to answer approval requests.
const FULL_ACCESS = { approvalPolicy: 'never', sandbox: 'danger-full-access' } as const;
const CODEX_MANAGER_MODEL = 'gpt-6.1-sol';

function codexThreadConfig(spec: Pick<ManagerSpec, 'effort' | 'compactTokens'>) {
  return {
    model_reasoning_effort: spec.effort,
    model_auto_compact_token_limit: spec.compactTokens ?? defaults.integration.managerCompactTokens,
  };
}

type CodexTurnSpec = Pick<ManagerSpec, 'id' | 'model' | 'effort'>;
type CodexThreadSpec = CodexTurnSpec & Pick<ManagerSpec, 'compactTokens'>;

/** `ThreadGoalSetParams` from installed `codex-cli 0.169`; no idle-continuation field is acknowledged. */
function activeGoalSet(threadId: string, spec: Pick<ManagerSpec, 'objective' | 'budget'>) {
  return {
    threadId,
    origin: 'user' as const,
    objective: spec.objective,
    status: 'active' as const,
    tokenBudget: spec.budget,
  };
}

function threadAccess(spec: CodexThreadSpec, threadId: string, model: string) {
  return {
    ...FULL_ACCESS,
    threadId,
    model,
    config: codexThreadConfig(spec),
  };
}

function activeTurnId(resumed: { thread: { turns?: { id: string; status: string }[] } }): string | null {
  return resumed.thread.turns?.findLast((turn) => turn.status === 'inProgress')?.id ?? null;
}

export type SessionTurnDelivery = { kind: 'steered' } | { kind: 'started'; turnId: string };
export type GoalMutationOrigin = 'user' | 'automatic';

/** The 0.169 protocol carries item origin as a ThreadItem discriminant, not its text. */
export function userMessageTurn(notification: Notification): { threadId: string; turnId: string } | null {
  if (notification.method !== 'item/started' && notification.method !== 'item/completed') return null;
  const params = notification.params;
  if (
    !params ||
    typeof params.threadId !== 'string' ||
    !params.threadId ||
    typeof params.turnId !== 'string' ||
    !params.turnId ||
    params.item?.type !== 'userMessage'
  )
    return null;
  return { threadId: params.threadId, turnId: params.turnId };
}

function userMessageItem(item: unknown): boolean {
  return Boolean(
    item && typeof item === 'object' && !Array.isArray(item) && (item as { type?: unknown }).type === 'userMessage',
  );
}

const THREAD_ITEM_TYPES = new Set([
  'userMessage',
  'hookPrompt',
  'agentMessage',
  'functionCallOutput',
  'plan',
  'reasoning',
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'subAgentActivity',
  'webSearch',
  'imageView',
  'sleep',
  'imageGeneration',
  'enteredReviewMode',
  'exitedReviewMode',
  'contextCompaction',
]);

/** Provider-facing manager sessions: connection cache, concrete Codex/Claude requests and viewer argv. */
export class ManagerSessionTransport {
  private pools = new Map<string, Promise<AppServer>>();
  private readonly observedThreads = new WeakMap<AppServer, Map<string, string>>();
  private observeThread(client: AppServer, manager: string, threadId: string): void {
    const observed = this.observedThreads.get(client) ?? new Map<string, string>();
    observed.set(manager, threadId);
    this.observedThreads.set(client, observed);
  }
  private unsubscribers: (() => void)[] = [];
  constructor(
    private readonly services: ManagerServices,
    private readonly appServerPolicy: ControlPolicy['appServer'],
    private readonly stateDirectory: string,
    private readonly onNotification: (notification: Notification) => void,
  ) {}
  private model(spec: Pick<ManagerSpec, 'id' | 'model'>): string {
    return this.services.codexManagerModel?.(spec.id) ?? spec.model ?? CODEX_MANAGER_MODEL;
  }
  client(pool: CodexPool): Promise<AppServer> {
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
      : connectPool(pool, onStart, undefined, this.appServerPolicy);
    const client = connecting.then(async (server) => {
      try {
        if (server.identity) onStart(server.identity);
      } catch (error) {
        await server.close();
        throw error;
      }
      this.unsubscribers.push(server.onNotification((notification) => this.onNotification(notification)));
      return server;
    });
    this.pools.set(key, client);
    void client.catch(() => this.pools.delete(key));
    return client;
  }
  async applyModelOverride(client: AppServer, spec: CodexTurnSpec, threadId: string): Promise<void> {
    const model = this.services.codexManagerModel?.(spec.id) ?? spec.model;
    if (model === undefined) return;
    await client.request('thread/settings/update', { threadId, model, effort: spec.effort });
  }
  async startThread(client: AppServer, spec: CodexThreadSpec & Pick<ManagerSpec, 'cwd'>): Promise<string> {
    const started = await client.request('thread/start', {
      ...FULL_ACCESS,
      cwd: spec.cwd,
      model: this.model(spec),
      config: codexThreadConfig(spec),
    });
    const threadId = started.thread.id as string;
    this.observeThread(client, spec.id, threadId);
    return threadId;
  }
  async setActiveGoal(
    client: AppServer,
    spec: Pick<ManagerSpec, 'objective' | 'budget'>,
    threadId: string,
  ): Promise<GoalState> {
    const goal = await client.request('thread/goal/set', activeGoalSet(threadId, spec));
    return goal.goal;
  }
  async setGoalStatus(
    client: AppServer,
    threadId: string,
    status: 'paused' | 'active' | 'complete',
    origin: GoalMutationOrigin,
  ): Promise<GoalState> {
    const goal = await client.request('thread/goal/set', { threadId, status, origin });
    return goal.goal;
  }
  async getGoal(client: AppServer, threadId: string): Promise<GoalState | null> {
    const goal = await client.request('thread/goal/get', { threadId });
    return goal.goal;
  }
  async startTurn(
    client: AppServer,
    spec: CodexTurnSpec,
    threadId: string,
    prompt: string,
  ): Promise<string> {
    const turn = await client.request('turn/start', {
      threadId,
      model: this.model(spec),
      effort: spec.effort,
      input: textInput(prompt),
    });
    return turn.turn.id;
  }
  /** A viewer or preceding host can have loaded the thread without subscribing this connection. */
  async rejoinForDelivery(client: AppServer, spec: CodexThreadSpec, threadId: string) {
    if (this.observedThreads.get(client)?.get(spec.id) === threadId) return;
    return this.resumeThread(client, spec, threadId);
  }
  async resumeThread(
    client: AppServer,
    spec: CodexThreadSpec,
    threadId: string,
  ): Promise<{
    activeTurnId: string | null;
    latestTurn?: { id: string; status: ManagerTurnDisposition['status'] };
  }> {
    const resumed = await client.request('thread/resume', threadAccess(spec, threadId, this.model(spec)));
    this.observeThread(client, spec.id, threadId);
    const latest = resumed.thread.turns?.at(-1);
    const status = latest?.status;
    const latestTurn =
      latest && (status === 'inProgress' || status === 'completed' || status === 'interrupted' || status === 'failed')
        ? { id: latest.id as string, status: status as ManagerTurnDisposition['status'] }
        : undefined;
    return {
      activeTurnId: activeTurnId(resumed),
      ...(latestTurn ? { latestTurn } : {}),
    };
  }
  async turnHasUserMessage(client: AppServer, threadId: string, turnId: string): Promise<boolean> {
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    for (;;) {
      const response = await client.request<unknown>('thread/items/list', {
        threadId,
        turnId,
        limit: 100,
        sortDirection: 'asc',
        ...(cursor ? { cursor } : {}),
      });
      if (!response || typeof response !== 'object' || Array.isArray(response))
        throw new Error('Invalid thread/items/list response for manager turn');
      const page = response as { data?: unknown; nextCursor?: unknown; backwardsCursor?: unknown };
      if (!Array.isArray(page.data)) throw new Error('Invalid thread/items/list data for manager turn');
      if (page.backwardsCursor !== null && (typeof page.backwardsCursor !== 'string' || !page.backwardsCursor))
        throw new Error('Invalid thread/items/list backwards cursor for manager turn');
      for (const entry of page.data) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
          throw new Error('Invalid thread/items/list entry for manager turn');
        const itemEntry = entry as { turnId?: unknown; item?: unknown };
        if (typeof itemEntry.turnId !== 'string' || !itemEntry.turnId)
          throw new Error('Invalid thread/items/list turn identity for manager turn');
        if (itemEntry.turnId !== turnId) throw new Error('Mismatched thread/items/list turn identity for manager turn');
        const item = itemEntry.item;
        const type =
          item && typeof item === 'object' && !Array.isArray(item) ? (item as { type?: unknown }).type : null;
        if (typeof type !== 'string' || !THREAD_ITEM_TYPES.has(type))
          throw new Error('Invalid thread/items/list item type for manager turn');
        if (userMessageItem(item)) return true;
      }
      if (page.nextCursor === null) return false;
      if (typeof page.nextCursor !== 'string' || !page.nextCursor || seenCursors.has(page.nextCursor))
        throw new Error('Invalid thread/items/list cursor for manager turn');
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }
  private async steer(client: AppServer, threadId: string, expectedTurnId: string, summary: string): Promise<void> {
    await client.request('turn/steer', {
      threadId,
      expectedTurnId,
      input: textInput(summary),
    });
  }
  private async startWakeTurn(
    client: AppServer,
    spec: CodexThreadSpec,
    threadId: string,
    summary: string,
    persistActiveTurn: (turnId: string | null) => void,
  ): Promise<SessionTurnDelivery> {
    const start = () => this.startTurn(client, spec, threadId, summary);
    try {
      return { kind: 'started', turnId: await start() };
    } catch {
      // A replaced app-server has not loaded the thread, or a turn began meanwhile: rejoin it, then start or steer.
      const { activeTurnId } = await this.resumeThread(client, spec, threadId);
      if (activeTurnId) {
        persistActiveTurn(activeTurnId);
        await this.steer(client, threadId, activeTurnId, summary);
        return { kind: 'steered' };
      }
      return { kind: 'started', turnId: await start() };
    }
  }
  async deliverToSession(
    client: AppServer,
    spec: CodexThreadSpec,
    threadId: string,
    activeTurnId: string | null,
    summary: string,
    persistActiveTurn: (turnId: string | null) => void,
  ): Promise<SessionTurnDelivery> {
    if (activeTurnId) {
      // turn/steer has no model or effort fields, so active turns inherit the settings pinned at turn/start.
      try {
        await this.steer(client, threadId, activeTurnId, summary);
        return { kind: 'steered' };
      } catch {
        // A completion can race the steer precondition. Rejoin to learn the live turn, then start/steer.
        const resumed = await this.resumeThread(client, spec, threadId);
        persistActiveTurn(resumed.activeTurnId);
        if (resumed.activeTurnId) {
          await this.steer(client, threadId, resumed.activeTurnId, summary);
          return { kind: 'steered' };
        }
        return this.startWakeTurn(client, spec, threadId, summary, persistActiveTurn);
      }
    }
    return this.startWakeTurn(client, spec, threadId, summary, persistActiveTurn);
  }
  async interruptTurn(
    client: AppServer,
    spec: CodexThreadSpec,
    threadId: string,
    turnId: string,
    beforeInterrupt: (turnId: string) => void,
  ): Promise<void> {
    beforeInterrupt(turnId);
    try {
      await client.request('turn/interrupt', { threadId, turnId });
    } catch {
      const { activeTurnId } = await this.resumeThread(client, spec, threadId);
      if (activeTurnId) {
        beforeInterrupt(activeTurnId);
        await client.request('turn/interrupt', { threadId, turnId: activeTurnId });
      }
    }
  }
  async interruptExactTurn(
    client: AppServer,
    threadId: string,
    turnId: string,
    beforeInterrupt: (turnId: string) => void,
  ): Promise<void> {
    beforeInterrupt(turnId);
    await client.request('turn/interrupt', { threadId, turnId });
  }
  async registerCodexViewer(
    spec: Pick<ManagerSpec, 'id' | 'pool' | 'cwd' | 'model' | 'effort'>,
    threadId: string,
    client: AppServer,
  ): Promise<void> {
    await this.services.windows.register(spec.id, this.codexViewerArgv(spec, threadId, client), spec.cwd);
  }
  async rebindCodexViewer(
    spec: Pick<ManagerSpec, 'id' | 'pool' | 'cwd' | 'model' | 'effort'>,
    threadId: string,
    client: AppServer,
    options: { restoreExited?: boolean } = {},
  ): Promise<boolean> {
    if (!client.endpoint || !this.services.windows.rebindIfStale) return false;
    return this.services.windows.rebindIfStale(
      spec.id,
      this.codexViewerArgv(spec, threadId, client),
      spec.cwd,
      options,
    );
  }
  private codexViewerArgv(spec: Pick<ManagerSpec, 'id' | 'pool' | 'model' | 'effort'>, threadId: string, client: AppServer): string[] {
    const viewer = [spec.pool.executable ?? 'codex', 'resume', threadId];
    if (client.endpoint) viewer.push('--remote', client.endpoint);
    return [
      'env',
      ...this.providerBoundaryUnsets(),
      `CODEX_HOME=${spec.pool.codexHome}`,
      `GOAL_MANAGER=${spec.id}`,
      ...viewer,
    ];
  }
  async registerClaudeSession(spec: ManagerSpec, sessionId: string, prompt: string): Promise<void> {
    await this.services.windows.register(
      spec.id,
      this.claudeArgv(spec, ['--session-id', sessionId], this.openingPointer(spec, prompt)),
      spec.cwd,
    );
  }
  async reviveClaude(
    spec: ManagerSpec,
    sessionId: string,
    pending: boolean,
    waking: { id: number }[],
  ): Promise<number[]> {
    if (!pending) return [];
    const alive = await this.services.windows.alive?.(spec.id);
    if (alive === false) {
      await this.services.windows.respawn?.(
        spec.id,
        this.claudeArgv(
          spec,
          ['--resume', sessionId],
          'The control plane resumed your exited session. Read and acknowledge your inbox, then continue.',
        ),
        spec.cwd,
      );
      return [];
    }
    // A live session that ended its turn without a watcher never wakes on its own (web sat 2 h on 13 unread events on
    // 2026-10-26): type the wake into it, once per event.
    if (!waking.length || !this.services.windows.prompt) return [];
    await this.services.windows.prompt(
      spec.id,
      `${waking.length} new inbox event(s): read them with bun tools/goal/src/cli.ts inbox read ${spec.id}, act and acknowledge; start bun tools/goal/src/cli.ts inbox wait ${spec.id} in the background before you end the turn.`,
    );
    return waking.map((event) => event.id);
  }
  // The opening goes to a file, not argv: the CLI process would otherwise match a `pgrep -f` for any command the
  // opening names, and a manager that stopped its inbox watcher by pattern once killed its own session that way.
  private openingPointer(spec: Pick<ManagerSpec, 'id'>, prompt: string): string {
    const path = join(this.stateDirectory, 'managers', `${spec.id}.opening.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, prompt);
    return `Read ${path} completely and follow it.`;
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
  unsubscribe(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
  }
  async close(): Promise<void> {
    for (const client of this.pools.values()) {
      try {
        await (await client).close();
      } catch {}
    }
    this.pools.clear();
  }
}
