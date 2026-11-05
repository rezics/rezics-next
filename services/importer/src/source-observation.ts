import { createHash } from 'node:crypto';
import { sourceObservation } from '../../kernel/src/rating/source-provider.ts';
import type { ImportSourceStatistic, ImportSourceStatisticClear } from './import-contract.ts';

export const SOURCE_OBSERVATION_PROVIDER = 'vndb' as const;
export const SOURCE_OBSERVATION_PAGE_MAX = 20;
export const DIGEST = /^[0-9a-f]{64}$/;

export type ObservationKind = 'write' | 'clear';
export type AggregateOperationStatus = 'prepared' | 'uncertain' | 'conflict' | 'refused' | 'delivered' | 'superseded';

export type IntendedWrite = Omit<ImportSourceStatistic, 'source' | 'expectedObservation'>;
export type IntendedClear = Omit<ImportSourceStatisticClear, 'source' | 'expectedObservation'>;
export type IntendedObservation = (IntendedWrite & { kind: 'write' }) | (IntendedClear & { kind: 'clear' });

export function isIntendedObservation(value: unknown): value is IntendedObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value) || 'association' in value) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'write' || kind === 'clear';
}

export type RetainedObservationHead = Readonly<{
  provider: typeof SOURCE_OBSERVATION_PROVIDER;
  sourceAlias: string;
  sourceRecordId: string;
  asOf: string;
  count: number;
  scale?: { min: number; max: number };
  mean?: number;
  cleared: boolean;
  digest: string;
}>;

export type ObservationHeadRead =
  | { kind: 'absent' }
  | { kind: 'head'; head: RetainedObservationHead }
  | { kind: 'unavailable'; status?: number; code?: string };

export type PublicFigureRead =
  | { kind: 'figure'; figure: Readonly<{ count: number; state: string; mean: number | null }> }
  | { kind: 'unavailable'; status?: number; code?: string };

export type ObservationDecision =
  | { action: 'identical' }
  | { action: 'automatic' }
  | { action: 'conflict'; reason: ObservationReason }
  | { action: 'refused'; reason: ObservationReason };

export type ObservationReason =
  | 'equal-date-correction'
  | 'record-rebinding'
  | 'alias-rebinding'
  | 'older-date'
  | 'cas-mismatch'
  | 'concurrent-head';

export class ObservationConflictError extends Error {
  readonly name = 'ObservationConflictError';
  constructor(
    readonly operationId: string,
    readonly reason: ObservationReason,
  ) {
    super('Source observation requires explicit operator resolution');
  }
}

export class ObservationRefusedError extends Error {
  readonly name = 'ObservationRefusedError';
  constructor(
    readonly operationId: string,
    readonly reason: ObservationReason,
  ) {
    super('Source observation date is older than the retained head');
  }
}

export function observationDigest(
  subjectId: string,
  value: Pick<IntendedObservation, 'sourceRecordId' | 'count' | 'asOf'> & {
    sourceAlias?: string;
    scale?: { min: number; max: number };
    mean?: number;
    licence?: string;
    attribution?: string;
  },
): string {
  return sourceObservation(subjectId, SOURCE_OBSERVATION_PROVIDER, {
    sourceRecordId: value.sourceRecordId,
    count: value.count,
    asOf: value.asOf,
    ...(value.sourceAlias === undefined ? {} : { sourceAlias: value.sourceAlias }),
    ...(value.scale === undefined ? {} : { scale: value.scale }),
    ...(value.mean === undefined ? {} : { mean: value.mean }),
    ...(value.licence === undefined ? {} : { licence: value.licence }),
    ...(value.attribution === undefined ? {} : { attribution: value.attribution }),
  }).digest;
}

export function intendedPayload(intended: IntendedObservation): Record<string, unknown> {
  if (intended.kind === 'clear') {
    return {
      ...(intended.sourceAlias === undefined ? {} : { sourceAlias: intended.sourceAlias }),
      sourceRecordId: intended.sourceRecordId,
      count: 0,
      asOf: intended.asOf,
    };
  }
  return {
    ...(intended.sourceAlias === undefined ? {} : { sourceAlias: intended.sourceAlias }),
    sourceRecordId: intended.sourceRecordId,
    scale: intended.scale,
    mean: intended.mean,
    count: intended.count,
    asOf: intended.asOf,
    licence: intended.licence,
    attribution: intended.attribution,
  };
}

export function effectiveAlias(sourceAlias: string | undefined): string {
  return sourceAlias ?? SOURCE_OBSERVATION_PROVIDER;
}

export function sameBinding(intended: IntendedObservation, head: RetainedObservationHead): boolean {
  return effectiveAlias(intended.sourceAlias) === head.sourceAlias && intended.sourceRecordId === head.sourceRecordId;
}

