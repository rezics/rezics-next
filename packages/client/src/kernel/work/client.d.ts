import { DBOSClient } from '@dbos-inc/dbos-sdk';
import { Pool, type PoolClient } from 'pg';
import { type WorkQueueName } from './queues.ts';
export declare const DBOS_SCHEMA = "dbos";
export declare const WORK_APPLICATION = "rezics-kernel";
export type WorkClient = DBOSClient & {
    close(): Promise<void>;
    discoverLegacyLeaveChild(workflowId: string): Promise<string | null>;
};
/** Private service composition binding. Matching URLs or a structural client do not enroll. */
export declare function assertSelectedWorkClient(client: WorkClient, pool: Pool): void;
export type WorkIntent = Readonly<{
    queue: WorkQueueName;
    workflowName: string;
    workflowId: string;
    /** Locators only; consumer modules own their input schema. */
    input: Readonly<{
        accounts: readonly string[];
        [locator: string]: unknown;
    }>;
    /** Original positional SDK arguments, when the existing workflow predates scoped work. */
    arguments?: readonly unknown[];
    /** Native queue controls; deduplication spans the entire queue, including partitions. */
    queuePartitionKey?: string;
    deduplicationID?: string;
    priority?: number;
    delaySeconds?: number;
}>;
/** Executor internals. The SDK uses this very connection; no pool checkout or relay. */
export declare function enqueueWorkIntent(work: WorkClient, client: PoolClient, intent: WorkIntent, capture?: (created: boolean) => void): Promise<void>;
/** Exact existence probes for the supported durable family. Pre-mapping orphan copies are
 * legacy too; a newly inserted SDK status row cannot retroactively cover their creation. */
export declare function hasRetainedWorkCopies(client: PoolClient, workflowId: string): Promise<boolean>;
/** Enqueue without launching an executor. A supplied pool remains the caller's responsibility. */
export declare function createWorkClient(databaseUrl: string, pool?: Pool): Promise<WorkClient>;
