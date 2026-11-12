import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StdioAppServer, type Notification } from './app-server.ts';
import { openDb } from './db.ts';
import { SqliteManagerInbox } from './inbox.ts';
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
  let now = Date.now();
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
    now: () => now,
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
    advance(ms: number) {
      now += ms;
    },
    async close() {
      await managers.close();
      db.close();
      temporary.close();
    },
  };
}

test('Codex turn boundaries pin model and effort through active steer and idle wake', async () => {
  const s = await setup();
  try {
    expect(readFileSync(join(s.spec.pool.codexHome, 'config.toml'), 'utf8')).toContain(
      'model = "gpt-6.1-terra"\nmodel_reasoning_effort = "low"',
    );
    const manager = await s.managers.start(s.spec);
    await s.managers.flush();

    const threadStart = s.requests().find((request) => request.method === 'thread/start');
    expect(threadStart!.params).toEqual({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      cwd: s.path,
      model: 'gpt-6.1-sol',
      config: { model_reasoning_effort: 'high', model_auto_compact_token_limit: 300000 },
    });
    const openingTurn = s.requests().find((request) => request.method === 'turn/start');
    expect(openingTurn!.params).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high' });

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
    expect(turnStarts[1]!.params).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high' });
    expect(s.managers.get(manager.id).activeTurnId).toBe('turn-2');
    expect(s.inbox.notifications(manager.id)).toHaveLength(0);
  } finally {
    await s.close();
  }
});

test('a steer racing a completed turn resumes and starts the next turn with pinned settings', async () => {
  const s = await setup();
  try {
    const manager = await s.managers.start(s.spec);
    await s.managers.flush();
    // Let the server's completion notification settle before restoring the stale turn observation.
    await s.client.request('turn/interrupt', { threadId: manager.threadId, turnId: manager.activeTurnId });
    await s.managers.flush();
    s.db.query('UPDATE manager_sessions SET state = ? WHERE id = ?').run(JSON.stringify(manager), manager.id);
    s.inbox.deliver({ managerId: manager.id, kind: 'instruction', summary: 'Wake after the race' });
    await s.managers.wake(manager.id);
    await s.managers.flush();

    const resumed = s.requests().find((request) => request.method === 'thread/resume');
    expect(resumed!.params.model).toBe('gpt-6.1-sol');
    expect(resumed!.params.config.model_reasoning_effort).toBe('high');
    const turnStarts = s.requests().filter((request) => request.method === 'turn/start');
    expect(turnStarts[1]!.params).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high' });
    expect(s.inbox.notifications(manager.id)).toHaveLength(0);
    expect(s.managers.get(manager.id).activeTurnId).toBe('turn-2');
  } finally {
    await s.close();
  }
});

test('renewing a paused Codex manager starts a fresh thread under the same id and keeps its inbox', async () => {
  const s = await setup();
  try {
    const first = await s.managers.start(s.spec);
    await s.managers.noteCommand(first.id);
    await s.notify({
      method: 'turn/completed',
      params: { threadId: first.threadId, turn: { id: first.activeTurnId, status: 'completed' } },
    });
    s.inbox.deliver({ managerId: first.id, kind: 'instruction', summary: 'An unread decision' });
    await s.managers.wake(first.id);
    await s.client.request('thread/goal/set', {
      threadId: first.threadId,
      status: 'active',
      tokensUsed: 1234,
      timeUsedSeconds: 90,
      tokenBudget: s.spec.budget,
    });
    await s.managers.flush();
    await s.notify({
      method: 'thread/tokenUsage/updated',
      params: { threadId: first.threadId, tokenUsage: { total: { totalTokens: 2345, cachedInputTokens: 1900 } } },
    });
    const paused = s.managers.get(first.id);
    paused.status = 'paused';
    s.db.query('UPDATE manager_sessions SET state = ? WHERE id = ?').run(JSON.stringify(paused), first.id);
    s.inbox.deliver({ managerId: first.id, kind: 'instruction', summary: 'Keep this decision for the new session' });

    const limits = { turns: 8, turnsWithoutDecision: 3, wallMs: 600_000 };
    const renewed = await s.managers.renew(first.id, { ...s.spec, budget: 25000, limits });
    await s.managers.flush();

    expect(renewed).toMatchObject({
      id: first.id,
      status: 'running',
      threadId: 'thread-2',
      budget: 25000,
      limits,
      turns: 1,
      turnsWithoutDecision: 0,
      goalState: { status: 'active', tokensUsed: 0, tokenBudget: 25000 },
      usage: null,
    });
    expect(renewed.history).toHaveLength(1);
    expect(renewed.history?.[0]).toMatchObject({
      threadId: first.threadId,
      status: 'paused',
      turns: 2,
      goalState: { tokensUsed: 1234 },
      usage: { total: { totalTokens: 2345, cachedInputTokens: 1900 } },
    });
    expect(s.removed).toContain(first.id);
    expect(
      s.requests().some((request) => request.method === 'turn/interrupt' && request.params.threadId === first.threadId),
    ).toBe(true);
    expect(s.requests().filter((request) => request.method === 'thread/start')).toHaveLength(2);
    const threadStarts = s.requests().filter((request) => request.method === 'thread/start');
    expect(threadStarts.map((request) => request.params.model)).toEqual(['gpt-6.1-sol', 'gpt-6.1-sol']);
    expect(threadStarts.map((request) => request.params.config.model_reasoning_effort)).toEqual(['high', 'high']);
    const turnStarts = s.requests().filter((request) => request.method === 'turn/start');
    expect(turnStarts.map((request) => request.params.threadId)).toEqual(['thread-1', 'thread-1', 'thread-2']);
    expect(
      turnStarts.every((request) => request.params.model === 'gpt-6.1-sol' && request.params.effort === 'high'),
    ).toBe(true);
    expect(
      s
        .requests()
        .some(
          (request) =>
            request.method === 'turn/steer' &&
            request.params.threadId === renewed.threadId &&
            request.params.input[0]?.text === 'Keep this decision for the new session',
        ),
    ).toBe(true);
    expect(s.inbox.pending(first.id).map((entry) => entry.event.summary)).toContain(
      'Keep this decision for the new session',
    );
  } finally {
    await s.close();
  }
});

