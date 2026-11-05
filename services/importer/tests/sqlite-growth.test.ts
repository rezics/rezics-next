import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
  countedSample,
  countedViolations,
  type CountedCheck,
  type CountedValues,
} from '../../kernel/test/support/growth-counters.ts';
import { RecordStore } from '../src/record-store';
import { createSqliteProbe } from './support/sqlite-growth';

test('SQLite probe counts executed rows and statements and rejects growing scans', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE records(id INTEGER PRIMARY KEY, source TEXT NOT NULL)');
  for (let i = 0; i < 64; i++) db.run('INSERT INTO records VALUES(?,?)', [i, 'source']);
  db.exec('ANALYZE');
  const p = createSqliteProbe(db, { growingTables: ['records'] });
  try {
    const sample = p.measure(() => db.query('SELECT id FROM records WHERE id=?').get(2));
    expect(sample.counts).toEqual({ 'sqlite returned rows': 1, 'sqlite statements': 1 });
    p.verifyPlans();
    p.measure(() => db.query('SELECT id FROM records WHERE source=?').all('source'));
    expect(() => p.verifyPlans()).toThrow();
  } finally {
    p.restore();
    db.close();
  }
});

test('actual record store uses indexed keys at three analyzed scales', () => {
  // Native cached statements require installing the real probe before preparation.
  let p!: ReturnType<typeof createSqliteProbe>;
  const store = new RecordStore(':memory:', {
    instrumentDatabase(database) {
      p = createSqliteProbe(database, { growingTables: ['acknowledged_records', 'record_source_counts'] });
      return p.database;
    },
  });
  let previous = 0;
  const samples = [];
  try {
    for (const scale of [32, 128, 512]) {
      for (; previous < scale; previous++)
        store.put({
          source: 'wikidata',
          recordKey: `Q${previous}`,
          recordRevision: 'unversioned',
          digest: 'a'.repeat(64),
          converter_revision: 'test@1',
          state: 'present',
        });
      store.database.exec('ANALYZE');
      {
        const result = p.measure(() => {
          store.get('wikidata', 'Q1');
          store.count('wikidata');
          store.page('wikidata', { after: 'Q1', limit: 3 });
        });
        expect(result.counts['sqlite returned rows']).toBe(5);
        expect(result.counts['sqlite statements']).toBe(3);
        p.verifyPlans();
        samples.push({ scale, counted: countedSample([result.counts]) });
      }
    }
    const check: CountedCheck = {
      read: (value: unknown) => value as CountedValues,
      bounds: { 'sqlite returned rows': 'constant', 'sqlite statements': 'constant' },
    };
    expect(countedViolations(check, samples)).toEqual([]);
  } finally {
    p.restore();
    store.close();
  }
});

// These cases exercise native SQLite executions, including hostile plans that
// small result counts alone cannot detect.
function fixture() {
  const db = new Database(':memory:');
  db.exec(
    'CREATE TABLE records(id INTEGER PRIMARY KEY, source TEXT NOT NULL); CREATE INDEX by_source ON records(source); CREATE TABLE other(id INTEGER PRIMARY KEY, source TEXT NOT NULL)',
  );
  for (let i = 0; i < 64; i++) {
    db.run('INSERT INTO records VALUES(?,?)', [i, `s${i % 4}`]);
    db.run('INSERT INTO other VALUES(?,?)', [i, `s${i % 4}`]);
  }
  db.exec('ANALYZE');
  return db;
}

test('probe counts execution rather than preparation, preserves bindings and raw plans', () => {
  const db = fixture();
  const p = createSqliteProbe(db, { growingTables: ['records'] });
  try {
    const statement = db.prepare('SELECT id FROM records WHERE id=?', [2]);
    const result = p.measure(() => {
      statement.get();
      statement.get(99);
      statement.values(3);
      db.run('UPDATE records SET source=? WHERE id=?', ['changed', 2]);
    });
    expect(result.counts).toEqual({ 'sqlite returned rows': 2, 'sqlite statements': 4 });
    expect(result.statements.map((s) => s.parameters)).toEqual([[2], [99], [3], ['changed', 2]]);
    expect(result.statements.map((s) => s.rows)).toEqual([1, 0, 1, 0]);
    expect(p.verifyPlans().every((e) => e.plan.length > 0)).toBe(true);
    expect(p.measure(() => statement.get()).statements[0]!.parameters).toEqual([3]);
  } finally {
    p.restore();
    db.close();
  }
});

