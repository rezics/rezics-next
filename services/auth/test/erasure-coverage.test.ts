import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { testDatabase } from '../scripts/database.ts';
import { NATIVE_CREATION_PARTY_PRODUCERS } from '../src/creation-party-context.ts';
import {
  installNativeRoleCoverage,
  installNativeRoleProducer,
  nativeRoleCoverageComplete,
  nativeRoleDeploymentComplete,
  reconcileNativeRoleCoveragePage,
} from '../src/erasure-coverage.ts';
import { nativePhaseExtensions } from '../src/erasure-role-upgrade.ts';
import { NATIVE_REQUEST_PARTY_PRODUCER } from '../src/workflow-request-parties.ts';

test('fresh native coverage binds the exact delivered creation and request producers under the writer cut', async () => {
  const fixture = testDatabase();
  const pool = new Pool({ connectionString: fixture.url });
  try {
    expect(await nativeRoleCoverageComplete(pool)).toBe(false);
    await installNativeRoleCoverage(pool);
    expect(await nativeRoleDeploymentComplete(pool)).toBe(true);
    expect(await reconcileNativeRoleCoveragePage(pool)).toBe(0);
    expect(nativePhaseExtensions).toEqual([
      ...NATIVE_CREATION_PARTY_PRODUCERS[0].accountPhases,
      ...NATIVE_CREATION_PARTY_PRODUCERS[1].accountPhases,
      ...NATIVE_REQUEST_PARTY_PRODUCER.accountPhases,
    ]);
    expect(nativePhaseExtensions).toHaveLength(14);
    expect(nativePhaseExtensions.filter((phase) => phase.kind === 'unavailable')).toEqual([]);
    expect(await nativeRoleCoverageComplete(pool)).toBe(true);
    await installNativeRoleCoverage(pool);
    expect(await nativeRoleCoverageComplete(pool)).toBe(true);
  } finally {
    await pool.end();
    fixture.close();
  }
}, 30000);

test('native deployment EOF is independent of missing original creation/request producer custody', async () => {
  const fixture = testDatabase();
  const pool = new Pool({ connectionString: fixture.url });
  try {
    installNativeRoleProducer(pool);
    // The original no-stage receipt ABI records source-unavailable itself.
    // No current relation can supply its missing original creation parties.
    await pool.query(`INSERT INTO auth_provisioning_receipt(idempotency_key,account_id,digest)
      VALUES ('generic-native-receipt','unrelated-native-subject',decode('00','hex'))`);
    expect(
      (
        await pool.query(`SELECT creation_context_version,erasure_actor_id,erasure_human_id,
          erasure_principal_id,erasure_source_client_id FROM auth_provisioning_receipt
          WHERE idempotency_key='generic-native-receipt'`)
      ).rows[0],
    ).toEqual({
      creation_context_version: 0,
      erasure_actor_id: null,
      erasure_human_id: null,
      erasure_principal_id: null,
      erasure_source_client_id: null,
    });
    expect(
      (await pool.query('SELECT reason FROM auth_native_role_unknown WHERE store=$1', ['auth_provisioning_receipt']))
        .rows,
    ).toEqual([{ reason: 'source-unavailable' }]);
    await installNativeRoleCoverage(pool);
    expect(await nativeRoleDeploymentComplete(pool)).toBe(true);
    expect(await reconcileNativeRoleCoveragePage(pool)).toBe(0);
    expect(await nativeRoleCoverageComplete(pool)).toBe(false);
    // Repeated startup cannot turn an absent source into a native proof.
    await installNativeRoleCoverage(pool);
    expect(await nativeRoleCoverageComplete(pool)).toBe(false);
  } finally {
    await pool.end();
    fixture.close();
  }
}, 30000);

test('native cached clients and pg method returns retain the current producer lease release', async () => {
  const fixture = testDatabase();
  const pool = new Pool({ connectionString: fixture.url, max: 1 });
  installNativeRoleProducer(pool);
  try {
    let previous;
    for (let attempt = 0; attempt < 3; attempt++) {
      const client = await pool.connect();
      try {
        if (previous) expect(client).toBe(previous);
        previous = client;
        const notice = () => {};
        // pg methods return the physical client. A separate facade lets a
        // chained release bypass the marker reset and leaves its lease live.
        expect(client.on('notice', notice).removeListener('notice', notice)).toBe(client);
        await client.query('BEGIN');
        expect(
          (
            await client.query(`SELECT current_setting('auth.native_role_producer') AS role,
          current_setting('auth.native_phase_producer') AS phase`)
          ).rows,
        ).toEqual([{ role: '1', phase: '3' }]);
        await client.query(attempt === 1 ? 'ROLLBACK' : 'COMMIT');
      } finally {
        await client.release();
      }
    }
    // Pool.query uses pg's callback checkout and release path on this same client.
    expect((await pool.query('SELECT 1 AS settled')).rows).toEqual([{ settled: 1 }]);
  } finally {
    await pool.end();
    fixture.close();
  }
}, 30000);
