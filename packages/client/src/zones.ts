import type { KernelClient } from './index.ts';

type ZonePath = ReturnType<KernelClient['zones']>;
export type ZoneCollectionsClient = ZonePath['collections'];
export type ZoneCollectionsQuery = NonNullable<Parameters<ZoneCollectionsClient['get']>[0]>['query'];
export type ZoneCollectionsCall = Awaited<ReturnType<ZoneCollectionsClient['get']>>;
export type ZoneCollectionsPage = NonNullable<ZoneCollectionsCall['data']>;

/** Return the generated, native Zone Collection endpoint for the selected Zone. */
export function zoneCollections(client: KernelClient, zoneId: string): ZoneCollectionsClient {
  return client.zones({ id: zoneId }).collections;
}
