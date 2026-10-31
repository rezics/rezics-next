import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import {
  NATIVE_PHASE_END,
  NATIVE_V1_END,
  nativeV1ClientPhases,
  nativeV1Phases,
  nativePhases,
  nativePhaseComplete,
  upgradeNativeCursor,
} from '../src/erasure-role-upgrade.ts';
import { installNativeRoleCoverage } from '../src/erasure-coverage.ts';
import { nativeErasurePage, redriveNativeErasure, startNativeErasure } from '../src/erasure-native.ts';
import { testDatabase } from '../scripts/database.ts';

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
  expect(nativeV1Phases).toHaveLength(89);
  expect(nativeV1ClientPhases).toHaveLength(22);
  for (let phase = 0; phase <= NATIVE_V1_END; phase++) {
    for (let client_phase = 0; client_phase <= nativeV1ClientPhases.length; client_phase++) {
      const saved = { ...old, phase, client_phase };
      const upgraded = upgradeNativeCursor(saved);
      expect(upgraded).toEqual({ ...saved, native_phase_version: 2 });
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
  expect(nativePhases[NATIVE_V1_END]?.kind).toBe('unavailable');
  expect(nativePhaseComplete({ native_phase_version: 1, phase: NATIVE_PHASE_END })).toBe(false);
});

test('native phase adapter refuses unknown inventories, invalid phases and oversized raw boundaries', () => {
  for (const invalid of [
    { native_phase_version: 0 },
    { native_phase_version: 3 },
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
    expect(saved.native_phase_version).toBe(2);
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
