import { expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { run } from './cli.ts';
import { openDb } from './db.ts';
import { createRuntime } from './config.ts';
import { hostRequest, type HostRequest } from './integration-cli.ts';
import { SqliteManagerInbox } from './inbox.ts';
import type { ManagerSpec } from './managers.ts';
import { WorkerStore } from './store.ts';
import { WorkerTasks } from './tasks.ts';
import { harness, temporaryDirectory } from './test-support.ts';

const runtimeScript = join(import.meta.dir, 'fixtures/cli-runtime.ts');
const short = (path: string) => relative(process.cwd(), path);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Hosted = { child: ChildProcess; ready: Promise<void>; exited: Promise<void>; stderr: () => string };

function startHost(env: NodeJS.ProcessEnv): Hosted {
  const child = spawn(process.execPath, [runtimeScript, '_manager-host'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr!.on('data', (chunk) => (stderr += String(chunk)));
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const ready = new Promise<void>((resolve, reject) => {
    const lines = createInterface({ input: child.stdout! });
    lines.once('line', (line) => {
      lines.close();
      if (line === 'ready') resolve();
      else reject(new Error(`unexpected host startup line: ${line}`));
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(stderr || `host exited before ready (${code})`)));
  });
  return { child, ready, exited, stderr: () => stderr };
}

async function stopHost(host: Hosted | undefined): Promise<void> {
  if (!host) return;
  if (host.child.exitCode === null && host.child.signalCode === null) {
    host.child.kill('SIGTERM');
    const stopped = await Promise.race([host.exited.then(() => true), delay(5_000).then(() => false)]);
    if (!stopped) host.child.kill('SIGKILL');
  }
  await host.exited;
}

function hostFixture(extra: NodeJS.ProcessEnv = {}) {
  const temporary = temporaryDirectory();
  mkdirSync(temporary.path, { recursive: true });
  const env = {
    ...process.env,
    FAKE_GOAL_STATE: short(temporary.path),
    FAKE_GOAL_MAIN: temporary.path,
    FAKE_RPC_TIMEOUT_MS: '5000',
    FAKE_RPC_STALL_FILE: join(temporary.path, 'stall.json'),
    ...extra,
  };
  const command = async (withEnv: NodeJS.ProcessEnv, ...args: string[]) => {
    const child = Bun.spawn([process.execPath, runtimeScript, ...args], {
      env: withEnv,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  const rpc = () => {
    try {
      return readFileSync(join(temporary.path, 'rpc.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { method: string; params: any });
    } catch {
      return [];
    }
  };
  return { ...temporary, env, command, rpc };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(10);
  }
}

async function listen(path: string, onConnection: (socket: Socket) => void): Promise<Server> {
  const server = createServer(onConnection);
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  serverSockets.set(server, sockets);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  return server;
}

const serverSockets = new WeakMap<Server, Set<Socket>>();

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    for (const socket of serverSockets.get(server) ?? []) socket.destroy();
  });
}

function managerSpec(cwd: string, id: string): ManagerSpec {
  return {
    id,
    goal: id,
    objective: `Manage ${id}`,
    brief: 'Wait for instructions',
    cwd,
    engine: 'codex',
    pool: { id: 'fake', codexHome: join(cwd, 'codex') },
    budget: 1000,
    effort: 'low',
    supermanager: 'supervisor',
    limits: { turns: 100, turnsWithoutDecision: 100, wallMs: 60_000 },
  };
}

test('durable decisions and public inbox and dispatch commands bypass a stalled manager chain', async () => {
  const f = hostFixture();
  const h = harness();
  const stallFile = join(f.path, 'stall.json');
  let host: Hosted | undefined;
  let stoppingA: Promise<{ code: number; stdout: string; stderr: string }> | undefined;
  try {
    host = startHost(f.env);
    await host.ready;
    for (const id of ['manager-a', 'manager-b']) {
      const started = await f.command(f.env, 'manager', 'start', id, '--engine', 'codex', '--budget', '1000');
      expect(started.code).toBe(0);
      expect(started.stderr).toBe('');
    }

    const inboxDb = openDb(join(f.path, 'state.sqlite'));
    try {
      new SqliteManagerInbox(inboxDb, f.path).deliver({
        managerId: 'manager-a',
        kind: 'instruction',
        summary: 'Choose the next task',
      });
    } finally {
      inboxDb.close();
    }

    writeFileSync(stallFile, JSON.stringify({ method: 'thread/goal/set', threadId: 'thread-1' }));
    stoppingA = f.command(f.env, 'manager', 'stop', 'manager-a');
    await waitFor(
      () =>
        f
          .rpc()
          .some(
            (request) =>
              request.method === 'thread/goal/set' &&
              request.params.threadId === 'thread-1' &&
              request.params.status === 'paused',
          ),
      'manager A pause to reach the stalled provider',
    );

    const managerEnv = { ...f.env, GOAL_MANAGER: 'manager-a' };
    const decisionStartedAt = Date.now();
    expect((await f.command(managerEnv, 'manager', 'decision', 'manager-a')).code).toBe(0);
    expect((await f.command(managerEnv, 'manager', 'decision', 'manager-a')).code).toBe(0);
    expect(Date.now() - decisionStartedAt).toBeLessThan(800);
    const readStartedAt = Date.now();
    const read = await f.command(managerEnv, 'inbox', 'read', 'manager-a');
    expect(Date.now() - readStartedAt).toBeLessThan(800);
    expect(read.code).toBe(0);
    const entries = JSON.parse(read.stdout) as { id: number; event: { summary: string } }[];
    expect(entries.map((entry) => entry.event.summary)).toEqual(['Choose the next task']);
    const ackStartedAt = Date.now();
    const ack = await f.command(managerEnv, 'inbox', 'ack', 'manager-a', String(entries[0]!.id));
    expect(Date.now() - ackStartedAt).toBeLessThan(800);
    expect(ack.code).toBe(0);
    expect((await f.command(managerEnv, 'inbox', 'read', 'manager-a')).stdout).toBe('[]\n');

    const settings = {
      ...h.settings,
      stateDirectory: f.path,
      worktreeRoot: join(f.path, 'trees'),
      integration: {
        ...h.settings.integration,
        managerSocket: join(f.path, 'manager.sock'),
        inboxDirectory: join(f.path, 'inboxes'),
        managerDirectory: join(f.path, 'managers'),
      },
    };
    const commandDb = openDb(join(f.path, 'state.sqlite'));
    const store = new WorkerStore(commandDb);
    const tasks = new WorkerTasks(settings, store);
    const scopedBrief = readFileSync(h.briefFile, 'utf8').replace('goal: fixture', 'goal: manager-a');
    const blockerBrief = join(h.settings.stateDirectory, 'blocker.md');
    writeFileSync(blockerBrief, scopedBrief);
    const blocker = tasks.dispatch(blockerBrief);
    const blockedBrief = join(h.settings.stateDirectory, 'blocked.md');
    writeFileSync(blockedBrief, scopedBrief.replace('waiting: []', `waiting: []\nafter: ["${blocker.id}"]`));
    const oldManager = process.env.GOAL_MANAGER;
    const output: string[] = [];
    const oldLog = console.log;
    process.env.GOAL_MANAGER = 'manager-a';
    console.log = (...values: unknown[]) => output.push(values.join(' '));
    let dispatched = 1;
    try {
      let transferredDatabaseToCli = false;
      try {
        dispatched = await run(['dispatch', blockedBrief], () => {
          transferredDatabaseToCli = true;
          return createRuntime({ settings, db: commandDb, tasks });
        });
      } finally {
        if (!transferredDatabaseToCli) commandDb.close();
      }
    } finally {
      console.log = oldLog;
      if (oldManager === undefined) delete process.env.GOAL_MANAGER;
      else process.env.GOAL_MANAGER = oldManager;
    }
    expect(dispatched).toBe(0);
    expect(output).toHaveLength(1);
    const createdTaskId = output[0]!;

    const stopBStartedAt = Date.now();
    const stoppedB = await f.command(f.env, 'manager', 'stop', 'manager-b');
    expect(stoppedB.code).toBe(0);
    expect(stoppedB.stderr).toBe('');
    expect(Date.now() - stopBStartedAt).toBeLessThan(800);

    rmSync(stallFile, { force: true });
    const stoppedA = await stoppingA;
    expect(stoppedA.code).toBe(0);
    await waitFor(() => {
      const db = openDb(join(f.path, 'state.sqlite'));
      try {
        const row = db.query('SELECT state FROM manager_sessions WHERE id = ?').get('manager-a') as { state: string };
        const state = JSON.parse(row.state) as {
          activeTurnId: string | null;
          turnsWithoutDecision: number;
          decision: boolean;
        };
        return state.activeTurnId === null && state.turnsWithoutDecision === 0 && state.decision;
      } finally {
        db.close();
      }
    }, 'manager A decision to be applied to its completed turn');

    const verifyDb = openDb(join(f.path, 'state.sqlite'));
    try {
      const decisions = verifyDb
        .query('SELECT thread_id, turn_id FROM manager_turn_decisions WHERE manager = ?')
        .all('manager-a') as { thread_id: string | null; turn_id: string | null }[];
      expect(decisions).toEqual([{ thread_id: 'thread-1', turn_id: 'turn-1' }]);
      const verifyStore = new WorkerStore(verifyDb);
      expect(verifyStore.taskIds()).toHaveLength(2);
      expect(verifyStore.task(createdTaskId).state).toBe('held');
      expect(verifyStore.attempts(createdTaskId)).toEqual([]);
    } finally {
      verifyDb.close();
    }
    expect(f.rpc().filter((request) => request.method === 'thread/start')).toHaveLength(2);
    expect(f.rpc().some((request) => request.method === 'decision')).toBe(false);
    expect(host.child.exitCode).toBeNull();
  } finally {
    rmSync(stallFile, { force: true });
    if (stoppingA) await stoppingA.catch(() => {});
    await stopHost(host);
    h.dispose();
    f.close();
  }
}, 20_000);

test('the manager socket accepts another manager while recovery waits on a provider request', async () => {
  const f = hostFixture({ FAKE_RPC_TIMEOUT_MS: '2500' });
  const stallFile = join(f.path, 'stall.json');
  let initial: Hosted | undefined;
  let recovering: Hosted | undefined;
  try {
    initial = startHost(f.env);
    await initial.ready;
    for (const id of ['manager-a', 'manager-b']) {
      const started = await f.command(f.env, 'manager', 'start', id, '--engine', 'codex', '--budget', '1000');
      expect(started.code).toBe(0);
    }
    await stopHost(initial);
    initial = undefined;

    writeFileSync(stallFile, JSON.stringify({ method: 'thread/resume', threadId: 'thread-1' }));
    recovering = startHost({ ...f.env, FAKE_RPC_STALL_FILE: stallFile });
    await Promise.race([
      recovering.ready,
      delay(800).then(() => {
        throw new Error('host waited for manager recovery before listening');
      }),
    ]);
    await waitFor(
      () => f.rpc().some((request) => request.method === 'thread/resume' && request.params.threadId === 'thread-1'),
      'manager A recovery to reach the stalled provider',
    );

    const startedAt = Date.now();
    const stoppedB = await f.command(f.env, 'manager', 'stop', 'manager-b');
    expect(stoppedB.code).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(800);
    expect(recovering.child.exitCode).toBeNull();
    const db = openDb(join(f.path, 'state.sqlite'));
    try {
      const row = db.query('SELECT state FROM manager_sessions WHERE id = ?').get('manager-b') as { state: string };
      expect(JSON.parse(row.state).status).toBe('paused');
    } finally {
      db.close();
    }
  } finally {
    rmSync(stallFile, { force: true });
    await stopHost(recovering);
    await stopHost(initial);
    f.close();
  }
}, 15_000);

test('the public completion command reports the completed verification result', async () => {
  const f = hostFixture();
  let host: Hosted | undefined;
  try {
    host = startHost(f.env);
    await host.ready;
    const started = await f.command(f.env, 'manager', 'start', 'manager-a', '--engine', 'codex', '--budget', '1000');
    expect(started.code).toBe(0);

    const completed = await f.command(f.env, 'manager', 'complete', 'manager-a');
    expect(completed.code).toBe(1);
    expect(completed.stderr).toBe('');
    const db = openDb(join(f.path, 'state.sqlite'));
    try {
      const row = db.query('SELECT state FROM manager_sessions WHERE id = ?').get('manager-a') as { state: string };
      expect(JSON.parse(row.state).status).toBe('running');
      expect(new SqliteManagerInbox(db, f.path).pending('manager-a').map((entry) => entry.event.kind)).toEqual([
        'goal-unmet',
      ]);
    } finally {
      db.close();
    }
  } finally {
    await stopHost(host);
    f.close();
  }
}, 10_000);

test('manager host requests retry absent sockets only during setup and clean up timeout and early-close paths', async () => {
  const f = temporaryDirectory();
  const lateSocket = short(join(f.path, 'late.sock'));
  const timeoutSocket = short(join(f.path, 'timeout.sock'));
  const earlySocket = short(join(f.path, 'early.sock'));
  let lateRequests = 0;
  let timeoutRequests = 0;
  let timeoutClosed: (() => void) | undefined;
  const timeoutClientClosed = new Promise<void>((resolve) => (timeoutClosed = resolve));
  let unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  let lateServer: Server | undefined;
  let timeoutServer: Server | undefined;
  let earlyServer: Server | undefined;
  try {
    const lateResponse = hostRequest(lateSocket, { command: 'decision', manager: 'manager-a' }, 700, 10);
    await delay(60);
    lateServer = await listen(lateSocket, (socket) => {
      const lines = createInterface({ input: socket });
      lines.once('line', () => {
        lateRequests++;
        socket.end(`${JSON.stringify({ result: 'recovered' })}\n`);
      });
    });
    expect(await lateResponse).toBe('recovered');
    expect(lateRequests).toBe(1);
    await closeServer(lateServer);
    lateServer = undefined;

    timeoutServer = await listen(timeoutSocket, (socket) => {
      const lines = createInterface({ input: socket });
      lines.once('line', () => timeoutRequests++);
      socket.once('close', () => timeoutClosed?.());
    });
    let timeoutError: unknown;
    try {
      await hostRequest(timeoutSocket, { command: 'decision', manager: 'manager-a' }, 80, 10);
    } catch (error) {
      timeoutError = error;
    }
    expect((timeoutError as Error).message).toBe('Manager host request timed out after 80ms');
    await Promise.race([
      timeoutClientClosed,
      delay(500).then(() => {
        throw new Error('timed-out client stayed open');
      }),
    ]);
    expect(timeoutRequests).toBe(1);
    await closeServer(timeoutServer);
    timeoutServer = undefined;

    let earlyConnections = 0;
    earlyServer = await listen(earlySocket, (socket) => {
      earlyConnections++;
      socket.end();
    });
    let earlyError: unknown;
    try {
      await hostRequest(earlySocket, { command: 'decision', manager: 'manager-a' }, 300, 10);
    } catch (error) {
      earlyError = error;
    }
    expect((earlyError as Error).message).toMatch(/closed without a response|EPIPE|ECONNRESET/);
    expect(earlyConnections).toBe(1);
    await delay(50);
    expect(unhandled).toEqual([]);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    if (lateServer) await closeServer(lateServer);
    if (timeoutServer) await closeServer(timeoutServer);
    if (earlyServer) await closeServer(earlyServer);
    f.close();
  }
}, 10_000);

test('a timed-out absent-socket request leaves no retry that can reach a later host', async () => {
  const f = temporaryDirectory();
  const path = short(join(f.path, 'future.sock'));
  let accepted = 0;
  let server: Server | undefined;
  try {
    let error: unknown;
    try {
      await hostRequest(path, { command: 'start', spec: managerSpec(f.path, 'manager-a') }, 70, 25);
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).toBe('Manager host request timed out after 70ms');
    server = await listen(path, () => accepted++);
    await delay(100);
    expect(accepted).toBe(0);
  } finally {
    if (server) await closeServer(server);
    f.close();
  }
}, 5_000);

test('a client disconnect during a mutating host request never replays the mutation or crashes the host', async () => {
  const f = hostFixture();
  let host: Hosted | undefined;
  let client: ReturnType<typeof createConnection> | undefined;
  try {
    host = startHost(f.env);
    await host.ready;
    const request: HostRequest = { command: 'start', spec: managerSpec(f.path, 'uncertain-manager') };
    await new Promise<void>((resolve, reject) => {
      client = createConnection(short(join(f.path, 'manager.sock')));
      client.once('error', reject);
      client.once('connect', () => {
        client!.write(`${JSON.stringify(request)}\n`, (error) => {
          if (error) reject(error);
          else {
            client!.destroy();
            resolve();
          }
        });
      });
    });
    await waitFor(() => f.rpc().some((entry) => entry.method === 'thread/start'), 'the uncertain start to execute');
    await waitFor(() => {
      const db = openDb(join(f.path, 'state.sqlite'));
      try {
        const row = db.query('SELECT state FROM manager_sessions WHERE id = ?').get('uncertain-manager') as {
          state: string;
        } | null;
        return Boolean(row && JSON.parse(row.state).status === 'running');
      } finally {
        db.close();
      }
    }, 'the manager start to commit');
    await delay(50);
    expect(f.rpc().filter((entry) => entry.method === 'thread/start')).toHaveLength(1);
    expect(host.child.exitCode).toBeNull();
    expect(host.stderr()).not.toContain('EPIPE');
  } finally {
    client?.destroy();
    await stopHost(host);
    f.close();
  }
}, 10_000);
