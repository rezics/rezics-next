import { type createGrantCommands } from './grant-commands.ts';
import type { Pool } from 'pg';
import { type Access, type Actor } from './check.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { type PublicIdentity } from './account-data.ts';
import { mountedExposureCatalogue } from './gates/visibility.ts';
import type { GrantSubject } from './grant-subject.ts';
import type { ViewerActionResources } from './viewer-actions.ts';
export type ManagedGrant = {
    kind: 'direct' | 'role';
    state: 'active' | 'scheduled';
    subject: GrantSubject;
    actions: string[];
    role: string | null;
    valid: string;
    startsAt: string | null;
    endsAt: string | null;
    manageable: boolean;
};
export type GrantReadPage = {
    resource: {
        id: string;
        route: number;
        type: string;
    };
    authority: {
        accountId: string;
        principalId: string | null;
        clientId: string;
    };
    roles: {
        id: string;
        actions: string[];
        delegable: boolean;
    }[];
    actions: string[];
    grants: ManagedGrant[];
    identities: PublicIdentity[];
    next: string | null;
    /** Realm mutation requires the genuine native command composition. */
    mutationState: 'ready' | 'realm_guard_unavailable';
};
/** Exact-resource management read. No caller-supplied type, authority or policy is accepted. */
export declare function readResourceGrants(deps: {
    pool: Pool;
    access: Access;
    tokens: KeyRing;
    resources: ViewerActionResources;
    clock: () => Date;
    commands?: ReturnType<typeof createGrantCommands>;
    routes?: Parameters<typeof mountedExposureCatalogue>[0];
}, actor: Actor, input: {
    resourceId: string;
    cursor?: string;
}, deadline: number): Promise<GrantReadPage>;