test('partial and unused iterators count only actual execution and consumed rows', () => {
  const db = fixture();
  const p = createSqliteProbe(db, { growingTables: ['records'] });
  try {
    const statement = db.query('SELECT id FROM records WHERE id>=?');
    const result = p.measure(() => {
      statement.iterate(0);
      for (const row of statement.iterate(0)) {
        expect(row).toEqual({ id: 0 });
        break;
      }
      // Bun requires a fresh statement after an early iterator return.
      const iterator = db.prepare('SELECT id FROM records WHERE id>=?').iterate(1);
      iterator.next();
      iterator.next();
      iterator.return?.();
    });
    expect(result.counts).toEqual({ 'sqlite returned rows': 3, 'sqlite statements': 2 });
    p.verifyPlans();
  } finally {
    p.restore();
    db.close();
  }
});

test('query cache, exec, transactions and returning writes count once', () => {
  const db = fixture();
  const p = createSqliteProbe(db, { growingTables: ['records'] });
  try {
    const statement = db.query('SELECT id FROM records WHERE id=?');
    expect(db.query('SELECT id FROM records WHERE id=?')).toBe(statement);
    const transaction = db.transaction(() => {
      statement.get(1);
      db.run('UPDATE records SET source=? WHERE id=?', ['x', 1]);
    });
    const result = p.measure(() => {
      transaction();
      db.exec("BEGIN; UPDATE records SET source='x' WHERE id=2; COMMIT");
      db.query('INSERT INTO records VALUES(?,?) RETURNING id').get(100, 'new');
    });
    expect(result.counts).toEqual({ 'sqlite returned rows': 2, 'sqlite statements': 8 });
    expect(result.statements.filter((s) => s.kind === 'control')).toHaveLength(4);
    expect(p.verifyPlans().some((e) => e.kind === 'insert')).toBe(true);
  } finally {
    p.restore();
    db.close();
  }
});

for (const sql of [
  'SELECT r.id FROM records AS r NOT INDEXED WHERE r.source=?',
  'SELECT r.id FROM records AS r INDEXED BY by_source',
  'SELECT id FROM records WHERE id>? ORDER BY source || id',
  'SELECT a.id FROM records AS a JOIN other AS b ON a.source=b.source WHERE a.id>?',
  'WITH hidden AS (SELECT * FROM records) SELECT id FROM hidden WHERE source || id=?',
  'UPDATE records SET source=?',
  'DELETE FROM records WHERE source || id=?',
  'INSERT INTO records SELECT id+100,source FROM records',
])
  test(`probe rejects unsafe native plan: ${sql}`, () => {
    const db = fixture();
    const p = createSqliteProbe(db, { growingTables: ['records', 'other'] });
    try {
      p.measure(() => db.query(sql).all('s1'));
      expect(() => p.verifyPlans()).toThrow();
    } finally {
      p.restore();
      db.close();
    }
  });

test('automatic indexes and temporary sorts retain raw engine evidence', () => {
  const db = fixture();
  // Avoid STAT4's tiny-table scan preference so SQLite chooses its automatic index.
  db.exec('DELETE FROM sqlite_stat1; ANALYZE sqlite_schema');
  const p = createSqliteProbe(db, { growingTables: ['records', 'other'] });
  try {
    const result = p.measure(() =>
      db.query('SELECT a.id FROM records a CROSS JOIN other b ON a.source=b.source WHERE a.id>?').all(0),
    );
    expect(result.statements[0]!.plan.some((row) => /AUTOMATIC/.test(row.detail))).toBe(true);
    expect(() => p.verifyPlans()).toThrow();
  } finally {
    p.restore();
    db.close();
  }
});

test('throws restore measurement state and explicit restore preserves original methods', () => {
  const db = fixture();
  const query = db.query;
  const run = db.run;
  const p = createSqliteProbe(db, { growingTables: ['records'] });
  const statement = db.query('SELECT id FROM records WHERE id=?');
  expect(() =>
    p.measure(() => {
      statement.get(1);
      throw new Error('operation failed');
    }),
  ).toThrow('operation failed');
  expect(p.measure(() => statement.get(2)).counts['sqlite statements']).toBe(1);
  expect(() => p.measure(() => db.query('INSERT INTO records VALUES(?,?)').run(1, 'private body'))).toThrow();
  p.restore();
  p.restore();
  expect(db.query).toBe(query);
  expect(db.run).toBe(run);
  expect(statement.get(2)).toEqual({ id: 2 });
  db.close();
});

test('evidence is bounded and unsupported plans fail without leaking parameters', () => {
  const db = fixture();
  const p = createSqliteProbe(db, { growingTables: ['records'] });
  try {
    p.measure(() => db.query('PRAGMA table_info(records)').all());
    expect(() => p.verifyPlans()).toThrow('Unsupported');
    expect(() =>
      p.measure(() => {
        for (let i = 0; i < 10000; i++) db.query('SELECT id FROM records WHERE id=?').get(1);
      }),
    ).toThrow('evidence limit');
  } finally {
    p.restore();
    db.close();
  }
});

test('closing the database restores instrumentation even inside a failed operation', () => {
  const db = fixture();
  const query = db.query;
  const p = createSqliteProbe(db, { growingTables: ['records'] });
  expect(() =>
    p.measure(() => {
      db.close();
      throw new Error('closed');
    }),
  ).toThrow('closed');
  expect(db.query).toBe(query);
  p.restore();
});

