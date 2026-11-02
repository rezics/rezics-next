import {
  PROBLEM_TYPE_BASE,
  PROBLEMS,
  ProblemError,
  type ProblemCode,
  type FieldErrorCode,
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
import { NotFound, ParseError, ValidationError, t } from 'elysia';
import type { TSchema } from 'typebox';
import { CommandResultErasedError, IdempotencyConflictError, TooManyEventsError } from '../command/command.ts';
import { AuthenticationError } from '../request/access.ts';
import { RealmLastOwnerError } from '../access/resource-access-errors.ts';

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

const reservedMembers = {
  type: true,
  title: true,
  status: true,
  detail: true,
  instance: true,
  errors: true,
  code: true,
  retryable: true,
  effect_status: true,
  request_id: true,
} as const;

function extensionMembers<T extends Readonly<Record<string, unknown>>>(
  extensions: T,
): Omit<T, keyof typeof reservedMembers> {
  return Object.fromEntries(
    Object.entries(extensions).filter(([name]) => !Object.hasOwn(reservedMembers, name)),
  ) as Omit<T, keyof typeof reservedMembers>;
}

function schemaFor(codes: readonly ProblemCode[], status: number) {
  const lastOwner = codes.length === 1 && codes[0] === 'realm_last_owner';
  return t.Object(
    {
      type: schemaUnion(codes.map((code) => t.Literal(`${PROBLEM_TYPE_BASE}${code}`))),
      title: schemaUnion(codes.map((code) => t.Literal(PROBLEMS[code].title))),
      status: t.Literal(status),
      code: schemaUnion(codes.map((code) => t.Literal(code))),
      retryable: schemaUnion(codes.map((code) => t.Literal(PROBLEMS[code].retryable))),
      effect_status: lastOwner
        ? t.Literal('not_applied')
        : t.Union([t.Literal('not_applicable'), t.Literal('not_applied')]),
      request_id: t.String(),
      ...(lastOwner
        ? {}
        : {
            detail: t.Optional(t.String({ maxLength: 512 })),
            errors: t.Optional(t.Array(fieldErrorSchema(), { maxItems: 16 })),
          }),
    },
    { additionalProperties: false },
  );
}

function extendedSchema<Extensions extends Record<string, TSchema>>(
  codes: readonly ProblemCode[],
  status: number,
  extensions: Extensions,
) {
  return t.Object(
    { ...schemaFor(codes, status).properties, ...extensionMembers(extensions) },
    { additionalProperties: false },
  );
}

function erasedResultSchema() {
  const base = schemaFor(['command_result_erased'], 410);
  return t.Object({ ...base.properties, effect_status: t.Literal('applied') }, { additionalProperties: false });
}

export function problemSchema(code: 'command_result_erased'): ReturnType<typeof erasedResultSchema>;
export function problemSchema<const Codes extends readonly [ProblemCode, ...ProblemCode[]]>(
  ...codes: Codes
): ReturnType<typeof schemaFor>;
export function problemSchema<
  const Codes extends readonly [ProblemCode, ...ProblemCode[]],
  const Extensions extends Record<string, TSchema>,
>(...codesAndExtensions: [...Codes, Extensions]): ReturnType<typeof extendedSchema<Extensions>>;
export function problemSchema(...codesAndExtensions: (ProblemCode | Record<string, TSchema>)[]) {
  const last = codesAndExtensions.at(-1);
  const codes = (typeof last === 'object' ? codesAndExtensions.slice(0, -1) : codesAndExtensions) as ProblemCode[];
  if (codes.length === 0) throw new TypeError('At least one problem code is required');
  const statuses = new Set(codes.map((code) => PROBLEMS[code].status));
  if (statuses.size !== 1) throw new TypeError('Problem response alternatives must share one status');
  const status = statuses.values().next().value!;
  if (codes.length === 1 && codes[0] === 'command_result_erased' && typeof last !== 'object')
    return erasedResultSchema();
  if (codes.length === 1 && codes[0] === 'realm_last_owner') return schemaFor(codes, status);
  return typeof last === 'object' ? extendedSchema(codes, status, last) : schemaFor(codes, status);
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
}): void {
  const { requestId, method, route, cause, commandIndex } = options;
  const code = cause instanceof Error ? (cause as { code?: unknown }).code : undefined;
  console.error(
    JSON.stringify({
      event: 'internal_error',
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
