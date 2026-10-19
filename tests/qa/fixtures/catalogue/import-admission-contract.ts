import type { DatasetRecord } from '../../../../scripts/datasets/types.ts';
import type { SemanticProperty } from '../../../../services/main/src/modules/semantic/change.ts';
import type { StatementValue } from '../../../../services/main/src/modules/statement/schema.ts';

/** Pending test proposals through existing Source and native owners. These types
 * neither register mapping adapters nor certify any successful product command. */
export interface RetainedIntake {
  index: number;
  record: string;
  observation: string;
  byteDigest: string;
}
export interface RetainedRecordInput {
  identity: { key: string; provider: string; namespace: string; externalId: string };
  snapshot: { id: string; digest: string; fileSha256: string };
  record: DatasetRecord;
  recordDigest: string;
  intakes: RetainedIntake[];
  payload: { format: 'json' | 'rezics-dataset-chunk-v1'; byteDigest: string; byteLength: number };
}
export interface RetainedConversionRequest {
  profile: 'source-retained-record-conversion-v1';
  /** A Source-registered adapter must verify the entire normalized record,
   * including fields outside data, against these bytes and source coordinates. */
  mappingRevision: string;
  retained: RetainedRecordInput;
}
export interface RetainedRecordBinding extends Omit<RetainedRecordInput, 'record'> {
  profile: 'source-retained-record-binding-v1';
  binding: string;
  sourceRecord: string;
  conversion: string;
  mappingRevision: string;
  normalizationRevision: string;
}
export interface RetainedFieldCoordinate {
  /** Full normalized DatasetRecord, never an observation JSON pointer. */
  pointer: string;
  /** Same six source states as the pure field plan; local protocol types keep
   * the test overlay independent of a later product adapter implementation. */
  presence: 'value' | 'omitted' | 'null' | 'empty-string' | 'empty-array' | 'empty-object';
  /** canonicalJson of the whole pointed value; absent only for omitted. An
   * alias ordinal selects a line without changing its parent-string digest. */
  valueDigest?: string;
  language?: string | null;
  ordinal?: number;
}
/** Reuse native codecs. Component properties have no fabricated Statement ID
 * or acceptance. The native owner verifies these exact values at its own head. */
export type NativeFieldBasis =
  | { kind: 'component-property'; target: string; revision: string; property: SemanticProperty }
  | { kind: 'statement'; target: string; revision: string; statement: string; predicate: string;
      value: StatementValue; context: string;
      qualifiers: { applicability: string[]; interpretationDefinitions: string[];
        qualification?: Record<string, unknown> };
      acceptance: { context: string; decision: string; source: string } | null };
export interface RetainedSupportRequest {
  profile: 'source-field-support-attachment-v2';
  target: string;
  slot: string;
  occurrence: string | null;
  context: string;
  sourceRecord: string;
  conversion: string;
  grain: string;
  sourceField: string;
  sourceOccurrence: string | null;
  expectedHead: string;
  actingSubject: string;
  evidence: { binding: string; recordDigest: string; mappingRevision: string;
    field: RetainedFieldCoordinate };
  native: NativeFieldBasis;
}
export interface RetainedSupportAdmission {
  profile: 'source-field-support-admission-v1';
  sourceRecord: string;
  conversion: string;
  evidence: RetainedSupportRequest['evidence'];
  correspondence: { normalizationRevision: string; rule: string;
    /** RFC 6901 in the actual single JSON or reconstructed payload. Never a
     * pointer into a chunk envelope masquerading as a provider document. */
    payloadPointers: string[]; selectedValueDigest: string };
  native: NativeFieldBasis;
  /** Truthful existing owner guarantee, not a stronger invented transaction. */
  headGuarantee: 'transaction-guarded' | 'verified-before-commit';
}
export const retainedAdmissionCases = [
  'vndb:vn:v11',
  'bangumi:subject:1014',
  'musicbrainz:artist:24f1766e-9635-4d58-a4d4-9413f9f98a4c',
  'musicbrainz:release:2ab08baa-b1c6-4aca-8cf7-c31565ef71b4',
] as const;

/** Granular basis is a proposed addition to the existing conflict codes. All
 * refusal responses are principal-private and must leave support/native state
 * unchanged. Inaccessible evidence still uses indistinguishable 404 first. */
export const admissionRefusals = {
  conversion: { status: 409, code: 'source_conversion_changed',
    bases: ['record', 'record-digest', 'byte-digest', 'part-order'] },
  support: { status: 409, code: 'source_support_changed',
    bases: ['record', 'record-digest', 'conversion', 'value-digest',
      'native-target', 'native-value', 'native-head'] },
  unverified: { status: 422, code: 'source_mapping_unverified' },
  coordinate: { status: 422, code: 'source_coordinate_invalid' },
} as const;
