import { expect, test } from 'bun:test';
import { greptimeRows } from './greptime.ts';

test('Greptime success has no code field; query errors and HTTP auth failures fail readiness', async () => {
  expect(
    await greptimeRows(
      Response.json({ output: [{ records: { rows: [[1]] } }], execution_time_ms: 1 }),
    ),
  ).toEqual([[1]]);
  await expect(greptimeRows(Response.json({ code: 1001, error: 'table_missing' }))).rejects.toThrow(
    'Greptime SQL failed',
  );
  await expect(greptimeRows(Response.json({}, { status: 401 }))).rejects.toThrow(
    'Greptime SQL failed',
  );
});
