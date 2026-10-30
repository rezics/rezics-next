import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createAuthHost, createAuthService, type AuthServiceOptions, type AuthHostOptions } from '../src/index.ts';
import {
  AuthRestoreAdmissionError,
  importRestoredAuthProgress,
  replayRestoredAuthPage,
  requireRestoredAuthAdmission,
  type AuthRestoredGeneration,
  type AuthRestoreInventory,
  type AuthRestoreNativeProgress,
} from '../src/restore-admission.ts';
import { installNativeRoleCoverage, reconcileNativeRoleCoveragePage } from '../src/erasure-coverage.ts';
import { testDatabase } from '../scripts/database.ts';
import { failNativeQueries, nativeFixture } from './support/erasure-native.ts';

function closedOptions(database: Pool): AuthServiceOptions {
  return {
    database,
    issuer: 'https://restore.auth.test',
    audience: 'https://restore.api.test',
    secret: 'restore admission contract secret at least 32 bytes',
    signing: { activeKid: 'must-not-start', privateKeys: [] },
    trustedAccess: {} as AuthServiceOptions['trustedAccess'],
    restoredGeneration: { kind: 'RESTORED', generation: 'declared-restored-copy' },
  };
}

// No database is contacted: refusal must precede signer/Better Auth/SDK work.
// A dependency returning a readiness flag cannot bypass the missing Source API.
test('An explicitly restored Auth generation remains closed before handler issuer workflow and writer admission until exact independent Source obligations and genuine original native progress are reconciled without renewing consent deadlines or claiming backup custody', async () => {
  const database = new Pool({
    connectionString: 'postgres://restore:restore@127.0.0.1:1/closed',
    connectionTimeoutMillis: 100,
  });
  try {
    await expect(createAuthService(closedOptions(database))).rejects.toMatchObject({
      name: 'AuthRestoreAdmissionError',
      code: 'database-owner-unavailable',
    });
    expect(database.totalCount).toBe(0);
    await expect(
      createAuthHost({
        ...closedOptions(database),
        stagingKey: new Uint8Array(32),
        access: {} as AuthHostOptions['access'],
      }),
    ).rejects.toMatchObject({ name: 'AuthRestoreAdmissionError', code: 'database-owner-unavailable' });
    // Host refusal still owns and closes its pools; it has returned no service,
    // handler, issuer, workflow runtime or maintenance task to the deployment.
    expect(database.ended).toBe(true);
  } finally {
    if (!database.ended) await database.end();
  }
});

test('missing or ambiguous verified lineage refuses construction without reading or logging native payload', async () => {
  for (const pending of ['restore-lineage-unavailable', 'restore-lineage-mismatch'] as const) {
    const database = new Pool({ connectionString: 'postgres://restore:restore@127.0.0.1:1/closed' });
    try {
      const options = closedOptions(database);
      options.restoredGeneration!.databaseOwner = {
        async verifyRestoredDatabase() {
          return { pending };
        },
        async recoverCommittedNativeProgress() {
          throw new Error('must not read original progress');
        },
      };
      await expect(createAuthService(options)).rejects.toMatchObject({
        name: 'AuthRestoreAdmissionError',
        code: pending,
      });
      expect(database.totalCount).toBe(0);
    } finally {
      await database.end();
    }
  }
});

