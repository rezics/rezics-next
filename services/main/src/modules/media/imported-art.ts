import { createHash } from 'node:crypto';
import type { AccessAdmissionRegistry, VerifiedPrincipal } from '../access/admission.ts';
import type { ImmutableObjects } from '../../infrastructure/immutable-objects.ts';
import { SourceCoverEvidenceInvalid, SourceCoverEvidenceUnavailable, type SourceCoverEvidenceVerifier,
  type SourceMediaEvidenceVerifier } from '../source/cover-evidence.ts';
import type { SourceImageRole } from '../source/archive-copy.ts';
import type { MediaStore } from './store.ts';
import { importedArtRole, type ImportedCoverProvenance } from './typed-schema.ts';
import type { MaterialScope, RightsStore, UseEvaluation } from '../rights/store.ts';

export function importedArtMaterial(provenance: ImportedCoverProvenance): MaterialScope {
  return { scopeKind: 'source_record', provider: null, namespace: null,
    sourceRecordId: provenance.source.record.slice(ID.length), contentVariantId: null,
    mediaAsset: null, component: importedArtRole(provenance) };
}
/** Only an exact artwork assessment can authorize v2 public delivery. Unknown
 * remains unknown, and database/service terms cannot license the image. */
export function importedArtDeliveryEligible(provenance: ImportedCoverProvenance, evaluation: UseEvaluation): boolean {
  return evaluation.status === 'assessed' && evaluation.assessment.expressionKind === 'media'
    && evaluation.assessment.outcome === 'supported'
    && ['license', 'permission', 'public_domain', 'statutory_exception'].includes(evaluation.assessment.basis)
    && evaluation.assessment.extent.originalDigest === provenance.originalDigest
    && evaluation.assessment.extent.observationDigest === provenance.source.observationDigest
    && evaluation.assessment.extent.fieldLocator === provenance.source.fieldLocator;
}

/** Source registry input. variant is the API-returned Content Asset variant;
 * a catalogue MainVersion or a guessed variant cannot acknowledge this Use. */
export interface ImportedArtNativeBasis {
  kind: 'media-use'; target: string; component: string; revision: string; receipt: string;
  variant: string; role: SourceImageRole; context: string; representation?: string;
}
export interface ImportedArtSelectedValue { value: unknown; language: string | null }
export type ImportedArtVerification =
  | { status: 'verified'; receipt: string; revision: string; native: ImportedArtNativeBasis;
      headGuarantee: 'verified-before-commit'; originalDigest: string; representationDigest: string }
  | { status: 'unavailable'; reason: 'owner-unavailable' | 'evidence-unavailable' | 'unsupported-profile' }
  | { status: 'mismatch'; basis: 'native-target' | 'native-value' | 'native-head' };

const NATIVE = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID = 'https://rezics.com/id/';

/** Native acknowledgment and Source witness verification are separate. The
 * registry must also admit retained coordinates, mapping, rights and supports.
 * Legacy cover receipts and revisioned artwork occurrences share the existing
 * Media, Source, Access and Rights owners. */
export class ImportedArtNativeVerifier {
  constructor(private readonly media: Pick<MediaStore, 'readImportedCoverUse'> & Partial<Pick<MediaStore, 'readImportedArtRepresentation'>>,
    private readonly access: Pick<AccessAdmissionRegistry, 'readAcknowledgedOwnerCommand' | 'activePrincipalId'>,
    private readonly source: Pick<SourceCoverEvidenceVerifier, 'verifyCurrent'>,
    private readonly objects: (namespace: string) => ImmutableObjects,
    private readonly art?: { source: Pick<SourceMediaEvidenceVerifier, 'verifyCurrent'>;
      rights: Pick<RightsStore, 'currentMediaDelivery'> }) {}

