import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { historicalManager } from '../test-support/historical-manager.ts';
import { StdioAppServer, type CodexPool, type Notification } from './app-server.ts';
import { userMessageTurn } from './manager-session-transport.ts';
import { openDb } from './db.ts';
import { SqliteManagerInbox } from './inbox.ts';
import {
  ManagerSessions,
  readManagerOperationalStatus,
  resolveGoalManager,
  type ManagedManagerState,
  type ManagerSpec,
} from './managers.ts';
import { defaultPolicy, type ControlPolicy } from './policy.ts';
import { authenticatedManager } from './priority-authority.ts';
import type { ProcessIdentity } from './process.ts';
import { renderManagerOpening } from './prompts.ts';
import { temporaryDirectory } from './test-support.ts';
import { prepareOwnerDecisionPrompt } from './owner-decisions.ts';
import type { WorkerEvent } from './store.ts';
import type { Task } from './types.ts';

const launchRetired = new Error('Managed manager launches are retired; use unit register for an execution unit');

async function setup(
  policy?: ControlPolicy,
  options: {
    autoStartGoalOnActive?: boolean;
    lateStartGoalOnPause?: boolean;
    threadSubscriptions?: boolean;
    codexManagerModel?: (id: string) => string | undefined;
  } = {},
) {
  const temporary = temporaryDirectory();
  const db = openDb(join(temporary.path, 'state.sqlite'));
  const log = join(temporary.path, 'rpc.jsonl');
  const failFile = join(temporary.path, 'rpc-fail.json');
  const stallFile = join(temporary.path, 'rpc-stall.json');
  let turnAllowed = true;
  const client = new StdioAppServer([process.execPath, join(import.meta.dir, 'fixtures/fake-app-server.ts')], {
    ...process.env,
    FAKE_RPC_LOG: log,
    FAKE_RPC_FAIL_FILE: failFile,
    FAKE_RPC_STALL_FILE: stallFile,
    FAKE_GOAL_AUTO_START_ON_ACTIVE: options.autoStartGoalOnActive ? '1' : '0',
    FAKE_GOAL_LATE_START_ON_PAUSE: options.lateStartGoalOnPause ? '1' : '0',
    FAKE_THREAD_SUBSCRIPTIONS: options.threadSubscriptions ? '1' : '0',
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
    ...(policy ? { policy } : {}),
    canStartTurn: () => turnAllowed,
    ...(options.codexManagerModel ? { codexManagerModel: options.codexManagerModel } : {}),
    connect: async (_pool?: CodexPool, _onStart?: (identity: ProcessIdentity) => void) => {
      connections++;
      return client;
    },
    onAppServerStart(_identity: ProcessIdentity) {},
    windows: {
      register(manager: string, argv: string[]) {
        windows.push({ manager, argv });
        return '@1';
      },
      unregister(manager: string) {
        removed.push(manager);
      },
      rebindIfStale(manager: string, argv: string[]) {
        windows.push({ manager, argv });
        return true;
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
  async function persistSession(overrides: Partial<ManagedManagerState> = {}) {
    const startedAt = services.now();
    const session = { ...spec, status: 'running', startedAt, threadId: randomUUID(), ...overrides } as const;
    if (session.engine === 'claude' || !session.threadId)
      return historicalManager(db, temporary.path, { turns: 0, ...session });

    // Recreate the provider side of the persisted session in the fake daemon. The fake turn advances its sequence.
    const { goal } = await client.request('thread/goal/set', {
      threadId: session.threadId,
      origin: 'user',
      objective: session.objective,
      status: 'active',
      tokenBudget: session.budget,
    });
    const threadId = session.threadId;
    const { turn } = await client.request<{ turn: { id: string } }>('turn/start', { threadId, input: [] });
    await managers.flush();
    return historicalManager(db, temporary.path, {
      ...session,
      activeTurnId: turn.id,
      countedTurn: turn.id,
      turnStartedAt: startedAt,
      turnDisposition: { threadId, turnId: turn.id, at: startedAt, status: 'inProgress', intent: 'work' },
      goalState: goal,
    });
  }
  async function recoverSession(overrides?: Partial<ManagedManagerState>) {
    const session = await persistSession(overrides);
    const previousErrors = errors.length;
    await managers.recover();
    await managers.flush();
    expect(errors.slice(previousErrors)).toEqual([]);
    return session;
  }
  return {
    ...temporary,
    db,
    failFile,
    stallFile,
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
    persistSession,
    recoverSession,
    get connections() {
      return connections;
    },
    pass() {
      passing = true;
    },
    setTurnAllowed(value: boolean) {
      turnAllowed = value;
    },
    advance(ms: number) {
      now += ms;
    },
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

async function waitForPausedGoalSet(s: Awaited<ReturnType<typeof setup>>, threadId: string, after: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (
      s
        .requests()
        .slice(after)
        .some(
          (request) =>
            request.method === 'thread/goal/set' &&
            request.params.threadId === threadId &&
            request.params.status === 'paused',
        )
    )
      return;
    await Bun.sleep(5);
  }
  throw new Error('The completed turn did not reach its native Goal idle park');
}

async function waitForTurnInterrupt(s: Awaited<ReturnType<typeof setup>>, threadId: string, after: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (
      s
        .requests()
        .slice(after)
        .some(
          (request) =>
            request.method === 'turn/interrupt' &&
            request.params.threadId === threadId &&
            request.params.turnId === 'turn-2',
        )
    )
      return;
    await Bun.sleep(5);
  }
  throw new Error('A late native Goal turn was not interrupted during idle parking');
}

test('historical manager recovery resumes both recorded threads through one app-server per pool', async () => {
  const s = await setup();
  try {
    const first = await s.persistSession();
    const second = await s.persistSession({ id: 'second' });
    const before = s.requests().length;
    await s.managers.recover();
    await s.managers.flush();
    const requests = s.requests().slice(before);
    expect(requests.filter((r) => r.method === 'thread/resume').map((r) => r.params)).toEqual(
      [first, second].map((state) => ({
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        threadId: state.threadId,
        model: 'gpt-6.1-sol',
        config: { model_reasoning_effort: 'high', model_auto_compact_token_limit: 300000 },
      })),
    );
    expect(requests.filter((r) => ['thread/start', 'thread/goal/set', 'turn/start'].includes(r.method))).toEqual([]);
    for (const state of [first, second])
      expect(s.managers.get(state.id)).toMatchObject({
        threadId: state.threadId,
        activeTurnId: state.activeTurnId,
        turns: 1,
        goalState: { objective: state.objective, status: 'active', tokenBudget: state.budget },
      });
    expect(s.connections).toBe(1);
    expect(s.errors).toEqual([]);
  } finally {
    await s.close();
  }
});

test('a manager model override applies to its next turn on the same thread only', async () => {
  let model: string | undefined;
  const s = await setup(undefined, { codexManagerModel: (id) => (id === 'manager' ? model : undefined) });
  try {
    const original = await s.recoverSession();
    const peer = await s.recoverSession({ ...s.spec, id: 'peer' });
    await s.notify({
      method: 'turn/completed',
      params: { threadId: original.threadId, turn: { id: original.activeTurnId, status: 'completed' } },
    });
    model = 'gpt-6-astra';
    s.inbox.deliver({ managerId: s.spec.id, kind: 'instruction', summary: 'Continue implementing the same scope' });
    await s.managers.wake(s.spec.id);
    await s.notify({
      method: 'turn/completed',
      params: { threadId: peer.threadId, turn: { id: peer.activeTurnId, status: 'completed' } },
    });
    s.inbox.deliver({ managerId: peer.id, kind: 'instruction', summary: 'Continue the peer scope' });
    await s.managers.wake(peer.id);
    await s.managers.flush();
    const starts = s.requests().filter((request) => request.method === 'turn/start');
    expect(starts.filter((r) => r.params.threadId === original.threadId).at(-1)?.params).toMatchObject({
      model: 'gpt-6-astra',
      effort: 'high',
    });
    expect(starts.filter((r) => r.params.threadId === peer.threadId).at(-1)?.params.model).toBe('gpt-6.1-sol');
    expect(s.managers.get(s.spec.id).threadId).toBe(original.threadId);
    expect(s.requests().filter((r) => r.method === 'thread/start')).toEqual([]);
  } finally {
    await s.close();
  }
});

test('sets the configured model before a native Goal wake can start a turn', async () => {
  let model: string | undefined;
  const s = await setup(undefined, { autoStartGoalOnActive: true, codexManagerModel: () => model });
  try {
    const original = await s.recoverSession();
    await s.notify({
      method: 'turn/completed',
      params: { threadId: original.threadId, turn: { id: original.activeTurnId, status: 'completed' } },
    });
    await waitForPausedGoalSet(s, original.threadId!, 0);
    const before = s.requests().length;
    model = 'gpt-6-astra';
    s.inbox.deliver({ managerId: s.spec.id, kind: 'instruction', summary: 'Continue' });
    await s.managers.wake(s.spec.id);
    await s.managers.flush();
    const relevant = s
      .requests()
      .slice(before)
      .filter(
        (r) =>
          r.method === 'thread/settings/update' || (r.method === 'thread/goal/set' && r.params.status === 'active'),
      );
    expect(relevant.map((r) => r.method)).toEqual(['thread/settings/update', 'thread/goal/set']);
    expect(relevant[0]?.params).toEqual({ threadId: original.threadId, model: 'gpt-6-astra', effort: 'high' });
    expect(s.managers.get(s.spec.id).threadId).toBe(original.threadId);
  } finally {
    await s.close();
  }
});

test('the Codex viewer resumes the thread on the remote endpoint without permission flags', async () => {
  const s = await setup();
  try {
    Object.defineProperty(s.client, 'endpoint', { value: 'ws://127.0.0.1:10001' });
    const manager = await s.recoverSession();
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
    const manager = await s.recoverSession();
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

test('an oversized legacy diagnostic reaches the existing turn only as an inbox pointer', async () => {
  const s = await setup();
  try {
    const manager = await s.recoverSession();
    await s.managers.flush();
    const diagnostic = 'R'.repeat(1_100_000);
    const taskId = 'task-with-retained-proof';
    s.inbox.deliver({ managerId: manager.id, taskId, kind: 'round-limit', summary: diagnostic });
    const id = s.inbox.pending(manager.id)[0]!.id;
    s.inbox.deliver({ managerId: manager.id, kind: 'instruction', summary: 'Continue independent source' });
    await s.managers.wake(manager.id);
    await s.managers.flush();
    const texts = s
      .requests()
      .filter((r) => r.method === 'turn/steer')
      .map((r) => r.params.input[0].text);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain(`Inbox #${id}: round-limit.`);
    expect(texts[0]).toContain(taskId);
    expect(texts[0].length).toBeLessThan(300);
    expect(texts[1]).toBe('Continue independent source');
    expect(s.inbox.notifications(manager.id)).toHaveLength(0);
    expect(s.inbox.pending(manager.id)[0]?.event.summary).toBe(diagnostic);
  } finally {
    await s.close();
  }
});

test('a steer racing a completed turn rejoins and starts a turn without losing the event', async () => {
  const s = await setup();
  try {
    const manager = await s.recoverSession();
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
    expect(s.requests().filter((r) => r.method === 'turn/start')).toHaveLength(2);
  } finally {
    await s.close();
  }
});

test('recorded-only outcomes never wake a manager and notifications track goal usage', async () => {
  const s = await setup();
  try {
    const manager = await s.recoverSession();
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

test('turn and wall-clock limits pause the old thread and report the retired renewal', async () => {
  for (const reason of ['turns', 'wall']) {
    const s = await setup();
    try {
      const spec = { ...s.spec, limits: { turns: 1, turnsWithoutDecision: 10, wallMs: 3_600_000 } };
      const state = await s.recoverSession(spec);
      await s.managers.flush();
      const openingTurnId = s.managers.get(state.id).activeTurnId!;
      if (reason === 'wall') s.advance(spec.limits.wallMs + 1);
      if (reason === 'turns') {
        await s.notify({
          method: 'turn/completed',
          params: { threadId: state.threadId, turn: { id: openingTurnId, status: 'completed' } },
        });
        s.inbox.deliver({ managerId: state.id, kind: 'decision', summary: 'Continue on the same thread' });
        await s.managers.wake(state.id);
        await s.managers.flush();
        const activeTurnId = s.managers.get(state.id).activeTurnId!;
        expect(activeTurnId).not.toBe(openingTurnId);
        await s.notify({
          method: 'turn/completed',
          params: { threadId: state.threadId, turn: { id: activeTurnId, status: 'completed' } },
        });
      } else {
        await s.notify({
          method: 'turn/completed',
          params: { threadId: state.threadId, turn: { id: openingTurnId, status: 'completed' } },
        });
      }
      await s.managers.flush();
      const renewed = s.managers.get(state.id);
      expect(renewed).toMatchObject({
        status: 'renewal-failed',
        activeTurnId: null,
        history: [{ threadId: state.threadId, status: 'paused' }],
        renewalAttempts: [{ at: expect.any(Number), error: launchRetired.message }],
      });
      expect(s.inbox.pending('supervisor').map(({ event }) => [event.kind, event.summary])).toEqual([
        ['blocker', `Manager ${state.id} renewal failed: ${launchRetired.message}`],
      ]);
      expect(
        s
          .requests()
          .some(
            (r) =>
              r.method === 'thread/goal/set' && r.params.threadId === state.threadId && r.params.status === 'paused',
          ),
      ).toBe(true);
      expect(s.removed).toContain(state.id);
      expect(
        s
          .requests()
          .filter((r) => r.method === 'turn/start')
          .map((r) => r.params.threadId),
      ).toEqual(reason === 'turns' ? [state.threadId, state.threadId] : [state.threadId]);
    } finally {
      await s.close();
    }
  }
});

test("A manager whose wall-clock renewal fails is reported to the supermanager as a blocker carrying the failure's error line, not as an ordinary round-limit pause.", async () => {
  const s = await setup();
  try {
    const spec = { ...s.spec, limits: { turns: 10, turnsWithoutDecision: 10, wallMs: 3_600_000 } };
    const state = await s.recoverSession(spec);
    await s.managers.flush();
    s.services.windows.register = () => {
      throw new Error('Missing termspaces session: rezics-agents\nrest of the stack');
    };
    s.advance(spec.limits.wallMs + 1);
    await s.notify({
      method: 'turn/completed',
      params: { threadId: state.threadId, turn: { id: state.activeTurnId, status: 'completed' } },
    });
    await s.managers.flush();
    const failed = s.managers.get(state.id);
    expect(failed.status).toBe('renewal-failed');
    expect(failed.renewalAttempts).toEqual([
      { at: expect.any(Number), error: 'Missing termspaces session: rezics-agents' },
    ]);
    const pending = s.inbox.pending('supervisor');
    expect(pending.map((entry) => entry.event.kind)).toEqual(['blocker']);
    expect(pending[0]?.event.summary).toBe('Manager manager renewal failed: Missing termspaces session: rezics-agents');
  } finally {
    await s.close();
  }
});

test('a scheduled historical renewal retry records its retirement error alongside the first failure', async () => {
  const s = await setup({ ...defaultPolicy, manager: { ...defaultPolicy.manager, renewalRetryMs: 200 } });
  try {
    const spec = { ...s.spec, limits: { turns: 10, turnsWithoutDecision: 10, wallMs: 3_600_000 } };
    const state = await s.recoverSession(spec);
    await s.managers.flush();
    s.services.windows.register = () => {
      throw new Error('Missing termspaces session: rezics-agents');
    };
    s.advance(spec.limits.wallMs + 1);
    await s.notify({
      method: 'turn/completed',
      params: { threadId: state.threadId, turn: { id: state.activeTurnId, status: 'completed' } },
    });
    await s.managers.flush();
    const failed = s.managers.get(state.id);
    expect(failed).toMatchObject({
      status: 'renewal-failed',
      nextRenewalRetryAt: s.services.now() + 200,
      renewalAttempts: [{ at: expect.any(Number), error: 'Missing termspaces session: rezics-agents' }],
    });
    s.services.windows.register = (manager: string, argv: string[]) => {
      s.windows.push({ manager, argv });
      return '@1';
    };
    const deadline = Date.now() + 1500;
    while ((s.managers.get(state.id).renewalAttempts?.length ?? 0) < 2 && Date.now() < deadline) await Bun.sleep(10);
    await s.managers.flush();
    const renewed = s.managers.get(state.id);
    expect(renewed.status).toBe('renewal-failed');
    expect(renewed.activeTurnId).toBeNull();
    expect(renewed.history?.map((entry) => entry.threadId)).toEqual([state.threadId]);
    expect(renewed.renewalAttempts).toEqual([
      { at: expect.any(Number), error: 'Missing termspaces session: rezics-agents' },
      { at: expect.any(Number), error: launchRetired.message },
    ]);
    expect(renewed.nextRenewalRetryAt).toBe(s.services.now() + 200);
  } finally {
    await s.close();
  }
});

test('turns without a decision pause the manager and notify the supermanager', async () => {
  const s = await setup();
  try {
    const spec = { ...s.spec, limits: { turns: 10, turnsWithoutDecision: 1, wallMs: 3_600_000 } };
    const state = await s.recoverSession(spec);
    await s.managers.flush();
    await s.notify({
      method: 'turn/completed',
      params: { threadId: state.threadId, turn: { id: state.activeTurnId, status: 'completed' } },
    });
    s.inbox.deliver({ managerId: state.id, kind: 'decision', summary: 'Continue work without a decision' });
    await s.managers.wake(state.id);
    await s.managers.flush();
    const nextTurn = s.managers.get(state.id).activeTurnId!;
    await s.notify({
      method: 'turn/completed',
      params: { threadId: state.threadId, turn: { id: nextTurn, status: 'completed' } },
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
    const manager = await s.recoverSession();
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

test('a control-plane decision resets the consecutive empty-turn count', async () => {
  const s = await setup();
  try {
    const spec = { ...s.spec, limits: { turns: 10, turnsWithoutDecision: 1, wallMs: 3_600_000 } };
    const manager = await s.recoverSession(spec);
    await s.notify({
      method: 'turn/completed',
      params: { threadId: manager.threadId, turn: { id: manager.activeTurnId, status: 'completed' } },
    });
    expect(s.managers.get(manager.id).turnsWithoutDecision).toBe(1);

    s.inbox.deliver({ managerId: manager.id, kind: 'instruction', summary: 'Make a control-plane decision' });
    await s.managers.wake(manager.id);
    await s.managers.flush();
    const productive = s.managers.get(manager.id).activeTurnId;
    expect(productive).toBeTruthy();
    await s.managers.noteCommand(manager.id);
    await s.notify({
      method: 'turn/completed',
      params: { threadId: manager.threadId, turn: { id: productive, status: 'completed' } },
    });
    expect(s.managers.get(manager.id).turnsWithoutDecision).toBe(0);

    s.inbox.deliver({ managerId: manager.id, kind: 'instruction', summary: 'Continue after the decision' });
    await s.managers.wake(manager.id);
    await s.managers.flush();
    const emptyAfterDecision = s.managers.get(manager.id).activeTurnId;
    expect(emptyAfterDecision).toBeTruthy();
    await s.notify({
      method: 'turn/completed',
      params: { threadId: manager.threadId, turn: { id: emptyAfterDecision, status: 'completed' } },
    });
    await s.managers.flush();
    expect(s.managers.get(manager.id).turnsWithoutDecision).toBe(1);
    expect(s.managers.get(manager.id).status).toBe('running');
  } finally {
    await s.close();
  }
});

test('completion is checked, unmet evidence is delivered, and only a validated goal stops', async () => {
  const s = await setup();
  try {
    const manager = await s.recoverSession();
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

test('historical Claude manager counts turns through hooks without connecting to Codex', async () => {
  const s = await setup();
  try {
    const manager = await s.recoverSession({ engine: 'claude' });
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

test.each(['custom config', 'default config'])(
  'a historical Claude manager with %s resumes its exited session when an event arrives',
  async (config) => {
    const s = await setup();
    try {
      const codexHome = config === 'default config' ? join(homedir(), '.claude') : s.spec.pool.codexHome;
      const manager = await s.recoverSession({ engine: 'claude', pool: { ...s.spec.pool, codexHome } });
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
      expect(argv.slice(argv.indexOf('--resume'), argv.indexOf('--resume') + 2)).toEqual([
        '--resume',
        manager.threadId!,
      ]);
      expect(argv).toContain('claude-opus-5-5');
      expect(argv).not.toContain('--session-id');
      expect(argv.slice(argv.indexOf('--autocompact'), argv.indexOf('--autocompact') + 2)).toEqual([
        '--autocompact',
        '300000',
      ]);
      expect(argv.slice(argv.indexOf('--permission-mode'), argv.indexOf('--permission-mode') + 2)).toEqual([
        '--permission-mode',
        'bypassPermissions',
      ]);
      expect(argv.filter((arg) => arg.startsWith('CLAUDE_CONFIG_DIR='))).toEqual(
        config === 'custom config' ? [`CLAUDE_CONFIG_DIR=${codexHome}`] : [],
      );
      expect(argv).toContain('--settings');
      expect(JSON.parse(argv[argv.indexOf('--settings') + 1]!).hooks).toEqual({
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: "'goal' 'manager' 'turn-start' 'manager'" }] }],
        Stop: [{ hooks: [{ type: 'command', command: "'goal' 'manager' 'turn-end' 'manager'" }] }],
      });
    } finally {
      await s.close();
    }
  },
);

test('a live Claude manager that ended its turn is woken by a prompt typed into its window, once per event', async () => {
  const s = await setup();
  try {
    const manager = await s.recoverSession({ ...s.spec, engine: 'claude' });
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

test('idle Goals stay parked; a concurrent inbox wake is retained through pool refusal and delivered once', async () => {
  const s = await setup(undefined, { autoStartGoalOnActive: true, lateStartGoalOnPause: true });
  try {
    const manager = await s.recoverSession();
    const threadId = manager.threadId!;
    const requestsBeforeInitialCompletion = s.requests().length;
    await s.notify({
      method: 'turn/completed',
      params: { threadId, turn: { id: manager.activeTurnId, status: 'completed' } },
    });
    // The provider can announce an automatic continuation after the pause reply. The persisted idle intent
    // must still interrupt that turn before an inbox wake arrives.
    await waitForTurnInterrupt(s, threadId, requestsBeforeInitialCompletion);
    await s.managers.flush();
    await s.notify({
      method: 'thread/tokenUsage/updated',
      params: { threadId, tokenUsage: { total: { totalTokens: 500 } } },
    });
    expect(s.managers.get(manager.id)).toMatchObject({
      status: 'running',
      threadId,
      activeTurnId: null,
      waitingForInbox: true,
      turns: 1,
      usage: { total: { totalTokens: 500 } },
      goalState: { status: 'paused', objective: s.spec.objective, tokenBudget: s.spec.budget },
      turnDisposition: {
        threadId,
        turnId: 'turn-2',
        status: 'interrupted',
        intent: 'controller-park',
      },
    });
    expect(readManagerOperationalStatus(s.db)).toContainEqual(
      expect.objectContaining({
        id: manager.id,
        operation: 'waiting-for-inbox',
        threadId,
        activeTurnId: null,
        waitingForInbox: true,
        nativeGoalStatus: 'paused',
        turnDisposition: expect.objectContaining({ intent: 'controller-park', status: 'interrupted' }),
      }),
    );
    expect(
      s
        .requests()
        .filter((r) => r.method === 'thread/goal/set')
        .map((r) => [r.params.status, r.params.origin]),
    ).toEqual([
      ['active', 'user'],
      ['paused', 'automatic'],
      ['paused', 'automatic'],
    ]);

    const startsAtIdle = s.requests().filter((r) => r.method === 'turn/start').length;
    const resumesAtIdle = s.requests().filter((r) => r.method === 'thread/resume').length;
    await s.managers.wake(manager.id);
    await s.managers.recover();
    await s.managers.flush();
    expect(s.requests().filter((r) => r.method === 'turn/start')).toHaveLength(startsAtIdle);
    expect(s.requests().filter((r) => r.method === 'thread/resume')).toHaveLength(resumesAtIdle);
    expect(s.managers.get(manager.id)).toMatchObject({ waitingForInbox: true, goalState: { status: 'paused' } });
    expect(s.inbox.pending('supervisor')).toHaveLength(0);

    // Reactivation itself starts the provider Goal turn. The existing start-or-steer path must use that same turn.
    s.inbox.deliver({ managerId: manager.id, kind: 'instruction', summary: 'Choose the next brief' });
    await s.managers.wake(manager.id);
    await s.managers.flush();
    expect(s.managers.get(manager.id)).toMatchObject({
      threadId,
      status: 'running',
      activeTurnId: 'turn-3',
      waitingForInbox: false,
      turns: 2,
      usage: { total: { totalTokens: 500 } },
      goalState: { status: 'active', objective: s.spec.objective, tokenBudget: s.spec.budget },
    });
    expect(s.requests().filter((r) => r.method === 'turn/steer')).toHaveLength(1);
    expect(s.inbox.notifications(manager.id)).toHaveLength(0);

    // Hold the native idle pause while new mail arrives; the per-manager serial queue must deliver it afterward.
    const requestsBeforeCompletion = s.requests().length;
    writeFileSync(s.stallFile, JSON.stringify({ method: 'thread/goal/set', status: 'paused', threadId }));
    const completion = s.notify({
      method: 'turn/completed',
      params: { threadId, turn: { id: 'turn-3', status: 'completed' } },
    });
    await waitForPausedGoalSet(s, threadId, requestsBeforeCompletion);
    s.setTurnAllowed(false);
    s.inbox.deliver({ managerId: manager.id, kind: 'decision', summary: 'Record the decision during idle parking' });
    rmSync(s.stallFile, { force: true });
    await completion;
    await s.managers.flush();
    expect(s.managers.get(manager.id)).toMatchObject({
      threadId,
      status: 'running',
      activeTurnId: null,
      waitingForInbox: true,
      goalState: { status: 'paused' },
    });
    expect(s.inbox.notifications(manager.id)).toHaveLength(1);
    const startsWhileCapped = s.requests().filter((r) => r.method === 'turn/start').length;
    s.managers.wake(manager.id);
    await s.managers.flush();
    expect(s.requests().filter((r) => r.method === 'turn/start')).toHaveLength(startsWhileCapped);
    expect(s.inbox.notifications(manager.id)).toHaveLength(1);
    expect(s.managers.get(manager.id)).toMatchObject({ waitingForInbox: true, goalState: { status: 'paused' } });

    s.setTurnAllowed(true);
    await s.managers.recover();
    await s.managers.flush();
    expect(s.managers.get(manager.id)).toMatchObject({
      threadId,
      status: 'running',
      activeTurnId: 'turn-4',
      waitingForInbox: false,
      turns: 3,
      usage: { total: { totalTokens: 500 } },
      goalState: { status: 'active', objective: s.spec.objective, tokenBudget: s.spec.budget },
    });
    expect(s.requests().filter((r) => r.method === 'turn/steer')).toHaveLength(2);
    expect(s.inbox.notifications(manager.id)).toHaveLength(0);

    await s.notify({
      method: 'turn/completed',
      params: { threadId, turn: { id: 'turn-4', status: 'completed' } },
    });
    expect(s.managers.get(manager.id)).toMatchObject({ waitingForInbox: true, goalState: { status: 'paused' } });
    const startsAfterDecision = s.requests().filter((r) => r.method === 'turn/start').length;
    await s.managers.recover();
    await s.managers.flush();
    expect(s.requests().filter((r) => r.method === 'turn/start')).toHaveLength(startsAfterDecision);
    expect(s.managers.get(manager.id)).toMatchObject({
      threadId,
      waitingForInbox: true,
      goalState: { status: 'paused' },
    });
  } finally {
    await s.close();
  }
});

test('a recovered manager subscribes before native inbox activation and parks when the delivered turn finishes', async () => {
  const s = await setup(undefined, { autoStartGoalOnActive: true, threadSubscriptions: true });
  let recovered: ManagerSessions | undefined;
  const closeTransport = s.client.close.bind(s.client);
  try {
    const manager = await s.recoverSession();
    const threadId = manager.threadId!;
    await s.notify({
      method: 'turn/completed',
      params: { threadId, turn: { id: manager.activeTurnId, status: 'completed' } },
    });
    s.client.close = () => {};
    await s.managers.close();
    await s.client.request('test/drop-thread-subscriptions', {});
    recovered = new ManagerSessions(s.db, s.inbox, s.services);
    const before = s.requests().length;
    await recovered.recover();
    expect(
      s
        .requests()
        .slice(before)
        .some((r) => r.method === 'thread/resume'),
    ).toBe(false);

    // Codex can already have loaded the thread for a viewer. The controller must not depend on
    // turn/start failing or adding a listener: the first delivery may go straight to turn/steer.
    s.inbox.deliver({ managerId: manager.id, kind: 'instruction', summary: 'Apply the delivered result' });
    await recovered.wake(manager.id);
    await recovered.flush();
    const relevant = s
      .requests()
      .slice(before)
      .filter((r) => r.method === 'thread/resume' || (r.method === 'thread/goal/set' && r.params.status === 'active'));
    expect(relevant.map((r) => r.method)).toEqual(['thread/resume', 'thread/goal/set']);
    const turnId = recovered.get(manager.id).activeTurnId!;
    expect(turnId).toBe('turn-2');
    expect(s.inbox.notifications(manager.id)).toHaveLength(0);
    await s.client.request('test/notify', {
      method: 'turn/completed',
      params: { threadId, turn: { id: turnId, status: 'completed' } },
    });
    await recovered.flush();
    expect(recovered.get(manager.id)).toMatchObject({
      threadId,
      activeTurnId: null,
      waitingForInbox: true,
      goalState: { status: 'paused' },
      turnDisposition: { threadId, turnId, status: 'completed', intent: 'work' },
    });
    const starts = s.requests().filter((r) => r.method === 'turn/start').length;
    await recovered.wake(manager.id);
    await recovered.recover();
    expect(s.requests().filter((r) => r.method === 'turn/start')).toHaveLength(starts);
  } finally {
    await recovered?.close();
    await closeTransport();
    await s.close();
  }
});

test('current interrupted and failed work turns stay visible and surface only real stranded mail once', async () => {
  for (const terminal of ['interrupted', 'failed'] as const) {
    const s = await setup();
    try {
      const manager = await s.recoverSession();
      const threadId = manager.threadId!;
      const turnId = manager.activeTurnId!;
      s.inbox.record(manager.id, { kind: 'merged' });

      await s.notify({
        method: 'turn/completed',
        params: { threadId, turn: { id: turnId, status: terminal } },
      });
      expect(readManagerOperationalStatus(s.db)).toContainEqual(
        expect.objectContaining({
          id: manager.id,
          operation: `turn-${terminal}`,
          threadId,
          activeTurnId: null,
          nativeGoalStatus: 'active',
          turnDisposition: expect.objectContaining({
            threadId,
            turnId,
            status: terminal,
            intent: 'work',
          }),
        }),
      );
      expect(s.inbox.pending('supervisor')).toHaveLength(0);

      await s.notify({
        method: 'turn/completed',
        params: { threadId, turn: { id: turnId, status: terminal } },
      });
      expect(s.inbox.pending('supervisor')).toHaveLength(0);

      s.inbox.deliver({ managerId: manager.id, kind: 'decision', summary: 'Review the interrupted work' });
      await s.managers.wake(manager.id);
      await s.managers.flush();
      expect(s.inbox.pending('supervisor')).toHaveLength(1);
      expect(s.inbox.pending('supervisor')[0]?.event.summary).toContain(
        `turn ${turnId} on thread ${threadId} ${terminal} unexpectedly`,
      );
      expect(s.managers.get(manager.id)).toMatchObject({ threadId, activeTurnId: 'turn-2', turns: 2 });
      expect(s.requests().filter((request) => request.method === 'turn/start')).toHaveLength(2);
      expect(
        s
          .requests()
          .filter((request) => request.method === 'turn/start')
          .at(-1)?.params.threadId,
      ).toBe(threadId);
      expect(s.inbox.notifications(manager.id)).toHaveLength(0);

      await s.managers.wake(manager.id);
      await s.managers.flush();
      expect(s.inbox.pending('supervisor')).toHaveLength(1);
      expect(s.requests().filter((request) => request.method === 'turn/start')).toHaveLength(2);
    } finally {
      await s.close();
    }
  }
});

test('a blocked running Goal accepts one admitted inbox turn without reactivation', async () => {
  const s = await setup();
  try {
    const manager = await s.recoverSession();
    const threadId = manager.threadId!;
    await s.notify({
      method: 'turn/completed',
      params: { threadId, turn: { id: manager.activeTurnId, status: 'completed' } },
    });
    await s.client.request('thread/goal/set', { threadId, status: 'blocked' });
    await s.managers.flush();
    expect(s.managers.get(manager.id)).toMatchObject({
      status: 'running',
      threadId,
      activeTurnId: null,
      goalState: { status: 'blocked', objective: s.spec.objective, tokenBudget: s.spec.budget },
    });

    s.setTurnAllowed(false);
    s.inbox.deliver({
      managerId: manager.id,
      kind: 'decision',
      summary: 'Review the blocked Goal and choose the next action',
    });
    await s.managers.wake(manager.id);
    await s.managers.flush();
    expect(s.inbox.notifications(manager.id)).toHaveLength(1);
    expect(s.requests().filter((r) => r.method === 'turn/start')).toHaveLength(1);

    s.setTurnAllowed(true);
    await s.managers.recover();
    await s.managers.flush();
    expect(s.managers.get(manager.id)).toMatchObject({
      status: 'running',
      threadId,
      activeTurnId: 'turn-2',
      waitingForInbox: false,
      turns: 2,
      goalState: { status: 'blocked', objective: s.spec.objective, tokenBudget: s.spec.budget },
    });
    expect(s.requests().filter((r) => r.method === 'turn/start')).toHaveLength(2);
    expect(s.requests().filter((r) => r.method === 'turn/steer')).toHaveLength(0);
    expect(s.inbox.notifications(manager.id)).toHaveLength(0);
    expect(
      s
        .requests()
        .filter((request) => request.method === 'thread/goal/set')
        .map((request) => request.params.status),
    ).toEqual(['active', 'paused', 'blocked']);
    expect(
      s
        .requests()
        .filter((request) => request.method === 'turn/start')
        .at(-1)?.params.input[0]?.text,
    ).toBe('Review the blocked Goal and choose the next action');

    await s.notify({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-2', status: 'completed' } } });
    const startsAfterCompletion = s.requests().filter((r) => r.method === 'turn/start').length;
    await s.managers.recover();
    await s.managers.flush();
    expect(s.requests().filter((r) => r.method === 'turn/start')).toHaveLength(startsAfterCompletion);
    expect(s.managers.get(manager.id)).toMatchObject({
      status: 'running',
      activeTurnId: null,
      goalState: { status: 'blocked' },
    });
  } finally {
    await s.close();
  }
});

test('recovery settles a completed explicit inbox turn while the native Goal remains blocked', async () => {
  const s = await setup();
  let recovered: ManagerSessions | undefined;
  const closeTransport = s.client.close.bind(s.client);
  try {
    const manager = await s.recoverSession();
    const threadId = manager.threadId!;
    await s.notify({
      method: 'turn/completed',
      params: { threadId, turn: { id: manager.activeTurnId, status: 'completed' } },
    });
    await s.client.request('thread/goal/set', { threadId, status: 'blocked' });
    await s.managers.flush();
    s.inbox.deliver({ managerId: manager.id, kind: 'instruction', summary: 'Resolve a real scheduling decision' });
    await s.managers.wake(manager.id);
    const turnId = s.managers.get(manager.id).activeTurnId!;
    s.client.close = () => {};
    await s.managers.close();
    // Make the fake provider return the exact terminal turn on resume while the host is disconnected.
    await s.client.request('test/notify', {
      method: 'turn/started',
      params: { threadId, turn: { id: turnId, status: 'completed' } },
    });
    const before = s.requests().length;
    recovered = new ManagerSessions(s.db, s.inbox, s.services);
    await recovered.recover();
    await recovered.flush();
    expect(recovered.get(manager.id)).toMatchObject({
      threadId,
      activeTurnId: null,
      waitingForInbox: false,
      goalState: { status: 'blocked' },
      turnDisposition: { threadId, turnId, status: 'completed', intent: 'work' },
    });
    expect(
      s
        .requests()
        .slice(before)
        .filter((r) => r.method === 'thread/goal/set' || r.method === 'turn/start'),
    ).toHaveLength(0);
  } finally {
    await recovered?.close();
    await closeTransport();
    await s.close();
  }
});

test('inbox decisions wake the same thread once across host recovery and preserve objective, budget and usage', async () => {
  const s = await setup();
  let recovered: ManagerSessions | undefined;
  const closeTransport = s.client.close.bind(s.client);
  try {
    const state = await s.recoverSession();
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
      waitingForInbox: true,
      usage: { total: { totalTokens: 900 } },
      goalState: { status: 'paused', objective: s.spec.objective, tokenBudget: s.spec.budget },
    });
    expect(s.requests().filter((r) => r.method === 'turn/start')).toHaveLength(1);
    s.inbox.deliver({ managerId: state.id, kind: 'instruction', summary: 'Decide before the host stops' });
    await s.managers.wake(state.id);
    expect(s.requests().filter((r) => r.method === 'turn/start')).toHaveLength(2);
    expect(s.managers.get(state.id)).toMatchObject({ goalState: { status: 'active' } });
    await s.notify({
      method: 'turn/completed',
      params: { threadId: state.threadId, turn: { id: 'turn-2', status: 'completed' } },
    });
    expect(s.managers.get(state.id)).toMatchObject({
      status: 'running',
      activeTurnId: null,
      waitingForInbox: true,
      goalState: { status: 'paused' },
    });
    s.inbox.record(state.id, { kind: 'merged' });
    await s.managers.wake(state.id);
    expect(s.requests().filter((r) => r.method === 'turn/start')).toHaveLength(2);
    // The managed daemon survives a host disconnect; retain that fake transport across the handoff.
    s.client.close = () => {};
    await s.managers.close();
    recovered = new ManagerSessions(s.db, s.inbox, s.services);
    const resumesBeforeIdleRecovery = s.requests().filter((r) => r.method === 'thread/resume').length;
    await recovered.recover();
    await recovered.flush();
    expect(recovered.get(state.id)).toMatchObject({
      threadId: state.threadId,
      status: 'running',
      activeTurnId: null,
      waitingForInbox: true,
      goalState: { status: 'paused', objective: s.spec.objective, tokenBudget: s.spec.budget },
    });
    expect(s.requests().filter((r) => r.method === 'turn/start')).toHaveLength(2);
    expect(s.requests().filter((r) => r.method === 'thread/resume')).toHaveLength(resumesBeforeIdleRecovery);
    s.inbox.deliver({ managerId: state.id, kind: 'instruction', summary: 'Committed while the host was down' });
    await recovered.recover();
    await recovered.flush();
    expect(recovered.get(state.id)).toMatchObject({
      threadId: state.threadId,
      status: 'running',
      activeTurnId: 'turn-3',
      waitingForInbox: false,
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
    expect(s.requests().filter((r) => r.method === 'thread/start')).toEqual([]);
    expect(s.requests().some((r) => r.method === 'thread/goal/get')).toBe(true);
    expect(s.inbox.notifications(state.id)).toHaveLength(0);
    await recovered.recover();
    await recovered.flush();
    expect(s.requests().filter((r) => r.method === 'turn/start')).toHaveLength(3);
    expect(s.requests().filter((r) => r.method === 'turn/steer')).toHaveLength(0);
    expect(
      s
        .requests()
        .filter((r) => r.method === 'thread/goal/set')
        .map((request) => request.params.status),
    ).toEqual(['active', 'paused', 'active', 'paused', 'active']);
    expect(s.requests().some((r) => ['thread/fork', 'thread/goal/clear', 'turn/interrupt'].includes(r.method))).toBe(
      false,
    );
    expect(recovered.get(state.id).usage).toEqual({ total: { totalTokens: 900 } });
  } finally {
    await recovered?.close();
    await closeTransport();
    await s.close();
  }
});

test('the wall-clock deadline handles a sleeping historical manager without a notification', async () => {
  const s = await setup();
  try {
    s.services.now = Date.now;
    const state = await s.recoverSession({ limits: { ...s.spec.limits, wallMs: 150 } });
    const deadline = Date.now() + 1500;
    while (s.managers.get(state.id).status !== 'renewal-failed' && Date.now() < deadline) await Bun.sleep(10);
    expect(s.managers.get(state.id)).toMatchObject({
      status: 'renewal-failed',
      activeTurnId: null,
      history: [{ threadId: state.threadId, status: 'paused' }],
      renewalAttempts: [{ error: launchRetired.message }],
    });
    expect(s.inbox.pending('supervisor').map(({ event }) => event.kind)).toEqual(['blocker']);
  } finally {
    await s.close();
  }
});

test('recovery pauses an incomplete historical start that has no provider thread', async () => {
  const s = await setup();
  try {
    const state = await s.recoverSession({ status: 'starting', threadId: null });
    expect(s.managers.get(state.id)).toMatchObject({ status: 'paused', threadId: null });
    expect(s.connections).toBe(0);
    expect(s.windows).toEqual([]);
    expect(s.requests().filter((r) => r.method === 'thread/start' || r.method === 'turn/start')).toEqual([]);
  } finally {
    await s.close();
  }
});

test('the historical manager opening rejects a retired launch', () => {
  expect(() =>
    renderManagerOpening({
      spec: { id: 'manager', goal: 'refactor', brief: 'Manage this scope', cwd: import.meta.dir, engine: 'codex' },
      backlogPath: join(import.meta.dir, 'refactor'),
      command: 'goal',
    }),
  ).toThrow(launchRetired);
});

test('a parked manager accepts a same-thread operator UserMessage after turn/started and reparks on completion', async () => {
  const s = await setup();
  try {
    const manager = await s.recoverSession();
    await s.notify({
      method: 'turn/completed',
      params: { threadId: manager.threadId, turn: { id: manager.activeTurnId, status: 'completed' } },
    });
    expect(s.managers.get(manager.id)).toMatchObject({ waitingForInbox: true, activeTurnId: null });

    const threadId = manager.threadId!;
    await s.notify({
      method: 'turn/started',
      params: { threadId, turn: { id: 'operator-turn-1', status: 'inProgress' } },
    });
    await s.notify({
      method: 'item/completed',
      params: {
        threadId,
        turnId: 'different-turn',
        completedAtMs: Date.now(),
        item: { type: 'userMessage', id: 'other-turn-message', clientId: null, content: [] },
      },
    });
    expect(s.managers.get(manager.id)).toMatchObject({
      waitingForInbox: true,
      activeTurnId: 'operator-turn-1',
      turns: 1,
    });
    await s.notify({
      method: 'item/completed',
      params: {
        threadId,
        turnId: 'operator-turn-1',
        completedAtMs: Date.now(),
        item: { type: 'userMessage', id: 'operator-message-1', clientId: null, content: [] },
      },
    });

    expect(s.managers.get(manager.id)).toMatchObject({
      waitingForInbox: false,
      activeTurnId: 'operator-turn-1',
      turns: 2,
      turnDisposition: { threadId, turnId: 'operator-turn-1', status: 'inProgress', intent: 'work' },
    });
    expect(
      s
        .requests()
        .filter((request) => request.method === 'turn/interrupt' && request.params.turnId === 'operator-turn-1'),
    ).toHaveLength(0);
    expect(
      s
        .requests()
        .filter((request) => request.method === 'thread/goal/set' && request.params.threadId === threadId)
        .map((request) => [request.params.status, request.params.origin]),
    ).toEqual([
      ['active', 'user'],
      ['paused', 'automatic'],
    ]);

    await s.notify({
      method: 'turn/completed',
      params: { threadId, turn: { id: 'operator-turn-1', status: 'completed' } },
    });
    expect(s.managers.get(manager.id)).toMatchObject({
      waitingForInbox: true,
      activeTurnId: null,
      turnDisposition: { threadId, turnId: 'operator-turn-1', status: 'completed', intent: 'work' },
      goalState: { status: 'paused' },
    });
  } finally {
    await s.close();
  }
});

test('reload preserves a native Goal harness continuation without classifying it as operator input', async () => {
  const s = await setup();
  const closeTransport = s.client.close.bind(s.client);
  let recovered: ManagerSessions | undefined;
  try {
    const manager = await s.recoverSession();
    const threadId = manager.threadId!;
    await s.notify({
      method: 'turn/completed',
      params: { threadId, turn: { id: manager.activeTurnId, status: 'completed' } },
    });
    const goalContinuation = {
      turn_trigger: 'goal',
      goal: { internal_context: { provenance: 'harness' } },
    };
    expect(
      userMessageTurn({
        method: 'item/completed',
        params: {
          ...goalContinuation,
          threadId,
          turnId: 'harness-turn',
          item: { type: 'userMessage', id: 'harness-message', clientId: null, content: [] },
        },
      }),
    ).toBeNull();
    await s.notify({
      method: 'turn/started',
      params: {
        threadId,
        turn: { ...goalContinuation, id: 'harness-turn', status: 'inProgress' },
      },
    });
    await s.notify({
      method: 'item/completed',
      params: {
        ...goalContinuation,
        threadId,
        turnId: 'harness-turn',
        item: { type: 'userMessage', id: 'harness-message', clientId: null, content: [] },
      },
    });
    expect(s.managers.get(manager.id)).toMatchObject({
      threadId,
      activeTurnId: 'harness-turn',
      waitingForInbox: false,
      turns: 2,
      turnDisposition: { threadId, turnId: 'harness-turn', status: 'inProgress', intent: 'work' },
    });
    expect(s.inbox.notifications(manager.id)).toHaveLength(0);

    s.client.close = () => {};
    await s.managers.close();
    recovered = new ManagerSessions(s.db, s.inbox, s.services);
    await recovered.recover();
    await recovered.flush();
    expect(recovered.get(manager.id)).toMatchObject({
      threadId,
      activeTurnId: 'harness-turn',
      waitingForInbox: false,
      turnDisposition: { threadId, turnId: 'harness-turn', status: 'inProgress', intent: 'work' },
    });
    expect(s.requests().filter((request) => request.method === 'thread/start')).toEqual([]);
    expect(s.requests().filter((request) => request.method === 'turn/start')).toHaveLength(1);
    expect(s.requests().filter((request) => request.method === 'turn/interrupt')).toHaveLength(0);
    expect(
      s
        .requests()
        .filter((request) => request.method === 'thread/resume')
        .map((request) => request.params.threadId),
    ).toContain(threadId);
    expect(s.inbox.notifications(manager.id)).toHaveLength(0);
  } finally {
    await recovered?.close();
    s.client.close = closeTransport;
    await s.close();
  }
});

test('an eventless automatic turn is interrupted after the item-ordering window', async () => {
  const s = await setup();
  try {
    const manager = await s.recoverSession();
    await s.notify({
      method: 'turn/completed',
      params: { threadId: manager.threadId, turn: { id: manager.activeTurnId, status: 'completed' } },
    });
    const threadId = manager.threadId!;
    await s.notify({
      method: 'turn/started',
      params: { threadId, turn: { id: 'automatic-turn', status: 'inProgress' } },
    });
    await s.notify({
      method: 'item/started',
      params: {
        threadId,
        turnId: 'automatic-turn',
        startedAtMs: Date.now(),
        item: { type: 'hookPrompt', id: 'internal-context', fragments: [] },
      },
    });
    expect(s.requests().filter((request) => request.method === 'turn/interrupt')).toHaveLength(0);
    await Bun.sleep(300);
    await s.managers.flush();

    expect(s.requests().filter((request) => request.method === 'turn/interrupt')).toContainEqual(
      expect.objectContaining({ params: { threadId, turnId: 'automatic-turn' } }),
    );
    expect(s.managers.get(manager.id)).toMatchObject({
      waitingForInbox: true,
      activeTurnId: null,
      turns: 1,
      turnDisposition: {
        threadId,
        turnId: 'automatic-turn',
        status: 'interrupted',
        intent: 'controller-park',
      },
      goalState: { status: 'paused' },
    });
  } finally {
    await s.close();
  }
});

test('a delayed UserMessage notification is recovered from the exact turn item list before interrupt', async () => {
  const s = await setup();
  try {
    const manager = await s.recoverSession();
    await s.notify({
      method: 'turn/completed',
      params: { threadId: manager.threadId, turn: { id: manager.activeTurnId, status: 'completed' } },
    });
    const threadId = manager.threadId!;
    await s.notify({
      method: 'turn/started',
      params: { threadId, turn: { id: 'delayed-input-turn', status: 'inProgress' } },
    });
    await s.client.request('test/persist-item', {
      threadId,
      turnId: 'delayed-input-turn',
      item: { type: 'userMessage', id: 'delayed-user-message', clientId: null, content: [] },
    });

    await Bun.sleep(300);
    await s.managers.flush();

    expect(s.requests().filter((request) => request.method === 'thread/items/list')).toContainEqual(
      expect.objectContaining({ params: expect.objectContaining({ threadId, turnId: 'delayed-input-turn' }) }),
    );
    expect(s.requests().filter((request) => request.method === 'turn/interrupt')).toHaveLength(0);
    expect(s.managers.get(manager.id)).toMatchObject({
      waitingForInbox: false,
      activeTurnId: 'delayed-input-turn',
      turns: 2,
      turnDisposition: {
        threadId,
        turnId: 'delayed-input-turn',
        status: 'inProgress',
        intent: 'work',
      },
    });

    await s.notify({
      method: 'item/completed',
      params: {
        threadId,
        turnId: 'delayed-input-turn',
        completedAtMs: Date.now(),
        item: { type: 'userMessage', id: 'delayed-user-message', clientId: null, content: [] },
      },
    });
    await s.notify({
      method: 'turn/completed',
      params: { threadId, turn: { id: 'delayed-input-turn', status: 'completed' } },
    });
    expect(s.managers.get(manager.id)).toMatchObject({
      waitingForInbox: true,
      activeTurnId: null,
      turnDisposition: { threadId, turnId: 'delayed-input-turn', status: 'completed', intent: 'work' },
    });
  } finally {
    await s.close();
  }
});

test('a real manager stop cancels the pending parked-turn decision and keeps stop intent', async () => {
  const s = await setup();
  try {
    const manager = await s.recoverSession();
    await s.notify({
      method: 'turn/completed',
      params: { threadId: manager.threadId, turn: { id: manager.activeTurnId, status: 'completed' } },
    });
    await s.notify({
      method: 'turn/started',
      params: { threadId: manager.threadId, turn: { id: 'stopped-turn', status: 'inProgress' } },
    });

    await s.managers.stop(manager.id);
    await s.managers.flush();
    await Bun.sleep(300);
    await s.managers.flush();

    expect(s.requests().filter((request) => request.method === 'turn/interrupt')).toHaveLength(1);
    expect(s.managers.get(manager.id)).toMatchObject({
      status: 'paused',
      waitingForInbox: false,
      turnDisposition: {
        threadId: manager.threadId,
        turnId: 'stopped-turn',
        status: 'interrupted',
        intent: 'controller-stop',
      },
    });
    expect(
      s
        .requests()
        .filter((request) => request.method === 'thread/goal/set')
        .at(-1),
    ).toMatchObject({
      params: { threadId: manager.threadId, status: 'paused', origin: 'user' },
    });
  } finally {
    await s.close();
  }
});

test('an event for an idle manager whose thread is not loaded rejoins the thread and starts a new turn', async () => {
  const s = await setup();
  try {
    const manager = await s.recoverSession();
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
    const manager = await s.recoverSession();
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
    const state = await s.recoverSession(spec);
    await s.managers.flush();
    const backlog = join(s.path, 'state', 'backlog', 'refactor');
    mkdirSync(join(backlog, 'failed'), { recursive: true });
    const turn = async (id: string, work: () => void) => {
      s.inbox.deliver({ managerId: state.id, kind: 'instruction', summary: `Perform ${id}` });
      await s.managers.wake(state.id);
      await s.managers.flush();
      const turnId = s.managers.get(state.id).activeTurnId;
      expect(turnId).toBeTruthy();
      work();
      await s.notify({
        method: 'turn/completed',
        params: { threadId: state.threadId, turn: { id: turnId, status: 'completed' } },
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
    expect(s.managers.get(state.id)).toMatchObject({ status: 'running', turnsWithoutDecision: 0 });
    // Without a brief or a command the turn is still empty.
    s.advance(60_000);
    await turn('empty', () => {});
    expect(s.managers.get(state.id)).toMatchObject({ status: 'running', turnsWithoutDecision: 1 });
  } finally {
    await s.close();
  }
});

test('recovery retains an incomplete historical start thread when the provider pause fails', async () => {
  const s = await setup();
  try {
    const state = await s.persistSession({ status: 'starting' });
    writeFileSync(s.failFile, JSON.stringify({ method: 'thread/goal/set' }));
    await s.managers.recover();
    expect(s.errors.map((error) => (error as Error).message)).toEqual(['Thread not loaded']);
    expect(s.managers.get(state.id)).toMatchObject({ status: 'paused', threadId: state.threadId });
    expect(s.requests().filter((r) => r.method === 'thread/start')).toEqual([]);
    await s.managers.stop(state.id);
    await s.managers.flush();
    expect(s.managers.get(state.id)).toMatchObject({
      status: 'paused',
      threadId: state.threadId,
      activeTurnId: null,
      turnDisposition: { turnId: state.activeTurnId, status: 'interrupted', intent: 'controller-stop' },
    });
    expect(s.removed).toContain(state.id);
  } finally {
    await s.close();
  }
});

test('a notification from a retired thread does not change the current session', async () => {
  const s = await setup();
  try {
    const manager = await s.recoverSession();
    await s.managers.flush();
    await s.notify({
      method: 'turn/completed',
      params: { threadId: 'retired-thread', turn: { id: manager.activeTurnId, status: 'completed' } },
    });
    await s.notify({
      method: 'thread/goal/updated',
      params: {
        threadId: 'retired-thread',
        goal: { status: 'complete', tokensUsed: 9, timeUsedSeconds: 1, tokenBudget: 40000 },
      },
    });
    expect(s.managers.get(manager.id)).toMatchObject({
      threadId: manager.threadId,
      activeTurnId: manager.activeTurnId,
      turns: 1,
    });
    expect(s.managers.get(manager.id).goalState?.status).toBe('active');
    expect(readManagerOperationalStatus(s.db)).toContainEqual(
      expect.objectContaining({ id: manager.id, operation: 'active-turn', threadId: manager.threadId }),
    );
    expect(s.inbox.pending('supervisor')).toHaveLength(0);
  } finally {
    await s.close();
  }
});

test('a failed connection is evicted so recovery reconnects the same historical session', async () => {
  const s = await setup();
  try {
    const state = await s.persistSession();
    let attempts = 0;
    const connect = s.services.connect;
    s.services.connect = async () => {
      attempts++;
      if (attempts === 1) throw new Error('connect failed');
      return connect();
    };
    await s.managers.recover();
    expect(s.errors).toEqual([new Error('connect failed')]);
    expect(s.managers.get(state.id)).toEqual(state);
    await s.managers.recover();
    await s.managers.flush();
    expect(s.managers.get(state.id)).toMatchObject({
      status: 'running',
      threadId: state.threadId,
      activeTurnId: state.activeTurnId,
    });
    expect(attempts).toBe(2);
    expect(s.errors).toHaveLength(1);
    expect(s.requests().filter((r) => r.method === 'thread/start')).toEqual([]);
  } finally {
    await s.close();
  }
});

test('one ownership callback fires per process identity', async () => {
  const s = await setup();
  try {
    const seen: { pid: number; start: string; boot: string }[] = [];
    s.services.onAppServerStart = (identity: ProcessIdentity) => seen.push(identity);
    const connect = s.services.connect!;
    s.services.connect = async (_pool?: CodexPool, onStart?: (identity: ProcessIdentity) => void) => {
      const server = await connect();
      if (server.identity) onStart?.(server.identity);
      return server;
    };
    await s.recoverSession();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(s.client.identity);
  } finally {
    await s.close();
  }
});

test('pause falls back to resume then interrupt when the active turn is gone', async () => {
  const s = await setup();
  try {
    const manager = await s.recoverSession();
    writeFileSync(s.failFile, JSON.stringify({ method: 'turn/interrupt' }));
    await s.managers.stop(manager.id);
    const methods = s
      .requests()
      .filter((r) => r.id && r.method !== 'initialize')
      .map((r) => r.method);
    const interruptAt = methods.lastIndexOf('turn/interrupt');
    expect(methods.slice(interruptAt - 2, interruptAt + 1)).toEqual([
      'turn/interrupt',
      'thread/resume',
      'turn/interrupt',
    ]);
    await s.managers.flush();
    expect(s.managers.get(manager.id).status).toBe('paused');
    expect(readManagerOperationalStatus(s.db)).toContainEqual(
      expect.objectContaining({
        id: manager.id,
        operation: 'paused',
        turnDisposition: expect.objectContaining({ intent: 'controller-stop', status: 'interrupted' }),
      }),
    );
    expect(s.inbox.pending('supervisor')).toHaveLength(0);
  } finally {
    await s.close();
  }
});

test('internal historical assignment moves a Goal and its records without restarting tasks', async () => {
  const s = await setup();
  try {
    mkdirSync(join(s.path, 'docs', 'goals'), { recursive: true });
    mkdirSync(join(s.path, '.temp', 'goal', 'refactor'), { recursive: true });
    mkdirSync(join(s.path, '.temp', 'goal', 'commerce'), { recursive: true });
    writeFileSync(join(s.path, 'docs', 'goals', 'refactor.md'), 'Refactor goal brief\n');
    writeFileSync(join(s.path, 'docs', 'goals', 'commerce.md'), 'Commerce goal brief\n');
    writeFileSync(join(s.path, '.temp', 'goal', 'refactor', 'CONTINUATION.md'), 'Refactor continuation\n');
    writeFileSync(join(s.path, '.temp', 'goal', 'commerce', 'CONTINUATION.md'), 'Commerce continuation\n');
    const source = await s.recoverSession();
    const dest = await s.recoverSession({ ...s.spec, id: 'other', goal: 'commerce', objective: 'Finish commerce' });
    const sourceActor = { GOAL_MANAGER: source.id, CODEX_THREAD_ID: source.threadId! };
    const destActor = { GOAL_MANAGER: dest.id, CODEX_THREAD_ID: dest.threadId! };
    expect(authenticatedManager(s.db, sourceActor)).toEqual({ id: source.id, sessionId: sourceActor.CODEX_THREAD_ID });
    await s.notify({
      method: 'turn/completed',
      params: { threadId: dest.threadId, turn: { id: dest.activeTurnId, status: 'completed' } },
    });
    s.db.exec(
      `CREATE TABLE worker_tasks (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE, current_attempt INTEGER NOT NULL, body TEXT NOT NULL);
       CREATE TABLE worker_attempts (task_id TEXT NOT NULL, attempt INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(task_id, attempt));
       CREATE TABLE landing_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, attempt INTEGER NOT NULL, request TEXT NOT NULL, outcome TEXT, delivered INTEGER NOT NULL DEFAULT 0, candidate TEXT);
       CREATE TABLE worker_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, attempt INTEGER NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, body TEXT NOT NULL);`,
    );
    const handle = { pid: 4242, start: '100', boot: 'boot', group: 4242 };
    s.db.query('INSERT INTO worker_tasks(id, sequence, current_attempt, body) VALUES (?, ?, ?, ?)').run(
      'running-task',
      1,
      1,
      JSON.stringify({
        id: 'running-task',
        currentAttempt: 1,
        state: 'running',
        worktree: '/trees/running-task',
        brief: { goal: 'refactor', manager: source.id },
      }),
    );
    s.db
      .query('INSERT INTO worker_attempts(task_id, attempt, body) VALUES (?, ?, ?)')
      .run(
        'running-task',
        1,
        JSON.stringify({ taskId: 'running-task', attempt: 1, state: 'running', process: handle }),
      );
    s.db
      .query('INSERT INTO landing_queue(task, attempt, request) VALUES (?, ?, ?)')
      .run(
        'running-task',
        1,
        JSON.stringify({ taskId: 'running-task', attempt: 1, managerLanding: { managerId: source.id } }),
      );
    s.inbox.deliver({
      managerId: source.id,
      kind: 'instruction',
      goalId: 'refactor',
      summary: 'Repair the refactor journey',
    });
    s.db.query('INSERT INTO worker_events(task_id,attempt,kind,at,body) VALUES (?,?,?,?,?)').run(
      'running-task',
      1,
      'owner-contract-decision-accepted',
      new Date().toISOString(),
      JSON.stringify({
        taskId: 'running-task',
        attempt: 1,
        decisionId: 'original-owner-rule',
        summary: 'Use the original owner rule.',
        managerId: source.id,
        senderSessionId: source.threadId,
        documentRefs: [],
      }),
    );
    const moved = await s.managers.assign('refactor', dest.id);
    await s.managers.flush();
    expect(moved).toEqual({ goal: 'refactor', from: source.id, to: dest.id, goals: ['commerce', 'refactor'] });
    expect(s.managers.get(source.id).status).toBe('paused');
    expect(s.removed).toContain(source.id);
    expect(authenticatedManager(s.db, sourceActor)).toBeUndefined();
    expect(authenticatedManager(s.db, destActor)).toEqual({ id: dest.id, sessionId: destActor.CODEX_THREAD_ID });
    expect(s.managers.get(dest.id)).toMatchObject({
      status: 'running',
      threadId: dest.threadId,
      goals: ['commerce', 'refactor'],
    });
    expect(s.inbox.pending(source.id)).toHaveLength(0);
    expect(s.inbox.pending(dest.id).map((entry) => entry.event.summary)).toEqual([
      'Repair the refactor journey',
      "You now own Goals commerce, refactor. Read each Goal's brief and continuation.",
    ]);
    const task = JSON.parse(
      (s.db.query('SELECT body FROM worker_tasks WHERE id = ?').get('running-task') as { body: string }).body,
    );
    const attempt = JSON.parse(
      (s.db.query('SELECT body FROM worker_attempts WHERE task_id = ?').get('running-task') as { body: string }).body,
    );
    expect(task).toMatchObject({ state: 'running', brief: { goal: 'refactor', manager: dest.id } });
    expect(attempt.process).toEqual(handle);
    const decisions = s.db.query('SELECT * FROM worker_events ORDER BY sequence').all() as WorkerEvent[];
    expect(decisions.map((event) => event.kind)).toEqual([
      'owner-contract-decision-accepted',
      'owner-contract-decisions-superseded',
    ]);
    expect(JSON.parse(decisions[1]!.body)).toEqual({ previousManager: source.id, manager: dest.id });
    // Restoring the former owner cannot revive intent invalidated by the real assignment.
    const restored = { ...task, brief: { ...task.brief, manager: source.id } } as Task;
    expect(
      prepareOwnerDecisionPrompt(
        { ownerDecisionEvents: () => decisions },
        restored,
        { taskId: restored.id, attempt: 1 },
        'Continue.',
      ).delivery,
    ).toBeUndefined();
    expect(resolveGoalManager(s.db, 'refactor', 'refactor')).toBe(dest.id);
    expect(
      JSON.parse(
        (s.db.query('SELECT request FROM landing_queue WHERE task = ?').get('running-task') as { request: string })
          .request,
      ).managerLanding.managerId,
    ).toBe(dest.id);
    const wake = s
      .requests()
      .filter((request) => request.method === 'turn/start' && request.params.threadId === dest.threadId);
    const wakePrompt = wake.at(-1)?.params.input[0].text as string;
    expect(wakePrompt).toContain('Read the assigned Goal documents if present:');
    expect(wakePrompt).toContain('docs/goals/refactor.md');
    expect(wakePrompt).toContain('.temp/goal/refactor/CONTINUATION.md');
    expect(wakePrompt).toContain('docs/goals/commerce.md');
    expect(wakePrompt).toContain('.temp/goal/commerce/CONTINUATION.md');
    expect(wakePrompt).toContain('Repair the refactor journey');
    expect(
      s.managers
        .list()
        .map((state) => ({ id: state.id, status: state.status, goals: 'goals' in state ? state.goals : [] })),
    ).toEqual(
      expect.arrayContaining([
        { id: dest.id, status: 'running', goals: ['commerce', 'refactor'] },
        { id: source.id, status: 'paused', goals: [] },
      ]),
    );
  } finally {
    await s.close();
  }
});

test('internal historical assignment refuses the current owner and a non-running destination', async () => {
  const s = await setup();
  try {
    const source = await s.recoverSession();
    await expect(s.managers.assign('refactor', source.id)).rejects.toThrow(
      'Goal refactor is already owned by manager manager',
    );
    const dest = await s.recoverSession({ ...s.spec, id: 'other', goal: 'commerce' });
    await s.managers.stop(dest.id);
    await expect(s.managers.assign('refactor', dest.id)).rejects.toThrow(
      'Manager other is not a running managed manager',
    );
    await expect(s.managers.assign('refactor', 'missing')).rejects.toThrow(
      'Manager missing is not a running managed manager',
    );
  } finally {
    await s.close();
  }
});

test('close flushes a pending wake and ignores later notifications', async () => {
  const s = await setup();
  try {
    const manager = await s.recoverSession();
    s.inbox.deliver({ managerId: manager.id, kind: 'instruction', summary: 'Finish before close' });
    const waking = s.managers.wake(manager.id);
    await s.managers.close();
    await waking;
    expect(s.inbox.notifications(manager.id)).toHaveLength(0);
    expect(s.requests().some((r) => r.method === 'turn/steer')).toBe(true);
    const turns = s.managers.get(manager.id).turns;
    await s
      .notify({
        method: 'turn/started',
        params: { threadId: manager.threadId, turn: { id: 'after-close', status: 'inProgress' } },
      })
      .catch(() => {});
    expect(s.managers.get(manager.id).turns).toBe(turns);
  } finally {
    await s.close();
  }
});

test('a failed historical renewal preserves an empty assignment', async () => {
  const s = await setup();
  try {
    const state = await s.persistSession({ status: 'paused', goals: [] });
    await expect(s.managers.renew(state.id, s.spec)).rejects.toThrow(launchRetired);
    expect(s.managers.get(state.id)).toMatchObject({
      status: 'paused',
      goals: [],
      activeTurnId: null,
      history: [{ threadId: state.threadId, goals: [] }],
    });
  } finally {
    await s.close();
  }
});

test('internal historical assignment repairs a duplicate paused claim', async () => {
  const s = await setup();
  try {
    const goal = s.spec.goal;
    const source = historicalManager(s.db, s.path, { ...s.spec, status: 'paused', goals: [goal, 'other-goal'] });
    const destination = await s.recoverSession({ id: 'destination', goals: [goal] });
    const moved = await s.managers.assign(goal, destination.id);
    expect(moved).toEqual({ goal, from: source.id, to: destination.id, goals: [goal] });
    expect(s.managers.get(source.id)).toMatchObject({ status: 'paused', goals: ['other-goal'] });
  } finally {
    await s.close();
  }
});
