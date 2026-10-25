import { Type, type Static } from 'typebox';
import { Compile } from 'typebox/schema';
import type { Release } from './index.ts';

export const BATCH_LIMIT = 100;
export const FIELD_GROUPS = ['facts', 'summary', 'cover'] as const;
export type FieldGroup = (typeof FIELD_GROUPS)[number];
export const SourceSchema = Type.Object({
  source: Type.String({ pattern: '^[a-z][a-z0-9_-]{0,31}$' }), external_id: Type.String({ minLength: 1, maxLength: 255 }),
  record_revision: Type.String({ minLength: 1, maxLength: 64 }), digest: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  converter_revision: Type.String({ minLength: 1, maxLength: 64 }), field_group: Type.Union([Type.Literal('facts'), Type.Literal('summary'), Type.Literal('cover')]),
});
export type Source = Static<typeof SourceSchema>;
const id = Type.Object({ id: Type.String({ minLength: 1 }) });
const snak = Type.Union([
  Type.Object({ property: id, value: Type.Object({ type: Type.Literal('value'), content: Type.Unknown() }) }),
  Type.Object({ property: id, value: Type.Union([Type.Object({ type: Type.Literal('somevalue') }), Type.Object({ type: Type.Literal('novalue') })]) }),
]);
export const BatchReferenceSchema = Type.Object({ parts: Type.Array(snak, { minItems: 1 }) });
export type BatchReference = Static<typeof BatchReferenceSchema>;
export const BatchStatementSchema = Type.Object({ property: id, value: Type.Union([Type.Object({ type: Type.Literal('value'), content: Type.Unknown() }), Type.Object({ type: Type.Literal('somevalue') }), Type.Object({ type: Type.Literal('novalue') })]), qualifiers: Type.Optional(Type.Array(snak)), references: Type.Array(BatchReferenceSchema, { minItems: 1, maxItems: 16 }), rank: Type.Optional(Type.Union([Type.Literal('normal'), Type.Literal('preferred')])) });
export type BatchStatement = Static<typeof BatchStatementSchema>;
const langmap = Type.Record(Type.String({ minLength: 1 }), Type.String({ minLength: 1 }));
const subjectBody = Type.Object({ type: Type.String({ minLength: 1 }), labels: langmap, descriptions: Type.Optional(langmap), aliases: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.Array(Type.String({ minLength: 1 })))), statements: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.Array(BatchStatementSchema))) });
const uuid = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const key = Type.String({ minLength: 1, maxLength: 255, pattern: '^[\\x20-\\x7e]+$' });
const base = { key, source: SourceSchema };
export const BatchCommandSchema = Type.Union([
  Type.Object({ op: Type.Literal('create'), ...base, subject: subjectBody }),
  Type.Object({ op: Type.Literal('propose'), ...base, subject: uuid, statement: BatchStatementSchema }),
  Type.Object({ op: Type.Literal('retract'), ...base, subject: uuid, candidate: uuid, references: Type.Array(BatchReferenceSchema, { minItems: 1, maxItems: 16 }) }),
]);
export type BatchCommand = Static<typeof BatchCommandSchema>;
export const BatchWriteRequestSchema = Type.Object({ commands: Type.Array(BatchCommandSchema, { minItems: 1, maxItems: BATCH_LIMIT }) });
export type BatchWriteRequest = Static<typeof BatchWriteRequestSchema>;
const problem = Type.Object({ type: Type.String(), title: Type.String(), status: Type.Integer({ minimum: 400, maximum: 599 }), detail: Type.Optional(Type.String()), errors: Type.Optional(Type.Array(Type.Unknown())) }, { additionalProperties: true });
const result = Type.Union([
  Type.Object({ key, status: Type.Union([Type.Literal(200), Type.Literal(201)]), value: Type.Union([Type.Object({ id: uuid, revision: Type.Integer({ minimum: 1 }) }), Type.Object({ candidate: uuid, revision: Type.Integer({ minimum: 1 }) }), Type.Object({ revision: Type.Integer({ minimum: 1 }) })]) }),
  Type.Object({ key, status: Type.Integer({ minimum: 400, maximum: 599 }), problem }),
]);
export const BatchWriteResultSchema = Type.Object({ results: Type.Array(result, { minItems: 1, maxItems: BATCH_LIMIT }) });
export type BatchWriteResult = Static<typeof BatchWriteResultSchema>;
export type Violation = { pointer: string; code: 'required' | 'unknown_field' | 'invalid_type' | 'invalid_format' | 'out_of_range' | 'unsupported' };
type Schema = Record<string, any>;
const esc = (x: string | number) => `/${String(x).replace(/~/g, '~0').replace(/\//g, '~1')}`;
function validate(schema: Schema, value: unknown, pointer: string, out: Violation[]) {
  const add = (code: Violation['code'], at = pointer) => out.push({ pointer: at, code });
  if (schema.anyOf || schema.oneOf) {
    const variants = schema.anyOf ?? schema.oneOf;
    const attempts = variants.map((s: Schema) => { const tmp: Violation[] = []; validate(s, value, pointer, tmp); return tmp; });
    if (attempts.some((v: Violation[]) => !v.length)) return;
    if (schema.anyOf) { const best = attempts.reduce((a: Violation[], b: Violation[]) => b.length < a.length ? b : a); out.push(...best); return; }
  }
  if (schema.const !== undefined || schema.enum) { if (!(schema.enum ?? [schema.const]).includes(value)) add('unsupported'); return; }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { add('invalid_type'); return; }
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) if (!Object.hasOwn(obj, req)) add('required', pointer + esc(req));
    for (const [k,v] of Object.entries(obj)) {
      if (schema.properties?.[k]) validate(schema.properties[k], v, pointer + esc(k), out);
      else if (schema.patternProperties && Object.entries(schema.patternProperties).some(([pattern]) => new RegExp(pattern, 'u').test(k))) { const entry = Object.entries(schema.patternProperties).find(([pattern]) => new RegExp(pattern, 'u').test(k))!; validate(entry[1] as Schema, v, pointer + esc(k), out); }
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validate(schema.additionalProperties, v, pointer + esc(k), out);
      else if (schema.additionalProperties !== true) add('unknown_field', pointer + esc(k));
    } return;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) { add('invalid_type'); return; }
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) add('out_of_range');
    value.forEach((v,i) => validate(schema.items, v, pointer + esc(i), out)); return;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') { add('invalid_type'); return; }
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) add('out_of_range');
    else if (schema.pattern && !(new RegExp(schema.pattern, 'u')).test(value)) add('invalid_format'); return;
  }
  if (schema.type === 'integer' || schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isInteger(value)) { add('invalid_type'); return; }
    if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) add('out_of_range'); return;
  }
}
function check(input: unknown, schema: Schema): Violation[] {
  const violations: Violation[] = []; validate(schema, input, '', violations);
  return violations;
}
export function checkBatchWrite(input: unknown, release?: Release): Violation[] {
  if (release !== undefined) throw new Error('release checks are not implemented');
  const errors = check(input, BatchWriteRequestSchema as Schema);
  if (input && typeof input === 'object' && Array.isArray((input as any).commands)) {
    const seen = new Set<unknown>();
    (input as any).commands.forEach((command: any, i: number) => { if (command && typeof command === 'object' && 'key' in command) { if (seen.has(command.key)) errors.push({ pointer: `/commands/${i}/key`, code: 'invalid_format' }); else seen.add(command.key); } });
  }
  return errors;
}
export function checkBatchWriteResult(input: unknown): Violation[] { return check(input, BatchWriteResultSchema as Schema); }
