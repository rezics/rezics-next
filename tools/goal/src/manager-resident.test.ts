import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { join, relative } from 'node:path';
import { ManagerSessions, type ManagerServices, type ManagerSpec } from './managers.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { openDb } from './db.ts';
import { authenticatedManager } from './priority-authority.ts';
import { harness, temporaryDirectory } from './test-support.ts';

const cliRuntime = join(import.meta.dir, 'fixtures/cli-runtime.ts');
const publicCli = join(import.meta.dir, 'cli.ts');

function cleanEnvironment(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'GOAL_MANAGER', 'GOAL_TASK_ID', 'GOAL_ATTEMPT'])
    delete env[key];
  return Object.assign(env, overrides);
}

async function startHost(env: NodeJS.ProcessEnv) {
  const host = spawn(process.execPath, [cliRuntime, '_manager-host'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let hostError = '';
  host.stderr.on('data', (chunk) => (hostError += chunk.toString()));
  const exited = new Promise<void>((resolve) => host.once('exit', () => resolve()));
  const ready = new Promise<void>((resolve, reject) => {
    createInterface({ input: host.stdout! }).once('line', (line) =>
      line === 'ready' ? resolve() : reject(new Error(line)),
    );
    host.once('exit', () => reject(new Error(hostError || 'Manager host exited before ready')));
  });
  await ready;
  return { host, exited };
}

async function invoke(env: NodeJS.ProcessEnv, ...args: string[]) {
  const child = Bun.spawn([process.execPath, cliRuntime, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function invokePublicCli(
  h: ReturnType<typeof harness>,
  manager: string | undefined,
  sessionId: string,
  ...args: string[]
) {
  const overrides: NodeJS.ProcessEnv = {
    GOAL_MAIN_CHECKOUT: h.root,
    GOAL_LOCAL_CONFIG: h.settings.localFile,
    GOAL_STATE_DIRECTORY: h.settings.stateDirectory,
    GOAL_WORKTREE_ROOT: h.settings.worktreeRoot,
    CLAUDE_CODE_SESSION_ID: sessionId,
  };
  if (manager) overrides.GOAL_MANAGER = manager;
  const env = cleanEnvironment(overrides);
  const child = Bun.spawn([process.execPath, publicCli, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

function residentHarness() {
  const temporary = temporaryDirectory();
  const db = openDb(join(temporary.path, 'state.sqlite'));
  const inbox = new SqliteManagerInbox(db, temporary.path);
  const windows: string[] = [];
  let connections = 0;
  let completions = 0;
  const services: ManagerServices = {
    connect: async () => {
      connections++;
      throw new Error('resident sessions must not connect to an app-server');
    },
    windows: {
      register(id) {
        windows.push(`register:${id}`);
        return '@1';
      },
      unregister(id) {
        windows.push(`unregister:${id}`);
      },
    },
    checkCompletion: async () => {
      completions++;
      return { passed: true, evidencePath: 'unused', summary: 'unused' };
    },
    command: ['goal'],
  };
  let managers = new ManagerSessions(db, inbox, services);
  return {
    temporary,
    db,
    inbox,
    get managers() {
      return managers;
    },
    windows,
    get connections() {
      return connections;
    },
    get completions() {
      return completions;
    },
    async restart() {
      await managers.close();
      managers = new ManagerSessions(db, inbox, services);
    },
    async close() {
      await managers.close();
      db.close();
      temporary.close();
    },
  };
}

test('public resident registration persists, authenticates, grants priority and lets the owner consume it', async () => {
  const h = harness();
  const sessionId = randomUUID();
  const stateDirectory = h.settings.stateDirectory;
  const env = cleanEnvironment({
    FAKE_GOAL_STATE: relative(process.cwd(), stateDirectory),
    FAKE_GOAL_MAIN: h.root,
    FAKE_GOAL_DATABASE: 'goal.sqlite',
  });
  const { host, exited } = await startHost(env);
  const inbox = new SqliteManagerInbox(h.store.db, h.settings.integration.inboxDirectory);
  const ownerWindows: string[] = [];
  const ownerManagers = new ManagerSessions(h.store.db, inbox, {
    connect: async () => {
      throw new Error('Claude owner should not connect to an app-server');
    },
    windows: {
      register(id) {
        ownerWindows.push(`register:${id}`);
        return '@owner';
      },
      unregister(id) {
        ownerWindows.push(`unregister:${id}`);
      },
    },
    checkCompletion: async () => ({ passed: false, evidencePath: 'unused', summary: 'unused' }),
    command: ['goal'],
  });
  try {
    const registered = await invoke(
      cleanEnvironment({ ...env, CLAUDE_CODE_SESSION_ID: sessionId }),
      'manager',
      'register-supermanager',
    );
    expect(registered.code).toBe(0);
    expect(registered.stderr).toBe('');
    const persisted = h.store.db
      .query('SELECT state FROM manager_sessions WHERE id = ?')
      .get('supermanager') as { state: string };
    const resident = JSON.parse(persisted.state);
    expect(JSON.parse(registered.stdout)).toEqual(resident);
    expect(resident).toMatchObject({
      kind: 'resident-supermanager',
      id: 'supermanager',
      provider: 'claude',
      threadId: sessionId,
      status: 'running',
    });
    expect(resident).not.toHaveProperty('engine');
    expect(resident).not.toHaveProperty('pool');
    expect(resident).not.toHaveProperty('goal');
    expect(resident).not.toHaveProperty('budget');
    expect(resident).not.toHaveProperty('limits');
    expect(
      authenticatedManager(h.store.db, { CLAUDE_CODE_SESSION_ID: sessionId }),
    ).toEqual({ id: 'supermanager', sessionId });

    const task = h.tasks.dispatch(h.briefFile);
    const owner: ManagerSpec = {
      id: task.brief.manager,
      goal: task.brief.goal,
      objective: 'Own this task',
      brief: 'Manage the task',
      cwd: h.root,
      engine: 'claude',
      pool: { id: 'fixture', codexHome: h.root, executable: 'claude' },
      budget: 1000,
      effort: 'low',
      supermanager: 'supermanager',
      limits: { turns: 10, turnsWithoutDecision: 10, wallMs: 60_000 },
    };
    const ownerState = await ownerManagers.start(owner);
    expect(ownerState.status).toBe('running');
    expect(ownerWindows).toEqual([`register:${owner.id}`]);

    const granted = await invokePublicCli(h, undefined, sessionId, 'priority', 'grant', task.id);
    expect(granted.code).toBe(0);
    expect(granted.stderr).toBe('');
    expect(JSON.parse(granted.stdout)).toMatchObject({
      taskId: task.id,
      grantor: 'supermanager',
      grantee: owner.id,
      provenance: { kind: 'manager-session', sessionId },
    });

    const consumed = await invokePublicCli(h, owner.id, ownerState.threadId!, 'priority', task.id, 'critical');
    expect(consumed.code).toBe(0);
    expect(consumed.stderr).toBe('');
    const updated = h.store.task(task.id);
    expect(updated.brief.criticalPath).toBe(true);
    expect(updated.priorityHistory?.[0]).toMatchObject({
      setter: owner.id,
      grantor: 'supermanager',
      provenance: { kind: 'manager-session', sessionId: ownerState.threadId },
    });
    expect(updated.priorityGrants?.[0]).toMatchObject({
      grantor: 'supermanager',
      consumedBy: owner.id,
      provenance: { kind: 'manager-session', sessionId },
    });
    expect(updated.priorityGrants?.[0]?.consumedAt).toBeTruthy();
    expect(
      (h.store.db.query('SELECT count(*) AS count FROM manager_turn_decisions WHERE manager = ?').get('supermanager') as {
        count: number;
      }).count,
    ).toBe(0);
  } finally {
    await ownerManagers.close();
    host.kill('SIGTERM');
    await exited;
    h.dispose();
  }
}, 60_000);

test('resident registration is idempotent and rejects workers, ordinary managers, ambiguous identities and replacement', async () => {
  const h = harness();
  const sessionId = randomUUID();
  const stateDirectory = h.settings.stateDirectory;
  const base = {
    FAKE_GOAL_STATE: relative(process.cwd(), stateDirectory),
    FAKE_GOAL_MAIN: h.root,
    FAKE_GOAL_DATABASE: 'goal.sqlite',
  };
  const env = cleanEnvironment(base);
  const { host, exited } = await startHost(env);
  const inbox = new SqliteManagerInbox(h.store.db, h.settings.integration.inboxDirectory);
  const ownerManagers = new ManagerSessions(h.store.db, inbox, {
    connect: async () => {
      throw new Error('not used');
    },
    windows: { register: () => '@owner', unregister() {} },
    checkCompletion: async () => ({ passed: false, evidencePath: 'unused', summary: 'unused' }),
    command: ['goal'],
  });
  try {
    const register = (overrides: NodeJS.ProcessEnv) =>
      invoke(cleanEnvironment({ ...base, ...overrides }), 'manager', 'register-supermanager');
    const missing = await register({ GOAL_MANAGER: 'supermanager' });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('CLAUDE_CODE_SESSION_ID');
    const malformed = await register({ CLAUDE_CODE_SESSION_ID: 'malformed' });
    expect(malformed.code).toBe(1);
    expect(malformed.stderr).toContain('valid CLAUDE_CODE_SESSION_ID');
    const ambiguous = await register({ CLAUDE_CODE_SESSION_ID: sessionId, CODEX_THREAD_ID: randomUUID() });
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.stderr).toContain('ambiguous');
    const worker = await register({
      CLAUDE_CODE_SESSION_ID: randomUUID(),
      GOAL_MANAGER: 'supermanager',
      GOAL_TASK_ID: 'worker-task',
      GOAL_ATTEMPT: '1',
    });
    expect(worker.code).toBe(1);
    expect(worker.stderr).toContain('Workers cannot register');

    const task = h.tasks.dispatch(h.briefFile);
    const owner: ManagerSpec = {
      id: task.brief.manager,
      goal: task.brief.goal,
      objective: 'Own this task',
      brief: 'Manage the task',
      cwd: h.root,
      engine: 'claude',
      pool: { id: 'fixture', codexHome: h.root, executable: 'claude' },
      budget: 1000,
      effort: 'low',
      supermanager: 'supermanager',
      limits: { turns: 10, turnsWithoutDecision: 10, wallMs: 60_000 },
    };
    const ownerState = await ownerManagers.start(owner);
    const ordinary = await register({
      CLAUDE_CODE_SESSION_ID: ownerState.threadId!,
      GOAL_MANAGER: owner.id,
    });
    expect(ordinary.code).toBe(1);
    expect(ordinary.stderr).toContain('cannot register the configured supermanager');

    const first = await register({ CLAUDE_CODE_SESSION_ID: sessionId });
    expect(first.code).toBe(0);
    const idempotent = await register({ CLAUDE_CODE_SESSION_ID: sessionId });
    expect(idempotent.code).toBe(0);
    expect(JSON.parse(idempotent.stdout)).toEqual(JSON.parse(first.stdout));

    const rootEnv = cleanEnvironment({ ...base, CLAUDE_CODE_SESSION_ID: sessionId, GOAL_MANAGER: 'supermanager' });
    const start = await invoke(rootEnv, 'manager', 'start', 'supermanager', '--engine', 'claude', '--budget', '1000');
    expect(start.code).toBe(1);
    expect(start.stderr).toContain('external session and cannot be started');
    const renew = await invoke(rootEnv, 'manager', 'renew', 'supermanager');
    expect(renew.code).toBe(1);
    expect(renew.stderr).toContain('external session and cannot be renewed');
    const stop = await invoke(rootEnv, 'manager', 'stop', 'supermanager');
    expect(stop.code).toBe(1);
    expect(stop.stderr).toContain('external session');
    const complete = await invoke(rootEnv, 'manager', 'complete', 'supermanager');
    expect(complete.code).toBe(1);
    expect(complete.stderr).toContain('external session');

    const replacement = await register({ CLAUDE_CODE_SESSION_ID: randomUUID() });
    expect(replacement.code).toBe(1);
    expect(replacement.stderr).toContain('explicit session replacement is unsupported');
    const assigned = await register({ CLAUDE_CODE_SESSION_ID: ownerState.threadId!, GOAL_MANAGER: 'supermanager' });
    expect(assigned.code).toBe(1);
    expect(assigned.stderr).toContain('already assigned');
    const stillRegistered = JSON.parse(
      (h.store.db.query('SELECT state FROM manager_sessions WHERE id = ?').get('supermanager') as { state: string })
        .state,
    );
    expect(stillRegistered.threadId).toBe(sessionId);
  } finally {
    await ownerManagers.close();
    host.kill('SIGTERM');
    await exited;
    h.dispose();
  }
}, 60_000);

test('resident recovery, watcher dispatch, limits and lifecycle commands never manage the external session', async () => {
  const s = residentHarness();
  const sessionId = randomUUID();
  try {
    const registered = await s.managers.registerResidentSupermanager('supermanager', sessionId);
    expect(registered).toMatchObject({
      kind: 'resident-supermanager',
      status: 'running',
      provider: 'claude',
      threadId: sessionId,
    });
    const rowBefore = s.db.query('SELECT state FROM manager_sessions WHERE id = ?').get('supermanager') as {
      state: string;
    };
    expect(JSON.parse(rowBefore.state)).toEqual(registered);

    await s.restart();
    await s.managers.recover();
    await s.managers.flush();
    s.inbox.deliver({ managerId: 'supermanager', kind: 'instruction', summary: 'Do not wake a managed session' });
    await Bun.sleep(2_150);
    await s.managers.flush();
    expect(s.managers.get('supermanager')).toEqual(registered);
    expect(s.connections).toBe(0);
    expect(s.windows).toEqual([]);
    expect(s.completions).toBe(0);

    const managerSpec: ManagerSpec = {
      id: 'supermanager',
      goal: 'unused',
      objective: 'unused',
      brief: 'unused',
      cwd: s.temporary.path,
      engine: 'codex',
      pool: { id: 'unused', codexHome: s.temporary.path },
      budget: 1,
      effort: 'low',
      supermanager: 'supermanager',
      limits: { turns: 1, turnsWithoutDecision: 1, wallMs: 1000 },
    };
    await expect(s.managers.stop('supermanager')).rejects.toThrow('external session');
    await expect(s.managers.renew('supermanager', managerSpec)).rejects.toThrow('external session');
    await expect(s.managers.completeCommand('supermanager')).rejects.toThrow('external session');
    await expect(Promise.resolve().then(() => s.managers.complete('supermanager'))).rejects.toThrow('external session');
    await expect(s.managers.claudeTurn('supermanager', true)).rejects.toThrow('external session');
    await s.managers.wake('supermanager');
    expect(s.managers.get('supermanager')).toEqual(registered);
    expect(s.connections).toBe(0);
    expect(s.windows).toEqual([]);
    expect(s.completions).toBe(0);
  } finally {
    await s.close();
  }
});
