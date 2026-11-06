import type { Pool } from 'pg';
import type { BatchResult } from './log.ts';
export type Relay = {
    consumer: string;
    run(partition: number): Promise<BatchResult>;
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
