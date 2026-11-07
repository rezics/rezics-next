import type { Pool } from 'pg';
import type { KeyRing } from '../tokens/seal.ts';
import { type Access, type AccountActor, type Actor } from '../request/access.ts';
import type { OwnMediaInventoryPage } from './schemas.ts';
export declare const OWN_MEDIA_PAGE_SIZE = 20;
export type OwnMediaDependencies = Readonly<{
    pool: Pool;
    access: Access;
    tokens: KeyRing;
    clock: () => Date;
    deadlineNow?: () => number;
}>;
/** Add a committed browser or imported reservation to the existing account-home erasure locator.
 * The upsert is safe to repeat when the original reservation key is replayed. */
export declare function recordOwnMediaReservation(pool: Pool, actor: AccountActor, mediaId: string): Promise<void>;
/** Read a raw keyset page from the actor home, then batch current state and authority
 * in each selected media home. A failed home fails the whole page so its cursor
 * remains at the same frontier; invisible or collected locators are sparse rows. */
export declare function readOwnMediaInventory(deps: OwnMediaDependencies, actor: Actor, input: Readonly<{
    cursor?: string;
}>, deadline: number): Promise<OwnMediaInventoryPage>;
