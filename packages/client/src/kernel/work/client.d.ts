import { DBOSClient } from '@dbos-inc/dbos-sdk';
import { Pool, type PoolClient } from 'pg';
import type { KernelExecutionContract } from '../command/execution-contract.ts';
import { DBOS_SCHEMA, WORK_APPLICATION, type WorkIntent as ContractIntent } from './contract/vocabulary.ts';
export { DBOS_SCHEMA, WORK_APPLICATION };
export type WorkIntent = ContractIntent;
export type WorkClient = DBOSClient & {
    close(): Promise<void>;
    discoverLegacyLeaveChild(workflowId: string): Promise<string | null>;
    readonly executionContract?: KernelExecutionContract;
};
/** Private service composition binding. Matching URLs or a structural client do not enroll. */
export declare function assertSelectedWorkClient(client: WorkClient, pool: Pool): void;
/** Executor internals. The SDK uses this very connection; no pool checkout or relay. */
export declare function enqueueWorkIntent(work: WorkClient, client: PoolClient, intent: WorkIntent, capture?: (created: boolean) => void): Promise<void>;
/** Exact existence probes for the supported durable family. Pre-mapping orphan copies are
 * legacy too; a newly inserted SDK status row cannot retroactively cover their creation. */
export declare function hasRetainedWorkCopies(client: PoolClient, workflowId: string): Promise<boolean>;
/** Enqueue without launching an executor. A supplied pool remains the caller's responsibility. */
export declare function createWorkClient(databaseUrl: string, pool?: Pool): Promise<WorkClient>;
