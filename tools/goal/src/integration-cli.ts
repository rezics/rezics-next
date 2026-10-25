import type { Database } from 'bun:sqlite';
import { spawn } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AttemptFence, GateOutcomeSink, LandingRequest, ManagerEventKind } from './contracts.ts';
import { SqliteLandingQueue } from './land.ts';
import { MergeTrain } from './merge-train.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { ManagerSessions, type ManagerServices, type ManagerSpec } from './managers.ts';
import { acquireDirectoryLease } from './lease.ts';

/** Composition belongs to the caller; this module never reads worker configuration or tables. */
export type IntegrationRuntime = {
  queue?: SqliteLandingQueue; inbox?: SqliteManagerInbox; pump?(): Promise<void>; drain?(): Promise<void>; hostCommand?: string[];
  codeIsCurrent?(): boolean; recoverOrphans?(): Promise<void>;
  db: Database; mainCheckout: string; stateDirectory: string; worktreeRoot: string; managerSocket: string;
  supermanager?: string;
  fence: AttemptFence; sink: GateOutcomeSink;
  landing(task: string): LandingRequest;
  manager(goal: string, engine: 'codex' | 'claude', budget: number): ManagerSpec;
  managerServices: ManagerServices;
};
export type HostRequest = { command: 'start' | 'stop' | 'complete' | 'decision' | 'turn-start' | 'turn-end';
  manager?: string; spec?: ManagerSpec };

export function hostRequest(socketPath: string, request: HostRequest): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.setTimeout(60_000, () => socket.destroy(new Error('Manager host request timed out')));
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('error', reject);
    createInterface({ input: socket }).once('line', line => {
      socket.end();
      try {
        const response = JSON.parse(line);
        if (response.error) reject(new Error(response.error)); else resolve(response.result);
      } catch (error) { reject(error); }
    });
    socket.on('end', () => reject(new Error('Manager host closed without a response')));
  });
}

async function ensureHost(runtime: IntegrationRuntime): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(runtime.managerSocket);
      socket.on('connect', () => { socket.end(); resolve(); }); socket.on('error', reject);
    });
    return;
  } catch {}
  const argv = [...(runtime.hostCommand ?? [process.execPath, join(runtime.mainCheckout, 'tools/goal/src/cli.ts')]), '_manager-host'];
  mkdirSync(runtime.stateDirectory, { recursive: true });
  const logPath = join(runtime.stateDirectory, 'manager-host.log');
  const log = openSync(logPath, 'a', 0o600);
  const child = spawn(argv[0]!, argv.slice(1), { env: process.env, detached: true, stdio: ['ignore', 'pipe', log] });
  closeSync(log);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Manager host startup timed out')); }, 45_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Manager host exited (${code}): ${readFileSync(logPath, 'utf8').slice(-4000)}`)); });
    const lines = createInterface({ input: child.stdout! });
    lines.once('line', line => {
      clearTimeout(timeout); lines.close();
      if (line !== 'ready') { child.kill(); reject(new Error(`Manager host startup: ${line}`)); return; }
      child.stdout!.destroy(); child.unref(); resolve();
    });
  });
}

