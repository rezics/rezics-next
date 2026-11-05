import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSqliteProbe } from './support/sqlite-growth.ts';

test('SQLite probe reports executed statements and rows returned from the same executions', () => {
  const database = new Database(':memory:');
  database.exec('CREATE TABLE counted (id INTEGER PRIMARY KEY, value TEXT)');
  const probe = createSqliteProbe(database, { growingTables: ['counted'] });
  try {
    const insert = probe.measure(() =>
      probe.database.prepare('INSERT INTO counted (id, value) VALUES (?, ?)').run(1, 'one'),
    );
    expect(insert.counts).toEqual({ 'sqlite statements': 1, 'sqlite returned rows': 0 });
    expect(insert.statements[0]).toMatchObject({
      sql: 'INSERT INTO counted (id, value) VALUES (?, ?)',
      parameters: [1, 'one'],
      kind: 'insert',
    });

    const select = probe.measure(() => probe.database.prepare('SELECT id, value FROM counted WHERE id = ?').all(1));
    expect(select.value).toEqual([{ id: 1, value: 'one' }]);
    expect(select.counts).toEqual({ 'sqlite statements': 1, 'sqlite returned rows': 1 });
    expect(select.statements[0]).toMatchObject({
      sql: 'SELECT id, value FROM counted WHERE id = ?',
      parameters: [1],
      rows: 1,
      kind: 'read',
    });
    expect(select.statements[0]!.plan.some((row) => /^SEARCH/.test(row.detail))).toBe(true);
    expect(Object.keys(select.counts)).not.toContain('blocks');
    expect(Object.keys(select.counts).some((name) => /postgres|\bpg\b/i.test(name))).toBe(false);
  } finally {
    probe.restore();
    database.close();
  }
});
