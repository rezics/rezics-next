import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { historicalManager } from '../test-support/historical-manager.ts';
import { StdioAppServer, type Notification } from './app-server.ts';
import { openDb } from './db.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { runIntegration, type IntegrationRuntime } from './integration-cli.ts';
import { ManagerSessions, type ManagerSpec } from './managers.ts';
import { temporaryDirectory } from './test-support.ts';

async function setup() {
  const temporary = temporaryDirectory();
  const db = openDb(join(temporary.path, 'state.sqlite'));
  const log = join(temporary.path, 'rpc.jsonl');
  const codexHome = join(temporary.path, 'codex-home');
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, 'config.toml'), 'model = "gpt-6.1-terra"\nmodel_reasoning_effort = "low"\n');
  const client = new StdioAppServer([process.execPath, join(import.meta.dir, 'fixtures/fake-app-server.ts')], {
    ...process.env,
    CODEX_HOME: codexHome,
    FAKE_RPC_LOG: log,
  });
  await client.initialize();
  const inbox = new SqliteManagerInbox(db, temporary.path);
  const windows: { manager: string; argv: string[] }[] = [];
  const removed: string[] = [];
  const services = {
    connect: async () => client,
    windows: {
      register(manager: string, argv: string[]) {
        windows.push({ manager, argv });
        return `@${windows.length}`;
      },
      unregister(manager: string) {
        removed.push(manager);
      },
    },
    checkCompletion: async () => ({
      passed: false,
      evidencePath: join(temporary.path, 'completion.log'),
      summary: 'Some tasks remain',
    }),
    command: ['goal'],
    onError: (error: unknown) => {
      throw error;
    },
  };
  const managers = new ManagerSessions(db, inbox, services);
  const spec: ManagerSpec = {
    id: 'manager',
    goal: 'refactor',
    objective: 'Finish the refactor',
    brief: 'Manage this scope',
    cwd: temporary.path,
    engine: 'codex',
    pool: { id: 'sol', codexHome },
    budget: 40000,
    effort: 'high',
    supermanager: 'supervisor',
    limits: { turns: 20, turnsWithoutDecision: 10, wallMs: 3_600_000 },
  };
  const requests = () =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  const notify = async (notification: Notification) => {
    await client.request('test/notify', notification);
    await managers.flush();
  };
  async function recoverSession() {
    const threadId = randomUUID();
    const { goal } = await client.request('thread/goal/set', {
      threadId,
      objective: spec.objective,
      status: 'active',
      tokenBudget: spec.budget,
    });
    const { turn } = await client.request<{ turn: { id: string } }>('turn/start', { threadId, input: [] });
    const state = historicalManager(db, temporary.path, {
      ...spec,
      threadId,
      status: 'running',
      activeTurnId: turn.id,
      countedTurn: turn.id,
      turnDisposition: { threadId, turnId: turn.id, at: Date.now(), status: 'inProgress', intent: 'work' },
      goalState: goal,
      continuationAsked: false,
      continuationRenewed: false,
    });
    await managers.recover();
    await managers.flush();
    return { ...state, threadId, activeTurnId: turn.id };
  }

  function publicRenew(id: string) {
    const runtime: IntegrationRuntime = {
      db,
      mainCheckout: temporary.path,
      stateDirectory: temporary.path,
      worktreeRoot: join(temporary.path, 'worktrees'),
      managerSocket: join(temporary.path, 'manager.sock'),
      inbox,
      fence: {} as IntegrationRuntime['fence'],
      sink: {} as IntegrationRuntime['sink'],
      landing: () => ({}) as ReturnType<IntegrationRuntime['landing']>,
      manager: () => spec,
      managerServices: services,
    };
    return runIntegration(['manager', 'renew', id], runtime);
  }
  return {
    ...temporary,
    db,
    client,
    inbox,
    managers,
    windows,
    removed,
    services,
    spec,
    requests,
    notify,
    recoverSession,
    publicRenew,
    async close() {
      try {
        await managers.close();
      } finally {
        await client.close();
        db.close();
        temporary.close();
      }
    },
  };
}

