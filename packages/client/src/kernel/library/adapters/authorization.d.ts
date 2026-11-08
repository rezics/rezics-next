/** Authorization adapter. The composition root supplies Access's native implementation. */
import type { Pool } from 'pg';
import type { AuthoritativeTime } from '../../command/command.ts';
import type { Access, Actor } from '../../request/access.ts';
import type { AuthorizationCapability } from '../contract/index.ts';
import type { LibraryActor } from '../contract/index.ts';
import type { CollectionAuthorizationPreparation, CollectionListFilter, SpecializeCollectionListInput } from '../contract/index.ts';
export type NativeCollectionReadAdmission = (input: {
    access: Access;
    pool: Pool;
    actor: Actor;
    deadline: number;
    route: number;
    collectionId: string;
    at: AuthoritativeTime;
}) => Promise<boolean>;
export type AuthorizationAdapterPorts = Readonly<{
    admitCollectionRead: NativeCollectionReadAdmission;
    fenceAccount(tx: unknown, accountId: string): Promise<void>;
    isLifecycleDenied(error: unknown): boolean;
    commandAuthorization(...args: readonly unknown[]): Promise<unknown>;
    deadlineClient<T extends object>(client: T, deadline: number): T;
    within<T>(deadline: number, work: () => Promise<T>): Promise<T>;
    specializeCollectionList(input: SpecializeCollectionListInput): CollectionListFilter;
    collectionAuthorizationPreparation(): CollectionAuthorizationPreparation;
}>;
export declare function createAuthorizationAdapter(input: {
    access?: Access | undefined;
    pool?: Pool | undefined;
    ports: AuthorizationAdapterPorts;
}): AuthorizationCapability;
export type { LibraryActor, Actor };
