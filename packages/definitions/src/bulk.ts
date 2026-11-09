import { checkDocument, serializeDocument } from '@rezics/document';
import spdxLicenseIds from 'spdx-license-ids';
import { Type, type Static } from 'typebox';
import { valueSchema, type Release } from './portable.ts';
import { checkSubjectInput, checkSubjectStructure, checkStatementInput, type Violation } from './validate.ts';
export type { Violation } from './validate.ts';

export const BATCH_LIMIT = 100;
export const FIELD_GROUPS = ['facts', 'summary', 'cover'] as const;
export type FieldGroup = (typeof FIELD_GROUPS)[number];
export const SourceSchema = Type.Object({
  source: Type.String({ pattern: '^[a-z][a-z0-9_-]{0,31}$' }),
  external_id: Type.String({ minLength: 1, maxLength: 255 }),
  record_revision: Type.String({ minLength: 1, maxLength: 64 }),
  digest: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  converter_revision: Type.String({ minLength: 1, maxLength: 64 }),
  field_group: Type.Union([Type.Literal('facts'), Type.Literal('summary'), Type.Literal('cover')]),
});
export type Source = Static<typeof SourceSchema>;
const id = Type.Object({ id: Type.String({ minLength: 1 }) });
const snak = Type.Union([
  Type.Object({ property: id, value: Type.Object({ type: Type.Literal('value'), content: Type.Unknown() }) }),
  Type.Object({
    property: id,
    value: Type.Union([
      Type.Object({ type: Type.Literal('somevalue') }),
      Type.Object({ type: Type.Literal('novalue') }),
    ]),
  }),
]);
export const BatchReferenceSchema = Type.Object({ parts: Type.Array(snak, { minItems: 1 }) });
export type BatchReference = Static<typeof BatchReferenceSchema>;
export const BatchStatementSchema = Type.Object({
  property: id,
  value: Type.Union([
    Type.Object({ type: Type.Literal('value'), content: Type.Unknown() }),
    Type.Object({ type: Type.Literal('somevalue') }),
    Type.Object({ type: Type.Literal('novalue') }),
  ]),
  qualifiers: Type.Optional(Type.Array(snak)),
  references: Type.Array(BatchReferenceSchema, { minItems: 1, maxItems: 16 }),
  rank: Type.Optional(Type.Union([Type.Literal('normal'), Type.Literal('preferred')])),
});
export type BatchStatement = Static<typeof BatchStatementSchema>;
const langmap = Type.Record(Type.String({ minLength: 1 }), Type.String({ minLength: 1 }));
const subjectBody = Type.Object({
  type: Type.String({ minLength: 1 }),
  labels: langmap,
  descriptions: Type.Optional(langmap),
  aliases: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.Array(Type.String({ minLength: 1 })))),
});
const uuid = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const key = Type.String({ minLength: 1, maxLength: 255, pattern: '^[\\x20-\\x7e]+$' });
export const RightsSchema = Type.Object({
  license: Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9.+-]{0,79}$' }),
  obligations: Type.Array(
    Type.Union([
      Type.Literal('cc:Attribution'),
      Type.Literal('cc:ShareAlike'),
      Type.Literal('cc:Notice'),
      Type.Literal('cc:SourceCode'),
    ]),
    { maxItems: 4, uniqueItems: true },
  ),
  attribution: Type.String({ minLength: 1, maxLength: 500 }),
});
export type Rights = Static<typeof RightsSchema>;
const licenseIds = new Set(spdxLicenseIds);
const base = { key, source: SourceSchema };
export const BatchCommandSchema = Type.Union([
  Type.Object({ op: Type.Literal('create'), ...base, subject: subjectBody }),
  Type.Object({
    op: Type.Literal('propose'),
    ...base,
    subject: uuid,
    statement: BatchStatementSchema,
    rights: Type.Optional(RightsSchema),
  }),
  Type.Object({
    op: Type.Literal('retract'),
    ...base,
    subject: uuid,
    candidate: uuid,
    references: Type.Array(BatchReferenceSchema, { minItems: 1, maxItems: 16 }),
  }),
]);
export type BatchCommand = Static<typeof BatchCommandSchema>;
export const BatchWriteRequestSchema = Type.Object({
  commands: Type.Array(BatchCommandSchema, { minItems: 1, maxItems: BATCH_LIMIT }),
});
export type BatchWriteRequest = Static<typeof BatchWriteRequestSchema>;
const problem = Type.Object(
  {
    type: Type.String(),
    title: Type.String(),
    status: Type.Integer({ minimum: 400, maximum: 599 }),
    retryable: Type.Boolean(),
    detail: Type.Optional(Type.String()),
    errors: Type.Optional(Type.Array(Type.Unknown())),
  },
  { additionalProperties: true },
);
const result = Type.Union([
  Type.Object({
    key,
    status: Type.Union([Type.Literal(200), Type.Literal(201)]),
    value: Type.Union([
      Type.Object({ id: uuid, revision: Type.Integer({ minimum: 1 }) }),
      Type.Object({ candidate: uuid, revision: Type.Integer({ minimum: 1 }) }),
      Type.Object({ revision: Type.Integer({ minimum: 1 }) }),
    ]),
  }),
  Type.Object({ key, status: Type.Integer({ minimum: 400, maximum: 599 }), problem }),
]);
export const BatchWriteResultSchema = Type.Object({
  results: Type.Array(result, { minItems: 1, maxItems: BATCH_LIMIT }),
});
export type BatchWriteResult = Static<typeof BatchWriteResultSchema>;
type Schema = Record<string, any>;
const esc = (x: string | number) => `/${String(x).replace(/~/g, '~0').replace(/\//g, '~1')}`;
function validate(schema: Schema, value: unknown, pointer: string, out: Violation[]) {
  const add = (code: Violation['code'], at = pointer) => out.push({ pointer: at, code });
  if (schema.anyOf || schema.oneOf) {
    const variants = schema.anyOf ?? schema.oneOf;
    if (record(value)) {
      const variant = variants.find((candidate: Schema) =>
        ['op', 'type'].some(
          (key) => candidate.properties?.[key]?.const !== undefined && candidate.properties[key].const === value[key],
        ),
      );
      if (variant) {
        validate(variant, value, pointer, out);
        return;
      }
    }
    const attempts = variants.map((s: Schema) => {
      const tmp: Violation[] = [];
      validate(s, value, pointer, tmp);
      return tmp;
    });
    if (attempts.some((v: Violation[]) => !v.length)) return;
    if (schema.anyOf) {
      const best = attempts.reduce((a: Violation[], b: Violation[]) => (b.length < a.length ? b : a));
      out.push(...best);
      return;
    }
  }
  if (schema.const !== undefined || schema.enum) {
    if (!(schema.enum ?? [schema.const]).includes(value)) add('unsupported');
    return;
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      add('invalid_type');
      return;
    }
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) if (!Object.hasOwn(obj, req)) add('required', pointer + esc(req));
    for (const [k, v] of Object.entries(obj)) {
      if (schema.properties && Object.hasOwn(schema.properties, k))
        validate(schema.properties[k], v, pointer + esc(k), out);
      else if (
        schema.patternProperties &&
        Object.entries(schema.patternProperties).some(([pattern]) => new RegExp(pattern, 'u').test(k))
      ) {
        const entry = Object.entries(schema.patternProperties).find(([pattern]) => new RegExp(pattern, 'u').test(k))!;
        validate(entry[1] as Schema, v, pointer + esc(k), out);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object')
        validate(schema.additionalProperties, v, pointer + esc(k), out);
      else if (
        schema.additionalProperties !== true &&
        (schema.properties || schema.patternProperties || schema.additionalProperties === false)
      )
        add('unknown_field', pointer + esc(k));
    }
    return;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      add('invalid_type');
      return;
    }
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) {
      add('out_of_range');
      return;
    }
    if (schema.uniqueItems) {
      const seen = new Set<unknown>();
      value.forEach((item, index) => {
        if (seen.has(item)) add('invalid_format', pointer + esc(index));
        else seen.add(item);
      });
    }
    value.forEach((v, i) => validate(schema.items, v, pointer + esc(i), out));
    return;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') {
      add('invalid_type');
      return;
    }
    const length = [...value].length;
    if (length < (schema.minLength ?? 0) || length > (schema.maxLength ?? Infinity)) add('out_of_range');
    else if (schema.pattern && new RegExp(schema.pattern, 'u').exec(value)?.[0] !== value) add('invalid_format');
    return;
  }
  if (schema.type === 'integer' || schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      add('invalid_type');
      return;
    }
    if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) add('out_of_range');
    return;
  }
}
function check(input: unknown, schema: Schema): Violation[] {
  const violations: Violation[] = [];
  validate(schema, input, '', violations);
  return violations;
}
// Subject and statement diagnostics come from the same checks as their single routes.
// The exported schema still describes their complete wire shapes.
const batchEnvelope = {
  ...BatchWriteRequestSchema,
  properties: {
    commands: {
      ...BatchWriteRequestSchema.properties.commands,
      items: {
        anyOf: BatchCommandSchema.anyOf.map((variant) => ({
          ...variant,
          properties: {
            ...variant.properties,
            ...(variant.properties.op.const === 'create' ? { subject: Type.Unknown() } : {}),
            ...(variant.properties.op.const === 'propose' ? { statement: Type.Unknown() } : {}),
          },
        })),
      },
    },
  },
};

