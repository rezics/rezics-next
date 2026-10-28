import { classifyUnavailability } from '../access/unavailable.ts';
import { issuePointers, type RawIssue } from '@rezics/definitions/validate';
export { issuePointers } from '@rezics/definitions/validate';
import { NotFound, ParseError, ValidationError, t } from 'elysia';
import type { TSchema } from 'typebox';
import { IdempotencyConflictError, TooManyEventsError } from '../command/command.ts';
import { AuthenticationError } from '../request/access.ts';

export const PROBLEM_TYPE_BASE = 'https://rezics.com/problems/';

export const PROBLEMS = {
  invalid_request: { status: 400, title: 'Invalid Request', retryable: false },
  precondition_failed: { status: 412, title: 'Precondition Failed', retryable: false },
  content_too_large: { status: 413, title: 'Content Too Large', retryable: false },
  invalid_signature: { status: 400, title: 'Invalid Signature', retryable: false },
  idempotency_conflict: { status: 422, title: 'Idempotency Key Reused', retryable: false },
  too_many_events: { status: 422, title: 'Too Many Events', retryable: false },
  authentication_required: { status: 401, title: 'Authentication Required', retryable: false },
  invalid_credentials: { status: 401, title: 'Invalid Credentials', retryable: false },
  forbidden: { status: 403, title: 'Forbidden', retryable: false },
  stale_editorial_head: { status: 409, title: 'Stale Editorial Head', retryable: false },
  offer_unavailable: { status: 409, title: 'Offer Unavailable', retryable: false },
  media_unavailable: { status: 409, title: 'Media Unavailable', retryable: false },
  invalid_cursor: { status: 400, title: 'Invalid Cursor', retryable: false },
  stale_cursor: { status: 409, title: 'Stale Cursor', retryable: false },
  conflict: { status: 409, title: 'Conflict', retryable: false },
  collection_full: { status: 409, title: 'Collection Full', retryable: false },
  semantic_not_ready: { status: 503, title: 'Semantic Layer Not Ready', retryable: true },
  presentation_not_ready: { status: 503, title: 'Presentation Not Ready', retryable: true },
  not_found: { status: 404, title: 'Not Found', retryable: false },
  internal_error: { status: 500, title: 'Internal Server Error', retryable: false },
  overloaded: { status: 503, title: 'Service Overloaded', retryable: true },
  partition_unavailable: { status: 503, title: 'Partition Unavailable', retryable: true },
  transaction_retry_exhausted: { status: 503, title: 'Transaction Retry Exhausted', retryable: true },
  deadline_exceeded: { status: 503, title: 'Deadline Exceeded', retryable: true },
  dependency_unavailable: { status: 503, title: 'Dependency Unavailable', retryable: true },
  rate_limited: { status: 429, title: 'Request Budget Exhausted', retryable: true },
  rate_limit_unavailable: { status: 503, title: 'Request Budget Unavailable', retryable: true },
  index_not_ready: { status: 503, title: 'Search Index Not Ready', retryable: true },
  search_restart_required: { status: 409, title: 'Search Restart Required', retryable: false },
  unsupported_query: { status: 422, title: 'Unsupported Query', retryable: false },
} as const;

export type ProblemCode = keyof typeof PROBLEMS;
export type FieldErrorCode =
  | 'required'
  | 'unknown_field'
  | 'invalid_type'
  | 'invalid_format'
  | 'out_of_range'
  | 'unsupported';
export type FieldError = { pointer: string; code: FieldErrorCode };

function truncateDetail(detail: string): string {
  let result = '';
  let length = 0;
  for (const character of detail) {
    if (length === 512) break;
    result += character;
    length++;
  }
  return result;
}

export class ProblemError extends Error {
  readonly code: ProblemCode;
  readonly detail: string | undefined;
  readonly errors: readonly FieldError[] | undefined;
  readonly headers: Record<string, string> | undefined;
  readonly effectStatus: 'not_applicable' | 'not_applied' | undefined;

