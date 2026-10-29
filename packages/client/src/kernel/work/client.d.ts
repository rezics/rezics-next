import { DBOSClient } from '@dbos-inc/dbos-sdk';
import { Pool, type PoolClient } from 'pg';
import { type WorkQueueName } from './queues.ts';
export declare const DBOS_SCHEMA = "dbos";
export declare const WORK_APPLICATION = "rezics-kernel";
export type WorkClient = DBOSClient & {
    close(): Promise<void>;
};
export type WorkIntent = Readonly<{
    queue: WorkQueueName;
    workflowName: string;
    workflowId: string;
    /** Locators only; consumer modules own their input schema. */
    input: Readonly<{
        accounts: readonly string[];
        [locator: string]: unknown;
    }>;
}>;
/** Executor internals. The SDK uses this very connection; no pool checkout or relay. */
export declare function enqueueWorkIntent(work: WorkClient, client: PoolClient, intent: WorkIntent): Promise<void>;
/** Enqueue without launching an executor. A supplied pool remains the caller's responsibility. */
export declare function createWorkClient(databaseUrl: string, pool?: Pool): Promise<WorkClient>;
