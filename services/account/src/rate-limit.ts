import { createHmac } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

/** One atomic primary-key upsert: concurrent requests cannot overspend a
 * fixed window. Keys never retain plaintext email, IP or session tokens. */
export async function consumeAccountLimit(pool: Pool | PoolClient, secret: string, key: string,
  maximum: number, seconds = 60): Promise<boolean> {
  const opaque = createHmac('sha256', secret).update(key).digest('hex');
  const result = await pool.query<{ count: number }>(`INSERT INTO rezics_account_rate_limit AS r (key)
    VALUES ($1) ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN r.started_at <= now() - $2 * interval '1 second' THEN 1 ELSE r.count + 1 END,
      started_at = CASE WHEN r.started_at <= now() - $2 * interval '1 second' THEN now() ELSE r.started_at END
    WHERE r.count < $3 OR r.started_at <= now() - $2 * interval '1 second'
    RETURNING count`, [opaque, seconds, maximum]);
  return result.rowCount === 1;
}
