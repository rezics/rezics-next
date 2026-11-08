/** Progress operation vocabulary and Library-owned producer catalogs. No SQL, Pool or foreign modules. */
import type { NestedAdmissionAccount } from './membership.ts';
import type { GrantedAccount, LibraryActor } from './actors.ts';
import type { WorkDimensions } from './work-dimensions.ts';
export declare const SESSION_LIMITS: Readonly<{
    page: 100;
    ownerPage: 50;
    measures: 8;
    unitWrite: 100;
    units: 20000;
}>;
export type SessionSqlKind = 'insert' | 'read' | 'update' | 'lock' | 'subject-page' | 'journal-read' | 'journal-lock' | 'journal-update' | 'unit-add' | 'unit-remove' | 'unit-clear' | 'unit-page' | 'change-append' | 'change-page' | 'owner-page' | 'owner-generation' | 'discovery-releases' | 'meaning-insert' | 'meaning-refresh';
export type SessionOperationKind = 'start' | 'record' | 'complete' | 'abandon' | 'reopen' | 'retire' | 'journal';
export type SessionReadKind = 'read' | 'inspect' | 'journal-read' | 'presentation' | 'subject-page' | 'owner-page' | 'owner-current' | 'unit-page' | 'change-page';
/** Nine-axis closed work. engineRequests stays 0: these leaves issue SQL only. */
export type SessionWork = WorkDimensions & {
    readonly engineRequests: 0;
};
export type ProgressSqlDescriptor = Readonly<{
    sql: string;
    params?: readonly string[];
    nativeRows: number;
    nativePoints: number;
    identityMetadataRows: number;
    resultBytes: number;
}>;
export type ProgressShelfStatement = 'gate-read' | 'gate-ensure' | 'gate-lock' | 'gate-share' | 'gate-save' | 'inputs' | 'run-create' | 'run-read' | 'step-save' | 'counter-initialize' | 'counter-read' | 'counter-complete' | 'head-ensure' | 'head-touch' | 'entry-raise';
export type ProgressSessionSqlCatalog = Readonly<{
    insert: string;
    read: string;
    update: string;
    lock: string;
    journalRead: string;
    journalLock: string;
    journalUpdate: string;
    unitAdd: string;
    unitRemove: string;
    unitClear: string;
    unitPage: string;
    changeAppend: string;
    changePage: string;
    subjectPage: string;
    ownerPage: string;
    ownerGeneration: string;
    discoveryReleases: string;
    meaningInsert: string;
    meaningRefresh: string;
    profileMigration: string;
}>;
export type ProgressAccessSqlCatalog = Readonly<{
    accountRead: ProgressSqlDescriptor;
    accountShare: ProgressSqlDescriptor;
}>;
export type ProgressSemanticSqlCatalog = Readonly<{
    releaseExists: ProgressSqlDescriptor;
    releaseRead: ProgressSqlDescriptor;
    releaseActive: ProgressSqlDescriptor;
    mappingOwners: ProgressSqlDescriptor;
    mappingSources: ProgressSqlDescriptor;
    mappingPending: ProgressSqlDescriptor;
    mappingCurrent: ProgressSqlDescriptor;
    subjectReference: ProgressSqlDescriptor;
    itemTypes: ProgressSqlDescriptor;
}>;
export type ProgressCommandSqlCatalog = Readonly<{
    receiptRead: string;
    eventFence: string;
    noEffectFence: string;
    timeRead: string;
    partitionRead: string;
}>;
export type ProgressOperationCatalog = Readonly<{
    releaseBytes: number;
    session: ProgressSessionSqlCatalog;
    access: ProgressAccessSqlCatalog;
    semantic: ProgressSemanticSqlCatalog;
    command: ProgressCommandSqlCatalog;
    shelf: Readonly<{
        plan(statement: ProgressShelfStatement, values: readonly unknown[], valueBytes: number): SessionWork;
    }>;
}>;
export type SessionCommandOriginal = Readonly<{
    accountId: string;
    clientId: string;
    requestedBy: string | null;
    kind: string;
    key: string;
    input: unknown;
}>;
export type SessionReadInput = Readonly<{
    targetId?: string;
    versionSubjectId?: string | null;
    limit?: number;
    cursor?: string;
}>;
export type SessionCommandDeclaration = Readonly<{
    kind: SessionOperationKind;
    original: SessionCommandOriginal;
    total: SessionWork;
}>;
export type SessionReadDeclaration = Readonly<{
    kind: SessionReadKind;
    original: SessionReadInput;
    total: SessionWork;
}>;
export type ProgressOperationAdmission = Readonly<{
    admitted: boolean;
    actor: LibraryActor;
    deadline: number;
    original: string | null;
    terminal: string | null;
    admission: NestedAdmissionAccount;
}>;
export type ProgressOperationApplication = Readonly<{
    catalog: ProgressOperationCatalog;
    admit(input: {
        actor: LibraryActor;
        deadline: number;
        subjectId?: string;
        at?: unknown;
        account?: GrantedAccount;
    }): Promise<ProgressOperationAdmission>;
    planCommand(kind: SessionOperationKind, original: SessionCommandOriginal, receiptKeys: number, preparesSource?: boolean, durationMs?: number): SessionCommandDeclaration;
    planRead(kind: SessionReadKind, accountId: string, input: SessionReadInput): SessionReadDeclaration;
    snapshotWork(accountId: string): SessionWork;
    partitionWork(partition: number): SessionWork;
    releaseWork(digest: string, active?: boolean): SessionWork;
    sourceWork(subjectId: string, withProfile: boolean): SessionWork;
    headWork(input: {
        route: number;
        account_id: string;
        subject_id: string;
    }): SessionWork;
    activityWork(input: {
        route: number;
        account_id: string;
        subject_id: string;
        time: string;
        completed: boolean;
    }): SessionWork;
    shelfWork(route: number, accountId: string, counters: boolean): SessionWork;
    profileMigrationWork(route: number, accountId: string): SessionWork;
    readTimeWork(): SessionWork;
    presentationWork(measures: number, sessions?: number): SessionWork;
    coreCommandAttemptWork(kind: string, accountId: string, receiptKeys: number, response: object): SessionWork;
}>;
export declare function emptySessionWork(): SessionWork;
/** Zero catalog for fake-capability applications. Ordinary composition replaces every leaf. */
export declare function emptyProgressOperationCatalog(): ProgressOperationCatalog;
