import { Client, type ClientConfig } from 'pg';
import { readProductionEnv } from './production-env.ts';

const ownerUrls = {
  account: 'ACCOUNT_DATABASE_URL',
  access: 'ACCESS_DATABASE_URL',
  content: 'CONTENT_DATABASE_URL',
  relay: 'MAIN_RELAY_DATABASE_URL',
} as const;
type PostgresOwner = keyof typeof ownerUrls;

export const POSTGRES_PREFLIGHT_COST = {
  connectionMs: 5_000,
  statementMs: 5_000,
  queryMs: 6_000,
  lockMs: 1_000,
} as const;

class PostgresPreflightError extends Error {}

function refused(owner: PostgresOwner, reason: string): never {
  throw new PostgresPreflightError(`PostgreSQL preflight (${owner}): ${reason}`);
}

export function postgresPreflightConfig(url: string): ClientConfig {
  const parsed = new URL(url);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol))
    throw new Error('Expected a PostgreSQL URL');
  // pg parses URL parameters after constructor options. Remove overrides so
  // neither an operator URL nor PGOPTIONS can disable the read-only bounds.
  for (const name of [
    'options',
    'statement_timeout',
    'lock_timeout',
    'query_timeout',
    'connectionTimeoutMillis',
    'idle_in_transaction_session_timeout',
    'application_name',
    'replication',
  ])
    parsed.searchParams.delete(name);
  return {
    connectionString: parsed.toString(),
    application_name: 'rezics-postgres-preflight',
    connectionTimeoutMillis: POSTGRES_PREFLIGHT_COST.connectionMs,
    statement_timeout: POSTGRES_PREFLIGHT_COST.statementMs,
    query_timeout: POSTGRES_PREFLIGHT_COST.queryMs,
    lock_timeout: POSTGRES_PREFLIGHT_COST.lockMs,
    options: '-c default_transaction_read_only=on',
  };
}

export async function assertPostgresOwner(
  client: Pick<Client, 'query'>,
  owner: PostgresOwner,
): Promise<void> {
  const result = await client.query<{
    role: string;
    superuser: boolean;
    prepared: string;
    diagnostics: boolean;
  }>(`SELECT current_user AS role, rolsuper AS superuser,
    current_setting('max_prepared_transactions') AS prepared,
    pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') AS diagnostics
    FROM pg_catalog.pg_roles WHERE rolname = current_user`);
  const row = result.rows[0];
  if (result.rows.length !== 1 || !row || row.role !== owner)
    refused(owner, 'connect using the matching owner role');
  if (row.superuser !== false) refused(owner, 'owner role must not be superuser');
  if (row.prepared !== '0')
    refused(owner, 'requires active max_prepared_transactions=0; configure and restart PostgreSQL');
  if ((owner === 'access' || owner === 'content') && row.diagnostics !== true)
    refused(owner, 'requires inherited pg_read_all_stats');
}

export async function checkPostgresOwners(env: Record<string, string | undefined>): Promise<void> {
  // Validate the entire inventory before opening any connection.
  for (const [owner, name] of Object.entries(ownerUrls))
    if (!env[name]) refused(owner as PostgresOwner, `requires ${name}`);
  for (const [owner, name] of Object.entries(ownerUrls)) {
    let client: Client | undefined;
    try {
      client = new Client(postgresPreflightConfig(env[name]!));
      // A disconnect between query completion and close must not emit a raw,
      // unhandled driver error containing connection details.
      client.on('error', () => {});
      await client.connect();
      await assertPostgresOwner(client, owner as PostgresOwner);
    } catch (error) {
      if (error instanceof PostgresPreflightError) throw error;
      refused(owner as PostgresOwner, 'connection or diagnostic query failed');
    } finally {
      await client?.end().catch(() => {});
    }
  }
}

if (import.meta.main) {
  try {
    const path = process.argv[2];
    if (!path || process.argv.length !== 3)
      throw new PostgresPreflightError('PostgreSQL preflight requires one environment file');
    await checkPostgresOwners(readProductionEnv(path));
    console.log('PostgreSQL owner diagnostics verified; prepared transactions disabled');
  } catch (error) {
    console.error(
      error instanceof PostgresPreflightError
        ? error.message
        : 'PostgreSQL preflight could not read its environment file',
    );
    process.exitCode = 1;
  }
}
