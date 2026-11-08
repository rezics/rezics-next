/** Native first owner write. Logical descriptors never initialize grants or certify Source completion. */
import type { Pool, PoolClient } from 'pg';
import { type CommandAuthorization, type CommandTransaction } from '../command/command.ts';
import type { Access, AccountActor } from '../request/access.ts';
import { type BuiltinCollectionKey } from './builtin-identity.ts';
import type { SavedCollectionRule } from './collection-rules.ts';
type Client = Pick<PoolClient, 'query'>;
type Key = Exclude<BuiltinCollectionKey, {
    kind: 'liked';
}>;
export type BuiltinPublicationRule = Readonly<{
    key: Key;
    rule: SavedCollectionRule;
}>;
export type BuiltinMaterialization = Readonly<{
    key: Key;
    rule: SavedCollectionRule;
    authorization: CommandAuthorization;
    materialize(tx: CommandTransaction): Promise<void>;
}>;
/** One native header, retaining accepted meaning rather than choosing a new current release. Data only. */
export declare function readBuiltinPublicationRule(client: Client, route: number, collectionId: string): Promise<BuiltinPublicationRule | null>;
/** Select only a real logical native owner descriptor. No caller tuple hints or historical release walk. */
export declare function prepareBuiltinMaterialization(config: Readonly<{
    pool: Pool;
    access: Access;
}>, actor: AccountActor, input: Readonly<{
    collectionId: string;
    revision: number;
}>, deadline: number): Promise<BuiltinMaterialization | null>;
export {};
