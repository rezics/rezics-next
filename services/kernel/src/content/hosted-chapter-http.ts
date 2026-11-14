import { t } from 'elysia';
import { IDEMPOTENCY_HEADER, SESSION_HEADER } from '@rezics/operations/protocol';
import { memoizedValue } from '../memoized.ts';
import { GrantDeniedError } from '../access/contract/index.ts';
import { ProblemError } from '../http/problem-error.ts';
import { problemSchema } from '../http/problem-schema.ts';
import { defineRateLimit } from '../http/route-metadata.ts';
import { idempotencyKeyOf } from '../http/idempotency-key.ts';
import { contentRequestId } from './adapters/bind.ts';
import {
  ContentNotFoundError as CommandNotFoundError,
  ContentForbiddenError,
  RevisionPreconditionError,
} from './commands.ts';
import { ContentNotFoundError } from './reads.ts';
import {
  InvalidHostedStructureError,
  InvalidHostedCursorError,
  HostedOwnerInventoryUnavailableError,
} from './hosted-chapters-model.ts';
import { HostedIdSchema } from './hosted-chapters-schemas.ts';

export function params() {
  return memoizedValue(params, () => t.Object({ id: HostedIdSchema }, { additionalProperties: false }));
}
export function occurrenceParams() {
  return memoizedValue(occurrenceParams, () =>
    t.Object({ id: HostedIdSchema, occurrenceId: HostedIdSchema }, { additionalProperties: false }),
  );
}
export function ownerParams() {
  return memoizedValue(ownerParams, () => t.Object({ accountId: HostedIdSchema }, { additionalProperties: false }));
}
export function ownerReadParams() {
  return memoizedValue(ownerReadParams, () =>
    t.Object({ accountId: HostedIdSchema, id: HostedIdSchema }, { additionalProperties: false }),
  );
}
export const headers = t.Object({ [IDEMPOTENCY_HEADER]: t.String() }, { additionalProperties: true });
export const responseHeaders = { [SESSION_HEADER]: t.String(), 'cache-control': t.String() };
export function failures() {
  return memoizedValue(failures, () => ({
    400: problemSchema('invalid_request', 'invalid_cursor'),
    401: problemSchema('authentication_required', 'invalid_credentials'),
    403: problemSchema('forbidden', 'platform_closed'),
    404: problemSchema('not_found'),
    412: problemSchema('precondition_failed'),
    413: problemSchema('content_too_large'),
    422: problemSchema('idempotency_conflict', 'too_many_events'),
    429: problemSchema('rate_limited'),
    500: problemSchema('internal_error'),
    503: problemSchema(
      'overloaded',
      'deadline_exceeded',
      'partition_unavailable',
      'transaction_retry_exhausted',
      'dependency_unavailable',
      'rate_limit_unavailable',
    ),
  }));
}
const readSecurity: Record<string, string[]>[] = [{}, { bearerAuth: [] }];
export const readDetail = {
  'x-exposure': 'public',
  'x-resource-types': ['content.post'],
  'x-action': 'post:read',
  security: readSecurity,
};
export const ownerDetail = { 'x-exposure': 'public', 'x-action': 'account:read', security: [{ bearerAuth: [] }] };
export function writeDetail() {
  return memoizedValue(writeDetail, () => ({
    'x-exposure': 'public',
    'x-resource-types': ['content.post'],
    'x-action': 'post:revise',
    'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
    security: [{ bearerAuth: [] }],
  }));
}

export async function operation<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ContentNotFoundError || error instanceof CommandNotFoundError)
      throw new ProblemError('not_found');
    if (error instanceof ContentForbiddenError || error instanceof GrantDeniedError)
      throw new ProblemError('forbidden');
    if (error instanceof RevisionPreconditionError) throw new ProblemError('precondition_failed');
    if (error instanceof InvalidHostedCursorError) throw new ProblemError('invalid_cursor');
    if (error instanceof InvalidHostedStructureError) throw new ProblemError('invalid_request');
    if (error instanceof HostedOwnerInventoryUnavailableError)
      throw new ProblemError('dependency_unavailable', { detail: error.message });
    throw error;
  }
}
export function commandContext(request: Request, deadline: number) {
  return {
    deadline,
    idempotencyKey: idempotencyKeyOf(request.headers.get(IDEMPOTENCY_HEADER)),
    requestId: contentRequestId(),
  };
}
