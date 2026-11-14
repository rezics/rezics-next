import { expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { createServer as createNetServer } from 'node:net';
import { dirname, join, relative } from 'node:path';
import type { Attempt } from './types.ts';
import { createInterface } from 'node:readline';
import {
  appServerEnvironmentFingerprint,
  attachPool,
  ForeignAppServerEndpointError,
  type AppServer,
  type AppServerAttachment,
  type Notification,
} from './app-server.ts';
import { openDb } from './db.ts';
import { dispatchDailyStepAudit, ensureFlow } from './flow.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { ManagerSessions, type ManagerSpec } from './managers.ts';
import { processIdentity, sameProcess, type ProcessIdentity } from './process.ts';
import { brief, harness, prepareKernelCompilerFixture, temporaryDirectory } from './test-support.ts';
import { createManagerTerminalOwnerLookup, stoppedTaskSweepRetainsOrdinaryProof } from './manager-host.ts';
import { authorizeProof } from './verification.ts';
import { git } from './tasks.ts';
import { hostRequest } from './integration-cli.ts';
import { createTerminalProcessSweep } from './attempt-resources.ts';
import { HOST_UNIT, reportServices } from './service.ts';
import { physicalHistoryPath } from '../../../scripts/check-custody.ts';
import {
  grantWorkerTypingRecovery,
  workerCheckBudgetDirectory,
  workerCheckHostContentTree,
} from './worker-check-budget.ts';

const runtime = join(import.meta.dir, 'fixtures/cli-runtime.ts');
const short = (path: string) => relative(process.cwd(), path);
const tmuxBinary = [process.env.TMUX, '/usr/bin/tmux', '/bin/tmux', 'tmux'].find((candidate) => {
  if (!candidate) return false;
  const result = spawnSync(candidate, ['-V'], { encoding: 'utf8' });
  return result.status === 0;
});

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

type Hosted = { child: ChildProcess; exited: Promise<void>; ready: Promise<void>; pid: number; diagnostics(): string };
function startHost(env: NodeJS.ProcessEnv): Hosted {
  const child = spawn(process.execPath, [runtime, '_manager-host'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  child.stderr?.on('data', (chunk) => {
    diagnostics = `${diagnostics}${String(chunk)}`.slice(-4096);
  });
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
  return { child, exited, ready, pid: child.pid!, diagnostics: () => diagnostics };
}

function hostShutdownEvidence(stateDirectory: string, host: Hosted, identity: ProcessIdentity): string {
  let registry = 'unreadable';
  try {
    registry = readFileSync(join(stateDirectory, 'manager-app-servers.json'), 'utf8');
  } catch (error) {
    registry = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'removed' : String(error);
  }
  let handoff = 'absent';
  try {
    handoff = readFileSync(join(stateDirectory, 'manager-app-servers-handoff.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') handoff = String(error);
  }
  return `app-server ${identity.pid} remains alive; registry=${registry}; handoff=${handoff}; host=${host.diagnostics()}`;
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function installFakeWebSocketCodex(stateDirectory: string): string {
  const executable = join(stateDirectory, 'fake-codex');
  const script = join(import.meta.dir, 'fixtures/fake-websocket-codex.ts');
  writeFileSync(executable, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`);
  chmodSync(executable, 0o755);
  return executable;
}

function startIsolatedTmux(socket: string, session: string, cwd: string): void {
  if (!tmuxBinary) throw new Error('tmux fixture is unavailable');
  const result = spawnSync(tmuxBinary, ['-u', '-S', socket, 'new-session', '-d', '-s', session, '-c', cwd, 'sleep', '300'], {
    encoding: 'utf8',
  });
  if (result.status !== 0)
    throw new Error(result.error?.message || result.stderr || `tmux exited ${result.status}${result.signal ? ` (${result.signal})` : ''}`);
}

function tmux(socket: string, ...argv: string[]): string {
  if (!tmuxBinary) throw new Error('tmux fixture is unavailable');
  const result = spawnSync(tmuxBinary, ['-u', '-S', socket, ...argv], { encoding: 'utf8' });
  if (result.status !== 0)
    throw new Error(result.error?.message || result.stderr || `tmux ${argv.join(' ')} exited ${result.status}`);
  return result.stdout.trim();
}

function jsonLines(path: string): any[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitForJsonLine(path: string, predicate: (entry: any) => boolean, label: string): Promise<any> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const found = jsonLines(path).find(predicate);
    if (found) return found;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function appServerRegistryEntry(stateDirectory: string): { identity: ProcessIdentity; attachment: AppServerAttachment } {
  const records = JSON.parse(readFileSync(join(stateDirectory, 'manager-app-servers.json'), 'utf8')) as {
    identity: ProcessIdentity;
    attachment?: AppServerAttachment;
  }[];
  const entry = records.find((record) => record.attachment?.poolId === 'fake');
  if (!entry?.attachment) throw new Error('Manager host did not record a complete pool app-server attachment');
  return { identity: entry.identity, attachment: entry.attachment };
}

function storedManagerState(stateDirectory: string, id = 'accounts'): Record<string, any> {
  const db = openDb(join(stateDirectory, 'state.sqlite'));
  try {
    const row = db.query('SELECT state FROM manager_sessions WHERE id = ?').get(id) as { state: string } | null;
    if (!row) throw new Error(`Missing stored manager state: ${id}`);
    return JSON.parse(row.state);
  } finally {
    db.close();
  }
}

function managerWindow(socket: string, session: string): string {
  return tmux(socket, 'list-windows', '-t', session, '-F', '#{window_id}\t#{@goal-manager}')
    .split('\n')
    .find((line) => line.endsWith('\taccounts'))
    ?.split('\t')[0] ?? '';
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
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
    recorded = (JSON.parse(readFileSync(appServers, 'utf8')) as (ProcessIdentity | { identity: ProcessIdentity })[]).map(
      (record) => ('identity' in record ? record.identity : record),
    );
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
    const registry = JSON.parse(readFileSync(join(f.path, 'manager-app-servers.json'), 'utf8')) as {
      identity: ProcessIdentity;
    }[];
    server = registry[0]?.identity;
    expect(server).toBeDefined();
    host.child.kill('SIGTERM');
    await host.exited;
    if (server && sameProcess(server)) throw new Error(hostShutdownEvidence(f.path, host, server));
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

test.skipIf(!tmuxBinary)('a routine Goal host restart keeps the pool server endpoint and its tmux viewer', async () => {
  const f = fixture();
  const tmuxDirectory = join(process.cwd(), '.temp');
  mkdirSync(tmuxDirectory, { recursive: true });
  const tmuxSocket = join(tmuxDirectory, `goal-tmux-${randomUUID()}.sock`);
  const session = 'goal-host-lifecycle';
  const rpcPath = join(f.path, 'rpc.jsonl');
  const viewerPath = join(f.path, 'viewers.jsonl');
  const serverStartPath = join(f.path, 'servers.jsonl');
  let first: Hosted | undefined;
  let second: Hosted | undefined;
  try {
    const executable = installFakeWebSocketCodex(f.path);
    Object.assign(f.env, {
      FAKE_APP_SERVER_WEBSOCKET: '1',
      FAKE_CODEX_EXECUTABLE: executable,
      FAKE_RPC_LOG: rpcPath,
      FAKE_SERVER_START_LOG: serverStartPath,
      FAKE_THREAD_STATE: join(f.path, 'threads.json'),
      FAKE_VIEWER_LOG: viewerPath,
      FAKE_TMUX_SOCKET: tmuxSocket,
      FAKE_TMUX_SESSION: session,
    });
    startIsolatedTmux(tmuxSocket, session, f.path);
    first = startHost(f.env);
    await first.ready;
    const started = await f.command('manager', 'start', 'accounts', '--engine', 'codex', '--budget', '1000');
    expect(started.code).toBe(0);
    const originalViewer = await waitForJsonLine(
      viewerPath,
      (entry) => entry.phase === 'attached',
      'the initial tmux viewer to attach to its app-server',
    );
    const originalThread = jsonLines(rpcPath).find((message) => message.method === 'thread/start');
    expect(originalThread).toBeDefined();
    const originalState = storedManagerState(f.path);
    const originalThreadId = originalState.threadId as string;
    expect(originalThreadId).toBeTruthy();
    const originalWindow = managerWindow(tmuxSocket, session);
    expect(originalWindow).not.toBe('');
    const originalPanes = tmux(tmuxSocket, 'list-panes', '-t', originalWindow, '-F', '#{pane_id}');
    const original = appServerRegistryEntry(f.path);
    const originalViewerIdentity = processIdentity(originalViewer.pid);
    expect(originalViewerIdentity).toBeDefined();
    expect(originalViewer.codexHome).toBe(join(f.path, 'codex'));
    expect(originalViewer.argv).toEqual([
      'resume',
      originalThreadId,
      '--remote',
      original.attachment.endpoint,
    ]);
    expect(readFileSync(`/proc/${original.identity.pid}/environ`, 'utf8')).toContain(
      `CODEX_HOME=${join(f.path, 'codex')}\0`,
    );

    const mockSystemctl = async (argv: string[]) => {
      if (argv[0] === 'systemctl' && argv[2] === 'restart' && argv.includes(HOST_UNIT)) {
        first!.child.kill('SIGTERM');
        await first!.exited;
        return { code: 0, output: '' };
      }
      if (argv[0] === 'systemctl' && argv.includes('show'))
        return { code: 0, output: 'LoadState=loaded\nActiveState=active\nSubState=running\nResult=success' };
      return { code: 0, output: '' };
    };
    expect(await reportServices('restart', mockSystemctl, () => {}, undefined, f.path)).toBe(0);
    expect(sameProcess(original.identity)).toBe(true);

    second = startHost(f.env);
    await second.ready;
    const resumed = await waitForJsonLine(
      rpcPath,
      (message) =>
        message.method === 'thread/resume' &&
        message.params.threadId === originalThreadId &&
        message.params.model === 'gpt-6.1-sol',
      'the original manager thread to resume',
    );
    expect(resumed.params.threadId).toBe(originalThreadId);
    const adopted = appServerRegistryEntry(f.path);
    expect(sameIdentityForTest(adopted.identity, original.identity)).toBe(true);
    expect(sameProcess(adopted.identity)).toBe(true);
    expect(adopted.attachment.endpoint).toBe(original.attachment.endpoint);
    expect(adopted.attachment.codexHome).toBe(original.attachment.codexHome);
    expect(adopted.attachment.executable).toBe(original.attachment.executable);
    expect(adopted.attachment.environmentFingerprint).toBe(original.attachment.environmentFingerprint);
    const resumedState = storedManagerState(f.path);
    for (const key of [
      'threadId',
      'status',
      'objective',
      'budget',
      'goalState',
      'promptManifest',
      'pool',
      'engine',
      'effort',
      'goals',
      'supermanager',
      'limits',
      'history',
    ])
      expect(resumedState[key]).toEqual(originalState[key]);
    expect(jsonLines(serverStartPath)).toHaveLength(1);
    expect(jsonLines(rpcPath).filter((message) => message.method === 'thread/start')).toHaveLength(1);
    expect(jsonLines(rpcPath).filter((message) => message.method === 'turn/start')).toHaveLength(1);
    expect(sameProcess(originalViewerIdentity!)).toBe(true);
    expect(jsonLines(viewerPath).filter((entry) => entry.phase === 'started')).toHaveLength(1);
    expect(jsonLines(viewerPath).filter((entry) => entry.phase === 'attached')).toHaveLength(1);
    expect(managerWindow(tmuxSocket, session)).toBe(originalWindow);
    expect(tmux(tmuxSocket, 'list-panes', '-t', originalWindow, '-F', '#{pane_id}')).toBe(originalPanes);
    expect(existsSync(join(f.path, 'manager-app-servers-handoff.json'))).toBe(false);
  } finally {
    await cleanHosted(f.path, second);
    await cleanHosted(f.path, first);
    if (existsSync(tmuxSocket) && tmuxBinary)
      spawnSync(tmuxBinary, ['-u', '-S', tmuxSocket, 'kill-server'], { stdio: 'ignore' });
    rmSync(tmuxSocket, { force: true });
    f.close();
  }
}, 30_000);

test('a foreign or credential-bearing viewer endpoint is refused before connecting', async () => {
  const pool = { id: 'pool', codexHome: '/private/codex-home' };
  const listener = createNetServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const foreignServer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    let foreignIdentity: ProcessIdentity | null = null;
    const identityDeadline = Date.now() + 5000;
    while (!foreignIdentity && Date.now() < identityDeadline) {
      foreignIdentity = processIdentity(foreignServer.pid!);
      if (!foreignIdentity) await Bun.sleep(10);
    }
    expect(foreignIdentity).toBeDefined();
    const attachment: AppServerAttachment = {
      version: 1,
      identity: foreignIdentity!,
      poolId: pool.id,
      codexHome: pool.codexHome,
      executable: 'codex',
      endpoint: 'ws://198.51.100.7:43123',
      environmentFingerprint: appServerEnvironmentFingerprint(pool),
      selectedExecutablePath: '/usr/bin/codex',
      selectedExecutableDevice: 1,
      selectedExecutableInode: 1,
      processExecutablePath: '/usr/bin/codex',
      processExecutableDevice: 1,
      processExecutableInode: 1,
    };
    const endpoint = `ws://127.0.0.1:${(listener.address() as { port: number }).port}`;
    await expect(attachPool(pool, { ...attachment, endpoint })).rejects.toBeInstanceOf(ForeignAppServerEndpointError);
    await expect(attachPool(pool, { ...attachment, endpoint: 'ws://198.51.100.7:43123' })).rejects.toThrow(
      'Refusing non-private app-server endpoint',
    );
    await expect(
      attachPool(pool, { ...attachment, endpoint: 'ws://viewer:secret@127.0.0.1:43123' }),
    ).rejects.toThrow('Refusing non-private app-server endpoint');
  } finally {
    foreignServer.kill('SIGTERM');
    await new Promise<void>((resolve) => foreignServer.once('exit', () => resolve()));
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
});

test('an explicit provider restart and one failed loopback reconnect each rejoin the same stored thread once', async () => {
  const f = fixture();
  let first: Hosted | undefined;
  let second: Hosted | undefined;
  let third: Hosted | undefined;
  const rpcPath = join(f.path, 'rpc.jsonl');
  const serverStartPath = join(f.path, 'servers.jsonl');
  try {
    const executable = installFakeWebSocketCodex(f.path);
    Object.assign(f.env, {
      FAKE_APP_SERVER_WEBSOCKET: '1',
      FAKE_CODEX_EXECUTABLE: executable,
      FAKE_RPC_LOG: rpcPath,
      FAKE_SERVER_START_LOG: serverStartPath,
      FAKE_THREAD_STATE: join(f.path, 'threads.json'),
    });
    first = startHost(f.env);
    await first.ready;
    expect((await f.command('manager', 'start', 'accounts', '--engine', 'codex', '--budget', '1000')).code).toBe(0);
    const originalThread = jsonLines(rpcPath).find((message) => message.method === 'thread/start');
    expect(originalThread).toBeDefined();
    const originalThreadId = storedManagerState(f.path).threadId as string;
    expect(originalThreadId).toBeTruthy();
    const initial = appServerRegistryEntry(f.path);

    signal(initial.identity, 'SIGTERM');
    const providerDeadline = Date.now() + 5000;
    while (sameProcess(initial.identity) && Date.now() < providerDeadline) await Bun.sleep(20);
    expect(sameProcess(initial.identity)).toBe(false);
    first.child.kill('SIGTERM');
    await first.exited;

    second = startHost(f.env);
    await second.ready;
    await waitForJsonLine(
      rpcPath,
      (message) =>
        message.method === 'thread/resume' &&
        message.params.threadId === originalThreadId &&
        message.params.model === 'gpt-6.1-sol',
      'thread recovery after provider replacement',
    );
    const replacement = appServerRegistryEntry(f.path);
    expect(replacement.identity.pid).not.toBe(initial.identity.pid);
    expect(jsonLines(serverStartPath)).toHaveLength(2);

    const unavailablePort = await unusedLoopbackPort();
    const registryPath = join(f.path, 'manager-app-servers.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as { identity: ProcessIdentity; attachment?: AppServerAttachment }[];
    const record = registry.find((entry) => entry.attachment?.poolId === 'fake');
    if (!record?.attachment) throw new Error('Missing provider replacement attachment');
    record.attachment.endpoint = `ws://127.0.0.1:${unavailablePort}`;
    writeFileSync(registryPath, JSON.stringify(registry), { mode: 0o600 });
    second.child.kill('SIGKILL');
    await second.exited;

    third = startHost(f.env);
    await third.ready;
    await waitForJsonLine(
      rpcPath,
      (message) =>
        message.method === 'thread/resume' &&
        message.params.threadId === originalThreadId &&
        message.params.model === 'gpt-6.1-sol',
      'bounded clean rejoin after a failed private endpoint',
    );
    const recovered = appServerRegistryEntry(f.path);
    expect(recovered.identity.pid).not.toBe(replacement.identity.pid);
    expect(jsonLines(serverStartPath)).toHaveLength(3);
    expect(jsonLines(rpcPath).filter((message) => message.method === 'thread/start')).toHaveLength(1);
    expect(jsonLines(rpcPath).filter((message) => message.method === 'turn/start')).toHaveLength(1);
    third.child.kill('SIGTERM');
    await third.exited;
    if (sameProcess(recovered.identity)) throw new Error(hostShutdownEvidence(f.path, third, recovered.identity));
    expect(sameProcess(recovered.identity)).toBe(false);
  } finally {
    await cleanHosted(f.path, third);
    await cleanHosted(f.path, second);
    await cleanHosted(f.path, first);
    f.close();
  }
}, 45_000);

function sameIdentityForTest(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.pid === right.pid && left.start === right.start && left.boot === right.boot && left.group === right.group;
}

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

test('recovery restores all five stale viewers without losing drafts or starting manager turns', async () => {
  const f = temporaryDirectory();
  mkdirSync(f.path, { recursive: true });
  const db = openDb(join(f.path, 'state.sqlite'));
  const inbox = new SqliteManagerInbox(db, f.path);
  const registrations: { id: string; argv: string[]; cwd: string }[] = [];
  const rebindings: { id: string; argv: string[]; cwd: string }[] = [];
  const viewers = new Map<string, { argv: string[]; cwd: string; dead: boolean; draft: string }>();
  const replacements = new Map<string, { argv: string[]; cwd: string; dead: boolean; draft: string }>();
  const threadStarts: string[] = [];
  const turnStarts: { threadId: string; turnId: string }[] = [];
  const requests: { method: string; params: any; pool: string }[] = [];
  const listeners = new Map<string, (notification: Notification) => void>();
  const goalStatuses = new Map<string, string>();
  const poolOne = { id: 'codex-1', codexHome: '/home/edge/.codex-1', executable: '/home/edge/.local/bin/codex' };
  const poolTwo = { id: 'codex', codexHome: '/home/edge/.codex', executable: '/home/edge/.local/bin/codex' };
  const endpoints = new Map([
    [poolOne.codexHome, 'ws://127.0.0.1:33515'],
    [poolTwo.codexHome, 'ws://127.0.0.1:36561'],
  ]);
  const services = {
    command: ['goal'],
    windows: {
      register(id: string, argv: string[], cwd: string) {
        registrations.push({ id, argv, cwd });
        viewers.set(id, { argv, cwd, dead: false, draft: `unsent draft for ${id}` });
        return '@1';
      },
      unregister(id: string) {
        viewers.delete(id);
      },
      rebindIfStale(id: string, argv: string[], cwd: string, options?: { restoreExited?: boolean }) {
        const current = replacements.get(id) ?? viewers.get(id);
        if (!current || current.cwd !== cwd || (current.dead && !options?.restoreExited)) return false;
        const currentRemote = current.argv.indexOf('--remote');
        const nextRemote = argv.indexOf('--remote');
        if (currentRemote < 0 || nextRemote < 0 || current.argv[currentRemote + 1] === argv[nextRemote + 1])
          return false;
        const expected = [...current.argv];
        expected[currentRemote + 1] = argv[nextRemote + 1]!;
        if (JSON.stringify(expected) !== JSON.stringify(argv)) return false;
        replacements.set(id, { argv, cwd, dead: false, draft: '' });
        rebindings.push({ id, argv, cwd });
        return true;
      },
    },
    checkCompletion: async () => ({ passed: false, evidencePath: 'completion.log', summary: 'not complete' }),
    connect: async (pool: { codexHome: string }): Promise<AppServer> => ({
      endpoint: endpoints.get(pool.codexHome)!,
      async request<T>(method: string, params: any): Promise<T> {
        requests.push({ method, params, pool: pool.codexHome });
        if (method === 'thread/start') {
          const threadId = `thread-${threadStarts.length + 1}`;
          threadStarts.push(threadId);
          return { thread: { id: threadId } } as T;
        }
        if (method === 'thread/goal/set') {
          goalStatuses.set(params.threadId, params.status);
          return {
            goal: { status: goalStatuses.get(params.threadId), tokensUsed: 0, timeUsedSeconds: 0, tokenBudget: 1000 },
          } as T;
        }
        if (method === 'turn/start') {
          const turnId = `turn-${turnStarts.length + 1}`;
          turnStarts.push({ threadId: params.threadId, turnId });
          return { turn: { id: turnId } } as T;
        }
        if (method === 'thread/resume') {
          const active = turnStarts.findLast((turn) => turn.threadId === params.threadId);
          return {
            thread: {
              id: params.threadId,
              turns: active ? [{ id: active.turnId, status: 'inProgress' }] : [],
            },
          } as T;
        }
        if (method === 'thread/goal/get')
          return {
            goal: {
              status: goalStatuses.get(params.threadId) ?? 'active',
              tokensUsed: 0,
              timeUsedSeconds: 0,
              tokenBudget: 1000,
            },
          } as T;
        throw new Error(`unexpected RPC ${method}`);
      },
      onNotification(listener) {
        listeners.set(pool.codexHome, listener);
        return () => {
          if (listeners.get(pool.codexHome) === listener) listeners.delete(pool.codexHome);
        };
      },
      close() {},
    }),
  };
  const roles: { id: string; pool: typeof poolOne | typeof poolTwo }[] = [
    { id: 'web', pool: poolOne },
    { id: 'content', pool: poolOne },
    { id: 'performance', pool: poolOne },
    { id: 'semantic', pool: poolTwo },
    { id: 'sprint-scheduling', pool: poolOne },
  ];
  const specs: ManagerSpec[] = roles.map(({ id, pool }) => ({
    id,
    goal: id,
    objective: `Manage ${id}`,
    brief: 'Wait for instructions',
    cwd: f.path,
    engine: 'codex' as const,
    pool,
    budget: 1000,
    effort: 'low' as const,
    supermanager: 'supermanager',
    limits: { turns: 100, turnsWithoutDecision: 100, wallMs: 60_000 },
  }));
  const first = new ManagerSessions(db, inbox, services);
  let recovered: ManagerSessions | undefined;
  try {
    const started = new Map<string, { threadId: string; turnId: string }>();
    for (const spec of specs) {
      const state = await first.start(spec);
      started.set(spec.id, { threadId: state.threadId!, turnId: state.activeTurnId! });
    }
    expect(threadStarts).toHaveLength(5);
    expect(turnStarts).toHaveLength(5);
    await first.close();
    endpoints.set(poolOne.codexHome, 'ws://127.0.0.1:41015');
    endpoints.set(poolTwo.codexHome, 'ws://127.0.0.1:41061');
    recovered = new ManagerSessions(db, inbox, services);
    await recovered.recover();
    for (const spec of specs) {
      const prior = started.get(spec.id)!;
      expect(recovered.get(spec.id)).toMatchObject({
        threadId: prior.threadId,
        activeTurnId: prior.turnId,
        waitingForInbox: false,
        goalState: { status: 'active' },
      });
      expect(replacements.get(spec.id)?.argv).toContain(endpoints.get(spec.pool.codexHome));
      expect(viewers.get(spec.id)?.draft).toBe(`unsent draft for ${spec.id}`);
    }
    expect(registrations).toHaveLength(5);
    expect(rebindings).toHaveLength(5);
    expect(threadStarts).toHaveLength(5);
    expect(turnStarts).toHaveLength(5);
    expect(requests.filter((request) => request.method === 'turn/interrupt')).toHaveLength(0);

    await recovered.recover();
    expect(rebindings).toHaveLength(5);
    expect(turnStarts).toHaveLength(5);
    const webThread = started.get('web')!;
    listeners.get(poolOne.codexHome)?.({
      method: 'turn/completed',
      params: { threadId: webThread.threadId, turn: { id: webThread.turnId, status: 'completed' } },
    });
    await recovered.flush();
    expect(recovered.get('web')).toMatchObject({
      threadId: webThread.threadId,
      activeTurnId: null,
      waitingForInbox: true,
      goalState: { status: 'paused' },
    });
    const webResumeCount = requests.filter(
      (request) => request.method === 'thread/resume' && request.params.threadId === webThread.threadId,
    ).length;
    await recovered.recover();
    expect(
      requests.filter((request) => request.method === 'thread/resume' && request.params.threadId === webThread.threadId),
    ).toHaveLength(webResumeCount);
    expect(recovered.get('web')).toMatchObject({
      threadId: webThread.threadId,
      activeTurnId: null,
      waitingForInbox: true,
    });

    inbox.deliver({ managerId: 'web', kind: 'instruction', summary: 'Continue the same manager thread' });
    await recovered.wake('web');
    await recovered.flush();
    expect(recovered.get('web')).toMatchObject({
      threadId: webThread.threadId,
      activeTurnId: 'turn-6',
      waitingForInbox: false,
    });
    expect(threadStarts).toHaveLength(5);
    expect(turnStarts).toHaveLength(6);
    expect(inbox.notifications('web')).toHaveLength(0);

    listeners.get(poolOne.codexHome)?.({
      method: 'turn/completed',
      params: { threadId: webThread.threadId, turn: { id: 'turn-6', status: 'completed' } },
    });
    await recovered.flush();
    viewers.delete('web');
    replacements.delete('web');
    await recovered.recover();
    expect(registrations).toHaveLength(5);
    expect(viewers.has('web')).toBe(false);
  } finally {
    await recovered?.close();
    await first.close();
    db.close();
    f.close();
  }
}, 10_000);

test('recovery reclaims a parked operator turn without starting a replacement turn', async () => {
  const f = temporaryDirectory();
  mkdirSync(f.path, { recursive: true });
  const db = openDb(join(f.path, 'state.sqlite'));
  const inbox = new SqliteManagerInbox(db, f.path);
  const registrations: { id: string; argv: string[]; cwd: string }[] = [];
  const rebindings: { id: string; argv: string[]; cwd: string }[] = [];
  const viewers = new Map<string, { argv: string[]; cwd: string }>();
  const turnStarts: { threadId: string; turnId: string }[] = [];
  const requests: { method: string; params: any }[] = [];
  const persistedItems: { turnId: string; item: { type: string } }[] = [];
  let notify: ((notification: Notification) => void) | undefined;
  let endpoint = 'ws://127.0.0.1:10001';
  let goalStatus = 'active';
  let activeTurn: { id: string; status: string } | null = null;
  const services = {
    command: ['goal'],
    windows: {
      register(id: string, argv: string[], cwd: string) {
        registrations.push({ id, argv, cwd });
        viewers.set(id, { argv, cwd });
        return '@1';
      },
      unregister(id: string) {
        viewers.delete(id);
      },
      rebindIfStale(id: string, argv: string[], cwd: string) {
        const current = viewers.get(id);
        if (!current) return false;
        const currentRemote = current.argv.indexOf('--remote');
        const nextRemote = argv.indexOf('--remote');
        if (currentRemote < 0 || nextRemote < 0 || current.argv[currentRemote + 1] === argv[nextRemote + 1])
          return false;
        const expected = [...current.argv];
        expected[currentRemote + 1] = argv[nextRemote + 1]!;
        if (JSON.stringify(expected) !== JSON.stringify(argv)) return false;
        viewers.set(id, { argv, cwd });
        rebindings.push({ id, argv, cwd });
        return true;
      },
    },
    checkCompletion: async () => ({ passed: false, evidencePath: 'completion.log', summary: 'not complete' }),
    connect: async (): Promise<AppServer> => ({
      endpoint,
      async request<T>(method: string, params: any): Promise<T> {
        requests.push({ method, params });
        if (method === 'thread/start') return { thread: { id: 'thread-1' } } as T;
        if (method === 'thread/goal/set') {
          goalStatus = params.status;
          return { goal: { status: goalStatus, tokensUsed: 0, timeUsedSeconds: 0, tokenBudget: 1000 } } as T;
        }
        if (method === 'turn/start') {
          const turnId = `turn-${turnStarts.length + 1}`;
          turnStarts.push({ threadId: params.threadId, turnId });
          activeTurn = { id: turnId, status: 'inProgress' };
          return { turn: { id: turnId } } as T;
        }
        if (method === 'thread/resume')
          return { thread: { id: params.threadId, turns: activeTurn ? [activeTurn] : [] } } as T;
        if (method === 'thread/items/list')
          return {
            data: persistedItems.filter((entry) => entry.turnId === params.turnId),
            nextCursor: null,
            backwardsCursor: null,
          } as T;
        if (method === 'thread/goal/get')
          return { goal: { status: goalStatus, tokensUsed: 0, timeUsedSeconds: 0, tokenBudget: 1000 } } as T;
        throw new Error(`unexpected RPC ${method}`);
      },
      onNotification(listener) {
        notify = listener;
        return () => {
          if (notify === listener) notify = undefined;
        };
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
  let recovered: ManagerSessions | undefined;
  try {
    const started = await first.start(spec);
    const threadId = started.threadId!;
    notify?.({
      method: 'turn/completed',
      params: { threadId, turn: { id: started.activeTurnId, status: 'completed' } },
    });
    activeTurn = null;
    await first.flush();
    expect(first.get('accounts')).toMatchObject({
      threadId,
      activeTurnId: null,
      waitingForInbox: true,
      goalState: { status: 'paused' },
    });
    notify?.({
      method: 'turn/started',
      params: { threadId, turn: { id: 'operator-turn', status: 'inProgress' } },
    });
    activeTurn = { id: 'operator-turn', status: 'inProgress' };
    await first.flush();
    expect(first.get('accounts')).toMatchObject({
      threadId,
      activeTurnId: 'operator-turn',
      waitingForInbox: true,
      turnDisposition: { threadId, turnId: 'operator-turn', status: 'inProgress', intent: 'controller-park' },
    });
    await first.close();
    endpoint = 'ws://127.0.0.1:10002';
    recovered = new ManagerSessions(db, inbox, services);
    await recovered.recover();
    expect(recovered.get('accounts')).toMatchObject({
      threadId,
      activeTurnId: 'operator-turn',
      waitingForInbox: true,
      goalState: { status: 'paused' },
    });
    expect(requests.filter((request) => request.method === 'turn/interrupt')).toHaveLength(0);
    expect(requests.filter((request) => request.method === 'thread/resume')).toHaveLength(0);
    expect(turnStarts).toHaveLength(1);
    expect(registrations).toHaveLength(1);
    expect(rebindings).toHaveLength(1);
    expect(rebindings[0]!.argv).toContain(threadId);
    expect(rebindings[0]!.argv).toContain(endpoint);

    persistedItems.push({ turnId: 'operator-turn', item: { type: 'userMessage' } });
    await recovered.recover();
    expect(recovered.get('accounts')).toMatchObject({
      activeTurnId: 'operator-turn',
      waitingForInbox: false,
      turns: 2,
      turnDisposition: { threadId, turnId: 'operator-turn', status: 'inProgress', intent: 'work' },
    });
    expect(requests.filter((request) => request.method === 'thread/items/list')).toHaveLength(2);
    expect(requests.filter((request) => request.method === 'thread/resume')).toHaveLength(1);
    expect(requests.filter((request) => request.method === 'turn/interrupt')).toHaveLength(0);
    activeTurn = null;
    notify?.({
      method: 'turn/completed',
      params: { threadId, turn: { id: 'operator-turn', status: 'completed' } },
    });
    await recovered.flush();
    expect(recovered.get('accounts')).toMatchObject({
      activeTurnId: null,
      waitingForInbox: true,
      turnDisposition: { threadId, turnId: 'operator-turn', status: 'completed', intent: 'work' },
    });
    expect(requests.filter((request) => request.method === 'turn/interrupt')).toHaveLength(0);

    await recovered.recover();
    expect(rebindings).toHaveLength(1);
    inbox.deliver({ managerId: 'accounts', kind: 'instruction', summary: 'Continue the same manager thread' });
    await recovered.wake('accounts');
    await recovered.flush();
    expect(recovered.get('accounts')).toMatchObject({ threadId, activeTurnId: 'turn-2', waitingForInbox: false });
    expect(turnStarts).toEqual([
      { threadId, turnId: 'turn-1' },
      { threadId, turnId: 'turn-2' },
    ]);
    expect(requests.filter((request) => request.method === 'thread/start')).toHaveLength(1);
    expect(inbox.notifications('accounts')).toHaveLength(0);

    activeTurn = null;
    notify?.({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-2', status: 'completed' } } });
    await recovered.flush();
    viewers.delete('accounts');
    await recovered.recover();
    expect(registrations).toHaveLength(1);
    expect(viewers.has('accounts')).toBe(false);
  } finally {
    await recovered?.close();
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

test('an idle daily audit does not hold the resident socket or watchdog behind another SQLite writer', async () => {
  const f = fixture();
  const waiting = join(f.path, 'audit-waiting');
  const locked = join(f.path, 'database-locked');
  const released = join(f.path, 'database-released');
  const heartbeat = join(f.path, 'watchdog-ping');
  const hostScript = join(f.path, 'audit-host.ts');
  const lockScript = join(f.path, 'database-writer.ts');
  const dbPath = join(f.path, 'state.sqlite');
  const auditAt = new Date();
  let host: Hosted | undefined;
  let writer: ChildProcess | undefined;
  try {
    const db = openDb(dbPath);
    ensureFlow(db);
    db.query('INSERT INTO flow_audit_runs(day, task_id) VALUES (?, ?)').run(
      auditAt.toISOString().slice(0, 10),
      'existing-audit',
    );
    db.close();
    const module = (name: string) => JSON.stringify(join(import.meta.dir, name));
    writeFileSync(
      lockScript,
      `import { Database } from 'bun:sqlite';
import { writeFileSync } from 'node:fs';
const db = new Database(${JSON.stringify(dbPath)});
db.exec('BEGIN IMMEDIATE');
writeFileSync(${JSON.stringify(locked)}, '1');
await new Promise(resolve => setTimeout(resolve, 1500));
writeFileSync(${JSON.stringify(released)}, '1');
db.exec('ROLLBACK');
db.close();
`,
    );
    writeFileSync(
      hostScript,
      `import { existsSync, writeFileSync } from 'node:fs';
import { createIntegrationRuntime } from ${module('fixtures/cli-runtime.ts')};
import { serveManagers } from ${module('manager-host.ts')};
import { dispatchDailyStepAudit } from ${module('flow.ts')};
const runtime = createIntegrationRuntime();
runtime.dispatchDailyStepAudit = async () => {
  writeFileSync(${JSON.stringify(waiting)}, '1');
  while (!existsSync(${JSON.stringify(locked)})) await new Promise(resolve => setTimeout(resolve, 10));
  dispatchDailyStepAudit(runtime.db, [], () => { throw new Error('existing audit must not be dispatched'); }, new Date(${JSON.stringify(auditAt.toISOString())}));
};
await serveManagers(runtime);
runtime.db.close();
`,
    );
    const bin = join(f.path, 'bin');
    mkdirSync(bin);
    const notify = join(bin, 'systemd-notify');
    writeFileSync(
      notify,
      `#!/bin/sh
case "$*" in *WATCHDOG=1*) touch ${JSON.stringify(heartbeat)} ;; esac
exit 0
`,
    );
    chmodSync(notify, 0o755);
    f.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
    f.env.NOTIFY_SOCKET = '/fixture/notify';
    f.env.WATCHDOG_USEC = '200000';
    host = {
      child: spawn(process.execPath, [hostScript], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] }),
      exited: Promise.resolve(),
      ready: Promise.resolve(),
      pid: 0,
    };
    host.exited = new Promise<void>((resolve) => host!.child.once('exit', () => resolve()));
    host.pid = host.child.pid!;
    host.ready = new Promise<void>((resolve, reject) => {
      const lines = createInterface({ input: host!.child.stdout! });
      lines.once('line', (line) => {
        lines.close();
        line === 'ready' ? resolve() : reject(new Error(line));
      });
      host!.child.once('exit', (code) => reject(new Error(`audit host exited before ready (${code})`)));
    });
    await host.ready;
    await waitForFlag(waiting, host.child, 'audit wait');
    writer = spawn(process.execPath, [lockScript], { env: f.env, stdio: 'ignore' });
    await waitForFlag(locked, writer, 'database lock');
    const started = performance.now();
    await expect(
      hostRequest(join(f.path, 'manager.sock'), { command: 'decision', manager: 'absent' }, 1000),
    ).rejects.toThrow('Unknown manager');
    expect(performance.now() - started).toBeLessThan(500);
    await waitForFlag(heartbeat, host.child, 'watchdog ping');
    expect(existsSync(released)).toBe(false);
  } finally {
    if (writer && writer.exitCode === null && writer.signalCode === null) {
      const exited = new Promise<void>((resolve) => writer!.once('exit', () => resolve()));
      writer.kill('SIGKILL');
      await exited;
    }
    await cleanHosted(f.path, host);
    f.close();
  }
}, 10_000);

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

function extractedHostScript(path: string, extras = '', serveOptions = '', afterServe = '') {
  const source = (name: string) => JSON.stringify(join(import.meta.dir, name));
  writeFileSync(
    path,
    `
      import { existsSync, writeFileSync } from 'node:fs';
      import { createIntegrationRuntime } from ${source('fixtures/cli-runtime.ts')};
      import { serveManagers } from ${source('manager-host.ts')};
      const runtime = createIntegrationRuntime();
      ${extras}
      await serveManagers(runtime${serveOptions ? `, ${serveOptions}` : ''});
      ${afterServe}
      runtime.db.close();
    `,
  );
}

async function waitForFlag(path: string, child: ChildProcess, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`extracted host exited before ${label} (${child.exitCode ?? child.signalCode})`);
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('extracted host answers while recovery continues and finishes one in-flight request before stop', async () => {
  const f = fixture({ FAKE_GOAL_HOST_SWEEP_MS: '25' });
  const script = join(f.path, 'extracted-host.ts');
  const recoveryStarted = join(f.path, 'recovery-started');
  const requestStarted = join(f.path, 'request-started');
  extractedHostScript(
    script,
    `
      runtime.recoverOrphans = () => {
        writeFileSync(${JSON.stringify(recoveryStarted)}, '1');
        return new Promise(() => {});
      };
      const connect = runtime.managerServices.connect;
      runtime.managerServices.connect = async () => {
        writeFileSync(${JSON.stringify(requestStarted)}, '1');
        await new Promise((resolve) => setTimeout(resolve, 400));
        return connect();
      };
    `,
  );
  let child: ChildProcess | undefined;
  let hostExited: Promise<void> | undefined;
  try {
    child = spawn(process.execPath, [script], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
    hostExited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    await new Promise<void>((resolve, reject) => {
      const lines = createInterface({ input: child!.stdout! });
      lines.once('line', (line) => {
        lines.close();
        line === 'ready' ? resolve() : reject(new Error(line));
      });
      child!.once('exit', (code) => reject(new Error(`extracted host exited before ready (${code})`)));
    });
    await waitForFlag(recoveryStarted, child, 'recovery start');
    await expect(
      hostRequest(join(f.path, 'manager.sock'), { command: 'decision', manager: 'absent' }, 1000),
    ).rejects.toThrow('Unknown manager');
    const starting = f.command('manager', 'start', 'accounts', '--engine', 'codex', '--budget', '1000');
    await waitForFlag(requestStarted, child, 'in-flight start');
    const started = await starting;
    expect(started.stderr).toBe('');
    expect(started.code).toBe(0);
    expect(JSON.parse(started.stdout).threadId).toBe('thread-1');
    rmSync(f.path, { recursive: true, force: true });
    await hostExited;
    expect(existsSync(join(f.path, 'manager.sock'))).toBe(false);
    expect(existsSync(join(f.path, 'manager-app-servers.json'))).toBe(false);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await hostExited;
    }
    await cleanHosted(f.path);
    f.close();
  }
}, 15_000);

test('host serves socket requests while a chunked terminal process inventory is in progress', async () => {
  const f = fixture({ FAKE_GOAL_HOST_SWEEP_MS: '25' });
  const script = join(f.path, 'resource-host.ts');
  const inventoryStarted = join(f.path, 'inventory-started');
  const inventoryBlocked = join(f.path, 'inventory-blocked');
  const inventoryRelease = join(f.path, 'inventory-release');
  const signalReceived = join(f.path, 'signal-received');
  const hostFinished = join(f.path, 'host-finished');
  extractedHostScript(
    script,
    `
      const { defaultPolicy } = await import(${JSON.stringify(join(import.meta.dir, 'policy.ts'))});
      runtime.managerServices.policy = {
        ...defaultPolicy,
        host: { ...defaultPolicy.host, recoveryIntervalMs: 20 },
        containers: { ...defaultPolicy.containers, cleanupIntervalMs: 60000 },
      };
      runtime.db.exec('CREATE TABLE IF NOT EXISTS worker_tasks (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE, current_attempt INTEGER NOT NULL, body TEXT NOT NULL)');
      runtime.db.query('INSERT INTO worker_tasks (id, sequence, current_attempt, body) VALUES (?, 1, 0, ?)').run(
        'terminal-fixture',
        JSON.stringify({ id: 'terminal-fixture', state: 'integrated', worktree: '/tmp/terminal-fixture' }),
      );
      const terminalProcessSweep = {
        inventory: async owners => {
          writeFileSync(${JSON.stringify(inventoryStarted)}, String(owners.length));
          for (let index = 0; index < 128; index++) await new Promise(resolve => setImmediate(resolve));
          writeFileSync(${JSON.stringify(inventoryBlocked)}, '1');
          while (!existsSync(${JSON.stringify(inventoryRelease)})) await new Promise(resolve => setImmediate(resolve));
          return [];
        },
        stop: async () => [],
      };
      process.on('SIGTERM', () => writeFileSync(${JSON.stringify(signalReceived)}, '1'));
    `,
    '{ terminalProcessSweep }',
    `writeFileSync(${JSON.stringify(hostFinished)}, '1');`,
  );
  let child: ChildProcess | undefined;
  let exited: Promise<void> | undefined;
  try {
    child = spawn(process.execPath, [script], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
    exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    await new Promise<void>((resolve, reject) => {
      const lines = createInterface({ input: child!.stdout! });
      lines.once('line', (line) => {
        lines.close();
        line === 'ready' ? resolve() : reject(new Error(line));
      });
      child!.once('exit', (code) => reject(new Error(`resource host exited before ready (${code})`)));
    });
    await waitForFlag(inventoryStarted, child, 'terminal process inventory');
    expect(readFileSync(inventoryStarted, 'utf8')).toBe('1');
    await waitForFlag(inventoryBlocked, child, 'blocked terminal process inventory');
    await expect(
      hostRequest(join(f.path, 'manager.sock'), { command: 'decision', manager: 'absent' }, 1000),
    ).rejects.toThrow('Unknown manager');
    child!.kill('SIGTERM');
    await waitForFlag(signalReceived, child, 'host shutdown signal handler');
    const exitedBeforeReaper = await Promise.race([
      exited!.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    expect(exitedBeforeReaper).toBe(false);
    writeFileSync(inventoryRelease, '1');
    await exited!;
    expect(existsSync(hostFinished)).toBe(true);
  } finally {
    writeFileSync(inventoryRelease, '1');
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await exited;
    }
    await cleanHosted(f.path);
    f.close();
  }
}, 10_000);

test('a host that loaded one tools/goal revision retires once main publishes another, and exits so systemd restarts it', async () => {
  const f = fixture();
  const script = join(f.path, 'retiring-host.ts');
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: f.path, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const publish = (text: string, message: string) => {
    writeFileSync(join(f.path, 'tools/goal/src/a.ts'), text);
    git('add', 'tools/goal');
    git('commit', '-qm', message);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  mkdirSync(join(f.path, 'tools/goal/src'), { recursive: true });
  publish('export const revision = 1;\n', 'Loaded revision');
  extractedHostScript(
    script,
    `
      const { captureLoadedCodeVersion } = await import(${JSON.stringify(join(import.meta.dir, 'runtime-version.ts'))});
      const { defaultPolicy } = await import(${JSON.stringify(join(import.meta.dir, 'policy.ts'))});
      runtime.loadedCodeVersion = captureLoadedCodeVersion(runtime.mainCheckout);
      runtime.codeRetirement = { retiring: false };
      runtime.managerServices.policy = {
        ...defaultPolicy,
        host: { ...defaultPolicy.host, restartIntervalMs: 0, codePollMs: 25 },
      };
    `,
  );
  let child: ChildProcess | undefined;
  let output = '';
  try {
    child = spawn(process.execPath, [script], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = new Promise<number | null>((resolve) => child!.once('close', (code) => resolve(code)));
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      output += chunk;
    });
    await new Promise<void>((resolve, reject) => {
      const lines = createInterface({ input: child!.stdout! });
      lines.once('line', (line) => {
        lines.close();
        line === 'ready' ? resolve() : reject(new Error(line));
      });
      child!.once('exit', (code) => reject(new Error(`retiring host exited before ready (${code})`)));
    });
    publish('export const revision = 2;\n', 'Published revision');
    const code = await Promise.race([
      closed,
      new Promise<'still running'>((resolve) => setTimeout(() => resolve('still running'), 10_000)),
    ]);
    expect(code).toBe(0);
    expect(output).toContain('tools/goal is published as');
    expect(existsSync(join(f.path, 'manager.sock'))).toBe(false);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await cleanHosted(f.path);
    f.close();
  }
}, 20_000);

test('the stopped-task sweep retains only the live owned ordinary-proof runner', () => {
  const h = harness();
  try {
    const identity = processIdentity();
    if (!identity) throw new Error('test process identity unavailable');
    const commit = git(h.root, ['rev-parse', 'HEAD']);
    git(h.root, ['branch', 'dev', commit]);
    h.store.db.exec('CREATE TABLE manager_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
    const actor = { id: 'operations', sessionId: 'proof-owner-session' };
    h.store.db
      .query('INSERT INTO manager_sessions VALUES (?,?)')
      .run(actor.id, JSON.stringify({ status: 'running', threadId: actor.sessionId }));
    const sourceBrief = brief();
    sourceBrief.acceptance.command = ['bun', 'test', 'fixture.test.ts'];
    const source = h.store.createTask(
      sourceBrief,
      { briefPath: h.briefFile, worktree: h.root, branch: 'main', base: commit },
      'implementation',
    );
    h.store.updateTask({ taskId: source.id, attempt: 0 }, (task) => {
      task.state = 'integrated';
      task.integratedCommit = commit;
    });
    const proofBrief = {
      ...sourceBrief,
      kind: 'verification' as const,
      paths: [],
      proof: { journey: 'Original journey', sourceTasks: [source.id], sourceCommit: commit },
    };
    const authorization = authorizeProof(h.store, h.root, proofBrief, actor, 'operations', 'dev');
    const proof = h.store.createTask(
      proofBrief,
      { briefPath: h.briefFile, worktree: h.root, branch: 'worker/proof', base: commit },
      'implementation',
    );
    const attempt = h.store.nextAttempt({ taskId: proof.id, attempt: 0 }, (n): Attempt => ({
      taskId: proof.id,
      attempt: n,
      state: 'exited',
      profile: { cli: 'codex', model: 'gpt-6-luna', effort: 'high', poolClass: 'codex' },
      pool: 'fixture',
      tableVersion: 'fixture',
      experiment: null,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      process: null,
      driver: null,
      session: 'proof-session',
      logPath: join(h.settings.stateDirectory, 'runs', proof.id, `${n}.jsonl`),
      evidencePath: join(h.settings.stateDirectory, 'evidence', proof.id, String(n)),
      auxiliaryProcesses: [],
      fixRound: 0,
      consulted: false,
      previousFailure: null,
      failure: null,
      escalation: null,
      before: null,
      after: null,
      exitCode: 0,
      result: '',
      blocker: null,
      approaches: [],
    }));
    h.store.updateTask(attempt, (task) => {
      task.proofAuthorization = authorization;
      task.state = 'stopped';
    });
    const checkId = randomUUID();
    mkdirSync(join(h.root, '.temp/goal/checks/results'), { recursive: true });
    writeFileSync(
      join(h.root, '.temp/goal/checks/results', `${checkId}.json`),
      JSON.stringify({
        id: checkId,
        cwd: h.root,
        argv: ['bun', 'test', 'fixture.test.ts'],
        ownership: { taskId: proof.id, attempt: 1 },
        status: 'running',
        runnerHost: hostname(),
        runnerPid: identity.pid,
        runnerIdentity: identity,
        physicalRunId: randomUUID(),
        log: '.temp/goal/checks/original.log',
      }),
    );
    expect(stoppedTaskSweepRetainsOrdinaryProof(h.store.db, proof.id, h.root, identity)).toBe(true);
    expect(
      stoppedTaskSweepRetainsOrdinaryProof(h.store.db, proof.id, h.root, {
        ...identity,
        group: identity.group + 1,
        pid: identity.pid + 1,
      }),
    ).toBe(false);
    h.store.updateAttempt(attempt, (current) => {
      current.terminationIntent = {
        operation: 'stop',
        requestedAt: new Date().toISOString(),
        state: 'complete',
        processIdentity: 'known',
        process: identity,
        auxiliaryProcesses: [],
        settledAt: new Date().toISOString(),
      };
    });
    expect(stoppedTaskSweepRetainsOrdinaryProof(h.store.db, proof.id, h.root, identity)).toBe(false);
  } finally {
    h.dispose();
  }
});

test('the native terminal sweep retains both exact groups and reaps unmatched and superseded groups', async () => {
  const h = harness();
  const runners: { child: ChildProcess; identity: ProcessIdentity; exited: Promise<void> }[] = [];
  try {
    const task = h.tasks.dispatch(h.briefFile);
    prepareKernelCompilerFixture(task.worktree, true);
    mkdirSync(join(task.worktree, 'apps/web/scripts'), { recursive: true });
    mkdirSync(join(task.worktree, 'apps/web/src'), { recursive: true });
    writeFileSync(
      join(task.worktree, 'apps/web/package.json'),
      JSON.stringify({ name: '@rezics/web', scripts: { typecheck: 'bun scripts/typecheck.ts' } }),
    );
    writeFileSync(join(task.worktree, 'apps/web/tsconfig.json'), '{"include":["src/**/*.ts"]}');
    writeFileSync(join(task.worktree, 'apps/web/scripts/typecheck.ts'), 'export {}\n');
    writeFileSync(join(task.worktree, 'apps/web/src/reader.ts'), 'export const reader = true\n');
    git(task.worktree, ['add', 'apps/web']);
    git(task.worktree, ['commit', '-m', 'Prepare Web recovery compiler fixture']);

    const ref = { taskId: task.id, attempt: 1 };
    h.store.db
      .query(
        "UPDATE worker_tasks SET current_attempt=1, body=json_set(body, '$.currentAttempt', 1, '$.state', 'stopped') WHERE id=?",
      )
      .run(task.id);
    h.store.db
      .query('INSERT INTO worker_attempts(task_id, attempt, body) VALUES (?, 1, ?)')
      .run(task.id, JSON.stringify({ taskId: task.id, attempt: 1, state: 'exited' }));
    const actor = { id: task.brief.manager, sessionId: 'native-recovery-session' };
    const budget = workerCheckBudgetDirectory(h.settings.stateDirectory, task.id, ref.attempt);
    mkdirSync(join(budget, 'typing-recovery'), { recursive: true });
    const content = workerCheckHostContentTree(task.worktree);

    const startRunner = async () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        cwd: task.worktree,
        detached: true,
        stdio: 'ignore',
      });
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      const identity = processIdentity(child.pid!);
      if (!identity) throw new Error('native recovery runner has no process identity');
      const runner = { child, identity, exited };
      runners.push(runner);
      return runner;
    };

    const writeRecovery = (
      grant: ReturnType<typeof grantWorkerTypingRecovery>,
      stamp: string,
      runner: ProcessIdentity,
      runnerHost = hostname(),
    ): void => {
      const command = grant.command as string[];
      writeFileSync(
        join(budget, stamp),
        JSON.stringify({
          content,
          includedTypecheck: true,
          exitCode: 0,
          typingRequest: {
            physicalRunId: grant.physicalRunId,
            command,
            localPrepared: [],
            capture: 'physical-command',
          },
          typingRecovery: {
            token: grant.token,
            checkId: grant.checkId,
            physicalRunId: grant.physicalRunId,
          },
        }),
      );
      writeFileSync(join(budget, 'typing-recovery', `${grant.token}.json`), JSON.stringify({ ...grant, stamp }));
      h.store.db.query('INSERT INTO worker_events(task_id,attempt,kind,at,body) VALUES (?,?,?,?,?)').run(
        task.id,
        ref.attempt,
        'typing-recovery-authorized',
        new Date().toISOString(),
        JSON.stringify({
          actor: grant.actor,
          token: grant.token,
          identity: grant.identity,
          command,
          checkId: grant.checkId,
        }),
      );
      const record = {
        version: 1,
        id: grant.checkId,
        cwd: task.worktree,
        argv: command,
        ownership: { taskId: task.id, attempt: ref.attempt },
        physicalRunId: grant.physicalRunId,
        runnerHost,
        runnerPid: runner.pid,
        runnerIdentity: runner,
        status: 'running',
      };
      const resultPath = join(task.worktree, '.temp/goal/checks/results', `${grant.checkId}.json`);
      const physicalPath = physicalHistoryPath(task.worktree, grant.checkId, grant.physicalRunId);
      mkdirSync(dirname(resultPath), { recursive: true });
      mkdirSync(dirname(physicalPath), { recursive: true });
      writeFileSync(resultPath, JSON.stringify(record));
      writeFileSync(physicalPath, JSON.stringify({ ...record, remoteExpected: false }));
    };

    const kernelGrant = grantWorkerTypingRecovery({
      stateDirectory: h.settings.stateDirectory,
      database: h.store.db.filename,
      taskId: task.id,
      attempt: ref.attempt,
      worktree: task.worktree,
      command: ['bun', 'services/kernel/scripts/typecheck.ts'],
      actor,
    });
    const webGrant = grantWorkerTypingRecovery({
      stateDirectory: h.settings.stateDirectory,
      database: h.store.db.filename,
      taskId: task.id,
      attempt: ref.attempt,
      worktree: task.worktree,
      command: ['bun', 'run', '--cwd', 'apps/web', 'typecheck'],
      actor,
    });
    const kernelRunner = await startRunner();
    const webRunner = await startRunner();
    const foreignRunner = await startRunner();
    const unrelatedRunner = await startRunner();
    writeRecovery(kernelGrant, '1', kernelRunner.identity);
    writeRecovery(webGrant, '2', webRunner.identity);

    const foreignGrant = {
      ...kernelGrant,
      token: randomUUID(),
      checkId: randomUUID(),
      physicalRunId: randomUUID(),
    };
    writeRecovery(foreignGrant, '3', foreignRunner.identity, 'foreign-runner');

    const sweep = createTerminalProcessSweep();
    const lookup = createManagerTerminalOwnerLookup(h.store.db, h.settings.stateDirectory);
    const owners = [{ id: task.id, worktree: task.worktree }];
    const first = await sweep.stop(await sweep.inventory(owners), lookup);
    expect(first.map(({ identity }) => identity.pid).sort((a, b) => a - b)).toEqual(
      [foreignRunner, unrelatedRunner].map(({ identity }) => identity.pid).sort((a, b) => a - b),
    );
    expect(sameProcess(kernelRunner.identity)).toBe(true);
    expect(sameProcess(webRunner.identity)).toBe(true);

    const terminalAt = new Date().toISOString();
    for (const path of [
      join(task.worktree, '.temp/goal/checks/results', `${webGrant.checkId}.json`),
      physicalHistoryPath(task.worktree, webGrant.checkId, webGrant.physicalRunId),
    ]) {
      const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      writeFileSync(path, JSON.stringify({ ...record, status: 'finished', exitCode: 0, endedAt: terminalAt }));
    }
    const terminal = await sweep.stop(await sweep.inventory(owners), lookup);
    expect(terminal.map(({ identity }) => identity.pid)).toEqual([webRunner.identity.pid]);
    expect(sameProcess(kernelRunner.identity)).toBe(true);
    expect(sameProcess(webRunner.identity)).toBe(false);

    h.store.db
      .query(
        "UPDATE worker_attempts SET body=json_set(body, '$.terminationIntent', json(?)) WHERE task_id=? AND attempt=1",
      )
      .run(JSON.stringify({ operation: 'cancel' }), task.id);
    expect(lookup(task.id, task.worktree, kernelRunner.identity)).toBe(true);
    h.store.db
      .query("UPDATE worker_attempts SET body=json_remove(body, '$.terminationIntent') WHERE task_id=? AND attempt=1")
      .run(task.id);

    h.store.db
      .query('INSERT INTO worker_attempts(task_id, attempt, body) VALUES (?, 2, ?)')
      .run(task.id, JSON.stringify({ taskId: task.id, attempt: 2, state: 'exited' }));
    h.store.db
      .query(
        "UPDATE worker_tasks SET current_attempt=2, body=json_set(body, '$.currentAttempt', 2, '$.state', 'stopped') WHERE id=?",
      )
      .run(task.id);
    const third = await sweep.stop(await sweep.inventory(owners), lookup);
    expect(third.map(({ identity }) => identity.pid)).toEqual([kernelRunner.identity.pid]);
    expect(sameProcess(kernelRunner.identity)).toBe(false);
    expect(sameProcess(webRunner.identity)).toBe(false);
  } finally {
    for (const runner of runners) {
      if (sameProcess(runner.identity)) runner.child.kill('SIGKILL');
    }
    await Promise.all(runners.map(({ exited }) => exited));
    await h.disposeAsync();
  }
});
