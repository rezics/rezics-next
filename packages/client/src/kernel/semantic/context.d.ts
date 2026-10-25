import type { Pool } from 'pg';
import { type ParentAnchor } from '../access/index.ts';
import { type CommandAuthorization } from '../command/command.ts';
import type { AccessCheck, AccountActor, Resource } from '../request/access.ts';
export declare const CREATE_CONTEXT = "context.create";
export declare const globalContextAnchor: ParentAnchor;
/** A server-bound editorial Context anchor. The caller chooses a Context id;
 * this binding fixes its route and verifies the community row on the released
 * authorization connection before Access evaluates the grant at command T.
 */
export declare function editorialContextAnchor(id: string): ParentAnchor;
export declare function contextTarget(routeKey: Uint8Array, accountId: string, idempotencyKey: string): Resource;
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
    actor: AccountActor;
    target: Resource;
    idempotencyKey: string;
    digest: Uint8Array;
    input: unknown;
    settings?: ContextRecord['settings'];
    defaults?: ContextRecord['defaults'];
    authorize?: AccessCheck;
    authorization?: CommandAuthorization;
    deadline?: number;
}): Promise<{
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
export declare function readContext(pool: Pool, id: string, authorize: (client: Parameters<AccessCheck>[0]) => Promise<boolean>): Promise<{
    context: ContextRecord;
    component: {
        partition: number;
        epoch: number;
        position: bigint;
    };
} | null>;
export declare function contextSnapshot(pool: Pool, id: string): Promise<ContextRecord | null>;
export declare function contextLabels(id: string, input: unknown): Record<string, string>;
export declare function publicContextEligibility(resource: Resource): import("../access/eligibility.ts").ResourceEligibility;
