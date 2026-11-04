import type { Pool } from 'pg';
import { type KernelClock } from '../clock.ts';
import { type Access, type Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { WorkClient } from '../work/client.ts';
import { type ArchiveCoverage, type ArchiveRecord } from './library-archive.ts';
import { createSessionCommands } from './sessions.ts';
export declare const LIBRARY_ARCHIVE_MERGE_LIMITS: {
    readonly records: 100000;
    readonly recordBytes: number;
    readonly maxRecordBytes: 65536;
    readonly pageBytes: 120000;
    readonly pageRows: 16;
    readonly uploadBytes: number;
    readonly depth: 32;
    readonly sections: 17;
    readonly page: 100;
    readonly reviewItems: 20;
    readonly applyItems: 20;
    readonly cleanupItems: 100;
    readonly lifetimeDays: 7;
};
export type LibraryArchiveMergeDependencies = {
    pool: Pool;
    access: Access;
    tokens: KeyRing;
    workClient: WorkClient | (() => Promise<WorkClient>);
    journalCommands?: Pick<ReturnType<typeof createSessionCommands>, 'readSession' | 'readSessionJournal' | 'patchSessionJournal'>;
    clock?: KernelClock;
};
export type ArchiveMergeReviewInput = {
    ordinal: number;
    kind: 'entry';
    subjectId: string;
    action: 'create' | 'update' | 'preserve';
    stateId?: string;
} | {
    ordinal: number;
    kind: 'label';
    target: {
        mode: 'existing';
        labelId: string;
    } | {
        mode: 'create';
    };
} | {
    ordinal: number;
    kind: 'assignment';
    subjectId: string;
    action: 'assign' | 'preserve';
} | {
    ordinal: number;
    kind: 'annotation';
    subjectId: string;
    incarnationId: string;
    fields: {
        note?: ArchiveFieldChoice;
        priority?: ArchiveFieldChoice;
    };
} | {
    ordinal: number;
    kind: 'journal';
    subjectId: string;
    sessionId: string;
    fields: {
        startDate?: ArchiveFieldChoice;
        finishDate?: ArchiveFieldChoice;
        reflection?: ArchiveFieldChoice;
    };
};
export type ArchiveMergeSelection = {
    ordinal: number;
    reviewRevision: number;
};
export type ArchiveFieldChoice = 'preserve' | 'set' | 'clear';
type ItemStatus = 'unresolved' | 'unsupported' | 'create' | 'already_equal' | 'current_conflict' | 'mapped' | 'preserved' | 'applying' | 'acknowledged';
/** Private bounded archive retention. Effects are delegated to the installed Library command owners. */
export declare function createLibraryArchiveMerge(deps: LibraryArchiveMergeDependencies): {
    upload: (actor: Actor, bytes: Uint8Array, requestKey: string, signal?: AbortSignal) => Promise<{
        value: {
            uploadId: string;
            createdAt: string;
            expiresAt: string;
            state: "cancelled" | "expired" | "ready";
            rows: number;
            recordBytes: number;
            coverage: ArchiveCoverage[];
        };
        partition: number;
        epoch: number;
        position: bigint;
        transactionId: string;
        replayed: boolean;
    }>;
    get: (actor: Actor, id: string, signal?: AbortSignal) => Promise<{
        uploadId: string;
        createdAt: string;
        expiresAt: string;
        state: "cancelled" | "expired" | "ready";
        rows: number;
        recordBytes: number;
        coverage: ArchiveCoverage[];
    }>;
    page: (actor: Actor, id: string, after?: number, limit?: number, signal?: AbortSignal) => Promise<{
        uploadId: string;
        state: "cancelled" | "expired" | "ready";
        coverage: ArchiveCoverage[];
        records: {
            ordinal: number;
            section: string;
            evidence: ArchiveRecord;
            status: ItemStatus;
            review: Record<string, unknown> | null;
            reviewRevision: number;
        }[];
        next: number | null;
    }>;
    review: (actor: Actor, id: string, decisions: readonly ArchiveMergeReviewInput[], signal?: AbortSignal) => Promise<{
        uploadId: string;
        reviewed: {
            ordinal: number;
            status: ItemStatus;
            reviewRevision: any;
        }[];
    }>;
    apply: (actor: Actor, id: string, selected: readonly ArchiveMergeSelection[], signal?: AbortSignal) => Promise<{
        uploadId: string;
        applied: {
            ordinal: number;
            status: string;
            result: Record<string, unknown> | null;
        }[];
    }>;
    results: (actor: Actor, id: string, after?: number, limit?: number, signal?: AbortSignal) => Promise<{
        uploadId: string;
        state: "cancelled" | "expired" | "ready";
        results: {
            ordinal: number;
            section: string;
            status: string;
            result: Record<string, unknown> | null;
        }[];
        next: number | null;
    }>;
    cancel: (actor: Actor, id: string, signal?: AbortSignal) => Promise<{
        uploadId: string;
        createdAt: string;
        expiresAt: string;
        state: "cancelled" | "expired" | "ready";
        rows: number;
        recordBytes: number;
        coverage: ArchiveCoverage[];
    }>;
    prune: (actor: Actor, id: string, signal?: AbortSignal) => Promise<{
        uploadId: string;
        removed: number;
        complete: boolean;
    }>;
};
export {};
