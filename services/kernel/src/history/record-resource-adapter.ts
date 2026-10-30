import type { Pool } from 'pg';
import { partitionOf, routeOf } from '../route/route.ts';
import {
  prepareRecordPurgeAuthority,
  type RecordPurgeAuthority,
  type RecordPurgeReference,
} from '../semantic/record-purge-authority.ts';
import { recordHistorySourceKey, type RecordHistorySourceReference } from './record-source.ts';

/** Adapter input only. Semantic has not yet extended its native opaque authority to resources. */
export type ResourceRecordPurgeReference =
  | Readonly<{ kind: 'context'; contextId: string; deletionGeneration: string }>
  | Readonly<{ kind: 'zone'; zoneId: string; deletionGeneration: string }>;
export type NativeRecordPurgeReference = RecordPurgeReference | ResourceRecordPurgeReference;

export type RecordHistoryPurgeLocator = Readonly<{
  source_key: string;
  partition_no: number;
  deletion_generation: string;
  reference_kind: 'contribution' | 'context' | 'zone';
  resource_id: string | null;
  subject_id: string | null;
  candidate_id: string | null;
  revision: number | null;
  document_id: string | null;
}>;

export class NativeResourceRecordPurgeUnavailableError extends Error {
  readonly code = 'record_history_native_resource_reference_unavailable';

  constructor(readonly kind: ResourceRecordPurgeReference['kind']) {
    super('record_history_native_resource_reference_unavailable');
    this.name = 'NativeResourceRecordPurgeUnavailableError';
  }
}

/** Original producer identity, without the later deletion generation or contribution placeholders. */
export function recordHistoryPurgeSourceReference(ref: NativeRecordPurgeReference): RecordHistorySourceReference {
  if ('subjectId' in ref)
    return {
      kind: 'contribution',
      subjectId: ref.subjectId,
      candidateId: ref.candidateId,
      revision: ref.revision,
      documentId: ref.documentId,
    };
  return ref.kind === 'context' ? { kind: 'context', contextId: ref.contextId } : { kind: 'zone', zoneId: ref.zoneId };
}

/** Storage is a restart locator, never authority. The typed original anchor determines its home. */
export function recordHistoryPurgeLocator(ref: NativeRecordPurgeReference): RecordHistoryPurgeLocator {
  const original = recordHistoryPurgeSourceReference(ref);
  const key = recordHistorySourceKey(original);
  const id =
    original.kind === 'contribution'
      ? original.subjectId
      : original.kind === 'context'
        ? original.contextId
        : original.zoneId;
  return {
    source_key: key,
    partition_no: partitionOf(routeOf(id)!),
    deletion_generation: ref.deletionGeneration,
    reference_kind: original.kind,
    resource_id: original.kind === 'contribution' ? null : id,
    subject_id: original.kind === 'contribution' ? original.subjectId : null,
    candidate_id: original.kind === 'contribution' ? original.candidateId : null,
    revision: original.kind === 'contribution' ? original.revision : null,
    document_id: original.kind === 'contribution' ? original.documentId : null,
  };
}

export function recordHistoryPurgeRestartReference(row: RecordHistoryPurgeLocator): NativeRecordPurgeReference {
  let ref: NativeRecordPurgeReference;
  if (
    row.reference_kind === 'contribution' &&
    row.resource_id === null &&
    row.subject_id !== null &&
    row.candidate_id !== null &&
    row.revision !== null
  ) {
    ref = {
      subjectId: row.subject_id,
      candidateId: row.candidate_id,
      revision: row.revision,
      documentId: row.document_id,
      deletionGeneration: row.deletion_generation,
    };
  } else if (
    row.resource_id !== null &&
    row.subject_id === null &&
    row.candidate_id === null &&
    row.revision === null &&
    row.document_id === null &&
    (row.reference_kind === 'context' || row.reference_kind === 'zone')
  ) {
    ref =
      row.reference_kind === 'context'
        ? { kind: 'context', contextId: row.resource_id, deletionGeneration: row.deletion_generation }
        : { kind: 'zone', zoneId: row.resource_id, deletionGeneration: row.deletion_generation };
  } else throw new TypeError('Invalid record history purge reference');
  const expected = recordHistoryPurgeLocator(ref);
  if (expected.source_key !== row.source_key || expected.partition_no !== row.partition_no)
    throw new TypeError('Record history purge source key or home does not match its reference');
  return ref;
}

/** Only the real Semantic issuer may reissue authority. No cast widens its accepted references. */
export async function prepareNativeRecordPurgeAuthority(
  deps: Readonly<{ pool: Pool; clock?: () => Date }>,
  ref: NativeRecordPurgeReference,
  context: Readonly<{ deadline: number }>,
): Promise<RecordPurgeAuthority | null> {
  if (!('subjectId' in ref)) throw new NativeResourceRecordPurgeUnavailableError(ref.kind);
  return prepareRecordPurgeAuthority(deps, ref, context);
}
