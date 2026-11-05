import { createHash } from 'node:crypto';
import {
  classificationObservedInstant,
  classificationSourceVersion,
  type SourceClassificationProjection,
  type SourceClassificationValue,
} from '@rezics/conversion';
import {
  classificationAssociationKey,
  classificationObservation,
  type ClassificationAssociation,
  type ClassificationClear,
  type ClassificationObservation,
} from '../../kernel/src/rating/source-classification-contract.ts';

export { classificationAssociationKey, classificationObservation };

export const SOURCE_CLASSIFICATION_PAGE_MAX = 20;
export const CLASSIFICATION_DIGEST = /^[0-9a-f]{64}$/;
const ASSOCIATION_MEMBER = /^[gi][1-9][0-9]{0,15}$/;
const RECORD = /^[vc][1-9][0-9]{0,15}$/;
const AS_OF = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type ClassificationKind = 'write' | 'clear';
export type ClassificationReason =
  | 'equal-date-correction'
  | 'record-rebinding'
  | 'alias-rebinding'
  | 'association-rebinding'
  | 'older-date'
  | 'cas-mismatch'
  | 'concurrent-head'
  | 'association-unavailable';

export type IntendedClassificationWrite = Readonly<{
  family: 'classification';
  kind: 'write';
  association: ClassificationAssociation;
  sourceAlias: string;
  sourceRecordId: string;
  sourceAssociationId: string;
  asOf: string;
  sourceVersion: ClassificationObservation['sourceVersion'];
  attribution: string;
  licence: string;
  confidence?: number;
  lie?: boolean;
  confidenceCount?: number;
  lieCount?: number;
}>;
export type IntendedClassificationClear = Readonly<{
  family: 'classification';
  kind: 'clear';
  association: ClassificationAssociation;
  sourceAlias: string;
  sourceRecordId: string;
  sourceAssociationId: string;
  asOf: string;
}>;
export type IntendedClassification = IntendedClassificationWrite | IntendedClassificationClear;

export type RetainedClassificationHead = Readonly<{
  associationKey: string;
  association: ClassificationAssociation;
  sourceAlias: string;
  sourceRecordId: string;
  sourceAssociationId: string;
  asOf: string;
  cleared: boolean;
  digest: string;
}>;

export type ClassificationHeadRead =
  | { kind: 'absent' }
  | { kind: 'head'; head: RetainedClassificationHead }
  | { kind: 'unavailable'; status?: number; code?: string; reason?: ClassificationReason };

export type ClassificationDecision =
  | { action: 'identical' }
  | { action: 'automatic' }
  | { action: 'conflict'; reason: ClassificationReason }
  | { action: 'refused'; reason: ClassificationReason };

export class ClassificationConflictError extends Error {
  readonly name = 'ClassificationConflictError';
  constructor(
    readonly operationId: string,
    readonly reason: ClassificationReason,
  ) {
    super('Source classification requires explicit operator resolution');
  }
}

export class ClassificationRefusedError extends Error {
  readonly name = 'ClassificationRefusedError';
  constructor(
    readonly operationId: string,
    readonly reason: ClassificationReason,
  ) {
    super('Source classification date is older than the retained head');
  }
}

export function classificationPayload(
  intended: IntendedClassification,
): ClassificationObservation | ClassificationClear {
  if (intended.kind === 'clear') {
    return {
      sourceAlias: intended.sourceAlias,
      sourceRecordId: intended.sourceRecordId,
      sourceAssociationId: intended.sourceAssociationId,
      asOf: intended.asOf,
      cleared: true,
    };
  }
  return {
    sourceAlias: intended.sourceAlias,
    sourceRecordId: intended.sourceRecordId,
    sourceAssociationId: intended.sourceAssociationId,
    asOf: intended.asOf,
    sourceVersion: intended.sourceVersion,
    attribution: intended.attribution,
    licence: intended.licence,
    ...(intended.confidence === undefined ? {} : { confidence: intended.confidence }),
    ...(intended.lie === undefined ? {} : { lie: intended.lie }),
    ...(intended.confidenceCount === undefined ? {} : { confidenceCount: intended.confidenceCount }),
    ...(intended.lieCount === undefined ? {} : { lieCount: intended.lieCount }),
  };
}

