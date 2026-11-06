import type { Pool } from 'pg';
import { type CommandTransaction } from '../command/command.ts';
import { type IdentityBindingData } from './identity-adapters/identity-epoch-binding.ts';
import type { IdentityAdmissionInput, IdentityJobRef, IdentityNativeReceipt, IdentityReceipt } from './identity-epoch-contract.ts';
export type OriginalAccountAgentIdentitySelection = Readonly<{
    account: string;
    direction: Exclude<IdentityReceipt, {
        kind: 'subject.merge';
    }>['kind'];
    receipt: string;
}>;
/** Original accepted claim custody, not an Accounts decision or a recovery command receipt. */
export type OriginalAccountAgentIdentitySource = Readonly<{
    input: IdentityAdmissionInput;
    digest: string;
    native: IdentityNativeReceipt;
    job: IdentityJobRef;
    claim: Pick<IdentityBindingData, 'partition' | 'key' | 'generation' | 'transactionId' | 'home' | 'scope' | 'sources'>;
}>;
export type OriginalAccountAgentIdentity = OriginalAccountAgentIdentitySource & Readonly<{
    priorVerification: (OriginalAccountAgentIdentitySource & Readonly<{
        verificationReceipt: string;
    }>) | null;
}>;
/** No active account/release lookup, admission, repair write, or recursive Accounts source read. */
export declare function readOriginalAccountAgentIdentity(pool: Pool, selection: OriginalAccountAgentIdentitySelection): Promise<OriginalAccountAgentIdentity | null>;
/** The association rejects clones; native local revalidation supplies the actual same-tx authority. */
export declare function verifyOriginalAccountAgentIdentity(tx: CommandTransaction, selection: OriginalAccountAgentIdentitySelection, result: OriginalAccountAgentIdentity): Promise<boolean>;
