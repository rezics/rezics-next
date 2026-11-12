import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { testDatabase } from '../scripts/database.ts';
import {
  NativeFixtureLifecycleError,
  nativeFixture,
  nativeFixtureResources,
  ownNativePool,
} from './support/erasure-native.ts';
import { createAuthRestoreHost } from '../src/host.ts';
import { startNativeErasure } from '../src/erasure-native.ts';
import { importRestoredAuthProgress, requireRestoredAuthAdmission } from '../src/restore-admission.ts';
import { newId } from '../../kernel/src/route/route.ts';

test('native Source live enrollment retains late deletions while restored Auth waits for original progress and physical receiving closure', async () => {
  const resources = nativeFixtureResources();
  try {
    const f = await nativeFixture();
    resources.own('native fixture', () => f.close());
    const copy = testDatabase();
    resources.own('restored database', () => copy.close());
    const originalDatabase = new Pool({ connectionString: copy.url, max: 1 });
    ownNativePool(originalDatabase, resources, 'original restored Auth pool');
    let database = originalDatabase;
    const restored = f.restoredGeneration(database, 'native-live-copy');
    const ports = restored.obligations!;
    const cutId = crypto.randomUUID();
    const request = () => ({ deadline: Date.now() + 10000 });
    await ports.startAuthErasureObligationCut({ cutId, ...request() });
    // Seal only the two selected native partitions, through their owning feed.
    // This proves Source behavior, never complete restored-image admission.
    for (let partition = 0; partition <= 1; partition++) {
      const page = await ports.pageAuthErasureObligations({
        cutId,
        cursor: { partition, afterOrdinal: '0' },
        ...request(),
      });
      expect(page.state).toBe('partition-end');
      expect(page.cut.sealedPartitions).toBe(partition + 1);
    }
    const live = restored.live!({
      cutId,
      authGeneration: restored.generation,
      databaseIdentity: 'isolated-native-auth-fixture',
      inventoryEntry: restored.generation,
      inventoryVersion: 'one',
    });
    const arm = await live.armAuthErasureLivePartition({ partition: 1, ...request() });
    expect(arm.state).toBe('armed');
    if (arm.state !== 'armed' || arm.highWater === null) throw new Error('Native Source arm unavailable');
    const cursor = { partition: 1, afterOrdinal: arm.highWater };
    expect(await live.readAuthErasureLivePage({ cursor, ...request() })).toMatchObject({
      state: 'tail-end',
      obligations: [],
      pending: [],
      next: cursor,
    });

    // Commit a real native tombstone after enrollment, using its public command.
    const { createLifecycleCommands, LIFECYCLE_ACTIONS } = await import('../../kernel/src/access/lifecycle.ts');
    const { admittedAccess, authenticateAccount } = await import('../../kernel/test/support/admitted-access.ts');
    const accountId = newId(16);
    await f.kernel.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES(16,$1,'actor','active',$1)`,
      [accountId],
    );
    await f.kernel.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
       VALUES(16,$1,$1,'account:delete','(,)'::tstzrange,$1)`,
      [accountId],
    );
    const access = admittedAccess({ actions: LIFECYCLE_ACTIONS });
    const actor = await authenticateAccount(
      access,
      { pool: f.kernel, ...request() },
      {
        accountId,
        clientId: 'restore-live-source',
        scopes: [...LIFECYCLE_ACTIONS.keys()],
      },
    );
    await createLifecycleCommands({ pool: f.kernel, access }).tombstone(
      { actor, ...request() },
      { accountId, key: crypto.randomUUID() },
    );
    const point = await ports.readAuthErasureObligation({ accountId, ...request() });
    if (point.state !== 'ready') throw new Error('Missing actual native late obligation');
    const page = await live.readAuthErasureLivePage({ cursor, ...request() });
    expect(page).toMatchObject({ state: 'tail-end', obligations: [point.obligation], pending: [] });
    expect(page.obligations.length + page.pending.length).toBeLessThanOrEqual(48);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(65536);
    expect(await live.verifyAuthErasureLivePartition({ partition: 1, ...request() })).toHaveProperty(
      'state',
      'current',
    );
    await expect(importRestoredAuthProgress(database, restored, accountId)).rejects.toMatchObject({
      code: 'original-progress-unavailable',
    });
    await startNativeErasure(f.pool, accountId, Number(point.obligation.minimumAuthnEpoch), point.obligation);
    await expect(importRestoredAuthProgress(database, restored, accountId)).rejects.toMatchObject({
      code: 'receiving-closure-pending',
    });
    // A consumer restart cannot consume the Source obligation or assert custody.
    await database.end();
    database = new Pool({ connectionString: copy.url, max: 1 });
    ownNativePool(database, resources, 'restarted restored Auth pool');
    const resumed = f.restoredGeneration(database, restored.generation);
    await expect(importRestoredAuthProgress(database, resumed, accountId)).rejects.toMatchObject({
      code: 'receiving-closure-pending',
    });
    expect((await live.readAuthErasureLivePage({ cursor, ...request() })).obligations).toEqual([point.obligation]);
    await expect(requireRestoredAuthAdmission(database, resumed)).rejects.toMatchObject({
      name: 'AuthRestoreAdmissionError',
    });
    expect((await database.query('SELECT 1 FROM auth_restore_replay')).rowCount).toBe(0);
    expect((await database.query('SELECT 1 FROM auth_signing_key')).rowCount).toBe(0);
  } finally {
    await resources.close();
  }
}, 120_000);

