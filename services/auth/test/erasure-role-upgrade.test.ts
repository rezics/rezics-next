import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import {
  NATIVE_PHASE_END,
  NATIVE_PHASE_VERSION,
  nativeV2Phases,
  nativeClientPhases,
  NATIVE_V1_END,
  nativeV1ClientPhases,
  nativeV1Phases,
  nativePhases,
  nativePhaseComplete,
  upgradeNativeCursor,
} from '../src/erasure-role-upgrade.ts';
import { installNativeRoleCoverage, installNativeRoleProducer } from '../src/erasure-coverage.ts';
import { nativeErasurePage, redriveNativeErasure, startNativeErasure } from '../src/erasure-native.ts';
import { testDatabase } from '../scripts/database.ts';
import { NATIVE_CREATION_PARTY_PRODUCERS } from '../src/creation-party-context.ts';
import { nativeFixture } from './support/erasure-native.ts';

// These values represent saved old progress, not a fixture-created source
// witness or a cursor used to bypass native work in a product cleanup test.
const old = {
  native_phase_version: 1,
  phase: 0,
  client_phase: 0,
  client_id: 'original-client',
  after_key: 'raw-z-before-ä',
  applicable: true,
  barrier: 7,
  kernel_at: '2026-10-29T01:02:03Z',
  user_deleted_at: '2026-10-29T01:03:03Z',
  consent_due_at: '2026-10-29T01:08:13Z',
  consent_completed_at: null,
};

test('Version native erasure phases for full creation/request roles', () => {
  expect(NATIVE_PHASE_VERSION).toBe(3);
  expect(nativeV1Phases).toHaveLength(89);
  expect(nativeV1ClientPhases).toHaveLength(22);
  for (let phase = 0; phase <= NATIVE_V1_END; phase++) {
    for (let client_phase = 0; client_phase <= nativeV1ClientPhases.length; client_phase++) {
      const saved = { ...old, phase, client_phase };
      const upgraded = upgradeNativeCursor(saved);
      expect(upgraded).toEqual({ ...saved, native_phase_version: NATIVE_PHASE_VERSION });
      expect(saved.native_phase_version).toBe(1);
      if (phase < NATIVE_V1_END) expect(nativePhases[upgraded.phase]).toEqual(nativeV1Phases[phase]);
      expect(nativePhaseComplete(upgraded)).toBe(false);
    }
  }
  expect(nativeV1Phases[76]).toEqual({ kind: 'assertion' });
  expect(nativeV1Phases[77]).toEqual({ kind: 'public-key' });
  expect(nativeV1Phases[78]).toEqual({ kind: 'counter' });
  expect(nativeV1Phases[79]).toEqual({
    kind: 'request',
    table: 'auth_workflow_request',
    role: 'erasure_subject_id',
  });
  expect(nativePhases[NATIVE_V1_END]).toEqual({
    kind: 'subject',
    table: 'auth_registration_stage',
    role: 'erasure_actor_id',
  });
  expect(nativePhaseComplete({ native_phase_version: 1, phase: NATIVE_PHASE_END })).toBe(false);
});

test('native phase adapter refuses unknown inventories, invalid phases and oversized raw boundaries', () => {
  for (const invalid of [
    { native_phase_version: 0 },
    { native_phase_version: 4 },
    { phase: -1 },
    { phase: 0.5 },
    { phase: NATIVE_V1_END + 1 },
    { client_phase: -1 },
    { client_phase: 23 },
    { after_key: 'é'.repeat(513) },
    { client_id: 'x'.repeat(1025) },
  ])
    expect(() => upgradeNativeCursor({ ...old, ...invalid })).toThrow('cursor unavailable');
  const limit = { ...old, after_key: 'é'.repeat(512) };
  expect(upgradeNativeCursor(limit).after_key).toBe(limit.after_key);
});

