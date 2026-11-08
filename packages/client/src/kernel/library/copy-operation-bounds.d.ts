import { type Bound } from '@rezics/bounds';
import type { PoolClient } from 'pg';
export { bindCopyCommandOperation, consumeCopyCommandAttempt, executeCopyOperation, executeCopyStatementWork, copyWorkDimensions, } from './copy-operation-runtime.ts';
import copyDelete from './entry-store-copy-delete.sql.d.ts';
import copyInsert from './entry-store-copy-insert.sql.d.ts';
import copyPage from './entry-store-copy-page.sql.d.ts';
import copyRead from './entry-store-copy-read.sql.d.ts';
import copyUpdate from './entry-store-copy-update.sql.d.ts';
import copyInventoryOptions from './copy-inventory-options.sql.d.ts';
import copyDetailRead from './copy-store-read.sql.d.ts';
import copyRetentionRead from './copy-retention-read.sql.d.ts';
import copyRetentionRestore from './copy-retention-restore.sql.d.ts';
import type { CopyOperationWork, CopyOperationPlan, CopyMutationOperation, CopyMutationOperationInput, CopyInventoryOperationInput } from './contract/index.ts';
export { MAX_COPY_FILTER_OPTIONS, COPY_FILTER_OPTION_QUERY_LIMIT, MAX_COPY_FILTER_OPTIONS_BYTES, } from './contract/index.ts';
export type { CopyOperationComponent, CopyOperationPlan, CopyMutationOperation, CopyMutationOperationInput, CopyInventoryOperationInput, } from './contract/index.ts';
type CopyQueryClient = Pick<PoolClient, 'query'>;
type QueryModule<Client, Input extends object, Result> = Readonly<{
    sql: string;
    run(client: Client, input: Input): Promise<Result>;
}>;
export type CopyStatementPlan<Client, Input extends object, Result> = Readonly<{
    kind: string;
    input: Readonly<Input>;
    bound: Bound;
    run(client: Client): Promise<Result>;
}>;
type WorkShape = Readonly<{
    candidateKeys: number;
    nativeRows: number;
    projectionRows?: number;
    identityMetadataRows?: number;
    emptySeeks: number;
    nativePoints: number;
    witnessKeys?: number;
}>;
/**
 * Bind one exact compiled SQL leaf to the operands sent through the existing
 * store. SQL, serialized operands and worst-case projected rows stay separate
 * terms; no returned-row observation reprices this declaration.
 */
