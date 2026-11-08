import type { RatingCapabilities } from './contract/capabilities.ts';
import type { Pool, PoolClient } from 'pg';
import { type SubjectSummary } from './dependencies.ts';
import type { KernelClock } from '../clock.ts';
import type { Access, Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { type RatingQuestionView } from './question-directory.ts';
export declare const OWN_VOTES_PAGE_SIZE = 20;
type Key = {
    questionId: string;
    targetId: string;
};
type Dependencies = {
    pool: Pool;
    access: Access;
    tokens: KeyRing;
    routeKey: Uint8Array;
    capabilities?: RatingCapabilities;
    clock?: KernelClock;
};
type CommandLinks = {
    clear: string;
    readback: string;
};
export type OwnVoteActions = (CommandLinks & {
    state: 'editable';
    put: string;
}) | (CommandLinks & {
    state: 'retired';
    reason: 'question_retired';
}) | {
    state: 'unavailable';
    reason: 'merged_source' | 'identity_pending' | 'read_only';
};
export type OwnVoteEntry = {
    /** Exact stored source key, even when its permitted navigation points at a terminal. */
    targetId: string;
    questionId: string;
    subject: SubjectSummary;
    subjectHref: string;
    question: RatingQuestionView;
    own: {
        units: number;
        revision: number;
        at: string;
    };
    actions: OwnVoteActions;
};
export type OwnVotesPage = {
    viewer: {
        accountId: string;
    };
    votes: OwnVoteEntry[];
    next: string | null;
};
/** Raw selection is a single account-home prefix. Cleared rows are outside its partial index. */
export declare function readOwnVotesRawPage(client: Pick<PoolClient, 'query'>, actor: Actor, after: Key | null): Promise<{
    votes: {
        questionId: string;
        targetId: string;
        units: number;
        revision: number;
        changedAt: string;
        countedTarget: string | null;
    }[];
    after: {
        questionId: string;
        targetId: string;
    } | null;
    hasMore: boolean;
}>;
/** Account-home native inventory. No mounted point GET calls, refill loop or secondary writer. */
export declare function createOwnVotesReader(deps: Dependencies): {
    page(actor: Actor, input: {
        cursor?: string;
    }, deadline: number): Promise<OwnVotesPage>;
};
export {};
