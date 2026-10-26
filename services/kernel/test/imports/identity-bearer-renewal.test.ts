import { expect, setSystemTime, test } from 'bun:test';
import { BULK_ACTION, GLOBAL, IMPORT_ACTIONS, COMMON_ACTIONS } from '../../../../specs/imports-identity-driver.ts';
import { withConnection } from '../../src/database/pool.ts';
import { accessCheck } from '../../src/request/access.ts';
import { createImportIdentityDriver } from './identity-driver.ts';
import { identitySupport, type ImportIdentity } from './identity-fixture.ts';
import { observeGrants } from './identity-observer.ts';

// Auth stamps and the production verifier checks token expiry against the process clock, not the
// injected one, so the test moves the process clock instead of sleeping through the lifetime.
async function bulkPermitted(f: ImportIdentity) {
  const credential = await identitySupport(f).issue(f.bulk.accountId, [...COMMON_ACTIONS, ...IMPORT_ACTIONS]);
  const context = { pool: f.database.pool, deadline: Date.now() + 10_000 };
  const actor = await f.access.authenticate(credential.bearer, context);
  const check = await accessCheck(f.access, actor, BULK_ACTION, GLOBAL, context);
  return withConnection(f.database.pool, (client) => check(client));
}
const granted = async (f: ImportIdentity) =>
  (await observeGrants(f, f.bulk.accountId)).some((row) => row.actions.includes(BULK_ACTION));

test('grant changes keep working after the management access token’s lifetime', async () => {
  const driver = createImportIdentityDriver();
  try {
    const f = await driver.open({ clock: () => new Date() });
    try {
      const lifetime = f.auth.verifier.accessTokenLifetimeSeconds;
      expect(await granted(f)).toBe(true);
      expect(await bulkPermitted(f)).toBe(true);
      try {
        setSystemTime(new Date(Date.now() + (lifetime + 1) * 1000));
        await f.setBulkPermission(false);
        expect(await granted(f)).toBe(false);
        expect(await bulkPermitted(f)).toBe(false);
        await f.setBulkPermission(true);
        expect(await granted(f)).toBe(true);
        expect(await bulkPermitted(f)).toBe(true);
      } finally {
        setSystemTime();
      }
    } finally {
      await f.close();
      await driver.release(f);
    }
  } finally {
    await driver.close();
  }
}, 120000);
