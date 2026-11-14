import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { withReportReadConnection } from '../../src/content/report-read-connection.ts';
import type { AccessClient } from '../../src/request/access.ts';

const begin = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';

function connection(statements: string[], blocked?: string, release: (error?: Error) => void = () => {}) {
  return {
    query: ((input: string | { text: string }) => {
      const sql = typeof input === 'string' ? input : input.text;
      statements.push(sql);
      return sql === blocked ? new Promise<never>(() => {}) : Promise.resolve({ rows: [] });
    }) as PoolClient['query'],
    release,
  } as unknown as PoolClient;
}

test('a stalled report read discards its connection and permits the next visit', async () => {
  const stalledStatements: string[] = [];
  const retryStatements: string[] = [];
  let discarded: Error | undefined;
  const clients = [
    connection(stalledStatements, 'SELECT report', (error) => (discarded = error)),
    connection(retryStatements),
  ];
  let index = 0;
  const pool = { connect: async () => clients[index++]! } as unknown as Pool;
  const read = (client: AccessClient) => client.query('SELECT report').then(() => 'report');

  await expect(withReportReadConnection(pool, Date.now() + 100, read)).rejects.toBeInstanceOf(AccessUnavailableError);
  expect(discarded).toBeInstanceOf(AccessUnavailableError);
  expect(stalledStatements).toEqual([begin, 'SELECT report']);
  expect(await withReportReadConnection(pool, Date.now() + 1_000, read)).toBe('report');
  expect(retryStatements).toEqual([begin, 'SELECT report', 'COMMIT']);
});
