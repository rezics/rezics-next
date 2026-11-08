import type { PoolClient } from 'pg';
import type { CopyOperationWork } from './contract/index.ts';
import type { EntryShelfWrite, HeadSnapshot } from './shelf-contract.ts';
import type { LibraryProfilePin } from './profile.ts';
import { type Copy, type CopyChanges, type CopyDraft, type CopyPage, type Entry, type EntryDraft, type EntryPage, type EntryState } from './entry-model.ts';
type Client = Pick<PoolClient, 'query'>;
type ProfileReadWork = CopyOperationWork['sessionProfileMigrationWork'];
type WriteContext = {
    transactionId: string;
    time: string;
};
type CopyAcceptance = Readonly<{
    pin: LibraryProfilePin;
    kind: string;
    statusSupplied?: boolean;
}>;
export declare function insertEntry(client: Client, route: number, entry: EntryDraft, context: WriteContext, pin?: LibraryProfilePin, shelf?: EntryShelfWrite & {
    head: HeadSnapshot;
}): Promise<Entry>;
export declare function readEntry(client: Client, route: number, accountId: string, subjectId: string): Promise<Entry | null>;
export declare function readEntryFact(client: Client, route: number, accountId: string, subjectId: string): Promise<{
    entry: Entry;
    pin: LibraryProfilePin | null;
} | null>;
export declare function updateEntryState(client: Client, route: number, accountId: string, subjectId: string, revision: number, state: EntryState, context: WriteContext, pin?: LibraryProfilePin, expectedIncarnationId?: string): Promise<Entry | null>;
export declare function deleteEntry(client: Client, route: number, accountId: string, subjectId: string, revision: number, expectedIncarnationId?: string): Promise<Entry | null>;
export declare function pageEntries(client: Client, route: number, accountId: string, page: EntryPage): Promise<Entry[]>;
export declare function insertCopy(client: Client, route: number, copy: CopyDraft, context: WriteContext, accepted?: CopyAcceptance): Promise<Copy>;
export declare function readCopy(client: Client, route: number, copyId: string, profileReadWork?: ProfileReadWork): Promise<Copy | null>;
/** Read the exact stored fact without resolving or revalidating current definitions. */
export declare function readCopyFact(client: Client, route: number, copyId: string): Promise<{
    copy: Copy;
    pin: LibraryProfilePin | null;
    kind: string | null;
} | null>;
export declare function updateCopy(client: Client, route: number, copyId: string, revision: number, changes: CopyChanges, context: WriteContext, accepted?: CopyAcceptance): Promise<Copy | null>;
export declare function deleteCopy(client: Client, route: number, copyId: string, revision: number, context: WriteContext): Promise<Copy | null>;
export declare function pageCopies(client: Client, route: number, accountId: string, page: CopyPage, subjectId?: string | null, kind?: string | null, status?: string | null, profileReadWork?: ProfileReadWork): Promise<Copy[]>;
export {};
