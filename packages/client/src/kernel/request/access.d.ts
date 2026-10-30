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
/** Server-only eligibility cannot be recovered from request JSON. */
export type Resource = {
    route: number;
    id: string;
    eligibility?: ResourceEligibility;
    /** Compatibility spelling; uses the same opaque capability and evaluator. */
    anonymousEligibility?: ResourceEligibility;
};
/** One trusted homogeneous resource page, copied before evidence preparation. */
export type ResourcePage = Readonly<{
    route: number;
    resourceType: string;
    ids: readonly string[];
}>;
/** Reject malformed pages synchronously, before any database or actor read. */
export declare function resourcePage(page: ResourcePage): ResourcePage;
export type ActionMetadata = {
    anonymous: boolean;
    replay?: 'self-account-read';
    /** Resource types the command initializes. Absent means it initializes none. */
    'x-resource-types'?: readonly string[];
};
export type ActionCatalogue = ReadonlyMap<string, ActionMetadata>;
/** Server-owned Realm membership proofs. The permission formula calls this on the
 * released Realm anchor; a missing reader denies Realm group matches.
 */
export type AccessRealmRoleReader = ((client: AccessClient, input: {
    realmId: string;
    accountId: string;
    at: string;
}) => Promise<readonly {
    role: 'owner' | 'member';
    member: boolean;
    valid: string;
}[] | null>) & {
    /** One trusted statement for all admitted Realm/member anchors. */
    batch?: (client: AccessClient, input: {
        pairs: readonly {
            realmId: string;
            accountId: string;
        }[];
        at: string;
    }) => Promise<readonly {
        realmId: string;
        accountId: string;
        role: 'owner' | 'member';
        member: boolean;
        valid: string;
    }[] | null>;
};
/** Actions available to an access implementation for one application. */
export type AccessConfig = {
    actions: ActionCatalogue;
    resourceRoles?: ResourceRoleCatalogue;
    realmRoleReader?: AccessRealmRoleReader;
    /** Outside a command, permission checks bind this instant. Absent uses PostgreSQL clock_timestamp(). */
    clock?: () => Date;
};
/** Builds an access implementation from an application's configuration. */
export type AccessFactory = (config: AccessConfig) => Access;
export type AccessContext = {
    pool: Pool;
    deadline: number;
};
export type AccessClient = Pick<PoolClient, 'query'>;
/** Ordinary permission plus the same formula with public floor and grant roles disabled. */
export type AccessDecision = Readonly<{
    allowed: boolean;
    explicit: boolean;
}>;
export type AccessExplicitCheck = (client: AccessClient, time?: AuthoritativeTime) => Promise<AccessDecision>;
/** Trusted owner callback, evaluated at the formula's snapshot instant. UUIDs have no
 * resource-kind tag: the owner supplies the homogeneous resourceType and ids. */
export type ReadDecisionEligibility = (client: AccessClient, ids: readonly string[], at: string) => Promise<Readonly<Record<string, boolean>>>;
export type ReadDecisionInput = Readonly<{
    action: string;
    resourceType: string;
    ids: readonly string[];
    eligibility?: ReadDecisionEligibility;
}>;
export type ReadDecisions = Readonly<{
    decide(client: AccessClient, input: ReadDecisionInput, time?: AuthoritativeTime): Promise<Readonly<Record<string, AccessDecision>>>;
}>;
export type PrepareReadDecisionsInput = {
    actor: Actor;
    actions: ReadonlySet<string>;
    /** Composed candidate sets for a mixed-type read; each type remains bounded to 64. */
    typeActions?: ReadonlyMap<string, ReadonlySet<string>>;
    /** Shared authoritative instant for a personal batch. */
    time?: AuthoritativeTime;
    context: AccessContext;
};
/** Validate the bounded catalogue before reading any authority dependency. */
export declare function validReadDecisionActions(input: PrepareReadDecisionsInput, catalogue: ActionCatalogue): boolean;
export type AccessCheck = (client: AccessClient, time?: AuthoritativeTime) => Promise<boolean>;
export type AccessCommandAuthorization = CommandAuthorization & {
    readonly check: AccessCheck;
};
export interface Access {
    authenticate(token: string, context: AccessContext): Promise<AccountActor>;
    prepareReadDecisions?(input: PrepareReadDecisionsInput): Promise<ReadDecisions>;
    prepare?(actor: Actor, action: string, resource: Resource, context: AccessContext): Promise<unknown>;
    preparePage?(actor: Actor, action: string, page: ResourcePage, context: AccessContext): Promise<unknown>;
    authorizePage?(client: AccessClient, actor: Actor, action: string, page: ResourcePage, evidence?: unknown, time?: AuthoritativeTime): Promise<boolean>;
    /** Optional explicit projection of the installed formula for a resource or homogeneous page. */
    authorizeExplicit?(client: AccessClient, actor: Actor, action: string, resource: Resource | ResourcePage, evidence?: unknown, time?: AuthoritativeTime): Promise<AccessDecision>;
    /** Derived only from the installed action catalogue's explicit declaration. */
    replayAuthorization?(action: string): 'self-account-read' | undefined;
    authorize(client: AccessClient, actor: Actor, action: string, resource: Resource, evidence?: unknown, time?: AuthoritativeTime): Promise<boolean>;
}
export declare function accessCheck(access: Access, actor: Actor, action: string, resource: Resource, context: AccessContext): Promise<AccessCheck>;
/** Resolve the installed port through derived adapters; never infer explicit
 * authority from an adapter's ordinary boolean decision. */
export declare function accessExplicitCheck(access: Access, actor: Actor, action: string, resource: Resource, context: AccessContext): Promise<AccessExplicitCheck>;
/** The installed root owns the sole batch read formula, including through adapters. */
export declare function prepareReadDecisions(access: Access, input: PrepareReadDecisionsInput): Promise<ReadDecisions>;
/** Recheck command admission and prepare fresh evidence on every live attempt
 * before resource checkout. The stable check wrapper always uses the current
 * attempt's evidence, including body checks captured before execution. A retry
 * does not renew the request: each attempt's context copies the fixed request
 * deadline, and its evidence budget is capped by it and by JWT expiry, so no
 * attempt's evidence outlives the request. Self-read permits receipt lookup
 * only, never a body.
 */
export declare function accessCommandAuthorization(access: Access, actor: Actor, action: string, resource: Resource, context: AccessContext, denied: () => Error): Promise<AccessCommandAuthorization>;
export declare class AuthenticationError extends Error {
    readonly status: 400 | 401;
    readonly challenge: string;
    constructor(status: 400 | 401, challenge: string);
}
export declare function actorOf(access: Access, request: Request, context: AccessContext): Promise<Actor>;
export declare const anonymousAccess: Access;
