import type { OperationalTransaction } from '../command/operational.ts';
import { ProblemError } from '../http/problem.ts';
import type { IdentityNativeReceipt } from '../semantic/identity-epoch-contract.ts';
import type { IdentityScopeObservation } from '../semantic/identity-scope-types.ts';
import type { CollectionSourceObservation } from './collection-source.ts';
import type { NativeSourceIdentity, NativeSourceCustody } from './native-source-custody.ts';

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

/** Admission stays unavailable until the native Kind preparation producer supplies its proof. */
export async function admitCollectionKindPreparationStep(
  tx: OperationalTransaction,
  locator: CollectionKindPreparationLocator,
): Promise<boolean> {
  throw new ProblemError('dependency_unavailable');
}

/** Work data stays unavailable until the native Kind preparation producer supplies its proof. */
export async function readCollectionKindWorkDefinition(
  tx: OperationalTransaction,
  locator: CollectionKindPreparationLocator,
): Promise<CollectionKindWorkDefinition | null> {
  throw new ProblemError('dependency_unavailable');
}
