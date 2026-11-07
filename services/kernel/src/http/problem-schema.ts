/** Problem response vocabulary and schemas, independent of request error handling. */
import { t } from 'elysia';
import type { TSchema } from 'typebox';
import { PROBLEM_TYPE_BASE, PROBLEMS, type ProblemCode, type FieldErrorCode } from './problem-error.ts';

export function fieldErrorCodes(): readonly FieldErrorCode[] {
  return ['required', 'unknown_field', 'invalid_type', 'invalid_format', 'out_of_range', 'unsupported'];
}

function schemaUnion(schemas: TSchema[]): TSchema {
  return schemas.length === 1 ? schemas[0]! : t.Union(schemas as [TSchema, ...TSchema[]]);
}

function fieldErrorSchema() {
  const codes = fieldErrorCodes();
  return t.Object(
    {
      pointer: t.String({ pattern: '^(?:\\/(?:[^~/]|~[01])*)*$' }),
      code: t.Union(codes.map((fieldCode) => t.Literal(fieldCode))),
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

export function extensionMembers<T extends Readonly<Record<string, unknown>>>(
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
