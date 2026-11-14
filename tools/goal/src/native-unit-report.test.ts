import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrate, openDb } from './db.ts';
import { nativeUnitMigrations, type NativeUnit } from './native-units.ts';
import { nativeUnitReportLines } from './native-unit-report.ts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const bucket = { start: '2026-11-15T00:00:00.000Z', end: '2026-11-15T01:00:00.000Z' };

function fixture() {
  const temporary = join(import.meta.dir, '../../../.temp');
  mkdirSync(temporary, { recursive: true });
  const directory = mkdtempSync(join(temporary, 'native-report-'));
  directories.push(directory);
  const codexHome = join(directory, 'codex');
  mkdirSync(codexHome);
  const native = new Database(join(codexHome, 'state_5.sqlite'));
  native.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, source TEXT)');
  const goals = new Database(join(codexHome, 'goals_1.sqlite'));
  goals.exec('CREATE TABLE thread_goals(thread_id TEXT PRIMARY KEY, goal_id TEXT, status TEXT, tokens_used INTEGER)');
  goals.exec("INSERT INTO thread_goals VALUES ('parent', 'goal', 'active', 99999999)");
  const db = openDb(join(directory, 'goal.sqlite'));
  migrate(db, nativeUnitMigrations);
  db.exec(
    "CREATE TABLE worker_attempts(task_id TEXT, attempt INTEGER, body TEXT); CREATE INDEX worker_attempts_session ON worker_attempts(json_extract(body, '$.session'))",
  );
  const unit = { version: 1, id: 'books', threadId: 'parent', goalId: 'goal', codexHome } as NativeUnit;
  db.query('INSERT INTO native_execution_units VALUES (?, ?, ?, ?, ?)').run(
    'books',
    'parent',
    '%12',
    directory,
    JSON.stringify(unit),
  );
  const thread = (id: string, events: unknown[], parent?: string) => {
    const path = join(directory, `${id}.jsonl`);
    writeFileSync(path, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
    native
      .query('INSERT INTO threads VALUES (?, ?, ?)')
      .run(id, path, parent ? JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: parent } } }) : 'vscode');
  };
  return {
    db,
    native,
    goals,
    thread,
    close() {
      db.close();
      native.close();
      goals.close();
    },
  };
}

function charge(response: string, input: number, cached: number, output: number) {
  return {
    type: 'token_usage_record',
    timestamp: '2026-11-15T00:10:00.000Z',
    response_id: response,
    payload: { usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } },
  };
}
function child(id: string) {
  return {
    type: 'event_msg',
    payload: { type: 'item_completed', item: { type: 'SubAgentActivity', agent_thread_id: id } },
  };
}

test('hourly native accounting follows verified children and deduplicates copied responses and managed sessions', () => {
  const f = fixture();
  try {
    const parentCharge = charge('response-parent', 10, 2, 3);
    f.thread('parent', [
      parentCharge,
      child('helper'),
      child('managed'),
      {
        type: 'event_msg',
        payload: { type: 'item_completed', item: { type: 'McpToolCall', result: { agent_thread_id: 'unrelated' } } },
      },
    ]);
    f.thread('helper', [parentCharge, charge('response-child', 20, 5, 4)], 'parent');
    f.thread('managed', [charge('response-managed', 1000, 0, 1000)], 'parent');
    f.thread('unrelated', [charge('response-unrelated', 5000, 0, 5000)]);
    f.db.query('INSERT INTO worker_attempts VALUES (?, ?, ?)').run('task', 1, JSON.stringify({ session: 'managed' }));
    f.db
      .query(
        'INSERT INTO native_unit_runs(id,unit,started_at,ended_at,exit_code,context,command) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run('observed-startup-failure', 'books', '2026-11-15T00:05:00.000Z', '2026-11-15T00:06:00.000Z', 1, '{}', '[]');
    const lines = nativeUnitReportLines(f.db, bucket);
    expect(lines[0]).toContain('3 distinct parent/subagent sessions observed; 2 measured; 0 unknown');
    expect(lines[1]).toContain('30 input, 7 cached input, 7 output');
    expect(lines[1]).toContain('1 managed sessions excluded; 1 copied response records deduplicated');
    expect(lines[2]).toContain('captured exit zero 0; nonzero 1');
    expect(lines[2]).toContain('source checkpoint unknown 1');
    expect(lines.join('\n')).not.toContain('99999999');
    expect(
      f.db
        .query(
          "EXPLAIN QUERY PLAN SELECT 1 FROM worker_attempts INDEXED BY worker_attempts_session WHERE json_extract(body,'$.session')=? LIMIT 1",
        )
        .all('managed')[0],
    ).toMatchObject({ detail: expect.stringContaining('worker_attempts_session') });
  } finally {
    f.close();
  }
});

test('native accounting reports missing session ledger as unknown rather than zero usage', () => {
  const f = fixture();
  try {
    f.thread('parent', [
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 5000 } } } },
    ]);
    const lines = nativeUnitReportLines(f.db, bucket);
    expect(lines[0]).toContain('0 measured; 1 unknown');
    expect(lines[1]).toContain('totals are partial');
  } finally {
    f.close();
  }
});
