/** Zone-owned Access capability for resource command and read operations. Composition binds the native adapter. */
import type { Pool, PoolClient } from 'pg';
import type { AuthoritativeTime, CommandAttempt, CommandAuthorization, CommandTransaction } from '../command/command.ts';
import type { KeyRing } from '../tokens/seal.ts';
/** Installed Access object; composition supplies the native evaluator. */
export type ZoneAccessHandle = object;
export type ZoneAccountActor = {
    kind: 'account';
    accountId: string;
    clientId: string;
    scopes: readonly string[];
    requestedBy: string | null;
    authnEpoch: number;
};
export type ZoneActor = ZoneAccountActor | {
    kind: 'anonymous';
};
export type ZoneQueryClient = Pick<PoolClient, 'query'>;
export type ZoneAccessBudget = Readonly<{
    pool: Pool;
    deadline: number;
}>;
export type ZoneResourceRef = Readonly<{
    route: number;
    id: string;
    eligibility?: unknown;
}>;
export type ZoneAccessCheck = (client: ZoneQueryClient, time?: AuthoritativeTime) => Promise<boolean>;
export type ZoneAccountSnapshot = Readonly<{
    id: string;
    kind: string;
    state: string;
    fenced: boolean;
    minimumAuthnEpoch: bigint;
    transactionId: string;
}>;
export type ZoneAccountActionState = Readonly<{
    id: string;
    kind: string;
    state: string;
    fenced: boolean;
}>;
export type ZoneParentAnchor = Readonly<{
    resource: Readonly<{
        route: number;
        id: string;
    }>;
    resourceType?: string;
    validate(client: ZoneQueryClient, time: AuthoritativeTime): Promise<boolean>;
}>;
export type ZoneCreationPort = Readonly<{
    validate(tx: CommandTransaction, resource: Readonly<{
        route: number;
        id: string;
    }>, time: AuthoritativeTime): Promise<boolean>;
}>;
export type ZoneAuthorizationPage = Readonly<{
    route: number;
    resourceType: string;
    ids: readonly string[];
    validate(client: ZoneQueryClient, time: AuthoritativeTime): Promise<boolean>;
}>;
export type ZonePublicEligibilityPrepare<E> = Readonly<{
    pool: Pool;
    resource: Readonly<{
        route: number;
        id: string;
    }>;
}>;
export type ZonePublicEligibilityVerify<E> = Readonly<{
    client: ZoneQueryClient;
    resource: Readonly<{
        route: number;
        id: string;
    }>;
    evidence: E;
}>;
export type ZoneResourceRuntimeDependencies = Readonly<{
    pool: Pool;
    access: ZoneAccessHandle;
    tokens: KeyRing;
    clock: () => Date;
}>;
/** Access authorization, account snapshots, public eligibility and read-transaction operations Zone resources consume. */
export type ZoneResourceAccessPort = Readonly<{
    requireDeadline(deadline: number): void;
    commandAccessContext(context: ZoneAccessBudget, attempt: CommandAttempt): ZoneAccessBudget;
    parentCreationAuthorization(input: {
        access: ZoneAccessHandle;
        actor: ZoneAccountActor;
        action: string;
        parent: ZoneParentAnchor;
        context: ZoneAccessBudget & {
            resource: Readonly<{
                route: number;
                id: string;
            }>;
            creation: ZoneCreationPort;
        };
    }): CommandAuthorization;
    resourceAuthorizationPage(input: {
        access: ZoneAccessHandle;
        actor: ZoneAccountActor;
        action: string;
        anchor: ZoneAuthorizationPage;
        context: ZoneAccessBudget & {
            partition: number;
        };
    }): CommandAuthorization;
    initializeResourceGrants(tx: CommandTransaction, input: {
        resource: Readonly<{
            route: number;
            id: string;
        }>;
        type: string;
        creator: string;
    }): Promise<void>;
    prepareAction(access: ZoneAccessHandle, actor: ZoneAccountActor, action: string, resource: ZoneResourceRef, context: ZoneAccessBudget): Promise<unknown>;
    authorizeAction(client: ZoneQueryClient, access: ZoneAccessHandle, actor: ZoneAccountActor, action: string, resource: ZoneResourceRef, permission: unknown, time: AuthoritativeTime): Promise<boolean>;
    checkAction(access: ZoneAccessHandle, actor: ZoneActor, action: string, resource: ZoneResourceRef, context: ZoneAccessBudget): Promise<ZoneAccessCheck>;
    createPublicEligibility<E extends {}>(options: {
        resource: Readonly<{
            route: number;
            id: string;
        }>;
        action: string;
        prepare(context: ZonePublicEligibilityPrepare<E>): Promise<E | null | undefined>;
        verify(context: ZonePublicEligibilityVerify<E>): Promise<boolean>;
    }): unknown;
    readAccount(client: ZoneQueryClient, route: number, accountId: string): Promise<ZoneAccountSnapshot | null>;
    readAccountActionStates(client: ZoneQueryClient, ids: readonly string[]): Promise<readonly ZoneAccountActionState[]>;
    withReadTransaction<T>(pool: Pool, work: (client: ZoneQueryClient) => Promise<T>, deadline?: number): Promise<T>;
    isGrantDenied(error: unknown): boolean;
    grantDenied(): Error;
    authenticationRequired(): Error;
}>;
/** Composition installs the native Access adapter. Resource commands and reads never import that adapter. */
export declare function bindZoneResourceAccess(port: ZoneResourceAccessPort): ZoneResourceAccessPort;
export declare function zoneResourceAccess(): ZoneResourceAccessPort;
export declare function tryZoneResourceAccess(): ZoneResourceAccessPort | undefined;
/** Tests restore the process binding; createKernel rebinds the native port. */
export declare function unbindZoneResourceAccess(): void;
