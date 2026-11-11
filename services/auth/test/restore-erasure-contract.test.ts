import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { testDatabase } from '../scripts/database.ts';
import { nativeErasurePage, startNativeErasure } from '../src/erasure-native.ts';
import { failNativeQueries, nativeFixture } from './support/erasure-native.ts';
import { createAuthRestoreHost } from '../src/host.ts';
import { importRestoredAuthProgress, requireRestoredAuthAdmission } from '../src/restore-admission.ts';

// Controlled old images exercise the delivered native Source and isolated host.
// Physical deployment and backup expiry cases below remain external acceptance;
// a successful Source read never supplies receiving or terminal evidence.

test('native restore Source preserves the committed deletion while an isolated old image waits for actual receiving closure', async () => {
  const f = await nativeFixture();
  const restoredFixture = testDatabase();
  const restored = new Pool({ connectionString: restoredFixture.url });
  try {
    const person = await f.person('restore-before-confirmation');
    const living = await f.person('restore-living');
    const snapshot = (
      await f.pool.query('SELECT * FROM "user" WHERE id=ANY($1) ORDER BY id', [[person.accountId, living.accountId]])
    ).rows;
    expect((await f.pool.query('SELECT 1 FROM auth_erasure WHERE account_id=$1', [person.accountId])).rowCount).toBe(0);
    expect((await f.delete(person)).status).toBe(200);
    const source = (
      await f.kernel.query('SELECT route,account_id,version,at FROM access.erasure WHERE route=$1 AND account_id=$2', [
        f.routeOf(person.accountId),
        person.accountId,
      ])
    ).rows[0]!;
    expect(source.account_id).toBe(person.accountId);
    expect(source.at).toBeInstanceOf(Date);
    // Controlled native fixture data, not a claim that a production backup API
    // exists. Independent Access retains the later confirmation while the old
    // Auth image has living-looking native rows and no erasure progress.
    for (const row of snapshot)
      await restored.query('INSERT INTO "user" SELECT * FROM json_populate_record(NULL::"user", $1::json)', [
        JSON.stringify(row),
      ]);
    expect((await restored.query('SELECT id FROM "user" ORDER BY id')).rows).toEqual(
      snapshot.map(({ id }) => ({ id })),
    );
    expect((await restored.query('SELECT 1 FROM auth_erasure WHERE account_id=$1', [person.accountId])).rowCount).toBe(
      0,
    );
    const current = await f.bindings.trustedAccess.readErasureAccount?.(person.accountId);
    expect(current).toMatchObject({ accountId: person.accountId, state: 'deleted', fenced: true });
    const generation = f.restoredGeneration(restored, 'before-confirmation-copy');
    const point = await generation.obligations!.readAuthErasureObligation({
      accountId: person.accountId,
      deadline: Date.now() + 5000,
    });
    expect(point.state).toBe('ready');
    if (point.state !== 'ready') throw new Error('Missing native Source obligation');
    expect(point.obligation).toMatchObject({
      route: source.route,
      accountId: source.account_id,
      version: source.version,
      at: (await f.bindings.trustedAccess.readAuthErasureBarrier!(person.accountId))!.at,
      minimumAuthnEpoch: String(current!.authnEpoch),
    });
    expect(new Date(point.obligation.at).getTime()).toBe(source.at.getTime());
    // The database owner recovers the independently surviving Auth tail, rather
    // than deriving an original floor, applicability or cutoff from the old image.
    const inventory = await generation.databaseOwner!.verifyRestoredDatabase({
      database: restored,
      generation: generation.generation,
    });
    if ('pending' in inventory) throw new Error('Missing controlled fixture inventory');
    const progress = await generation.databaseOwner!.recoverCommittedNativeProgress({
      inventory,
      accountId: person.accountId,
    });
    const original = (await f.pool.query('SELECT * FROM auth_erasure WHERE account_id=$1', [person.accountId]))
      .rows[0]!;
    expect(progress).toMatchObject({
      source: { route: source.route, accountId: person.accountId, version: source.version, at: original.kernel_at },
      floor: original.barrier,
      applicable: original.applicable,
      userDeletion: { consentDueAt: original.consent_due_at.toISOString() },
    });
    await expect(importRestoredAuthProgress(restored, generation, person.accountId)).rejects.toMatchObject({
      code: 'receiving-closure-pending',
    });
    await expect(requireRestoredAuthAdmission(restored, generation)).rejects.toMatchObject({
      name: 'AuthRestoreAdmissionError',
    });
    expect((await restored.query('SELECT 1 FROM auth_restore_replay')).rowCount).toBe(0);
    expect((await restored.query('SELECT 1 FROM auth_signing_key')).rowCount).toBe(0);
    expect((await restored.query('SELECT id FROM "user" ORDER BY id')).rows).toEqual(
      snapshot.map(({ id }) => ({ id })),
    );
  } finally {
    await restored.end();
    restoredFixture.close();
    await f.close();
  }
}, 120_000);

