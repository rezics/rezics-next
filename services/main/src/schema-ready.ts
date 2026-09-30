import { Pool } from 'pg';
import {
  expectedSchemaHead,
  repositoryRoot,
  type SchemaOwner,
} from '../../../scripts/ops/migrate.ts';

export async function readSchemaHead(
  pool: Pick<Pool, 'query'>,
  owner: SchemaOwner,
  root = repositoryRoot,
): Promise<string> {
  const expected = expectedSchemaHead(root, owner);
  const result = await pool.query<{ head: string }>(
    'SELECT head FROM public.rezics_release_schema WHERE owner = $1',
    [owner],
  );
  if (result.rows.length !== 1 || result.rows[0]!.head !== expected)
    throw new Error(`${owner} schema differs from release`);
  return expected;
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
    pools.set(url, pool);
  }
  return pool;
}

/** One indexed row per owner; connection and query deadlines bound storage probes. */
export async function mainSchemaReady(env: Record<string, string | undefined> = process.env) {
  const schemaHeads: Record<string, string> = {};
  for (const [owner, name] of [
    ['access', 'ACCESS_DATABASE_URL'],
    ['content', 'CONTENT_DATABASE_URL'],
    ['relay', 'MAIN_RELAY_DATABASE_URL'],
  ] as const) {
    const url = env[name];
    if (!url) {
      if (env.NODE_ENV === 'production') throw new Error(`Readiness requires ${name}`);
      continue;
    }
    const pool = storage(url);
    if (env.NODE_ENV !== 'production') {
      await pool.query('SELECT 1');
      continue;
    }
    schemaHeads[owner] = await readSchemaHead(pool, owner);
    if (owner === 'access' && env.NODE_ENV === 'production') {
      const provider = await pool.query(
        'SELECT EXISTS(SELECT 1 FROM commerce.payment_provider) AS present',
      );
      if (provider.rows[0]?.present !== false) throw new Error('Payment provider is not approved');
    }
  }
  return { storage: 'ready' as const, schemaHeads };
}
