import { type IdentityTransformSource } from '../identity-core/index.ts';
export { IdentityEpochStoreError } from '../identity-terminal-closure-errors.ts';
import { type CommandTransaction } from '../../command/command.ts';
import { readIdentityMappings, readIdentityRatingReview } from './read.ts';
import type { IdentityEpochStore, IdentityJobRef, IdentityReceipt, IdentityIntent, IdentityChange } from './identity-epoch-contract.ts';
export declare const IDENTITY_EPOCH_CONTROL_PARTITION = 0;
/** Fixed initial production capacity, charged once per native (home,job). */
export declare const IDENTITY_EPOCH_HOME_CAPACITY = 1;
export declare const identityJobPartition: (job: IdentityJobRef) => number;
export declare function recordIdentityEpochNativeCommit(tx: CommandTransaction, purpose: string): void;
export { serializeIdentityValue } from '../identity-core/index.ts';
export declare function identityReceiptValue(receipt: IdentityReceipt): Readonly<{
    kind: 'account-agent.verify';
    account: string;
    receipt: string;
}> | Readonly<{
    kind: 'account-agent.unverify';
    account: string;
    receipt: string;
}> | {
    kind: "subject.merge";
    command: {
        digest: string;
        actorAccountId: string;
        kind: string;
        key: string;
    };
};
export declare function identityReceiptKey(receipt: IdentityReceipt): string;
export declare function authorizeIdentityAdmission(tx: CommandTransaction, receipt: IdentityReceipt, binding?: import('./identity-epoch-binding.ts').IdentityReceiptBinding, intent?: IdentityIntent): Promise<Readonly<{
    input: Readonly<{
        intent: IdentityIntent;
        receipt: Readonly<{
            kind: 'account-agent.verify';
            account: string;
            receipt: string;
        }> | Readonly<{
            kind: 'account-agent.unverify';
            account: string;
            receipt: string;
        }>;
    }>;
    partition: number;
    epoch: number;
    position: bigint;
    transactionId: string;
    digest: string;
    workflowId: string;
    roles: readonly import("../erasure-producer.ts").SemanticCopyRole[];
}> | undefined>;
/** One keyed selection in the captured generation, independent of presentation visibility. */
export declare function selectIdentityEpochRemainder(tx: CommandTransaction, intent: IdentityIntent, input: {
    partition_no: number;
    terminal: string;
    generation: string;
}): Promise<string | null>;
/** Validate pure captured values before binding or allocating an attempt. */
export declare function identityEpochRemainderTerminal(intent: IdentityIntent, sources: readonly IdentityTransformSource[]): string | null;
export { identityEpochChangeTerminal, type IdentityEpochLibraryTransform } from '../identity-core/index.ts';
export declare const identityEpochLibraryInputsSQL = "SELECT generation,terminal,control_partition FROM semantic.identity_epoch_input WHERE partition_no=$1 AND job_id=$2 ORDER BY terminal LIMIT 3";
/** Library-only bounded projection of the ordinary pageChanges algorithm, on the caller's RR snapshot.
 * This neither admits a job nor changes the ordinary store API. Every output ID is native UUID width.
 */
export declare function pageLibraryIdentityEpochChanges(tx: CommandTransaction, job: IdentityJobRef, after: string | null): Promise<{
    changes: IdentityChange[];
    next: string | null;
}>;
/** Native source mappings and partition-scoped admission. Participant completion is never inferred. */
export declare function identityEpochStore(): IdentityEpochStore;
export { readIdentityMappings, readIdentityRatingReview };
export type { IdentityRatingControlLocator, IdentityRatingReviewOperand, IdentityRatingReviewResult, IdentityRatingReviewUnavailableReason, } from './read.ts';
export type * from './identity-epoch-contract.ts';
