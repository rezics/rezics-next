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
