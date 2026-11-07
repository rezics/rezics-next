import { fieldErrorCodes, extensionMembers } from './problem-schema.ts';
export { problemSchema } from './problem-schema.ts';
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
import { classifyUnavailability } from '../access/unavailable.ts';
import { issuePointers, type RawIssue } from '@rezics/definitions/validate';
export { issuePointers } from '@rezics/definitions/validate';
import { NotFound, ParseError, ValidationError } from 'elysia';
import { CommandResultErasedError, IdempotencyConflictError, TooManyEventsError } from '../command/command.ts';
import { AuthenticationError } from '../request/access.ts';
import { RealmLastOwnerError } from '../access/resource-access-errors.ts';

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
  action?: string,
  code?: ProblemCode,
): 'not_applicable' | 'not_applied' | 'applied' {
  if (code === 'command_result_erased') return 'applied';
  if (action && (code === 'account_suspended' ? action.endsWith(':read') : /:read(?:_|$)/.test(action)))
    return 'not_applicable';
  return ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) ? 'not_applicable' : 'not_applied';
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

export function problemResponse(
  error: unknown,
  context: { method: string; id: string; action?: string; route?: string | undefined },
): Response {
  let code: ProblemCode = 'internal_error';
  let detail: string | undefined;
  let errors: readonly FieldError[] | undefined;
  const headers = new Headers();

  if (error instanceof RealmLastOwnerError) {
    code = 'realm_last_owner';
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

  const definition = PROBLEMS[code];
  const lastOwner = code === 'realm_last_owner';
  const safeErrors = lastOwner ? undefined : safeFieldErrors(errors);
  const body = {
    type: `${PROBLEM_TYPE_BASE}${code}`,
    title: definition.title,
    status: definition.status,
    code,
    retryable: definition.retryable,
    effect_status: lastOwner
      ? 'not_applied'
      : error instanceof CommandResultErasedError
        ? 'applied'
        : error instanceof ProblemError && error.effectStatus
          ? error.effectStatus
          : effectStatus(context.method, context.action, code),
    request_id: context.id,
    ...(lastOwner || detail === undefined ? {} : { detail: truncateDetail(detail) }),
    ...(safeErrors ? { errors: safeErrors } : {}),
    ...(!lastOwner && error instanceof ProblemError ? extensionMembers(error.extensions ?? {}) : {}),
  };

  if (code === 'deadline_exceeded') logDeadlineExceeded(context);
  headers.set('content-type', 'application/problem+json');
  return new Response(JSON.stringify(body), { status: definition.status, headers });
}
