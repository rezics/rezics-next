import type { Pool } from 'pg';
import { type CommandTransaction } from '../command/command.ts';
import type { Access, Actor } from '../request/access.ts';
import type { ReadContext } from './model.ts';
import { RealmPresentationImageSchema, type RealmPresentationImage, type RealmPresentationOptional } from './realm-presentation-image.ts';
export { RealmPresentationImageSchema, type RealmPresentationImage, type RealmPresentationOptional, } from './realm-presentation-image.ts';
/** Exact JSON summary shared by native presentation consumers; never download authority. */
export declare function exactRealmPresentationImage(value: RealmPresentationImage): import('typebox').Static<ReturnType<typeof RealmPresentationImageSchema>> | null;
/** Called after the native settings revision/head writes, within their authorized command.
 * Null slots never undo claims made by an immutable earlier Realm revision. */
export declare function claimRealmPresentationMedia(tx: CommandTransaction, input: Readonly<{
    realmId: string;
    author: Actor;
    avatarMediaId: string | null;
    bannerMediaId: string | null;
}>): Promise<void>;
export declare function readRealmPresentationImages(deps: Readonly<{
    pool: Pool;
    access: Access;
    clock: () => Date;
}>, input: Readonly<{
    realmId: string;
    avatarMediaId: string | null;
    bannerMediaId: string | null;
}>, context: ReadContext): Promise<Readonly<{
    avatar: RealmPresentationOptional<RealmPresentationImage>;
    banner: RealmPresentationOptional<RealmPresentationImage>;
}>>;
