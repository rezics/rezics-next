import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { migrate, openDb } from './db.ts';
import { nativeUnitContext } from './native-unit-context.ts';
import {
  nativeUnitEnvironment,
  nativeUnitMigrations,
  observeNativeUnitContext,
  registerNativeUnit,
  registeredNativeUnits,
} from './native-units.ts';
import { isWorker, walkAcceptanceId, walkStackRequired } from '../../../scripts/stack-run.ts';
import { walkStackLogPath } from '../../../scripts/walk-stack.ts';
import { runIntegration, type IntegrationRuntime } from './integration-cli.ts';
import { registerResidentSupermanager } from './managers.ts';
import { runNativeUnitCommand } from './native-unit-command.ts';
import type { Settings } from './types.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const temporary = join(import.meta.dir, '../../../.temp');
  mkdirSync(temporary, { recursive: true });
  const path = mkdtempSync(join(temporary, 'native-unit-'));
  roots.push(path);
  const worktree = join(path, 'repo');
  const codexHome = join(path, 'codex');
  const stateDirectory = join(path, 'state');
  for (const directory of [worktree, codexHome, stateDirectory]) mkdirSync(directory);
  expect(spawnSync('git', ['init', worktree], { stdio: 'ignore' }).status).toBe(0);
  expect(
    spawnSync('git', [
      '-C',
      worktree,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--allow-empty',
      '--quiet',
      '-m',
      'baseline',
    ]).status,
  ).toBe(0);
  const threadId = '11111111-1111-4111-8111-111111111111';
  const goalId = '22222222-2222-4222-8222-222222222222';
  const goals = new Database(join(codexHome, 'goals_1.sqlite'));
  goals.exec(
    'CREATE TABLE thread_goals(thread_id TEXT PRIMARY KEY, goal_id TEXT, objective TEXT, status TEXT, updated_at_ms INTEGER)',
  );
  goals
    .query('INSERT INTO thread_goals VALUES (?, ?, ?, ?, ?)')
    .run(threadId, goalId, 'Publish a book and read it', 'active', 1);
  goals.close();
  const threads = new Database(join(codexHome, 'state_5.sqlite'));
  threads.exec(
    'CREATE TABLE threads(id TEXT PRIMARY KEY, cwd TEXT, source TEXT, originator TEXT, archived INTEGER, rollout_path TEXT)',
  );
  threads
    .query('INSERT INTO threads VALUES (?, ?, ?, ?, 0, ?)')
    .run(threadId, worktree, 'vscode', 'Codex Desktop', join(path, 'rollout.jsonl'));
  threads.close();
  const briefPath = join(path, 'goal.md');
  writeFileSync(
    briefPath,
    '---\nacceptance:\n  command: [bun, apps/web/scripts/check.ts, --host, tests/native/hosted-book-journey.host.test.ts]\n  requires: [native, browser]\n---\nPublish and read a complete book.\n',
  );
  const termspacesStatus = {
    protocolVersion: 1,
    ok: true,
    data: {
      sessions: [
        {
          owned: true,
          windows: [
            {
              owned: true,
              panes: [
                {
                  runtimeId: '%12',
                  owned: true,
                  dead: false,
                  cwd: worktree,
                  spec: { argv: ['codex', 'resume', threadId, '--remote', 'unix:///tmp/test.sock'] },
                },
              ],
            },
          ],
        },
      ],
    },
  };
  const input = {
    id: 'book-unit',
    threadId,
    pane: '%12',
    worktree,
    briefPath,
    codexHome,
    pool: 'codex',
    mainCheckout: worktree,
    stateDirectory,
    termspacesStatus,
  };
  return { path, goals: join(codexHome, 'goals_1.sqlite'), db: openDb(join(stateDirectory, 'goal.sqlite')), input };
}

