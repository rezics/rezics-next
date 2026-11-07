import { expect, spyOn, test } from 'bun:test';
import { CommandUnavailableError } from '../../src/command/command.ts';
import { withCommandTiming } from '../../src/command/timing.ts';
import { PROBLEM_TYPE_BASE } from '../../src/http/problem.ts';
import {
  asUniqueContention,
  BULK_UNIQUE_CONTENTION_CONSTRAINTS,
  PROPOSAL_UNIQUE_CONTENTION_CONSTRAINTS,
} from '../../src/semantic/candidate-command.ts';
import {
  bulkWriteAction,
  bulkWriteCommandProblem,
  bulkWriteDiagnostics,
  bulkWriteUnavailableSchema,
} from '../../src/semantic/http/bulk.ts';

test('unique constraint races become Core contention codes', () => {
  const error = { code: '23505', constraint: 'source_candidate_pkey' };
  expect(asUniqueContention(error, BULK_UNIQUE_CONTENTION_CONSTRAINTS)).toEqual({
    code: '40001',
    constraint: 'source_candidate_pkey',
  });
  const proposal = { code: '23505', constraint: 'candidate_pkey' };
  expect(asUniqueContention(proposal, PROPOSAL_UNIQUE_CONTENTION_CONSTRAINTS)).toMatchObject({ code: '40001' });
  const editorial = { code: '23505', constraint: 'editorial_conflict_pkey' };
  expect(asUniqueContention(editorial, BULK_UNIQUE_CONTENTION_CONSTRAINTS)).toEqual(editorial);
});

test('bulk propose maps exhausted contention to a complete RFC9457 problem', async () => {
  const requestId = Bun.randomUUIDv7();
  const error = new CommandUnavailableError('contention', 12);
  const lines: unknown[][] = [];
  const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => void lines.push(args));
  try {
    const result = await withCommandTiming(() =>
      bulkWriteCommandProblem(error, { requestId, commandIndex: 4, op: 'propose' }),
    );
    expect(result.status).toBe(503);
    expect(result.problem).toMatchObject({
      type: `${PROBLEM_TYPE_BASE}transaction_retry_exhausted`,
      code: 'transaction_retry_exhausted',
      retryable: true,
      request_id: requestId,
      operation: 'statement:propose',
      partition: 12,
      phase: 'before_command',
    });
    expect(JSON.stringify(result.problem)).not.toContain('password');
    expect(JSON.stringify(result.problem)).not.toContain('BEGIN');
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]![0] as string);
    expect(line).toMatchObject({
      event: 'transaction_retry_exhausted',
      request_id: requestId,
      method: 'POST',
      route: '/v1/subjects:batchWrite',
      command_index: 4,
      operation: 'statement:propose',
      partition: 12,
      dominant_phase: 'before_command',
    });
  } finally {
    spy.mockRestore();
  }
});

test('bulk create and propose actions stay distinct and diagnostics omit unknown phases', () => {
  expect(bulkWriteAction('create')).toBe('subject:create');
  expect(bulkWriteAction('propose')).toBe('statement:propose');
  expect(bulkWriteDiagnostics(new Error('not a command'), 'statement:propose')).toEqual({
    operation: 'statement:propose',
  });
  const schema = bulkWriteUnavailableSchema();
  expect(JSON.stringify(schema)).toContain('transaction_retry_exhausted');
  expect(JSON.stringify(schema)).toContain('partition_unavailable');
});
