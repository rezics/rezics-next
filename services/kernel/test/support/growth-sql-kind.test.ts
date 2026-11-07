import { expect, test } from 'bun:test';
import { costOf, isControlStatement, type Capture } from './growth-cost.ts';
import { classifyGrowthSql, executableSqlOffsets } from './growth-sql-kind.ts';
import { readAttemptLedger } from './growth.ts';

function captured(statements: string[], errors?: (string | null)[]): Capture {
  return {
    statements,
    plans: [],
    statementBackends: statements.map(() => 71),
    ...(errors === undefined ? {} : { statementErrors: errors }),
  };
}

test('classifies supported controls after SQL comments without matching lookalikes', () => {
  for (const sql of [
    '/* nested /* block */ comment */ BEGIN',
    '-- line comment\r\nSTART /* split */ TRANSACTION',
    '/* comment */ COMMIT',
    '/* comment */ ROLLBACK /* split */ WORK /* split */ TO savepoint_name',
    '/* comment */ SAVEPOINT s',
    '/* comment */ SET /* split */ LOCAL x = 1',
  ])
    expect(isControlStatement(sql)).toBe(true);
  for (const sql of ["SELECT 'COMMIT'", 'SELECT "BEGIN"', 'BEGINning', 'BEGIN$label', 'SET LOCALITY x'])
    expect(isControlStatement(sql)).toBe(false);
  expect(() => isControlStatement('/* comment only */')).toThrow(/empty or contains only comments/);
  expect(() => isControlStatement('/* unterminated')).toThrow(/unterminated leading SQL block comment/);
});

test('reads executable OFFSET clauses while ignoring comments and quoted lookalikes', () => {
  expect(
    executableSqlOffsets(`-- OFFSET 7
      SELECT 'OFFSET 8', E'OFFSET 9', "OFFSET", $$ OFFSET 10 $$, value
      OFFSET /* OFFSET 11 */ 0 LIMIT 3`),
  ).toEqual([{ operand: '0', bareZero: true }]);
  expect(executableSqlOffsets('SELECT 1 OFFSET 4')).toEqual([{ operand: '4', bareZero: false }]);
  expect(executableSqlOffsets('SELECT 1 OFFSET 0 + 1')).toEqual([{ operand: '0', bareZero: false }]);
  expect(executableSqlOffsets('SELECT value AS offset FROM labels')).toEqual([]);
  expect(executableSqlOffsets('SELECT offset + 1, label.offset FROM labels')).toEqual([]);
  expect(executableSqlOffsets(`SELECT 'OFFSET 4', $$ OFFSET 5 $$`)).toEqual([]);
});

test('commented transaction boundaries preserve savepoints, costs, and retry outcomes', () => {
  const committed = captured([
    '/* begin */ BEGIN',
    'SELECT 1',
    'ROLLBACK /* same attempt */ TO SAVEPOINT before_read',
    'SELECT \'COMMIT\', "BEGIN"',
    '-- end attempt\nCOMMIT',
  ]);
  expect(costOf(committed)).toMatchObject({ statements: 2, controlStatements: 3 });
  expect(readAttemptLedger(committed)).toMatchObject([
    { backend: 71, outcome: 'committed', statements: 2, occurrences: [0, 1, 2, 3, 4] },
  ]);

  const retried = captured(
    ['/* begin */ BEGIN', 'SELECT retryable_work()', '/* retry */ ROLLBACK'],
    [null, '40001', null],
  );
  expect(readAttemptLedger(retried)).toMatchObject([
    { backend: 71, outcome: 'aborted:40001', statements: 1, occurrences: [0, 1, 2] },
  ]);
});

test('a control prefix cannot stand for a multi-command wire message', () => {
  const hidden = captured(['BEGIN; SELECT 1', 'COMMIT']);
  expect(() => costOf(hidden)).toThrow(/leading control keyword/);
  expect(() => readAttemptLedger(hidden)).toThrow(/leading control keyword/);
  expect(() => classifyGrowthSql('START TRANSACTION; SELECT 1')).toThrow(/leading control keyword/);
  expect(() => classifyGrowthSql('ROLLBACK TO s; SELECT 1')).toThrow(/leading control keyword/);
  expect(() => classifyGrowthSql('SET LOCAL x = 1; SELECT 1')).toThrow(/leading control keyword/);

  expect(classifyGrowthSql('BEGIN;')).toBe('begin');
  expect(classifyGrowthSql('COMMIT; -- done')).toBe('commit');
  expect(classifyGrowthSql('ROLLBACK; /* trail */ ;')).toBe('rollback');
  expect(isControlStatement("SET LOCAL x = 'a;b'")).toBe(true);
  expect(isControlStatement(`SET LOCAL x = E'a\\;b'`)).toBe(true);
  expect(isControlStatement('SET LOCAL x = $tag$a;b$tag$')).toBe(true);
  expect(isControlStatement('SET LOCAL "x;y" = 1')).toBe(true);
  expect(isControlStatement('BEGIN /* nested /* ; */ still */')).toBe(true);
  expect(classifyGrowthSql('SELECT $tag$ BEGIN; SELECT 1 $tag$')).toBe('statement');
});