test('native current dispatcher retains the original consent cutoff and stays pending for absent producer coverage after restart', async () => {
  const fixture = testDatabase();
  let pool = new Pool({ connectionString: fixture.url });
  try {
    installNativeRoleProducer(pool);
    // The original generic no-stage provisioning ABI is deliberately unclassified.
    // Its real guard records missing source custody; no readiness is seeded.
    await pool.query(`INSERT INTO auth_provisioning_receipt(idempotency_key,account_id,digest)
      VALUES ('generic-native-receipt','unrelated-native-subject',decode('00','hex'))`);
    expect(
      (
        await pool.query(
          "SELECT creation_context_version FROM auth_provisioning_receipt WHERE idempotency_key='generic-native-receipt'",
        )
      ).rows[0]!.creation_context_version,
    ).toBe(0);
    await installNativeRoleCoverage(pool);
    const id = await startNativeErasure(pool, 'no-native-user', 7);
    let pending = '';
    for (let page = 0; page < 100; page++) {
      pending = (await nativeErasurePage(pool, id)).code;
      if (pending === 'native-creation-roles-unavailable') break;
    }
    expect(pending).toBe('native-creation-roles-unavailable');
    const saved = (await pool.query('SELECT * FROM auth_erasure WHERE id=$1', [id])).rows[0]!;
    expect(saved.applicable).toBe(false);
    expect(saved.barrier).toBe(7);
    expect(saved.native_phase_version).toBe(NATIVE_PHASE_VERSION);
    expect(saved.phase).toBe(NATIVE_V1_END);
    expect(saved.native_completed_at).toBeNull();
    expect(saved.consent_completed_at).toBeNull();
    expect(saved.consent_due_at.getTime() - saved.user_deleted_at.getTime()).toBeGreaterThanOrEqual(309_000);
    expect(saved.consent_due_at.getTime() - saved.user_deleted_at.getTime()).toBeLessThanOrEqual(310_000);
    await pool.end();
    pool = new Pool({ connectionString: fixture.url });
    expect(await redriveNativeErasure(pool)).toBe(1);
    const resumed = (await pool.query('SELECT * FROM auth_erasure WHERE id=$1', [id])).rows[0]!;
    expect(resumed.consent_due_at).toEqual(saved.consent_due_at);
    expect(resumed.user_deleted_at).toEqual(saved.user_deleted_at);
    expect(resumed.phase).toBe(saved.phase);
    expect(resumed.native_completed_at).toBeNull();
    expect(resumed.revision > saved.revision).toBe(true);
  } finally {
    await pool.end();
    fixture.close();
  }
}, 30000);

test('native phase activation refuses old pages and separately leased old producers atomically', async () => {
  const fixture = testDatabase();
  const pool = new Pool({ connectionString: fixture.url });
  const oldLease = await pool.connect();
  try {
    const id = await startNativeErasure(pool, 'old-page', 1);
    await oldLease.query("SELECT set_config('auth.native_role_producer','1',false)");
    await expect(
      oldLease.query(
        "INSERT INTO auth_workflow_request(workflow_id,digest,request) VALUES('old-request',decode('00','hex'),'{}')",
      ),
    ).rejects.toThrow('Auth native phase producer version refused');
    await oldLease.query('BEGIN');
    await oldLease.query("SELECT set_config('auth.native_phase_worker','1',true)");
    await expect(oldLease.query('UPDATE auth_erasure SET phase=1 WHERE id=$1', [id])).rejects.toThrow(
      'Auth native phase worker version refused',
    );
    await oldLease.query('ROLLBACK');
    await oldLease.query('BEGIN');
    await oldLease.query("SELECT set_config('auth.erasure_obligation',$1,true)", [id]);
    await expect(oldLease.query('UPDATE auth_erasure SET phase=phase WHERE id=$1', [id])).rejects.toThrow(
      'Auth native phase worker version refused',
    );
    await oldLease.query('ROLLBACK');
    expect((await pool.query('SELECT phase FROM auth_erasure WHERE id=$1', [id])).rows[0]!.phase).toBe(0);
    expect((await pool.query("SELECT 1 FROM auth_workflow_request WHERE workflow_id='old-request'")).rowCount).toBe(0);
  } finally {
    oldLease.release();
    await pool.end();
    fixture.close();
  }
}, 30000);

test('Bind delivered native party producers into versioned erasure phases', () => {
  expect(nativeV2Phases).toHaveLength(91);
  expect(nativeV2Phases.slice(0, 88)).toEqual(nativeV1Phases.slice(0, 88));
  expect(nativeV2Phases[88]).toEqual({
    kind: 'unavailable',
    source: 'creation',
    code: 'native-creation-roles-unavailable',
  });
  expect(nativeV2Phases[89]).toEqual({
    kind: 'unavailable',
    source: 'request',
    code: 'native-request-roles-unavailable',
  });
  expect(nativeV2Phases[90]).toEqual({ kind: 'done' });
  expect(nativePhases.slice(88, 100)).toEqual([
    ...NATIVE_CREATION_PARTY_PRODUCERS[0].accountPhases,
    ...NATIVE_CREATION_PARTY_PRODUCERS[1].accountPhases,
  ]);
  expect(nativePhases[100]).toEqual({ kind: 'request', table: 'auth_workflow_request', role: 'erasure_actor_id' });
  expect(nativePhases[101]).toEqual({ kind: 'request', table: 'auth_workflow_request', role: 'erasure_principal_id' });
  expect(nativePhases[102]).toEqual({ kind: 'done' });
  expect(nativeClientPhases.slice(0, 22)).toEqual([...nativeV1ClientPhases]);
  expect(nativeClientPhases[22]).toBeNull();
  expect(nativeClientPhases[23]).toEqual({ table: 'auth_workflow_request', role: 'erasure_source_client_id' });
  expect(nativeClientPhases.slice(24)).toEqual([
    ...NATIVE_CREATION_PARTY_PRODUCERS[0].clientPhases,
    ...NATIVE_CREATION_PARTY_PRODUCERS[1].clientPhases,
  ]);
  expect(NATIVE_PHASE_END).toBe(102);
});