  async verify(principal: VerifiedPrincipal, native: ImportedArtNativeBasis,
    selected: ImportedArtSelectedValue): Promise<ImportedArtVerification> {
    if (native.kind !== 'media-use' || ![native.target, native.component].every(value => NATIVE.test(value))) {
      return { status: 'mismatch', basis: 'native-target' };
    }
    if (!NATIVE.test(native.revision)) return { status: 'mismatch', basis: 'native-head' };
    try {
      const principalId = await this.access.activePrincipalId(principal);
      if (!principalId) return { status: 'unavailable', reason: 'owner-unavailable' };
      const row = await this.media.readImportedCoverUse(native.component.slice(ID.length));
      if (!row) return { status: 'unavailable', reason: 'evidence-unavailable' };
      if (row.provenance.format === 'media-imported-cover-v1' && (native.role !== 'cover' || row.provenance.source.provider === 'vndb'))
        return { status: 'unavailable', reason: 'unsupported-profile' };
      const receipt = await this.access.readAcknowledgedOwnerCommand(principal, native.receipt);
      if (!receipt) return { status: 'unavailable', reason: 'evidence-unavailable' };
      if (row.target !== native.target || row.use !== native.component || row.context !== native.context
        || row.variant !== native.variant || row.provenance.targetWork !== native.target || importedArtRole(row.provenance) !== native.role
        || receipt.action !== 'media.avatar' || receipt.scope !== `media:avatar:${row.target}`
        || receipt.actingSubject !== row.actor || row.operationId !== `${row.role === 'avatar' ? 'media-avatar' : 'media-art'}:${receipt.admissionId}`) {
        return { status: 'mismatch', basis: 'native-target' };
      }
      if (receipt.requestDigest !== row.requestDigest || receipt.dataEpoch !== row.dataEpoch
        || receipt.sequence !== row.sequence || row.selection !== native.revision || row.currentHead !== row.selection) {
        return { status: 'mismatch', basis: 'native-head' };
      }
      if (selected.value !== row.provenance.image.captureUrl || selected.language !== null) {
        return { status: 'mismatch', basis: 'native-value' };
      }
      const verifySource = async () => {
        if (row.provenance.format === 'media-imported-cover-v1') return this.source.verifyCurrent(principalId, row.provenance);
        if (!this.art) throw new SourceCoverEvidenceUnavailable('revisioned artwork owners are unavailable');
        await this.art.source.verifyCurrent(principal, row.provenance);
        if (!importedArtDeliveryEligible(row.provenance, await this.art.rights.currentMediaDelivery(importedArtMaterial(row.provenance))))
          throw new SourceCoverEvidenceUnavailable('artwork delivery rights are unavailable');
      };
      await verifySource();
      const bytes = await this.objects(row.objectNamespace).get(row.original.sha256, row.original.byteLength);
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (bytes.length !== row.original.byteLength || digest !== row.original.sha256
        || digest !== row.provenance.originalDigest || digest !== row.provenance.image.captureDigest) {
        return { status: 'unavailable', reason: 'evidence-unavailable' };
      }
      let representationDigest = digest;
      let delivered: Awaited<ReturnType<MediaStore['readImportedArtRepresentation']>> = null;
      if (native.representation !== undefined) {
        delivered = await this.media.readImportedArtRepresentation?.(native.component.slice(ID.length), native.representation) ?? null;
        if (!delivered) return { status: 'mismatch', basis: 'native-value' };
        const representation = await this.objects(delivered.objectNamespace).get(delivered.sha256, delivered.byteLength);
        representationDigest = createHash('sha256').update(representation).digest('hex');
        if (representation.length !== delivered.byteLength || representationDigest !== delivered.sha256)
          return { status: 'unavailable', reason: 'evidence-unavailable' };
      }
      await verifySource();
      if (delivered && JSON.stringify(delivered) !== JSON.stringify(await this.media.readImportedArtRepresentation!(native.component.slice(ID.length), native.representation!)))
        return { status: 'mismatch', basis: 'native-head' };
      const current = await this.media.readImportedCoverUse(native.component.slice(ID.length));
      const currentReceipt = await this.access.readAcknowledgedOwnerCommand(principal, native.receipt);
      if (await this.access.activePrincipalId(principal) !== principalId || !currentReceipt
        || JSON.stringify(receipt) !== JSON.stringify(currentReceipt)) return { status: 'unavailable', reason: 'owner-unavailable' };
      if (!current) return { status: 'unavailable', reason: 'evidence-unavailable' };
      if (JSON.stringify(row) !== JSON.stringify(current)) return { status: 'mismatch', basis: 'native-head' };
      return { status: 'verified', receipt: receipt.receipt, revision: row.selection,
        native: { kind: 'media-use', target: row.target, component: row.use, revision: row.selection,
          receipt: receipt.receipt, variant: row.variant, role: importedArtRole(row.provenance), context: row.context,
          ...(native.representation !== undefined ? { representation: native.representation } : {}) },
        headGuarantee: 'verified-before-commit', originalDigest: row.provenance.originalDigest,
        representationDigest };
    } catch (error) {
      return { status: 'unavailable', reason: error instanceof SourceCoverEvidenceInvalid
        || error instanceof SourceCoverEvidenceUnavailable ? 'evidence-unavailable' : 'owner-unavailable' };
    }
  }
}
