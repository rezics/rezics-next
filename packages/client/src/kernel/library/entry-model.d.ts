export type EntryState = string;
export type CopyStatus = string;
/** Database projection for one account's entry on a subject. */
export type EntryRow = {
    route: number;
    accountId: string;
    subjectId: string;
    requestedSubjectId: string | null;
    incarnationId: string | null;
    state: string;
    revision: number;
    createdAt: string;
    updatedAt: string;
    transactionId: string;
};
/** Private view of one library entry. State changes only through a revision compare-and-swap. */
export type Entry = Omit<EntryRow, 'route' | 'state' | 'incarnationId'> & {
    state: EntryState;
    incarnationId?: string | null;
};
export type EntryDraft = {
    accountId: string;
    subjectId: string;
    requestedSubjectId: string | null;
    state: EntryState;
};
export type EntryPage = {
    after: {
        updatedAt: string;
        subjectId: string;
    } | null;
    state: EntryState | null;
    limit: number;
};
/** Database projection for one physical copy. Subject is not unique: one edition may have many copies. */
export type CopyRow = {
    route: number;
    copyId: string;
    accountId: string;
    subjectId: string;
    status: string;
    location: string | null;
    source: string | null;
    acquiredOn: string | null;
    disposedOn: string | null;
    note: string | null;
    revision: number;
    createdAt: string;
    updatedAt: string;
    transactionId: string;
};
/** Private view of one copy. `id` is the copy id. */
export type Copy = Omit<CopyRow, 'route' | 'copyId' | 'status'> & {
    id: string;
    status: CopyStatus;
};
export type CopyDraft = {
    id: string;
    accountId: string;
    subjectId: string;
    status: CopyStatus;
    location: string | null;
    source: string | null;
    acquiredOn: string | null;
    disposedOn: string | null;
    note: string | null;
};
export type CopyChanges = Omit<CopyDraft, 'id' | 'accountId' | 'subjectId'>;
export type CopyPage = {
    after: {
        createdAt: string;
        copyId: string;
    } | null;
    limit: number;
};
export declare const MAX_LIBRARY_PAGE_SIZE = 100;
