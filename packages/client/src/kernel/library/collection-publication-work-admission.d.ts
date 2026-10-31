/** SERVER ONLY. Original Library whole-query publication seam, distinct from Members and Kind. */
import type { FilterDocument, FilterRelease } from '@rezics/filter';
import type { OperationalTransaction } from '../command/operational.ts';
import type { IdentityNativeReceipt } from '../semantic/identity-epoch-contract.ts';
import type { IdentityScopeObservation } from '../semantic/identity-scope-types.ts';
import type { CollectionPublicationCreation, CollectionPublicationInputRef, CollectionPublicationPhase, CollectionPublicationRuleRef, CollectionPublicationTargetRef } from './collection-publication-episode-contract.ts';
import type { CollectionSourceObservation } from './collection-source.ts';
import type { NativeSourceCustody, NativeSourceIdentity } from './native-source-custody.ts';
/** Exact native lookup fields only. Possession grants neither admission nor final command authority. */
export type CollectionPublicationLocator = Readonly<{
    route: number;
    ownerAccountId: string;
    collectionId: string;
    publicationId: string;
}>;
/** Actual expanded, pinned whole-query meaning read from native state, never request JSON.
 * This transient result is not a second retained AST on an episode or work payload.
 */
export type CollectionPublicationDefinition = Readonly<{
    filter: FilterDocument;
    sort: 'id';
    release: Readonly<{
        digest: string;
        value: FilterRelease;
    }>;
}>;
/** Data on the SAME live Core client after independent native admission, not a completion receipt.
 * input and target MUST name the SAME actual Collection explicitly; input remains private working
 * Source even while target serves selected A. output names pending native B, never a borrowed A.
 * Compare the WHOLE result again after foreign staging and before settling progress.
 */
export type CollectionPublicationWorkDefinition = Readonly<{
    locator: CollectionPublicationLocator;
    definition: CollectionPublicationDefinition;
    input: CollectionPublicationInputRef;
    target: CollectionPublicationTargetRef;
    rule: CollectionPublicationRuleRef;
    creation: CollectionPublicationCreation;
    sourceIdentity: NativeSourceIdentity;
    observation: CollectionSourceObservation;
    identityObservation: IdentityScopeObservation;
    repairReceipt: IdentityNativeReceipt;
    custody: NativeSourceCustody;
    releaseDigest: string;
    audience: string;
}> & Extract<CollectionPublicationPhase, {
    phase: 'staging' | 'awaiting_activation';
}>;
/** TEMPORARY UNAVAILABLE CONTRACT ADAPTER. The later native episode producer must replace it.
 * On each use, verify the genuine live work-step transaction, exact pool/owner/namespace and T,
 * committed original operation/receipt, phase/rule/source/identity/receiving/custody/output fences.
 * Admission permits bounded own-namespace mechanical staging only; never disclosure or activation.
 */
export declare function admitCollectionPublicationStep(_tx: OperationalTransaction, _locator: CollectionPublicationLocator): Promise<boolean>;
/** TEMPORARY UNAVAILABLE CONTRACT ADAPTER. Getter data alone is never admission or completion.
 * Native implementation must use the admitted SAME client; absent/changed evidence returns null
 * or unavailability, never ready-empty. Full-query exhaustion uses the shared Source/compiler and
 * existing WorkAllowance, never a selected 0..100 set, first page, or count as a complete query.
 */
export declare function readCollectionPublicationWorkDefinition(_tx: OperationalTransaction, _locator: CollectionPublicationLocator): Promise<CollectionPublicationWorkDefinition | null>;
