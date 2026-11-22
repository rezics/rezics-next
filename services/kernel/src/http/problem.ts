import {
  PROBLEM_TYPE_BASE,
  PROBLEMS,
  ProblemError,
  truncateDetail,
  type ProblemCode,
  type FieldError,
} from './problem-error.ts';
export {
  PROBLEM_TYPE_BASE,
  PROBLEMS,
  ProblemError,
  type ProblemCode,
  type FieldErrorCode,
  type FieldError,
} from './problem-error.ts';
import { commandTimingSnapshot } from '../command/timing.ts';
import type { WalkCommitCause, WalkPostgresFailure } from '@rezics/definitions/bulk';
import { classifyUnavailability } from '../access/unavailable.ts';
import { issuePointers, type RawIssue } from '@rezics/definitions/validate';
export { issuePointers } from '@rezics/definitions/validate';
import { NotFound, ParseError, ValidationError } from 'elysia';
import {
  AppliedCommandResponseError,
  CommandResultErasedError,
  IdempotencyConflictError,
  isUnconfirmedCommandCommit,
  TooManyEventsError,
} from '../command/command.ts';
import { AuthenticationError } from '../request/authentication-error.ts';
import { RealmLastOwnerError } from '../access/resource-access-errors.ts';
import { SubjectProjectionPreparingError } from '../semantic/contract/subject-errors.ts';

import { extensionMembers, fieldErrorCodes } from './problem-schema.ts';
export { problemSchema } from './problem-schema.ts';

/** Enter only after the command returned its committed outcome. A failed response
 * read retains its ordinary problem code without claiming the write rolled back.
 */
export async function withAppliedCommandEffect<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof AppliedCommandResponseError) throw error;
    throw new AppliedCommandResponseError(error);
  }
}

function isSafePointer(pointer: string): boolean {
  return /^(?:\/(?:[^~/]|~[01])*)*$/.test(pointer);
}

function validationFieldErrors(error: ValidationError): FieldError[] {
  const result: FieldError[] = [];
  const seen = new Set<string>();
  for (const raw of error.errors as RawIssue[]) {
    if (!raw || typeof raw !== 'object') continue;
    const fields = issuePointers(raw);
    for (const field of fields) {
      if (seen.has(field.pointer)) continue;
      seen.add(field.pointer);
      result.push(field);
      if (result.length === 16) return result;
    }
  }
  return result;
}

function safeFieldErrors(errors: readonly FieldError[] | undefined): FieldError[] | undefined {
  if (!errors?.length) return undefined;
  const result: FieldError[] = [];
  const seen = new Set<string>();
  for (const error of errors) {
    if (!isSafePointer(error.pointer) || !fieldErrorCodes().includes(error.code) || seen.has(error.pointer)) continue;
    seen.add(error.pointer);
    result.push({ pointer: error.pointer, code: error.code });
    if (result.length === 16) break;
  }
  return result.length ? result : undefined;
}

