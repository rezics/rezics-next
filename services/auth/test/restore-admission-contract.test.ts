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
import { failNativeQueries, nativeFixture, nativeFixtureResources, ownNativePool } from './support/erasure-native.ts';

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

// Only the unverified declaration is stored: refusal precedes signer/SDK work.
// A dependency returning a readiness flag cannot bypass the missing Source API.
test('An explicitly restored Auth generation remains closed before handler issuer workflow and writer admission until exact independent Source obligations and genuine original native progress are reconciled without renewing consent deadlines or claiming backup custody', async () => {
  const resources = nativeFixtureResources();
  try {
    const fixture = testDatabase();
    resources.own('restored database', () => fixture.close());
    const database = new Pool({ connectionString: fixture.url });
    ownNativePool(database, resources, 'restored Auth pool');
    await expect(createAuthService(closedOptions(database))).rejects.toMatchObject({
      name: 'AuthRestoreAdmissionError',
      code: 'database-owner-unavailable',
    });
    expect(
      (await database.query('SELECT inventory,native_coverage_started FROM auth_restore_generation')).rows,
    ).toEqual([{ inventory: null, native_coverage_started: false }]);
    await expect(requireRestoredAuthAdmission(database)).rejects.toMatchObject({ code: 'restore-lineage-unavailable' });
    expect((await database.query('SELECT 1 FROM auth_signing_key LIMIT 1')).rowCount).toBe(0);
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
    await resources.close();
  }
}, 60_000);

test('missing or ambiguous verified lineage refuses construction without reading or logging native payload', async () => {
  for (const pending of ['restore-lineage-unavailable', 'restore-lineage-mismatch'] as const) {
    const resources = nativeFixtureResources();
    try {
      const fixture = testDatabase();
      resources.own('restored database', () => fixture.close());
      const database = new Pool({ connectionString: fixture.url });
      ownNativePool(database, resources, 'restored Auth pool');
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
      expect((await database.query('SELECT inventory FROM auth_restore_generation')).rows).toEqual([
        { inventory: null },
      ]);
    } finally {
      await resources.close();
    }
  }
}, 60_000);

// These fixture inventory identities exercise native binding/refusal only.
// They are NOT a production backup verifier, sealed Source feed or certificate.
test('recover original committed Auth progress beyond the snapshot, replay bounded native bytes and retain the first consent cutoff and real consumer proof', async () => {
  const resources = nativeFixtureResources();
  let restoreQueries = () => {};
  try {
    const f = await nativeFixture();
    resources.own('native fixture', () => f.close());
    const copy = testDatabase();
    resources.own('restored database', () => copy.close());
    const restored = new Pool({ connectionString: copy.url, max: 1 });
    ownNativePool(restored, resources, 'restored Auth pool');
    resources.own('native query fault reset', () => restoreQueries());
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
      databaseIdentity: 'native-fixture-auth-database',
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
    await replayRestoredAuthPage(restored, restoredGeneration, id);
    expect(
      (await restored.query('SELECT store_index FROM auth_native_role_deployment WHERE singleton')).rows[0]!
        .store_index,
    ).toBe(0);
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
    expect(await importRestoredAuthProgress(restored, restoredGeneration, victim.accountId)).toBe(id);
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
    await resources.close();
  }
}, 120_000);