test('saved v2 placeholders and done retain original progress and never certify missing creation roles', () => {
  for (let phase = 0; phase <= 90; phase++) {
    for (let client_phase = 0; client_phase <= 22; client_phase++) {
      const saved = { ...old, native_phase_version: 2, phase, client_phase };
      const original = { ...saved };
      const upgraded = upgradeNativeCursor(saved);
      expect(saved).toEqual(original);
      expect(upgraded).toEqual({
        ...original,
        native_phase_version: 3,
        phase: phase < 88 ? phase : 88,
        after_key: phase < 88 ? original.after_key : '',
      });
      expect(nativePhaseComplete(upgraded)).toBe(false);
    }
  }
  for (const cursor of [
    { ...old, native_phase_version: 2, phase: 91 },
    { ...old, native_phase_version: 2, client_phase: 23 },
    { ...old, native_phase_version: 3, phase: 103 },
    { ...old, native_phase_version: 3, client_phase: 29 },
  ])
    expect(() => upgradeNativeCursor(cursor)).toThrow('cursor unavailable');
  const current = { ...old, native_phase_version: 3, phase: 90, after_key: 'own-role-boundary' };
  expect(upgradeNativeCursor(current)).toEqual({ ...current, native_phase_version: NATIVE_PHASE_VERSION });
  expect(nativePhaseComplete({ native_phase_version: 3, phase: 102 })).toBe(true);
});

test('current native creation producers advance through the actual appended phases', async () => {
  const f = await nativeFixture();
  try {
    const person = await f.person('native-phase-current');
    for (const producer of NATIVE_CREATION_PARTY_PRODUCERS) {
      const rows = await f.pool.query(
        `SELECT creation_context_version,erasure_actor_version FROM "${producer.table}" WHERE account_id=$1`,
        [person.accountId],
      );
      expect(rows.rowCount).toBe(1);
      expect(rows.rows[0]).toEqual({ creation_context_version: 1, erasure_actor_version: 1 });
    }
    expect((await f.delete(person)).status).toBe(200);
    const obligation = (await f.pool.query('SELECT id FROM auth_erasure WHERE account_id=$1', [person.accountId]))
      .rows[0]!;
    for (let page = 0; page < 140; page++) {
      await nativeErasurePage(f.pool, obligation.id);
      const row = (
        await f.pool.query('SELECT phase,native_completed_at FROM auth_erasure WHERE id=$1', [obligation.id])
      ).rows[0]!;
      if (row.native_completed_at) break;
      await Bun.sleep(100);
    }
    const completed = (
      await f.pool.query('SELECT phase,native_phase_version,native_completed_at FROM auth_erasure WHERE id=$1', [
        obligation.id,
      ])
    ).rows[0]!;
    expect(completed.phase).toBe(102);
    expect(completed.native_phase_version).toBe(3);
    expect(completed.native_completed_at).toBeInstanceOf(Date);
  } finally {
    await f.close();
  }
}, 120_000);

test('saved v2 request and done require independent native creation absence before skipping creation roles', async () => {
  const fixture = testDatabase();
  const pool = new Pool({ connectionString: fixture.url });
  try {
    installNativeRoleProducer(pool);
    await installNativeRoleCoverage(pool);
    for (const [version, phase] of [
      [1, 88],
      [2, 88],
      [2, 89],
      [2, 90],
    ] as const) {
      const client = await pool.connect();
      let id: string;
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('auth.native_phase_worker','3',true)");
        id = (
          await client.query(
            `INSERT INTO auth_erasure(account_id,barrier,version,applicable,native_phase_version,native_role_version,phase,after_key)
          VALUES ($1,7,1,false,$3,1,$2,'placeholder-boundary') RETURNING id`,
            ['v' + version + '-' + phase, phase, version],
          )
        ).rows[0]!.id;
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      await nativeErasurePage(pool, id!);
      const row = (
        await pool.query(
          'SELECT phase,after_key,native_phase_upgrade,native_completed_at FROM auth_erasure WHERE id=$1',
          [id!],
        )
      ).rows[0]!;
      expect(row.phase).toBe(phase === 88 ? 88 : 100);
      expect(row.after_key).toBe('');
      expect(row.native_phase_upgrade).toEqual({
        native_phase_version: version,
        phase,
        client_phase: 0,
        after_key: 'placeholder-boundary',
        client_id: null,
      });
      expect(row.native_completed_at).toBeNull();
    }
  } finally {
    await pool.end();
    fixture.close();
  }
}, 30000);
