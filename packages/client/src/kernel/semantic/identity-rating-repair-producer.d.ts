import { type CommandTransaction } from '../command/command.ts';
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
}> | Readonly<{
    status: 'current';
    obligationId: string;
    mappings: readonly IdentityRatingRepairMapping[];
}>;
export type IdentityRatingRepairProducer = Readonly<{
    hold(tx: CommandTransaction, page: IdentityRatingRepairPage): Promise<IdentityRatingRepairAuthority>;
    complete(tx: CommandTransaction, input: Readonly<{
        page: IdentityRatingRepairPage;
        obligationId: string;
        mappingDigest: string;
        transactionId: string;
    }>): Promise<boolean>;
}>;
export declare function createIdentityRatingRepairProducer(): IdentityRatingRepairProducer;
export declare function identityRatingRepairMappingDigest(mappings: readonly IdentityRatingRepairMapping[]): string;