export async function serveManagers(runtime: IntegrationRuntime): Promise<void> {
  const lease = acquireDirectoryLease(`${runtime.managerSocket}.lease`);
  const inbox = runtime.inbox ?? new SqliteManagerInbox(runtime.db, runtime.stateDirectory);
  const managers = new ManagerSessions(runtime.db, inbox, runtime.managerServices);
  rmSync(runtime.managerSocket, { force: true });
  let activeRequests = 0, restart = false, stopServer: (() => void) | undefined;
  let stopRequested = false;
  const stopWhenIdle = () => { if (stopRequested && activeRequests === 0) stopServer?.(); };
  const requestRestart = () => {
    restart = true; stopRequested = true;
    server.close();
    stopWhenIdle();
  };
  const server = createServer(socket => {
    const lines = createInterface({ input: socket });
    lines.once('line', async line => {
      activeRequests++;
      let completed = false;
      const completeRequest = () => {
        if (completed) return;
        completed = true; activeRequests--; stopWhenIdle();
      };
      socket.once('close', completeRequest);
      if (restart) { socket.end(`${JSON.stringify({ error: 'Manager host is restarting' })}\n`, completeRequest); return; }
      try {
        const request = JSON.parse(line) as HostRequest;
        let result: unknown;
        switch (request.command) {
          case 'start': if (!request.spec) throw new Error('Missing manager spec'); result = await managers.start(request.spec); break;
          case 'stop': result = await managers.stop(request.manager!); break;
          case 'complete': result = await managers.complete(request.manager!); break;
          case 'decision': result = await managers.noteCommand(request.manager!); break;
          case 'turn-start': result = await managers.claudeTurn(request.manager!, true); break;
          case 'turn-end': result = await managers.claudeTurn(request.manager!, false); break;
          default: throw new Error('Unknown manager host command');
        }
        socket.end(`${JSON.stringify({ result: result ?? null })}\n`, completeRequest);
      } catch (error) { socket.end(`${JSON.stringify({ error: String(error) })}\n`, completeRequest); }
    });
    socket.on('error', () => {});
  });
  let checkTimer: ReturnType<typeof setInterval> | undefined;
  let recoveryTimer: ReturnType<typeof setInterval> | undefined;
  let recovery: Promise<void> | undefined;
  const recoverOrphans = () => {
    if (!runtime.recoverOrphans) return Promise.resolve();
    if (!recovery) {
      const current = runtime.recoverOrphans().finally(() => { if (recovery === current) recovery = undefined; });
      recovery = current;
    }
    return recovery;
  };
  try {
    await recoverOrphans();
    await managers.recover();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(runtime.managerSocket, resolve); });
    chmodSync(runtime.managerSocket, 0o600);
    console.log('ready');
    recoveryTimer = setInterval(() => { void recoverOrphans().catch(() => {}); }, 60_000);
    recoveryTimer.unref();
    await new Promise<void>(resolve => {
      stopServer = resolve;
      const stop = () => { stopRequested = true; stopWhenIdle(); };
      process.once('SIGTERM', stop); process.once('SIGINT', stop);
      if (runtime.codeIsCurrent) {
        checkTimer = setInterval(() => {
          try { if (!runtime.codeIsCurrent!()) requestRestart(); } catch {}
        }, 1000);
        checkTimer.unref();
        try { if (!runtime.codeIsCurrent()) requestRestart(); } catch {}
      }
    });
  } finally {
    if (recoveryTimer) clearInterval(recoveryTimer);
    if (checkTimer) clearInterval(checkTimer);
    server.close(); await managers.close(); rmSync(runtime.managerSocket, { force: true }); lease.release();
  }
  if (restart) {
    const argv = [...(runtime.hostCommand ?? [process.execPath, join(runtime.mainCheckout, 'tools/goal/src/cli.ts')]), '_manager-host'];
    const child = spawn(argv[0]!, argv.slice(1), { cwd: runtime.mainCheckout, env: process.env, detached: true, stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
  }
}

export async function runIntegration(argv: string[], runtime: IntegrationRuntime): Promise<number> {
  const [command, subcommand, id, ...flags] = argv;
  const inbox = runtime.inbox ?? new SqliteManagerInbox(runtime.db, runtime.stateDirectory);
  const queue = runtime.queue ?? new SqliteLandingQueue(runtime.db, runtime.fence);
  if (command === 'land' && subcommand) {
    await recordManagerCommand(runtime);
    queue.enqueue(runtime.landing(subcommand));
    if (runtime.pump) { await runtime.pump(); await runtime.drain?.(); }
    return 0;
  }
  if (command === 'train') { await recordManagerCommand(runtime); if (runtime.pump) { await runtime.pump(); await runtime.drain?.(); }
    else await new MergeTrain({ ...runtime, queue }).run(); return 0; }
  if (command === '_manager-host') { await serveManagers(runtime); return 0; }
  if (command === 'inbox' && id) {
    if (subcommand === 'send') {
      const [kind, summary, ...options] = flags;
      if (!kind || !summary) throw new Error('usage: inbox send <manager> <kind> <summary> [--task <task>] [--evidence <path>]');
      const values = new Map<string, string>();
      for (let index = 0; index < options.length; index += 2) {
        const option = options[index]; const value = options[index + 1];
        if ((option !== '--task' && option !== '--evidence') || !value || values.has(option)) throw new Error(`invalid inbox send option: ${option ?? '(missing value)'}`);
        values.set(option, value);
      }
      const allowed = ['spec-conflict', 'scope-growth', 'environment', 'round-limit', 'stalled', 'failed-after-consult', 'goal-unmet', 'goal-met', 'instruction'];
      if (!allowed.includes(kind)) throw new Error(`unknown inbox event kind: ${kind}. Valid kinds: ${allowed.join(', ')}`);
      if (/[\r\n]/.test(summary)) throw new Error('inbox event summary must be one line');
      await recordManagerCommand(runtime);
      inbox.deliver({ managerId: id, kind: kind as ManagerEventKind, summary,
        from: process.env.GOAL_MANAGER || runtime.supermanager || 'supermanager',
        ...(values.has('--task') ? { taskId: values.get('--task')! } : {}),
        ...(values.has('--evidence') ? { evidencePath: values.get('--evidence')! } : {}) });
    } else {
      await recordManagerCommand(runtime);
      if (subcommand === 'wait') console.log(JSON.stringify(await inbox.wait(id)));
      else if (subcommand === 'read') console.log(JSON.stringify(inbox.read(id)));
      else if (subcommand === 'ack') inbox.acknowledge(id, flags.length ? flags.map(Number) : undefined);
      else throw new Error(`unknown inbox command: ${subcommand ?? '(missing)'}`);
    }
    return 0;
  }
  if (command === 'manager' && id) {
    if (subcommand === 'start') {
      const option = (name: string) => flags[flags.indexOf(name) + 1];
      const engine = option('--engine'); const budget = Number(option('--budget'));
      if (!flags.includes('--engine') || (engine !== 'codex' && engine !== 'claude') || !flags.includes('--budget') || !Number.isSafeInteger(budget) || budget <= 0)
        throw new Error('usage: manager start <goal> --engine <codex|claude> --budget <positive integer>');
      await ensureHost(runtime);
      await recordManagerCommand(runtime);
      console.log(JSON.stringify(await hostRequest(runtime.managerSocket, { command: 'start', spec: runtime.manager(id, engine, budget) })));
    } else if (subcommand && ['stop', 'complete', 'decision', 'turn-start', 'turn-end'].includes(subcommand)) {
      if (subcommand === 'complete' || subcommand === 'stop') await recordManagerCommand(runtime);
      const result = await hostRequest(runtime.managerSocket, { command: subcommand as HostRequest['command'], manager: id });
      if (subcommand === 'complete' && result === false) return 1;
    } else throw new Error(`unknown manager command: ${subcommand ?? '(missing)'}`);
    return 0;
  }
  throw new Error(`invalid command arguments: ${argv.join(' ')}`);
}

/** Public control-plane command modules use this to attribute a manager's command to its turn. */
export async function recordManagerCommand(runtime: IntegrationRuntime): Promise<void> {
  let manager = process.env.GOAL_MANAGER;
  if (!manager && process.env.CODEX_THREAD_ID) {
    if (!runtime.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'manager_sessions'").get()) return;
    const rows = runtime.db.query("SELECT state FROM manager_sessions").all() as { state: string }[];
    manager = rows.map(row => JSON.parse(row.state)).find(state => state.threadId === process.env.CODEX_THREAD_ID)?.id;
  }
  if (manager && existsSync(runtime.managerSocket)) await hostRequest(runtime.managerSocket, { command: 'decision', manager });
}