test('historical Codex recovery pins model and effort through active steer and idle wake', async () => {
  const s = await setup();
  try {
    expect(readFileSync(join(s.spec.pool.codexHome, 'config.toml'), 'utf8')).toContain(
      'model = "gpt-6.1-terra"\nmodel_reasoning_effort = "low"',
    );
    const manager = await s.recoverSession();
    await s.managers.flush();

    const resumed = s.requests().find((request) => request.method === 'thread/resume');
    expect(resumed!.params).toEqual({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      threadId: manager.threadId,
      model: 'gpt-6.1-sol',
      config: { model_reasoning_effort: 'high', model_auto_compact_token_limit: 300000 },
    });

    s.inbox.deliver({ managerId: manager.id, kind: 'instruction', summary: 'Resolve the conflict' });
    await s.managers.wake(manager.id);
    const steer = s.requests().find((request) => request.method === 'turn/steer');
    expect(steer!.params.expectedTurnId).toBe(manager.activeTurnId);
    expect(steer!.params.input).toEqual([{ type: 'text', text: 'Resolve the conflict', text_elements: [] }]);
    expect(steer!.params).not.toHaveProperty('model');
    expect(steer!.params).not.toHaveProperty('effort');

    await s.notify({
      method: 'turn/completed',
      params: { threadId: manager.threadId, turn: { id: manager.activeTurnId, status: 'completed' } },
    });
    expect(s.managers.get(manager.id).activeTurnId).toBeNull();
    s.inbox.deliver({ managerId: manager.id, kind: 'spec-conflict', summary: 'Choose a contract' });
    await s.managers.wake(manager.id);

    const turnStarts = s.requests().filter((request) => request.method === 'turn/start');
    expect(turnStarts).toHaveLength(2);
    expect(turnStarts[1]!.params).toMatchObject({ threadId: manager.threadId, model: 'gpt-6.1-sol', effort: 'high' });
    expect(s.managers.get(manager.id).activeTurnId).toBe('turn-2');
    expect(s.inbox.notifications(manager.id)).toHaveLength(0);
  } finally {
    await s.close();
  }
});

test('a steer racing a completed turn resumes and starts the next turn with pinned settings', async () => {
  const s = await setup();
  try {
    const manager = await s.recoverSession();
    await s.managers.flush();
    // Let the server's completion notification settle before restoring the stale turn observation.
    await s.client.request('turn/interrupt', { threadId: manager.threadId, turnId: manager.activeTurnId });
    await s.managers.flush();
    s.db.query('UPDATE manager_sessions SET state = ? WHERE id = ?').run(JSON.stringify(manager), manager.id);
    s.inbox.deliver({ managerId: manager.id, kind: 'instruction', summary: 'Wake after the race' });
    await s.managers.wake(manager.id);
    await s.managers.flush();

    const resumed = s.requests().filter((request) => request.method === 'thread/resume');
    expect(resumed).toHaveLength(2);
    expect(resumed[1]!.params.threadId).toBe(manager.threadId);
    expect(resumed[1]!.params.model).toBe('gpt-6.1-sol');
    expect(resumed[1]!.params.config.model_reasoning_effort).toBe('high');
    const turnStarts = s.requests().filter((request) => request.method === 'turn/start');
    expect(turnStarts[1]!.params).toMatchObject({ threadId: manager.threadId, model: 'gpt-6.1-sol', effort: 'high' });
    expect(s.inbox.notifications(manager.id)).toHaveLength(0);
    expect(s.managers.get(manager.id).activeTurnId).toBe('turn-2');
  } finally {
    await s.close();
  }
});

test('stopping a Codex manager and refusing public renewal preserve the thread, budget, usage and inbox', async () => {
  const s = await setup();
  try {
    const first = await s.recoverSession();
    await s.client.request('thread/goal/set', {
      threadId: first.threadId,
      status: 'active',
      tokensUsed: 1234,
      timeUsedSeconds: 90,
      tokenBudget: s.spec.budget,
    });
    await s.notify({
      method: 'thread/tokenUsage/updated',
      params: { threadId: first.threadId, tokenUsage: { total: { totalTokens: 2345, cachedInputTokens: 1900 } } },
    });
    await s.managers.stop(first.id);
    await s.managers.flush();
    s.inbox.deliver({ managerId: first.id, kind: 'instruction', summary: 'Keep this unread decision' });

    const stopped = s.managers.get(first.id);
    expect(stopped).toMatchObject({
      id: first.id,
      status: 'paused',
      threadId: first.threadId,
      activeTurnId: null,
      budget: s.spec.budget,
      limits: s.spec.limits,
      goalState: { status: 'paused', tokensUsed: 1234, timeUsedSeconds: 90, tokenBudget: s.spec.budget },
      usage: { total: { totalTokens: 2345, cachedInputTokens: 1900 } },
      turnDisposition: { turnId: first.activeTurnId, status: 'interrupted', intent: 'controller-stop' },
    });
    expect(s.removed).toEqual([first.id]);

    const requests = s.requests();
    await expect(s.publicRenew(first.id)).rejects.toThrow('Managed manager launches and assignments are retired');
    await s.managers.wake(first.id);
    await s.managers.recover();
    await s.managers.flush();

    expect(s.managers.get(first.id)).toEqual(stopped);
    expect(s.requests()).toEqual(requests);
    expect(s.inbox.notifications(first.id)).toHaveLength(1);
    expect(s.inbox.pending(first.id).map(({ event }) => event.summary)).toEqual(['Keep this unread decision']);
  } finally {
    await s.close();
  }
});

