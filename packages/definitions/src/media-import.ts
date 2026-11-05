import { Type, type Static, type TSchema } from 'typebox';
import { Errors } from 'typebox/schema';
import { BatchReferenceSchema, RightsSchema, SourceSchema, checkBatchWrite, type Violation } from './bulk.ts';

// Close the portable citation envelopes without defining another citation shape.
function closed<T extends TSchema>(schema: T): T {
  const node = schema as TSchema & Record<string, unknown>;
  return {
    ...schema,
    ...(node.type === 'object' ? { additionalProperties: false } : {}),
    ...(node.properties
      ? {
          properties: Object.fromEntries(
            Object.entries(node.properties as Record<string, TSchema>).map(([key, value]) => [
              key,
              closed(value as TSchema),
            ]),
          ),
        }
      : {}),
    ...(node.items ? { items: closed(node.items as TSchema) } : {}),
    ...(node.anyOf ? { anyOf: (node.anyOf as TSchema[]).map(closed) } : {}),
    ...(node.pattern ? { pattern: `(?:${node.pattern})(?![\\s\\S])` } : {}),
  };
}
const uuid = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\\s\\S])' });
const text = Type.String({ minLength: 1, maxLength: 1024 });
const https = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: '^https://[^\\s]+(?![\\s\\S])' });
const crop = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: '^xywh=\\d+,\\d+,(?:0*[1-9]\\d*),(?:0*[1-9]\\d*)$',
});
const focalPoint = Type.Object(
  { x: Type.Number({ minimum: 0, maximum: 1 }), y: Type.Number({ minimum: 0, maximum: 1 }) },
  { additionalProperties: false },
);

/** Image rights are independent of the licence on catalogue metadata. */
export const CoverCreditSchema = Type.Object(
  {
    rightsHolder: text,
    via: Type.Object({ name: text, url: https(1024) }, { additionalProperties: false }),
    license: RightsSchema.properties.license,
    obligations: RightsSchema.properties.obligations,
  },
  { additionalProperties: false },
);
export type CoverCredit = Static<typeof CoverCreditSchema>;
export const CoverProvenanceSchema = closed(
  Type.Object({
    ...SourceSchema.properties,
    field_group: Type.Literal('cover'),
    references: Type.Array(BatchReferenceSchema, { minItems: 1, maxItems: 128 }),
  }),
);
export type CoverProvenance = Static<typeof CoverProvenanceSchema>;
export const MediaImportRequestSchema = Type.Object(
  {
    containerId: uuid,
    sourceUrl: https(2048),
    crop: Type.Optional(crop),
    focalPoint: Type.Optional(focalPoint),
    credit: CoverCreditSchema,
    provenance: CoverProvenanceSchema,
  },
  { additionalProperties: false },
);
export type MediaImportRequest = Static<typeof MediaImportRequestSchema>;

const identity = { id: uuid, containerId: uuid, purpose: Type.Literal('cover') };
/** HTTP 202 receipt; acceptance does not imply successful processing. */
export const MediaImportAcceptedSchema = Type.Object(
  {
    media: Type.Object({ ...identity, state: Type.Literal('reserved') }, { additionalProperties: false }),
  },
  { additionalProperties: false },
);
export type MediaImportAccepted = Static<typeof MediaImportAcceptedSchema>;
const measurements = {
  byteCount: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  mediaType: text,
  sha256: Type.String({ pattern: '^[0-9a-f]{64}(?![\\s\\S])' }),
};
const statusFields = {
  ...identity,
  crop: Type.Optional(crop),
  focalPoint: Type.Optional(focalPoint),
  credit: CoverCreditSchema,
  provenance: CoverProvenanceSchema,
  rejection: Type.Optional(Type.Object({ code: text }, { additionalProperties: false })),
};
const pendingMedia = Type.Object(
  {
    ...statusFields,
    state: Type.Union([Type.Literal('reserved'), Type.Literal('rejected')]),
    byteCount: Type.Union([measurements.byteCount, Type.Null()]),
    mediaType: Type.Union([measurements.mediaType, Type.Null()]),
    sha256: Type.Union([measurements.sha256, Type.Null()]),
  },
  { additionalProperties: false },
);
const measuredMedia = Type.Object(
  {
    ...statusFields,
    state: Type.Union([Type.Literal('uploaded'), Type.Literal('available')]),
    ...measurements,
  },
  { additionalProperties: false },
);
const envelope = <T extends TSchema>(media: T) => Type.Object({ media }, { additionalProperties: false });
export const MediaImportStatusSchema = envelope(Type.Union([pendingMedia, measuredMedia]));
const pendingStatus = envelope(pendingMedia);
const measuredStatus = envelope(measuredMedia);
export type MediaImportStatus = Static<typeof MediaImportStatusSchema>;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const at = (pointer: string, member: string | number) =>
  `${pointer}/${String(member).replace(/~/g, '~0').replace(/\//g, '~1')}`;
