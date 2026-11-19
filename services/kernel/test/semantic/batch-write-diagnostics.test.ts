import { expect, spyOn, test } from 'bun:test';
import { CommandCommitUncertainError, CommandUnavailableError } from '../../src/command/command.ts';
import { countContentionRetry, withCommandTiming } from '../../src/command/timing.ts';
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
    const result = await withCommandTiming(() => {
      countContentionRetry();
      return bulkWriteCommandProblem(error, { requestId, commandIndex: 4, op: 'propose' });
    });
    expect(result.status).toBe(503);
    expect(result.problem).toMatchObject({
      type: `${PROBLEM_TYPE_BASE}transaction_retry_exhausted`,
      code: 'transaction_retry_exhausted',
      retryable: true,
      request_id: requestId,
      operation: 'statement:propose',
      partition: 12,
      phase: 'before_command',
      contention_retries: 1,
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
      contention_retries: 1,
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

test('bulk internal failures expose only the supplied stage and the response command index', async () => {
  const requestId = Bun.randomUUIDv7();
  const log = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const result = await bulkWriteCommandProblem(new Error('private provider text'), {
      requestId,
      commandIndex: 4,
      op: 'retract',
      failureStage: 'source_fence',
    });
    expect(result).toMatchObject({
      status: 500,
      problem: { code: 'internal_error', request_id: requestId, command_index: 4, failure_stage: 'source_fence' },
    });
    expect(JSON.stringify(result.problem)).not.toContain('private provider text');
  } finally {
    log.mockRestore();
  }
});

test('catalogue 53200 observations preserve the uncertain receipt and classify only private server evidence', async () => {
  const log = spyOn(console, 'error').mockImplementation(() => {});
  const { REZICS_WALK_IMPORT_CATALOGUE, REZICS_WALK_STACK_SLOT } = process.env;
  Object.assign(process.env, { REZICS_WALK_IMPORT_CATALOGUE: '1', REZICS_WALK_STACK_SLOT: '1' });
  try {
    for (const [fields, resource] of [
      [{ file: 'lock.c', hint: 'You might need to increase "max_locks_per_transaction".' }, 'heavyweight_lock_table'],
      [
        { file: 'predicate.c', hint: 'You might need to increase "max_pred_locks_per_transaction".' },
        'predicate_lock_table',
      ],
      [{ file: 'predicate.c', routine: 'SetRWConflict' }, 'serializable_conflict_pool'],
      [{ file: 'mcxt.c', routine: 'MemoryContextAllocationFailure' }, 'backend_heap'],
      [{ message: 'out of shared memory' }, 'shared_memory_unspecified'],
      [{ file: 'unknown.c', routine: 'private_routine' }, 'unknown'],
    ] as const) {
      const cause = Object.assign(new Error('private database message'), fields, {
        code: '53200',
        severity: 'ERROR',
        where: 'SQL statement "private SQL"\nPL/pgSQL function semantic.capture_candidate_erasure() line 5 at PERFORM',
      });
      const result = await bulkWriteCommandProblem(new CommandCommitUncertainError(12, cause), {
        commandIndex: 0,
        requestId: 'walk-test',
        op: 'propose',
      });
      expect(result.problem).toMatchObject({
        sqlstate: '53200',
        failure_stage: 'transaction_commit',
        effect_status: 'unknown',
        retryable: false,
      });
      expect(result.problem).not.toHaveProperty('postgres_failure');
      const event = JSON.parse(log.mock.calls.at(-1)![0] as string);
      expect(event.postgres_failure).toEqual({ resource, sqlFunction: 'semantic.capture_candidate_erasure' });
      expect(JSON.stringify(event)).not.toContain('private SQL');
    }
  } finally {
    for (const [key, value] of Object.entries({ REZICS_WALK_IMPORT_CATALOGUE, REZICS_WALK_STACK_SLOT })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    log.mockRestore();
  }
});