test('a historical continuation requires fresh bounded progress and the configured recipient', async () => {
  const s = await setup();
  try {
    const first = await s.recoverSession();
    const directory = join(s.path, '.temp', 'goal', first.id);
    const continuationPath = join(directory, 'CONTINUATION.md');
    mkdirSync(directory, { recursive: true });
    const oldProgress = '- Next action: Review the existing checkpoint.\n';
    writeFileSync(continuationPath, oldProgress);
    await s.notify({
      method: 'thread/goal/updated',
      params: {
        threadId: first.threadId,
        goal: { status: 'active', tokensUsed: 37000, timeUsedSeconds: 80, tokenBudget: s.spec.budget },
      },
    });
    const checkpoint = s.managers.get(first.id);
    expect(checkpoint).toMatchObject({
      continuationAsked: true,
      continuationRenewed: false,
      continuationThreadId: first.threadId,
    });

    const requests = s.requests();
    const freshProgress = '- Result: Recorded a concrete decision for the active scope.\n';
    for (const markdown of [oldProgress, `Updated heading\n${oldProgress}`, freshProgress + 'x'.repeat(8001)]) {
      writeFileSync(continuationPath, markdown);
      await s.managers.outgoingMessage(first.id, s.spec.supermanager, 'continuation written');
      expect(s.managers.get(first.id)).toEqual(checkpoint);
    }
    writeFileSync(continuationPath, freshProgress);
    await s.managers.outgoingMessage(first.id, 'other-manager', 'continuation written');
    expect(s.managers.get(first.id)).toEqual(checkpoint);
    expect(s.inbox.pending(s.spec.supermanager)).toEqual([]);
    expect(s.requests()).toEqual(requests);
  } finally {
    await s.close();
  }
});

test('public renewal refuses a stopped Claude manager without replacing its provider session', async () => {
  const s = await setup();
  try {
    const first = historicalManager(s.db, s.path, { ...s.spec, engine: 'claude', status: 'running' });
    await s.managers.stop(first.id);
    const stopped = s.managers.get(first.id);
    expect(stopped).toMatchObject({ engine: 'claude', status: 'paused', threadId: first.threadId });
    expect(s.removed).toEqual([first.id]);

    await expect(s.publicRenew(first.id)).rejects.toThrow('Managed manager launches and assignments are retired');
    expect(s.managers.get(first.id)).toEqual(stopped);
    expect(s.windows).toEqual([]);
    expect(s.removed).toEqual([first.id]);
    expect(s.requests().filter((request) => request.method.startsWith('thread/'))).toEqual([]);
  } finally {
    await s.close();
  }
});

test('renewing a running manager is refused without stopping its session', async () => {
  const s = await setup();
  try {
    const running = await s.recoverSession();
    const before = s.managers.get(running.id);
    const requests = s.requests();
    await expect(s.managers.renew(running.id, s.spec)).rejects.toThrow('Manager must be paused to renew');
    await expect(s.publicRenew(running.id)).rejects.toThrow('Managed manager launches and assignments are retired');
    expect(s.managers.get(running.id)).toEqual(before);
    expect(s.requests()).toEqual(requests);
    expect(s.managers.get(running.id)).toMatchObject({ status: 'running', threadId: running.threadId });
    expect(s.removed).toHaveLength(0);
    await s.managers.stop(running.id);
  } finally {
    await s.close();
  }
});
