import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { historicalManager } from '../test-support/historical-manager.ts';
import { StdioAppServer, type Notification } from './app-server.ts';
import { openDb } from './db.ts';
import { readFlow } from './flow.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { runIntegration, type IntegrationRuntime } from './integration-cli.ts';
import { ManagerSessions, type GoalState, type ManagedManagerState, type ManagerSpec } from './managers.ts';
import { temporaryDirectory } from './test-support.ts';
import { readControlPolicy, type ControlPolicy } from './policy.ts';

async function setup(policy?: ControlPolicy) {
  const temporary = temporaryDirectory();
  const db = openDb(join(temporary.path, 'state.sqlite'));
  const log = join(temporary.path, 'rpc.jsonl');
  const client = new StdioAppServer([process.execPath, join(import.meta.dir, 'fixtures/fake-app-server.ts')], {
    ...process.env,
    FAKE_RPC_LOG: log,
  });
  await client.initialize();
  const inbox = new SqliteManagerInbox(db, temporary.path);
  const services = {
    ...(policy ? { policy } : {}),
    connect: async () => client,
    windows: { register: () => '@1', unregister: () => {} },
    checkCompletion: async () => ({
      passed: false,
      evidencePath: join(temporary.path, 'completion.log'),
      summary: 'Tasks remain',
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
    pool: { id: 'sol', codexHome: join(temporary.path, 'codex-home') },
    budget: 1000,
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
  async function providerSession() {
    const threadId = randomUUID();
    const { goal } = await client.request('thread/goal/set', {
      threadId,
      objective: spec.objective,
      status: 'active',
      tokenBudget: spec.budget,
    });
    const { turn } = await client.request<{ turn: { id: string } }>('turn/start', { threadId, input: [] });
    return {
      threadId,
      status: 'running',
      activeTurnId: turn.id,
      countedTurn: turn.id,
      turnDisposition: { threadId, turnId: turn.id, at: Date.now(), status: 'inProgress', intent: 'work' },
      goalState: goal,
      continuationAsked: false,
      continuationRenewed: false,
    } as const;
  }
  async function recoverSession() {
    // Load the same thread and active turn from the fake provider and the historical store.
    const provider = await providerSession();
    const state = historicalManager(db, temporary.path, { ...spec, ...provider });
    await managers.recover();
    await managers.flush();
    return { ...state, threadId: provider.threadId };
  }

  function runtime(managerSocket = join(temporary.path, 'manager.sock')): IntegrationRuntime {
    return {
      db,
      mainCheckout: temporary.path,
      stateDirectory: temporary.path,
      worktreeRoot: join(temporary.path, 'worktrees'),
      managerSocket,
      inbox,
      fence: {} as IntegrationRuntime['fence'],
      sink: {} as IntegrationRuntime['sink'],
      landing: () => ({}) as ReturnType<IntegrationRuntime['landing']>,
      manager: () => spec,
      managerServices: services,
    };
  }
  return {
    ...temporary,
    db,
    client,
    inbox,
    managers,
    recoverSession,
    providerSession,
    runtime,
    services,
    spec,
    requests,
    notify,
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

async function report(
  s: Awaited<ReturnType<typeof setup>>,
  threadId: string,
  status: GoalState['status'],
  tokensUsed: number,
) {
  const { goal } = await s.client.request('thread/goal/set', {
    threadId,
    status,
    tokensUsed,
    timeUsedSeconds: 120,
    tokenBudget: s.spec.budget,
  });
  await s.managers.flush();
  return goal;
}

test('a Codex manager reaching 90% of its budget is asked once to write a continuation file', async () => {
  const s = await setup();
  try {
    const started = await s.recoverSession();
    await report(s, started.threadId, 'active', 900);
    await report(s, started.threadId, 'active', 950);

    const instructions = s.inbox.pending(started.id).filter((entry) => entry.event.kind === 'instruction');
    expect(instructions).toHaveLength(1);
    expect(instructions[0]!.event.summary).toContain('.temp/goal/manager/CONTINUATION.md');
    expect(instructions[0]!.event.summary).toContain(
      'Replace .temp/goal/manager/CONTINUATION.md with at most 8,000 characters',
    );
    expect(instructions[0]!.event.summary).toContain('live task IDs');
    expect(instructions[0]!.event.summary).toContain('decisions in force as links to owner documents');
    expect(instructions[0]!.event.summary).toContain('next actions');
    expect(instructions[0]!.event.summary).toContain('Do not append to the old file');
    expect(instructions[0]!.event.summary).toContain('continuation written');
    expect(s.managers.get(started.id)).toMatchObject({
      continuationAsked: true,
      continuationRenewed: false,
      status: 'running',
      threadId: started.threadId,
    });
    expect(s.requests().filter((request) => request.method === 'thread/start')).toHaveLength(0);
  } finally {
    await s.close();
  }
});

test('public managed start refuses launch even with a restrictive prompt budget', async () => {
  const s = await setup(readControlPolicy({ prompt: { managerRoleBytes: 1, managerOpeningBytes: 1 } }));
  try {
    const requests = s.requests();
    await expect(runIntegration(['manager', 'start', s.spec.id], s.runtime())).rejects.toThrow(
      'Managed manager launches and assignments are retired',
    );
    expect(s.managers.list()).toEqual([]);
    expect(readFlow(s.db).filter((event) => event.stage === 'manager' && event.action === 'started')).toEqual([]);
    expect(s.requests()).toEqual(requests);
  } finally {
    await s.close();
  }
});

test('a Codex manager below the threshold is not asked or renewed', async () => {
  const s = await setup();
  try {
    const started = await s.recoverSession();
    await report(s, started.threadId, 'active', 899);

    expect(s.inbox.pending(started.id).filter((entry) => entry.event.kind === 'instruction')).toHaveLength(0);
    expect(s.managers.get(started.id)).toMatchObject({
      continuationAsked: false,
      status: 'running',
      threadId: started.threadId,
    });
    expect(s.requests().filter((request) => request.method === 'thread/start')).toHaveLength(0);
  } finally {
    await s.close();
  }
});

test('a budget-limited Codex manager without a fresh continuation parks and notifies the supermanager once', async () => {
  const s = await setup();
  try {
    const started = await s.recoverSession();
    await report(s, started.threadId, 'active', 900);
    await s.managers.outgoingMessage(started.id, 'supervisor', 'continuation written');
    const goal = await report(s, started.threadId, 'budgetLimited', 1000);

    const parked = s.managers.get(started.id);
    expect(parked).toMatchObject({
      status: 'paused',
      threadId: started.threadId,
      continuationAsked: true,
      continuationRenewed: false,
      activeTurnId: null,
      goalState: { status: 'paused', tokensUsed: 1000, tokenBudget: 1000 },
    });
    await s.notify({ method: 'thread/goal/updated', params: { threadId: started.threadId, goal } });
    expect(
      s
        .requests()
        .some(
          (request) =>
            request.method === 'thread/goal/set' &&
            request.params.threadId === started.threadId &&
            request.params.status === 'paused',
        ),
    ).toBe(true);
    expect(s.requests().filter((request) => request.method === 'thread/start')).toHaveLength(0);
    const notices = s.inbox.pending('supervisor').filter((entry) => entry.event.kind === 'blocker');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.event.summary).toContain('without a fresh, bounded continuation');
    expect(notices[0]!.event.summary).toContain('bun tools/goal/src/cli.ts manager renew manager');
  } finally {
    await s.close();
  }
});

test('recovery delivers a persisted continuation notice once to the configured supermanager', async () => {
  const s = await setup();
  const closeClient = s.client.close.bind(s.client);
  let recovered: ManagerSessions | undefined;
  let recoveredAgain: ManagerSessions | undefined;
  try {
    const old = await s.recoverSession();
    await report(s, old.threadId, 'active', 900);
    await s.managers.stop(old.id);
    await s.managers.flush();
    const checkpoint = s.managers.get(old.id) as ManagedManagerState;
    const provider = await s.providerSession();
    const { threadId } = provider;
    const replacement: ManagedManagerState = {
      ...old,
      ...provider,
      history: [{ ...checkpoint, continuationRenewed: true, continuationTokensUsed: 900 }],
      pendingRenewal: { tokensUsed: 900, oldThreadId: old.threadId, ready: true },
    };
    // Keep the fake provider alive while replacing the host that observes it.
    s.client.close = () => {};
    await s.managers.close();
    s.db.query('UPDATE manager_sessions SET state = ? WHERE id = ?').run(JSON.stringify(replacement), old.id);

    recovered = new ManagerSessions(s.db, s.inbox, s.services);
    await recovered.recover();
    await recovered.flush();
    const persisted = recovered.get(old.id) as ManagedManagerState;
    expect(persisted.pendingRenewal).toBeUndefined();
    expect(persisted).toMatchObject({
      threadId,
      budget: old.budget,
      goalState: { tokenBudget: old.budget },
      history: [{ threadId: old.threadId, continuationThreadId: old.threadId, continuationTokensUsed: 900 }],
    });

    await recovered.close();
    recoveredAgain = new ManagerSessions(s.db, s.inbox, s.services);
    await recoveredAgain.recover();
    await recoveredAgain.flush();
    expect(recoveredAgain.get(old.id)).toEqual(persisted);
    expect(s.requests().filter((request) => request.method === 'thread/start')).toHaveLength(0);
    expect(s.inbox.pending(old.id).filter((entry) => entry.event.kind === 'instruction')).toHaveLength(1);
    expect(s.inbox.pending(old.supermanager).map(({ event }) => [event.kind, event.summary])).toEqual([
      ['environment', `Manager ${old.id} renewed after using 900 tokens; new thread ${threadId}.`],
    ]);
  } finally {
    await recoveredAgain?.close();
    await recovered?.close();
    s.client.close = closeClient;
    await s.close();
  }
});

test.each(['budgetLimited', 'blocked'] as const)(
  'public renew refuses a historical %s Goal and preserves its budget and ownership',
  async (status) => {
    const s = await setup();
    try {
      const started = historicalManager(s.db, s.path, {
        ...s.spec,
        status: 'running',
        goals: [s.spec.goal, 'search'],
        goalState: { status, tokensUsed: 950, timeUsedSeconds: 10, tokenBudget: s.spec.budget },
      });

      const requests = s.requests();
      await expect(runIntegration(['manager', 'renew', started.id], s.runtime())).rejects.toThrow(
        'Managed manager launches and assignments are retired',
      );
      expect(s.managers.get(started.id)).toEqual(started);
      expect(s.requests()).toEqual(requests);
    } finally {
      await s.close();
    }
  },
);

test('inbox send reports a continuation confirmation to the manager host', async () => {
  const s = await setup();
  const socketPath = join(s.path, 'manager.sock');
  const hostRequests: any[] = [];
  const server = createServer((socket) => {
    createInterface({ input: socket }).once('line', (line) => {
      hostRequests.push(JSON.parse(line));
      socket.end(`${JSON.stringify({ result: null })}\n`);
    });
  });
  const priorManager = process.env.GOAL_MANAGER;
  const priorCodexThread = process.env.CODEX_THREAD_ID;
  try {
    const started = await s.recoverSession();
    await report(s, started.threadId, 'active', 900);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    process.env.GOAL_MANAGER = started.id;
    const send = ['inbox', 'send', 'supervisor', 'instruction', 'continuation written'];
    process.env.CODEX_THREAD_ID = 'unrecognized-thread';
    await expect(runIntegration(send, s.runtime(socketPath))).rejects.toThrow('authenticated manager session');
    expect(hostRequests).toEqual([]);
    expect(s.inbox.pending('supervisor')).toEqual([]);

    process.env.CODEX_THREAD_ID = started.threadId;
    await runIntegration(send, s.runtime(socketPath));
    expect(s.inbox.pending('supervisor').map(({ event }) => event)).toEqual([
      expect.objectContaining({ from: started.id, summary: 'continuation written' }),
    ]);

    expect(hostRequests.map((request) => request.command)).toEqual(['decision', 'outgoing-message']);
    expect(hostRequests[1]).toMatchObject({
      command: 'outgoing-message',
      manager: started.id,
      recipient: started.supermanager,
      summary: 'continuation written',
    });

    await s.managers.stop(started.id);
    await s.managers.flush();
    await expect(runIntegration(send, s.runtime(socketPath))).rejects.toThrow('authenticated manager session');
    expect(hostRequests).toHaveLength(2);
    expect(s.inbox.pending('supervisor')).toHaveLength(1);
  } finally {
    if (priorManager === undefined) delete process.env.GOAL_MANAGER;
    else process.env.GOAL_MANAGER = priorManager;
    if (priorCodexThread === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = priorCodexThread;
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await s.close();
  }
});

test('historical manager policy overrides apply to sleep alarms and the continuation boundary', async () => {
  const s = await setup(
    readControlPolicy({
      manager: { continuationBudgetPercent: 50, continuationCharacters: 1200, sleepAlarmPerHour: 1 },
    }),
  );
  try {
    const state = await s.recoverSession();
    await report(s, state.threadId, 'active', 499);
    expect(s.inbox.pending(state.id)).toHaveLength(0);
    await report(s, state.threadId, 'active', 500);
    expect(s.inbox.pending(state.id)[0]!.event.summary).toContain('at least 50%');
    expect(s.inbox.pending(state.id)[0]!.event.summary).toContain('at most 1,200 characters');
    for (let index = 0; index < 3; index++)
      await s.notify({
        method: 'item/started',
        params: { threadId: state.threadId, item: { type: 'sleep', id: `s${index}` } },
      });
    expect(s.inbox.pending('supervisor').filter((entry) => entry.event.kind === 'environment')).toHaveLength(1);
  } finally {
    await s.close();
  }
});
