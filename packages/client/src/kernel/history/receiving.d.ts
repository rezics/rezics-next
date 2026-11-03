import type { Pool } from 'pg';
import type { IdentitySourceConsumerMaintenanceWork } from '../semantic/identity-source-consumer-maintenance.ts';
import { type CommandTransaction } from '../command/command.ts';
import type { AccountErasureSearchObservation } from '../search/account-erasure-source.ts';
import { type HistoryArtifact, type HistoryBarrier, type HistoryProducerFamily } from './registry.ts';
export type HistoryReceivingDependencies = Readonly<{
    pool: Pool;
    clock?: () => Date;
}>;
export type HistoryReceivingContext = Readonly<{
    deadline: number;
    identityConsumerWork?: IdentitySourceConsumerMaintenanceWork;
    accountErasureSearchObservation?: AccountErasureSearchObservation;
    recoveryReceivingReserved?: boolean;
}>;
declare const ownerCoverage: unique symbol;
declare const receivingReceipt: unique symbol;
export type HistoryOwnerCoverage = {
    readonly [ownerCoverage]: true;
};
export type HistoryReceivingReceipt = {
    readonly [receivingReceipt]: true;
};
export type HistoryOwnerCoverageResult = Readonly<{
    state: 'pending';
    gaps: readonly string[];
}> | Readonly<{
    state: 'complete';
    coverage: HistoryOwnerCoverage;
}>;
export declare function historyDeadline(context: HistoryReceivingContext, partition: number): void;
export declare function lockHistoryBarrier(tx: CommandTransaction, barrier: HistoryBarrier): Promise<boolean>;
/** Called by the physical minimizer in the SAME transaction as its local locator effect. No
 * caller boolean or process capability substitutes for the native minimized source proof. */
export declare function recordHistoryReceivingProof(tx: CommandTransaction, barrier: HistoryBarrier, partition: number, locator: HistoryArtifact['locator'], pool?: Pool, context?: HistoryReceivingContext): Promise<string | null>;
export declare function historyReceivingGap(tx: CommandTransaction, partition: number, locator: HistoryArtifact['locator'], barrier?: HistoryBarrier, pool?: Pool, context?: HistoryReceivingContext): Promise<string | null>;
export declare function historyPhysicalProof(tx: CommandTransaction, partition: number, locator: HistoryArtifact['locator']): Promise<boolean>;
export declare function readHistoryReceivingReceipt(deps: HistoryReceivingDependencies, barrier: HistoryBarrier, artifact: HistoryArtifact, context: HistoryReceivingContext): Promise<HistoryReceivingReceipt | null>;
/** Final owners call this on their actual account-home command. Locks live through its COMMIT. */
export declare function verifyHistoryReceivingReceipt(tx: CommandTransaction, barrier: HistoryBarrier, artifact: HistoryArtifact, receipt: HistoryReceivingReceipt): Promise<boolean>;
export declare function readHistoryOwnerCoverage(deps: HistoryReceivingDependencies, barrier: HistoryBarrier, family: HistoryProducerFamily, context: HistoryReceivingContext): Promise<HistoryOwnerCoverageResult>;
export declare function verifyHistoryOwnerCoverage(tx: CommandTransaction, barrier: HistoryBarrier, family: HistoryProducerFamily, coverage: HistoryOwnerCoverage): Promise<boolean>;
/** Operational use only. Reuses the exact artifact receiving proof and source locks. */
export declare function recordHistoryFamilyArtifactWatch(tx: CommandTransaction, barrier: HistoryBarrier, artifact: HistoryArtifact): Promise<boolean>;
/** Current native receiving proof in the held home. This grants no new writer authority. */
export declare function verifyCurrentHistoryReceiving(tx: CommandTransaction, barrier: HistoryBarrier, artifact: HistoryArtifact): Promise<boolean>;
export {};