function structural(schema: TSchema, input: unknown): Violation[] {
  const violations: Violation[] = [];
  const add = (pointer: string, code: Violation['code']) => violations.push({ pointer, code });
  for (const error of Errors(schema, input)[1]) {
    const pointer = error.instancePath;
    if (error.keyword === 'required')
      error.params.requiredProperties.forEach((member) => add(at(pointer, member), 'required'));
    else if (error.keyword === 'additionalProperties')
      error.params.additionalProperties.forEach((member) => add(at(pointer, member), 'unknown_field'));
    else if (error.keyword === 'uniqueItems')
      error.params.duplicateItems.forEach((index) => add(at(pointer, index), 'invalid_format'));
    else if (error.keyword === 'type') add(pointer, 'invalid_type');
    else if (['minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum'].includes(error.keyword))
      add(pointer, 'out_of_range');
    else if (error.keyword === 'const' || error.keyword === 'enum' || error.keyword === 'anyOf')
      add(pointer, 'unsupported');
    else if (error.keyword !== 'boolean') add(pointer, 'invalid_format');
  }
  return violations;
}

function checkCredit(credit: unknown, pointer: string, violations: Violation[]) {
  if (!record(credit)) return violations;
  // Bulk currently exposes its semantic Rights check through checkBatchWrite.
  // Project only its Rights diagnostics; no document, catalogue or kernel checks run.
  const rights = {
    ...(Object.hasOwn(credit, 'license') ? { license: credit.license } : {}),
    ...(Object.hasOwn(credit, 'obligations') ? { obligations: credit.obligations } : {}),
    attribution: 'image credit',
  };
  const errors = checkBatchWrite({ commands: [{ op: 'propose', source: { field_group: 'summary' }, rights }] });
  const filtered = violations.filter(
    (violation) =>
      !['license', 'obligations'].some(
        (member) =>
          violation.pointer === at(pointer, member) || violation.pointer.startsWith(at(pointer, member) + '/'),
      ),
  );
  for (const error of errors) {
    if (error.pointer.startsWith('/commands/0/rights/'))
      filtered.push({
        pointer: pointer + error.pointer.slice('/commands/0/rights'.length),
        code: error.code as Violation['code'],
      });
  }
  return filtered;
}
function checkUrl(value: unknown, pointer: string, violations: Violation[]) {
  if (typeof value !== 'string' || violations.some((v) => v.pointer === pointer)) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname) throw new Error('HTTPS URL required');
  } catch {
    violations.push({ pointer, code: 'invalid_format' });
  }
}
function checkCrop(value: unknown, pointer: string, violations: Violation[]) {
  if (typeof value !== 'string' || violations.some((violation) => violation.pointer === pointer)) return;
  const match = /^xywh=(\d+),(\d+),(\d+),(\d+)$/.exec(value);
  if (!match) {
    violations.push({ pointer, code: 'invalid_format' });
    return;
  }
  const values = match.slice(1).map(Number);
  if (
    values.some((number) => !Number.isSafeInteger(number) || number > 2_147_483_647) ||
    values[2]! < 1 ||
    values[3]! < 1
  )
    violations.push({ pointer, code: 'out_of_range' });
}
function checkBody(body: Record<string, unknown>, pointer: string, violations: Violation[]) {
  const result = checkCredit(body.credit, at(pointer, 'credit'), violations);
  if (record(body.credit) && record(body.credit.via))
    checkUrl(body.credit.via.url, `${pointer}/credit/via/url`, result);
  if (Object.hasOwn(body, 'crop')) checkCrop(body.crop, at(pointer, 'crop'), result);
  return result;
}

// Refuse oversized collections before the schema engine's item/uniqueness work.
function collectionLimit(body: unknown, pointer: string): Violation[] {
  if (!record(body)) return [];
  if (record(body.credit) && Array.isArray(body.credit.obligations) && body.credit.obligations.length > 4)
    return checkCredit(body.credit, `${pointer}/credit`, []);
  if (record(body.provenance) && Array.isArray(body.provenance.references) && body.provenance.references.length > 128)
    return [{ pointer: `${pointer}/provenance/references`, code: 'out_of_range' }];
  return [];
}

/** Structural checks only: host allowlisting and rights authorization belong to runtime. */
export function checkMediaImportRequest(input: unknown): Violation[] {
  const limit = collectionLimit(input, '');
  if (limit.length) return limit;
  let violations = structural(MediaImportRequestSchema, input);
  if (record(input)) {
    violations = checkBody(input, '', violations);
    checkUrl(input.sourceUrl, '/sourceUrl', violations);
  }
  return violations;
}
/** No object keys, fetch URLs or tokens are part of the public status. */
export function checkMediaImportStatus(input: unknown): Violation[] {
  const limit = collectionLimit(record(input) ? input.media : undefined, '/media');
  if (limit.length) return limit;
  const state = record(input) && record(input.media) ? input.media.state : undefined;
  const schema =
    state === 'uploaded' || state === 'available'
      ? measuredStatus
      : state === 'reserved' || state === 'rejected'
        ? pendingStatus
        : MediaImportStatusSchema;
  let violations = structural(schema, input);
  if (record(input) && record(input.media)) violations = checkBody(input.media, '/media', violations);
  return violations;
}
