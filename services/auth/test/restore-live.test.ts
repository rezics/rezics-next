import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import type { AuthErasureLivePorts, AuthErasureLiveReceiver } from '@rezics/auth-contract';
import { testDatabase } from '../scripts/database.ts';
import { nativeFixture } from './support/erasure-native.ts';
import { createAuthRestoreHost } from '../src/host.ts';
import { startNativeErasure } from '../src/erasure-native.ts';
import {
  requireRestoredAuthAdmission,
  stageRestoredAuthObligations,
  type AuthRestoredGeneration,
  type AuthRestoreInventory,
  type AuthRestoreNativeProgress,
} from '../src/restore-admission.ts';
import { newId } from '../../kernel/src/route/route.ts';

// All positive Source replies below originate at the original native producer.
// The variable import lets the consumer typecheck before normal producer-first
// integration; deferred native acceptance still requires the REAL module/body.
async function sources() {
  const path = '../../kernel/src/access/auth-erasure-live.ts';
  const live: { createAuthErasureLiveBindings(pool: Pool, receiver: AuthErasureLiveReceiver): AuthErasureLivePorts } =
    await import(path);
  return {
    ...live,
    ...(await import('../../kernel/src/access/auth-erasure-obligations.ts')),
    ...(await import('../../kernel/src/access/lifecycle.ts')),
    ...(await import('../../kernel/test/support/admitted-access.ts')),
  };
}

