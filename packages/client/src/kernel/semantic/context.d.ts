import type { Pool } from 'pg';
import { type CommandAuthorization } from '../command/command.ts';
import { CONTEXT_GLOBAL_ID } from './context-literals.ts';
import type { ResourceEligibility } from '../access/index.ts';
import { type ContextAccessPort, type ContextAccountActor, type ContextParentAnchor, type ContextQueryClient, type ContextResource } from './context-access-port.ts';
export declare const CREATE_CONTEXT = "context.create";
export { CONTEXT_GLOBAL_ID };
export declare const globalContextAnchor: ContextParentAnchor;
/** A server-bound editorial Context anchor. The caller chooses a Context id;
 * this binding fixes its route and verifies the community row on the released
 * authorization connection before Access evaluates the grant at command T.
 */
export declare function editorialContextAnchor(id: string): ContextParentAnchor;
export declare function contextTarget(routeKey: Uint8Array, accountId: string, idempotencyKey: string): ContextResource;
export declare class ContextAccessDeniedError extends Error {
    constructor();
}
export declare class ContextNotFoundError extends Error {
    constructor();
}
export type ContextRecord = {
    id: string;
    kind: 'community' | 'global';
    labels: Record<string, string>;
    settings: {
        id: string;
        release: string;
    } | null;
    defaults: Record<string, 'inherit' | 'suppress'>;
};
export declare function createContext(pool: Pool, options: {
    actor: ContextAccountActor;
    target: ContextResource;
    idempotencyKey: string;
    digest: Uint8Array;
    input: unknown;
    settings?: ContextRecord['settings'];
    defaults?: ContextRecord['defaults'];
    authorize?: (client: ContextQueryClient, time?: unknown) => Promise<boolean>;
    authorization?: CommandAuthorization;
    deadline?: number;
    clock?: () => Date;
}, accessPort?: ContextAccessPort): Promise<{
    context: {
        id: string;
        kind: 'community';
        labels: Record<string, string>;
        settings: {
            id: string;
            release: string;
        } | null;
        defaults: Record<string, "inherit" | "suppress">;
    };
    component: {
        partition: number;
        epoch: number;
        position: bigint;
    };
    replayed: boolean;
}>;
export declare function readContext(pool: Pool, id: string, authorize: (client: ContextQueryClient) => Promise<boolean>, accessPort?: ContextAccessPort): Promise<{
    context: ContextRecord;
    component: {
        partition: number;
        epoch: number;
        position: bigint;
    };
} | null>;
export declare function contextSnapshot(pool: Pool, id: string, accessPort?: ContextAccessPort): Promise<ContextRecord | null>;
export declare function contextLabels(id: string, input: unknown): Record<string, string>;
export declare function publicContextEligibility(resource: ContextResource, accessPort?: ContextAccessPort): ResourceEligibility;
