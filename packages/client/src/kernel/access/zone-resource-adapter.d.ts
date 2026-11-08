/** Public Access producer for Zone resource command and read operations. Composition binds it; Zone does not import these internals. */
import type { Pool } from 'pg';
import { type ParentAnchor, type ResourceCreationPort } from './parent-creation.ts';
import { type AuthorizationAnchorPage } from './resource-authorization.ts';
import { GrantDeniedError } from './resource-access-errors.ts';
import { type Access, type AccessClient, type AccessContext, type Actor, type Resource } from './check.ts';
import type { AuthoritativeTime, CommandAttempt, CommandAuthorization, CommandTransaction } from '../command/command.ts';
export type ZoneResourceAccessClient = AccessClient;
export type ZoneResourceAccessActor = Extract<Actor, {
    kind: 'account';
}>;
export type ZoneResourceAccessHandle = Access;
export type ZoneResourceAccountSnapshot = Readonly<{
    id: string;
    kind: string;
    state: string;
    fenced: boolean;
    minimumAuthnEpoch: bigint;
    transactionId: string;
}>;
export type ZoneResourceAccountActionState = Readonly<{
    id: string;
    kind: string;
    state: string;
    fenced: boolean;
}>;
export type ZoneResourceAccessProducer = Readonly<{
    requireDeadline(deadline: number): void;
    commandAccessContext(context: AccessContext, attempt: CommandAttempt): AccessContext;
    parentCreationAuthorization(input: {
        access: Access;
        actor: Actor;
        action: string;
        parent: ParentAnchor;
        context: AccessContext & {
            resource: Resource;
            creation: ResourceCreationPort;
        };
    }): CommandAuthorization;
    resourceAuthorizationPage(input: {
        access: Access;
        actor: Actor;
        action: string;
        anchor: AuthorizationAnchorPage;
        context: AccessContext & {
            partition: number;
        };
    }): CommandAuthorization;
    initializeResourceGrants(tx: CommandTransaction, input: {
        resource: Resource;
        type: string;
        creator: string;
    }): Promise<void>;
    prepareAction(access: Access, actor: Extract<Actor, {
        kind: 'account';
    }>, action: string, resource: Resource, context: AccessContext): Promise<unknown>;
    authorizeAction(client: AccessClient, access: Access, actor: Extract<Actor, {
        kind: 'account';
    }>, action: string, resource: Resource, permission: unknown, time: AuthoritativeTime): Promise<boolean>;
    checkAction(access: Access, actor: Actor, action: string, resource: Resource, context: AccessContext): Promise<(client: AccessClient, time?: AuthoritativeTime) => Promise<boolean>>;
    createPublicEligibility<E extends {}>(options: {
        resource: Resource;
        action: string;
        prepare(context: {
            pool: Pool;
            resource: Resource;
        }): Promise<E | null | undefined>;
        verify(context: {
            client: AccessClient;
            resource: Resource;
            evidence: E;
        }): Promise<boolean>;
    }): unknown;
    readAccount(client: AccessClient, route: number, accountId: string): Promise<ZoneResourceAccountSnapshot | null>;
    readAccountActionStates(client: AccessClient, ids: readonly string[]): Promise<readonly ZoneResourceAccountActionState[]>;
    isGrantDenied(error: unknown): boolean;
    grantDenied(): GrantDeniedError;
}>;
/** Native Access command admission, grant initialization, account snapshots and public eligibility. */
export declare function createZoneResourceAccessProducer(): ZoneResourceAccessProducer;
