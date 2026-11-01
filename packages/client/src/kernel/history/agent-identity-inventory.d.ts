import type { Pool } from 'pg';
import type { WorkClient } from '../work/client.ts';
import { type CommandTransaction } from '../command/command.ts';
import type { originalAccountIdentitySource } from '../access/agent-verification-identity.ts';
import { type AgentIdentitySourceKey } from './agent-identity-source.ts';
import type { HistoryArtifact, HistoryBarrier } from './registry.ts';
import { type AgentIdentityRetirementStage } from './agent-identity-retirement.ts';
import { type HistoryReceivingContext, type HistoryReceivingDependencies } from './receiving.ts';
/** First owner declaration: exact original Accounts key and native tuple, never an erasure Source authority.
 * Native receipt/outbox closure and SDK future-writer closure are independent branches. */
export declare const AGENT_IDENTITY_INVENTORY: Readonly<{
    readonly producerVersion: 1;
    readonly conversionCoverage: 'native-receipt-outbox/v1';
    readonly maxCopies: 3;
    readonly nativeFutureWriters: 'closed-at-original-commit';
    readonly sdkFutureWriters: 'native-sdk-fence-requires-source-transfer';
}>;
export type AgentIdentityOriginal = Readonly<{
    key: AgentIdentitySourceKey;
    partition: number;
    epoch: number;
    position: bigint;
    transactionId: string;
    digest: string;
}>;
declare const inventoryProof: unique symbol;
/** A portable snapshot of durable native custody. Verification always re-reads its native fences and receipts. */
export type AgentIdentityInventoryProof = Readonly<{
    original: AgentIdentityOriginal;
    generation: string;
    domainGeneration: string;
    receiverEpoch: number;
    cutDigest: string;
    artifacts: readonly HistoryArtifact[];
    readonly [inventoryProof]: true;
}>;
export type AgentIdentityNativeInventory = Readonly<{
    state: 'pending';
    gap: 'agent-identity-original-inventory-unsealed';
    proof: null;
}> | Readonly<{
    state: 'sealed';
    gap: null;
    proof: AgentIdentityInventoryProof;
}>;
export type AgentIdentityInventoryVerification = Readonly<{
    state: 'pending';
    native: 'pending' | 'verified';
    gap: string;
}>;
/** Only the original native writer issues this binding, before any nested serializer. */
export declare function declareAgentIdentityInventory(tx: CommandTransaction, original: ReturnType<typeof originalAccountIdentitySource>): Promise<void>;
/** Executor calls before JSON.stringify of any event data or response. Types and slots are copied
 * synchronously; getters/toJSON cannot reduce the expected work while serialization is running. */
export declare function captureAgentIdentityInventory(tx: CommandTransaction, kind: string | undefined, events: readonly {
    type: string;
}[]): void;
/** After EVERY actual serializer hook and final physical fence, still in the original transaction.
 * Durable validation matches each expected slot to its genuine association and physical row. */
export declare function finalizeAgentIdentityInventory(tx: CommandTransaction, position: bigint): Promise<void>;
export declare function releaseAgentIdentityInventory(tx: CommandTransaction): void;
/** At most three exact original associations and 64 roles each; no historical scans, inferred
 * empty sources, transaction-wide attachments, JSON source parsing or caller conversion flag. */
export declare function readAgentIdentityInventoryInTransaction(tx: CommandTransaction, key: AgentIdentitySourceKey): Promise<AgentIdentityNativeInventory>;
export declare function readAgentIdentityNativeInventory(pool: Pool, key: AgentIdentitySourceKey, context: HistoryReceivingContext): Promise<AgentIdentityNativeInventory>;
/** Every foreign receiving probe runs AFTER releasing the read home. A missing receipt is
 * precise pending. Native seal never asserts SDK enrollment, Account root or Semantic custody. */
export declare function readAgentIdentityInventory(deps: HistoryReceivingDependencies & Readonly<{
    client?: WorkClient;
}>, barrier: HistoryBarrier, key: AgentIdentitySourceKey, context: HistoryReceivingContext): Promise<Readonly<{
    state: 'pending';
    gap: 'agent-identity-original-inventory-unsealed';
    proof: null;
}> | {
    proof: AgentIdentityInventoryProof;
    state: 'pending';
    native: 'sealed';
    gap: string;
} | {
    proof: AgentIdentityInventoryProof;
    state: 'received';
    native: 'verified';
    gap: null;
}>;
/** SAME source-home command. All queries address local core rows. The portable snapshot is
 * untrusted until current generation, restore/writer seal, full roles, each durable barrier
 * receipt and each physical disposition have been rechecked and locked through COMMIT. */
export declare function verifyAgentIdentityInventory(tx: CommandTransaction, barrier: HistoryBarrier, key: AgentIdentitySourceKey, proof: AgentIdentityInventoryProof, sdkStage?: AgentIdentityRetirementStage): Promise<AgentIdentityInventoryVerification>;
export {};
