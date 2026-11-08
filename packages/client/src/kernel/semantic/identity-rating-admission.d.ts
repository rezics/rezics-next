import type { CommandTransaction } from '../command/command.ts';
import type { Pool } from 'pg';
import type { IdentityRatingEpochObservation } from './contract/domain-ports.ts';
import type { IdentityEpochState } from './identity-epoch-contract.ts';
import type { IdentityRatingAdmissionResult } from './contract/index.ts';
export type { IdentityRatingAdmissionReason, IdentityRatingAdmissionResult } from './contract/index.ts';
export type IdentityRatingEpochWitness = IdentityRatingEpochObservation;
export type IdentityRatingEpochReader = (tx: CommandTransaction, home: number) => Promise<IdentityEpochState>;
/** Released native-home observations. These do not fence identity publication through an owner commit. */
export declare function readIdentityRatingEpochs(pool: Pool, homes: readonly number[], deadline: number): Promise<Readonly<{
    partition: number;
    epoch: string;
}>[]>;
export declare function compareIdentityRatingEpochs(expected: readonly IdentityRatingEpochWitness[], actual: readonly IdentityRatingEpochWitness[]): void;
/**
 * Revalidate the pre-resolved target in the voter's transaction. A newly installed direct
 * redirect or an open identity epoch leaves this command attempt retryable before any vote write.
 */
export declare function admitIdentityRatingEffect(tx: CommandTransaction, input: Readonly<{
    requestedTargetId: string;
    resolvedTargetId: string;
    expectedEpochs?: readonly IdentityRatingEpochWitness[];
}>, readEpoch?: IdentityRatingEpochReader): Promise<IdentityRatingAdmissionResult>;