// These fixture inventory identities exercise native binding/refusal only.
// They are NOT a production backup verifier, sealed Source feed or certificate.
test('recover original committed Auth progress beyond the snapshot, replay bounded native bytes and retain the first consent cutoff and real consumer proof', async () => {
  const f = await nativeFixture();
  const copy = testDatabase();
  const restored = new Pool({ connectionString: copy.url, max: 1 });
  let restoreQueries = () => {};
  try {
    const victim = await f.person('admission-victim');
    const living = await f.person('admission-living');
    const oldUsers = (
      await f.pool.query('SELECT * FROM "user" WHERE id=ANY($1)', [[victim.accountId, living.accountId]])
    ).rows;
    // A native role store with more than one raw page and an unrelated row.
    await restored.query(
      `INSERT INTO auth_effect_receipt(receipt_id,account_id,purpose,minimum_authn_epoch,acting_human_id)
      SELECT 'restored-'||lpad(i::text,3,'0'),$1,'sessions',7,$2 FROM generate_series(1,105)i`,
      [living.accountId, victim.accountId],
    );
    await restored.query(
      `INSERT INTO auth_effect_receipt(receipt_id,account_id,purpose,minimum_authn_epoch)
      VALUES ('living-witness',$1,'sessions',7)`,
      [living.accountId],
    );
    for (const row of oldUsers)
      await restored.query('INSERT INTO "user" SELECT * FROM json_populate_record(NULL::"user",$1::json)', [
        JSON.stringify(row),
      ]);
    expect((await restored.query('SELECT 1 FROM auth_erasure WHERE account_id=$1', [victim.accountId])).rowCount).toBe(
      0,
    );
    expect((await f.delete(victim)).status).toBe(200);
    const original = (await f.pool.query('SELECT * FROM auth_erasure WHERE account_id=$1', [victim.accountId]))
      .rows[0]!;
    const source = (
      await f.kernel.query('SELECT route,account_id,version,at FROM access.erasure WHERE route=$1 AND account_id=$2', [
        f.routeOf(victim.accountId),
        victim.accountId,
      ])
    ).rows[0]!;
    const iso = (date: Date | null) => date?.toISOString() ?? null;
    const progress: AuthRestoreNativeProgress = {
      source: { route: source.route, accountId: source.account_id, version: source.version, at: original.kernel_at },
      originalNativeId: original.id,
      checkpoint: 'fixture-committed-tail-after-confirmation',
      floor: original.barrier,
      acceptedAt: original.accepted_at.toISOString(),
      applicable: original.applicable,
      userDeletion: {
        state: 'established',
        deletedAt: original.user_deleted_at.toISOString(),
        consentDueAt: original.consent_due_at.toISOString(),
        consentCompletedAt: iso(original.consent_completed_at),
      },
      consumer: original.source_accepted_at
        ? {
            state: 'accepted',
            workflowId: original.source_workflow_id,
            continuationId: original.source_continuation_id,
            receiptId: original.source_receipt_id,
            acceptedAt: original.source_accepted_at.toISOString(),
            dischargedAt: iso(original.source_discharged_at),
            publishedAt: iso(original.source_published_at),
          }
        : { state: 'pending' },
    };
    const inventory: AuthRestoreInventory = {
      generation: 'native-fixture-copy-one',
      databaseIdentity: copy.url,
      inventoryEntry: 'isolated-native-fixture',
      inventoryVersion: 'one',
      sourceCluster: 'fixture-cluster',
      sourceTimeline: 'fixture-timeline',
      sourceLineage: 'fixture-independent-source',
      capturePoint: 'fixture-before-confirmation',
      committedNativeTail: progress.checkpoint,
    };
    const restoredGeneration: AuthRestoredGeneration = {
      kind: 'RESTORED',
      generation: inventory.generation,
      databaseOwner: {
        async verifyRestoredDatabase({ database, generation }) {
          expect(database).toBe(restored);
          expect(generation).toBe(inventory.generation);
          expect(restored.idleCount).toBe(restored.totalCount);
          return inventory;
        },
        async recoverCommittedNativeProgress({ accountId }) {
          expect(accountId).toBe(victim.accountId);
          expect(restored.idleCount).toBe(restored.totalCount);
          return progress;
        },
      },
    };
    const id = await importRestoredAuthProgress(restored, restoredGeneration, victim.accountId);
    expect(await importRestoredAuthProgress(restored, restoredGeneration, victim.accountId)).toBe(id);
    const immutable = () =>
      restored.query(
        `SELECT barrier,accepted_at,source_route,kernel_version,kernel_at,
      user_deleted_at,consent_due_at,consent_completed_at,source_workflow_id,source_continuation_id,
      source_receipt_id,source_accepted_at,source_discharged_at,source_published_at FROM auth_erasure WHERE id=$1`,
        [id],
      );
    const before = (await immutable()).rows[0];
    expect(before).toMatchObject({
      barrier: original.barrier,
      source_route: source.route,
      kernel_at: original.kernel_at,
      user_deleted_at: original.user_deleted_at,
      consent_due_at: original.consent_due_at,
    });
    await expect(requireRestoredAuthAdmission(restored, restoredGeneration)).rejects.toMatchObject({
      code: 'source-authority-unavailable',
    });
    // Omitting the deployment declaration cannot bypass an already bound image.
    await expect(requireRestoredAuthAdmission(restored)).rejects.toMatchObject({ code: 'restore-lineage-unavailable' });
    await installNativeRoleCoverage(restored);
    for (let i = 0; i < 100; i++) if (!(await reconcileNativeRoleCoveragePage(restored))) break;
    // The original real deletion consumer must have actually discharged its
    // native need; Source root metadata alone is insufficient for cleanup.
    expect(original.source_discharged_at).toBeInstanceOf(Date);
    let changed = false;
    restoreQueries = failNativeQueries(restored, (sql) => {
      if (sql.startsWith('DELETE FROM "auth_effect_receipt"')) changed = true;
      return changed && sql.startsWith('UPDATE auth_restore_replay SET phase=');
    });
    let crashed = false;
    for (let i = 0; i < 160; i++) {
      try {
        await replayRestoredAuthPage(restored, restoredGeneration, id);
      } catch (error) {
        expect(String(error)).toContain('Injected native consumer interruption');
        crashed = true;
        break;
      }
    }
    expect(crashed).toBe(true);
    restoreQueries();
    expect(
      (await restored.query('SELECT 1 FROM auth_effect_receipt WHERE acting_human_id=$1', [victim.accountId])).rowCount,
    ).toBe(105);
    let firstPage = true;
    for (let i = 0; i < 180; i++) {
      await replayRestoredAuthPage(restored, restoredGeneration, id);
      const left = (
        await restored.query('SELECT 1 FROM auth_effect_receipt WHERE acting_human_id=$1', [victim.accountId])
      ).rowCount!;
      if (firstPage) {
        expect(left).toBe(57);
        firstPage = false;
      }
      if ((await restored.query('SELECT 1 FROM "user" WHERE id=$1', [victim.accountId])).rowCount === 0) break;
      if (i === 179) throw new Error('Existing bounded native engine did not reach restored user deletion');
    }
    expect(
      (await restored.query('SELECT 1 FROM auth_effect_receipt WHERE receipt_id=$1', ['living-witness'])).rowCount,
    ).toBe(1);
    expect((await restored.query('SELECT 1 FROM "user" WHERE id=$1', [living.accountId])).rowCount).toBe(1);
    expect((await immutable()).rows[0]).toEqual(before);
    expect(
      (await restored.query('SELECT due_at FROM auth_consent_erasure WHERE account_id=$1', [victim.accountId])).rows[0]!
        .due_at,
    ).toEqual(original.consent_due_at);
    // Old completion is not a seal or current Source/live-feed handoff.
    await expect(createAuthService({ ...closedOptions(restored), restoredGeneration })).rejects.toBeInstanceOf(
      AuthRestoreAdmissionError,
    );
    // No Source feed, external receiver or backup custody result is fabricated.
    expect(
      (
        await restored.query(
          'SELECT copies_completed_at FROM auth_restore_replay WHERE generation=$1 AND obligation_id=$2',
          [inventory.generation, id],
        )
      ).rows[0]!.copies_completed_at,
    ).toBeNull();
    const changedProgress = { ...progress, floor: progress.floor + 1 };
    restoredGeneration.databaseOwner!.recoverCommittedNativeProgress = async () => changedProgress;
    await expect(importRestoredAuthProgress(restored, restoredGeneration, victim.accountId)).rejects.toMatchObject({
      code: 'original-progress-mismatch',
    });
    expect((await immutable()).rows[0]).toEqual(before);
    // A new image always begins at the first native page even if an old image's
    // cursor had already passed those stores. No Source state is reset.
    inventory.generation = restoredGeneration.generation = 'native-fixture-copy-two';
    restoredGeneration.databaseOwner!.recoverCommittedNativeProgress = async () => progress;
    expect(await importRestoredAuthProgress(restored, restoredGeneration, victim.accountId)).toBe(id);
    expect(
      (
        await restored.query(
          'SELECT phase,user_replayed FROM auth_restore_replay WHERE generation=$1 AND obligation_id=$2',
          [inventory.generation, id],
        )
      ).rows[0],
    ).toEqual({ phase: 0, user_replayed: false });
    expect((await immutable()).rows[0]).toEqual(before);
  } finally {
    restoreQueries();
    await restored.end();
    copy.close();
    await f.close();
  }
}, 120_000);

test('missing original Auth tail stays pending even when an old restored image has no native obligation', async () => {
  const fixture = testDatabase();
  const database = new Pool({ connectionString: fixture.url });
  try {
    const restored: AuthRestoredGeneration = {
      kind: 'RESTORED',
      generation: 'missing-native-tail',
      databaseOwner: {
        async verifyRestoredDatabase() {
          return {
            generation: 'missing-native-tail',
            databaseIdentity: fixture.url,
            inventoryEntry: 'fixture',
            inventoryVersion: 'one',
            sourceCluster: 'fixture',
            sourceTimeline: 'fixture',
            sourceLineage: 'fixture',
            capturePoint: 'before',
            committedNativeTail: 'unavailable',
          };
        },
        async recoverCommittedNativeProgress() {
          return { pending: 'original-progress-unavailable' };
        },
      },
    };
    await expect(importRestoredAuthProgress(database, restored, 'absent-from-old-copy')).rejects.toMatchObject({
      code: 'original-progress-unavailable',
    });
    expect((await database.query('SELECT 1 FROM auth_erasure LIMIT 1')).rowCount).toBe(0);
  } finally {
    await database.end();
    fixture.close();
  }
});
