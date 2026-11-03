import type { Pool } from 'pg';
import { type CommandEvent, type CommandTransaction, type AuthoritativeTime } from '../command/command.ts';
import type { KernelClock } from '../clock.ts';
import type { Access, AccountActor, Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { type ShelfTypeDigest } from './shelf-type-keys.ts';
import type { Entry, EntryState, EntryDeletion } from './entry-model.ts';
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
export declare class LibraryEntryInvalidError extends TypeError {
    constructor(message?: string);
}
export declare class LibraryConflictError extends Error {
    constructor();
}
export declare class LibraryEntryLifecycleConflictError extends LibraryConflictError {
    readonly reason: 'stale' | 'occupied' | 'expired';
    constructor(reason: 'stale' | 'occupied' | 'expired');
}
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
    putEntry: (...args: Parameters<(actor: Actor, subjectId: string, input: unknown, requestKey: string, guard?: import('./list-import-bangumi-model.ts').BangumiGuard | ReviewedEntrySource) => Promise<import("../command/command.ts").CommandOutcome<{
        entry: Entry;
        created: boolean;
    }>>>) => Promise<import("../command/command.ts").CommandOutcome<{
        entry: Entry;
        created: boolean;
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
export {};
