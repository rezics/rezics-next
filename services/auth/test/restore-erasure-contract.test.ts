import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { testDatabase } from '../scripts/database.ts';
import { nativeErasurePage, startNativeErasure } from '../src/erasure-native.ts';
import { failNativeQueries, nativeFixture } from './support/erasure-native.ts';

// These are future native acceptance cases, not a test-only restore service.
// Row snapshots below establish exactly what a before-T copy would reintroduce.
// The actual isolated restore/source-feed producer is absent and stays honest red.
// Never transplant Access SQL, manufacture a source T or reset product fences.

test('a backup predating confirmation cannot lose the exact committed source deletion and T on an empty restored Auth progress store', async () => {
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
    // Existing source port supplies only AccessAccount; this is deliberately
    // the missing real source metadata assertion, not a fake restore receipt.
    expect(current).toHaveProperty('erasure', {
      route: source.route,
      accountId: source.account_id,
      version: source.version,
      at: source.at.toISOString(),
    });
    throw new Error(
      'Missing adoption: Access sealed bounded Auth obligation feed and isolated restore bootstrap importing the original source tuple before handlers, issuers, DBOS recovery or personal reads open',
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
    throw new Error(
      'Missing restore admission: bind native replay checkpoints to the restored copy generation and original Access T; native same-database crash recovery alone cannot certify an older restored image',
    );
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
    throw new Error(
      'Missing isolated restore admission: reintroduce the actual old session/signing/workflow copy only behind current source fencing, recover original consent due evidence and drain before serving; no restored completion may renew source authority',
    );
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
