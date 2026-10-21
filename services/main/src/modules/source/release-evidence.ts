import type { Pool } from 'pg';
import { contentConnection } from '../../../../content/src/connection.ts';
import { canonicalJson } from '../../../../../scripts/lib/canonical-json.ts';
import { readReleaseRealizationCorrespondence, releaseSourceProperty } from '../release/source-verifier.ts';
import { realizationSourceProperty } from '../realization/source-verifier.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import type { SourceRetainedRecordStore } from './retained-record.ts';
import type { SourceRetainedRecordEvidenceOwner } from './retained-evidence.ts';
import type { FieldAttachmentCertificate, RetainedSupportAdmission, RetainedSupportRequest,
  VerifiedNativeAcknowledgement } from './field-support-contract.ts';
import { verifyRetainedField } from './field-support-evidence.ts';
import { suppliedLanguage } from './field-control-language.ts';
import { retainedAttachmentDigest } from './field-support-retained.ts';
import { sourceId } from './retained-record-normalization.ts';
import { releaseNativeValueMatches } from './release-native-verifier.ts';
import type { ReleaseNativeCommandBasis } from './release-native-verifier.ts';
import { RELEASE_EVIDENCE_COST, type ReleaseSourceEvidence } from './release-evidence-contract.ts';

export interface ReleaseEvidenceSelection {
  owner: 'release' | 'realization';
  component: string;
  revision: string;
}
interface SavedReleaseEvidence {
  principal_id: string;
  support_id: string;
  step_id: string;
  request: RetainedSupportRequest;
  request_digest: string;
  retained_admission: RetainedSupportAdmission;
  native_acknowledgement: VerifiedNativeAcknowledgement;
  certificate: FieldAttachmentCertificate;
  attachment_receipt: string;
}

const commandBasis = (basis: ReleaseNativeCommandBasis): ReleaseNativeCommandBasis => ({
  component: basis.component,revision: basis.revision,receipt: basis.receipt,expectedHead: basis.expectedHead,
});

/** The existing settled support is optional evidence, never an admission condition
 * on a native read or a manual citation. This path reads persisted custody and
 * field correspondence; it does not call a converter or rerun a mapper. */
export class SourceReleaseEvidenceOwner {
  constructor(private readonly pool: Pool,
    private readonly records: Pick<SourceRetainedRecordStore, 'evidence'>,
    private readonly publicEvidence: Pick<SourceRetainedRecordEvidenceOwner, 'projectPublicRetainedFieldForReader'>,
    private readonly native = readReleaseRealizationCorrespondence) {}

  async read(session: WorkReadSession, selection: ReleaseEvidenceSelection): Promise<ReleaseSourceEvidence[]> {
    return session.selection(`source-release-evidence:${canonicalJson(selection)}`,
      probe => this.project(probe, selection));
  }

