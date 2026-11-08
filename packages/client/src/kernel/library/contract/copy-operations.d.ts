import type { WorkDimensions } from './work-dimensions.ts';
export type CopyBound = WorkDimensions & Readonly<{
    engineRequests: number;
}>;
export type CopyOperationComponent = Readonly<{
    kind: string;
    bound: CopyBound;
}>;
export type CopyOperationPlan = Readonly<{
    kind: string;
    branch: string;
    input: Readonly<Record<string, unknown>>;
    components: readonly CopyOperationComponent[];
    branches: Readonly<Record<string, CopyBound>>;
    total: CopyBound;
}>;
export type CopyMutationOperation = 'create' | 'update' | 'delete' | 'restore';
export type CopyMutationOperationInput = Readonly<{
    route: number;
    accountId: string;
    copyId: string;
    requestKey: string;
    receiptKeys: number;
    clientId: string;
    requestedBy: string | null;
    durationMs: number;
    commandInput: unknown;
    subjectId?: string | undefined;
    revision?: number | undefined;
    deletionId?: string | undefined;
    kind?: string | undefined;
    status?: string | undefined;
    location?: string | null | undefined;
    source?: string | null | undefined;
    acquiredOn?: string | null | undefined;
    disposedOn?: string | null | undefined;
    note?: string | null | undefined;
    mediaCondition?: unknown;
    packagingCondition?: unknown;
}>;
export type CopyInventoryOperationInput = Readonly<{
    route: number;
    accountId: string;
    limit: number;
    subjectId: string | null;
    kind: string | null;
    status: string | null;
    cursor: string | null;
}>;
/** Static native leaves supplied before I/O. Outcome alternatives share one retained operation envelope. */
export type CopyMutationWork = Readonly<{
    shared: readonly CopyOperationComponent[];
    prepareRead: CopyBound;
    sourceInitial: CopyBound;
    sourceCurrent: CopyBound;
    lock: CopyBound;
    loan: CopyBound;
    read: CopyBound;
    currentFact: CopyBound;
    mutation: CopyBound;
    trigger: CopyBound;
    privateRead: CopyBound;
    retentionRead: CopyBound;
    retainedReleases: CopyBound;
    restoreSource: CopyBound;
    eventFence: CopyBound;
    terminal: CopyBound;
}>;
/** Native owners supply static work descriptions; planning never loads their runners. */
export interface CopyOperationWork {
    account: {
        floor(route: number, accountId: string): CopyBound;
        share(route: number, accountId: string): CopyBound;
        command(route: number, accountId: string): CopyBound;
    };
    sessionPartitionWork(partition: number): CopyBound;
    sessionProfileMigrationWork(route: number, accountId: string): CopyBound;
    sessionReadTimeWork(): CopyBound;
    sessionReleaseWork(digest: string, active?: boolean): CopyBound;
    sessionShelfWork(route: number, accountId: string, counters: boolean): CopyBound;
    sessionSourceWork(subjectId: string, withProfile: boolean): CopyBound;
}
