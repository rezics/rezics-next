import type { Pool, PoolClient } from 'pg';

export function failConnect(pool: Pool, times: number | 'always') {
  const original = pool.connect.bind(pool);
  let remaining = times === 'always' ? Number.POSITIVE_INFINITY : times;
  pool.connect = (async () => {
    if (remaining > 0) {
      remaining -= 1;
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    }
    return original();
  }) as Pool['connect'];
  return () => {
    pool.connect = original;
  };
}

export function loseCommitOnce(pool: Pool) {
  const original = pool.connect.bind(pool);
  let lost = false;
  pool.connect = (async () => {
    const client = await original();
    const query = client.query.bind(client) as PoolClient['query'];
    client.query = ((sql: string | { text?: string }, ...rest: unknown[]) => {
      const text = typeof sql === 'string' ? sql : sql?.text;
      const result = (query as (...args: unknown[]) => Promise<unknown>)(sql, ...rest);
      if (!lost && text === 'COMMIT') {
        lost = true;
        return result.then(() => {
          throw Object.assign(new Error('Connection lost after COMMIT'), { code: 'ECONNRESET' });
        });
      }
      return result;
    }) as PoolClient['query'];
    return client;
  }) as Pool['connect'];
  return () => {
    pool.connect = original;
  };
}