export function checkBatchWrite(input: unknown, release?: Release): { pointer: string; code: string }[] {
  const errors = check(input, batchEnvelope);
  if (!record(input) || !Array.isArray(input.commands) || input.commands.length > BATCH_LIMIT) return errors;
  input.commands.forEach((command, i) => {
    if (!record(command)) return;
    const prefix = `/commands/${i}`;
    if (command.op === 'create' && Object.hasOwn(command, 'subject')) {
      const raw = command.subject;
      const subject = record(raw)
        ? Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'statements'))
        : raw;
      if (record(raw) && Object.hasOwn(raw, 'statements'))
        errors.push({ pointer: `${prefix}/subject/statements`, code: 'unsupported' });
      const violations = release
        ? checkSubjectInput(subject, release).violations
        : checkSubjectStructure(subject).violations;
      errors.push(...violations.map((error) => ({ ...error, pointer: `${prefix}/subject${error.pointer}` })));
      if (!release && record(subject)) {
        if (subject.type === undefined) errors.push({ pointer: `${prefix}/subject/type`, code: 'required' });
        else if (typeof subject.type !== 'string')
          errors.push({ pointer: `${prefix}/subject/type`, code: 'invalid_type' });
        else if (!subject.type.length) errors.push({ pointer: `${prefix}/subject/type`, code: 'out_of_range' });
      }
    } else if (command.op === 'propose' && Object.hasOwn(command, 'statement')) {
      errors.push(
        ...checkStatementInput(command.statement, release).violations.map((error) => ({
          ...error,
          pointer: prefix + error.pointer,
        })),
      );
      if (!release && record(command.statement) && command.statement.rank === 'deprecated')
        errors.push({ pointer: `${prefix}/statement/rank`, code: 'unsupported' });
    }
  });
  const seen = new Set<unknown>();
  input.commands.forEach((command, i) => {
    if (record(command) && Object.hasOwn(command, 'key')) {
      if (seen.has(command.key)) errors.push({ pointer: `/commands/${i}/key`, code: 'invalid_format' });
      else seen.add(command.key);
    }
  });
  input.commands.forEach((command, i) => {
    if (!record(command) || !record(command.source)) return;
    const pointer = `/commands/${i}`;
    const group = command.source.field_group;
    const summary = command.op === 'propose' && group === 'summary';
    if (Object.hasOwn(command, 'rights') && !summary) {
      for (let j = errors.length - 1; j >= 0; j--)
        if (errors[j]!.pointer === `${pointer}/rights` || errors[j]!.pointer.startsWith(`${pointer}/rights/`))
          errors.splice(j, 1);
      errors.push({ pointer: `${pointer}/rights`, code: 'unsupported' });
    }
    if (command.op === 'create') {
      if (group === 'summary' || group === 'cover')
        errors.push({ pointer: `${pointer}/source/field_group`, code: 'unsupported' });
      return;
    }
    if (command.op !== 'propose') return;
    if (release && record(command.statement) && record(command.statement.property)) {
      const id = command.statement.property.id;
      const property =
        typeof id === 'string' && Object.hasOwn(release.properties, id) ? release.properties[id] : undefined;
      if (
        property &&
        ((group === 'summary' && property.datatype !== 'document') ||
          (group === 'cover' && property.datatype !== 'media') ||
          (group === 'facts' && ['document', 'media'].includes(property.datatype)))
      )
        errors.push({ pointer: `${pointer}/statement/property/id`, code: 'unsupported' });
    }
    if (summary) {
      if (!Object.hasOwn(command, 'rights')) errors.push({ pointer: `${pointer}/rights`, code: 'required' });
      else if (
        record(command.rights) &&
        typeof command.rights.license === 'string' &&
        !errors.some((error) => error.pointer === `${pointer}/rights/license`) &&
        !licenseIds.has(command.rights.license) &&
        !/^LicenseRef-[A-Za-z0-9.+-]+$/.test(command.rights.license)
      )
        errors.push({ pointer: `${pointer}/rights/license`, code: 'invalid_format' });
    }
    if (group !== 'summary' && group !== 'cover') return;
    if (!record(command.statement) || !record(command.statement.value)) return;
    const value = command.statement.value;
    const path = `${pointer}/statement/value`;
    if (value.type === 'somevalue' || value.type === 'novalue') {
      errors.push({ pointer: `${path}/type`, code: 'unsupported' });
      return;
    }
    if (value.type !== 'value' || !Object.hasOwn(value, 'content')) return;
    validate(valueSchema(group === 'summary' ? 'document' : 'media'), value.content, `${path}/content`, errors);
    if (summary && record(value.content) && Object.hasOwn(value.content, 'document')) {
      const document = value.content.document;
      // The portable schema describes the envelope; document owns snapshot validation.
      const documentPath = `${path}/content/document`;
      for (let j = errors.length - 1; j >= 0; j--) if (errors[j]!.pointer === documentPath) errors.splice(j, 1);
      if (!record(document) || !checkDocument(document)) errors.push({ pointer: documentPath, code: 'invalid_format' });
      else if (Buffer.byteLength(serializeDocument(document), 'utf8') > 32_768)
        errors.push({ pointer: documentPath, code: 'out_of_range' });
    }
  });
  return errors;
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
export function checkBatchWriteResult(input: unknown): Violation[] {
  return check(input, BatchWriteResultSchema as Schema);
}
