import type { ImportIdentityDriver } from '../../../../specs/imports-identity-driver.ts';
import { openGrowthDatabase } from '../support/growth.ts';
import {
  createIdentityNamespace,
  identityResources,
  identitySupport,
  openImportIdentity,
  runIdentityBootstrap,
  type ImportIdentity,
} from './identity-fixture.ts';
import { observeAccount, observeAuthAccount, observeBootstrap, observeGrants } from './identity-observer.ts';
import '../support/native-history-composition.ts';

/** Caller ownership of the isolated application DB is separate from Auth ownership. */
export function createImportIdentityDriver(): ImportIdentityDriver {
  const releases = new Map<ImportIdentity, () => Promise<void>>();
  return {
    async open(options) {
      const base = process.env.DATABASE_URL;
      if (!base) throw new Error('DATABASE_URL must name a migrated application database');
      const namespace = await createIdentityNamespace(base, decodeURIComponent(new URL(base).pathname.slice(1)));
      let database: Awaited<ReturnType<typeof openGrowthDatabase>> | undefined;
      try {
        database = await openGrowthDatabase(namespace.url);
        const f = await openImportIdentity({ ...options, database });
        let releasing: Promise<void> | undefined;
        releases.set(
          f,
          () =>
            (releasing ??= (async () => {
              try {
                await f.close();
              } finally {
                try {
                  await database!.close();
                } finally {
                  await namespace.close();
                  releases.delete(f);
                }
              }
            })()),
        );
        return f;
      } catch (error) {
        try {
          await database?.close();
        } finally {
          await namespace.close();
        }
        throw error;
      }
    },
    account: observeAccount,
    authAccount: observeAuthAccount,
    issue: (f, accountId, scopes) => identitySupport(f).issue(accountId, scopes),
    bootstrap: (f, accountId) => runIdentityBootstrap(f.database.url, accountId),
    bootstrapEvidence: observeBootstrap,
    grants: observeGrants,
    resources: async () => identityResources(),
    async release(f) {
      await releases.get(f)?.();
    },
    async close() {
      for (const release of [...releases.values()]) await release();
    },
  };
}