export function intendedClassificationRequest(intended: IntendedClassification, expectedObservation: string | null) {
  return {
    association: intended.association,
    expectedObservation,
    value: classificationPayload(intended),
  };
}

export function classificationOperationDigest(intended: IntendedClassification): string {
  return classificationObservation(intended.association, classificationPayload(intended)).digest;
}

export function sameClassificationBinding(intended: IntendedClassification, head: RetainedClassificationHead): boolean {
  return (
    intended.sourceAlias === head.sourceAlias &&
    intended.sourceRecordId === head.sourceRecordId &&
    intended.sourceAssociationId === head.sourceAssociationId &&
    classificationAssociationKey(intended.association) === head.associationKey
  );
}

export function classifyClassification(
  intended: IntendedClassification,
  head: ClassificationHeadRead,
): ClassificationDecision {
  if (head.kind === 'unavailable') throw new TypeError('Unavailable classification head is not an absent head');
  const nextDigest = classificationOperationDigest(intended);
  if (head.kind === 'absent') return { action: 'automatic' };
  if (head.head.digest === nextDigest) return { action: 'identical' };
  if (intended.asOf < head.head.asOf) return { action: 'refused', reason: 'older-date' };
  if (!sameClassificationBinding(intended, head.head)) {
    if (classificationAssociationKey(intended.association) !== head.head.associationKey)
      return { action: 'conflict', reason: 'association-rebinding' };
    return {
      action: 'conflict',
      reason: intended.sourceAlias === head.head.sourceAlias ? 'record-rebinding' : 'alias-rebinding',
    };
  }
  if (intended.asOf === head.head.asOf) return { action: 'conflict', reason: 'equal-date-correction' };
  return { action: 'conflict', reason: 'cas-mismatch' };
}

export function classificationOperationId(input: {
  runId: string;
  recordKey: string;
  subjectId: string;
  intended: IntendedClassification;
  expectedObservation?: string | null;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.runId,
        input.recordKey,
        input.subjectId,
        'classification',
        input.intended.kind,
        classificationPayload(input.intended),
        classificationAssociationKey(input.intended.association),
        input.expectedObservation ?? null,
      ]),
    )
    .digest('hex');
}

export function nativeClassificationReason(reason: ClassificationReason): string {
  switch (reason) {
    case 'equal-date-correction':
      return 'Equal-time classification differs from the retained head and needs expectedObservation.';
    case 'record-rebinding':
      return 'A different source record occupies this classification slot and needs expectedObservation.';
    case 'alias-rebinding':
      return 'A different source alias occupies this classification slot and needs expectedObservation.';
    case 'association-rebinding':
      return 'A different Semantic association occupies this slot and needs expectedObservation.';
    case 'older-date':
      return 'An older classification date cannot override the retained head, including with CAS.';
    case 'cas-mismatch':
      return 'Changed classification payloads require the current retained digest as expectedObservation.';
    case 'concurrent-head':
      return 'The retained classification head changed after inspection; a fresh decision is required.';
    case 'association-unavailable':
      return 'No authentic Semantic association is bound; classification is withheld.';
  }
}

export function headFromClassification(intended: IntendedClassification): RetainedClassificationHead {
  return {
    associationKey: classificationAssociationKey(intended.association),
    association: intended.association,
    sourceAlias: intended.sourceAlias,
    sourceRecordId: intended.sourceRecordId,
    sourceAssociationId: intended.sourceAssociationId,
    asOf: intended.asOf,
    cleared: intended.kind === 'clear',
    digest: classificationOperationDigest(intended),
  };
}

export function normalizeClassificationAsOf(value: string): string | null {
  const iso = classificationObservedInstant(value);
  return iso && AS_OF.test(iso) ? iso : null;
}

