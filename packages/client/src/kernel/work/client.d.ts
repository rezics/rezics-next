import { DBOSClient } from '@dbos-inc/dbos-sdk';
import type { Pool } from 'pg';
export declare const DBOS_SCHEMA = "dbos";
export declare const WORK_APPLICATION = "rezics-kernel";
export type WorkClient = DBOSClient & {
    close(): Promise<void>;
};
/** Enqueue without launching an executor. A supplied pool remains the caller's responsibility. */
export declare function createWorkClient(databaseUrl: string, pool?: Pool): Promise<WorkClient>;
