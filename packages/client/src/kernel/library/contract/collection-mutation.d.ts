import type { Collection, CollectionDraft, CollectionChanges } from './collection.ts';
import type { CollectionMetadataField, CollectionMetadataSnapshot } from './collection-history.ts';
import type { WorkDimensions } from './work-dimensions.ts';
type Bound = WorkDimensions & Readonly<{
    engineRequests: number;
}>;
type CollectionMetadataSnapshotInput = CollectionMetadataSnapshot;
type CollectionMetadataFieldInput = CollectionMetadataField;
export type CollectionMetadataHistorySqlPlan<Input = unknown> = Readonly<{
    kind: string;
    input: Readonly<Input>;
    total: Bound;
    withinExistingCeiling: boolean;
}>;
export type CollectionMetadataHistoryCapturePlan = Readonly<{
    kind: 'collection.metadata-history.no-change' | 'collection.metadata-history.capture';
    input: Readonly<{
        route: number;
        before: CollectionMetadataSnapshotInput;
        after: CollectionMetadataSnapshotInput;
        collectionId: string;
        curatorAccountId: string;
        revision: number;
        transactionId: string;
        time: string;
    }>;
    changedFields: readonly CollectionMetadataFieldInput[];
    leaves: Readonly<{
        owner?: CollectionMetadataHistorySqlPlan;
        append?: CollectionMetadataHistorySqlPlan;
        prune?: CollectionMetadataHistorySqlPlan;
        pruned?: CollectionMetadataHistorySqlPlan;
    }>;
    total: Bound;
    withinExistingCeiling: boolean;
}>;
export type CollectionWriteContext = Readonly<{
    transactionId: string;
    time: string;
}>;
export type CollectionHistoryInitializeInput = CollectionWriteContext & Readonly<{
    route: number;
    collection: Pick<CollectionDraft, 'id' | 'curatorAccountId'>;
}>;
export type CollectionHistoryCaptureInput = CollectionWriteContext & Readonly<{
    route: number;
    before: Collection;
    after: Collection;
}>;
/** Native effects execute only on the transaction supplied by the owning command. */
export interface CollectionMutationPorts<Connection> {
    initialize(tx: Connection, input: CollectionHistoryInitializeInput, plan?: CollectionMetadataHistorySqlPlan): Promise<void>;
    planCapture(input: CollectionHistoryCaptureInput): CollectionMetadataHistoryCapturePlan;
    owner(tx: Connection, plan: CollectionMetadataHistorySqlPlan): Promise<void>;
    append(tx: Connection, plan: CollectionMetadataHistorySqlPlan): Promise<number>;
    prune(tx: Connection, plan: CollectionMetadataHistorySqlPlan): Promise<number>;
    pruned(tx: Connection, plan: CollectionMetadataHistorySqlPlan): Promise<void>;
}
export type CollectionCleanupPage = Readonly<{
    status: 'progress' | 'purged' | 'stale' | 'not_due' | 'retained';
    removed: number;
    custody?: 'collection_source_and_destination_disposition' | 'native_source_capture' | 'account_fence';
}>;
export type CollectionDeletionKey = Readonly<{
    route: number;
    collectionId: string;
    accountId: string;
    deletionId: string;
    revision: number;
    purgeAfter: string;
}>;
export type CollectionRetirementEpisode = Readonly<{
    kind: 'deleted';
    deletionId: string;
    revision: number;
    purgeAfter: string;
}> | Readonly<{
    kind: 'terminal';
}>;
export interface CollectionRetentionNativeCapability {
    retireCapture(tx: unknown, input: Readonly<{
        accountId: string;
        collectionId: string;
        episode: CollectionRetirementEpisode;
    }>): Promise<Readonly<{
        status: 'progress' | 'retired';
        removed: number;
    }> | Readonly<{
        status: 'blocked' | 'unavailable';
    }>>;
    purgeSaved(tx: unknown, input: Readonly<{
        accountId: string;
        collectionId: string;
    }>): Promise<CollectionCleanupPage | null>;
}
export interface CollectionMutationApplication<Connection = unknown> {
    initializeHistory(tx: Connection, input: CollectionHistoryInitializeInput, plan?: CollectionMetadataHistorySqlPlan): Promise<void>;
    captureHistory(tx: Connection, input: CollectionHistoryCaptureInput, plan?: CollectionMetadataHistoryCapturePlan): Promise<void>;
    create<T>(tx: Connection, input: CollectionHistoryInitializeInput, write: () => Promise<T>): Promise<T>;
    updateMetadata(tx: Connection, input: CollectionWriteContext & Readonly<{
        route: number;
        before: Collection;
        revision: number;
        changes: CollectionChanges;
    }>, effects: Readonly<{
        write(): Promise<Collection | null>;
        conflict(): never;
        retirePublication(): Promise<void>;
        reducePublicSource(): Promise<void>;
        readCurrent(): Promise<Collection>;
    }>): Promise<Collection>;
    removeRetainedPage(tx: Connection, input: Readonly<{
        publicCustody: boolean;
        sourceCustody: boolean;
    }>, effects: Readonly<{
        retireCapture(): ReturnType<CollectionRetentionNativeCapability['retireCapture']>;
        children: readonly (() => Promise<number>)[];
        removeHead(): Promise<boolean>;
        retireFence(): Promise<void>;
    }>): Promise<CollectionCleanupPage>;
    advancePublication(tx: Connection, expected: 'staging' | 'awaiting_activation', phase: 'awaiting_activation' | 'refused', effects: Readonly<{
        admit(): Promise<boolean>;
        current(): Promise<Readonly<{
            generation: string;
        }> | null>;
        compareAndSet(): Promise<boolean>;
        cancel(generation: string): Promise<void>;
    }>): Promise<boolean>;
    updateRule(tx: Connection, input: Readonly<{
        before: Collection;
        revision: number;
    }>, effects: Readonly<{
        conflict(): never;
        unchanged(): Promise<boolean>;
        write(): Promise<void>;
        retirePublication(): Promise<void>;
        readCurrent(): Promise<Collection>;
        reducePublicSource(): Promise<void>;
    }>): Promise<Readonly<{
        value: Collection;
        changed: boolean;
    }>>;
}
export {};
