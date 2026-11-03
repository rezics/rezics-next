import { DBOS } from '@dbos-inc/dbos-sdk';
import { partitionOf, routeOf } from '../../../src/route/route.ts';
import { testRouteKey } from '../../support/test-kernel.ts';
import {
  composeNativeCollectionRuntime,
  createMediaObjectStore,
  mediaRealmDownloadFixture,
} from '../media-native-collection-fixture.ts';

/** Native Realm HTTP and registered Content work share the isolated, observed database. */
export async function growthRealmAssetPublicationFixture() {
  const native = await mediaRealmDownloadFixture();
  const store = createMediaObjectStore();
  let runtime: Awaited<ReturnType<typeof composeNativeCollectionRuntime>> | undefined;
  try {
    if (DBOS.isInitialized()) await DBOS.shutdown({ deregister: true });
    const route = routeOf(native.publicRealm.realmId);
    if (route === null) throw new Error('Growth Realm has no route');
    const partition = partitionOf(route);
    runtime = await composeNativeCollectionRuntime({
      databaseUrl: native.db.url,
      routeKey: testRouteKey(),
      partitions: [partition],
      store,
      clock: () => new Date('2030-01-01T00:00:00.000Z'),
      pool: native.mutationPool,
    });

    let closing: Promise<void> | undefined;
    return {
      native,
      store,
      runtime,
      route,
      partition,
      realmId: native.publicRealm.realmId,
      close() {
        return (closing ??= (async () => {
          try {
            await runtime!.close();
          } finally {
            try {
              await native.close();
            } finally {
              store.close();
            }
          }
        })());
      },
    };
  } catch (error) {
    try {
      await runtime?.close();
    } finally {
      try {
        await native.close();
      } finally {
        store.close();
      }
    }
    throw error;
  }
}
