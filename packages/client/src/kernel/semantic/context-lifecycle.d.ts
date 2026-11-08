import type { Pool } from 'pg';
import { type ContextAccessPort, type ContextAccessHandle, type ContextAccountActor } from './context-access-port.ts';
export declare class ContextLifecycleConflictError extends Error {
    constructor();
}
/** Lifecycle commands authorize the stable identity, including its tombstone. Normal readers use active anchors. */
export declare function changeContextLifecycle(pool: Pool, options: {
    context: string;
    state: 'active' | 'deleted';
    actor: ContextAccountActor;
    access: ContextAccessHandle;
    idempotencyKey: string;
    digest: Uint8Array;
    deadline: number;
    clock: () => Date;
}, accessPort?: ContextAccessPort): Promise<{
    context: {
        id: string;
        state: "active" | "deleted";
    };
    component: {
        partition: number;
        epoch: number;
        position: bigint;
    };
    replayed: boolean;
}>;
