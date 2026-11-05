import type { OperationalTransaction } from '../command/operational.ts';
import type { IdentityNativeReceipt } from '../semantic/identity-epoch-contract.ts';
import type { IdentityScopeObservation } from '../semantic/identity-scope-types.ts';
import type { WorkDimensions, CollectionSourceObservation } from './collection-source.ts';
import { NativeCollectionWork } from './collection-source-work.ts';
import { type NativeSourceIdentity, type NativeSourceCustody } from './native-source-custody.ts';
export type CollectionKindPreparationLocator = Readonly<{
    route: number;
    ownerAccountId: string;
    collectionId: string;
    preparationId: string;
}>;
export type CollectionKindWorkDefinition = Readonly<{
    releaseDigest: string;
    audience: string;
    sourceIdentity: NativeSourceIdentity;
    observation: CollectionSourceObservation;
    identityObservation: IdentityScopeObservation;
    repairReceipt: IdentityNativeReceipt;
    custody: NativeSourceCustody;
}>;
/** Bind one native frame to one live Core transaction and one immutable episode. */
export declare function bindCollectionKindPreparationStep(tx: OperationalTransaction, locator: CollectionKindPreparationLocator, work: NativeCollectionWork): void;
/** Pure complete local admission, without a checkout or another reservation. */
export declare function collectionKindInputAdmissionWork(): WorkDimensions;
/** Locks the exact current enrolled episode, committed Source scope and retained custody. */
export declare function admitCollectionKindPreparationStep(tx: OperationalTransaction, locator: CollectionKindPreparationLocator, work: NativeCollectionWork): Promise<boolean>;
/** Reread Source custody; missing independent audience/identity results remain unavailable. */
export declare function readCollectionKindWorkDefinition(tx: OperationalTransaction, locator: CollectionKindPreparationLocator, work: NativeCollectionWork): Promise<CollectionKindWorkDefinition | null>;
/** Pre-Type owner operands only. No repair receipt, release or disclosure closure. */
export declare function currentCollectionKindInputAdmission(tx: OperationalTransaction, locator: CollectionKindPreparationLocator, work: NativeCollectionWork): Readonly<{
    tx: OperationalTransaction;
    locator: CollectionKindPreparationLocator;
    originId: string;
    referenceId: string;
    sourceIdentity: NativeSourceIdentity;
    custody: NativeSourceCustody;
    pool: import("pg").Pool;
    deadline: number;
}> | undefined;