test('restore replay after a native crash retains the original floor, applicability and exact page while preserving living evidence', async () => {
  const fixture = testDatabase();
  let pool = new Pool({ connectionString: fixture.url });
  let restoreQueries = () => {};
  try {
    await pool.query(`INSERT INTO auth_effect_receipt (receipt_id,account_id,purpose,minimum_authn_epoch,acting_human_id)
      SELECT 'restore-crash-'||lpad(i::text,3,'0'),'living-subject','sessions',7,'erased-human'
      FROM generate_series(1,105) i;
      INSERT INTO auth_effect_receipt (receipt_id,account_id,purpose,minimum_authn_epoch)
      VALUES ('living-witness','living-subject','sessions',7)`);
    const id = await startNativeErasure(pool, 'erased-human', 7);
    const original = (await pool.query('SELECT id,barrier,applicable,accepted_at FROM auth_erasure WHERE id=$1', [id]))
      .rows[0];
    let changed = false;
    restoreQueries = failNativeQueries(pool, (sql) => {
      if (sql.startsWith('DELETE FROM "auth_effect_receipt"')) changed = true;
      return changed && sql.startsWith('UPDATE auth_erasure SET phase=');
    });
    await expect(
      (async () => {
        for (let page = 0; page < 100; page++) {
          const result = await nativeErasurePage(pool, id);
          if (result.state !== 'more') throw new Error(`Unexpected native hold before crash: ${result.code}`);
        }
        throw new Error('Native crash injection did not reach the selected source page');
      })(),
    ).rejects.toThrow('Injected native consumer interruption');
    restoreQueries();
    expect(
      (await pool.query('SELECT 1 FROM auth_effect_receipt WHERE acting_human_id=$1', ['erased-human'])).rowCount,
    ).toBe(105);
    await pool.end();
    pool = new Pool({ connectionString: fixture.url });
    restoreQueries = () => {};
    expect(await startNativeErasure(pool, 'erased-human', 99)).toBe(id);
    for (let page = 0; page < 100; page++) {
      const result = await nativeErasurePage(pool, id);
      if (result.state !== 'more') break;
      if (page === 99) throw new Error('Native replay exceeded its fixed phase budget');
    }
    expect(
      (await pool.query('SELECT 1 FROM auth_effect_receipt WHERE acting_human_id=$1', ['erased-human'])).rowCount,
    ).toBe(0);
    expect(
      (await pool.query('SELECT 1 FROM auth_effect_receipt WHERE receipt_id=$1', ['living-witness'])).rowCount,
    ).toBe(1);
    expect(
      (await pool.query('SELECT id,barrier,applicable,accepted_at FROM auth_erasure WHERE id=$1', [id])).rows[0],
    ).toEqual(original);
    // Same-database crash recovery proves the original native transaction only.
    // It cannot admit an independently restored image or assert backup expiry.
    expect((await pool.query('SELECT 1 FROM auth_restore_replay')).rowCount).toBe(0);
  } finally {
    restoreQueries();
    await pool.end();
    fixture.close();
  }
}, 60_000);

test('restored stale sessions, issuers and late writers remain fenced without renewing the original consent or source deadline', async () => {
  const f = await nativeFixture();
  try {
    const person = await f.person('restore-stale-issuer');
    const before = (
      await f.pool.query('SELECT id,token,"authnEpoch" FROM session WHERE "userId"=$1', [person.accountId])
    ).rows;
    expect(before.length).toBeGreaterThan(0);
    expect((await f.delete(person)).status).toBe(200);
    const original = (await f.pool.query('SELECT * FROM auth_erasure WHERE account_id=$1', [person.accountId]))
      .rows[0]!;
    expect(original.consent_due_at).toBeInstanceOf(Date);
    const delayed = original.consent_due_at.getTime() - original.user_deleted_at.getTime();
    // Native clock_timestamp calls can differ within the deletion transaction.
    expect(delayed).toBeGreaterThanOrEqual(309_000);
    expect(delayed).toBeLessThanOrEqual(310_000);
    expect((await f.call('/token', {}, person.cookie)).status).not.toBe(200);
    await expect(
      f.pool.query(`INSERT INTO auth_consent (account_id,client_id,scopes) VALUES ($1,'erasure-web','{}')`, [
        person.accountId,
      ]),
    ).rejects.toThrow('Auth erasure fence');
    expect(await f.host.service.internal.startAccountErasure(person.accountId)).toBe(original.id);
    const repeated = (
      await f.pool.query('SELECT barrier,consent_due_at FROM auth_erasure WHERE account_id=$1', [person.accountId])
    ).rows[0];
    expect(repeated).toEqual({ barrier: original.barrier, consent_due_at: original.consent_due_at });
    const copy = testDatabase();
    const database = new Pool({ connectionString: copy.url });
    const restore = createAuthRestoreHost({
      database,
      restoredGeneration: f.restoredGeneration(database, 'stale-session-copy'),
      trustedAccess: f.bindings.trustedAccess,
    });
    try {
      expect('handler' in restore).toBe(false);
      expect('service' in restore).toBe(false);
      expect(await restore.reconcile()).toEqual({ pending: 'source-consumer-pending' });
      expect((await database.query('SELECT 1 FROM auth_signing_key')).rowCount).toBe(0);
      expect((await database.query('SELECT 1 FROM auth_restore_replay')).rowCount).toBe(0);
      expect(
        (await f.pool.query('SELECT barrier,consent_due_at FROM auth_erasure WHERE account_id=$1', [person.accountId]))
          .rows[0],
      ).toEqual(repeated);
    } finally {
      await restore.stop();
      copy.close();
    }
  } finally {
    await f.close();
  }
}, 120_000);

for (const missing of [
  'unavailable current source',
  'wrong backup lineage/version',
  'copy with an older completed marker',
  'unproved backup expiry',
] as const) {
  test(`restore custody refuses ${missing} rather than accepting absent configuration or elapsed TTL as none`, async () => {
    const fixture = testDatabase();
    const pool = new Pool({ connectionString: fixture.url });
    try {
      // Even a truly empty native fixture supplies neither a surviving deletion
      // boundary nor a sealed receiving inventory for any historical backup.
      expect((await pool.query('SELECT 1 FROM auth_erasure LIMIT 1')).rowCount).toBe(0);
      throw new Error(
        `Missing database/deployment restore interface: ${missing}; require actual inventory-bound restore isolation, Access sealed replay boundary and irreversible copy/expiry proof, with living rows unchanged`,
      );
    } finally {
      await pool.end();
      fixture.close();
    }
  }, 60_000);
}