test('indexed writes, named bindings and explicit keyed inserts retain native evidence', () => {
  const db = fixture();
  const p = createSqliteProbe(db, { growingTables: ['records'] });
  try {
    const result = p.measure(() => {
      db.query('SELECT id FROM records WHERE id=$id').get({ $id: 2 });
      db.query('INSERT INTO records(id,source) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET source=excluded.source').run(
        100,
        'new',
      );
      db.query('DELETE FROM records WHERE id=?').run(100);
      db.exec("BEGIN; UPDATE records SET source='a;b' WHERE id=2; /* ; */ COMMIT;");
    });
    expect(result.counts).toEqual({ 'sqlite returned rows': 1, 'sqlite statements': 6 });
    expect(result.statements[0]!.parameters).toEqual([{ $id: 2 }]);
    expect(result.statements[1]!.kind).toBe('insert');
    expect(result.statements[2]!.changes).toBe(1);
    p.verifyPlans();
  } finally {
    p.restore();
    db.close();
  }
});

test('nested native transactions count real savepoint and rollback executions', () => {
  const db = fixture();
  const p = createSqliteProbe(db, { growingTables: ['records'] });
  try {
    const inner = db.transaction(() => {
      db.query('SELECT id FROM records WHERE id=?').get(2);
      throw new Error('rollback');
    });
    const outer = db.transaction(() => {
      expect(() => inner()).toThrow('rollback');
    });
    const result = p.measure(() => outer.immediate());
    expect(result.counts).toEqual({ 'sqlite returned rows': 1, 'sqlite statements': 6 });
    expect(result.statements.filter((s) => s.kind === 'control')).toHaveLength(5);
    p.verifyPlans();
  } finally {
    p.restore();
    db.close();
  }
});

test('probe does not intercept unrelated databases and restores statement methods', () => {
  const db = fixture();
  const other = fixture();
  const p = createSqliteProbe(db, { growingTables: ['records'] });
  try {
    const prepared = db.prepare('SELECT id FROM records WHERE id=?');
    const measured = p.measure(() => {
      other.query('SELECT * FROM records').all();
      prepared.get(3);
    });
    expect(measured.counts).toEqual({ 'sqlite returned rows': 1, 'sqlite statements': 1 });
    const instrumented = prepared.get;
    p.restore();
    expect(prepared.get).not.toBe(instrumented);
    expect(prepared.get(4)).toEqual({ id: 4 });
  } finally {
    p.restore();
    db.close();
    other.close();
  }
});

test('compound exec preserves native aggregate changes, empty SQL and quoted boundaries', () => {
  const db = fixture();
  const p = createSqliteProbe(db, { growingTables: ['records'] });
  try {
    const result = p.measure(() =>
      db.exec("INSERT INTO records VALUES(100,'a;b'); -- ;\n INSERT INTO records VALUES(101,'second')"),
    );
    expect(result.value).toEqual({ changes: 2, lastInsertRowid: 101 });
    expect(result.counts).toEqual({ 'sqlite returned rows': 0, 'sqlite statements': 2 });
    const empty = p.measure(() => expect(() => db.exec('-- only a comment')).toThrow());
    expect(empty.counts['sqlite statements']).toBe(0);
    p.verifyPlans();
  } finally {
    p.restore();
    db.close();
  }
});

test('writes with opaque trigger reads fail closed even when their outer key is indexed', () => {
  const db = fixture();
  db.exec('CREATE TRIGGER hidden_read AFTER UPDATE ON records BEGIN SELECT source FROM records; END');
  const p = createSqliteProbe(db, { growingTables: ['records'] });
  try {
    p.measure(() => db.run('UPDATE records SET source=? WHERE id=?', ['x', 1]));
    expect(() => p.verifyPlans()).toThrow('Unsupported');
  } finally {
    p.restore();
    db.close();
  }
});

test('binary binding evidence is capped without printing its content', () => {
  const db = fixture();
  const p = createSqliteProbe(db, { growingTables: ['records'] });
  try {
    expect(() => p.measure(() => db.query('SELECT ?').get(new ArrayBuffer(1024 * 1024 + 1)))).toThrow('evidence limit');
    expect(() => p.verifyPlans()).toThrow();
  } finally {
    p.restore();
    db.close();
  }
});

test('generated insert keys cannot be certified as explicit keyed writes', () => {
  const db = fixture();
  const p = createSqliteProbe(db, { growingTables: ['records'] });
  try {
    p.measure(() => db.run('INSERT INTO records(id,source) VALUES(?,?)', [null, 'generated']));
    expect(() => p.verifyPlans()).toThrow('Unsupported');
  } finally {
    p.restore();
    db.close();
  }
});
