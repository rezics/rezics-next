import type { Pool } from 'pg';
import type { CommandOutcome } from '../command/command.ts';
import type { KernelClock } from '../clock.ts';
import type { Actor } from '../request/access.ts';
import { type PersonalEntry } from './entry-personal-model.ts';
import type { Entry } from './entry-model.ts';
export declare const ENTRY_ANNOTATION_CORRECTION_LIMITS: Readonly<{
    selection: 16;
    page: 4;
    requestBytes: number;
    responseBytes: number;
    activeReviewsPerOwner: 4;
    retainedReviewsPerOwner: 8;
    reviewMinutes: 15;
    resultMinutes: 15;
}>;
export type EntryAnnotationOperation<T> = Readonly<{
    op: 'preserve';
}> | Readonly<{
    op: 'clear';
}> | Readonly<{
    op: 'set';
    value: T;
}>;
export type EntryAnnotationCorrectionSelection = Readonly<{
    subjectId: string;
    incarnationId: string;
    currentRevision: number;
    note: EntryAnnotationOperation<string>;
    priority: EntryAnnotationOperation<number>;
}>;
export type EntryAnnotationCorrectionCurrent = Readonly<{
    annotationRevision: number;
    note: string | null;
    priority: number | null;
}>;
export type EntryAnnotationCorrectionItem = Readonly<{
    selected: Readonly<{
        subjectId: string;
        incarnationId: string;
        currentRevision: number;
    }>;
    eligibility: 'ready' | 'stale' | 'unavailable';
    current: EntryAnnotationCorrectionCurrent | null;
    operation: Readonly<{
        note: EntryAnnotationOperation<string>;
        priority: EntryAnnotationOperation<number>;
    }> | null;
    outcome: 'accepted' | 'unchanged' | 'stale' | 'unavailable' | 'not-started';
}>;
export type EntryAnnotationCorrectionPage = Readonly<{
    reviewId: string;
    epoch: string;
    state: 'open' | 'confirmed' | 'cancelled' | 'expired';
    createdAt: string;
    expiresAt: string;
    total: number;
    page: number;
    pageCount: number;
    nextPage: number | null;
    items: readonly EntryAnnotationCorrectionItem[];
}>;
export type EntryAnnotationCorrectionCommands = {
    readEntry(actor: Actor, subjectId: string): Promise<Entry>;
    readPersonalEntry(actor: Actor, subjectId: string): Promise<PersonalEntry>;
    saveAnnotations(actor: Actor, subjectId: string, input: unknown, requestKey: string): Promise<CommandOutcome<PersonalEntry>>;
};
type Dependencies = {
    pool: Pool;
    clock?: KernelClock;
    entries: () => EntryAnnotationCorrectionCommands;
};
export declare class EntryAnnotationCorrectionConflictError extends Error {
    readonly reason: 'epoch' | 'expired';
    constructor(reason: 'epoch' | 'expired');
}
export declare class EntryAnnotationCorrectionLimitError extends Error {
    constructor();
}
export declare function createEntryAnnotationCorrectionCommands(dependencies: Dependencies): {
    create: (actor: Actor, input: unknown) => Promise<Readonly<{
        reviewId: string;
        epoch: string;
        state: 'open' | 'confirmed' | 'cancelled' | 'expired';
        createdAt: string;
        expiresAt: string;
        total: number;
        page: number;
        pageCount: number;
        nextPage: number | null;
        items: readonly EntryAnnotationCorrectionItem[];
    }>>;
    readPage: (actor: Actor, reviewId: string, page?: number) => Promise<Readonly<{
        reviewId: string;
        epoch: string;
        state: 'open' | 'confirmed' | 'cancelled' | 'expired';
        createdAt: string;
        expiresAt: string;
        total: number;
        page: number;
        pageCount: number;
        nextPage: number | null;
        items: readonly EntryAnnotationCorrectionItem[];
    }>>;
    confirmItem: (actor: Actor, reviewId: string, epoch: string, position: number) => Promise<{
        page: Readonly<{
            reviewId: string;
            epoch: string;
            state: 'open' | 'confirmed' | 'cancelled' | 'expired';
            createdAt: string;
            expiresAt: string;
            total: number;
            page: number;
            pageCount: number;
            nextPage: number | null;
            items: readonly EntryAnnotationCorrectionItem[];
        }>;
        commandOutcome?: CommandOutcome<Readonly<{
            subjectId: string;
            annotationRevision: number;
            note: string | null;
            priority: number | null;
            annotationUpdatedAt: string | null;
            sourceObservations: readonly import("./entry-personal-model.ts").PersonalEntryObservation[];
        }>>;
    }>;
    cancel: (actor: Actor, reviewId: string, epoch: string) => Promise<{
        reviewId: string;
        epoch: string;
        state: "cancelled" | "confirmed" | "expired" | "open";
        expiresAt: string;
    }>;
};
/** Scheduled cleanup is keyed by the review expiry index, independent of owner History. */
export declare function purgeExpiredEntryAnnotationReviews({ pool, clock }: {
    pool: Pool;
    clock?: KernelClock;
}, { partition, limit, after }: {
    partition: number;
    limit: number;
    after: string | null;
}): Promise<{
    examined: number;
    removed: number;
    next: string | null;
}>;
export {};
