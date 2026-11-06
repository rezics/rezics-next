/** SERVER ONLY. Original Library whole-query publication seam, distinct from Members and Kind. */
import type { FilterDocument, FilterRelease } from '@rezics/filter';
import { type OperationalTransaction } from '../command/operational.ts';
import type { CollectionRuleSource } from './collection-rules.ts';
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
    /** The stored Source selects the population: the owner's private Library, or Search's public catalogue. */
    source: CollectionRuleSource;
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
/** Preparation may advance only an original committed episode, before any private Source IO. */
export declare function admitCollectionPublicationSourcePreparation(tx: OperationalTransaction, locator: CollectionPublicationLocator): Promise<boolean>;
/** Getter data alone is never admission or completion. Recheck the SAME native client on each use.
 * Missing original provenance is unavailable, never ready-empty. Source initialization cannot
 * start from a bare locator while its owning episode reader is absent.
 */
export declare function readCollectionPublicationWorkDefinition(tx: OperationalTransaction, locator: CollectionPublicationLocator): Promise<CollectionPublicationWorkDefinition | null>;
/** Mechanical admission only. The result is never viewer permission or final activation authority. */
export declare function admitCollectionPublicationStep(tx: OperationalTransaction, locator: CollectionPublicationLocator): Promise<boolean>;