export declare function copyStatementPlan<Client, Input extends object, Result>(kind: string, query: QueryModule<Client, Input, Result>, input: Input, shape: WorkShape, projection: unknown, releaseIdentifiers?: number): CopyStatementPlan<Client, Input, Result>;
type CopyPageInput = {
    route: number;
    account_id: string;
    after_created_at: string | null;
    after_copy_id: string | null;
    limit: number;
};
type CopyFilteredPageInput = CopyPageInput & {
    subject_id?: string;
    kind?: string;
    status?: string;
};
type CopyPageResult = Awaited<ReturnType<typeof copyPage.run>>;
type CopyPagePlan = Readonly<{
    input: Readonly<CopyFilteredPageInput>;
    bound: Bound;
    run(client: Parameters<typeof copyPage.run>[0]): Promise<CopyPageResult>;
}>;
/** Select the same closed SQL branch as EntryStore.pageCopies and retain its raw key frontier. */
export declare function copyPageStatementPlan(input: CopyPageInput, subjectId: string | null, kind: string | null, status: string | null): CopyPagePlan;
type InventoryOptionsInput = {
    route: number;
    account_id: string;
    limit: number;
};
export declare function copyInventoryValuesStatementPlan(input: InventoryOptionsInput): CopyStatementPlan<Parameters<typeof copyInventoryOptions.run>[0], InventoryOptionsInput, Awaited<ReturnType<typeof copyInventoryOptions.run>>>;
export declare const copySingleRowWork: Readonly<{
    candidateKeys: 1;
    nativeRows: 1;
    emptySeeks: 1;
    nativePoints: 1;
}>;
export declare const copyMutationWork: Readonly<{
    candidateKeys: 1;
    nativeRows: 1;
    emptySeeks: 1;
    nativePoints: 1;
}>;
export declare const copyRetentionRestoreWork: Readonly<{
    candidateKeys: 2;
    nativeRows: 2;
    emptySeeks: 2;
    nativePoints: 2;
}>;
export declare function copyInsertStatementPlan(input: Parameters<typeof copyInsert.run>[1]): Readonly<{
    kind: string;
    input: Readonly<{
        time: string;
        library_profile_pin?: import("reylo").Json;
        route: number;
        copy_id: string;
        account_id: string;
        subject_id: string;
        status: string;
        location?: string | null;
        source?: string | null;
        acquired_on?: string | null;
        disposed_on?: string | null;
        note?: string | null;
        transaction_id: string;
        kind?: string | null;
        media_condition?: import("reylo").Json;
        packaging_condition?: import("reylo").Json;
    }>;
    bound: Bound;
    run(client: import("reylo").PostgresClient): Promise<{
        route: number;
        id: string;
        accountId: string;
        subjectId: string;
        kind: string | null;
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
        mediaCondition: import("reylo").Json;
        packagingCondition: import("reylo").Json;
    }[]>;
}>;
export declare function copyReadStatementPlan(input: Parameters<typeof copyRead.run>[1]): Readonly<{
    kind: string;
    input: Readonly<{
        route: number;
        copy_id: string;
    }>;
    bound: Bound;
    run(client: import("reylo").PostgresClient): Promise<{
        route: number;
        id: string;
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
        kind: string | null;
        libraryProfilePin: import("reylo").Json;
        mediaCondition: import("reylo").Json;
        packagingCondition: import("reylo").Json;
    } | null>;
}>;
export declare function copyUpdateStatementPlan(input: Parameters<typeof copyUpdate.run>[1]): Readonly<{
    kind: string;
    input: Readonly<{
        status: string;
        location?: string | null;
        source?: string | null;
        acquired_on?: string | null;
        disposed_on?: string | null;
        note?: string | null;
        time: string;
        transaction_id: string;
        library_profile_pin?: import("reylo").Json;
        media_condition?: import("reylo").Json;
        packaging_condition?: import("reylo").Json;
        route: number;
        copy_id: string;
        revision: number;
    }>;
    bound: Bound;
    run(client: import("reylo").PostgresClient): Promise<{
        route: number;
        id: string;
        accountId: string;
        subjectId: string;
        kind: string | null;
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
        mediaCondition: import("reylo").Json;
        packagingCondition: import("reylo").Json;
    } | null>;
}>;
export declare function copyDeleteStatementPlan(input: Parameters<typeof copyDelete.run>[1]): Readonly<{
    kind: string;
    input: Readonly<{
        time: string;
        deletion_id: string;
        route: number;
        copy_id: string;
        revision: number;
    }>;
    bound: Bound;
    run(client: import("reylo").PostgresClient): Promise<{
        route: number;
        id: string;
        accountId: string;
        subjectId: string;
        kind: string | null;
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
    }[]>;
}>;
export declare function copyDetailReadStatementPlan(input: Parameters<typeof copyDetailRead.run>[1]): Readonly<{
    kind: string;
    input: Readonly<{
        route: number;
        copy_id: string;
        account_id: string;
    }>;
    bound: Bound;
    run(client: import("reylo").PostgresClient): Promise<{
        id: string;
        accountId: string;
        subjectId: string;
        kind: string | null;
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
        libraryProfilePin: import("reylo").Json;
        kindProfilePin: import("reylo").Json;
        statusProfilePin: import("reylo").Json;
        mediaCondition: import("reylo").Json;
        packagingCondition: import("reylo").Json;
    } | null>;
}>;
export declare function copyRetentionReadStatementPlan(input: Parameters<typeof copyRetentionRead.run>[1]): Readonly<{
    kind: string;
    input: Readonly<{
        time: string;
        route: number;
        copy_id: string;
        account_id: string;
    }>;
    bound: Bound;
    run(client: import("reylo").PostgresClient): Promise<{
        id: string;
        accountId: string;
        subjectId: string;
        kind: string | null;
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
        libraryProfilePin: import("reylo").Json;
        deletionId: string | null;
        deletedAt: string | null;
        restoreUntil: string | null;
        expired: boolean | null;
    } | null>;
}>;
export declare function copyRetentionRestoreStatementPlan(input: Parameters<typeof copyRetentionRestore.run>[1]): Readonly<{
    kind: string;
    input: Readonly<{
        route: number;
        account_id: string;
        transaction_id: string;
        copy_id: string;
        deletion_id: string;
        revision: number;
        time: string;
    }>;
    bound: Bound;
    run(client: import("reylo").PostgresClient): Promise<{
        id: string;
    }[]>;
}>;
export type CopyPrivateReadInput = {
    route: number;
    copy_id: string;
    account_id: string;
};
export type CopyPrivateReadRow = {
    subject_id: string;
    kind: string | null;
    status: string;
    library_profile_pin: unknown;
    kind_profile_pin: unknown;
    status_profile_pin: unknown;
};
export declare function copyPrivateReadStatementPlan(input: CopyPrivateReadInput): Readonly<{
    kind: string;
    input: Readonly<CopyPrivateReadInput>;
    bound: Bound;
    run(client: CopyQueryClient): Promise<CopyPrivateReadRow | undefined>;
}>;
/** Construct plans from static supplied account/source work, independently of SQL execution. */
export declare function createCopyOperationPlans(work: CopyOperationWork): {
    mutation: (operation: CopyMutationOperation, input: CopyMutationOperationInput) => CopyOperationPlan;
    gate: (route: number, accountId: string) => CopyOperationPlan;
    read: (route: number, accountId: string, copyId: string) => CopyOperationPlan;
    presentation: (route: number, accountId: string, copyId: string, subjectId: string) => CopyOperationPlan;
    inventory: (input: CopyInventoryOperationInput) => CopyOperationPlan;
};
/** Compatibility callers share the installed native catalog. Applications retain their own supplied catalog. */
export declare const copyMutationOperationPlan: ReturnType<typeof createCopyOperationPlans>['mutation'];
export declare const copyAccountGatePlan: ReturnType<typeof createCopyOperationPlans>['gate'];
export declare const copyReadOperationPlan: ReturnType<typeof createCopyOperationPlans>['read'];
export declare const copyPresentationOperationPlan: ReturnType<typeof createCopyOperationPlans>['presentation'];
export declare const copyInventoryOperationPlan: ReturnType<typeof createCopyOperationPlans>['inventory'];
export declare const copyProfileMigrationWork: CopyOperationWork['sessionProfileMigrationWork'];
