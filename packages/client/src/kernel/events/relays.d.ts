import type { Pool } from 'pg';
import type { BatchResult } from './log.ts';
export type Relay = {
    consumer: string;
    run(partition: number): Promise<BatchResult>;
};
export declare function startRelays(pool: Pool, relays: Relay[], options?: {
    intervalMs?: number;
    concurrency?: number;
    paused?: boolean;
}): {
    pause(): Promise<void>;
    resume(): void;
    stop(): Promise<void>;
};
