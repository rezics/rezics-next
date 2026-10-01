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
  'rezics_oauth_code_basis', 'rezics_oauth_first_party_client', 'rezics_oauth_installation', 'rezics_signing_key',
  'session', 'user', 'verification',
  'passkey', 'twoFactor', 'rezics_account_email', 'rezics_account_rate_limit',
  'rezics_account_pending_consent', 'rezics_account_step_up', 'rezics_account_security_event',
  'rezics_account_security', 'rezics_account_grant', 'rezics_account_operator',
  'rezics_account_operator_bootstrap', 'rezics_account_operator_audit', 'rezics_account_operator_note',
  'rezics_account_operator_command', 'rezics_account_operator_preference', 'rezics_account_operator_job',
  'rezics_account_operator_job_item', 'rezics_display_preferences',
  'rezics_account_email_change',
  'rezics_policy_acceptance', 'rezics_mail_suppression', 'rezics_content_preferences',
] as const;
const UUID_ID_TABLES = new Set<string>([
  'rezics_account_recovery_activation', 'rezics_account_recovery_approval',
  'rezics_account_recovery_claim',
  'rezics_account_email', 'rezics_account_security_event', 'rezics_account_operator_audit',
  'rezics_account_operator_note', 'rezics_account_operator_job',
]);
const KEYS: Record<string, [string, string][]> = {
  rezics_account_rate_limit: [['key', 'text']],
  rezics_account_step_up: [['session_id', 'text']],
  rezics_account_security: [['user_id', 'text']],
  rezics_account_grant: [['user_id', 'text'], ['client_id', 'text']],
  rezics_account_operator: [['user_id', 'text']],
  rezics_account_operator_bootstrap: [['singleton', 'boolean']],
  rezics_account_operator_command: [['actor_id', 'text'], ['command_id', 'uuid']],
  rezics_account_operator_preference: [['user_id', 'text']],
  rezics_account_operator_job_item: [['job_id', 'uuid'], ['position', 'integer']],
  rezics_content_preferences: [['user_id', 'text']],
  rezics_display_preferences: [['user_id', 'text']],
  rezics_account_email_change: [['user_id', 'text']],
  rezics_oauth_first_party_client: [['client_id', 'text']],
  rezics_policy_acceptance: [['user_id', 'text'], ['policy_id', 'text'], ['version_digest', 'text']],
  rezics_mail_suppression: [['address', 'text'], ['purpose', 'text']],
};

/** Offline coverage of every private Account table at one UTC snapshot. */
export async function accountRecoveryCoverage(pool: Pool): Promise<AccountRecoveryCoverage> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const schema = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`);
    const actual = new Set(schema.rows.map(row => row.table_name));
    const expected = new Set<string>(TABLES);
    const missing = [...expected].filter(table => !actual.has(table)).sort();
    const unexpected = [...actual].filter(table => !expected.has(table)).sort();
    if (missing.length || unexpected.length) {
      throw new AccountRecoveryCoverageConflict(
        `Account table set differs from pinned recovery profile: missing ${JSON.stringify(missing)}; `
        + `unexpected ${JSON.stringify(unexpected)}`);
    }
    const digest = createHash('sha256');
    let count = 0n;
    for (const table of TABLES) {
      const keys = KEYS[table] ?? [['id', UUID_ID_TABLES.has(table) ? 'uuid' : 'text']];
      const columns = keys.map(([name]) => `"${name}"`).join(', ');
      let lastKey: unknown[] | null = null;
      while (true) {
        const page: QueryResult<{ id: string; body: string }> =
          await client.query<{ id: string; body: string }>(
            `SELECT jsonb_build_array(${columns})::text AS id, to_jsonb(t)::text AS body FROM public."${table}" AS t
             ${lastKey ? `WHERE ROW(${columns}) > ROW(${keys.map(([, type], index) => `$${index + 1}::${type}`).join(', ')})` : ''}
             ORDER BY ${columns} LIMIT 1000`, lastKey ?? []);
        for (const row of page.rows) {
          digest.update(JSON.stringify([table, row.id, row.body]));
          digest.update('\n');
          count++;
          lastKey = JSON.parse(row.id) as unknown[];
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
