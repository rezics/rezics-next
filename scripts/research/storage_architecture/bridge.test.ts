import { expect, test } from 'bun:test';
import { bridgeMapping, bridgeStatementLogs, bridgeValuesQuery, queryRows, verifyWorkRows } from './bridge';
import { PREFIX } from './fixture';

test('outer binding cases stay outside the SQL GRAPH block at the cap boundary', () => {
  for (const count of [1_999, 2_001, 5_000]) {
    const query = bridgeValuesQuery(count);
    const where = query.where as unknown[][];
    expect(where).toHaveLength(2);
    expect(where[0]![0]).toBe('values');
    expect(where[1]![0]).toBe('graph');
    const values = (where[0]![1] as unknown[])[1] as Array<{ '@id': string }>;
    expect(values).toHaveLength(count);
    expect(values[0]).toEqual({ '@id': `${PREFIX}r/work/0` });
    expect(values.at(-1)).toEqual({ '@id': `${PREFIX}r/work/${count - 1}` });
    expect(new Set(values.map(value => value['@id'])).size).toBe(count);
  }
  expect(() => bridgeValuesQuery(0)).toThrow();
  expect(() => bridgeValuesQuery(6_001)).toThrow();
});

test('mapping exposes decimal and JSONB paths as separate source columns', () => {
  const mapping = bridgeMapping();
  expect(mapping).toContain('rr:tableName "bridge_work"');
  expect(mapping).toContain(`rr:template "${PREFIX}r/work/{id}"`);
  expect(mapping).toContain('rr:column "amount" ; rr:datatype xsd:decimal');
  expect(mapping).toContain('rr:column "payload"');
});

test('statement telemetry excludes startup and cancellation logs', () => {
  const lines = [
    '2026 INFO fluree_sql_bridge: statement id=x sql=SELECT 1',
    '2026 INFO fluree_sql_bridge: fluree-sql-bridge ready',
    '2026 INFO fluree_sql_bridge: statement cancelled id=x',
    '2026 INFO fluree_sql_bridge: statement id=y sql=SELECT 2',
  ];
  expect(bridgeStatementLogs(lines)).toEqual([lines[0], lines[3]]);
  expect(queryRows({ result: [[1], [2]], status: 200 })).toEqual([[1], [2]]);
  expect(() => queryRows({ error: 'failure' })).toThrow();
});

test('row oracle catches missing, duplicate, and wrong-title source mappings', () => {
  expect(verifyWorkRows([['Work 1', `${PREFIX}r/work/1`], [`${PREFIX}r/work/0`, 'Work 0']], 2)).toEqual({ correct: true, problems: [] });
  expect(verifyWorkRows([[`${PREFIX}r/work/0`, 'Work 0'], [`${PREFIX}r/work/0`, 'Work 0']], 2).correct).toBe(false);
  expect(verifyWorkRows([[`${PREFIX}r/work/0`, 'Wrong']], 1).correct).toBe(false);
});
