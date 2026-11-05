import type { Pool, PoolClient } from 'pg';
import { type OperationalTransaction } from '../command/operational.ts';
import type { WorkClient } from '../work/client.ts';
import type { FollowTargetType } from './follow-model.ts';
export type CountRuntime = {
    pool: Pool;
    client: WorkClient;
};
export type CountKey = {
    accountId: string;
    targetType: FollowTargetType;
    targetId: string;
};
export type CountReplacement = CountKey & {
    revision: string;
    eligible: boolean;
};
type Client = Pick<PoolClient, 'query'>;
export declare const ZERO_COUNT_KEY = "00000000-0000-0000-0000-000000000000";
export declare function countRoute(id: string): number;
export declare function countTransaction<T>(deps: CountRuntime, route: number, kind: string, body: (tx: OperationalTransaction) => Promise<T>): Promise<T>;
/** The owner counter is the all-writer mutex. Native account share serializes lifecycle;
 * this internal derived operation admits suspended/deleted states without active-account authority. */
export declare function lockCountOwner(tx: Client, accountId: string): Promise<{
    route: number;
    active: boolean;
    terminal: boolean;
}>;
/** Native bootstrap observes finite immutable keys; updates behind its cursor are already
 * represented by the installed trigger. Existing negatives/revisions always win first seeding. */
export declare function bootstrapFollowCountOwner(deps: CountRuntime, accountId: string): Promise<{
    examined: number;
    complete: boolean;
}>;
/** Every target attempt re-reads current source, even a delayed first positive. */
export declare function reconcileFollowCountSource(deps: CountRuntime, key: CountKey): Promise<CountReplacement | null>;
export declare function acknowledgeFollowCount(deps: CountRuntime, replacement: CountReplacement): Promise<void>;
export declare function pendingFollowCountKeys(pool: Pool, partition: number): Promise<CountKey[]>;
export {};
