import type { Pool } from 'pg';
import { type Access, type AccessRealmRoleReader, type Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
export type AccountRealmsPage = {
    realms: {
        id: string;
        role: 'owner' | 'member';
    }[];
    next: string | null;
};
export type AccountRealmsDependencies = {
    pool: Pool;
    tokens: KeyRing;
    access: Access;
    realmRoleReader: AccessRealmRoleReader;
};
/** A bounded public page over the account's inverse, with independent live Realm checks. */
export declare function readAccountRealms(dependencies: AccountRealmsDependencies, actor: Actor, accountId: string, at: Date, deadline: number, input: {
    limit?: number;
    cursor?: string;
}): Promise<AccountRealmsPage>;
