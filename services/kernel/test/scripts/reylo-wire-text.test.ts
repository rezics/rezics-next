import { expect, spyOn, test } from 'bun:test';
import { checks, defineQuery } from 'reylo';

test('fixed SQL keeps exact source attribution and binds every concurrent input independently', async () => {
  const query = defineQuery<{ id: string }, { id: string }, 'one', 'postgres'>({
    dialect: 'postgres',
    sql: 'SELECT :id::text AS id -- origin\n; ',
    params: ['id'],
    columns: [['id', 'text']],
    cardinality: 'one',
    source: "src/é'notes.sql",
    sqlcommenter: true,
  });
  const expected = "SELECT $1::text AS id -- origin\n/*file='src%2F%C3%A9\\'notes.sql'*/;";
  const ids = ['first', "quote'--", 'third'];
  const sent: string[] = [];
  const client = {
    async query(text: string, values: string[]) {
      sent.push(text);
      await Promise.resolve();
      return { rows: [{ id: values[0] }], fields: [] };
    },
  };
  const results = await Promise.all(ids.map((id) => query.run(client, { id })));
  expect(results).toEqual(ids.map((id) => ({ id })));
  expect(sent).toEqual(ids.map(() => expected));
  expect(query.sql).toBe('SELECT $1::text AS id -- origin\n; ');
  expect(query['~standard'].query.text).toBe(expected);
  expect(ids.map((id) => query['~standard'].query.encode({ id }))).toEqual(ids.map((id) => [id]));
});

test('a structured insert retains the SQL variant and bound values for each call', async () => {
  type Row = { a: string; b?: string };
  const sql = 'INSERT INTO t (a, b) SELECT a, b FROM source(?)';
  const field = (name: string, optional: boolean) => ({
    name,
    optional,
    written: 'text',
    nullable: false,
    type: { kind: 'scalar' as const, name: 'text' },
  });
  const lists = [sql.indexOf('a, b'), sql.lastIndexOf('a, b')].map((start) => ({
    start,
    end: start + 4,
    entries: ['a', 'b'],
  }));
  const query = defineQuery<{ row: Row }, never, 'none', 'mysql'>({
    dialect: 'mysql',
    sql,
    text: sql,
    params: ['row'],
    order: ['row'],
    cardinality: 'none',
    source: 'insert.sql',
    sqlcommenter: true,
    structured: [{ name: 'row', lists }],
    checks,
    inputs: { row: { type: { kind: 'rows', one: true, fields: [field('a', false), field('b', true)] } } },
  });
  const sent: { text: string; values: string[] }[] = [];
  const client = {
    async execute(text: string, values: string[] = []) {
      sent.push({ text, values });
      return { rows: [], statement: text };
    },
  };
  const rows: Row[] = [{ a: '1' }, { a: '2', b: 'other' }, { a: '3' }];
  await Promise.all(rows.map((row) => query.run(client, { row })));
  expect(sent).toEqual(
    rows.map((row) => ({
      text: (row.b ? sql : 'INSERT INTO t (a) SELECT a FROM source(?)') + " /*file='insert.sql'*/",
      values: [JSON.stringify(row)],
    })),
  );
  expect(() => query['~standard'].query.encode({ row: rows[0]! })).toThrow('depends on its input');
});

test('the pinned Reylo executor rechecks attribution settings on a mutable query module', async () => {
  // defineQuery snapshots its definition. Exercise the lower-level module received by the patched executor itself.
  const { execute } = await import(new URL('./execute.js', import.meta.resolve('reylo')).href);
  const module = { dialect: 'postgres', sql: 'SELECT 1;', params: [], source: 'before.sql', sqlcommenter: true };
  const sent: string[] = [];
  const client = {
    async query(text: string) {
      sent.push(text);
      return { rows: [] };
    },
  };
  await execute(client, module, {});
  module.sqlcommenter = false;
  await execute(client, module, {});
  module.source = 'after.sql';
  module.sqlcommenter = true;
  await execute(client, module, {});
  module.sql = 'SELECT 2;  ';
  await execute(client, module, {});
  module.source = '';
  await execute(client, module, {});
  // A hand-built JavaScript definition may supply mutable string coercion.
  let name = 'one.sql';
  const mutable = { ...module, source: { toString: () => name } };
  await execute(client, mutable, {});
  name = 'two.sql';
  await execute(client, mutable, {});
  expect(sent).toEqual([
    "SELECT 1 /*file='before.sql'*/;",
    'SELECT 1;',
    "SELECT 1 /*file='after.sql'*/;",
    "SELECT 2 /*file='after.sql'*/;",
    'SELECT 2;  ',
    "SELECT 2 /*file='one.sql'*/;",
    "SELECT 2 /*file='two.sql'*/;",
  ]);
});

test('each query retains only its last matching wire text', async () => {
  const { execute } = await import(new URL('./execute.js', import.meta.resolve('reylo')).href);
  const source = 'wire-cache-test.sql';
  const module = { dialect: 'postgres', sql: 'SELECT 1;', params: [], source, sqlcommenter: true };
  const client = {
    async query() {
      return { rows: [] };
    },
  };
  const encode = spyOn(globalThis, 'encodeURIComponent');
  try {
    for (const sql of ['SELECT 1;', 'SELECT 1;', 'SELECT 2;', 'SELECT 1;']) {
      module.sql = sql;
      await execute(client, module, {});
    }
    // A second query with the same text and source owns an independent entry.
    await execute(client, { ...module }, {});
    expect(encode.mock.calls.filter(([value]) => value === source)).toHaveLength(4);
  } finally {
    encode.mockRestore();
  }
});
