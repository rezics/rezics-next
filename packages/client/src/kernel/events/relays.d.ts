import type { Pool, PoolClient } from 'pg';
import type { BatchResult } from './log.ts';
type RelayHome = {
    partition_no: number;
    position: string | bigint;
};
export type Relay = {
    consumer: string;
    run(partition: number): Promise<BatchResult>;
    scanPriority?(client: PoolClient): Promise<readonly RelayHome[]>;
};
/** Default in-flight relay homes. A max-one pool shares its only connection; larger pools keep one slot free. */
export declare function relayConcurrencyForPool(pool: Pool): number;
export declare function startRelays(pool: Pool, relays: Relay[], options?: {
    intervalMs?: number;
    concurrency?: number;
    paused?: boolean;
}): {
    pause(): Promise<void>;
    resume(): void;
    stop(): Promise<void>;
};
export {};
