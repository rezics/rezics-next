import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { testDatabase } from '../scripts/database.ts';
import {
  installNativeRoleCoverage,
  nativeRoleCoverageComplete,
  nativeRoleDeploymentComplete,
  reconcileNativeRoleCoveragePage,
} from '../src/erasure-coverage.ts';
import { nativePhaseExtensions } from '../src/erasure-role-upgrade.ts';

test('native deployment EOF is independent of missing original creation/request producer custody', async () => {
  const fixture = testDatabase();
  const pool = new Pool({ connectionString: fixture.url });
  try {
    await installNativeRoleCoverage(pool);
    expect(await nativeRoleDeploymentComplete(pool)).toBe(true);
    expect(await reconcileNativeRoleCoveragePage(pool)).toBe(0);
    expect(await nativeRoleCoverageComplete(pool)).toBe(false);
    expect(nativePhaseExtensions.filter((phase) => phase.kind === 'unavailable').map((phase) => phase.code)).toEqual([
      'native-creation-roles-unavailable',
      'native-request-roles-unavailable',
    ]);
    // Repeated startup cannot turn an absent source into a native proof.
    await installNativeRoleCoverage(pool);
    expect(await nativeRoleCoverageComplete(pool)).toBe(false);
  } finally {
    await pool.end();
    fixture.close();
  }
}, 30000);
