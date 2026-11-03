import type { Pool } from 'pg';

/** Interleave a real owner mutation at one native SQL boundary, without replacing SQL or Access. */
export function interleaveClassificationRead(
  pool: Pool,
  table: string,
  mutate: () => Promise<void>,
  occurrence = 1,
): Pool {
  let remaining = occurrence;
  return new Proxy(pool, {
    get(target, property) {
      if (property === 'connect')
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(connection, key) {
              const value = Reflect.get(connection, key);
              if (key === 'query')
                return new Proxy(connection.query, {
                  async apply(query, _receiver, args) {
                    const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
                    if (typeof sql === 'string' && sql.includes(`FROM ${table}\n`) && --remaining === 0) {
                      await mutate();
                    }
                    return Reflect.apply(query, connection, args);
                  },
                });
              return typeof value === 'function' ? value.bind(connection) : value;
            },
          });
        };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
