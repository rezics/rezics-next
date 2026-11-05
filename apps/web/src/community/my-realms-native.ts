import type { KernelClient } from '@rezics/client';

/** Keep the installed endpoint as the source of the inventory contract. */
export type MyRealmsNativePage = NonNullable<Awaited<ReturnType<KernelClient['me']['realms']['get']>>['data']>;
export type MyRealmsNativeItem = MyRealmsNativePage['items'][number];
export type MyRealmsInventoryLink = Pick<MyRealmsNativeItem, 'realmId' | 'name'>;

/**
 * Format exactly the returned window. A sparse window still owns its opaque next cursor.
 * This installed response admits inventory labels only: role is not action or entry advice.
 * Keep the projection explicit so additional native fields require deliberate admission.
 */
export function formatMyRealmsInventory(page: MyRealmsNativePage): {
  realms: MyRealmsInventoryLink[];
  next: MyRealmsNativePage['next'];
} {
  return {
    realms: page.items.map(({ realmId, name }) => ({ realmId, name })),
    next: page.next,
  };
}
