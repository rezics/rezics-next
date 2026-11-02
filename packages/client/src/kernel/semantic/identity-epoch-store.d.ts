export { IdentityEpochStoreError } from './identity-terminal-closure-errors.ts';
import { type CommandTransaction } from '../command/command.ts';
import type { IdentityEpochStore, IdentityJobRef, IdentityReceipt, IdentityIntent } from './identity-epoch-contract.ts';
export declare const IDENTITY_EPOCH_CONTROL_PARTITION = 0;
/** Fixed initial production capacity, charged once per native (home,job). */
export declare const IDENTITY_EPOCH_HOME_CAPACITY = 1;
export declare const identityJobPartition: (job: IdentityJobRef) => number;
export declare function recordIdentityEpochNativeCommit(tx: CommandTransaction, purpose: string): void;
export declare function serializeIdentityValue(value: unknown): string;
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
    roles: readonly import("./erasure-producer.ts").SemanticCopyRole[];
}> | undefined>;
/** One keyed selection in the captured generation, independent of presentation visibility. */
export declare function selectIdentityEpochRemainder(tx: CommandTransaction, intent: IdentityIntent, input: {
    partition_no: number;
    terminal: string;
    generation: string;
}): Promise<string | null>;
type TransformSource = {
    input_original: string;
    terminal: string;
    observed_count: string;
    remainder_terminal?: string | null;
};
/** Validate the captured transform before binding or allocating an attempt. */
export declare function identityEpochRemainderTerminal(intent: IdentityIntent, sources: readonly TransformSource[]): string | null;
/** The store page and executable mapping consume the same immutable constant transform. */
export declare function identityEpochChangeTerminal(intent: IdentityIntent, remainder: string | null, original: string, previous: string): string;
/** Native source mappings and partition-scoped admission. Participant completion is never inferred. */
export declare const identityEpochStore: IdentityEpochStore;