function effectStatus(
  method: string,
  action: string | undefined,
  code: ProblemCode,
  error: unknown,
  applied: boolean,
): 'not_applicable' | 'not_applied' | 'applied' | 'unknown' {
  if (code === 'realm_last_owner') return 'not_applied';
  if (applied || code === 'command_result_erased') return 'applied';
  if (
    error instanceof ProblemError &&
    (error.effectStatus === 'not_applicable' || error.effectStatus === 'not_applied')
  )
    return error.effectStatus;
  if (action && (code === 'account_suspended' ? action.endsWith(':read') : /:read(?:_|$)/.test(action)))
    return 'not_applicable';
  if (['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) return 'not_applicable';
  return isUnconfirmedCommandCommit(error) ? 'unknown' : 'not_applied';
}

function hasInvalidToken(challenge: string): boolean {
  return /(?:^|[\s,])error\s*=\s*(?:"invalid_token"|invalid_token)(?=$|[\s,])/i.test(challenge);
}

export function logInternalError(options: {
  requestId: string;
  method: string;
  route?: string | undefined;
  cause: unknown;
  commandIndex?: number | undefined;
  commitCause?: WalkCommitCause;
  postgresFailure?: WalkPostgresFailure | undefined;
  event?: 'internal_error' | 'dependency_unavailable';
}): void {
  const { requestId, method, route, cause, commandIndex } = options;
  const code = cause instanceof Error ? (cause as { code?: unknown }).code : undefined;
  console.error(
    JSON.stringify({
      event: options.event ?? 'internal_error',
      request_id: requestId,
      method,
      route,
      name: cause instanceof Error ? cause.name : typeof cause,
      ...(code === undefined ? {} : { code }),
      stack: cause instanceof Error ? cause.stack : undefined,
      ...(commandIndex === undefined ? {} : { command_index: commandIndex }),
      ...(options.postgresFailure === undefined ? {} : { postgres_failure: options.postgresFailure }),
      ...(options.commitCause === undefined ? {} : { commit_cause: options.commitCause }),
    }),
  );
}

export function logDeadlineExceeded(context: { method: string; id: string; route?: string | undefined }): void {
  const timing = commandTimingSnapshot(true);
  if (timing)
    console.error(
      JSON.stringify({
        event: 'deadline_exceeded',
        request_id: context.id,
        method: context.method,
        route: context.route,
        ...timing,
      }),
    );
}

export function isImportCatalogueWalk(): boolean {
  return (
    process.env.REZICS_WALK_IMPORT_CATALOGUE === '1' &&
    Boolean(process.env.REZICS_WALK_STACK_SLOT) &&
    process.env.NODE_ENV !== 'production'
  );
}

export function problemResponse(
  error: unknown,
  context: { method: string; id: string; action?: string; route?: string | undefined; observeWalkSubject?: boolean },
): Response {
  const appliedError = error instanceof AppliedCommandResponseError ? error : undefined;
  const applied = appliedError !== undefined;
  if (appliedError) error = appliedError.cause;
  let code: ProblemCode = 'internal_error';
  let detail: string | undefined;
  let errors: readonly FieldError[] | undefined;
  const headers = new Headers();

  if (error instanceof RealmLastOwnerError) {
    code = 'realm_last_owner';
  } else if (error instanceof SubjectProjectionPreparingError) {
    code = 'semantic_not_ready';
    headers.set('retry-after', '1');
    headers.set('cache-control', 'private, no-store');
  } else if (error instanceof ProblemError) {
    code = error.code;
    detail = error.detail;
    errors = error.errors;
    for (const [name, value] of Object.entries(error.headers ?? {})) headers.set(name, value);
  } else if (error instanceof ValidationError) {
    code = 'invalid_request';
    errors = validationFieldErrors(error);
  } else if (error instanceof ParseError) {
    code = 'invalid_request';
  } else if (error instanceof NotFound) {
    code = 'not_found';
  } else if (error instanceof AuthenticationError) {
    if (error.status === 400) code = 'invalid_request';
    else code = hasInvalidToken(error.challenge) ? 'invalid_credentials' : 'authentication_required';
    headers.set('www-authenticate', error.challenge);
  } else if (error instanceof IdempotencyConflictError) {
    code = 'idempotency_conflict';
  } else if (isUnconfirmedCommandCommit(error)) {
    if (classifyUnavailability(error.cause) === 'deadline') code = 'deadline_exceeded';
  } else if (error instanceof CommandResultErasedError) {
    code = 'command_result_erased';
  } else if (error instanceof TooManyEventsError) {
    code = 'too_many_events';
    detail = error.message;
  } else if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'atomic_guard_unavailable'
  ) {
    code = 'atomic_guard_unavailable';
    headers.set('retry-after', '1');
  } else {
    switch (classifyUnavailability(error)) {
      case 'overloaded':
        code = 'overloaded';
        headers.set('retry-after', '1');
        break;
      case 'fenced':
      case 'moved':
        code = 'partition_unavailable';
        headers.set('retry-after', '1');
        break;
      case 'contention':
        code = 'transaction_retry_exhausted';
        headers.set('retry-after', '1');
        break;
      case 'deadline':
        code = 'deadline_exceeded';
        break;
    }
  }

  // Native walk evidence belongs to the refusal that produced this response.
  if (
    code === 'semantic_not_ready' &&
    context.method === 'GET' &&
    context.route === '/v1/subjects/:id' &&
    isImportCatalogueWalk()
  ) {
    const reason =
      error instanceof SubjectProjectionPreparingError
        ? `${error.identity}/${error.stage}/${error.reason}`
        : 'other-readiness';
    console.warn(`Semantic subject GET 503 reason=${reason}`);
    if (context.observeWalkSubject) headers.set('x-rezics-walk-subject-read', reason);
  }

  const definition = PROBLEMS[code];
  const lastOwner = code === 'realm_last_owner';
  const safeErrors = lastOwner ? undefined : safeFieldErrors(errors);
  const body = {
    type: `${PROBLEM_TYPE_BASE}${code}`,
    title: definition.title,
    status: definition.status,
    code,
    retryable: definition.retryable,
    effect_status: effectStatus(context.method, context.action, code, error, applied),
    request_id: context.id,
    ...(lastOwner || detail === undefined ? {} : { detail: truncateDetail(detail) }),
    ...(safeErrors ? { errors: safeErrors } : {}),
    ...(!lastOwner && error instanceof ProblemError ? extensionMembers(error.extensions ?? {}) : {}),
  };

  if (code === 'deadline_exceeded') logDeadlineExceeded(context);
  headers.set('content-type', 'application/problem+json');
  return new Response(JSON.stringify(body), { status: definition.status, headers });
}
