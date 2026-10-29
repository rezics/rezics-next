import { type Pool } from 'pg';
import type { Relay } from './relays.ts';
import { type CloudEvent, type Envelope } from './log.ts';
export { DBOS_SCHEMA } from '../work/client.ts';
export declare const EFFECTS_QUEUE = "effects";
export declare const EFFECTS_CONSUMER = "effects";
export type Effect = {
    name: string;
    types: string[];
    run(event: CloudEvent): Promise<void>;
};
type WorkOptions = {
    databaseUrl: string;
    executorId?: string;
    systemDatabasePool?: Pool;
};
export declare function effectWorkflowId(envelope: Envelope, eventSeq: number, name: string): string;
export declare function registerEffects(effects: Effect[], pool?: Pool): {
    enqueue(envelopes: readonly Envelope[]): Promise<void>;
};
/** Compatibility for tests that register effects before launching the shared executor. */
export declare function launchWork(options: WorkOptions): Promise<void>;
export declare function shutdownWork(): Promise<void>;
/** A batch failing after enqueuing is read again and finds the workflows it started. */
export declare function relayEffects(pool: Pool, effects: ReturnType<typeof registerEffects>, partition: number): Promise<import("./log.ts").BatchResult>;
export declare function effectsRelay(pool: Pool, effects: ReturnType<typeof registerEffects>): Relay;
