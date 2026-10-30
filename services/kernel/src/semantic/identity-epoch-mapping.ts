import type { IdentityEpochStep } from './identity-epoch-contract.ts';
import { IdentityEpochStoreError } from './identity-epoch-store.ts';

/** PROVISIONAL agreed producer declaration. Replace with the owner's actual native implementation on landing. */
export const stepIdentityEpochMapping: IdentityEpochStep = async () => {
  throw new IdentityEpochStoreError('identity_epoch_unavailable', 'Native identity mapping producer is not integrated');
};
