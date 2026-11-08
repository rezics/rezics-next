import type { CommandTransaction } from '../command/command.ts';
export { RATING_IDENTITY_PAGE_SIZE } from './identity-work-frame-limits.ts';
export type IdentityVoteKey = {
    questionId: string;
    targetId: string;
};
export type IdentityVote = IdentityVoteKey & {
    units: number | null;
    revision: number;
    countedTargetId: string | null;
    countedRevision: number;
    changedAt: string;
};
export type IdentityWorkRef = {
    workId: string;
    generation: string;
};
export type IdentityRepairPage = IdentityWorkRef & {
    pageId: string;
    voterId: string;
    mode: 'repair' | 'withdrawal';
    after: IdentityVoteKey | null;
    through: IdentityVoteKey | null;
    next: IdentityVoteKey | null;
    terminal: boolean;
    votes: IdentityVote[];
    digest: string;
};
export type IdentityWorkFrame = IdentityWorkRef & {
    state: 'active' | 'complete' | 'cancelled';
    mode: IdentityRepairPage['mode'];
    cursor: IdentityVoteKey | null;
    through: IdentityVoteKey | null;
    selected: IdentityRepairPage | null;
};
export declare function identityRoute(voterId: string): number;
export declare function validateIdentityWork(ref: IdentityWorkRef): void;
export declare function sameIdentityWork(frame: IdentityWorkFrame | null, ref: IdentityWorkRef): frame is IdentityWorkFrame;
export declare function readIdentityFrame(tx: CommandTransaction, voterId: string): Promise<IdentityWorkFrame | null>;
export declare function saveIdentityFrame(tx: CommandTransaction, voterId: string, frame: IdentityWorkFrame): Promise<void>;
export declare function readIdentityLimit(tx: CommandTransaction, voterId: string): Promise<IdentityVoteKey | null>;
export declare function readIdentityVotes(tx: CommandTransaction, voterId: string, after: IdentityVoteKey | null, through: IdentityVoteKey | null): Promise<IdentityVote[]>;
export declare function identityPageDigest(page: Omit<IdentityRepairPage, 'digest'>): string;