export function intendedFromProjection(
  projection: SourceClassificationProjection,
  association: ClassificationAssociation,
): IntendedClassification | null {
  if (projection.state !== 'available') return null;
  const { provenance, value } = projection;
  if (!provenance.sourceAssociationId || !ASSOCIATION_MEMBER.test(provenance.sourceAssociationId)) return null;
  if (!RECORD.test(provenance.sourceRecordId)) return null;
  if (provenance.observedAt === null) return null;
  const asOf = normalizeClassificationAsOf(provenance.observedAt);
  if (!asOf) return null;
  const sourceVersion = classificationSourceVersion(provenance);
  if (!sourceVersion && value.kind !== 'clear') return null;
  if (value.kind === 'clear') {
    return {
      family: 'classification',
      kind: 'clear',
      association,
      sourceAlias: provenance.sourceAlias,
      sourceRecordId: provenance.sourceRecordId,
      sourceAssociationId: provenance.sourceAssociationId,
      asOf,
    };
  }
  return {
    family: 'classification',
    kind: 'write',
    association,
    sourceAlias: provenance.sourceAlias,
    sourceRecordId: provenance.sourceRecordId,
    sourceAssociationId: provenance.sourceAssociationId,
    asOf,
    sourceVersion: sourceVersion!,
    attribution: provenance.attribution,
    licence: provenance.licence.id,
    ...observationFields(value),
  };
}

function observationFields(value: Extract<SourceClassificationValue, { kind: 'observation' }>) {
  return {
    ...(value.confidence === undefined ? {} : { confidence: value.confidence }),
    ...(value.lie === undefined ? {} : { lie: value.lie }),
    ...(value.confidenceCount === undefined ? {} : { confidenceCount: value.confidenceCount }),
    ...(value.lieCount === undefined ? {} : { lieCount: value.lieCount }),
  };
}

export function isIntendedClassification(value: unknown): value is IntendedClassification {
  return !!value && typeof value === 'object' && (value as { family?: unknown }).family === 'classification';
}

export function safeClassificationSummary(input: {
  operationId: string;
  recordKey: string;
  subjectId: string;
  intended: IntendedClassification;
  head: RetainedClassificationHead | null;
  reason?: ClassificationReason;
  status: string;
}): Record<string, unknown> {
  return {
    operationId: input.operationId,
    recordKey: input.recordKey,
    subjectId: input.subjectId,
    family: 'classification',
    associationKey: classificationAssociationKey(input.intended.association),
    sourceAlias: input.intended.sourceAlias,
    sourceRecordId: input.intended.sourceRecordId,
    sourceAssociationId: input.intended.sourceAssociationId,
    date: input.intended.asOf,
    clear: input.intended.kind === 'clear',
    ...(input.intended.kind === 'write'
      ? {
          ...(input.intended.confidence === undefined ? {} : { confidence: input.intended.confidence }),
          ...(input.intended.lie === undefined ? {} : { lie: input.intended.lie }),
        }
      : {}),
    head: input.head
      ? {
          associationKey: input.head.associationKey,
          sourceAlias: input.head.sourceAlias,
          sourceRecordId: input.head.sourceRecordId,
          sourceAssociationId: input.head.sourceAssociationId,
          date: input.head.asOf,
          cleared: input.head.cleared,
          digest: input.head.digest,
        }
      : null,
    status: input.status,
    ...(input.reason === undefined
      ? {}
      : { reason: input.reason, nativeReason: nativeClassificationReason(input.reason) }),
    note: 'A source classification observation is independent of a REZICS classification ballot.',
  };
}

const REASONS: readonly ClassificationReason[] = [
  'equal-date-correction',
  'record-rebinding',
  'alias-rebinding',
  'association-rebinding',
  'older-date',
  'cas-mismatch',
  'concurrent-head',
  'association-unavailable',
];

export function parseClassificationReason(value: string | null | undefined): ClassificationReason | undefined {
  return value && (REASONS as readonly string[]).includes(value) ? (value as ClassificationReason) : undefined;
}
