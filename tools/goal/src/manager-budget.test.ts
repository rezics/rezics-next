import { expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  const client = new StdioAppServer([process.execPath, join(import.meta.dir, 'fixtures/fake-app-server.ts')], {
    ...process.env,
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
    async close() {
      await managers.close();
      db.close();
      temporary.close();
    },
  };
}

async function report(s: Awaited<ReturnType<typeof setup>>, threadId: string, status: string, tokensUsed: number) {
  await s.notify({
    method: 'thread/goal/updated',
    params: { threadId, goal: { status, tokensUsed, timeUsedSeconds: 120, tokenBudget: s.spec.budget } },
  });
}

function continuationPath(root: string, manager: string): string {
  return join(root, '.temp', 'goal', manager, 'CONTINUATION.md');
}

async function writeContinuation(s: Awaited<ReturnType<typeof setup>>) {
  const path = continuationPath(s.path, s.spec.id);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'Live task state and decisions');
  return path;
}

test('a Codex manager reaching 90% of its budget is asked once to write a continuation file', async () => {
  const s = await setup();
  try {
    const started = await s.managers.start(s.spec);
    await report(s, started.threadId!, 'active', 900);
    await report(s, started.threadId!, 'active', 950);

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
    expect(s.requests().filter((request) => request.method === 'thread/start')).toHaveLength(1);
  } finally {
    await s.close();
  }
});

test('a Codex manager below the threshold is not asked or renewed', async () => {
  const s = await setup();
  try {
    const started = await s.managers.start(s.spec);
    await report(s, started.threadId!, 'active', 899);

    expect(s.inbox.pending(started.id).filter((entry) => entry.event.kind === 'instruction')).toHaveLength(0);
    expect(s.managers.get(started.id)).toMatchObject({
      continuationAsked: false,
      status: 'running',
      threadId: started.threadId,
    });
    expect(s.requests().filter((request) => request.method === 'thread/start')).toHaveLength(1);
  } finally {
    await s.close();
  }
});

test('a budget-limited Codex manager renews with its continuation and tells the supermanager once', async () => {
  const s = await setup();
  try {
    const started = await s.managers.start(s.spec);
    await report(s, started.threadId!, 'active', 900);
    const path = await writeContinuation(s);
    await report(s, started.threadId!, 'budgetLimited', 1000);

    const renewed = s.managers.get(started.id);
    expect(renewed).toMatchObject({
      status: 'running',
      threadId: 'thread-2',
      continuationAsked: false,
      continuationRenewed: false,
    });
    expect(renewed.history?.[0]).toMatchObject({
      threadId: started.threadId,
      continuationAsked: true,
      continuationRenewed: true,
      continuationTokensUsed: 1000,
    });
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
    expect(s.requests().filter((request) => request.method === 'thread/start')).toHaveLength(2);
    const opening = s
      .requests()
      .find((request) => request.method === 'turn/start' && request.params.threadId === renewed.threadId)?.params
      .input[0]?.text;
    expect(opening).toContain(path);
    expect(opening).toContain(`Read your brief and the continuation ${path} once per session`);
    const notices = s.inbox.pending('supervisor').filter((entry) => entry.event.kind === 'environment');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.event.summary).toContain('Manager manager');
    expect(notices[0]!.event.summary).toContain('1000 tokens');
    expect(notices[0]!.event.summary).toContain(renewed.threadId!);
  } finally {
    await s.close();
  }
});

test('a continuation confirmation to the configured supermanager renews a Codex manager', async () => {
  const s = await setup();
  try {
    const started = await s.managers.start(s.spec);
    await report(s, started.threadId!, 'active', 900);
    await writeContinuation(s);

    await s.managers.outgoingMessage(started.id, 'supervisor', 'continuation written');
    const renewed = s.managers.get(started.id);
    expect(renewed.threadId).toBe('thread-2');
    expect(renewed.history?.[0]).toMatchObject({ continuationRenewed: true, continuationTokensUsed: 900 });
    expect(s.inbox.pending('supervisor').filter((entry) => entry.event.kind === 'environment')).toHaveLength(1);
  } finally {
    await s.close();
  }
});

