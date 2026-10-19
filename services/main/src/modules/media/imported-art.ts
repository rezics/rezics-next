import { createHash } from 'node:crypto';
import type { AccessAdmissionRegistry, VerifiedPrincipal } from '../access/admission.ts';
import type { ImmutableObjects } from '../../infrastructure/immutable-objects.ts';
import { SourceCoverEvidenceInvalid, SourceCoverEvidenceUnavailable, type SourceCoverEvidenceVerifier } from '../source/cover-evidence.ts';
import type { SourceImageRole } from '../source/archive-copy.ts';
import type { MediaStore } from './store.ts';

/** Source registry input. variant is the API-returned Content Asset variant;
 * a catalogue MainVersion or a guessed variant cannot acknowledge this Use. */
export interface ImportedArtNativeBasis {
  kind: 'media-use'; target: string; component: string; revision: string; receipt: string;
  variant: string; role: SourceImageRole; context: string;
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
 * This compatible reader verifies existing acknowledged Work-cover Uses. New
 * portrait/screenshot custody remains unavailable until its owner writes it. */
export class ImportedArtNativeVerifier {
  constructor(private readonly media: Pick<MediaStore, 'readImportedCoverUse'>,
    private readonly access: Pick<AccessAdmissionRegistry, 'readAcknowledgedOwnerCommand' | 'activePrincipalId'>,
    private readonly source: Pick<SourceCoverEvidenceVerifier, 'verifyCurrent'>,
    private readonly objects: (namespace: string) => ImmutableObjects) {}

  async verify(principal: VerifiedPrincipal, native: ImportedArtNativeBasis,
    selected: ImportedArtSelectedValue): Promise<ImportedArtVerification> {
    if (native.kind !== 'media-use' || ![native.target, native.component].every(value => NATIVE.test(value))) {
      return { status: 'mismatch', basis: 'native-target' };
    }
    if (!NATIVE.test(native.revision)) return { status: 'mismatch', basis: 'native-head' };
    if (native.role !== 'cover') return { status: 'unavailable', reason: 'unsupported-profile' };
    try {
      const principalId = await this.access.activePrincipalId(principal);
      if (!principalId) return { status: 'unavailable', reason: 'owner-unavailable' };
      const row = await this.media.readImportedCoverUse(native.component.slice(ID.length));
      if (!row) return { status: 'unavailable', reason: 'evidence-unavailable' };
      const receipt = await this.access.readAcknowledgedOwnerCommand(principal, native.receipt);
      if (!receipt) return { status: 'unavailable', reason: 'evidence-unavailable' };
      if (row.target !== native.target || row.use !== native.component || row.context !== native.context
        || row.variant !== native.variant || row.provenance.targetWork !== native.target
        || receipt.action !== 'media.avatar' || receipt.scope !== `media:avatar:${row.target}`
        || receipt.actingSubject !== row.actor || row.operationId !== `media-avatar:${receipt.admissionId}`) {
        return { status: 'mismatch', basis: 'native-target' };
      }
      if (receipt.requestDigest !== row.requestDigest || receipt.dataEpoch !== row.dataEpoch
        || receipt.sequence !== row.sequence || row.selection !== native.revision || row.currentHead !== row.selection) {
        return { status: 'mismatch', basis: 'native-head' };
      }
      if (selected.value !== row.provenance.image.captureUrl || selected.language !== null) {
        return { status: 'mismatch', basis: 'native-value' };
      }
      await this.source.verifyCurrent(principalId, row.provenance);
      // No legacy JSON descriptor proves original VNDB archive custody. The
      // archive/COPY owner must admit that witness through the revisioned path.
      if (row.provenance.source.provider === 'vndb') return { status: 'unavailable', reason: 'unsupported-profile' };
      const bytes = await this.objects(row.objectNamespace).get(row.original.sha256, row.original.byteLength);
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (bytes.length !== row.original.byteLength || digest !== row.original.sha256
        || digest !== row.provenance.originalDigest || digest !== row.provenance.image.captureDigest) {
        return { status: 'unavailable', reason: 'evidence-unavailable' };
      }
      await this.source.verifyCurrent(principalId, row.provenance);
      const current = await this.media.readImportedCoverUse(native.component.slice(ID.length));
      const currentReceipt = await this.access.readAcknowledgedOwnerCommand(principal, native.receipt);
      if (await this.access.activePrincipalId(principal) !== principalId || !currentReceipt
        || JSON.stringify(receipt) !== JSON.stringify(currentReceipt)) return { status: 'unavailable', reason: 'owner-unavailable' };
      if (!current) return { status: 'unavailable', reason: 'evidence-unavailable' };
      if (JSON.stringify(row) !== JSON.stringify(current)) return { status: 'mismatch', basis: 'native-head' };
      return { status: 'verified', receipt: receipt.receipt, revision: row.selection,
        native: { kind: 'media-use', target: row.target, component: row.use, revision: row.selection,
          receipt: receipt.receipt, variant: row.variant, role: 'cover', context: row.context },
        headGuarantee: 'verified-before-commit', originalDigest: row.provenance.originalDigest,
        representationDigest: digest };
    } catch (error) {
      return { status: 'unavailable', reason: error instanceof SourceCoverEvidenceInvalid
        || error instanceof SourceCoverEvidenceUnavailable ? 'evidence-unavailable' : 'owner-unavailable' };
    }
  }
}
