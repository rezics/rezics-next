import type { Pool, PoolClient } from 'pg';
import type { Access, AccessContext, Actor } from '../request/access.ts';
export type AccountPreferences = {
    spoilerLevel: 0 | 1 | 2;
    suitability: 'blur' | 'show';
    version: number;
};
export declare const DEFAULT_ACCOUNT_PREFERENCES: Readonly<AccountPreferences>;
export type PreferenceChange = {
    expectedVersion: number;
    spoilerLevel?: 0 | 1 | 2;
    suitability?: 'blur' | 'show';
};
/** One account-key seek, at most one row; missing storage means the defaults. */
export declare function readAccountPreferences(client: Pick<Pool | PoolClient, 'query'>, accountId: string): Promise<AccountPreferences>;
/** Serializable read/compare/write touches one preference row and the command receipt.
 * The acting account alone owns this state, including in an operator-opened session.
 */
export declare function createPreferenceCommands(config: {
    pool: Pool;
    access: Access;
    clock: () => Date;
}): {
    setPreferences(context: AccessContext & {
        actor: Actor;
    }, input: PreferenceChange & {
        accountId: string;
        key: string;
    }): Promise<import("../command/command.ts").CommandOutcome<{
        version: number;
        spoilerLevel: 0 | 1 | 2;
        suitability: "blur" | "show";
    }>>;
};