  private async project(session: WorkReadSession, selection: ReleaseEvidenceSelection): Promise<ReleaseSourceEvidence[]> {
    // The native acknowledgement index bounds selection by the exact component
    // and revision before reading retained records. Withdrawn or unsettled steps
    // never enter the public projection. No private support cursor is exposed.
    const rows = (await contentConnection(this.pool).query<SavedReleaseEvidence>(`
      SELECT s.principal_id,s.id AS support_id,st.id AS step_id,a.request,a.request_digest,
        st.retained_admission,st.native_acknowledgement,a.certificate,a.receipt AS attachment_receipt
      FROM source.field_support_step st
      JOIN source.field_support s ON s.id=st.support_id AND s.principal_id=st.principal_id
      JOIN source.field_support_head h ON h.support_id=s.id AND h.settled_step_id=st.id
      JOIN source.field_support_attachment a ON a.step_id=st.id AND a.principal_id=s.principal_id
      WHERE st.native_acknowledgement->>'component'=$1 AND st.native_acknowledgement->>'revision'=$2
        AND st.native_acknowledgement IS NOT NULL
        AND a.request#>>'{native,owner}'=$3 AND s.context='global' AND s.occurrence=$1
        AND NOT EXISTS (SELECT 1 FROM source.field_support_withdrawal w WHERE w.support_id=s.id)
      ORDER BY s.id,st.id LIMIT $4`,
    [selection.component,selection.revision,selection.owner,RELEASE_EVIDENCE_COST.supports + 1])).rows;
    if (rows.length > RELEASE_EVIDENCE_COST.supports) {
      throw new WorkReadUnavailable('Release source evidence exceeds its bounded projection');
    }
    const result = new Map<string, ReleaseSourceEvidence>();
    const proofs = new Map<string, ReturnType<typeof readReleaseRealizationCorrespondence>>();
    for (const row of rows) {
      const input = row.request, admission = row.retained_admission, ack = row.native_acknowledgement;
      const native = input.native;
      if (native.kind !== 'component-property' || native.owner !== selection.owner
        || (native.owner !== 'release' && native.owner !== 'realization')
        || native.component !== selection.component || native.revision !== selection.revision
        || native.target !== input.target || input.context !== 'global' || input.occurrence !== native.component
        || input.slot !== `component-property-v1#${native.property.predicate}`
        || input.expectedHead !== native.revision || ack.receipt !== native.receipt
        || ack.component !== native.component || ack.revision !== native.revision
        || admission.profile !== 'source-field-support-admission-v1'
        || canonicalJson(admission.native) !== canonicalJson(native)
        || row.certificate.profile !== 'source-field-attachment-certificate-v1'
        || row.certificate.receipt !== row.attachment_receipt
        || row.certificate.nativeReceipt !== native.receipt
        || row.certificate.requestDigest !== row.request_digest
        || retainedAttachmentDigest(row.principal_id,input,admission,ack) !== row.request_digest) {
        throw new WorkReadUnavailable('Release source settlement differs');
      }
      const evidence = await this.records.evidence(row.principal_id,input.conversion);
      if (!evidence) continue;
      let field;
      try { field = await verifyRetainedField(input,evidence); }
      catch { throw new WorkReadUnavailable('Release source correspondence is unavailable'); }
      if (canonicalJson(field.correspondence) !== canonicalJson(admission.correspondence)
        || admission.sourceRecord !== input.sourceRecord || admission.conversion !== input.conversion
        || canonicalJson(admission.evidence) !== canonicalJson(input.evidence)) {
        throw new WorkReadUnavailable('Release source correspondence differs');
      }
      const pair = native.owner === 'release'
        ? { target: native.target,release: commandBasis(native),realization: commandBasis(native.coverage.realization),
          completeness: native.coverage.completeness }
        : { target: native.target,release: commandBasis(native.release),realization: commandBasis(native),completeness: native.completeness };
      const key = canonicalJson(pair);
      let pending = proofs.get(key);
      if (!pending) {
        pending = this.native(session.deps.environment,{ ...pair,principal: session.principal });
        proofs.set(key,pending);
      }
      const proof = await pending;
      if (proof.status !== 'available') continue;
      const actual = native.owner === 'release'
        ? releaseSourceProperty(native,proof.release.record,proof.realization.record)
        : realizationSourceProperty(native,proof.realization.record);
      if (!releaseNativeValueMatches(native.property,{ value: native.property.value,
        ...(Object.hasOwn(input.evidence.field,'language') ? { language: input.evidence.field.language } : {}) },actual)) continue;
      const receipt = native.owner === 'release' ? proof.release.receipt : proof.realization.receipt;
      if (receipt.receipt !== ack.receipt || receipt.admissionId !== ack.admissionId
        || receipt.dataEpoch !== ack.dataEpoch || receipt.sequence !== ack.sequence || receipt.scope !== ack.scope) continue;
      if (field.correspondence.payloadPointers.length !== 1) continue;
      const disclosed = await this.publicEvidence.projectPublicRetainedFieldForReader(
        { principal: session.principal },evidence,field.correspondence.payloadPointers[0]!,
        suppliedLanguage(input.evidence.field));
      if (!disclosed) continue;
      const binding = evidence.conversion.retainedRecord;
      // A retained conversion has its own original provider record. Its anchor
      // observation may retain a dataset envelope/part; keep the actual saved
      // anchor rather than inventing an observation on that original record.
      const anchor = binding.intakes[0];
      const observation = anchor && evidence.observations.find(item => item.record === anchor.record
        && item.observation === anchor.observation && item.byteDigest === anchor.byteDigest);
      if (!observation || disclosed.id !== binding.sourceRecord
        || binding.identity.provider !== observation.provider) continue;
      const reference: ReleaseSourceEvidence = {
        provider: binding.identity.provider,namespace: binding.identity.namespace,externalId: binding.identity.externalId,
        // DatasetRecord has no acknowledged provider revision. Its intake uses
        // the dataset snapshot digest, which is not a provider revision.
        sourceRevision: null,datasetSnapshotDigest: binding.snapshot.digest,
        recordDigest: binding.recordDigest,fieldLocator: input.evidence.field.pointer,
        record: binding.sourceRecord,observation: observation.observation,href: disclosed.attribution.sourceUrl,
      };
      // Independent supports remain in their owner. Equal public coordinates do
      // not expose the number or private identities of their custodians.
      result.set(canonicalJson(reference),reference);
    }
    return [...result.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([,reference]) => reference);
  }
}

export async function releaseSourceEvidence(session: WorkReadSession,
  selection: ReleaseEvidenceSelection): Promise<ReleaseSourceEvidence[]> {
  if (!sourceId(selection.component) || !sourceId(selection.revision)) {
    throw new WorkReadUnavailable('Release source selection is invalid');
  }
  return session.deps.sourceReleaseEvidence?.read(session,selection) ?? [];
}
