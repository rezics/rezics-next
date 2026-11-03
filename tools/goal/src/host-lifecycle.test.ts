import { expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import type { AppServer } from './app-server.ts';
import { openDb } from './db.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { ManagerSessions, type ManagerSpec } from './managers.ts';
import { processIdentity, sameProcess, type ProcessIdentity } from './process.ts';
import { harness, temporaryDirectory } from './test-support.ts';
import { hostRequest } from './integration-cli.ts';

const runtime = join(import.meta.dir, 'fixtures/cli-runtime.ts');
const short = (path: string) => relative(process.cwd(), path);

function fixture(extra: NodeJS.ProcessEnv = {}) {
  const temporary = temporaryDirectory();
  mkdirSync(temporary.path, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FAKE_GOAL_STATE: short(temporary.path),
    FAKE_GOAL_MAIN: temporary.path,
    ...extra,
  };
  const command = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, runtime, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  return { ...temporary, env, command };
}

type Hosted = { child: ChildProcess; exited: Promise<void>; ready: Promise<void>; pid: number };
function startHost(env: NodeJS.ProcessEnv): Hosted {
  const child = spawn(process.execPath, [runtime, '_manager-host'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const ready = new Promise<void>((resolve, reject) => {
    const lines = createInterface({ input: child.stdout! });
    lines.once('line', (line) => {
      lines.close();
      if (line === 'ready') resolve();
      else reject(new Error(line));
    });
    child.once('exit', (code) => reject(new Error(`host exited before ready (${code})`)));
  });
  return { child, exited, ready, pid: child.pid! };
}

function children(pid: number): ProcessIdentity[] {
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .map((child) => processIdentity(child))
      .filter((child): child is ProcessIdentity => child !== null);
  } catch {
    return [];
  }
}

function hostIdentity(stateDirectory: string): ProcessIdentity | undefined {
  const lease = join(stateDirectory, 'manager.sock.lease');
  try {
    const file = readdirSync(lease).find((name) => name.endsWith('.json'));
    return file ? (JSON.parse(readFileSync(join(lease, file), 'utf8')) as ProcessIdentity) : undefined;
  } catch {
    return undefined;
  }
}

function signal(identity: ProcessIdentity | undefined, value: NodeJS.Signals): void {
  if (identity && sameProcess(identity)) {
    try {
      process.kill(identity.pid, value);
    } catch {}
  }
}

async function cleanHosted(
  stateDirectory: string,
  host?: Hosted,
  knownChildren: ProcessIdentity[] = [],
): Promise<void> {
  const owner = hostIdentity(stateDirectory);
  const appServers = join(stateDirectory, 'manager-app-servers.json');
  let recorded: ProcessIdentity[] = [];
  try {
    recorded = JSON.parse(readFileSync(appServers, 'utf8')) as ProcessIdentity[];
  } catch {}
  const childrenBeforeExit = [
    ...knownChildren,
    ...recorded,
    ...(host ? children(host.pid) : owner ? children(owner.pid) : []),
  ];
  if (host && host.child.exitCode === null && host.child.signalCode === null) {
    host.child.kill('SIGTERM');
    await Promise.race([host.exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    if (host.child.exitCode === null && host.child.signalCode === null) host.child.kill('SIGKILL');
    await host.exited;
  } else if (!host && owner && sameProcess(owner)) {
    signal(owner, 'SIGTERM');
    const deadline = Date.now() + 5000;
    while (sameProcess(owner) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    signal(owner, 'SIGKILL');
  }
  for (const child of childrenBeforeExit) signal(child, 'SIGKILL');
}

test('the app-server a host owns exits with the host', async () => {
  const f = fixture({ FAKE_APP_SERVER_PERSIST: '1' });
  let host: Hosted | undefined;
  let server: ProcessIdentity | undefined;
  try {
    host = startHost(f.env);
    await host.ready;
    const started = await f.command('manager', 'start', 'accounts', '--engine', 'codex', '--budget', '1000');
    expect(started.code).toBe(0);
    server = children(host.pid)[0];
    expect(server).toBeDefined();
    host.child.kill('SIGTERM');
    await host.exited;
    expect(server && sameProcess(server)).toBe(false);
  } finally {
    await cleanHosted(f.path, host, server ? [server] : []);
    f.close();
  }
}, 10_000);

test('a host that finds a recorded app-server of a dead host stops it before resuming threads', async () => {
  const f = fixture({ FAKE_APP_SERVER_PERSIST: '1' });
  let first: Hosted | undefined;
  let second: Hosted | undefined;
  let oldServer: ProcessIdentity | undefined;
  try {
    first = startHost(f.env);
    await first.ready;
    const started = await f.command('manager', 'start', 'accounts', '--engine', 'codex', '--budget', '1000');
    expect(started.code).toBe(0);
    oldServer = children(first.pid)[0];
    expect(oldServer).toBeDefined();
    first.child.kill('SIGKILL');
    await first.exited;
    expect(oldServer && sameProcess(oldServer)).toBe(true);

    const recovery = startHost({ ...f.env, FAKE_APP_SERVER_MUST_STOP_PID: String(oldServer!.pid) });
    second = recovery;
    await second.ready;
    // Socket readiness can precede asynchronous manager recovery.
    const deadline = Date.now() + 5000;
    let resumed: { method: string; oldProcessAlive?: boolean } | undefined;
    while (!resumed) {
      const rpc = readFileSync(join(f.path, 'rpc.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      resumed = rpc.findLast((message) => message.method === 'thread/resume');
      if (resumed) break;
      if (second.child.exitCode !== null || second.child.signalCode !== null)
        throw new Error('Recovery host exited before thread/resume.');
      if (Date.now() >= deadline) throw new Error('Timed out waiting for recovered thread/resume RPC.');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(resumed?.oldProcessAlive).toBe(false);
    expect(sameProcess(oldServer!)).toBe(false);
  } finally {
    await cleanHosted(f.path, second, oldServer ? [oldServer] : []);
    await cleanHosted(f.path, first, oldServer ? [oldServer] : []);
    f.close();
  }
}, 15_000);

test('a replacement host adopts a worker launched after slice tuning fails and can stop that same attempt', async () => {
  const h = harness(`#!/usr/bin/env bun
console.log(JSON.stringify({type:'thread.started',thread_id:'restart-survivor'}));
setInterval(() => {}, 1000);
`);
  const task = h.tasks.dispatch(h.briefFile);
  const bin = join(h.root, '.temp/systemd/bin');
  mkdirSync(bin, { recursive: true });
  const scopeArgs = join(h.root, '.temp/systemd/scope.args');
  writeFileSync(
    join(bin, 'systemctl'),
    '#!/bin/sh\nif [ "$1" = show ]; then printf "0\\n"; exit 0; fi\necho "slice tuning unavailable" >&2\nexit 1\n',
  );
  writeFileSync(
    join(bin, 'systemd-run'),
    `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(scopeArgs)}\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in --user|--scope|--collect|--quiet|--slice=*|--unit=*) shift ;; *) break ;; esac\ndone\n"$@"\nexit 1\n`,
  );
  chmodSync(join(bin, 'systemctl'), 0o755);
  chmodSync(join(bin, 'systemd-run'), 0o755);
  const ready = join(h.root, '.temp/goal/host-ready.json');
  const recovered = join(h.root, '.temp/goal/host-recovered.json');
  const done = join(h.root, '.temp/goal/host-done');
  const hostScript = join(h.root, '.temp/worker-host.ts');
  const module = (name: string) => JSON.stringify(join(import.meta.dir, name));
  writeFileSync(
    hostScript,
    `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSettings } from ${module('config.ts')};
import { openDb } from ${module('db.ts')};
import { WorkerJob } from ${module('job.ts')};
import { WorkerStore } from ${module('store.ts')};
import { WorkerTasks } from ${module('tasks.ts')};
const [root, mode, taskId, readyPath, donePath] = process.argv.slice(2);
const settings = loadSettings({ cwd: root!, env: {} });
const store = new WorkerStore(openDb(join(settings.stateDirectory, 'goal.sqlite')));
const tasks = new WorkerTasks(settings, store);
const job = new WorkerJob(tasks, { enqueue() {} }, { deliver() {} });
const current = () => { const task = store.task(taskId!); return store.attempt({ taskId: taskId!, attempt: task.currentAttempt }); };
let attempt;
if (mode === 'launch') {
  const work = job.start(taskId!);
  for (let n = 0; n < 1000; n++) {
    const task = store.task(taskId!);
    if (task.currentAttempt) {
      const candidate = current();
      if (candidate.process && candidate.state === 'running' && existsSync(candidate.logPath) && readFileSync(candidate.logPath, 'utf8').includes('restart-survivor')) { attempt = candidate; break; }
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (!attempt) throw new Error('worker did not start');
  writeFileSync(readyPath!, JSON.stringify({ hostPid: process.pid, attempt: attempt.attempt, process: attempt.process, logPath: attempt.logPath }));
  await work;
} else {
  attempt = current();
  const work = job.recover(taskId!);
  writeFileSync(readyPath!, JSON.stringify({ hostPid: process.pid, attempt: attempt.attempt, process: attempt.process, logPath: attempt.logPath }));
  await work;
}
writeFileSync(donePath!, 'settled');
store.db.close();
`,
  );

  const environment = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
  const startHost = (mode: string, readyPath: string) =>
    spawn(process.execPath, [hostScript, h.root, mode, task.id, readyPath, done], {
      env: environment,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  const readWhenReady = async (path: string, host: ChildProcess) => {
    for (let n = 0; n < 1000; n++) {
      if (existsSync(path))
        return JSON.parse(readFileSync(path, 'utf8')) as {
          hostPid: number;
          attempt: number;
          process: ProcessIdentity;
          logPath: string;
        };
      if (host.exitCode !== null || host.signalCode !== null)
        throw new Error(`worker host exited before readiness (${host.exitCode ?? host.signalCode})`);
      await Bun.sleep(10);
    }
    throw new Error('timed out waiting for worker host readiness');
  };
  const waitForDone = async () => {
    for (let n = 0; n < 1000; n++) {
      if (existsSync(done)) return readFileSync(done, 'utf8');
      await Bun.sleep(10);
    }
    throw new Error('timed out waiting for worker recovery to settle');
  };
  const stopHost = async (host?: ChildProcess) => {
    if (!host || host.exitCode !== null || host.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => host.once('exit', () => resolve()));
    host.kill('SIGKILL');
    await exited;
  };

  let first: ChildProcess | undefined;
  let replacement: ChildProcess | undefined;
  try {
    first = startHost('launch', ready);
    const launched = await readWhenReady(ready, first);
    expect(launched.attempt).toBe(1);
    expect(readFileSync(scopeArgs, 'utf8').split('\n')).toContain('--scope');
    expect(sameProcess(launched.process)).toBe(true);
    expect(readFileSync(launched.logPath, 'utf8')).toContain('restart-survivor');

    await stopHost(first);
    expect(sameProcess(launched.process)).toBe(true);

    replacement = startHost('recover', recovered);
    const adopted = await readWhenReady(recovered, replacement);
    expect(adopted.attempt).toBe(launched.attempt);
    expect(adopted.process).toEqual(launched.process);
    expect(sameProcess(adopted.process)).toBe(true);
    expect(adopted.logPath).toBe(launched.logPath);
    expect(readFileSync(adopted.logPath, 'utf8')).toContain('restart-survivor');
    expect(
      readFileSync(scopeArgs, 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('--unit=')),
    ).toHaveLength(1);

    await h.tasks.stop(task.id);
    expect(sameProcess(launched.process)).toBe(false);
    expect(await waitForDone()).toBe('settled');
    expect(h.store.task(task.id).state).toBe('stopped');
  } finally {
    await stopHost(replacement);
    await stopHost(first);
    await h.disposeAsync();
  }
}, 30_000);

test('recovery reopens each codex viewer window on the current endpoint', async () => {
  const f = temporaryDirectory();
  mkdirSync(f.path, { recursive: true });
  const db = openDb(join(f.path, 'state.sqlite'));
  const inbox = new SqliteManagerInbox(db, f.path);
  const registrations: { argv: string[]; cwd: string }[] = [];
  let endpoint = 'ws://127.0.0.1:10001';
  const services = {
    command: ['goal'],
    windows: {
      register(_id: string, argv: string[], cwd: string) {
        registrations.push({ argv, cwd });
        return '@1';
      },
      unregister() {},
    },
    checkCompletion: async () => ({ passed: false, evidencePath: 'completion.log', summary: 'not complete' }),
    connect: async (): Promise<AppServer> => ({
      endpoint,
      async request<T>(method: string, params: any): Promise<T> {
        if (method === 'thread/start') return { thread: { id: 'thread-1' } } as T;
        if (method === 'thread/goal/set')
          return { goal: { status: params.status, tokensUsed: 0, timeUsedSeconds: 0 } } as T;
        if (method === 'turn/start') return { turn: { id: 'turn-1' } } as T;
        if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [] } } as T;
        if (method === 'thread/goal/get') return { goal: { status: 'active', tokensUsed: 0, timeUsedSeconds: 0 } } as T;
        throw new Error(`unexpected RPC ${method}`);
      },
      onNotification() {
        return () => {};
      },
      close() {},
    }),
  };
  const spec: ManagerSpec = {
    id: 'accounts',
    goal: 'accounts',
    objective: 'Manage accounts',
    brief: 'Wait for instructions',
    cwd: f.path,
    engine: 'codex',
    pool: { id: 'fixture', codexHome: f.path, executable: 'codex' },
    budget: 1000,
    effort: 'low',
    supermanager: 'supermanager',
    limits: { turns: 100, turnsWithoutDecision: 100, wallMs: 60_000 },
  };
  const first = new ManagerSessions(db, inbox, services);
  try {
    await first.start(spec);
    await first.close();
    endpoint = 'ws://127.0.0.1:10002';
    const recovered = new ManagerSessions(db, inbox, services);
    try {
      await recovered.recover();
    } finally {
      await recovered.close();
    }
    expect(registrations).toHaveLength(2);
    expect(registrations[1]!.argv).toContain(endpoint);
  } finally {
    await first.close();
    db.close();
    f.close();
  }
}, 10_000);

test('a host whose state directory is gone exits', async () => {
  const f = fixture({ FAKE_GOAL_HOST_SWEEP_MS: '25' });
  let host: Hosted | undefined;
  try {
    host = startHost(f.env);
    await host.ready;
    rmSync(f.path, { recursive: true, force: true });
    const exited = await Promise.race([
      host.exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    expect(exited).toBe(true);
  } finally {
    await cleanHosted(f.path, host);
    f.close();
  }
}, 10_000);

test('manager commands request systemd activation and retain its exact failure', async () => {
  const f = fixture();
  const bin = join(f.path, 'bin');
  mkdirSync(bin);
  const calls = join(f.path, 'systemctl.args');
  writeFileSync(
    join(bin, 'systemctl'),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "' + calls + '"\necho "fixture user bus unavailable" >&2\nexit 1\n',
  );
  chmodSync(join(bin, 'systemctl'), 0o755);
  f.env.PATH = bin + ':' + process.env.PATH;
  try {
    for (const command of ['start', 'stop', 'complete', 'decision', 'turn-start', 'turn-end']) {
      const result = await f.command(
        'manager',
        command,
        'accounts',
        ...(command === 'start' ? ['--engine', 'codex', '--budget', '1000'] : []),
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('fixture user bus unavailable');
      expect(hostIdentity(f.path)).toBeUndefined();
    }
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(
      Array(6).fill('--user start rezics-goal-host.service'),
    );
  } finally {
    f.close();
  }
});

test('daily audit validation and dispatch failures are durable and reported once without escaping the real host', async () => {
  for (const failure of ['parse', 'dispatch']) {
    const f = fixture();
    const script = join(f.path, 'audit-host.ts');
    const source = (name: string) => JSON.stringify(join(import.meta.dir, name));
    writeFileSync(
      script,
      `
      import { createIntegrationRuntime } from ${source('fixtures/cli-runtime.ts')};
      import { serveManagers } from ${source('integration-cli.ts')};
      import { dispatchDailyStepAudit } from ${source('flow.ts')};
      import { parseBrief, readRiskOwnership } from ${source('briefs.ts')};
      import { SqliteManagerInbox } from ${source('inbox.ts')};
      import { readFileSync } from 'node:fs';
      const runtime = createIntegrationRuntime();
      const inbox = new SqliteManagerInbox(runtime.db, runtime.stateDirectory);
      runtime.dispatchDailyStepAudit = () => dispatchDailyStepAudit(runtime.db, [], () => {
        ${
          failure === 'parse'
            ? `parseBrief(readFileSync(${JSON.stringify(join(import.meta.dir, '../templates/daily-step-audit.md'))}, 'utf8').replace('daily-step-audit-*.md', '**'), readRiskOwnership(${JSON.stringify(join(import.meta.dir, '../risk-areas.json'))}));`
            : ''
        }
        throw new Error('fixture dispatch failure: original cause');
      }, new Date('2026-10-30T00:00:00Z'), summary => inbox.deliver({ managerId: 'supermanager', kind: 'environment', summary }));
      await serveManagers(runtime);
      runtime.db.close();
    `,
    );
    let child: ChildProcess | undefined;
    const start = async () => {
      child = spawn(process.execPath, [script], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
      await new Promise<void>((resolve, reject) => {
        const lines = createInterface({ input: child!.stdout! });
        lines.once('line', (line) => {
          lines.close();
          line === 'ready' ? resolve() : reject(new Error(line));
        });
        child!.once('exit', (code) => reject(new Error(`audit host exited before ready (${code})`)));
      });
    };
    const stopChild = async () => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((resolve) => child!.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    };
    try {
      await start();
      // A real socket response demonstrates that the host still serves after the thrown audit operation.
      await expect(
        hostRequest(join(f.path, 'manager.sock'), { command: 'decision', manager: 'absent' }, 1000),
      ).rejects.toThrow('Unknown manager');
      await stopChild();
      await start();
      const db = openDb(join(f.path, 'state.sqlite'));
      try {
        const notices = new SqliteManagerInbox(db, f.path).pending('supermanager');
        expect(notices).toHaveLength(1);
        expect(notices[0]!.event.summary).toContain(failure === 'parse' ? 'undeclared risk area' : 'original cause');
        const rows = db.query('SELECT cause, reported_at FROM flow_audit_failures').all() as {
          cause: string;
          reported_at: string | null;
        }[];
        expect(rows).toHaveLength(1);
        expect(rows[0]!.reported_at).not.toBeNull();
        expect(rows[0]!.cause).toContain(
          failure === 'parse' ? 'undeclared risk area' : 'fixture dispatch failure: original cause',
        );
      } finally {
        db.close();
      }
    } finally {
      await stopChild();
      await cleanHosted(f.path);
      f.close();
    }
  }
}, 15_000);
