import { expect, test } from 'bun:test';
import { inlineStatements, literal, statement, transactionControl } from './support/sql-placement.ts';

const source = new URL('../src/', import.meta.url).pathname;

test('kernel source sends no SQL text but transaction control; every statement is a typed .sql file', async () => {
  expect(await inlineStatements(source)).toEqual([]);
});

test('the scan finds statements in any quote and case, and passes transaction control and other text', () => {
  const sample = [
    'await client.query("SELECT 1");',
    "await client.query('select id from core.receipt where partition_no = $1');",
    'const write = `\n  WITH fence AS (UPDATE core.partition SET position = position + 1) SELECT 1`;',
    "await client.query('SET search_path = core');",
    "await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');",
    "await client.query(`SET LOCAL statement_timeout = '${remaining}ms'`);",
    "await client.query('COMMIT'); await client.query('ROLLBACK');",
    "const methods = ['get', 'delete'] as const; const action = 'subject:create';",
  ].join('\n');
  const found = [...sample.matchAll(literal)]
    .map((match) => match[2]!)
    .filter((sql) => statement.test(sql) && !transactionControl.test(sql))
    .map((sql) => sql.trim().split(/\s+/).slice(0, 2).join(' '));
  expect(found).toEqual(['SELECT 1', 'select id', 'WITH fence', 'SET search_path']);
});
