import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { connectPool, StdioAppServer, type AppServer } from './app-server.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { ManagerSessions, type ManagerSpec } from './managers.ts';
import { authenticatedManager } from './priority-authority.ts';
import { runWorkerCommand } from './worker-commands.ts';
import { workerEnvironment } from './launch.ts';
import type { Attempt, Pool } from './types.ts';
import { harness, markdown, temporaryDirectory } from './test-support.ts';
import { openDb } from './db.ts';

const capturedKeys = [
  'PATH',
  'HOME',
  'CODEX_HOME',
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDECODE',
  'CLAUDE_PARENT_ONLY_HINT',
  'CLAUDE_CUSTOM_RUNTIME_HINT',
  'GOAL_MANAGER',
  'GOAL_TASK_ID',
  'GOAL_ATTEMPT',
  'GOAL_CHECK_WAIT_FILE',
  'GOAL_MAIN_CHECKOUT',
  'GOAL_LOCAL_CONFIG',
  'GOAL_STATE_DIRECTORY',
  'FAKE_PROVIDER_CAPTURE',
];

const fakeCodex = String.raw`#!/usr/bin/env bun
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const keys = ${JSON.stringify(capturedKeys)};
function environment() {
  const value = {};
  for (const key of keys) if (process.env[key] !== undefined) value[key] = process.env[key];
  return value;
}
function record(value) {
  appendFileSync(process.env.FAKE_PROVIDER_CAPTURE, JSON.stringify(value) + String.fromCharCode(10));
}
if (args[0] !== 'app-server') {
  const resumed = args[0] === 'resume';
  record({ kind: resumed ? 'codex-viewer' : 'codex-worker', argv: args, env: environment() });
  const resume = args.indexOf('resume');
  const threadId = resumed
    ? args[resume + 1]
    : process.env.GOAL_TASK_ID && process.env.GOAL_ATTEMPT
      ? 'worker-session:' + process.env.GOAL_TASK_ID + ':' + process.env.GOAL_ATTEMPT
      : '';
  if (threadId) {
    const code = "const fs=require('node:fs');const keys=" + JSON.stringify(keys) + ";const env={};for(const key of keys)if(process.env[key]!==undefined)env[key]=process.env[key];fs.appendFileSync(process.env.FAKE_PROVIDER_CAPTURE,JSON.stringify({kind:'codex-tool',env})+String.fromCharCode(10))";
    const result = spawnSync(process.execPath, ['-e', code], { env: { ...process.env, CODEX_THREAD_ID: threadId } });
    if (result.status !== 0) process.exit(result.status || 1);
  }
  process.exit(0);
}
record({ kind: 'codex-app-server', argv: args, env: environment() });
const listen = new URL(args[args.indexOf('--listen') + 1]);
if (listen.protocol !== 'ws:' || listen.hostname !== '127.0.0.1') process.exit(3);
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(listen.port || 0),
  fetch(request, server) {
    if (new URL(request.url).pathname === '/readyz') return new Response('ok');
    return server.upgrade(request) ? undefined : new Response('upgrade required', { status: 426 });
  },
  websocket: {
    message(ws, data) {
      const message = JSON.parse(String(data));
      if (message.id === undefined) return;
      const p = message.params || {};
      record({ kind: 'codex-rpc', method: message.method, params: p });
      let result = {};
      if (message.method === 'thread/start') result = { thread: { id: 'thread-' + crypto.randomUUID() } };
      else if (message.method === 'thread/resume') result = { thread: { id: p.threadId, turns: [] } };
      else if (message.method === 'thread/goal/set') result = { goal: { status: p.status, tokensUsed: 0, timeUsedSeconds: 0, tokenBudget: p.tokenBudget ?? 1000 } };
      else if (message.method === 'thread/goal/get') result = { goal: { status: 'active', tokensUsed: 0, timeUsedSeconds: 0, tokenBudget: 1000 } };
      else if (message.method === 'turn/start') result = { turn: { id: 'turn-' + crypto.randomUUID() } };
      ws.send(JSON.stringify({ id: message.id, result }));
    }
  }
});
process.stderr.write('readyz: http://127.0.0.1:' + server.port + '/readyz' + String.fromCharCode(10));
`;

function writeCodex(directory: string): string {
  mkdirSync(directory, { recursive: true });
  const executable = join(directory, 'codex');
  writeFileSync(executable, fakeCodex);
  chmodSync(executable, 0o755);
  return executable;
}

