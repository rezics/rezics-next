import type { Pool } from 'pg';
import { assertSchemaReady } from '../../main/src/schema-ready.ts';

export async function accountSchemaReady(
  pool: Pick<Pool, 'query'>,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (env.NODE_ENV === 'production') await assertSchemaReady(pool, 'account');
}