// Host source binding must use the native trusted Access composition rather
// than require a second set of feed callbacks in the restore declaration.
test('isolated host inherits the native obligation feed and records its durable source cursor before replay', async () => {
  const resources = nativeFixtureResources();
  try {
    const f = await nativeFixture();
    resources.own('native fixture', () => f.close());
    const copy = testDatabase();
    resources.own('restored database', () => copy.close());
    const database = new Pool({ connectionString: copy.url, max: 1 });
    ownNativePool(database, resources, 'restored Auth pool');
    const { obligations: _feed, ...restored } = f.restoredGeneration(database, 'host-native-feed');
    const host = createAuthRestoreHost({
      database,
      restoredGeneration: restored,
      trustedAccess: f.bindings.trustedAccess,
    });
    resources.own('isolated restore host', () => host.stop());
    expect('handler' in host).toBe(false);
    expect('service' in host).toBe(false);
    expect(await host.reconcile()).toEqual({ pending: 'source-consumer-pending' });
    const checkpoint = (
      await database.query('SELECT source_cursor,source_revision FROM auth_restore_generation WHERE generation=$1', [
        restored.generation,
      ])
    ).rows[0]!;
    expect(checkpoint.source_cursor).toEqual({ partition: 1, afterOrdinal: '0' });
    expect(Number(checkpoint.source_revision)).toBeGreaterThan(0);
    expect((await database.query('SELECT 1 FROM auth_restore_replay')).rowCount).toBe(0);
    expect((await database.query('SELECT 1 FROM auth_signing_key')).rowCount).toBe(0);
  } finally {
    await resources.close();
  }
}, 120_000);

test('isolated restore lifecycle keeps missing native owners closed and shuts down only its owned pool', async () => {
  const resources = nativeFixtureResources();
  let ownedDatabase: Pool | undefined;
  try {
    const copy = testDatabase();
    resources.own('restored database', () => copy.close());
    const database = new Pool({ connectionString: copy.url, max: 1 });
    ownedDatabase = database;
    ownNativePool(database, resources, 'restored Auth pool');
    const host = createAuthRestoreHost({
      database,
      restoredGeneration: { kind: 'RESTORED', generation: 'missing-owner-copy' },
    });
    resources.own('isolated restore host', () => host.stop());
    expect(await host.reconcile()).toEqual({ pending: 'database-owner-unavailable' });
    await host.start();
    expect((await database.query('SELECT 1 FROM auth_signing_key')).rowCount).toBe(0);
    expect((await database.query('SELECT 1 FROM auth_restore_replay')).rowCount).toBe(0);
  } finally {
    await resources.close();
  }
  expect(ownedDatabase?.ended).toBe(true);
});

test('Auth startup stop settles its owned generation before the next native host starts', async () => {
  let failure: unknown;
  try {
    await nativeFixture({
      async startHost(host) {
        const starting = host.start();
        await host.stop();
        await expect(starting).rejects.toThrow('Auth host is stopped');
        throw new Error('startup stopped for lifecycle handoff');
      },
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(NativeFixtureLifecycleError);
  expect(failure).toMatchObject({ phase: 'Auth host startup' });
  expect((failure as NativeFixtureLifecycleError).cause).toMatchObject({
    message: 'startup stopped for lifecycle handoff',
  });

  const successor = await nativeFixture();
  try {
    expect(successor.host).toBeDefined();
  } finally {
    await successor.close();
  }
}, 120_000);
