import type { Pool, PoolClient } from 'pg';

type QueryInput = string | { text?: string };

function isPoolClient(client: unknown): client is PoolClient {
  return (
    typeof client === 'object' &&
    client !== null &&
    'query' in client &&
    typeof client.query === 'function' &&
    'release' in client &&
    typeof client.release === 'function'
  );
}

/** Runs a native transition after the first current bounded public-identity read in an Inbox request. */
export async function afterInboxActorProfile<T>(
  pool: Pool,
  transition: () => Promise<void>,
  read: () => Promise<T>,
): Promise<T> {
  const originalDescriptor = Object.getOwnPropertyDescriptor(pool, 'connect');
  const originalConnect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  let transitioned = false;

  Object.defineProperty(pool, 'connect', {
    configurable: true,
    writable: true,
    value: (...args: unknown[]) => {
      const connection = Reflect.apply(originalConnect, pool, args);
      if (args.length !== 0 || typeof connection !== 'object' || connection === null || !('then' in connection))
        return connection;
      return Promise.resolve(connection).then((client) => {
        if (!isPoolClient(client)) throw new TypeError('Expected a native Inbox query client');
        const nativeClient = client;
        return new Proxy(nativeClient, {
          get(target, property) {
            if (property === 'query') {
              return (...queryArgs: unknown[]) => {
                const input = queryArgs[0] as QueryInput;
                const text = typeof input === 'string' ? input : (input?.text ?? '');
                const actorProfile =
                  !transitioned &&
                  text.includes('WITH ORDINALITY') &&
                  text.includes('FROM access.account') &&
                  text.includes('operatorId');
                const result = Reflect.apply(target.query, target, queryArgs);
                if (!actorProfile || queryArgs.some((value) => typeof value === 'function')) return result;
                return Promise.resolve(result).then(async (value) => {
                  transitioned = true;
                  await transition();
                  return value;
                });
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      });
    },
  });

  try {
    const result = await read();
    if (!transitioned) throw new Error('Inbox actor identity read did not reach its interleaving point');
    return result;
  } finally {
    if (originalDescriptor) Object.defineProperty(pool, 'connect', originalDescriptor);
    else Reflect.deleteProperty(pool, 'connect');
  }
}
