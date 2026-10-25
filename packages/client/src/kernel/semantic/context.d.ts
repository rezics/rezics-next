import type { Pool } from 'pg';
import type { Access, AccessCheck, AccountActor, Resource } from '../request/access.ts';
export declare const CREATE_CONTEXT = "context.create";
export declare const COMMUNITY_CONTEXT_TYPE = "semantic.community";
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
};
export declare function createContext(pool: Pool, options: {
    actor: AccountActor;
    target: Resource;
    idempotencyKey: string;
    digest: Uint8Array;
    input: unknown;
    access: Access;
    deadline?: number;
}): Promise<{
    context: {
        id: string;
        kind: 'community';
        labels: Record<string, string>;
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
export declare function contextLabels(id: string, input: unknown): Record<string, string>;
export declare function publicContextEligibility(resource: Resource): import("../access/eligibility.ts").ResourceEligibility;