test('a persisted continuation request and renewal survive manager-host recovery without duplicate events', async () => {
  const s = await setup();
  const closeClient = s.client.close.bind(s.client);
  let recovered: ManagerSessions | undefined;
  let recoveredAgain: ManagerSessions | undefined;
  try {
    const started = await s.managers.start(s.spec);
    await report(s, started.threadId!, 'active', 900);
    s.client.close = () => {};
    await s.managers.close();

    const pending = s.managers.get(started.id);
    pending.continuationRenewed = true;
    pending.continuationTokensUsed = 900;
    pending.pendingRenewal = { tokensUsed: 900, oldThreadId: started.threadId, ready: false };
    s.db.query('UPDATE manager_sessions SET state = ? WHERE id = ?').run(JSON.stringify(pending), started.id);

    recovered = new ManagerSessions(s.db, s.inbox, s.services);
    await recovered.recover();
    await recovered.flush();
    expect(recovered.get(started.id).threadId).toBe('thread-2');
    expect(s.inbox.pending(started.id).filter((entry) => entry.event.kind === 'instruction')).toHaveLength(1);
    expect(s.inbox.pending('supervisor').filter((entry) => entry.event.kind === 'environment')).toHaveLength(1);

    await recovered.close();
    recoveredAgain = new ManagerSessions(s.db, s.inbox, s.services);
    await recoveredAgain.recover();
    await recoveredAgain.flush();
    expect(recoveredAgain.get(started.id).threadId).toBe('thread-2');
    expect(s.requests().filter((request) => request.method === 'thread/start')).toHaveLength(2);
    expect(s.inbox.pending(started.id).filter((entry) => entry.event.kind === 'instruction')).toHaveLength(1);
    expect(s.inbox.pending('supervisor').filter((entry) => entry.event.kind === 'environment')).toHaveLength(1);
  } finally {
    await recoveredAgain?.close();
    await recovered?.close();
    s.client.close = closeClient;
    closeClient();
    await s.close();
  }
});

test('manager renew accepts budget-limited and blocked Codex Goals without a separate stop', async () => {
  for (const status of ['budgetLimited', 'blocked'] as const) {
    const s = await setup();
    try {
      const started = await s.managers.start(s.spec);
      await s.managers.flush();
      const state = s.managers.get(started.id);
      state.goalState = { status, tokensUsed: 950, timeUsedSeconds: 10, tokenBudget: s.spec.budget };
      s.db.query('UPDATE manager_sessions SET state = ? WHERE id = ?').run(JSON.stringify(state), started.id);

      const renewed = await s.managers.renew(started.id, s.spec);
      expect(renewed.status).toBe('running');
      expect(renewed.threadId).not.toBe(started.threadId);
      expect(s.requests().filter((request) => request.method === 'thread/start')).toHaveLength(2);
    } finally {
      await s.close();
    }
  }
});

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
    const started = await s.managers.start(s.spec);
    await report(s, started.threadId!, 'active', 900);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    process.env.GOAL_MANAGER = started.id;
    process.env.CODEX_THREAD_ID = started.threadId!;
    const runtime: IntegrationRuntime = {
      db: s.db,
      mainCheckout: s.path,
      stateDirectory: s.path,
      worktreeRoot: join(s.path, 'worktrees'),
      managerSocket: socketPath,
      inbox: s.inbox,
      fence: {} as IntegrationRuntime['fence'],
      sink: {} as IntegrationRuntime['sink'],
      landing: () => ({}) as ReturnType<IntegrationRuntime['landing']>,
      manager: () => s.spec,
      managerServices: s.services,
    };

    await runIntegration(['inbox', 'send', 'supervisor', 'instruction', 'continuation written'], runtime);

    expect(hostRequests.map((request) => request.command)).toEqual(['decision', 'outgoing-message']);
    expect(hostRequests[1]).toMatchObject({
      command: 'outgoing-message',
      manager: started.id,
      recipient: 'supervisor',
      summary: 'continuation written',
    });
  } finally {
    if (priorManager === undefined) delete process.env.GOAL_MANAGER;
    else process.env.GOAL_MANAGER = priorManager;
    if (priorCodexThread === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = priorCodexThread;
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await s.close();
  }
});
