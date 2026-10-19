import type { DatasetRecord } from '../../../../../scripts/datasets/types.ts';
import type { SemanticProperty } from '../semantic/change.ts';
import type { AcknowledgedSemanticBasis, VerifiedSemanticBasis } from '../semantic/native-basis.ts';
import type { ReleaseSourceNativeBasis, RealizationSourceNativeBasis } from './release-native-verifier.ts';

/** Private Source refusals. Check evidence custody and reuse before disclosing a basis. */
export class SourceFieldProblem extends Error {
  constructor(readonly status: 403 | 404 | 409 | 422 | 503, readonly code: string,
    message: string, readonly basis?: string) { super(message); }
}
export const conversionChanged = (basis: string): never => {
  throw new SourceFieldProblem(409, 'source_conversion_changed', 'Retained conversion basis changed', basis);
};
export const supportChanged = (basis: string): never => {
  throw new SourceFieldProblem(409, 'source_support_changed', 'Source support basis changed', basis);
};
export const coordinateInvalid = (): never => {
  throw new SourceFieldProblem(422, 'source_coordinate_invalid', 'Source coordinate is invalid');
};
export const mappingUnverified = (): never => {
  throw new SourceFieldProblem(422, 'source_mapping_unverified', 'Source mapping has no verified adapter');
};
export const supportUnavailable = (): never => {
  throw new SourceFieldProblem(503, 'source_support_unavailable', 'Source support evidence is unavailable');
};
export const sourceNotFound = (): never => {
  throw new SourceFieldProblem(404, 'source_support_unavailable', 'Source evidence is unavailable');
};

export interface RetainedIntake { index: number; record: string; observation: string; byteDigest: string; }
export interface RetainedRecordInput {
  identity: { key: string; provider: string; namespace: string; externalId: string };
  snapshot: { id: string; digest: string; fileSha256: string };
  record: DatasetRecord; recordDigest: string; intakes: RetainedIntake[];
  payload: { format: 'json' | 'rezics-dataset-chunk-v1'; byteDigest: string; byteLength: number };
}
export interface RetainedConversionRequest {
  profile: 'source-retained-record-conversion-v1'; mappingRevision: string; retained: RetainedRecordInput;
}
export interface RetainedRecordBinding extends Omit<RetainedRecordInput, 'record'> {
  profile: 'source-retained-record-binding-v1'; binding: string; sourceRecord: string;
  conversion: string; mappingRevision: string; normalizationRevision: string;
}
export type SuppliedLanguage = { state: 'omitted' } | { state: 'null' } | { state: 'value'; value: string };
export interface RetainedFieldCoordinate {
  pointer: string;
  presence: 'value' | 'omitted' | 'null' | 'empty-string' | 'empty-array' | 'empty-object';
  valueDigest?: string; language?: string | null; ordinal?: number;
}
export type AcknowledgedNativeBasis = ReleaseSourceNativeBasis | RealizationSourceNativeBasis
  | AcknowledgedSemanticBasis | {
  kind: 'component-property'; owner: 'work-editorial'; target: string; component: string;
  revision: string; receipt: string; field: 'synopsis'; property: SemanticProperty;
  language: SuppliedLanguage;
};
export interface RetainedSupportRequest {
  profile: 'source-field-support-attachment-v2'; target: string; slot: string;
  occurrence: string | null; context: string; sourceRecord: string; conversion: string;
  grain: string; sourceField: string; sourceOccurrence: string | null; expectedHead: string;
  actingSubject: string;
  evidence: { binding: string; recordDigest: string; mappingRevision: string; field: RetainedFieldCoordinate };
  native: AcknowledgedNativeBasis;
}
export interface RetainedSupportAdmission {
  profile: 'source-field-support-admission-v1'; sourceRecord: string; conversion: string;
  evidence: RetainedSupportRequest['evidence'];
  correspondence: { normalizationRevision: string; rule: string; payloadPointers: string[]; selectedValueDigest: string };
  native: AcknowledgedNativeBasis; headGuarantee: 'transaction-guarded' | 'verified-before-commit';
}
export interface FieldAttachmentCertificate {
  profile: 'source-field-attachment-certificate-v1'; receipt: string; requestDigest: string; nativeReceipt: string;
}
/** The native owner resolves these from its actual terminal command and current
 * state. In particular, editorial Work/control/protection heads are not the
 * content revision named by expectedHead. */
export interface VerifiedNativeAcknowledgement {
  receipt: string; admissionId: string; dataEpoch: string; sequence: string;
  scope: string; action: 'semantic.change' | 'statement.record' | 'work.edit';
  component: string; revision: string;
  semantic?: Pick<VerifiedSemanticBasis, 'operation' | 'manifest' | 'modelGeneration' | 'headGuarantee'>;
  editorial?: { workHead: string; controlHead: string; controlEpoch: string; protectionHead: string | null };
  release?: { currentHeads: { release: string; realization: string };
    correspondence: { work: string; release: ReleaseSourceNativeBasis['coverage']['realization'];
      realization: ReleaseSourceNativeBasis['coverage']['realization'];
      completeness: ReleaseSourceNativeBasis['coverage']['completeness']; language: string } };
}
