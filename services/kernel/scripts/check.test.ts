import { expect, test } from 'bun:test';
import { formatPostgresErrors, reportPostgresErrors, startPostgresContainer } from './check.ts';

test('the check database logs each error with its SQLSTATE', () => {
  const calls: string[][] = [];
  const container = startPostgresContainer((args) => (calls.push(args), 'postgres-container'));
  const args = calls[0]!;
  const prefix = args.indexOf('log_line_prefix=%m [%p] [%e] ');

  expect(container).toBe('postgres-container');
  expect(prefix).toBeGreaterThan(0);
  expect(args[prefix - 1]).toBe('-c');
});

test("a failing kernel check prints the database server's errors and fatal messages by SQLSTATE", () => {
  const logLines = [
    '2026-10-28 01:02:03 UTC [100] [53300] ERROR: outside the retained log tail',
    ...Array.from({ length: 298 }, (_, index) => `retained non-error line ${index}`),
    '2026-10-28 01:02:04 UTC [101] [53300] ERROR: remaining connection slots are reserved',
    '2026-10-28 01:02:05 UTC [102] [53300] ERROR: sorry, too many clients already',
    '2026-10-28 01:02:06 UTC [103] [57P03] FATAL: the database system is starting up',
    '2026-10-28 01:02:07 UTC [104] [XX000] PANIC: forced server panic',
  ].join('\n');
  const calls: string[][] = [];
  let printed = '';

  reportPostgresErrors(
    'postgres-container',
    (args) => (calls.push(args), logLines),
    (message) => (printed += message),
  );

  expect(calls).toEqual([['logs', '--tail', '300', 'postgres-container']]);
  expect(printed).toContain('grouped by SQLSTATE');
  expect(printed).toContain('53300 ERROR: 2; first: remaining connection slots are reserved');
  expect(printed).toContain('57P03 FATAL: 1; first: the database system is starting up');
  expect(printed).toContain('XX000 PANIC: 1; first: forced server panic');
  expect(printed).not.toContain('outside the retained log tail');
  expect(formatPostgresErrors('2026-10-28 01:02:08 UTC [105] [00000] LOG: checkpoint complete')).toBeNull();
});
