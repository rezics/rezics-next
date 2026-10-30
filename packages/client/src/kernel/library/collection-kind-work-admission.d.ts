import type { OperationalTransaction } from '../command/operational.ts';
import type { IdentityNativeReceipt } from '../semantic/identity-epoch-contract.ts';
import type { IdentityScopeObservation } from '../semantic/identity-scope-types.ts';
import type { CollectionSourceObservation } from './collection-source.ts';
import type { NativeSourceCustody, NativeSourceIdentity } from './native-source-custody.ts';

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

/** Native Library producer; declarations are not admission or proof. */
export declare function admitCollectionKindPreparationStep(tx: OperationalTransaction, locator: CollectionKindPreparationLocator): Promise<boolean>;
export declare function readCollectionKindWorkDefinition(tx: OperationalTransaction, locator: CollectionKindPreparationLocator): Promise<CollectionKindWorkDefinition | null>;
