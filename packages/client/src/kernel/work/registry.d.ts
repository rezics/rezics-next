import type { Pool } from 'pg';
import { type KernelClock } from '../clock.ts';
import { type WorkClient } from './client.ts';
import { type Effect } from '../events/effects.ts';
import { WORK_QUEUES } from './queues.ts';
export type WorkService = {
    stop(): Promise<void>;
};
export type WorkContext = {
    readonly pool: Pool;
    readonly queues: typeof WORK_QUEUES;
    readonly client: WorkClient;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly clock: KernelClock;
    addEffects(effects: Effect[]): void;
    addService(start: () => WorkService | Promise<WorkService>): void;
};
export type WorkModule = {
    name: string;
    register(context: WorkContext): void | Promise<void>;
};
export type WorkOptions = {
    databaseUrl: string;
    executorId?: string;
    pool: Pool;
    client: WorkClient;
    env?: Readonly<Record<string, string | undefined>>;
    /** Trusted service composition only. */
    clock?: KernelClock;
};
/** Registration owns the process-global SDK once. Pools and clients belong to the caller. */
export declare function composeWork(modules: readonly WorkModule[], options: WorkOptions): Promise<{
    effects: {
        enqueue(envelopes: readonly import("../events/log.ts").Envelope[]): Promise<void>;
    };
    launch(): Promise<void>;
    shutdown(): Promise<void>;
}>;
