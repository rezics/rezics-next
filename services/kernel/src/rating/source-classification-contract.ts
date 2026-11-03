import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import { Type, type Static } from 'typebox';
import { Compile } from 'typebox/compile';

export const MAX_SOURCE_CLASSIFICATION_BATCH = 32;
export const SOURCE_CLASSIFICATION_CHANGED = 'com.rezics.rating.source_classification.changed.v1';
const closed = { additionalProperties: false } as const;
const digest = Type.String({ pattern: '^[0-9a-f]{64}$' });
const uuid = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const tuple = {
  sourceAlias: Type.String({ pattern: '^[a-z][a-z0-9_-]{0,31}$' }),
  sourceRecordId: Type.String({ pattern: '^[vc][1-9][0-9]{0,15}$' }),
  sourceAssociationId: Type.String({ pattern: '^[gi][1-9][0-9]{0,15}$' }),
  asOf: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }),
};

/** Exact Semantic identity. Labels never participate in association resolution. */
export const ClassificationAssociationSchema = Type.Object(
  {
    subjectId: uuid,
    candidateId: uuid,
    contextId: uuid,
    targetId: uuid,
    property: text(256),
    revision: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
    release: digest,
    qualifiersDigest: digest,
  },
  closed,
);
export type ClassificationAssociation = Static<typeof ClassificationAssociationSchema>;

export const ClassificationSourceVersionSchema = Type.Union([
  Type.Object({ kind: Type.Literal('revision'), revision: text(256) }, closed),
  Type.Object({ kind: Type.Literal('unversioned'), digest }, closed),
]);
/** This is an admitted aggregate, never a provider response or an arbitrary property bag.
 * Imports owns extraction, permission and the meaning of independently supplied counts.
 */
export const ClassificationObservationSchema = Type.Object(
  {
    ...tuple,
    confidence: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 3 })),
    lie: Type.Optional(Type.Boolean()),
    confidenceCount: Type.Optional(Type.Integer({ minimum: 0, maximum: 2_147_483_647 })),
    lieCount: Type.Optional(Type.Integer({ minimum: 0, maximum: 2_147_483_647 })),
    sourceVersion: ClassificationSourceVersionSchema,
    attribution: text(2000),
    licence: text(1024),
  },
  closed,
);
export type ClassificationObservation = Static<typeof ClassificationObservationSchema>;
export const ClassificationClearSchema = Type.Object({ ...tuple, cleared: Type.Literal(true) }, closed);
export type ClassificationClear = Static<typeof ClassificationClearSchema>;
export type ClassificationPayload = ClassificationObservation | ClassificationClear;
export type ImmutableClassificationObservation = Readonly<{ digest: string; payload: ClassificationPayload }>;

const associationValidator = Compile(ClassificationAssociationSchema);
const observationValidator = Compile(ClassificationObservationSchema);
const clearValidator = Compile(ClassificationClearSchema);
const controls = /[\u0000-\u001f\u007f-\u009f]/u;
function stringsValid(value: unknown): boolean {
  if (typeof value === 'string') return value.isWellFormed() && !controls.test(value);
  if (value && typeof value === 'object') return Object.values(value).every(stringsValid);
  return true;
}
export function validateClassificationAssociation(value: unknown): asserts value is ClassificationAssociation {
  if (!associationValidator.Check(value) || !stringsValid(value))
    throw new TypeError('Invalid classification association');
}
export function validateClassificationObservation(value: unknown): asserts value is ClassificationObservation {
  if (!observationValidator.Check(value) || !stringsValid(value))
    throw new TypeError('Invalid classification observation');
  validateTuple(value);
  if (value.confidence === undefined && value.lie === undefined)
    throw new TypeError('No supplied classification indicator');
  if (value.sourceRecordId.startsWith('c') && value.confidence !== undefined)
    throw new TypeError('VNDB character traits do not supply confidence');
  if (Buffer.byteLength(value.licence) > 1024 || Buffer.byteLength(value.attribution) > 2000)
    throw new TypeError('Classification provenance exceeds byte limit');
}
export function validateClassificationClear(value: unknown): asserts value is ClassificationClear {
  if (!clearValidator.Check(value) || !stringsValid(value)) throw new TypeError('Invalid classification clear');
  validateTuple(value);
}
function validateTuple(value: ClassificationPayload) {
  if (value.sourceRecordId.startsWith('v') !== value.sourceAssociationId.startsWith('g'))
    throw new TypeError('VNDB association and record kinds differ');
  const date = new Date(value.asOf);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value.asOf)
    throw new TypeError('Invalid classification observation date');
}
export function classificationDigest(value: unknown): string {
  const bytes = canonicalize(value);
  if (typeof bytes !== 'string') throw new TypeError('Classification observation must be canonical JSON');
  return createHash('sha256').update(bytes).digest('hex');
}
export function classificationAssociationKey(association: ClassificationAssociation): string {
  validateClassificationAssociation(association);
  return classificationDigest(['classification-association.v1', association]);
}
export function classificationObservation(
  association: ClassificationAssociation,
  payload: ClassificationPayload,
): ImmutableClassificationObservation {
  validateClassificationAssociation(association);
  if ('cleared' in payload) validateClassificationClear(payload);
  else validateClassificationObservation(payload);
  // Copy through canonical JSON: the retained identity cannot be mutated by the caller while awaiting IO.
  const frozen = JSON.parse(canonicalize(payload)!) as ClassificationPayload;
  return { digest: classificationDigest(['vndb-classification-observation.v1', association, frozen]), payload: frozen };
}

export type ClassificationUnavailableReason =
  | 'not_found'
  | 'not_observed'
  | 'provenance_unavailable'
  | 'authority_unavailable'
  | 'changed';
export type SourceClassificationFigure = Readonly<{
  provider: 'vndb';
  association: ClassificationAssociation;
  observation: { digest: string; sourceVersion: ClassificationObservation['sourceVersion'] };
  sourceAlias: string;
  sourceRecordId: string;
  sourceAssociationId: string;
  confidence:
    | { state: 'available'; value: number; unit: 'vndb-tag-rating'; minExclusive: 0; max: 3 }
    | { state: 'unavailable'; reason: 'not_supplied' };
  lie: { state: 'available'; value: boolean; unit: 'boolean' } | { state: 'unavailable'; reason: 'not_supplied' };
  confidenceCount?: number;
  lieCount?: number;
  asOf: string;
  ageSeconds: number;
  attribution: string;
  licence: string;
}>;
export type SourceClassificationRead =
  | { state: 'available'; value: SourceClassificationFigure }
  | { state: 'unavailable'; reason: ClassificationUnavailableReason };

/** Hash public Semantic qualifier snaks without presentation datatype fields. */
export function classificationQualifiersDigest(
  qualifiers: readonly {
    property: string | { id: string };
    value: unknown;
  }[],
): string {
  return classificationDigest(
    qualifiers.map((q) => ({
      property: typeof q.property === 'string' ? q.property : q.property.id,
      value: q.value,
    })),
  );
}