export function classifyObservation(
  intended: IntendedObservation,
  subjectId: string,
  head: ObservationHeadRead,
): ObservationDecision {
  if (head.kind === 'unavailable') throw new TypeError('Unavailable observation head is not an absent head');
  const nextDigest = observationDigest(subjectId, intended);
  if (head.kind === 'absent') return { action: 'automatic' };
  if (head.head.digest === nextDigest) return { action: 'identical' };
  if (intended.asOf < head.head.asOf) return { action: 'refused', reason: 'older-date' };
  const rebound = !sameBinding(intended, head.head);
  if (rebound)
    return {
      action: 'conflict',
      reason: effectiveAlias(intended.sourceAlias) === head.head.sourceAlias ? 'record-rebinding' : 'alias-rebinding',
    };
  if (intended.asOf === head.head.asOf) return { action: 'conflict', reason: 'equal-date-correction' };
  return { action: 'automatic' };
}

export function aggregateOperationId(input: {
  runId: string;
  recordKey: string;
  subjectId: string;
  intended: IntendedObservation;
  expectedObservation?: string | null;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.runId,
        input.recordKey,
        input.subjectId,
        input.intended.kind,
        intendedPayload(input.intended),
        input.expectedObservation ?? null,
      ]),
    )
    .digest('hex');
}

export function nativeReason(reason: ObservationReason): string {
  switch (reason) {
    case 'equal-date-correction':
      return 'Equal-date observation differs from the retained head and needs expectedObservation.';
    case 'record-rebinding':
      return 'A different source record occupies this provider slot and needs expectedObservation.';
    case 'alias-rebinding':
      return 'A different source alias occupies this provider slot and needs expectedObservation.';
    case 'older-date':
      return 'An older observation date cannot override the retained head, including with CAS.';
    case 'cas-mismatch':
      return 'The reviewed expectedObservation no longer matches the current retained head.';
    case 'concurrent-head':
      return 'The retained head changed after inspection; a fresh decision is required.';
  }
}

export function safeObservationSummary(input: {
  operationId: string;
  recordKey: string;
  subjectId: string;
  provider: typeof SOURCE_OBSERVATION_PROVIDER;
  sourceAlias: string;
  intended: IntendedObservation;
  head: RetainedObservationHead | null;
  reason?: ObservationReason;
  status: AggregateOperationStatus;
}): Record<string, unknown> {
  return {
    operationId: input.operationId,
    recordKey: input.recordKey,
    subjectId: input.subjectId,
    provider: input.provider,
    sourceAlias: input.sourceAlias,
    sourceRecordId: input.intended.sourceRecordId,
    date: input.intended.asOf,
    clear: input.intended.kind === 'clear',
    ...(input.intended.kind === 'write'
      ? { count: input.intended.count, scale: input.intended.scale, mean: input.intended.mean }
      : { count: 0 }),
    head: input.head
      ? {
          sourceAlias: input.head.sourceAlias,
          sourceRecordId: input.head.sourceRecordId,
          date: input.head.asOf,
          count: input.head.count,
          cleared: input.head.cleared,
          digest: input.head.digest,
          ...(input.head.scale === undefined ? {} : { scale: input.head.scale }),
          ...(input.head.mean === undefined ? {} : { mean: input.head.mean }),
        }
      : null,
    status: input.status,
    ...(input.reason === undefined ? {} : { reason: input.reason, nativeReason: nativeReason(input.reason) }),
    note: 'A source figure is independent of a REZICS vote.',
  };
}

export function headFromStatistic(
  subjectId: string,
  row: {
    source: string;
    sourceAlias?: string;
    sourceRecordId: string;
    asOf: string;
    count: number;
    scale: { min: number; max: number };
    mean: number;
    licence?: string;
    attribution?: string;
    observation?: { kind: 'unversioned'; digest: string };
  },
): RetainedObservationHead {
  const sourceAlias = row.sourceAlias ?? row.source;
  const digest =
    row.observation?.digest ??
    observationDigest(subjectId, {
      ...(row.sourceAlias === undefined ? {} : { sourceAlias: row.sourceAlias }),
      sourceRecordId: row.sourceRecordId,
      scale: row.scale,
      mean: row.mean,
      count: row.count,
      asOf: row.asOf,
      licence: row.licence ?? 'ODbL-1.0',
      attribution: row.attribution ?? 'VNDB',
    });
  return {
    provider: SOURCE_OBSERVATION_PROVIDER,
    sourceAlias,
    sourceRecordId: row.sourceRecordId,
    asOf: row.asOf,
    count: row.count,
    scale: row.scale,
    mean: row.mean,
    cleared: false,
    digest,
  };
}

export function headFromClear(subjectId: string, value: IntendedClear): RetainedObservationHead {
  return {
    provider: SOURCE_OBSERVATION_PROVIDER,
    sourceAlias: effectiveAlias(value.sourceAlias),
    sourceRecordId: value.sourceRecordId,
    asOf: value.asOf,
    count: 0,
    cleared: true,
    digest: observationDigest(subjectId, value),
  };
}

export const UNRESOLVED_AGGREGATE_STATUSES = ['prepared', 'uncertain', 'conflict', 'refused'] as const;

const REASONS: readonly ObservationReason[] = [
  'equal-date-correction',
  'record-rebinding',
  'alias-rebinding',
  'older-date',
  'cas-mismatch',
  'concurrent-head',
];

export function parseObservationReason(value: string | null | undefined): ObservationReason | undefined {
  return value && (REASONS as readonly string[]).includes(value) ? (value as ObservationReason) : undefined;
}