function captured(path: string): Record<string, any>[] {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function hostileEnvironment(capture: string, codexHome: string, claudeConfig: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${dirname(codexHome)}/bin:${process.env.PATH ?? ''}`,
    CODEX_HOME: '/inherited/wrong-codex-account',
    CODEX_SESSION_ID: 'inherited-old-codex-session',
    CODEX_THREAD_ID: 'inherited-old-codex-thread',
    CLAUDE_CONFIG_DIR: '/inherited/wrong-claude-account',
    CLAUDE_CODE_SESSION_ID: 'inherited-old-claude-session',
    CLAUDECODE: '1',
    CLAUDE_PARENT_ONLY_HINT: 'must-not-reach-another-provider',
    CLAUDE_CUSTOM_RUNTIME_HINT: 'must-not-reach-another-provider',
    GOAL_MANAGER: 'ambient-caller',
    GOAL_TASK_ID: 'ambient-task',
    GOAL_ATTEMPT: '91',
    GOAL_CHECK_WAIT_FILE: '/stale/check-wait',
    GOAL_MAIN_CHECKOUT: '/configured/checkout',
    GOAL_LOCAL_CONFIG: '/configured/local.json',
    GOAL_STATE_DIRECTORY: '/configured/state',
    FAKE_PROVIDER_CAPTURE: capture,
    CLAUDE_TEST_CONFIG: claudeConfig,
  };
}

function expectCleanCodexProcess(env: NodeJS.ProcessEnv, codexHome: string, expectedManager?: string): void {
  expect(env.CODEX_HOME).toBe(codexHome);
  expect(env.CODEX_SESSION_ID).toBeUndefined();
  expect(env.CODEX_THREAD_ID).toBeUndefined();
  expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
  expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  expect(env.CLAUDE_PARENT_ONLY_HINT).toBeUndefined();
  expect(env.CLAUDE_CUSTOM_RUNTIME_HINT).toBeUndefined();
  expect(env.CLAUDE_TEST_CONFIG).toBeUndefined();
  expect(env.CLAUDECODE).toBeUndefined();
  expect(env.GOAL_MANAGER).toBe(expectedManager);
  expect(env.GOAL_TASK_ID).toBeUndefined();
  expect(env.GOAL_ATTEMPT).toBeUndefined();
  expect(env.GOAL_CHECK_WAIT_FILE).toBeUndefined();
  expect(env.GOAL_MAIN_CHECKOUT).toBe('/configured/checkout');
  expect(env.GOAL_LOCAL_CONFIG).toBe('/configured/local.json');
  expect(env.GOAL_STATE_DIRECTORY).toBe('/configured/state');
  expect(env.PATH).toContain(dirname(codexHome));
}

async function withEnvironment<T>(overrides: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
  const owned = new Set([
    ...Object.keys(process.env).filter(
      (key) => key.startsWith('CLAUDE_') || key.startsWith('CODEX_') || key === 'CLAUDECODE',
    ),
    'GOAL_MANAGER',
    'GOAL_TASK_ID',
    'GOAL_ATTEMPT',
    'GOAL_CHECK_WAIT_FILE',
    ...Object.keys(overrides),
  ]);
  const before = new Map([...owned].map((key) => [key, process.env[key]]));
  for (const key of owned) delete process.env[key];
  for (const [key, value] of Object.entries(overrides)) if (value !== undefined) process.env[key] = value;
  try {
    return await run();
  } finally {
    for (const key of owned) delete process.env[key];
    for (const [key, value] of before) if (value !== undefined) process.env[key] = value;
  }
}

test('a real Codex pool app-server starts with only its selected account and no ambient provider or Goal identity', async () => {
  const temporary = temporaryDirectory();
  const capturePath = join(temporary.path, 'provider.jsonl');
  const executable = writeCodex(join(temporary.path, 'bin'));
  const poolHome = join(temporary.path, 'accounts', 'codex');
  const parent = hostileEnvironment(capturePath, poolHome, join(temporary.path, 'claude'));
  let server: Awaited<ReturnType<typeof connectPool>> | undefined;
  try {
    server = await connectPool({ id: 'pool', codexHome: poolHome, executable }, undefined, parent);
    const record = captured(capturePath).find((value) => value.kind === 'codex-app-server');
    expect(record).toBeDefined();
    expectCleanCodexProcess(record!.env, poolHome);
    expect(await server.request('test/ping', {})).toEqual({});
    expect(parent.CODEX_THREAD_ID).toBe('inherited-old-codex-thread');
    expect(parent.CLAUDE_CODE_SESSION_ID).toBe('inherited-old-claude-session');
    expect(parent.GOAL_MANAGER).toBe('ambient-caller');
  } finally {
    await server?.close();
    temporary.close();
  }
}, 10_000);

test('a fresh worker child receives only its current task and attempt while its provider establishes a session', () => {
  const temporary = temporaryDirectory();
  const capturePath = join(temporary.path, 'worker-provider.jsonl');
  const executable = writeCodex(join(temporary.path, 'bin'));
  const codexHome = join(temporary.path, 'accounts', 'codex-worker');
  const parent = hostileEnvironment(capturePath, codexHome, join(temporary.path, 'accounts', 'claude'));
  const pool: Pool = {
    name: 'codex-worker-fixture',
    cli: 'codex',
    classes: ['default'],
    configDirectory: codexHome,
    command: executable,
    allowanceKey: 'codex-worker-fixture',
    policy: { weight: 1, reservePercent: 0, allowUnknown: true, maxAgeMs: 60_000 },
  };
  try {
    const env = workerEnvironment(
      pool,
      {
        GOAL_TASK_ID: 'task:owned-worker',
        GOAL_ATTEMPT: '7',
        GOAL_CHECK_WAIT_FILE: '/current/check-wait',
      },
      parent,
      temporary.path,
    );
    const result = spawnSync(executable, ['exec', '--json'], {
      cwd: temporary.path,
      env,
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    const worker = captured(capturePath).find((value) => value.kind === 'codex-worker');
    expect(worker?.env).toMatchObject({
      CODEX_HOME: codexHome,
      GOAL_TASK_ID: 'task:owned-worker',
      GOAL_ATTEMPT: '7',
      GOAL_CHECK_WAIT_FILE: '/current/check-wait',
    });
    expect(worker?.env.PATH).toBe(env.PATH);
    expect(worker?.env.CODEX_THREAD_ID).toBeUndefined();
    expect(worker?.env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(worker?.env.CLAUDE_CUSTOM_RUNTIME_HINT).toBeUndefined();
    expect(worker?.env.GOAL_MANAGER).toBeUndefined();
    const tool = captured(capturePath).find((value) => value.kind === 'codex-tool');
    expect(tool?.env).toMatchObject({
      CODEX_THREAD_ID: 'worker-session:task:owned-worker:7',
      CODEX_HOME: codexHome,
      GOAL_TASK_ID: 'task:owned-worker',
      GOAL_ATTEMPT: '7',
      GOAL_CHECK_WAIT_FILE: '/current/check-wait',
    });
    expect(tool?.env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(parent.CODEX_THREAD_ID).toBe('inherited-old-codex-thread');
    expect(parent.CLAUDE_CODE_SESSION_ID).toBe('inherited-old-claude-session');
    expect(parent.GOAL_MANAGER).toBe('ambient-caller');
    expect(parent.GOAL_TASK_ID).toBe('ambient-task');
  } finally {
    temporary.close();
  }
});

function runtimeFor(h: ReturnType<typeof harness>) {
  return { settings: h.settings, db: h.store.db, store: h.store, tasks: h.tasks, drain: async () => {} } as never;
}

function stoppedAttempt(h: ReturnType<typeof harness>, taskId: string) {
  const startedAt = new Date().toISOString();
  const attempt = h.store.nextAttempt({ taskId, attempt: 0 }, (n): Attempt => ({
    taskId,
    attempt: n,
    state: 'exited',
    profile: { cli: 'codex', model: 'gpt-6-luna', effort: 'high', poolClass: 'codex' },
    pool: 'fixture',
    tableVersion: 'fixture',
    experiment: null,
    startedAt,
    endedAt: startedAt,
    process: null,
    driver: null,
    logPath: join(h.settings.stateDirectory, 'runs', taskId, `${n}.jsonl`),
    evidencePath: join(h.settings.stateDirectory, 'evidence', taskId, String(n)),
    auxiliaryProcesses: [],
    session: 'pre-provider-session',
    fixRound: 0,
    consulted: false,
    previousFailure: null,
    failure: null,
    escalation: null,
    before: null,
    after: null,
    exitCode: 1,
    result: 'stopped fixture attempt',
    blocker: null,
    approaches: [],
  }));
  const ref = { taskId, attempt: attempt.attempt };
  h.store.updateTask(ref, (task) => {
    task.state = 'stopped';
  });
  return ref;
}

test('Codex manager launch, host recovery, viewer tools and authenticated retry preserve the provider session', async () => {
  const h = harness();
  const capturePath = join(h.settings.stateDirectory, 'provider-environment.jsonl');
  const executable = writeCodex(join(h.settings.stateDirectory, 'bin'));
  const codexHome = join(h.settings.stateDirectory, 'accounts', 'codex');
  const claudeHome = join(h.settings.stateDirectory, 'accounts', 'claude');
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(claudeHome, { recursive: true });
  const parent = hostileEnvironment(capturePath, codexHome, claudeHome);
  parent.PATH = `${dirname(executable)}:${parent.PATH}`;
  const ownerName = 'fixture';
  const calls: string[][] = [];
  const executeWindow = (argv: string[], cwd: string) => {
    calls.push(argv);
    const result = spawnSync(argv[0]!, argv.slice(1), { cwd, env: parent, encoding: 'utf8', timeout: 10_000 });
    if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'fake provider viewer failed');
  };
  const inbox = new SqliteManagerInbox(h.store.db, h.settings.stateDirectory);
  const services = {
    command: ['goal'],
    connect: (pool: { id: string; codexHome: string }, onStart?: (identity: any) => void) =>
      connectPool({ ...pool, executable }, onStart, parent),
    windows: {
      register(_id: string, argv: string[], cwd: string) {
        executeWindow(argv, cwd);
        return '@provider';
      },
      unregister() {},
    },
    checkCompletion: async () => ({ passed: false, evidencePath: 'unused', summary: 'not complete' }),
  };
  const spec: ManagerSpec = {
    id: ownerName,
    goal: ownerName,
    objective: 'Exercise a controlled provider session',
    brief: 'Use the provider tool session only for this manager.',
    cwd: h.root,
    engine: 'codex',
    pool: { id: 'codex-test', codexHome, executable },
    budget: 1000,
    effort: 'low',
    supermanager: 'root',
    limits: { turns: 100, turnsWithoutDecision: 100, wallMs: 60_000 },
  };
  let first: ManagerSessions | undefined;
  let recovered: ManagerSessions | undefined;
  try {
    await withEnvironment(parent, async () => {
      first = new ManagerSessions(h.store.db, inbox, services);
      const started = await first.start(spec);
      if (started.kind === 'resident-supermanager') throw new Error('expected a managed Codex session');
      expect(started.status).toBe('running');
      const originalThread = started.threadId!;
      expect(originalThread).toMatch(/^thread-/);
      expect(started.goalState).toMatchObject({ status: 'active', tokenBudget: 1000 });
      const oldViewer = captured(capturePath).find((value) => value.kind === 'codex-viewer');
      expect(oldViewer).toBeDefined();
      expectCleanCodexProcess(oldViewer!.env, codexHome, ownerName);

      const previous = {
        ...started,
        threadId: 'archived-provider-session',
        activeTurnId: null,
        status: 'complete',
        startedAt: started.startedAt - 1000,
        goalState: { status: 'complete', tokensUsed: 250, timeUsedSeconds: 5, tokenBudget: 500 },
      };
      const history = [previous];
      const persisted = { ...started, history };
      h.store.db.query('UPDATE manager_sessions SET state=? WHERE id=?').run(JSON.stringify(persisted), ownerName);
      const rootSession = randomUUID();
      await first.registerResidentSupermanager('root', rootSession);
      expect(first.get('root')).toMatchObject({
        kind: 'resident-supermanager',
        threadId: rootSession,
        status: 'running',
      });
      await first.close();
      first = undefined;

      recovered = new ManagerSessions(h.store.db, inbox, services);
      await recovered.recover();
      const current = recovered.get(ownerName);
      expect(current).toMatchObject({
        id: ownerName,
        goal: ownerName,
        budget: 1000,
        threadId: originalThread,
        history,
        status: 'running',
      });
      expect(current.goalState).toMatchObject({ status: 'active', tokenBudget: 1000 });

      const records = captured(capturePath);
      const appServers = records.filter((value) => value.kind === 'codex-app-server');
      expect(appServers).toHaveLength(2);
      for (const record of appServers) expectCleanCodexProcess(record.env, codexHome);
      const resume = records.find((value) => value.kind === 'codex-rpc' && value.method === 'thread/resume');
      expect(resume?.params.threadId).toBe(originalThread);
      const viewers = records.filter((value) => value.kind === 'codex-viewer');
      expect(viewers).toHaveLength(2);
      for (const viewer of viewers) expectCleanCodexProcess(viewer.env, codexHome, ownerName);
      const toolEnvironment = records.filter((value) => value.kind === 'codex-tool').at(-1)?.env as
        | NodeJS.ProcessEnv
        | undefined;
      expect(toolEnvironment?.CODEX_THREAD_ID).toBe(originalThread);
      expect(toolEnvironment?.CLAUDE_CODE_SESSION_ID).toBeUndefined();
      expect(authenticatedManager(h.store.db, toolEnvironment!)).toEqual({ id: ownerName, sessionId: originalThread });
      expect(
        records.some(
          (value) => value.kind === 'codex-rpc' && value.method === 'thread/start' && value.params?.manager === 'root',
        ),
      ).toBe(false);
      expect(calls).toHaveLength(2);

      const task = h.tasks.dispatch(h.briefFile);
      const ref = stoppedAttempt(h, task.id);
      await runWorkerCommand('priority', ['grant', task.id], {
        runtime: runtimeFor(h),
        env: { CLAUDE_CODE_SESSION_ID: rootSession, GOAL_MANAGER: 'root' },
        print() {},
      });
      const ownerEnvironment = { CODEX_THREAD_ID: originalThread, GOAL_MANAGER: ownerName };
      await runWorkerCommand('priority', [task.id, 'critical'], {
        runtime: runtimeFor(h),
        env: ownerEnvironment,
        print() {},
      });
      const critical = h.store.task(task.id);
      const amendmentPath = join(h.settings.stateDirectory, 'critical-amendment.md');
      writeFileSync(
        amendmentPath,
        markdown.replace('criticalPath: false', 'criticalPath: true') +
          '\nUse the currently authenticated manager session.\n',
      );
      const briefFilesBefore = readdirSyncSafe(join(h.settings.stateDirectory, 'briefs'));
      const rejected = [
        { ...ownerEnvironment, CLAUDE_CODE_SESSION_ID: rootSession },
        { CODEX_THREAD_ID: randomUUID(), GOAL_MANAGER: ownerName },
        { CODEX_THREAD_ID: originalThread, GOAL_MANAGER: 'wrong-manager' },
        { GOAL_MANAGER: ownerName },
      ];
      for (const env of rejected) {
        await expect(
          runWorkerCommand('retry', [task.id, '--brief', amendmentPath], {
            runtime: runtimeFor(h),
            env,
            print() {},
          }),
        ).rejects.toThrow('priority changes require an authenticated manager session');
        expect(h.store.task(task.id)).toEqual(critical);
        expect(h.store.retryIntent(ref)).toBeUndefined();
      }
      expect(readdirSyncSafe(join(h.settings.stateDirectory, 'briefs'))).toEqual(briefFilesBefore);

      await runWorkerCommand('retry', [task.id, '--brief', amendmentPath], {
        runtime: runtimeFor(h),
        env: ownerEnvironment,
        print() {},
      });
      const retried = h.store.task(task.id);
      expect(retried.priorityGrants).toEqual(critical.priorityGrants);
      expect(retried.priorityHistory).toEqual(critical.priorityHistory);
      expect(retried.priorityGrants?.[0]).toMatchObject({ consumedBy: ownerName });
      expect(retried.priorityGrants?.[0]?.revokedAt).toBeUndefined();
      expect(h.store.attempt(ref).session).toBe('pre-provider-session');
      expect(h.store.retryIntent(ref)).toMatchObject({ status: 'pending' });
    });
  } finally {
    await recovered?.close();
    await first?.close();
    h.dispose();
  }
}, 20_000);

function readdirSyncSafe(path: string): string[] {
  try {
    return readdirSync(path).sort();
  } catch {
    return [];
  }
}

const fakeClaude = String.raw`#!/usr/bin/env bun
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const keys = ${JSON.stringify(capturedKeys)};
function environment() {
  const value = {};
  for (const key of keys) if (process.env[key] !== undefined) value[key] = process.env[key];
  return value;
}
const sessionFlag = args.includes('--session-id') ? '--session-id' : '--resume';
const sessionId = args[args.indexOf(sessionFlag) + 1];
appendFileSync(process.env.FAKE_PROVIDER_CAPTURE, JSON.stringify({ kind: 'claude-provider', argv: args, env: environment() }) + String.fromCharCode(10));
const code = "const fs=require('node:fs');const keys=" + JSON.stringify(keys) + ";const env={};for(const key of keys)if(process.env[key]!==undefined)env[key]=process.env[key];fs.appendFileSync(process.env.FAKE_PROVIDER_CAPTURE,JSON.stringify({kind:'claude-tool',env})+String.fromCharCode(10))";
const result = spawnSync(process.execPath, ['-e', code], { env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId } });
if (result.status !== 0) process.exit(result.status || 1);
`;

test('Claude fresh and resumed provider processes receive the configured account without Codex or caller session markers', async () => {
  const temporary = temporaryDirectory();
  const capturePath = join(temporary.path, 'claude-provider.jsonl');
  const bin = join(temporary.path, 'bin');
  mkdirSync(bin, { recursive: true });
  const claude = join(bin, 'claude');
  writeFileSync(claude, fakeClaude);
  chmodSync(claude, 0o755);
  const claudeHome = join(temporary.path, 'accounts', 'claude');
  const codexHome = join(temporary.path, 'accounts', 'codex');
  mkdirSync(claudeHome, { recursive: true });
  const parent = hostileEnvironment(capturePath, codexHome, claudeHome);
  parent.PATH = `${bin}:${parent.PATH}`;
  const dbPath = join(temporary.path, 'state.sqlite');
  const { openDb } = await import('./db.ts');
  const db = openDb(dbPath);
  const inbox = new SqliteManagerInbox(db, temporary.path);
  const calls: string[][] = [];
  let alive = true;
  const services = {
    command: ['goal'],
    windows: {
      register(_id: string, argv: string[], cwd: string) {
        calls.push(argv);
        const result = spawnSync(argv[0]!, argv.slice(1), { cwd, env: parent, encoding: 'utf8', timeout: 10_000 });
        if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'fake Claude launch failed');
        return '@claude';
      },
      respawn(_id: string, argv: string[], cwd: string) {
        calls.push(argv);
        const result = spawnSync(argv[0]!, argv.slice(1), { cwd, env: parent, encoding: 'utf8', timeout: 10_000 });
        if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'fake Claude resume failed');
      },
      unregister() {},
      alive() {
        return alive;
      },
    },
    checkCompletion: async () => ({ passed: false, evidencePath: 'unused', summary: 'not complete' }),
  };
  const spec: ManagerSpec = {
    id: 'claude-manager',
    goal: 'claude-manager',
    objective: 'Exercise a controlled Claude session',
    brief: 'Use the configured Claude account.',
    cwd: temporary.path,
    engine: 'claude',
    pool: { id: 'claude-test', codexHome: claudeHome, executable: 'claude' },
    budget: 800,
    effort: 'low',
    supermanager: 'root',
    limits: { turns: 100, turnsWithoutDecision: 100, wallMs: 60_000 },
  };
  let managers: ManagerSessions | undefined;
  try {
    await withEnvironment(parent, async () => {
      managers = new ManagerSessions(db, inbox, services);
      const started = await managers.start(spec);
      expect(started.status).toBe('running');
      const session = started.threadId!;
      expect(calls).toHaveLength(1);
      const fresh = captured(capturePath).find((value) => value.kind === 'claude-provider');
      expect(fresh?.argv).toContain('--session-id');
      expect(fresh?.argv).toContain(session);
      expect(fresh?.env).toMatchObject({ CLAUDE_CONFIG_DIR: claudeHome, GOAL_MANAGER: spec.id });
      expect(fresh?.env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
      expect(fresh?.env.CLAUDE_CUSTOM_RUNTIME_HINT).toBeUndefined();
      expect(fresh?.env.CODEX_THREAD_ID).toBeUndefined();
      expect(fresh?.env.CODEX_SESSION_ID).toBeUndefined();
      const tool = captured(capturePath).find((value) => value.kind === 'claude-tool')?.env as NodeJS.ProcessEnv;
      expect(tool.CLAUDE_CODE_SESSION_ID).toBe(session);
      expect(tool.CLAUDE_CONFIG_DIR).toBe(claudeHome);
      expect(tool.CODEX_THREAD_ID).toBeUndefined();
      expect(authenticatedManager(db, tool)).toEqual({ id: spec.id, sessionId: session });

      alive = false;
      inbox.deliver({ managerId: spec.id, kind: 'instruction', summary: 'Continue the existing manager session.' });
      await managers.wake(spec.id);
      expect(calls).toHaveLength(2);
      expect(calls[1]).toContain('--resume');
      expect(calls[1]).toContain(session);
      const all = captured(capturePath).filter((value) => value.kind === 'claude-provider');
      expect(all).toHaveLength(2);
      expect(all[1]?.env).toMatchObject({ CLAUDE_CONFIG_DIR: claudeHome, GOAL_MANAGER: spec.id });
      expect(all[1]?.env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
      expect(all[1]?.env.CLAUDE_CUSTOM_RUNTIME_HINT).toBeUndefined();
      expect(all[1]?.env.CODEX_THREAD_ID).toBeUndefined();
      const resumedTool = captured(capturePath)
        .filter((value) => value.kind === 'claude-tool')
        .at(-1)?.env as NodeJS.ProcessEnv;
      expect(resumedTool.CLAUDE_CODE_SESSION_ID).toBe(session);
      expect(authenticatedManager(db, resumedTool)).toEqual({ id: spec.id, sessionId: session });
      expect(managers.get(spec.id)).toMatchObject({ threadId: session, goal: spec.goal, budget: spec.budget });
      expect(parent.CLAUDE_CODE_SESSION_ID).toBe('inherited-old-claude-session');
      expect(parent.CODEX_THREAD_ID).toBe('inherited-old-codex-thread');
    });
  } finally {
    await managers?.close();
    db.close();
    temporary.close();
  }
}, 15_000);

test('manager recovery, wake races and interruption races forward the configured thread settings', async () => {
  const temporary = temporaryDirectory();
  const db = openDb(join(temporary.path, 'state.sqlite'));
  const log = join(temporary.path, 'rpc.jsonl');
  const client = new StdioAppServer([process.execPath, join(import.meta.dir, 'fixtures/fake-app-server.ts')], {
    ...process.env,
    FAKE_RPC_LOG: log,
  });
  let failNext: string | undefined;
  const connection: AppServer = {
    request<T>(method: string, params: unknown): Promise<T> {
      if (method === failNext) {
        failNext = undefined;
        return Promise.reject(new Error('fixture turn observation raced the provider'));
      }
      return client.request<T>(method, params);
    },
    onNotification: (listener) => client.onNotification(listener),
    close: () => client.close(),
  };
  const inbox = new SqliteManagerInbox(db, temporary.path);
  const managers = new ManagerSessions(db, inbox, {
    command: ['goal'],
    connect: async () => connection,
    windows: { register: () => '@config', unregister() {} },
    checkCompletion: async () => ({ passed: false, evidencePath: 'unused', summary: 'not complete' }),
  });
  try {
    await client.initialize();
    const started = await managers.start({
      id: 'configured-owner',
      goal: 'configured-owner',
      objective: 'Keep the configured settings on every resume',
      brief: 'Continue the existing provider thread.',
      cwd: temporary.path,
      engine: 'codex',
      pool: { id: 'config', codexHome: temporary.path },
      budget: 1000,
      compactTokens: 200000,
      effort: 'high',
      supermanager: 'root',
      limits: { turns: 100, turnsWithoutDecision: 100, wallMs: 60_000 },
    });
    await managers.flush();
    await managers.recover();
    failNext = 'turn/steer';
    inbox.deliver({ managerId: started.id, kind: 'instruction', summary: 'Continue after the turn race' });
    await managers.wake(started.id);
    await managers.flush();
    failNext = 'turn/interrupt';
    await managers.stop(started.id);
    const requests = captured(log);
    const resumes = requests.filter((record) => record.method === 'thread/resume');
    expect(resumes).toHaveLength(3);
    const config = { model_reasoning_effort: 'high', model_auto_compact_token_limit: 200000 };
    for (const resume of resumes)
      expect(resume.params).toEqual({
        threadId: started.threadId,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        config,
      });
    const starts = requests.filter((record) => record.method === 'thread/start');
    expect(starts).toHaveLength(1);
    expect(starts[0]?.params.config).toEqual(config);
    expect(managers.get(started.id)).toMatchObject({ threadId: started.threadId, budget: 1000, compactTokens: 200000 });
    expect(requests.some((record) => /compact/i.test(record.method))).toBe(false);
  } finally {
    await managers.close();
    db.close();
    temporary.close();
  }
});