test('goal continuation renews with pinned model and effort and notifies the supermanager once', async () => {
  const s = await setup();
  try {
    const first = await s.managers.start(s.spec);
    const continuationPath = join(s.path, '.temp', 'goal', first.id, 'CONTINUATION.md');
    mkdirSync(join(s.path, '.temp', 'goal', first.id), { recursive: true });
    writeFileSync(continuationPath, '- Next action: review the existing manager checkpoint before taking more work.\n');
    await s.notify({
      method: 'thread/goal/updated',
      params: {
        threadId: first.threadId,
        goal: { status: 'active', tokensUsed: 37000, timeUsedSeconds: 80, tokenBudget: s.spec.budget },
      },
    });
    expect(s.managers.get(first.id)).toMatchObject({ continuationAsked: true, continuationRenewed: false });

    await s.managers.outgoingMessage(first.id, s.spec.supermanager, 'continuation written');
    expect(s.requests().filter((request) => request.method === 'thread/start')).toHaveLength(1);

    writeFileSync(
      continuationPath,
      `- Result: the new bounded checkpoint records concrete progress.\n${'x'.repeat(8001)}`,
    );
    await s.managers.outgoingMessage(first.id, s.spec.supermanager, 'continuation written');
    expect(s.requests().filter((request) => request.method === 'thread/start')).toHaveLength(1);

    writeFileSync(
      continuationPath,
      '- Result: the current-thread renewal now requires a fresh bounded continuation with concrete progress.\n',
    );
    await s.managers.outgoingMessage(first.id, s.spec.supermanager, 'continuation written');
    await s.managers.flush();

    const renewed = s.managers.get(first.id);
    expect(renewed).toMatchObject({ threadId: 'thread-2', status: 'running' });
    const threadStarts = s.requests().filter((request) => request.method === 'thread/start');
    expect(threadStarts).toHaveLength(2);
    expect(threadStarts.every((request) => request.params.model === 'gpt-6.1-sol')).toBe(true);
    expect(threadStarts.every((request) => request.params.config.model_reasoning_effort === 'high')).toBe(true);
    const turnStarts = s.requests().filter((request) => request.method === 'turn/start');
    expect(turnStarts).toHaveLength(2);
    expect(
      turnStarts.every((request) => request.params.model === 'gpt-6.1-sol' && request.params.effort === 'high'),
    ).toBe(true);
    expect(turnStarts[1]!.params.input[0].text).toContain(continuationPath);
    expect(s.inbox.pending(s.spec.supermanager).filter((entry) => entry.event.kind === 'environment')).toHaveLength(1);

    await s.managers.outgoingMessage(first.id, s.spec.supermanager, 'continuation written');
    expect(s.requests().filter((request) => request.method === 'thread/start')).toHaveLength(2);
    expect(s.inbox.pending(s.spec.supermanager).filter((entry) => entry.event.kind === 'environment')).toHaveLength(1);
  } finally {
    await s.close();
  }
});

test('renewing a paused Claude manager opens a new session under the same id', async () => {
  const s = await setup();
  try {
    const first = await s.managers.start({ ...s.spec, engine: 'claude' });
    await s.managers.stop(first.id);
    const renewed = await s.managers.renew(first.id, {
      ...s.spec,
      engine: 'claude',
      limits: { turns: 12, turnsWithoutDecision: 4, wallMs: 900_000 },
    });

    expect(renewed).toMatchObject({
      id: first.id,
      engine: 'claude',
      status: 'running',
      threadId: expect.any(String),
      turns: 0,
      turnsWithoutDecision: 0,
    });
    expect(renewed.threadId).not.toBe(first.threadId);
    expect(renewed.history).toHaveLength(1);
    expect(renewed.history?.[0]).toMatchObject({ engine: 'claude', status: 'paused' });
    expect(s.windows).toHaveLength(2);
    expect(s.windows.every((window) => window.manager === first.id)).toBe(true);
    expect(s.removed).toContain(first.id);
  } finally {
    await s.close();
  }
});

test('renewing a running manager is refused without stopping its session', async () => {
  const s = await setup();
  try {
    const running = await s.managers.start(s.spec);
    await expect(s.managers.renew(running.id, s.spec)).rejects.toThrow('paused');
    expect(s.managers.get(running.id)).toMatchObject({ status: 'running', threadId: running.threadId });
    expect(s.requests().filter((request) => request.method === 'thread/start')).toHaveLength(1);
    expect(s.removed).toHaveLength(0);
    await s.managers.stop(running.id);
  } finally {
    await s.close();
  }
});
