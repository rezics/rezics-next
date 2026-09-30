import type { Pool } from 'pg';
import { readSchemaHead } from '../../main/src/schema-ready.ts';

export async function accountSchemaReady(
  pool: Pick<Pool, 'query'>,
  env: Record<string, string | undefined> = process.env,
) {
  // Embedded dev protocol fixtures do not carry a release seal. The deployed
  // HTTP process always supplies ACCOUNT_DATABASE_URL and must match the head.
  if (env.NODE_ENV !== 'production') return { storage: 'ready' as const, schemaHead: undefined };
  return { storage: 'ready' as const, schemaHead: await readSchemaHead(pool, 'account') };
}