test('missing original Auth tail stays pending even when an old restored image has no native obligation', async () => {
  const resources = nativeFixtureResources();
  try {
    const fixture = testDatabase();
    resources.own('restored database', () => fixture.close());
    const database = new Pool({ connectionString: fixture.url });
    ownNativePool(database, resources, 'restored Auth pool');
    const restored: AuthRestoredGeneration = {
      kind: 'RESTORED',
      generation: 'missing-native-tail',
      databaseOwner: {
        async verifyRestoredDatabase() {
          return {
            generation: 'missing-native-tail',
            databaseIdentity: 'native-fixture-auth-database',
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
    await expect(requireRestoredAuthAdmission(database)).rejects.toMatchObject({ code: 'restore-lineage-unavailable' });
  } finally {
    await resources.close();
  }
});

// Delivered Source integration: all successful point/page/verifier values below
// come from native Access, never from a header/empty-page readiness callback.
import { newId } from '../../kernel/src/route/route.ts';
import { startNativeErasure } from '../src/erasure-native.ts';
import { stageRestoredAuthObligations } from '../src/restore-admission.ts';

// nativeFixture installs Reylo against its kernel database before these imports.
async function nativeSourceModules() {
  return {
    ...(await import('../../kernel/src/access/auth-erasure-obligations.ts')),
    ...(await import('../../kernel/src/access/lifecycle.ts')),
    ...(await import('../../kernel/test/support/admitted-access.ts')),
  };
}

async function nativeRestoreRoot(f: Awaited<ReturnType<typeof nativeFixture>>, route: number) {
  const {
    admittedAccess,
    authenticateAccount,
    createLifecycleCommands,
    LIFECYCLE_ACTIONS,
    createAuthErasureObligationBindings,
  } = await nativeSourceModules();
  const accountId = newId(route);
  await f.kernel.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
     VALUES($1,$2,'actor','active',$2)`,
    [route, accountId],
  );
  await f.kernel.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES($1,$2,$2,'account:delete','(,)'::tstzrange,$2)`,
    [route, accountId],
  );
  const access = admittedAccess({ actions: LIFECYCLE_ACTIONS });
  const actor = await authenticateAccount(
    access,
    { pool: f.kernel, deadline: Date.now() + 10000 },
    {
      accountId,
      clientId: 'restore-native-source',
      scopes: [...LIFECYCLE_ACTIONS.keys()],
    },
  );
  await createLifecycleCommands({ pool: f.kernel, access }).tombstone(
    { actor, deadline: Date.now() + 10000 },
    { accountId, key: crypto.randomUUID() },
  );
  const point = await createAuthErasureObligationBindings(f.kernel).readAuthErasureObligation({
    accountId,
    deadline: Date.now() + 10000,
  });
  if (point.state !== 'ready') throw new Error('Actual native tombstone did not produce its obligation');
  // This is real ORIGINAL Auth progress in the surviving database, not progress
  // synthesized in the old restored snapshot from Source alone.
  await startNativeErasure(f.pool, accountId, Number(point.obligation.minimumAuthnEpoch), point.obligation);
  return point.obligation;
}

async function restoredNativeOwner(
  f: Awaited<ReturnType<typeof nativeFixture>>,
  database: Pool,
  generation: string,
): Promise<AuthRestoredGeneration> {
  const { createAuthErasureObligationBindings } = await nativeSourceModules();
  const inventory: AuthRestoreInventory = {
    generation,
    databaseIdentity: 'isolated-native-auth-fixture',
    inventoryEntry: generation,
    inventoryVersion: 'one',
    sourceCluster: 'native-fixture-cluster',
    sourceTimeline: 'native-fixture-timeline',
    sourceLineage: 'independent-current-access',
    capturePoint: 'before-confirmations',
    committedNativeTail: 'surviving-native-auth-database',
  };
  const recovered = new Map<string, AuthRestoreNativeProgress>();
  return {
    kind: 'RESTORED',
    generation,
    obligations: createAuthErasureObligationBindings(f.kernel),
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
}

test('Actual native Access obligation page and point bind immutable restored Auth progress and durable bounded checkpoints before admission while unknown original floor Source lineage receiving or live handoff remains closed', async () => {
  const resources = nativeFixtureResources();
  let unfault = () => {};
  try {
    const f = await nativeFixture();
    resources.own('native fixture', () => f.close());
    const copy = testDatabase();
    resources.own('restored database', () => copy.close());
    const database = new Pool({ connectionString: copy.url, max: 1 });
    ownNativePool(database, resources, 'restored Auth pool');
    resources.own('native query fault reset', () => unfault());
    const roots = [];
    for (let i = 0; i < 49; i++) roots.push(await nativeRestoreRoot(f, 15));
    const highRoute = await nativeRestoreRoot(f, 65535);
    const restored = await restoredNativeOwner(f, database, 'native-obligation-page-copy');
    const native = restored.obligations!;
    let pageDeadline = 0;
    const cuts = new Set<string>();
    restored.obligations = {
      async startAuthErasureObligationCut(input) {
        expect(database.idleCount).toBe(database.totalCount);
        cuts.add(input.cutId);
        pageDeadline = input.deadline;
        return native.startAuthErasureObligationCut(input);
      },
      async pageAuthErasureObligations(input) {
        expect(database.idleCount).toBe(database.totalCount);
        expect(input.deadline).toBe(pageDeadline);
        return native.pageAuthErasureObligations(input);
      },
      async readAuthErasureObligation(input) {
        expect(database.idleCount).toBe(database.totalCount);
        expect(input.deadline).toBe(pageDeadline);
        return native.readAuthErasureObligation(input);
      },
      async verifyAuthErasureObligationCut(input) {
        expect(database.idleCount).toBe(database.totalCount);
        expect(input.deadline).toBe(pageDeadline);
        return native.verifyAuthErasureObligationCut(input);
      },
    };
    // Crash AFTER genuine imports but BEFORE the corresponding page checkpoint.
    unfault = failNativeQueries(database, (sql) => sql.startsWith('UPDATE auth_restore_generation SET source_cut='));
    await expect(stageRestoredAuthObligations(database, restored)).rejects.toThrow(
      'Injected native consumer interruption',
    );
    unfault();
    const state = async () =>
      (
        await database.query(
          'SELECT source_cut_id,source_cursor,source_verify_partition FROM auth_restore_generation WHERE generation=$1',
          [restored.generation],
        )
      ).rows[0]!;
    expect((await state()).source_cursor).toEqual({ partition: 0, afterOrdinal: '0' });
    expect((await database.query('SELECT 1 FROM auth_restore_replay')).rowCount).toBe(48);
    await stageRestoredAuthObligations(database, restored);
    expect((await database.query('SELECT 1 FROM auth_restore_replay')).rowCount).toBe(48);
    expect((await state()).source_cursor).toEqual({ partition: 0, afterOrdinal: roots[47]!.ordinal });
    await stageRestoredAuthObligations(database, restored);
    expect((await database.query('SELECT 1 FROM auth_restore_replay')).rowCount).toBe(49);
    expect((await state()).source_cursor).toEqual({ partition: 1, afterOrdinal: '0' });
    // Every empty partition is actually visited. Header/EOF alone cannot admit.
    for (let i = 1; i < 4096; i++) await stageRestoredAuthObligations(database, restored);
    expect((await state()).source_cursor).toBeNull();
    expect((await state()).source_verify_partition).toBe(0);
    const bound = (
      await database.query(
        `SELECT r.source_obligation,r.original_progress,e.source_route,e.barrier,r.obligation_id
       FROM auth_restore_replay r JOIN auth_erasure e ON e.id=r.obligation_id WHERE e.account_id=$1`,
        [highRoute.accountId],
      )
    ).rows[0]!;
    expect(bound.source_obligation).toEqual(highRoute);
    expect(bound.source_route).toBe(65535);
    expect(String(bound.barrier)).toBe(highRoute.minimumAuthnEpoch);
    expect(bound.original_progress.source.at).toBe(highRoute.at);
    expect(cuts.size).toBe(1);
    expect((await database.query('SELECT 1 FROM auth_restore_source_partition')).rowCount).toBe(4096);
    for (let i = 0; i < 4095; i++) await stageRestoredAuthObligations(database, restored);
    expect(await stageRestoredAuthObligations(database, restored)).toEqual({ pending: 'source-live-handoff-pending' });
    const observation = (
      await database.query(
        'SELECT verification FROM auth_restore_source_partition WHERE generation=$1 AND partition=4095',
        [restored.generation],
      )
    ).rows[0]!.verification;
    expect(observation).toMatchObject({
      state: 'current',
      highWater: highRoute.ordinal,
      liveHighWater: highRoute.ordinal,
    });
    expect(observation.sourceGeneration).toBeString();
    expect(observation.sourceOwner).toBeString();
    expect(observation.sourceEpoch).toBeNumber();
    await expect(requireRestoredAuthAdmission(database, restored)).rejects.toMatchObject({
      code: 'source-live-handoff-pending',
    });
    await expect(createAuthService({ ...closedOptions(database), restoredGeneration: restored })).rejects.toMatchObject(
      { code: 'source-live-handoff-pending' },
    );
    expect((await database.query('SELECT 1 FROM auth_signing_key')).rowCount).toBe(0);
    // Source-only discovery has neither released the original consumer nor
    // cleaned copies or manufactured receiving/physical readiness.
    expect(
      (
        await database.query('SELECT copies_completed_at FROM auth_restore_replay WHERE obligation_id=$1', [
          bound.obligation_id,
        ])
      ).rows[0]!.copies_completed_at,
    ).toBeNull();
    expect(await replayRestoredAuthPage(database, restored, bound.obligation_id)).toHaveProperty('pending');
    await expect(
      database.query('UPDATE auth_restore_generation SET source_cut_id=gen_random_uuid()'),
    ).rejects.toThrow();
    await expect(
      database.query(
        `UPDATE auth_restore_replay SET source_obligation=jsonb_set(source_obligation,'{receiptId}','"changed"')`,
      ),
    ).rejects.toThrow();
    const later = await nativeRestoreRoot(f, 65535);
    expect(later.ordinal).not.toBe(highRoute.ordinal);
    expect(
      (
        await native.verifyAuthErasureObligationCut({
          cutId: (await state()).source_cut_id,
          partition: 4095,
          deadline: Date.now() + 10000,
        })
      ).state,
    ).toBe('pending');
    await expect(requireRestoredAuthAdmission(database, restored)).rejects.toMatchObject({
      code: 'source-live-handoff-pending',
    });
    expect(cuts.size).toBe(1);
  } finally {
    await resources.close();
  }
}, 240_000);

// Fault wrappers below only deny/change actual native reads; none supplies
// successful Source authority, native original progress or external proof.
test('native Source point disagreement, exact floor domain and missing original Auth tail never import replacement progress', async () => {
  const resources = nativeFixtureResources();
  try {
    const f = await nativeFixture();
    resources.own('native fixture', () => f.close());
    const copy = testDatabase();
    resources.own('restored database', () => copy.close());
    const database = new Pool({ connectionString: copy.url, max: 1 });
    ownNativePool(database, resources, 'restored Auth pool');
    const root = await nativeRestoreRoot(f, 65535);
    const restored = await restoredNativeOwner(f, database, 'point-mismatch-copy');
    const native = restored.obligations!;
    for (const minimumAuthnEpoch of ['2147483648', '9007199254740993', '1.5', '02', '-1', '2e0']) {
      restored.obligations = {
        ...native,
        async readAuthErasureObligation(input) {
          const point = await native.readAuthErasureObligation(input);
          if (point.state !== 'ready') return point;
          return { state: 'ready', obligation: { ...point.obligation, minimumAuthnEpoch } };
        },
      };
      await expect(importRestoredAuthProgress(database, restored, root.accountId)).rejects.toMatchObject({
        code: 'original-progress-mismatch',
      });
    }
    restored.obligations = native;
    const recover = restored.databaseOwner!.recoverCommittedNativeProgress;
    const genuine = await recover({ inventory: {} as AuthRestoreInventory, accountId: root.accountId });
    if ('pending' in genuine) throw new Error('Missing original native progress');
    for (const changed of [
      { ...genuine, floor: genuine.floor + 1 },
      { ...genuine, source: { ...genuine.source, route: 4095 } },
      { ...genuine, source: { ...genuine.source, version: genuine.source.version + 1 } },
      { ...genuine, source: { ...genuine.source, at: new Date(0).toISOString() } },
    ]) {
      restored.databaseOwner!.recoverCommittedNativeProgress = async () => changed;
      await expect(importRestoredAuthProgress(database, restored, root.accountId)).rejects.toMatchObject({
        code: 'original-progress-mismatch',
      });
    }
    restored.databaseOwner!.recoverCommittedNativeProgress = async () => ({ pending: 'original-progress-unavailable' });
    await expect(importRestoredAuthProgress(database, restored, root.accountId)).rejects.toMatchObject({
      code: 'original-progress-unavailable',
    });
    expect((await database.query('SELECT 1 FROM auth_erasure')).rowCount).toBe(0);
    restored.databaseOwner!.recoverCommittedNativeProgress = recover;
    const id = await importRestoredAuthProgress(database, restored, root.accountId);
    expect(
      (await database.query('SELECT source_route FROM auth_erasure WHERE id=$1', [id])).rows[0]!.source_route,
    ).toBe(65535);
    await f.kernel.query('UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=4095');
    await expect(importRestoredAuthProgress(database, restored, root.accountId)).rejects.toMatchObject({
      code: 'source-consumer-pending',
    });
    await expect(requireRestoredAuthAdmission(database)).rejects.toMatchObject({ code: 'restore-lineage-unavailable' });
  } finally {
    await resources.close();
  }
}, 120_000);

test('native pending original floor and changed Source ownership retain the exact bounded page and never advance past it', async () => {
  const resources = nativeFixtureResources();
  try {
    const f = await nativeFixture();
    resources.own('native fixture', () => f.close());
    const copy = testDatabase();
    resources.own('restored database', () => copy.close());
    const database = new Pool({ connectionString: copy.url, max: 1 });
    ownNativePool(database, resources, 'restored Auth pool');
    const accountId = newId(16);
    await f.kernel.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
      VALUES(16,$1,'actor','active',$1)`,
      [accountId],
    );
    await f.kernel.query(
      "UPDATE access.account SET state='deleted',authn_fenced=true,minimum_authn_epoch=123 WHERE route=16 AND account_id=$1",
      [accountId],
    );
    await f.kernel.query('INSERT INTO access.erasure(route,account_id,version,at) VALUES(16,$1,1,clock_timestamp())', [
      accountId,
    ]);
    const restored = await restoredNativeOwner(f, database, 'unknown-original-floor-copy');
    await stageRestoredAuthObligations(database, restored);
    await stageRestoredAuthObligations(database, restored);
    const checkpoint = async () =>
      (await database.query('SELECT source_cut_id,source_cursor FROM auth_restore_generation')).rows[0]!;
    const before = await checkpoint();
    expect(before.source_cursor).toEqual({ partition: 1, afterOrdinal: '0' });
    const page = (await database.query('SELECT page FROM auth_restore_source_partition WHERE partition=1')).rows[0]!
      .page;
    expect(page).toMatchObject({ state: 'pending', pending: [{ accountId, reason: 'original-floor-unavailable' }] });
    expect((await database.query('SELECT 1 FROM auth_erasure')).rowCount).toBe(0);
    await f.kernel.query('UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=1');
    await stageRestoredAuthObligations(database, restored);
    expect(await checkpoint()).toEqual(before);
    expect(
      (await database.query('SELECT page FROM auth_restore_source_partition WHERE partition=1')).rows[0]!.page,
    ).toMatchObject({ state: 'pending', reason: 'source-unavailable' });
    await expect(requireRestoredAuthAdmission(database, restored)).rejects.toMatchObject({
      code: 'source-consumer-pending',
    });
  } finally {
    await resources.close();
  }
}, 120_000);