  constructor(
    code: ProblemCode,
    options: {
      detail?: string;
      errors?: readonly FieldError[];
      headers?: Record<string, string>;
      effectStatus?: 'not_applicable' | 'not_applied';
    } = {},
  ) {
    super(options.detail ?? PROBLEMS[code].title);
    this.name = 'ProblemError';
    this.code = code;
    this.detail = options.detail === undefined ? undefined : truncateDetail(options.detail);
    this.errors = options.errors;
    this.headers = options.headers;
    this.effectStatus = options.effectStatus;
  }
}

const fieldErrorCodes: readonly string[] = [
  'required',
  'unknown_field',
  'invalid_type',
  'invalid_format',
  'out_of_range',
  'unsupported',
];
const pointerPattern = /^(?:\/(?:[^~/]|~[01])*)*$/;

function schemaUnion(schemas: TSchema[]): TSchema {
  return schemas.length === 1 ? schemas[0]! : t.Union(schemas as [TSchema, ...TSchema[]]);
}

function fieldErrorSchema() {
  return t.Object(
    {
      pointer: t.String({ pattern: pointerPattern.source }),
      code: t.Union(fieldErrorCodes.map((fieldCode) => t.Literal(fieldCode))),
    },
    { additionalProperties: false },
  );
}

function schemaFor(codes: readonly ProblemCode[], status: number) {
  return t.Object(
    {
      type: schemaUnion(codes.map((code) => t.Literal(`${PROBLEM_TYPE_BASE}${code}`))),
      title: schemaUnion(codes.map((code) => t.Literal(PROBLEMS[code].title))),
      status: t.Literal(status),
      code: schemaUnion(codes.map((code) => t.Literal(code))),
      retryable: schemaUnion(codes.map((code) => t.Literal(PROBLEMS[code].retryable))),
      effect_status: t.Union([t.Literal('not_applicable'), t.Literal('not_applied')]),
      request_id: t.String(),
      detail: t.Optional(t.String({ maxLength: 512 })),
      errors: t.Optional(t.Array(fieldErrorSchema(), { maxItems: 16 })),
    },
    { additionalProperties: false },
  );
}

export function problemSchema<const Codes extends readonly [ProblemCode, ...ProblemCode[]]>(...codes: Codes) {
  if (codes.length === 0) throw new TypeError('At least one problem code is required');
  const statuses = new Set(codes.map((code) => PROBLEMS[code].status));
  if (statuses.size !== 1) throw new TypeError('Problem response alternatives must share one status');
  return schemaFor(codes, statuses.values().next().value!);
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
    if (!pointerPattern.test(error.pointer) || !fieldErrorCodes.includes(error.code) || seen.has(error.pointer))
      continue;
    seen.add(error.pointer);
    result.push({ pointer: error.pointer, code: error.code });
    if (result.length === 16) break;
  }
  return result.length ? result : undefined;
}

function effectStatus(method: string, action?: string): 'not_applicable' | 'not_applied' {
  if (action && /:read(?:_|$)/.test(action)) return 'not_applicable';
  return ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) ? 'not_applicable' : 'not_applied';
}

function hasInvalidToken(challenge: string): boolean {
  return /(?:^|[\s,])error\s*=\s*(?:"invalid_token"|invalid_token)(?=$|[\s,])/i.test(challenge);
}

export function problemResponse(error: unknown, context: { method: string; id: string; action?: string }): Response {
  let code: ProblemCode = 'internal_error';
  let detail: string | undefined;
  let errors: readonly FieldError[] | undefined;
  const headers = new Headers();

  if (error instanceof ProblemError) {
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
  } else if (error instanceof TooManyEventsError) {
    code = 'too_many_events';
    detail = error.message;
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
  const safeErrors = safeFieldErrors(errors);
  const body = {
    type: `${PROBLEM_TYPE_BASE}${code}`,
    title: definition.title,
    status: definition.status,
    code,
    retryable: definition.retryable,
    effect_status:
      error instanceof ProblemError && error.effectStatus
        ? error.effectStatus
        : effectStatus(context.method, context.action),
    request_id: context.id,
    ...(detail === undefined ? {} : { detail: truncateDetail(detail) }),
    ...(safeErrors ? { errors: safeErrors } : {}),
  };

  headers.set('content-type', 'application/problem+json');
  return new Response(JSON.stringify(body), { status: definition.status, headers });
}
