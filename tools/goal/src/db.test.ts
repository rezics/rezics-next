import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openDb } from './db.ts';

test('migrations apply once per module and version and stay applied after restart', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'goal-db-')), 'goal.db');
  let db = openDb(path);
  const steps = [
    { module: 'b', version: 1, sql: 'CREATE TABLE b_one (id TEXT PRIMARY KEY); CREATE TABLE b_two (id TEXT)' },
    { module: 'a', version: 1, sql: 'CREATE TABLE a_one (id TEXT PRIMARY KEY)' },
  ];
  migrate(db, steps);
  migrate(db, [...steps, { module: 'a', version: 2, sql: 'ALTER TABLE a_one ADD COLUMN note TEXT' }]);
  const tables = db.query('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name').all('table');
  expect(tables.map((row) => (row as { name: string }).name)).toEqual(['a_one', 'b_one', 'b_two', 'schema_migrations']);
  expect(db.query('SELECT count(*) AS n FROM schema_migrations').get()).toEqual({ n: 3 });
  expect((db.query('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
  db.close();

  db = openDb(path);
  try {
    migrate(db, [...steps, { module: 'a', version: 2, sql: 'ALTER TABLE a_one ADD COLUMN note TEXT' }]);
    expect(db.query('SELECT count(*) AS n FROM schema_migrations').get()).toEqual({ n: 3 });
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='a_one'").get()).toEqual({
      name: 'a_one',
    });
  } finally {
    db.close();
  }
});
