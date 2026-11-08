export { IdentityEpochStoreError } from '../contract/identity-errors.ts';
import { bindSemanticProducerRoles, identityErasureRoles } from '../erasure-producer.ts';
export { bindSemanticProducerRoles, identityErasureRoles };
import { admittedAccountMappingSource } from './identity-epoch-binding.ts';
import type { CommandTransaction } from '../../command/command.ts';
import type { NativeIdentityCapabilities } from '../identity-adapter-port.ts';
import { readIdentityMappings, readIdentityRatingReview } from './identity-epoch-read.ts';
import { type IdentityEpochStore, type IdentityJobRef, type IdentityChange } from './identity-epoch-contract.ts';
export declare const IDENTITY_EPOCH_CONTROL_PARTITION = 0;
/** Fixed initial production capacity, charged once per native (home,job). */
export declare const IDENTITY_EPOCH_HOME_CAPACITY = 1;
export { authorizeIdentityAdmission } from './identity-epoch-binding.ts';
export { recordIdentityEpochNativeCommit } from './native-commit.ts';
export { identityEpochRemainderTerminal, identityHomeAvailable, identityJobPartition, identityReceiptKey, identityReceiptValue, } from './identity-epoch-contract.ts';
export { selectIdentityEpochRemainder } from './identity-epoch-read.ts';
export { serializeIdentityValue } from '../identity-core/index.ts';
export { identityEpochChangeTerminal, type IdentityEpochLibraryTransform } from '../identity-core/index.ts';
export { identityEpochLibraryInputsSQL } from '../identity-epoch-library-inputs.ts';
/** Library-only bounded projection of the ordinary pageChanges algorithm, on the caller's RR snapshot.
 * This neither admits a job nor changes the ordinary store API. Every output ID is native UUID width.
 */
export declare function pageLibraryIdentityEpochChanges(tx: CommandTransaction, job: IdentityJobRef, after: string | null): Promise<{
    changes: IdentityChange[];
    next: string | null;
}>;
/** Native source mappings and partition-scoped admission. Participant completion is never inferred. */
export declare function createIdentityEpochStore(capabilities: NativeIdentityCapabilities): IdentityEpochStore;
export declare function identityEpochStore(): IdentityEpochStore;
export { IDENTITY_EPOCH_JOB_READ_DECLARATION, IDENTITY_EPOCH_STEP_RECONCILE_DECLARATION, } from '../identity-epoch-participant-cost.ts';
export { readIdentityMappings, readIdentityRatingReview };
export type { IdentityReceivingSelection } from '../identity-receiving-effects-types.ts';
export type { IdentityRatingControlLocator, IdentityRatingReviewOperand, IdentityRatingReviewResult, IdentityRatingReviewUnavailableReason, } from './identity-epoch-read.ts';
export type * from './identity-epoch-contract.ts';
export { admittedAccountMappingSource };
