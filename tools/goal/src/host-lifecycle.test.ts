import { expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { openDb } from './db.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { ManagerSessions, type ManagerSpec } from './managers.ts';
import { processIdentity, sameProcess, type ProcessIdentity } from './process.ts';
import { temporaryDirectory } from './test-support.ts';

const runtime = join(import.meta.dir, 'fixtures/cli-runtime.ts');
const short = (path: string) => relative(process.cwd(), path);

function fixture(extra: NodeJS.ProcessEnv = {}) {
  const temporary = temporaryDirectory();
  mkdirSync(temporary.path, { recursive: true });
  const env = { ...process.env, FAKE_GOAL_STATE: short(temporary.path), FAKE_GOAL_MAIN: temporary.path, ...extra };
  const command = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, runtime, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  return { ...temporary, env, command };
}

type Hosted = { child: ChildProcess; exited: Promise<void>; ready: Promise<void>; pid: number };
function startHost(env: NodeJS.ProcessEnv): Hosted {
  const child = spawn(process.execPath, [runtime, '_manager-host'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  const ready = new Promise<void>((resolve, reject) => {
    const lines = createInterface({ input: child.stdout! });
    lines.once('line', line => {
      lines.close();
      if (line === 'ready') resolve(); else reject(new Error(line));
    });
    child.once('exit', code => reject(new Error(`host exited before ready (${code})`)));
  });
  return { child, exited, ready, pid: child.pid! };
}

function children(pid: number): ProcessIdentity[] {
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/)
      .filter(Boolean).map(Number).map(child => processIdentity(child)).filter((child): child is ProcessIdentity => child !== null);
  } catch { return []; }
}

function hostIdentity(stateDirectory: string): ProcessIdentity | undefined {
  const lease = join(stateDirectory, 'manager.sock.lease');
  try {
    const file = readdirSync(lease).find(name => name.endsWith('.json'));
    return file ? JSON.parse(readFileSync(join(lease, file), 'utf8')) as ProcessIdentity : undefined;
  } catch { return undefined; }
}

function signal(identity: ProcessIdentity | undefined, value: NodeJS.Signals): void {
  if (identity && sameProcess(identity)) {
    try { process.kill(identity.pid, value); } catch {}
  }
}

async function cleanHosted(stateDirectory: string, host?: Hosted, knownChildren: ProcessIdentity[] = []): Promise<void> {
  const serverIdentity = hostIdentity(stateDirectory);
  const childrenBeforeExit = [...knownChildren, ...(host ? children(host.pid) : []), ...(serverIdentity ? [serverIdentity] : [])];
  if (host && host.child.exitCode === null && host.child.signalCode === null) {
    host.child.kill('SIGTERM');
    await Promise.race([host.exited, new Promise(resolve => setTimeout(resolve, 5000))]);
    if (host.child.exitCode === null && host.child.signalCode === null) host.child.kill('SIGKILL');
    await host.exited;
  }
  signal(serverIdentity, 'SIGTERM');
  for (const child of childrenBeforeExit) signal(child, 'SIGKILL');
  const identity = hostIdentity(stateDirectory);
  signal(identity, 'SIGKILL');
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
    const rpc = readFileSync(join(f.path, 'rpc.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    const resumed = rpc.findLast(message => message.method === 'thread/resume');
    expect(resumed?.oldProcessAlive).toBe(false);
    expect(sameProcess(oldServer!)).toBe(false);
  } finally {
    await cleanHosted(f.path, second, oldServer ? [oldServer] : []);
    await cleanHosted(f.path, first, oldServer ? [oldServer] : []);
    f.close();
  }
}, 15_000);

test('recovery reopens each codex viewer window on the current endpoint', async () => {
  const f = temporaryDirectory();
  mkdirSync(f.path, { recursive: true });
  const db = openDb(join(f.path, 'state.sqlite'));
  const inbox = new SqliteManagerInbox(db, f.path);
  const registrations: { argv: string[]; cwd: string }[] = [];
  let endpoint = 'ws://127.0.0.1:10001';
  const services = {
    command: ['goal'],
    windows: { register(_id: string, argv: string[], cwd: string) { registrations.push({ argv, cwd }); return '@1'; }, unregister() {} },
    checkCompletion: async () => ({ passed: false, evidencePath: 'completion.log', summary: 'not complete' }),
    connect: async () => ({ endpoint, async request(method: string, params: any) {
      if (method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (method === 'thread/goal/set') return { goal: { status: params.status, tokensUsed: 0, timeUsedSeconds: 0 } };
      if (method === 'turn/start') return { turn: { id: 'turn-1' } };
      if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [] } };
      if (method === 'thread/goal/get') return { goal: { status: 'active', tokensUsed: 0, timeUsedSeconds: 0 } };
      throw new Error(`unexpected RPC ${method}`);
    }, onNotification() { return () => {}; }, close() {} }),
  };
  const spec: ManagerSpec = { id: 'accounts', goal: 'accounts', objective: 'Manage accounts', brief: 'Wait for instructions',
    cwd: f.path, engine: 'codex', pool: { id: 'fixture', codexHome: f.path, executable: 'codex' }, budget: 1000,
    effort: 'low', supermanager: 'supermanager', limits: { turns: 100, turnsWithoutDecision: 100, wallMs: 60_000 } };
  const first = new ManagerSessions(db, inbox, services);
  try {
    await first.start(spec);
    await first.close();
    endpoint = 'ws://127.0.0.1:10002';
    const recovered = new ManagerSessions(db, inbox, services);
    try { await recovered.recover(); }
    finally { await recovered.close(); }
    expect(registrations).toHaveLength(2);
    expect(registrations[1]!.argv).toContain(endpoint);
  } finally { await first.close(); db.close(); f.close(); }
}, 10_000);

test('a host whose state directory is gone exits', async () => {
  const f = fixture({ FAKE_GOAL_HOST_SWEEP_MS: '25' });
  let host: Hosted | undefined;
  try {
    host = startHost(f.env);
    await host.ready;
    rmSync(f.path, { recursive: true, force: true });
    const exited = await Promise.race([host.exited.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 500))]);
    expect(exited).toBe(true);
  } finally {
    await cleanHosted(f.path, host);
    f.close();
  }
}, 10_000);

test('every manager command starts the host when it is not running', async () => {
  const subcommands: [string, string[]][] = [
    ['start', ['--engine', 'codex', '--budget', '1000']],
    ['stop', []], ['complete', []], ['decision', []], ['turn-start', []], ['turn-end', []],
  ];
  for (const [subcommand, flags] of subcommands) {
    const f = fixture();
    try {
      const result = await f.command('manager', subcommand, 'accounts', ...flags);
      const owner = hostIdentity(f.path);
      expect(owner, `${subcommand} did not start a manager host; command output: ${result.stderr}`).toBeDefined();
      expect(sameProcess(owner!)).toBe(true);
      expect(result.stderr).not.toContain('ENOENT');
    } finally {
      await cleanHosted(f.path);
      f.close();
    }
  }
}, 30_000);
