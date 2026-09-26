import { createHash } from 'node:crypto';
import type { Pool, QueryResult } from 'pg';

export class AccountRecoveryCoverageConflict extends Error {}

export interface AccountRecoveryCoverage {
  rowCount: string;
  rowDigest: string;
}

// Better Auth 1.7.5, its pinned OAuth provider, the private code-basis fence,
// App installations, signing-key generations and independent credential
// recovery evidence. A schema change must be reviewed before coverage is accepted.
const TABLES = [
  'account', 'jwks', 'oauthAccessToken', 'oauthClient', 'oauthClientAssertion',
  'oauthClientResource', 'oauthConsent', 'oauthRefreshToken', 'oauthResource',
  'rezics_account_recovery_activation', 'rezics_account_recovery_approval',
  'rezics_account_recovery_claim', 'rezics_account_recovery_policy',
  'rezics_oauth_code_basis', 'rezics_oauth_installation', 'rezics_signing_key',
  'session', 'user', 'verification',
] as const;
const UUID_ID_TABLES = new Set<string>([
  'rezics_account_recovery_activation', 'rezics_account_recovery_approval',
  'rezics_account_recovery_claim',
]);

/** Offline coverage of every private Account table at one UTC snapshot. */
export async function accountRecoveryCoverage(pool: Pool): Promise<AccountRecoveryCoverage> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const schema = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`);
    if (JSON.stringify(schema.rows.map(row => row.table_name)) !==
      JSON.stringify([...TABLES].sort())) {
      throw new AccountRecoveryCoverageConflict('Account table set differs from pinned recovery profile');
    }
    const digest = createHash('sha256');
    let count = 0n;
    for (const table of TABLES) {
      const uuidId = UUID_ID_TABLES.has(table);
      let lastId = uuidId ? '00000000-0000-0000-0000-000000000000' : '';
      while (true) {
        const page: QueryResult<{ id: string; body: string }> =
          await client.query<{ id: string; body: string }>(
            `SELECT id::text AS id, to_jsonb(t)::text AS body FROM public."${table}" AS t
             WHERE id > $1${uuidId ? '::uuid' : ''} ORDER BY id LIMIT 1000`, [lastId]);
        for (const row of page.rows) {
          digest.update(JSON.stringify([table, row.id, row.body]));
          digest.update('\n');
          count++;
          lastId = row.id;
        }
        if (page.rows.length < 1000) break;
      }
    }
    await client.query('COMMIT');
    return { rowCount: count.toString(), rowDigest: digest.digest('hex') };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    client.release();
  }
}

export async function assertAccountRecoveryCoverage(
  pool: Pool, expected: AccountRecoveryCoverage,
): Promise<void> {
  if (!/^[0-9]+$/.test(expected?.rowCount ?? '')
    || !/^[0-9a-f]{64}$/.test(expected?.rowDigest ?? '')) {
    throw new AccountRecoveryCoverageConflict('invalid Account recovery coverage');
  }
  const actual = await accountRecoveryCoverage(pool);
  if (actual.rowCount !== expected.rowCount || actual.rowDigest !== expected.rowDigest) {
    throw new AccountRecoveryCoverageConflict('Account rows differ from retained recovery coverage');
  }
}
