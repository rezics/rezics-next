import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, relative } from 'node:path';
import { ManagerSessions, type ManagerServices, type ManagerSpec } from './managers.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { openDb } from './db.ts';
import { authenticatedManager } from './priority-authority.ts';
import { nativeUnitContext } from './native-unit-context.ts';
import { harness, temporaryDirectory } from './test-support.ts';
import { historicalManager } from '../test-support/historical-manager.ts';

const cliRuntime = join(import.meta.dir, 'fixtures/cli-runtime.ts');
const publicCli = join(import.meta.dir, 'cli.ts');

function cleanEnvironment(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    'CLAUDE_CODE_SESSION_ID',
    'CODEX_THREAD_ID',
    'CODEX_SESSION_ID',
    'GOAL_MANAGER',
    'GOAL_TASK_ID',
    'GOAL_ATTEMPT',
    'REZICS_NATIVE_UNIT_CONTEXT',
  ])
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
  provider: 'codex' | 'claude',
  ...args: string[]
) {
  const overrides: NodeJS.ProcessEnv = {
    GOAL_MAIN_CHECKOUT: h.root,
    GOAL_LOCAL_CONFIG: h.settings.localFile,
    GOAL_STATE_DIRECTORY: h.settings.stateDirectory,
    GOAL_WORKTREE_ROOT: h.settings.worktreeRoot,
    [provider === 'codex' ? 'CODEX_THREAD_ID' : 'CLAUDE_CODE_SESSION_ID']: sessionId,
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

test.each(['claude', 'codex'] as const)(
  'public %s resident registration persists, authenticates, grants priority and lets the owner consume it',
  async (provider) => {
    const h = harness();
    const sessionId = randomUUID();
    const stateDirectory = h.settings.stateDirectory;
    const env = cleanEnvironment({
      FAKE_GOAL_STATE: relative(process.cwd(), stateDirectory),
      FAKE_GOAL_MAIN: h.root,
      FAKE_GOAL_DATABASE: 'goal.sqlite',
    });
    const { host, exited } = await startHost(env);
    try {
      const registered = await invokePublicCli(h, undefined, sessionId, provider, 'manager', 'register-supermanager');
      expect(registered.code).toBe(0);
      expect(registered.stderr).toBe('');
      const persisted = h.store.db.query('SELECT state FROM manager_sessions WHERE id = ?').get('supermanager') as {
        state: string;
      };
      const resident = JSON.parse(persisted.state);
      expect(JSON.parse(registered.stdout)).toEqual(resident);
      expect(resident).toMatchObject({
        kind: 'resident-supermanager',
        id: 'supermanager',
        provider,
        threadId: sessionId,
        status: 'running',
      });
      expect(resident).not.toHaveProperty('engine');
      expect(resident).not.toHaveProperty('pool');
      expect(resident).not.toHaveProperty('goal');
      expect(resident).not.toHaveProperty('budget');
      expect(resident).not.toHaveProperty('limits');
      expect(
        authenticatedManager(h.store.db, {
          [provider === 'codex' ? 'CODEX_THREAD_ID' : 'CLAUDE_CODE_SESSION_ID']: sessionId,
        }),
      ).toEqual({
        id: 'supermanager',
        sessionId,
      });

      const task = h.tasks.dispatch(h.briefFile);
      const owner = historicalManager(h.store.db, h.root, {
        id: task.brief.manager,
        goal: task.brief.goal,
        status: 'running',
      });

      const granted = await invokePublicCli(h, undefined, sessionId, provider, 'priority', 'grant', task.id);
      expect(granted.code).toBe(0);
      expect(granted.stderr).toBe('');
      expect(JSON.parse(granted.stdout)).toMatchObject({
        taskId: task.id,
        grantor: 'supermanager',
        grantee: owner.id,
        provenance: { kind: 'manager-session', sessionId },
      });

      const unregistered = await invokePublicCli(h, owner.id, randomUUID(), 'claude', 'priority', task.id, 'critical');
      expect(unregistered.code).toBe(1);
      expect(unregistered.stderr).toContain('authenticated manager session');
      const beforeConsumption = h.store.task(task.id);
      expect(beforeConsumption.brief.criticalPath).toBe(false);
      expect(beforeConsumption.priorityGrants?.[0]?.consumedAt).toBeUndefined();

      const consumed = await invokePublicCli(h, owner.id, owner.threadId!, 'claude', 'priority', task.id, 'critical');
      expect(consumed.code).toBe(0);
      expect(consumed.stderr).toBe('');
      const updated = h.store.task(task.id);
      expect(updated.brief.criticalPath).toBe(true);
      expect(updated.priorityHistory?.[0]).toMatchObject({
        setter: owner.id,
        grantor: 'supermanager',
        provenance: { kind: 'manager-session', sessionId: owner.threadId },
      });
      expect(updated.priorityGrants?.[0]).toMatchObject({
        grantor: 'supermanager',
        consumedBy: owner.id,
        provenance: { kind: 'manager-session', sessionId },
      });
      expect(updated.priorityGrants?.[0]?.consumedAt).toBeTruthy();
      expect(
        (
          h.store.db
            .query('SELECT count(*) AS count FROM manager_turn_decisions WHERE manager = ?')
            .get('supermanager') as {
            count: number;
          }
        ).count,
      ).toBe(0);
    } finally {
      host.kill('SIGTERM');
      await exited;
      h.dispose();
    }
  },
  60_000,
);
test('resident registration rejects unauthorized callers and atomically replaces only the expected session', async () => {
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
  try {
    const register = (overrides: NodeJS.ProcessEnv, ...args: string[]) =>
      invoke(cleanEnvironment({ ...base, ...overrides }), 'manager', 'register-supermanager', ...args);
    const missing = await register({ GOAL_MANAGER: 'supermanager' });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('CLAUDE_CODE_SESSION_ID');
    const malformed = await register({ CLAUDE_CODE_SESSION_ID: 'malformed' });
    expect(malformed.code).toBe(1);
    expect(malformed.stderr).toContain('valid CODEX_THREAD_ID or CLAUDE_CODE_SESSION_ID');
    const malformedCodex = await register({ CODEX_THREAD_ID: 'malformed' });
    expect(malformedCodex.code).toBe(1);
    expect(malformedCodex.stderr).toContain('valid CODEX_THREAD_ID');
    const malformedReplacement = await register({ CODEX_THREAD_ID: randomUUID() }, '--replace-session', 'malformed');
    expect(malformedReplacement.code).toBe(1);
    expect(malformedReplacement.stderr).toContain('Previous resident session ID is malformed');
    const missingReplacement = await register({ CODEX_THREAD_ID: randomUUID() }, '--replace-session', sessionId);
    expect(missingReplacement.code).toBe(1);
    expect(missingReplacement.stderr).toContain('replacement mismatch');
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
    const owner = historicalManager(h.store.db, h.root, {
      id: task.brief.manager,
      goal: task.brief.goal,
      status: 'running',
    });
    const ordinary = await register({
      CLAUDE_CODE_SESSION_ID: owner.threadId!,
      GOAL_MANAGER: owner.id,
    });
    expect(ordinary.code).toBe(1);
    expect(ordinary.stderr).toContain('cannot register the configured supermanager');
    const ordinaryReplacement = await register(
      { CLAUDE_CODE_SESSION_ID: owner.threadId! },
      '--replace-session',
      sessionId,
    );
    expect(ordinaryReplacement.code).toBe(1);
    expect(ordinaryReplacement.stderr).toContain('cannot register the configured supermanager');

    const first = await register({ CLAUDE_CODE_SESSION_ID: sessionId });
    expect(first.code).toBe(0);
    const idempotent = await register({ CLAUDE_CODE_SESSION_ID: sessionId });
    expect(idempotent.code).toBe(0);
    expect(JSON.parse(idempotent.stdout)).toEqual(JSON.parse(first.stdout));

    const rootEnv = cleanEnvironment({ ...base, CLAUDE_CODE_SESSION_ID: sessionId, GOAL_MANAGER: 'supermanager' });
    for (const args of [
      ['start', 'supermanager', '--engine', 'claude', '--budget', '1000'],
      ['renew', 'supermanager'],
      ['assign', task.brief.goal, owner.id],
    ]) {
      const retired = await invoke(rootEnv, 'manager', ...args);
      expect(retired.code).toBe(1);
      expect(retired.stdout).toBe('');
      expect(retired.stderr).toContain(
        'Managed manager launches and assignments are retired; use unit register for an execution unit',
      );
    }
    const stop = await invoke(rootEnv, 'manager', 'stop', 'supermanager');
    expect(stop.code).toBe(1);
    expect(stop.stderr).toContain('external session');
    const complete = await invoke(rootEnv, 'manager', 'complete', 'supermanager');
    expect(complete.code).toBe(1);
    expect(complete.stderr).toContain('external session');

    const replacement = await register({ CLAUDE_CODE_SESSION_ID: randomUUID() });
    expect(replacement.code).toBe(1);
    expect(replacement.stderr).toContain('use --replace-session');
    const assigned = await register({ CLAUDE_CODE_SESSION_ID: owner.threadId!, GOAL_MANAGER: 'supermanager' });
    expect(assigned.code).toBe(1);
    expect(assigned.stderr).toContain('already assigned');
    const stillRegistered = JSON.parse(
      (h.store.db.query('SELECT state FROM manager_sessions WHERE id = ?').get('supermanager') as { state: string })
        .state,
    );
    expect(stillRegistered.threadId).toBe(sessionId);
    const wrongPrevious = await register({ CODEX_THREAD_ID: randomUUID() }, '--replace-session', randomUUID());
    expect(wrongPrevious.code).toBe(1);
    expect(wrongPrevious.stderr).toContain('replacement mismatch');
    expect(authenticatedManager(h.store.db, { CLAUDE_CODE_SESSION_ID: sessionId })?.id).toBe('supermanager');

    inbox.deliver({ managerId: 'supermanager', kind: 'instruction', summary: 'Read before handoff' });
    inbox.deliver({ managerId: 'supermanager', kind: 'instruction', summary: 'Keep this inbox' });
    const inboxCommand = (threadId: string, provider: 'claude' | 'codex', ...flags: string[]) =>
      invokePublicCli(h, undefined, threadId, provider, 'inbox', 'read', 'supermanager', ...flags);
    const [firstMessage, nextMessage] = inbox.pending('supermanager');
    const firstRead = await inboxCommand(sessionId, 'claude', '--limit', '1');
    expect(firstRead.code).toBe(0);
    expect(JSON.parse(firstRead.stdout)).toMatchObject({
      entries: [{ id: firstMessage!.id }],
      hasMore: true,
      nextCursor: firstMessage!.id,
    });
    const durableCursor = () =>
      h.store.db
        .query('SELECT after_id, provider, session_id FROM manager_inbox_resident_cursor WHERE manager = ?')
        .get('supermanager');
    const messagesBefore = inbox.pending('supermanager');
    const nextIds = [randomUUID(), randomUUID()];
    const competing = await Promise.all(
      nextIds.map((nextId) =>
        invokePublicCli(
          h,
          undefined,
          nextId,
          'codex',
          'manager',
          'register-supermanager',
          '--replace-session',
          sessionId,
        ),
      ),
    );
    expect(competing.map((result) => result.code).sort()).toEqual([0, 1]);
    const winner = competing.findIndex((result) => result.code === 0);
    const nextId = nextIds[winner]!;
    expect(competing.find((result) => result.code !== 0)?.stderr).toContain('replacement mismatch');
    expect(JSON.parse(competing[winner]!.stdout)).toMatchObject({
      id: 'supermanager',
      provider: 'codex',
      threadId: nextId,
      kind: 'resident-supermanager',
    });
    expect(authenticatedManager(h.store.db, { CLAUDE_CODE_SESSION_ID: sessionId })).toBeUndefined();
    expect(authenticatedManager(h.store.db, { CODEX_THREAD_ID: nextId })).toEqual({
      id: 'supermanager',
      sessionId: nextId,
    });
    expect(authenticatedManager(h.store.db, { CLAUDE_CODE_SESSION_ID: nextId })).toBeUndefined();
    const repeated = await register({ CODEX_THREAD_ID: nextId });
    expect(repeated.code).toBe(0);
    expect(JSON.parse(repeated.stdout)).toEqual(JSON.parse(competing[winner]!.stdout));
    const retired = await invokePublicCli(h, undefined, sessionId, 'claude', 'priority', 'grant', task.id);
    expect(retired.code).toBe(1);
    expect(retired.stderr).toContain('authenticated manager session');
    expect(inbox.pending('supermanager')).toEqual(messagesBefore);
    const foreignRead = await inboxCommand(sessionId, 'claude');
    expect(foreignRead.code).toBe(0);
    expect(durableCursor()).toEqual({ after_id: firstMessage!.id, provider: 'claude', session_id: sessionId });
    const successorRead = await inboxCommand(nextId, 'codex');
    expect(successorRead.code).toBe(0);
    expect(JSON.parse(successorRead.stdout)).toMatchObject({
      entries: [{ id: nextMessage!.id, event: { summary: 'Keep this inbox' } }],
      hasMore: false,
      nextCursor: null,
    });
    expect(durableCursor()).toEqual({ after_id: nextMessage!.id, provider: 'codex', session_id: nextId });
    const reread = await inboxCommand(nextId, 'codex');
    expect(reread.code).toBe(0);
    expect(JSON.parse(reread.stdout)).toMatchObject({ entries: [] });
  } finally {
    host.kill('SIGTERM');
    await exited;
    h.dispose();
  }
}, 60_000);

test.each(['claude', 'codex'] as const)(
  '%s resident recovery, watcher dispatch, limits and lifecycle commands never manage the external session',
  async (provider) => {
    const s = residentHarness();
    const sessionId = randomUUID();
    try {
      const registered = await s.managers.registerResidentSupermanager('supermanager', sessionId, { provider });
      expect(registered).toMatchObject({
        kind: 'resident-supermanager',
        status: 'running',
        provider,
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
      await expect(Promise.resolve().then(() => s.managers.renew('supermanager', managerSpec))).rejects.toThrow(
        'external session',
      );
      await expect(Promise.resolve().then(() => s.managers.completeCommand('supermanager'))).rejects.toThrow(
        'external session',
      );
      await expect(Promise.resolve().then(() => s.managers.complete('supermanager'))).rejects.toThrow(
        'external session',
      );
      await expect(s.managers.claudeTurn('supermanager', true)).rejects.toThrow('external session');
      await s.managers.wake('supermanager');
      expect(s.managers.get('supermanager')).toEqual(registered);
      expect(s.connections).toBe(0);
      expect(s.windows).toEqual([]);
      expect(s.completions).toBe(0);
    } finally {
      await s.close();
    }
  },
);
test('native Codex registration refuses a legacy host response that ignored the provider', async () => {
  const h = harness();
  const sessionId = randomUUID();
  const requests: unknown[] = [];
  const server = createServer((socket) => {
    createInterface({ input: socket }).once('line', (line) => {
      requests.push(JSON.parse(line));
      socket.end(
        JSON.stringify({
          result: {
            kind: 'resident-supermanager',
            id: 'supermanager',
            provider: 'claude',
            threadId: sessionId,
          },
        }) + '\n',
      );
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(h.settings.integration.managerSocket, resolve);
    });
    const registered = await invokePublicCli(h, undefined, sessionId, 'codex', 'manager', 'register-supermanager');
    expect(registered.code).toBe(1);
    expect(registered.stdout).toBe('');
    expect(registered.stderr).toContain('restart it on updated code');
    expect(requests).toEqual([{ command: 'register-supermanager', sessionId, residentProvider: 'codex' }]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    h.dispose();
  }
});

test('a desktop resident handoff authorizes registration of the exact native execution unit', async () => {
  const h = harness();
  const former = randomUUID();
  const successor = randomUUID();
  const threadId = randomUUID();
  const goalId = randomUUID();
  const worktree = join(h.settings.stateDirectory, 'native-worktree');
  const brief = join(h.settings.stateDirectory, 'native-brief.md');
  const pool = h.settings.pools[0]!;
  const invokeAs = (session: string, ...args: string[]) => invokePublicCli(h, undefined, session, 'codex', ...args);
  const registerResident = (session: string, ...flags: string[]) =>
    invokeAs(session, 'manager', 'register-supermanager', '--desktop', pool.name, ...flags);
  const registerUnit = (session: string, thread: string) =>
    invokeAs(
      session,
      'unit',
      'register',
      'fixture-unit',
      '--desktop',
      '--thread',
      thread,
      '--worktree',
      worktree,
      '--brief',
      brief,
      '--pool',
      pool.name,
    );
  try {
    const added = spawnSync('git', ['-C', h.root, 'worktree', 'add', '--detach', worktree], { encoding: 'utf8' });
    expect(added.status, added.stderr).toBe(0);
    mkdirSync(pool.configDirectory, { recursive: true });
    const threads = openDb(join(pool.configDirectory, 'state_5.sqlite'));
    const goals = openDb(join(pool.configDirectory, 'goals_1.sqlite'));
    try {
      threads.exec(
        'CREATE TABLE threads(id TEXT PRIMARY KEY, cwd TEXT, source TEXT, originator TEXT, archived INTEGER, rollout_path TEXT)',
      );
      goals.exec(
        'CREATE TABLE thread_goals(thread_id TEXT PRIMARY KEY, goal_id TEXT, objective TEXT, status TEXT, updated_at_ms INTEGER)',
      );
      for (const [id, cwd, goal] of [
        [former, h.root, randomUUID()],
        [successor, h.root, randomUUID()],
        [threadId, worktree, goalId],
      ] as const) {
        threads
          .query('INSERT INTO threads VALUES (?, ?, ?, ?, 0, ?)')
          .run(id, cwd, 'vscode', 'Codex Desktop', join(pool.configDirectory, id + '.jsonl'));
        goals.query('INSERT INTO thread_goals VALUES (?, ?, ?, ?, ?)').run(id, goal, 'Verify the fixture', 'active', 1);
      }
    } finally {
      goals.close();
      threads.close();
    }
    writeFileSync(
      brief,
      '---\nacceptance:\n  command: [bun, fixture.ts]\n  requires: [native]\n---\nVerify the fixture.\n',
    );

    const initial = await registerResident(former);
    expect(initial.code).toBe(0);
    const mismatched = await registerResident(successor, '--replace-session', randomUUID());
    expect(mismatched.code).toBe(1);
    expect(mismatched.stderr).toContain('replacement mismatch');
    const replaced = await registerResident(successor, '--replace-session', former);
    expect(replaced.code).toBe(0);
    expect(JSON.parse(replaced.stdout)).toMatchObject({ kind: 'resident-supermanager', threadId: successor });

    const stale = await registerUnit(former, threadId);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain('Only the registered root manager may register native units');
    const wrongTree = await registerUnit(successor, former);
    expect(wrongTree.code).toBe(1);
    expect(wrongTree.stderr).toContain('thread must be in its assigned worktree');
    const registered = await registerUnit(successor, threadId);
    expect(registered.code).toBe(0);
    expect(JSON.parse(registered.stdout)).toMatchObject({ id: 'fixture-unit', threadId, goalId, worktree, pane: null });
    const repeated = await registerUnit(successor, threadId);
    expect(repeated.code).toBe(0);
    expect(JSON.parse(repeated.stdout)).toEqual(JSON.parse(registered.stdout));

    const context = await invokeAs(threadId, 'unit', 'context', 'fixture-unit');
    expect(context.code).toBe(0);
    const { cwd, environment, command } = JSON.parse(context.stdout);
    expect(cwd).toBe(worktree);
    expect(command).toEqual(['bun', 'fixture.ts']);
    const observed = nativeUnitContext(environment);
    expect(observed).toMatchObject({ unit: 'fixture-unit', threadId, goalId, worktree });
    writeFileSync(
      join(worktree, 'fixture.ts'),
      `if (process.cwd() !== ${JSON.stringify(worktree)} || process.env.GOAL_TASK_ID || process.env.GOAL_ATTEMPT ||
          JSON.parse(process.env.REZICS_NATIVE_UNIT_CONTEXT).threadId !== ${JSON.stringify(threadId)} ||
          !process.env.REZICS_NATIVE_UNIT_RUN_ID) process.exit(1);
`,
    );
    const executed = await invokeAs(threadId, 'unit', 'run', 'fixture-unit');
    expect(executed.code, executed.stderr).toBe(0);
    expect(h.store.db.query('SELECT unit, requested_source_commit, exit_code FROM native_unit_runs').all()).toEqual([
      { unit: 'fixture-unit', requested_source_commit: observed!.sourceRevision, exit_code: 0 },
    ]);
    expect(h.store.taskIds()).toEqual([]);
  } finally {
    h.dispose();
  }
}, 10_000);
