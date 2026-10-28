import { expect, test } from 'bun:test';
import type { Pool, PoolClient, QueryConfig } from 'pg';
import { bootstrapGovernance, BootstrapGovernanceUnavailableError } from '../../src/access/bootstrap-governance.ts';
import { createImportIdentityDriver } from '../imports/identity-driver.ts';

// Forward every operation to the native pool/client except one selected read.
// This seam is local to this invocation; no module or shared pool is mocked.
function failRead(base: Pool, fragment: string, cause: Error, hit: () => void): Pool {
  const seam = Object.create(base) as Pool;
  const query = (client: Pool | PoolClient) =>
    ((input: QueryConfig | string, values?: unknown[]) => {
      if ((typeof input === 'string' ? input : input.text).includes(fragment)) {
        hit();
        throw cause;
      }
      return typeof input === 'string' ? client.query(input, values) : client.query(input);
    }) as Pool['query'];
  seam.query = query(base);
  seam.connect = (async () => {
    const client = await base.connect();
    const intercepted = Object.create(client) as PoolClient;
    intercepted.query = query(client) as PoolClient['query'];
    intercepted.release = client.release.bind(client);
    return intercepted;
  }) as Pool['connect'];
  return seam;
}

async function snapshot(pool: Pool) {
  const state: Record<string, unknown[]> = {};
  for (const table of [
    'access.governance_bootstrap',
    'access.resource_role_grant',
    'access.standing_parent_installation',
    'access.resource_grant',
    'core.outbox',
    'core.receipt',
    'core.partition',
    'editorial.write_basis',
  ]) {
    state[table] = (await pool.query(`SELECT * FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return state;
}

async function unavailable(result: Promise<unknown>) {
  let caught: unknown;
  try {
    await result;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(BootstrapGovernanceUnavailableError);
  const error = caught as BootstrapGovernanceUnavailableError;
  expect(error.name).toBe('BootstrapGovernanceUnavailableError');
  expect(error.message).toBe('Operator governance bootstrap is unavailable');
  return error;
}

test('native bootstrap failures survive both unavailable wrappers without changing denial or committed effects', async () => {
  const driver = createImportIdentityDriver();
  try {
    // Real registration, Auth credentials and operator CLI install the starting
    // authority. Neither the seam nor SQL setup synthesizes authorized effects.
    const f = await driver.open({ clock: () => new Date() });
    const pool = f.database.pool;
    const before = await snapshot(pool);
    expect(before['access.governance_bootstrap']).toHaveLength(1);
    expect(before['access.standing_parent_installation']).toHaveLength(1);

    for (const fragment of ['AS eligible', 'AS "minimumAuthnEpoch"']) {
      // First fail native command preparation, then the standing-grant account
      // read after native same-account replay. Unclassified errors are not retried.
      const cause = Object.assign(new Error(`native-bootstrap-sentinel: ${fragment}`), { code: 'XX000' });
      let calls = 0;
      const seam = failRead(pool, fragment, cause, () => calls++);
      const error = await unavailable(bootstrapGovernance(seam, f.governance.accountId));
      expect(error.cause).toBe(cause);
      expect(calls).toBe(1);
      expect(await snapshot(pool)).toEqual(before);
    }

    for (const accountId of ['malformed', f.bulk.accountId, f.ordinary.accountId]) {
      const denial = await unavailable(bootstrapGovernance(pool, accountId));
      expect(denial.cause).toBeUndefined();
      expect(await snapshot(pool)).toEqual(before);
    }
    expect(await bootstrapGovernance(pool, f.governance.accountId)).toMatchObject({ replayed: true });
    expect(await snapshot(pool)).toEqual(before);
  } finally {
    await driver.close();
  }
}, 120_000);
