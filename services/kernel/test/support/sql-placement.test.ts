import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inlineStatements, literal, statement, transactionControl } from './sql-placement.ts';

function flagged(source: string): string[] {
  return [...source.matchAll(literal)]
    .map((match) => match[2]!)
    .filter((sql) => statement.test(sql) && !transactionControl.test(sql))
    .map((sql) => sql.trim().split(/\s+/).slice(0, 2).join(' '));
}

test('the scanner flags a statement in any quote and case', () => {
  const sample = [
    'await client.query("SELECT 1");',
    "await client.query('select id from core.receipt where partition_no = $1');",
    'const write = `\n  WITH fence AS (UPDATE core.partition SET position = position + 1) SELECT 1`;',
    "await client.query('SET search_path = core');",
    'await client.query("SeLeCt 1");',
    "const methods = ['get', 'delete'] as const; const action = 'subject:create';",
  ].join('\n');
  expect(flagged(sample)).toEqual(['SELECT 1', 'select id', 'WITH fence', 'SET search_path', 'SeLeCt 1']);
});

test('the scanner passes BEGIN ISOLATION LEVEL with READ ONLY and SET LOCAL', () => {
  const sample = [
    "await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');",
    "await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');",
    "await client.query(`SET LOCAL statement_timeout = '${remaining}ms'`);",
    "await client.query('SET LOCAL enable_seqscan = off');",
    "await client.query('COMMIT'); await client.query('ROLLBACK');",
  ].join('\n');
  expect(flagged(sample)).toEqual([]);
});

test('the scanner flags BEGIN READ ONLY', () => {
  expect(flagged("await bounded.query('BEGIN READ ONLY');")).toEqual(['BEGIN READ']);
});

test('the scanner does not flag an error message such as Copy revision conflicts while it still flags COPY statements in upper and lower case', () => {
  const sample = [
    "super('Copy revision conflicts');",
    "await client.query('COPY accounts FROM STDIN');",
    "await client.query('copy accounts to stdout');",
    'await client.query("COPY accounts");',
    'await client.query("copy accounts");',
  ].join('\n');
  expect(flagged(sample)).toEqual(['COPY accounts', 'copy accounts', 'COPY accounts', 'copy accounts']);
});

test('the access gate visibility read opens its read-only transaction in an allowed form', async () => {
  const visibility = new URL('../../src/access/gates/visibility.ts', import.meta.url);
  const text = await Bun.file(visibility).text();
  expect(text).toContain("'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'");
  const gates = new URL('./', visibility).pathname;
  const found = (await inlineStatements(gates)).filter((line) => line.startsWith('visibility.ts:'));
  expect(found).toEqual([]);
});

test('Access source has no inline statement', async () => {
  const access = new URL('../../src/access/', import.meta.url).pathname;
  expect(await inlineStatements(access)).toEqual([]);
});

test('inline statements are reported with their file and line', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sql-placement-'));
  const root = `${directory}/`;
  await Bun.write(
    `${root}sample.ts`,
    'const message = "Copy revision conflicts";\nawait client.query("BEGIN READ ONLY");\nawait client.query("copy t FROM STDIN");\nawait client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");\n',
  );
  try {
    expect(await inlineStatements(root)).toEqual(['sample.ts:2 BEGIN READ ONLY', 'sample.ts:3 copy t FROM STDIN']);
  } finally {
    await rm(directory, { recursive: true });
  }
});
