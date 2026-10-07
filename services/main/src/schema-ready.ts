import { Pool } from 'pg';
import {
  migrationRecords,
  repositoryRoot,
  type SchemaOwner,
} from '../../../scripts/ops/migrate.ts';

/** Check only that this release's migrations have completed. Older and newer
 * tracker entries are allowed; recorded SQL may be edited in place. */
export async function assertSchemaReady(
  pool: Pick<Pool, 'query'>,
  owner: SchemaOwner,
  root = repositoryRoot,
): Promise<void> {
  const expected = migrationRecords(root, owner);
  if (owner === 'content') {
    const result = await pool.query<{ version: number }>(
      'SELECT version FROM content.schema_migration',
    );
    const recorded = new Set(result.rows.map((row) => row.version));
    if (expected.some((file) => !recorded.has(file.version)))
      throw new Error(`${owner} migrations are incomplete`);
  } else {
    const result = await pool.query<{ name: string }>(
      'SELECT name FROM public.rezics_local_migration',
    );
    const recorded = new Set(result.rows.map((row) => row.name));
    if (expected.some((file) => !recorded.has(file.name)))
      throw new Error(`${owner} migrations are incomplete`);
  }
}

const pools = new Map<string, Pool>();
function storage(url: string) {
  let pool = pools.get(url);
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      max: 1,
      connectionTimeoutMillis: 1_500,
      statement_timeout: 1_500,
    });
    // pg-pool emits an idle client's disconnect here. Without a listener, that
    // disconnect is an unhandled exception.
    pool.on('error', (error: Error) => {
      console.error('Schema readiness connection failed:', error.message);
    });
    pools.set(url, pool);
  }
  return pool;
}

/** Close readiness connections for these URLs. A caller that stops the server
 * it probed must do this first, while the server can still close the session. */
export async function endMainSchemaReady(urls: readonly string[]): Promise<void> {
  await Promise.all(
    urls.map(async (url) => {
      const pool = pools.get(url);
      if (!pool) return;
      pools.delete(url);
      await pool.end();
    }),
  );
}

export async function mainSchemaReady(
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (env.NODE_ENV !== 'production') return;
  for (const [owner, name] of [
    ['access', 'ACCESS_DATABASE_URL'],
    ['content', 'CONTENT_DATABASE_URL'],
    ['relay', 'MAIN_RELAY_DATABASE_URL'],
  ] as const) {
    const url = env[name];
    if (!url) throw new Error(`Readiness requires ${name}`);
    const pool = storage(url);
    await assertSchemaReady(pool, owner);
    if (owner === 'access') {
      const provider = await pool.query(
        'SELECT EXISTS(SELECT 1 FROM commerce.payment_provider) AS present',
      );
      if (provider.rows[0]?.present !== false) throw new Error('Payment provider is not approved');
    }
  }
}
