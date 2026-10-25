import type { Pool, PoolClient } from 'pg';
export type AccountActor = {
    kind: 'account';
    accountId: string;
    clientId: string;
    scopes: readonly string[];
    requestedBy: string | null;
    authnEpoch: number;
};
export type Actor = AccountActor | {
    kind: 'anonymous';
};
export type Resource = {
    route: number;
    id: string;
};
export type ActionCatalogue = ReadonlyMap<string, {
    anonymous: boolean;
}>;
export type AccessContext = {
    pool: Pool;
    deadline: number;
};
export type AccessClient = Pick<PoolClient, 'query'>;
export interface Access {
    authenticate(token: string, context: AccessContext): Promise<AccountActor>;
    prepare?(actor: Actor, action: string, resource: Resource, context: AccessContext): Promise<unknown>;
    authorize(client: AccessClient, actor: Actor, action: string, resource: Resource, evidence?: unknown): Promise<boolean>;
}
export declare function accessCheck(access: Access, actor: Actor, action: string, resource: Resource, context: AccessContext): Promise<(client: AccessClient) => Promise<boolean>>;
export declare class AuthenticationError extends Error {
    readonly status: 400 | 401;
    readonly challenge: string;
    constructor(status: 400 | 401, challenge: string);
}
export declare function actorOf(access: Access, request: Request, context: AccessContext): Promise<Actor>;
export declare const anonymousAccess: Access;
