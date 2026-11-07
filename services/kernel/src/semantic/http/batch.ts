import { GrantDeniedError } from '../../access/grant-commands.ts';
import { CommandUnavailableError } from '../../command/command.ts';
import { commandTimingSnapshot } from '../../command/timing.ts';
import {
  PROBLEM_TYPE_BASE,
  ProblemError,
  logInternalError,
  problemResponse,
  problemSchema,
  type FieldError,
} from '../../http/problem.ts';
import { EditorialConflictError, SubjectNotFoundError, SubjectRedirectError } from '../contract/subject-errors.ts';
import { SubjectInputError } from '../item.ts';
import { SubjectAccessDeniedError } from '../subject.ts';

export const BULK_WRITE_ROUTE = '/v1/subjects:batchWrite';

const TRANSACTION_PHASES = [
  'before_command',
  'command_overhead',
  'time_mint',
  'access_prepare',
  'gate_wait',
  'transaction_pool_wait',
  'transaction_body',
  'commit',
  'writable_wait',
  'contention_pause',
  'request_completion',
] as const;

export type BulkWriteTransactionPhase = (typeof TRANSACTION_PHASES)[number];
export type BulkWriteAction = 'subject:create' | 'statement:propose';
export type BulkWriteProblemBody = {
  type: string;
  title: string;
  status: number;
  code: string;
  retryable: boolean;
  effect_status: string;
  request_id: string;
  detail?: string;
  errors?: FieldError[];
  operation?: BulkWriteAction;
  partition?: number;
  phase?: BulkWriteTransactionPhase;
  contention_retries?: number;
  redirect?: { from: string; to: string };
};

const TRANSACTION_PHASE_SET = new Set<string>(TRANSACTION_PHASES);

export function bulkWriteAction(op: string | undefined): BulkWriteAction {
  return op === 'create' ? 'subject:create' : 'statement:propose';
}

export function bulkWriteUnavailableSchema() {
  return problemSchema(
    'semantic_not_ready',
    'overloaded',
    'deadline_exceeded',
    'partition_unavailable',
    'transaction_retry_exhausted',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function publicPartition(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 65535 ? value : undefined;
}

function publicPhase(value: unknown): BulkWriteTransactionPhase | undefined {
  return typeof value === 'string' && TRANSACTION_PHASE_SET.has(value)
    ? (value as BulkWriteTransactionPhase)
    : undefined;
}

function publicRetries(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 10_000 ? value : undefined;
}

/** Safe RFC9457 extensions: operation, partition and transaction phase only. */
export function bulkWriteDiagnostics(
  error: unknown,
  action: BulkWriteAction,
): Pick<BulkWriteProblemBody, 'operation' | 'partition' | 'phase' | 'contention_retries'> {
  const timing = commandTimingSnapshot();
  const partition = error instanceof CommandUnavailableError ? publicPartition(error.partition) : undefined;
  const phase = publicPhase(timing?.dominant_phase);
  const retries = publicRetries(timing?.contention_retries);
  return {
    operation: action,
    ...(partition === undefined ? {} : { partition }),
    ...(phase === undefined ? {} : { phase }),
    ...(retries === undefined ? {} : { contention_retries: retries }),
  };
}

export function logBulkWriteUnavailable(options: {
  requestId: string;
  action: BulkWriteAction;
  commandIndex: number;
  error: unknown;
  code: string;
}): void {
  const diagnostics = bulkWriteDiagnostics(options.error, options.action);
  const timing = commandTimingSnapshot(true);
  console.error(
    JSON.stringify({
      event: options.code,
      request_id: options.requestId,
      method: 'POST',
      route: BULK_WRITE_ROUTE,
      command_index: options.commandIndex,
      operation: diagnostics.operation,
      ...(diagnostics.partition === undefined ? {} : { partition: diagnostics.partition }),
      ...(timing
        ? {
            elapsed_ms: timing.elapsed_ms,
            phases_ms: timing.phases_ms,
            dominant_phase: timing.dominant_phase,
            contention_retries: timing.contention_retries,
          }
        : diagnostics.phase === undefined
          ? {}
          : { dominant_phase: diagnostics.phase }),
    }),
  );
}

function mapBulkWriteError(
  error: unknown,
  commandIndex: number,
  op: string | undefined,
): { problem: unknown; redirect?: { from: string; to: string } } {
  if (error instanceof SubjectInputError)
    return {
      problem: new ProblemError('invalid_request', {
        errors: error.violations.map((violation) => ({
          ...violation,
          pointer: `/commands/${commandIndex}${op === 'create' ? '/subject' : ''}${violation.pointer}`,
        })),
      }),
    };
  if (error instanceof SubjectNotFoundError) return { problem: new ProblemError('not_found') };
  if (error instanceof EditorialConflictError) return { problem: new ProblemError('conflict') };
  if (error instanceof SubjectRedirectError)
    return { problem: new ProblemError('conflict'), redirect: { from: error.from, to: error.to } };
  if (error instanceof SubjectAccessDeniedError || error instanceof GrantDeniedError)
    return { problem: new ProblemError('forbidden') };
  return { problem: error };
}

export async function bulkWriteCommandProblem(
  error: unknown,
  options: { requestId: string; commandIndex: number; op: string | undefined },
): Promise<{ status: number; problem: BulkWriteProblemBody }> {
  const action = bulkWriteAction(options.op);
  const mapped = mapBulkWriteError(error, options.commandIndex, options.op);
  const response = problemResponse(mapped.problem, {
    method: 'POST',
    id: options.requestId,
    action,
    route: BULK_WRITE_ROUTE,
  });
  if (response.status === 500)
    logInternalError({
      requestId: options.requestId,
      method: 'POST',
      route: BULK_WRITE_ROUTE,
      cause: error,
      commandIndex: options.commandIndex,
    });
  const payload: unknown = await response.json();
  if (!isRecord(payload) || typeof payload.code !== 'string' || typeof payload.status !== 'number')
    throw new TypeError('bulk write problem payload');
  const problem: BulkWriteProblemBody = {
    ...(payload as BulkWriteProblemBody),
    ...bulkWriteDiagnostics(error, action),
    ...(mapped.redirect ? { redirect: mapped.redirect } : {}),
  };
  if (
    response.status === 503 &&
    (problem.code === 'transaction_retry_exhausted' || problem.code === 'deadline_exceeded')
  )
    logBulkWriteUnavailable({
      requestId: options.requestId,
      action,
      commandIndex: options.commandIndex,
      error,
      code: problem.code,
    });
  return { status: response.status, problem };
}

export function logPendingFenceFailure(requestId: string, commandIndex: number): Error {
  const cause = new Error('Source fence was still pending after the retry pass');
  logInternalError({
    requestId,
    method: 'POST',
    route: BULK_WRITE_ROUTE,
    cause,
    commandIndex,
  });
  return cause;
}

export { PROBLEM_TYPE_BASE };
