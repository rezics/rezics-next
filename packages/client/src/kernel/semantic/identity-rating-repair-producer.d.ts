import type { Pool } from 'pg';
import { type CommandEvent, type CommandTransaction } from '../command/command.ts';
import { IDENTITY_RATING_REPAIR_CONTINUATION } from './events.ts';
export declare const IDENTITY_RATING_REPAIR_MAX_CONTINUATION = 8;
export { IDENTITY_RATING_REPAIR_CONTINUATION };
export type IdentityRatingRepairVoteKey = Readonly<{
    questionId: string;
    targetId: string;
}>;
export type IdentityRatingRepairVote = IdentityRatingRepairVoteKey & Readonly<{
    units: number | null;
    revision: number;
    countedTargetId: string | null;
    countedRevision: number;
    changedAt: string;
}>;
export type IdentityRatingRepairPage = Readonly<{
    pageId: string;
    voterId: string;
    workId: string;
    generation: string;
    mode: 'repair' | 'withdrawal';
    after: IdentityRatingRepairVoteKey | null;
    through: IdentityRatingRepairVoteKey | null;
    next: IdentityRatingRepairVoteKey | null;
    terminal: boolean;
    votes: readonly IdentityRatingRepairVote[];
    digest: string;
}>;
export type IdentityRatingRepairMapping = Readonly<{
    originalId: string;
    terminalId: string;
    epoch: string;
}>;
export type IdentityRatingRepairAuthority = Readonly<{
    status: 'pending';
    reason: string;
    obligationId?: string;
    events?: readonly CommandEvent[];
}> | Readonly<{
    status: 'current';
    obligationId: string;
    mappings: readonly IdentityRatingRepairMapping[];
    extraHomes?: readonly number[];
}>;
/** Structurally the Rating identity-repair producer. Rating retains vote/effect/receipt writes. */
export type IdentityRatingRepairProducer = Readonly<{
    hold(tx: CommandTransaction, page: IdentityRatingRepairPage): Promise<IdentityRatingRepairAuthority>;
    complete(tx: CommandTransaction, input: Readonly<{
        page: IdentityRatingRepairPage;
        obligationId: string;
        mappingDigest: string;
        transactionId: string;
    }>): Promise<boolean>;
    prepare(tx: CommandTransaction, input: Readonly<{
        obligationId: string;
        voterPartition: number;
        originals: readonly string[];
    }>): Promise<IdentityRatingRepairAuthority>;
    handoff(tx: CommandTransaction, input: Readonly<{
        obligationId: string;
        home: number;
        originals: readonly string[];
        mappings: readonly IdentityRatingRepairMapping[];
        extraHomes?: readonly number[];
    }>): Promise<IdentityRatingRepairAuthority>;
    drain(tx: CommandTransaction): Promise<IdentityRatingRepairDrain>;
}>;
export type IdentityRatingRepairDrain = Readonly<{
    drained: number;
    continuing: boolean;
    events: readonly CommandEvent[];
}>;
declare function identityRatingRepairMappingDigest(mappings: readonly IdentityRatingRepairMapping[]): string;
/**
 * Exact original-to-visible-terminal mappings for a Rating identity-repair page.
 * Same-home voter commands lock core.partition through COMMIT. Foreign source or
 * control homes persist a preparing obligation and one-partition prepare/handoff
 * receipts; later mapping and vote writes drain through bounded owner commands.
 */
export declare function createIdentityRatingRepairProducer(): IdentityRatingRepairProducer;
export declare function continueIdentityRatingRepair(pool: Pool, data: Readonly<{
    partition: number;
    voterPartition: number;
    obligationId: string;
    kind: 'prepare' | 'drain';
    originals: readonly string[];
}>): Promise<void>;
export { identityRatingRepairMappingDigest };
