import type { Pool } from 'pg';
import { type CommandTransaction } from '../command/command.ts';
import type { Access, Actor } from '../request/access.ts';
import type { ReadContext } from './model.ts';
export type RealmPresentationOptional<T> = Readonly<{
    state: 'available';
    value: T;
}> | Readonly<{
    state: 'none' | 'unavailable';
    value: null;
}>;
export type RealmPresentationImage = Readonly<{
    id: string;
    containerId: string;
    digest: string;
    width: number;
    height: number;
    variants: readonly Readonly<{
        format: 'avif' | 'webp';
        width: number;
        height: number;
    }>[];
    placeholder: Readonly<{
        thumbhash: string;
        color: string;
    }> | null;
    focalPoint: Readonly<{
        x: number;
        y: number;
    }> | null;
    credit: import('@rezics/definitions/media-import').MediaImportRequest['credit'] | null;
}>;
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
    clock?: () => Date;
}>, input: Readonly<{
    realmId: string;
    avatarMediaId: string | null;
    bannerMediaId: string | null;
}>, context: ReadContext): Promise<Readonly<{
    avatar: RealmPresentationOptional<RealmPresentationImage>;
    banner: RealmPresentationOptional<RealmPresentationImage>;
}>>;
