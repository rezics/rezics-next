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
}>;
/** Add a committed browser reservation to the existing account-home erasure locator.
 * The registered reserved-event projection repeats this upsert as its durable repair path. */
export declare function recordOwnMediaReservation(pool: Pool, actor: AccountActor, mediaId: string): Promise<void>;
/** Read a raw keyset page from the actor home, then batch current state and authority
 * in each selected media home. A failed home fails the whole page so its cursor
 * remains at the same frontier; invisible or collected locators are sparse rows. */
export declare function readOwnMediaInventory(deps: OwnMediaDependencies, actor: Actor, input: Readonly<{
    cursor?: string;
}>, deadline: number): Promise<OwnMediaInventoryPage>;
