import type { Pool } from 'pg';
import { type CommandEvent, type CommandTransaction, type AuthoritativeTime } from '../command/command.ts';
import type { KernelClock } from '../clock.ts';
import type { Access, AccountActor, Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { type ShelfTypeDigest } from './shelf-type-keys.ts';
import type { Entry, EntryState, EntryDeletion } from './entry-model.ts';
import { type VndbEntryReview } from './list-import-vndb-admission.ts';
export { LibraryConflictError } from './entry-errors.ts';
type Dependencies = {
    pool: Pool;
    access: Access;
    tokens: KeyRing;
    clock?: KernelClock;
    shelfTypeDigest?: ShelfTypeDigest;
    typeSourceObserved?: import('./type-preparation-contract.ts').TypePreparationSourceObserved;
};
export type ReviewedEntrySource = {
    release: string;
    epoch: string;
    acceptingType: string;
    importFence?: {
        id: string;
        row: number;
        version: string;
    };
    binding?: {
        subject: string;
        route: number;
        source: string;
        externalId: string;
    };
};
type ListEntryOptions = {
    state?: EntryState;
    cursor?: string;
    limit?: number;
};
type EntryStateHistoryOptions = {
    cursor?: string;
    limit?: number;
};
export declare class LibraryEntryInvalidError extends TypeError {
    constructor(message?: string);
}
export declare function LibraryEntryLifecycleConflictError(): {
    new (reason: 'stale' | 'occupied' | 'expired'): {
        readonly reason: 'stale' | 'occupied' | 'expired';
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
    isError(error: unknown): error is Error;
    isError(value: unknown): value is Error;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
    stackTraceLimit: number;
};
export type LibraryEntryLifecycleConflictError = InstanceType<ReturnType<typeof LibraryEntryLifecycleConflictError>>;
export declare function LibraryEntryStateRestoreConflictError(): {
    new (reason: 'stale' | 'unavailable' | 'unchanged'): {
        readonly reason: 'stale' | 'unavailable' | 'unchanged';
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
    isError(error: unknown): error is Error;
    isError(value: unknown): value is Error;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
    stackTraceLimit: number;
};
export type LibraryEntryStateRestoreConflictError = InstanceType<ReturnType<typeof LibraryEntryStateRestoreConflictError>>;
type EntryStateCommandKind = 'library.entry.put' | 'library.entry.state.restore';
/** Ordinary deletion transition, on the caller's authorized native owner transaction. */
export declare function deleteLibraryEntryInTransaction(tx: CommandTransaction, command: {
    transactionId: string;
    time: AuthoritativeTime;
}, owner: AccountActor, subjectId: string, expected: number, guard?: string): Promise<{
    value: EntryDeletion;
    events: readonly CommandEvent[];
}>;
/** Private account library entry writes and signed, account-scoped keyset reads. */
export declare function createEntryCommands(config: Dependencies): {
    receiptDigest: (actor: Actor, kind: string, input: unknown) => string;
    readCommandReceipt: (actor: Actor, request: {
        kind: string;
        requestKey: string;
        digest: string;
        authorize: (tx: CommandTransaction) => Promise<void>;
    }) => Promise<import("../command/command.ts").CommandOutcome<unknown> | null>;
    readPersonalEntry: (actor: Actor, subjectId: string) => Promise<import("./entry-personal-model.ts").PersonalEntry>;
    readSourceObservation: (...args: Parameters<(actor: Actor, subjectId: string, provider: string, recordId: string) => Promise<import("./entry-personal-model.ts").PersonalEntryObservation | null>>) => Promise<Readonly<{
        provider: string;
        recordId: string;
        revision: number;
        privacy: import("./entry-personal-model.ts").PrivacyFact;
        sourceCreated: import("./entry-personal-model.ts").TimestampFact;
        sourceUpdated: import("./entry-personal-model.ts").TimestampFact;
        recordedAt: string;
    }> | null>;
    saveAnnotations: (...args: Parameters<(actor: Actor, subjectId: string, input: unknown, requestKey: string, admission?: import("./label-command-admission.ts").LabelCommandAdmission) => Promise<import("../command/command.ts").CommandOutcome<Readonly<{
        subjectId: string;
        annotationRevision: number;
        note: string | null;
        priority: number | null;
        annotationUpdatedAt: string | null;
        sourceObservations: readonly import("./entry-personal-model.ts").PersonalEntryObservation[];
    }>>>>) => Promise<import("../command/command.ts").CommandOutcome<Readonly<{
        subjectId: string;
        annotationRevision: number;
        note: string | null;
        priority: number | null;
        annotationUpdatedAt: string | null;
        sourceObservations: readonly import("./entry-personal-model.ts").PersonalEntryObservation[];
    }>>>;
    admitSourceObservation: (...args: Parameters<(actor: Actor, subjectId: string, input: unknown, requestKey: string, internalGuard?: unknown, admission?: import("./label-command-admission.ts").LabelCommandAdmission) => Promise<import("../command/command.ts").CommandOutcome<{
        sourceObservation: Readonly<{
            provider: string;
            recordId: string;
            revision: number;
            privacy: import("./entry-personal-model.ts").PrivacyFact;
            sourceCreated: import("./entry-personal-model.ts").TimestampFact;
            sourceUpdated: import("./entry-personal-model.ts").TimestampFact;
            recordedAt: string;
        }>;
    }>>>) => Promise<import("../command/command.ts").CommandOutcome<{
        sourceObservation: Readonly<{
            provider: string;
            recordId: string;
            revision: number;
            privacy: import("./entry-personal-model.ts").PrivacyFact;
            sourceCreated: import("./entry-personal-model.ts").TimestampFact;
            sourceUpdated: import("./entry-personal-model.ts").TimestampFact;
            recordedAt: string;
        }>;
    }>>;
    correctSourceObservation: (...args: Parameters<(actor: Actor, subjectId: string, input: unknown, requestKey: string, internalGuard?: unknown, admission?: import("./label-command-admission.ts").LabelCommandAdmission) => Promise<import("../command/command.ts").CommandOutcome<{
        sourceObservation: Readonly<{
            provider: string;
            recordId: string;
            revision: number;
            privacy: import("./entry-personal-model.ts").PrivacyFact;
            sourceCreated: import("./entry-personal-model.ts").TimestampFact;
            sourceUpdated: import("./entry-personal-model.ts").TimestampFact;
            recordedAt: string;
        }>;
    }>>>) => Promise<import("../command/command.ts").CommandOutcome<{
        sourceObservation: Readonly<{
            provider: string;
            recordId: string;
            revision: number;
            privacy: import("./entry-personal-model.ts").PrivacyFact;
            sourceCreated: import("./entry-personal-model.ts").TimestampFact;
            sourceUpdated: import("./entry-personal-model.ts").TimestampFact;
            recordedAt: string;
        }>;
    }>>;
    putEntry: (...args: Parameters<(actor: Actor, subjectId: string, input: unknown, requestKey: string, guard?: import('./list-import-bangumi-model.ts').BangumiGuard | VndbEntryReview | ReviewedEntrySource | {
        subjectId: string;
        pin: unknown;
        epoch: string;
    }) => Promise<import("../command/command.ts").CommandOutcome<{
        entry: Entry;
        created: boolean;
    }>>>) => Promise<import("../command/command.ts").CommandOutcome<{
        entry: Entry;
        created: boolean;
    }>>;
    listEntryStateHistory: (actor: Actor, subjectId: string, options?: EntryStateHistoryOptions) => Promise<{
        incarnationId: null;
        currentRevision: number;
        changes: never[];
        coverage: 'unknown';
        next: null;
    } | {
        incarnationId: string;
        currentRevision: number;
        changes: {
            revision: number;
            priorRevision: number | null;
            beforeState: string | null;
            afterState: string;
            commandId: string;
            commandKind: EntryStateCommandKind;
            changedAt: string;
        }[];
        coverage: "complete" | "partial" | "unknown";
        next: string | null;
    }>;
    reviewEntryStateChange: (actor: Actor, subjectId: string, selectedRevision: number) => Promise<{
        change: {
            revision: number;
            priorRevision: number | null;
            beforeState: string | null;
            afterState: string;
            commandId: string;
            commandKind: EntryStateCommandKind;
            changedAt: string;
        };
        current: {
            incarnationId: string | null;
            revision: number;
            state: string;
        };
        availability: "available" | "no_prior_state" | "state_unavailable";
    }>;
    restoreEntryState: (actor: Actor, subjectId: string, selectedRevision: number, input: unknown, requestKey: string) => Promise<import("../command/command.ts").CommandOutcome<{
        entry: Entry;
    }>>;
    deleteEntry: (actor: Actor, subjectId: string, expectedRevision: number, requestKey: string, expectedIncarnationId?: string) => Promise<import("../command/command.ts").CommandOutcome<{
        deletionId: string;
        revision: number;
    } | Entry>>;
    restoreEntry: (actor: Actor, subjectId: string, input: unknown, requestKey: string) => Promise<import("../command/command.ts").CommandOutcome<{
        entry: Entry;
    }>>;
    readEntry: (actor: Actor, subjectId: string) => Promise<Entry>;
    listEntries: (actor: Actor, options?: ListEntryOptions) => Promise<{
        entries: Entry[];
        next: string | null;
    }>;
};
