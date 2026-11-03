import type { Pool, PoolClient } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { Access, Actor, AccountActor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { AniListStored, AniListMatch, AniListObservation } from './list-import-anilist.ts';
export type AniListLabelSelection = {
    key: string;
    target: {
        labelId: string;
    } | {
        name: string;
    };
};
export type AniListLabelReviewInput = {
    subjectId?: string;
    selections: AniListLabelSelection[];
};
type Label = {
    id: string;
    revision: number;
};
type Item = {
    key: string;
    value: string;
    origin: 'customLists' | 'customContainer';
    target: {
        label: Label;
    } | {
        name: string;
        primary: number;
    };
    createKey: string;
    assignKey: string;
};
export type AniListLabelReview = {
    id: string;
    sourceDigest: string;
    subjectId: string;
    identityEpoch: string;
    matchFingerprint: string;
    clientId: string;
    requestedBy: string | null;
    items: Item[];
};
export type AniListLabelItemOutcome = {
    key: string;
    status: 'applied' | 'unchanged' | 'stale' | 'capacity' | 'failed' | 'pending';
    label?: Label;
    assignment?: {
        id: string;
        revision: number;
    };
    reason?: string;
};
export type AniListLabelWork = {
    createStarted?: boolean;
    assignStarted?: boolean;
    label?: Label;
    outcome?: AniListLabelItemOutcome;
};
type Dependencies = {
    pool: Pool;
    access: Access;
    tokens: KeyRing;
    clock?: KernelClock;
    load: (actor: Actor, id: string, ordinal: number) => Promise<AniListStored>;
    snapshot: <T>(actor: Actor, body: (tx: PoolClient, account: AccountActor) => Promise<T>) => Promise<T>;
    match: (actor: Actor, source: AniListStored['source']) => Promise<AniListMatch>;
    observe: (actor: Actor, subjectId: string) => Promise<AniListObservation | null>;
};
/** This is a composition on the installed source, not another upload or native fact store. */
export declare function createAniListLabelAdoption(deps: Dependencies): {
    reviewLabels: (actor: Actor, id: string, ordinal: number, input: AniListLabelReviewInput, key: string) => Promise<{
        ordinal: number;
        review: AniListLabelReview;
    }>;
    applyLabels: (actor: Actor, id: string, confirmations: {
        ordinal: number;
        reviewId: string;
    }[], signal?: AbortSignal) => Promise<{
        outcomes: {
            ordinal: number;
            reviewId: string;
            items: AniListLabelItemOutcome[];
            complete: boolean;
        }[];
        complete: boolean;
    }>;
};
export {};
