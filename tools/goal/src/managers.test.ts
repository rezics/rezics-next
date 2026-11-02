import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { StdioAppServer, type Notification } from './app-server.ts';
import { openDb } from './db.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { ManagerSessions, type ManagerSpec } from './managers.ts';
import { temporaryDirectory } from './test-support.ts';

async function setup() {
  const temporary = temporaryDirectory();
  const db = openDb(join(temporary.path, 'state.sqlite'));
  const log = join(temporary.path, 'rpc.jsonl');
  const failFile = join(temporary.path, 'rpc-fail.json');
  const client = new StdioAppServer([process.execPath, join(import.meta.dir, 'fixtures/fake-app-server.ts')], {
    ...process.env,
    FAKE_RPC_LOG: log,
    FAKE_RPC_FAIL_FILE: failFile,
  });
  await client.initialize();
  const inbox = new SqliteManagerInbox(db, temporary.path);
  const windows: { manager: string; argv: string[] }[] = [];
  const removed: string[] = [];
  const errors: unknown[] = [];
  let connections = 0;
  let passing = false;
  let now = Date.now();
  const services = {
    connect: async () => {
      connections++;
      return client;
    },
    windows: {
      register(manager: string, argv: string[]) {
        windows.push({ manager, argv });
        return '@1';
      },
      unregister(manager: string) {
        removed.push(manager);
      },
    },
    checkCompletion: async () => ({
      passed: passing,
      evidencePath: join(temporary.path, 'completion.log'),
      summary: 'Some tasks remain unmerged',
    }),
    command: ['goal'],
    backlogDirectory: join(temporary.path, 'state', 'backlog'),
    now: () => now,
    onError: (error: unknown) => {
      errors.push(error);
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
    pool: { id: 'sol', codexHome: join(temporary.path, 'codex-home') },
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
    failFile,
    client,
    inbox,
    managers,
    windows,
    removed,
    errors,
    services,
    spec,
    requests,
    notify,
    get connections() {
      return connections;
    },
    pass() {
      passing = true;
    },
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

test('manager startup follows installed protocol and two managers share one app-server per pool', async () => {
  const s = await setup();
  try {
    const first = await s.managers.start(s.spec);
    await s.managers.flush();
    const requests = s.requests().filter((r) => r.id && r.method !== 'initialize');
    expect(requests.slice(0, 3).map((r) => r.method)).toEqual(['thread/start', 'thread/goal/set', 'turn/start']);
    expect(requests[0].params).toEqual({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      cwd: s.path,
      model: 'gpt-6.1-sol',
      config: { model_reasoning_effort: 'high', model_auto_compact_token_limit: 300000 },
    });
    expect(requests[1].params.tokenBudget).toBe(40000);
    expect(requests[1].params.status).toBe('active');
    expect(first.threadId).toBe('thread-1');
    expect(first.activeTurnId).toBe('turn-1');
    expect(s.managers.get(s.spec.id).turns).toBe(1);
    await s.managers.start({ ...s.spec, id: 'second' });
    expect(s.connections).toBe(1);
  } finally {
    await s.close();
  }
});

test('the Codex viewer resumes the thread on the remote endpoint without permission flags', async () => {
  const s = await setup();
  try {
    Object.defineProperty(s.client, 'endpoint', { value: 'ws://127.0.0.1:10001' });
    const manager = await s.managers.start(s.spec);
    const argv = s.windows[0]?.argv ?? [];
    expect(argv).toContain('resume');
    expect(argv).toContain(manager.threadId!);
    expect(argv).toContain('--remote');
    expect(argv).toContain('ws://127.0.0.1:10001');
    expect(argv).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  } finally {
    await s.close();
  }
});

test('delivery steers an active turn with expectedTurnId and starts an idle turn', async () => {
  const s = await setup();
  try {
    const manager = await s.managers.start(s.spec);
    await s.managers.flush();
    s.inbox.deliver({ managerId: s.spec.id, kind: 'instruction', summary: 'Resolve the conflict' });
    await s.managers.wake(s.spec.id);
    const steer = s.requests().find((r) => r.method === 'turn/steer');
    expect(steer.params.expectedTurnId).toBe(manager.activeTurnId);
    expect(steer.params.input).toEqual([{ type: 'text', text: 'Resolve the conflict', text_elements: [] }]);
    await s.notify({
      method: 'turn/completed',
      params: { threadId: manager.threadId, turn: { id: manager.activeTurnId, status: 'completed' } },
    });
    expect(s.managers.get(s.spec.id).activeTurnId).toBeNull();
    s.inbox.deliver({ managerId: s.spec.id, kind: 'spec-conflict', summary: 'Choose a contract' });
    await s.managers.wake(s.spec.id);
    expect(s.requests().filter((r) => r.method === 'turn/start')).toHaveLength(2);
    expect(s.managers.get(s.spec.id).activeTurnId).toBe('turn-2');
    expect(s.inbox.notifications(s.spec.id)).toHaveLength(0);
  } finally {
    await s.close();
  }
});

test('a steer racing a completed turn rejoins and starts a turn without losing the event', async () => {
  const s = await setup();
  try {
    const manager = await s.managers.start(s.spec);
    await s.managers.flush();
    // The server finishes just before delivery, while the persisted manager still names that turn.
    await s.client.request('turn/interrupt', { threadId: manager.threadId, turnId: manager.activeTurnId });
    // Force an old active-turn observation, as with an event arriving before its completion notification.
    s.db.query('UPDATE manager_sessions SET state = ? WHERE id = ?').run(JSON.stringify(manager), manager.id);
    s.inbox.deliver({ managerId: manager.id, kind: 'instruction', summary: 'Wake after the race' });
    await s.managers.wake(manager.id);
    await s.managers.flush();
    expect(s.inbox.notifications(manager.id)).toHaveLength(0);
    expect(s.managers.get(manager.id).activeTurnId).toBe('turn-2');
  } finally {
    await s.close();
  }
});

test('recorded-only outcomes never wake a manager and notifications track goal usage', async () => {
  const s = await setup();
  try {
    const manager = await s.managers.start(s.spec);
    await s.managers.flush();
    for (const kind of ['gate-passed', 'merged', 'environment-rerun', 'automatic-consultation'])
      s.inbox.record(manager.id, { kind });
    await s.managers.wake(manager.id);
    expect(s.requests().filter((r) => r.method === 'turn/steer')).toHaveLength(0);
    await s.notify({
      method: 'thread/goal/updated',
      params: {
        threadId: manager.threadId,
        goal: { status: 'active', tokensUsed: 200, timeUsedSeconds: 2, tokenBudget: 40000 },
      },
    });
    await s.notify({
      method: 'thread/tokenUsage/updated',
      params: { threadId: manager.threadId, tokenUsage: { total: { totalTokens: 1000, cachedInputTokens: 800 } } },
    });
    expect(s.managers.get(manager.id).goalState?.tokensUsed).toBe(200);
    expect(s.managers.get(manager.id).usage).toEqual({ total: { totalTokens: 1000, cachedInputTokens: 800 } });
  } finally {
    await s.close();
  }
});

test('turn and wall-clock limits replace the session without waking the supermanager', async () => {
  for (const reason of ['turns', 'wall']) {
    const s = await setup();
    try {
      const spec = { ...s.spec, limits: { turns: 1, turnsWithoutDecision: 10, wallMs: 3_600_000 } };
      const state = await s.managers.start(spec);
      await s.managers.flush();
      if (reason === 'wall') s.advance(spec.limits.wallMs + 1);
      await s.notify({
        method: 'turn/completed',
        params: { threadId: state.threadId, turn: { id: state.activeTurnId, status: 'completed' } },
      });
      if (reason === 'turns')
        await s.notify({
          method: 'turn/started',
          params: { threadId: state.threadId, turn: { id: 'next', status: 'inProgress' } },
        });
      await s.managers.flush();
      const renewed = s.managers.get(state.id);
      expect(renewed.status).toBe('running');
      expect(renewed.threadId).not.toBe(state.threadId);
      expect(renewed.history?.map((entry) => entry.threadId)).toEqual([state.threadId]);
      expect(s.inbox.pending('supervisor')).toHaveLength(0);
      expect(
        s
          .requests()
          .some(
            (r) =>
              r.method === 'thread/goal/set' && r.params.threadId === state.threadId && r.params.status === 'paused',
          ),
      ).toBe(true);
      expect(s.requests().filter((r) => r.method === 'thread/start')).toHaveLength(2);
    } finally {
      await s.close();
    }
  }
});

test('turns without a decision pause the manager and notify the supermanager', async () => {
  const s = await setup();
  try {
    const spec = { ...s.spec, limits: { turns: 10, turnsWithoutDecision: 1, wallMs: 3_600_000 } };
    const state = await s.managers.start(spec);
    await s.managers.flush();
    await s.notify({
      method: 'turn/completed',
      params: { threadId: state.threadId, turn: { id: state.activeTurnId, status: 'completed' } },
    });
    await s.notify({
      method: 'turn/started',
      params: { threadId: state.threadId, turn: { id: 'next', status: 'inProgress' } },
    });
    await s.notify({
      method: 'turn/completed',
      params: { threadId: state.threadId, turn: { id: 'next', status: 'completed' } },
    });
    await s.managers.flush();
    expect(s.managers.get(state.id).status).toBe('paused');
    expect(s.inbox.pending('supervisor')[0]?.event.kind).toBe('round-limit');
    expect(s.requests().some((r) => r.method === 'thread/goal/set' && r.params.status === 'paused')).toBe(true);
    expect(s.removed).toContain(state.id);
  } finally {
    await s.close();
  }
});

test('a control-plane decision prevents the turn from counting as empty', async () => {
  const s = await setup();
  try {
    const manager = await s.managers.start(s.spec);
    await s.managers.noteCommand(manager.id);
    await s.notify({
      method: 'turn/completed',
      params: { threadId: manager.threadId, turn: { id: manager.activeTurnId, status: 'completed' } },
    });
    expect(s.managers.get(manager.id).turnsWithoutDecision).toBe(0);
  } finally {
    await s.close();
  }
});

test('completion is checked, unmet evidence is delivered, and only a validated goal stops', async () => {
  const s = await setup();
  try {
    const manager = await s.managers.start(s.spec);
    await s.managers.flush();
    await s.notify({
      method: 'thread/goal/updated',
      params: {
        threadId: manager.threadId,
        goal: { status: 'complete', tokensUsed: 100, timeUsedSeconds: 1, tokenBudget: 40000 },
      },
    });
    expect(s.inbox.pending(manager.id)[0]?.event.kind).toBe('goal-unmet');
    expect(s.inbox.pending(manager.id)[0]?.event.evidencePath).toEndWith('completion.log');
    expect(s.managers.get(manager.id).status).toBe('running');
    expect(s.managers.get(manager.id).goalState?.status).toBe('active');
    s.pass();
    await s.managers.complete(manager.id);
    await s.managers.flush();
    expect(s.managers.get(manager.id).status).toBe('complete');
    expect(s.removed).toContain(manager.id);
  } finally {
    await s.close();
  }
});

test('Claude manager opens the requested CLI and counts turns through hooks', async () => {
  const s = await setup();
  try {
    const manager = await s.managers.start({ ...s.spec, engine: 'claude' });
    const argv = s.windows[0]!.argv;
    expect(argv).toContain('claude-opus-5-5');
    expect(argv).toContain('--autocompact');
    expect(argv).toContain('300000');
    expect(argv.join(' ')).not.toContain('inbox wait');
    expect(argv).toContain('--settings');
    expect(readFileSync(argv.at(-1)!.split(' ')[1]!, 'utf8')).toContain('inbox wait manager');
    expect(argv.slice(argv.indexOf('--session-id'), argv.indexOf('--session-id') + 2)).toEqual([
      '--session-id',
      manager.threadId!,
    ]);
    expect(argv.slice(argv.indexOf('--permission-mode'), argv.indexOf('--permission-mode') + 2)).toEqual([
      '--permission-mode',
      'bypassPermissions',
    ]);
    expect(argv.some((arg) => arg.startsWith('CLAUDE_CONFIG_DIR='))).toBe(true);
    const defaults = await setup();
    try {
      await defaults.managers.start({
        ...defaults.spec,
        engine: 'claude',
        pool: { ...defaults.spec.pool, codexHome: join(homedir(), '.claude') },
      });
      expect(defaults.windows[0]!.argv.some((arg) => arg.startsWith('CLAUDE_CONFIG_DIR='))).toBe(false);
    } finally {
      await defaults.close();
    }
    expect(s.connections).toBe(0);
    await s.managers.claudeTurn(manager.id, true);
    await s.managers.noteCommand(manager.id);
    await s.managers.claudeTurn(manager.id, false);
    expect(s.managers.get(manager.id).turns).toBe(1);
    expect(s.managers.get(manager.id).turnsWithoutDecision).toBe(0);
    s.inbox.deliver({ managerId: manager.id, kind: 'instruction', summary: 'Wake Claude' });
    await s.managers.wake(manager.id);
    expect(s.inbox.pending(manager.id)).toHaveLength(1);
    expect(s.connections).toBe(0);
  } finally {
    await s.close();
  }
});

test('a Claude manager whose session exited is resumed in its window when an event arrives', async () => {
  const s = await setup();
  try {
    const manager = await s.managers.start({ ...s.spec, engine: 'claude' });
    const resumed: string[][] = [];
    let alive = true;
    Object.assign(s.services.windows, {
      alive: () => alive,
      respawn: (_id: string, argv: string[]) => {
        resumed.push(argv);
      },
    });
    s.inbox.deliver({ managerId: manager.id, kind: 'instruction', summary: 'Wake Claude' });
    await s.managers.wake(manager.id);
    expect(resumed).toHaveLength(0);
    alive = false;
    await s.managers.wake(manager.id);
    const argv = resumed[0]!;
    expect(argv.slice(argv.indexOf('--resume'), argv.indexOf('--resume') + 2)).toEqual(['--resume', manager.threadId!]);
    expect(argv).toContain('--settings');
  } finally {
    await s.close();
  }
});

test('a live Claude manager that ended its turn is woken by a prompt typed into its window, once per event', async () => {
  const s = await setup();
  try {
    const manager = await s.managers.start({ ...s.spec, engine: 'claude' });
    const prompts: string[] = [];
    Object.assign(s.services.windows, {
      alive: () => true,
      prompt: (_id: string, text: string) => {
        prompts.push(text);
      },
    });
    s.inbox.deliver({ managerId: manager.id, kind: 'instruction', summary: 'Wake Claude' });
    await s.managers.wake(manager.id);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(`inbox read ${manager.id}`);
    await s.managers.wake(manager.id);
    expect(prompts).toHaveLength(1);
    s.inbox.deliver({ managerId: manager.id, kind: 'instruction', summary: 'Again' });
    await s.managers.wake(manager.id);
    expect(prompts).toHaveLength(2);
  } finally {
    await s.close();
  }
});

test('JSON-RPC errors propagate and an exiting app-server rejects pending requests', async () => {
  const s = await setup();
  try {
    await expect(s.client.request('test/fail', {})).rejects.toThrow('Fake failure');
    s.client.close();
    await expect(s.client.request('thread/start', {})).rejects.toThrow('closed');
  } finally {
    await s.close();
  }
});

test('an idle active Goal waits while the host starts another manager, then inbox wakes the same thread', async () => {
  const s = await setup();
  try {
    const manager = await s.managers.start(s.spec);
    await s.notify({
      method: 'turn/completed',
      params: { threadId: manager.threadId, turn: { id: manager.activeTurnId, status: 'completed' } },
    });
    await s.notify({
      method: 'thread/tokenUsage/updated',
      params: { threadId: manager.threadId, tokenUsage: { total: { totalTokens: 500 } } },
    });
    expect(s.managers.get(manager.id)).toMatchObject({
      status: 'running',
      activeTurnId: null,
      usage: { total: { totalTokens: 500 } },
      goalState: { status: 'active', objective: s.spec.objective, tokenBudget: s.spec.budget },
    });
    await s.managers.start({ ...s.spec, id: 'second' });
    expect(s.managers.get('second')).toMatchObject({ status: 'running', threadId: 'thread-2' });
    expect(s.requests().filter((r) => r.method === 'turn/start' && r.params.threadId === manager.threadId)).toHaveLength(
      1,
    );
    expect(
      s.requests().some((r) =>
        ['thread/fork', 'thread/goal/clear', 'thread/settings/update', 'turn/interrupt'].includes(r.method),
      ),
    ).toBe(false);
    expect(s.requests().some((r) => r.method === 'thread/goal/set' && r.params.status === 'paused')).toBe(false);
    s.inbox.deliver({ managerId: manager.id, kind: 'instruction', summary: 'Choose the next brief' });
    await s.managers.wake(manager.id);
    const wakes = s.requests().filter((r) => r.method === 'turn/start' && r.params.threadId === manager.threadId);
    expect(wakes).toHaveLength(2);
    expect(wakes[1].params.input).toEqual([{ type: 'text', text: 'Choose the next brief', text_elements: [] }]);
    expect(s.managers.get(manager.id)).toMatchObject({
      threadId: manager.threadId,
      status: 'running',
      usage: { total: { totalTokens: 500 } },
      goalState: { status: 'active', objective: s.spec.objective, tokenBudget: s.spec.budget },
    });
  } finally {
    await s.close();
  }
});

test('controller inbox recovery wakes the same active Goal once without changing its lifecycle', async () => {
  const s = await setup();
  let recovered: ManagerSessions | undefined;
  const closeTransport = s.client.close.bind(s.client);
  try {
    const state = await s.managers.start(s.spec);
    await s.managers.flush();
    await s.notify({
      method: 'turn/completed',
      params: { threadId: state.threadId, turn: { id: state.activeTurnId, status: 'completed' } },
    });
    await s.notify({
      method: 'thread/tokenUsage/updated',
      params: { threadId: state.threadId, tokenUsage: { total: { totalTokens: 900 } } },
    });
    expect(s.managers.get(state.id)).toMatchObject({
      status: 'running',
      activeTurnId: null,
      usage: { total: { totalTokens: 900 } },
      goalState: { status: 'active', objective: s.spec.objective, tokenBudget: s.spec.budget },
    });
    expect(s.requests().filter((r) => r.method === 'turn/start')).toHaveLength(1);
    s.inbox.deliver({ managerId: state.id, kind: 'instruction', summary: 'Decide before the host stops' });
    await s.managers.wake(state.id);
    expect(s.requests().filter((r) => r.method === 'turn/start')).toHaveLength(2);
    await s.notify({
      method: 'turn/completed',
      params: { threadId: state.threadId, turn: { id: 'turn-2', status: 'completed' } },
    });
    s.inbox.record(state.id, { kind: 'merged' });
    await s.managers.wake(state.id);
    expect(s.requests().filter((r) => r.method === 'turn/start')).toHaveLength(2);
    // The managed daemon survives a host disconnect; retain that fake transport across the handoff.
    s.client.close = () => {};
    await s.managers.close();
    s.inbox.deliver({ managerId: state.id, kind: 'instruction', summary: 'Committed while the host was down' });
    recovered = new ManagerSessions(s.db, s.inbox, s.services);
    await recovered.recover();
    await recovered.flush();
    expect(recovered.get(state.id)).toMatchObject({
      threadId: state.threadId,
      status: 'running',
      activeTurnId: 'turn-3',
      usage: { total: { totalTokens: 900 } },
      goalState: { status: 'active', objective: s.spec.objective, tokenBudget: s.spec.budget },
    });
    const wakeTurns = s.requests().filter((r) => r.method === 'turn/start');
    expect(wakeTurns).toHaveLength(3);
    expect(wakeTurns[1].params).toMatchObject({
      threadId: state.threadId,
      input: [{ text: 'Decide before the host stops' }],
    });
    expect(wakeTurns[2].params).toMatchObject({
      threadId: state.threadId,
      input: [{ text: 'Committed while the host was down' }],
    });
    expect(s.requests().filter((r) => r.method === 'thread/start')).toHaveLength(1);
    expect(s.requests().find((r) => r.method === 'thread/resume')?.params).toMatchObject({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
    expect(s.requests().some((r) => r.method === 'thread/goal/get')).toBe(true);
    expect(s.inbox.notifications(state.id)).toHaveLength(0);
    await recovered.recover();
    await recovered.flush();
    expect(s.requests().filter((r) => r.method === 'turn/start')).toHaveLength(3);
    expect(s.requests().filter((r) => r.method === 'turn/steer')).toHaveLength(0);
    expect(s.requests().filter((r) => r.method === 'thread/goal/set')).toHaveLength(1);
    expect(s.requests().some((r) => ['thread/fork', 'thread/goal/clear', 'turn/interrupt'].includes(r.method))).toBe(
      false,
    );
    expect(recovered.get(state.id).usage).toEqual({ total: { totalTokens: 900 } });
  } finally {
    await recovered?.close();
    closeTransport();
    await s.close();
  }
});

test('the wall-clock deadline renews a sleeping manager without waiting for a notification', async () => {
  const s = await setup();
  try {
    s.services.now = Date.now;
    const state = await s.managers.start({ ...s.spec, limits: { ...s.spec.limits, wallMs: 80 } });
    const deadline = Date.now() + 1500;
    while (!s.managers.get(state.id).history?.length && Date.now() < deadline) await Bun.sleep(10);
    expect(s.managers.get(state.id).history?.[0]?.threadId).toBe(state.threadId);
    expect(s.inbox.pending('supervisor')).toHaveLength(0);
  } finally {
    await s.close();
  }
});

test('a manager whose start failed before its session existed can start again', async () => {
  const s = await setup();
  try {
    let fail = true;
    const connect = s.services.connect;
    s.services.connect = async () => {
      if (fail) throw new Error('initialize timed out');
      return connect();
    };
    await expect(s.managers.start(s.spec)).rejects.toThrow('initialize timed out');
    expect(s.managers.get(s.spec.id)).toMatchObject({ status: 'paused' });
    expect(s.managers.get(s.spec.id).threadId ?? null).toBeNull();
    fail = false;
    expect((await s.managers.start(s.spec)).status).toBe('running');
  } finally {
    await s.close();
  }
});

test('a Codex manager opening ends idle turns instead of sleeping and names its backlog and message limits', async () => {
  const s = await setup();
  try {
    await s.managers.start(s.spec);
    const opening = s.requests().find((r) => r.method === 'turn/start')?.params.input[0]?.text as string;
    expect(opening).not.toContain('use clock.sleep inside the active turn');
    expect(opening).toContain('When no decision is pending, end the turn; do not use clock.sleep or poll');
    expect(opening).toContain('the controller resumes this thread when an inbox event arrives');
    expect(opening).toContain(`ready briefs in ${join(s.path, 'state', 'backlog', 'refactor')}`);
    expect(opening).toContain("Synthesize your workers' reports");
    expect(opening).toContain('at most 60 words each');
    expect(opening).toContain('Do not write receipts, status snapshots or lists of actions not taken.');
    expect(opening).toContain('Read your brief and continuation once per session');
    expect(opening).toContain('CONTINUATION.md under 8,000 characters, replaced, not appended');
    expect(opening).toContain('Act on each stopped task within an hour');
  } finally {
    await s.close();
  }
});

test('an event for an idle manager whose thread is not loaded rejoins the thread and starts a new turn', async () => {
  const s = await setup();
  try {
    const manager = await s.managers.start(s.spec);
    await s.notify({
      method: 'turn/completed',
      params: { threadId: manager.threadId, turn: { id: manager.activeTurnId, status: 'completed' } },
    });
    writeFileSync(s.failFile, JSON.stringify({ method: 'turn/start' }));
    s.inbox.deliver({ managerId: manager.id, kind: 'instruction', summary: 'Wake on a replaced app-server' });
    await s.managers.wake(manager.id);
    const methods = s
      .requests()
      .filter((r) => r.id && r.method !== 'initialize')
      .map((r) => r.method)
      .slice(-3);
    expect(methods).toEqual(['turn/start', 'thread/resume', 'turn/start']);
    expect(s.managers.get(manager.id).activeTurnId).toBe('turn-2');
    expect(s.inbox.notifications(manager.id)).toHaveLength(0);
  } finally {
    await s.close();
  }
});

test('more than ten clock.sleep calls in an hour raise one alarm and one correction', async () => {
  const s = await setup();
  try {
    const manager = await s.managers.start(s.spec);
    await s.managers.flush();
    const sleep = (index: number) =>
      s.notify({
        method: 'item/started',
        params: {
          threadId: manager.threadId,
          turnId: manager.activeTurnId,
          item: { type: 'sleep', id: `sleep-${index}`, durationMs: 60_000 },
        },
      });
    for (let index = 1; index <= 10; index++) await sleep(index);
    expect(s.inbox.pending('supervisor')).toHaveLength(0);
    await sleep(11);
    await sleep(12);
    const alarms = s.inbox.pending('supervisor');
    expect(alarms).toHaveLength(1);
    expect(alarms[0]!.event).toMatchObject({ kind: 'environment' });
    expect(alarms[0]!.event.summary).toContain('Manager manager called clock.sleep 11 times');
    expect(s.inbox.pending(manager.id).map((entry) => entry.event.summary)).toContain(
      'Do not call clock.sleep: when no decision is pending, end the turn; the next inbox event starts a new one.',
    );
    // Other tool items are not sleeps, and a new hour starts a new count.
    await s.notify({
      method: 'item/started',
      params: { threadId: manager.threadId, item: { type: 'commandExecution', id: 'command' } },
    });
    s.advance(3_600_000);
    for (let index = 13; index <= 22; index++) await sleep(index);
    expect(s.inbox.pending('supervisor')).toHaveLength(1);
  } finally {
    await s.close();
  }
});

test('a turn in which the manager writes or returns a backlog brief is not an empty turn', async () => {
  const s = await setup();
  try {
    const spec = { ...s.spec, limits: { turns: 10, turnsWithoutDecision: 1, wallMs: 3_600_000 } };
    const state = await s.managers.start(spec);
    await s.managers.flush();
    const backlog = join(s.path, 'state', 'backlog', 'refactor');
    mkdirSync(join(backlog, 'failed'), { recursive: true });
    const turn = async (id: string, work: () => void) => {
      await s.notify({
        method: 'turn/started',
        params: { threadId: state.threadId, turn: { id, status: 'inProgress' } },
      });
      work();
      await s.notify({
        method: 'turn/completed',
        params: { threadId: state.threadId, turn: { id, status: 'completed' } },
      });
    };
    await s.notify({
      method: 'turn/completed',
      params: { threadId: state.threadId, turn: { id: state.activeTurnId, status: 'completed' } },
    });
    expect(s.managers.get(state.id).turnsWithoutDecision).toBe(1);
    // File times are wall-clock times: bring the host clock to the wall clock before each turn starts.
    const sync = async (waitMs = 20) => {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      s.advance(Date.now() - s.services.now());
    };
    // A new brief written during the turn.
    await sync();
    await turn('write', () => writeFileSync(join(backlog, 'next.md'), 'Next brief\n'));
    // A refused brief moved back from failed/: its modification time is old, its status time is new.
    const returned = join(backlog, 'failed', 'returned.md');
    writeFileSync(returned, 'Returned brief\n');
    utimesSync(returned, 1, 1);
    // Past the file-clock slack, so only the rename during the turn can count.
    await sync(1_100);
    await turn('return', () => renameSync(returned, join(backlog, 'returned.md')));
    // A brief written during the turn that a backlog run already dispatched.
    await sync();
    await turn('dispatched', () => {
      s.db.exec('CREATE TABLE IF NOT EXISTS backlog_goals (goal TEXT PRIMARY KEY, last_written_at INTEGER)');
      s.db
        .query('INSERT OR REPLACE INTO backlog_goals(goal, last_written_at) VALUES (?, ?)')
        .run('refactor', Date.now());
    });
    expect(s.managers.get(state.id)).toMatchObject({ status: 'running', turnsWithoutDecision: 1 });
    // Without a brief or a command the turn is still empty.
    s.advance(60_000);
    await turn('empty', () => {});
    expect(s.managers.get(state.id).status).toBe('paused');
  } finally {
    await s.close();
  }
});
