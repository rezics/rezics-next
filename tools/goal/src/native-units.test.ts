import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDb } from './db.ts';
import { nativeUnitContext } from './native-unit-context.ts';
import {
  nativeUnitEnvironment,
  observeNativeUnitContext,
  registerNativeUnit,
  registeredNativeUnits,
} from './native-units.ts';
import { isWorker, walkStackRequired } from '../../../scripts/stack-run.ts';
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
  threads.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, cwd TEXT, rollout_path TEXT, source TEXT)');
  threads
    .query('INSERT INTO threads VALUES (?, ?, ?, ?)')
    .run(threadId, worktree, join(path, 'rollout.jsonl'), 'vscode');
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