test('native registration and check context retain actual Goal identity without managed task records', () => {
  const f = fixture();
  try {
    const unit = registerNativeUnit(f.db, f.input);
    expect(registerNativeUnit(f.db, f.input).registeredAt).toBe(unit.registeredAt);
    expect(registeredNativeUnits(f.db)).toHaveLength(1);
    const env = nativeUnitEnvironment(unit);
    expect(observeNativeUnitContext(env)).toMatchObject({
      unit: 'book-unit',
      threadId: f.input.threadId,
      goalId: unit.goalId,
      requires: ['native', 'browser'],
    });
    expect(env.GOAL_TASK_ID).toBeUndefined();
    expect(isWorker(env)).toBe(true);
    expect(walkStackRequired(env)).toBe(true);
    expect(
      f.db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('worker_tasks', 'manager_sessions')")
        .all(),
    ).toEqual([]);
    expect(() => nativeUnitContext({ ...env, GOAL_TASK_ID: 'invented' })).toThrow('cannot also claim');
    const goals = new Database(f.goals);
    goals.exec("UPDATE thread_goals SET status='paused'");
    goals.close();
    expect(() => observeNativeUnitContext(env)).toThrow('no longer active');
  } finally {
    f.db.close();
  }
});

test('native registration verifies its termspaces viewer and keeps one worktree per unit', () => {
  const f = fixture();
  try {
    const pane = f.input.termspacesStatus.data.sessions[0]!.windows[0]!.panes[0]!;
    pane.spec.argv[2] = 'another-thread';
    expect(() => registerNativeUnit(f.db, f.input)).toThrow('attach its existing Codex thread');
    pane.spec.argv[2] = f.input.threadId;
    registerNativeUnit(f.db, f.input);
    expect(() => registerNativeUnit(f.db, { ...f.input, id: 'second-unit' })).toThrow('UNIQUE');
    writeFileSync(
      f.input.briefPath,
      '---\nacceptance:\n  command: [bun, another.ts]\n  requires: [native]\n---\nChanged goal.\n',
    );
    expect(() => nativeUnitEnvironment(registeredNativeUnits(f.db)[0]!)).toThrow('brief changed');
  } finally {
    f.db.close();
  }
});

test('walks require a scoped identity and exact acceptance tokens from managed callers', () => {
  const env = { GOAL_TASK_ID: 'managed-task', GOAL_ACCEPTANCE_REQUIRES: 'root,browser' };
  expect(walkAcceptanceId(env)).toBe('managed-task');
  expect(walkAcceptanceId(env, 'native')).toBeUndefined();
  expect(walkAcceptanceId({ ...env, GOAL_TASK_ID: '../wrong' })).toBeUndefined();
  expect(walkAcceptanceId({ GOAL_ACCEPTANCE_REQUIRES: 'native' })).toBeUndefined();
  expect(walkAcceptanceId({ ...env, GOAL_ACCEPTANCE_REQUIRES: 'native-approximation' })).toBeUndefined();
  expect(() => walkAcceptanceId({ ...env, REZICS_NATIVE_UNIT_CONTEXT: '{}' })).toThrow('Invalid native unit');
});

