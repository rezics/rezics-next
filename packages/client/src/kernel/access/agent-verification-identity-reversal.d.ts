import type { Pool } from 'pg';
import { type CommandTransaction } from '../command/command.ts';
import type { IdentitySourceConsumerReference, IdentitySourceConsumerContext } from '../semantic/identity-source-consumer-custody.ts';
import { type AccountIdentitySource } from './agent-verification-identity.ts';
import type { AgentVerificationReversal } from './agent-verification.ts';
type Bound = Readonly<{
    source: AccountIdentitySource;
    binding: Readonly<{
        generation: string;
        transactionId: string;
        home: number;
        scope: string;
        sources: unknown;
        job: Readonly<{
            jobId: string;
            epoch: bigint;
        }>;
    }>;
    undoGeneration: string;
    restoreGeneration: string;
}>;
export type AccountIdentityReversalWrite = Readonly<{
    input: AgentVerificationReversal;
    deadline: number;
    verified: Bound;
    reversed: Bound;
}>;
/** Released probes only; no admission, bindReceipt, current release or invented job hint. */
export declare function prepareAccountIdentityReversalSettlement(pool: Pool, input: AgentVerificationReversal): Promise<AccountIdentityReversalWrite>;
/** Called only inside the original reversed command, before its native receipt/event commit. */
export declare function recordAccountIdentityReversalSettlement(tx: CommandTransaction, prepared: AccountIdentityReversalWrite): Promise<void>;
declare const settlement: unique symbol;
export type AccountIdentityReversalSettlement = Readonly<{
    [settlement]: true;
}>;
/** Exact current reference, one funded same-home read, no foreign-home I/O or minting. */
export declare function readAccountIdentityReversalSettlement(pool: Pool, reference: IdentitySourceConsumerReference, context: IdentitySourceConsumerContext): Promise<AccountIdentityReversalSettlement | null>;
/** A brand/observation alone never proves currentness: lock the durable native rows again. */
export declare function verifyAccountIdentityReversalSettlement(tx: CommandTransaction, reference: IdentitySourceConsumerReference, proof: AccountIdentityReversalSettlement): Promise<boolean>;
/** Same-home settlement read: 64/64/20/65536 plus explicit remaining axes. Verify is the 15-statement prefix. */
export declare function ACCOUNT_IDENTITY_REVERSAL_SETTLEMENT_DECLARATION(): Readonly<{
    engineRequests: 0;
    work: Readonly<{
        candidateKeys: 0;
        nativeRows: 64;
        identityMetadataRows: 0;
        nativePoints: 64;
        witnessKeys: 0;
        statements: 20;
        bytes: 65536;
        emptySeeks: 20;
    }>;
}>;
export declare function ACCOUNT_IDENTITY_REVERSAL_VERIFY_DECLARATION(): Readonly<{
    engineRequests: 0;
    work: Readonly<{
        candidateKeys: 0;
        nativeRows: 64;
        identityMetadataRows: 0;
        nativePoints: 64;
        witnessKeys: 0;
        statements: 15;
        bytes: 65536;
        emptySeeks: 15;
    }>;
}>;
export {};
