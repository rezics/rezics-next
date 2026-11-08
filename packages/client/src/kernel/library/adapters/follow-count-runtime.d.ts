import type { Pool } from 'pg';
import { type OperationalTransaction } from '../../command/operational.ts';
import type { WorkClient } from '../../work/client.ts';
import type { FollowCountRuntime } from '../contract/index.ts';
export declare function followCountRuntime(): FollowCountRuntime;
export declare function workStepDeadline(): number;
export type CountRuntime = {
    pool: Pool;
    client: WorkClient;
};
export declare const ZERO_COUNT_KEY = "00000000-0000-0000-0000-000000000000";
export declare function countRoute(id: string): number;
export declare function countTransaction<T>(deps: CountRuntime, route: number, kind: string, body: (tx: OperationalTransaction) => Promise<T>): Promise<T>;