test('an active desktop resident hands off authority and launches only the assigned registered unit', async () => {
  const f = fixture();
  const { worktree: mainCheckout, codexHome, stateDirectory, threadId, briefPath, id } = f.input;
  const worktree = join(f.path, 'desktop-worktree');
  const manager = randomUUID();
  const former = randomUUID();
  const supermanager = 'supermanager';
  const pools = [{ name: 'codex', cli: 'codex', configDirectory: codexHome }] as Settings['pools'];
  const runtime = {
    db: f.db,
    mainCheckout,
    supermanager,
    pools,
    managerServices: {},
    integration: { supermanager },
    stateDirectory,
  };
  const settings = runtime as Settings;
  const replace = (previous: string) =>
    runIntegration(
      ['manager', 'register-supermanager', '--desktop', 'codex', '--replace-session', previous],
      runtime as IntegrationRuntime,
    );
  const register = (thread: string) =>
    runNativeUnitCommand(
      [
        'register',
        id,
        '--desktop',
        '--thread',
        thread,
        '--worktree',
        worktree,
        '--brief',
        briefPath,
        '--pool',
        'codex',
      ],
      { db: f.db, settings },
    );
  const prior = { CODEX_THREAD_ID: process.env.CODEX_THREAD_ID, CODEX_SESSION_ID: process.env.CODEX_SESSION_ID };
  const setCaller = (thread: string) =>
    Object.assign(process.env, { CODEX_THREAD_ID: thread, CODEX_SESSION_ID: thread });
  const native = new Database(join(codexHome, 'state_5.sqlite'));
  const goals = new Database(f.goals);
  try {
    expect(
      spawnSync('git', ['-C', mainCheckout, 'worktree', 'add', '--detach', worktree], { stdio: 'ignore' }).status,
    ).toBe(0);
    native
      .query('INSERT INTO threads VALUES (?, ?, ?, ?, 0, ?)')
      .run(manager, mainCheckout, 'vscode', 'Codex Desktop', join(f.path, 'manager.jsonl'));
    goals
      .query('INSERT INTO thread_goals VALUES (?, ?, ?, ?, ?)')
      .run(manager, randomUUID(), 'Manage units', 'active', 1);
    migrate(f.db, nativeUnitMigrations.slice(0, 1));
    registerResidentSupermanager(f.db, supermanager, former, { provider: 'codex' });
    setCaller(manager);
    await expect(register(threadId)).rejects.toThrow('Only the registered root manager');
    await expect(replace(randomUUID())).rejects.toThrow('replacement mismatch');
    expect(await replace(former)).toBe(0);
    await expect(register(randomUUID())).rejects.toThrow('existing Codex thread and native Goal');
    await expect(register(threadId)).rejects.toThrow('thread must be in its assigned worktree');
    native.query('UPDATE threads SET cwd = ?, archived = 1 WHERE id = ?').run(worktree, threadId);
    await expect(register(threadId)).rejects.toThrow('unarchived Codex Desktop thread');
    native.query('UPDATE threads SET archived = 0 WHERE id = ?').run(threadId);
    expect(await register(threadId)).toBe(0);
    const unit = registeredNativeUnits(f.db)[0]!;
    expect(unit.pane).toBeNull();
    const env = nativeUnitEnvironment(unit);
    expect(walkAcceptanceId(env, 'native', worktree)).toBe(id);
    expect(walkStackLogPath(worktree, id)).toBe(join(worktree, '.temp/walk/book-unit/stack.log'));
    expect(() => walkAcceptanceId(env, 'native', mainCheckout)).toThrow('check must start in its assigned worktree');
    expect(() => walkAcceptanceId({ ...env, GOAL_TASK_ID: 'managed-task' }, 'native', worktree)).toThrow(
      'cannot also claim',
    );
    setCaller(former);
    const run = () =>
      runNativeUnitCommand(
        [
          'run',
          id,
          '--',
          process.execPath,
          '-e',
          `if (process.cwd() !== ${JSON.stringify(worktree)} || process.env.GOAL_TASK_ID || !process.env.REZICS_NATIVE_UNIT_RUN_ID) process.exit(1)`,
        ],
        { db: f.db, settings },
      );
    await expect(run()).rejects.toThrow('belongs to its root manager');
    setCaller(threadId);
    expect(await run()).toBe(0);
    goals.query("UPDATE thread_goals SET status = 'paused' WHERE thread_id = ?").run(threadId);
    await expect(run()).rejects.toThrow('Goal must be active');
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    goals.close();
    native.close();
    f.db.close();
  }
});

test('a focused local check records its requested checkpoint without claiming observed immutable source', async () => {
  const f = fixture();
  const previousThread = process.env.CODEX_THREAD_ID;
  try {
    registerNativeUnit(f.db, f.input);
    process.env.CODEX_THREAD_ID = f.input.threadId;
    writeFileSync(join(f.input.worktree, 'local-dirty-source.txt'), 'not in the requested checkpoint');
    const command = [
      process.execPath,
      '-e',
      "process.exit(require('node:fs').readFileSync('local-dirty-source.txt','utf8') === 'not in the requested checkpoint' ? 0 : 1)",
    ];
    const settings = { integration: { supermanager: 'supermanager' } } as Settings;
    expect(await runNativeUnitCommand(['run', f.input.id, '--', ...command], { db: f.db, settings })).toBe(0);
    const row = f.db
      .query('SELECT command, requested_source_commit, source_commit, exit_code FROM native_unit_runs')
      .get() as {
      command: string;
      requested_source_commit: string;
      source_commit: string | null;
      exit_code: number;
    };
    expect(JSON.parse(row.command)).toEqual(command);
    expect(row.requested_source_commit).toMatch(/^[a-f0-9]{40}$/);
    expect(row.source_commit).toBeNull();
    expect(f.db.query('SELECT count(*) AS count FROM native_unit_run_sources').get()).toEqual({ count: 0 });
    expect(row.exit_code).toBe(0);
  } finally {
    if (previousThread === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = previousThread;
    f.db.close();
  }
});
