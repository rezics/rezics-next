import { expect } from 'bun:test';
import { installIdentityEpochBootstrap } from '../../../src/semantic/identity-epoch-bootstrap-install.ts';
import { identityEpochDatabase } from '../../semantic/support/identity-epoch.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../../support/growth.ts';
import {
  IDENTITY_REPAIR_NATIVE_AT,
  IDENTITY_REPAIR_NATIVE_ROUTE,
  laterIdentities,
  openIdentityRepairNative,
  type IdentityRepairNativeHost,
} from './identity-repair-native.ts';

export type InstalledIdentityRepairGrowth = Awaited<ReturnType<typeof openInstalledIdentityRepairGrowth>>;

/** Private migrated identity deployment measured through the shared growth harness. */
export async function openInstalledIdentityRepairGrowth(
  options: { identities?: number; foreignIndexes?: readonly number[] } = {},
) {
  const isolated = await identityEpochDatabase();
  let db: GrowthDatabase | undefined;
  try {
    expect((await installIdentityEpochBootstrap(isolated.pool)).mode).toBe('legacy');
    await isolated.disconnect();
    db = await openGrowthDatabase(isolated.url);
    const host = await openIdentityRepairNative({
      identities: options.identities ?? 64,
      ...(options.foreignIndexes === undefined ? {} : { foreignIndexes: options.foreignIndexes }),
      database: { pool: db.pool, admin: db.admin },
    });
    const last = host.originals.slice().sort().at(-1) ?? host.root;
    return {
      db,
      host,
      originals: host.originals,
      later: (count: number) => laterIdentities(last, count),
      async close() {
        await db!.close();
        await isolated.close();
      },
    };
  } catch (error) {
    await db?.close().catch(() => undefined);
    await isolated.close();
    throw error;
  }
}

export { IDENTITY_REPAIR_NATIVE_AT, IDENTITY_REPAIR_NATIVE_ROUTE, type GrowthDatabase, type IdentityRepairNativeHost };