test('Native restored Auth live handoff consumer', async () => {
  const f = await nativeFixture();
  const copy = testDatabase();
  let database = new Pool({ connectionString: copy.url, max: 1 });
  try {
    const source = await sources();
    const inventory: AuthRestoreInventory = {
      generation: 'native-live-copy',
      databaseIdentity: 'isolated-native-auth-fixture',
      inventoryEntry: 'native-live-copy',
      inventoryVersion: 'original-opaque-version',
      sourceCluster: 'native-fixture-cluster',
      sourceTimeline: 'native-fixture-timeline',
      sourceLineage: 'independent-current-access',
      capturePoint: 'before-confirmations',
      committedNativeTail: 'surviving-native-auth-database',
    };
    const recovered = new Map<string, AuthRestoreNativeProgress>();
    const receivers = new Set<string>();
    const restored: AuthRestoredGeneration = {
      kind: 'RESTORED',
      generation: inventory.generation,
      obligations: source.createAuthErasureObligationBindings(f.kernel),
      live(receiver) {
        expect(database.idleCount).toBe(database.totalCount);
        receivers.add(JSON.stringify(receiver));
        const native = source.createAuthErasureLiveBindings(f.kernel, receiver);
        return {
          async armAuthErasureLivePartition(input) {
            expect(database.idleCount).toBe(database.totalCount);
            return native.armAuthErasureLivePartition(input);
          },
          async readAuthErasureLivePage(input) {
            expect(database.idleCount).toBe(database.totalCount);
            const page = await native.readAuthErasureLivePage(input);
            expect(page.obligations.length + page.pending.length).toBeLessThanOrEqual(48);
            expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(65536);
            return page;
          },
          async verifyAuthErasureLivePartition(input) {
            expect(database.idleCount).toBe(database.totalCount);
            return native.verifyAuthErasureLivePartition(input);
          },
        };
      },
      databaseOwner: {
        async verifyRestoredDatabase(input) {
          expect(input.database).toBe(database);
          expect(database.idleCount).toBe(database.totalCount);
          return inventory;
        },
        async recoverCommittedNativeProgress({ accountId }) {
          expect(database.idleCount).toBe(database.totalCount);
          if (recovered.has(accountId)) return recovered.get(accountId)!;
          const row = (await f.pool.query('SELECT * FROM auth_erasure WHERE account_id=$1', [accountId])).rows[0];
          if (!row) return { pending: 'original-progress-unavailable' };
          const progress: AuthRestoreNativeProgress = {
            source: { accountId, route: f.routeOf(accountId)!, version: row.kernel_version, at: row.kernel_at },
            originalNativeId: row.id,
            checkpoint: inventory.committedNativeTail,
            floor: row.barrier,
            acceptedAt: row.accepted_at.toISOString(),
            applicable: row.applicable,
            userDeletion: row.user_deleted_at
              ? {
                  state: 'established',
                  deletedAt: row.user_deleted_at.toISOString(),
                  consentDueAt: row.consent_due_at.toISOString(),
                  consentCompletedAt: row.consent_completed_at?.toISOString() ?? null,
                }
              : { state: 'never-established' },
            consumer: row.source_accepted_at
              ? {
                  state: 'accepted',
                  workflowId: row.source_workflow_id,
                  continuationId: row.source_continuation_id,
                  receiptId: row.source_receipt_id,
                  acceptedAt: row.source_accepted_at.toISOString(),
                  dischargedAt: row.source_discharged_at?.toISOString() ?? null,
                  publishedAt: row.source_published_at?.toISOString() ?? null,
                }
              : { state: 'pending' },
          };
          recovered.set(accountId, progress);
          return progress;
        },
      },
    };
    // Traverse and verify genuine original Source checkpoints. No test installs
    // a cursor, coverage truth, terminal receipt or replacement consumer proof.
    for (let i = 0; i < 8192; i++) await stageRestoredAuthObligations(database, restored);
    for (let i = 0; i < 4095; i++) await stageRestoredAuthObligations(database, restored);
    expect(await stageRestoredAuthObligations(database, restored)).toEqual({ pending: 'native-replay-pending' });
    expect(receivers.size).toBe(1);
    expect((await database.query('SELECT 1 FROM auth_restore_live_partition')).rowCount).toBe(4096);
    await expect(requireRestoredAuthAdmission(database, restored)).rejects.toMatchObject({
      code: 'native-replay-pending',
    });

    // A genuine future tombstone arrives after every arm. Its original Auth
    // progress is initially absent: Source alone may not manufacture that row.
    const accountId = newId(16); // native feed partition one
    await f.kernel.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES(16,$1,'actor','active',$1)`,
      [accountId],
    );
    await f.kernel.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
       VALUES(16,$1,$1,'account:delete','(,)'::tstzrange,$1)`,
      [accountId],
    );
    const access = source.admittedAccess({ actions: source.LIFECYCLE_ACTIONS });
    const actor = await source.authenticateAccount(
      access,
      { pool: f.kernel, deadline: Date.now() + 10000 },
      {
        accountId,
        clientId: 'restore-live-source',
        scopes: [...source.LIFECYCLE_ACTIONS.keys()],
      },
    );
    await source
      .createLifecycleCommands({ pool: f.kernel, access })
      .tombstone({ actor, deadline: Date.now() + 10000 }, { accountId, key: crypto.randomUUID() });
    // Admission above revisited partition zero, so the next unit is partition one.
    await expect(stageRestoredAuthObligations(database, restored)).rejects.toMatchObject({
      code: 'original-progress-unavailable',
    });
    expect((await database.query('SELECT 1 FROM auth_erasure WHERE account_id=$1', [accountId])).rowCount).toBe(0);
    const point = await restored.obligations!.readAuthErasureObligation({ accountId, deadline: Date.now() + 10000 });
    if (point.state !== 'ready') throw new Error('Missing actual native late obligation');
    await startNativeErasure(f.pool, accountId, Number(point.obligation.minimumAuthnEpoch), point.obligation);
    // Restart with the same native generation, keeping the durable rotating key.
    await database.end();
    database = new Pool({ connectionString: copy.url, max: 1 });
    for (let i = 0; i < 4095; i++) await stageRestoredAuthObligations(database, restored);
    expect(await stageRestoredAuthObligations(database, restored)).toEqual({ pending: 'native-replay-pending' });
    const imported = (
      await database.query(
        `SELECT r.original_progress,r.source_obligation,r.native_completed_at,r.copies_completed_at
       FROM auth_restore_replay r JOIN auth_erasure e ON e.id=r.obligation_id WHERE e.account_id=$1`,
        [accountId],
      )
    ).rows[0]!;
    expect(imported.source_obligation).toEqual(point.obligation);
    expect(imported.original_progress).toEqual(recovered.get(accountId));
    expect(imported.native_completed_at).toBeNull();
    expect(imported.copies_completed_at).toBeNull();
    expect((await database.query('SELECT 1 FROM auth_signing_key')).rowCount).toBe(0);
    await expect(
      database.query('UPDATE auth_restore_live_partition SET after_ordinal=after_ordinal+1'),
    ).rejects.toThrow();
    await expect(database.query("UPDATE auth_restore_live_generation SET inventory='{}'::jsonb")).rejects.toThrow();
  } finally {
    await database.end();
    copy.close();
    await f.close();
  }
}, 300_000);

test('isolated restore lifecycle keeps missing native owners closed and shuts down only its owned pool', async () => {
  const copy = testDatabase();
  const database = new Pool({ connectionString: copy.url, max: 1 });
  const host = createAuthRestoreHost({
    database,
    restoredGeneration: { kind: 'RESTORED', generation: 'missing-owner-copy' },
  });
  try {
    expect(await host.reconcile()).toEqual({ pending: 'database-owner-unavailable' });
    await host.start();
    expect((await database.query('SELECT 1 FROM auth_signing_key')).rowCount).toBe(0);
    expect((await database.query('SELECT 1 FROM auth_restore_replay')).rowCount).toBe(0);
  } finally {
    await host.stop();
    copy.close();
  }
  expect(database.ended).toBe(true);
});
