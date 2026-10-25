import type { Pool, PoolClient } from 'pg';
import type { ResourceRoleCatalogue } from '../access/resource-roles.ts';
import { type AuthoritativeTime, type CommandAuthorization } from '../command/command.ts';
import type { ResourceEligibility } from '../access/eligibility.ts';
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
    eligibility?: ResourceEligibility;
};
export type ActionCatalogue = ReadonlyMap<string, {
    anonymous: boolean;
    replay?: 'self-account-read';
}>;
/** Actions available to an access implementation for one application. */
export type AccessConfig = {
    actions: ActionCatalogue;
    resourceRoles?: ResourceRoleCatalogue;
};
/** Builds an access implementation from an application's configuration. */
export type AccessFactory = (config: AccessConfig) => Access;
export type AccessContext = {
    pool: Pool;
    deadline: number;
};
export type AccessClient = Pick<PoolClient, 'query'>;
export type AccessCheck = (client: AccessClient, time?: AuthoritativeTime) => Promise<boolean>;
export type AccessCommandAuthorization = CommandAuthorization & {
    readonly check: AccessCheck;
};
export interface Access {
    authenticate(token: string, context: AccessContext): Promise<AccountActor>;
    prepare?(actor: Actor, action: string, resource: Resource, context: AccessContext): Promise<unknown>;
    /** Derived only from the installed action catalogue's explicit declaration. */
    replayAuthorization?(action: string): 'self-account-read' | undefined;
    authorize(client: AccessClient, actor: Actor, action: string, resource: Resource, evidence?: unknown, time?: AuthoritativeTime): Promise<boolean>;
}
export declare function accessCheck(access: Access, actor: Actor, action: string, resource: Resource, context: AccessContext): Promise<AccessCheck>;
/** Prepare request evidence once. The command boundary invokes the final formula
 * on every real attempt, at its trusted T, before looking up any receipt.
 * The explicit self-read exception can retrieve a receipt but never run a body.
 */
export declare function accessCommandAuthorization(access: Access, actor: Actor, action: string, resource: Resource, context: AccessContext, denied: () => Error): Promise<AccessCommandAuthorization>;
export declare class AuthenticationError extends Error {
    readonly status: 400 | 401;
    readonly challenge: string;
    constructor(status: 400 | 401, challenge: string);
}
export declare function actorOf(access: Access, request: Request, context: AccessContext): Promise<Actor>;
export declare const anonymousAccess: Access;
