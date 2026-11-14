import { expect, test } from 'bun:test';
import type { Pool, PoolClient, QueryArrayResult, QueryResult, QueryResultRow } from 'pg';
import {
  BoundedReadDeadlineError,
  NestedPoolCheckoutError,
  RetiredReadClientError,
  withBoundedReadConnection,
  withBoundedReadOnlyTransaction,
  withConnection,
  withQueryAccounting,
  type QueryAccounting,
} from '../src/database/pool.ts';
import type { NativeReadQueryArrayConfig, NativeReadQueryConfig } from '../src/database/bounded-read-lifetime.ts';
import { withContinueReadSnapshot } from '../src/library/continue-read-connection.ts';

type FakeQueryResult = QueryResult<Record<string, unknown>> | QueryArrayResult<unknown[]>;

function queryResult<Row extends QueryResultRow>(rows: Row[]): QueryResult<Row> {
  return { command: 'SELECT', rowCount: rows.length, oid: 0, fields: [], rows };
}

function queryArrayResult<Row extends unknown[]>(rows: Row[]): QueryArrayResult<Row> {
  return { command: 'SELECT', rowCount: rows.length, oid: 0, fields: [], rows };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fakeClient(
  query: (config: NativeReadQueryConfig) => Promise<FakeQueryResult> | FakeQueryResult,
  release: (error?: Error | boolean) => void = () => {},
): PoolClient {
  return {
    query(input: NativeReadQueryConfig | string, values?: unknown[]) {
      const config: NativeReadQueryConfig =
        typeof input === 'string' ? { text: input, ...(values === undefined ? {} : { values }) } : input;
      return Promise.resolve(query(config));
    },
    release,
  } as PoolClient;
}

function fakePool(connect: () => Promise<PoolClient>): Pool {
  return { connect } as Pool;
}

test('a late checkout is released without dispatching SQL', async () => {
  const checkout = deferred<PoolClient>();
  const released = deferred<Error | boolean | undefined>();
  const statements: string[] = [];
  const late = fakeClient(
    (config) => {
      statements.push(config.text ?? '');
      return queryResult([]);
    },
    (error) => released.resolve(error),
  );
  const visit = withBoundedReadOnlyTransaction(
    fakePool(() => checkout.promise),
    Date.now() + 40,
    async (client) => client.query('SELECT late'),
  );

  await expect(visit).rejects.toBeInstanceOf(BoundedReadDeadlineError);
  checkout.resolve(late);
  expect(await released.promise).toBeUndefined();
  expect(statements).toEqual([]);
});

test('uncertain transaction phases discard the client and the next read uses a healthy checkout', async () => {
  for (const blocked of ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SELECT slow', 'COMMIT']) {
    const never = new Promise<FakeQueryResult>(() => {});
    const statements: string[] = [];
    const released = deferred<Error | boolean | undefined>();
    let checkouts = 0;
    const database = fakePool(async () => {
      checkouts += 1;
      if (checkouts > 1) return fakeClient((config) => queryResult([{ healthy: config.text === 'SELECT healthy' }]));
      return fakeClient(
        (config) => {
          statements.push(config.text ?? '');
          return config.text === blocked ? never : queryResult([]);
        },
        (error) => released.resolve(error),
      );
    });

    const expired = withBoundedReadOnlyTransaction(database, Date.now() + 40, async (client) => {
      if (blocked === 'SELECT slow') await client.query(blocked);
      return 'old';
    });
    await expect(expired).rejects.toBeInstanceOf(BoundedReadDeadlineError);
    expect(await released.promise).toBeInstanceOf(Error);
    expect(statements).not.toContain('ROLLBACK');

    const healthy = await withBoundedReadOnlyTransaction(database, Date.now() + 500, (client) =>
      client.query<{ healthy: boolean }>('SELECT healthy'),
    );
    expect(healthy.rows).toEqual([{ healthy: true }]);
    expect(checkouts).toBe(2);
  }
});

test('a shorter native timeout preserves its cause and retires the checkout before the next read', async () => {
  const original = new Error('Query read timeout');
  const submitted: NativeReadQueryConfig[] = [];
  const releases: Array<Error | boolean | undefined> = [];
  let discarded = false;
  let checkouts = 0;
  const timedOut = fakeClient(
    (config) => {
      submitted.push(config);
      if (config.text !== 'SELECT slow') return queryResult([{ healthy: false }]);
      return new Promise<FakeQueryResult>((_resolve, reject) => {
        setTimeout(() => reject(original), config.query_timeout);
      });
    },
    (error) => {
      releases.push(error);
      discarded = error !== undefined;
    },
  );
  const healthy = fakeClient(() => queryResult([{ healthy: true }]));
  // A healthy release would put the same unresolved connection back into circulation.
  const database = fakePool(async () => {
    checkouts += 1;
    return discarded ? healthy : timedOut;
  });
  const request: NativeReadQueryConfig = { text: 'SELECT slow', query_timeout: 25 };
  let retained!: PoolClient;
  const visit = withBoundedReadConnection(database, Date.now() + 500, async (client) => {
    retained = client;
    return client.query(request);
  });

  expect(await visit.catch((error: unknown) => error)).toBe(original);
  expect(releases).toEqual([original]);
  expect(submitted[0]?.query_timeout).toBe(25);
  expect(submitted[0]).not.toBe(request);
  expect(request.query_timeout).toBe(25);
  await expect(retained.query('SELECT stale')).rejects.toBeInstanceOf(RetiredReadClientError);

  const next = await withBoundedReadConnection(database, Date.now() + 500, (client) => client.query('SELECT healthy'));
  expect(next.rows).toEqual([{ healthy: true }]);
  expect(checkouts).toBe(2);
  expect(submitted.map(({ text }) => text)).toEqual(['SELECT slow']);
});

test('native rejection and synchronous dispatch failure retire a checkout but ordinary callback failure does not', async () => {
  for (const failureAt of ['native rejection', 'synchronous dispatch', 'callback']) {
    const original = new Error('Connection terminated unexpectedly');
    const releases: Array<Error | boolean | undefined> = [];
    const database = fakePool(async () =>
      fakeClient(
        () => {
          if (failureAt === 'native rejection') return Promise.reject(original);
          if (failureAt === 'synchronous dispatch') throw original;
          return queryResult([]);
        },
        (error) => releases.push(error),
      ),
    );
    const visit = withBoundedReadConnection(database, Date.now() + 500, async (client) => {
      await client.query('SELECT current');
      throw original;
    });

    expect(await visit.catch((error: unknown) => error)).toBe(original);
    expect(releases).toEqual([failureAt === 'callback' ? undefined : original]);
  }
});

test('a caught native callback timeout keeps its first mapped cause through expiry and late work failure', async () => {
  const original = new Error('Query read timeout');
  const mapped = new Error('mapped native timeout', { cause: original });
  const request: NativeReadQueryConfig = { text: 'SELECT slow', query_timeout: 5 };
  const resume = deferred<void>();
  const callbackFinished = deferred<void>();
  const released = deferred<Error | boolean | undefined>();
  let caught: unknown;
  const database = fakePool(async () =>
    fakeClient(() => Promise.reject(original), (error) => released.resolve(error)),
  );
  const visit = withBoundedReadConnection(
    database,
    Date.now() + 40,
    async (client) => {
      try {
        await new Promise<void>((resolve) => {
          client.query(request, (error) => {
            caught = error;
            resolve();
          });
        });
        await resume.promise;
        throw new Error('late callback failure');
      } finally {
        callbackFinished.resolve();
      }
    },
    { mapError: (error) => (error === original ? mapped : new Error('later mapping', { cause: error })) },
  );

  const failure = await visit.catch((error: unknown) => error);
  resume.resolve();
  await callbackFinished.promise;
  expect(caught).toBe(mapped);
  expect(failure).toBe(mapped);
  expect(await released.promise).toBe(mapped);
});

test('settled PostgreSQL failures roll back safely and rollback failures preserve the first error', async () => {
  const readError = Object.assign(new Error('read failed'), { code: '23505', severity: 'ERROR' });
  const mappedReadError = new Error('mapped server failure', { cause: readError });
  const safeStatements: string[] = [];
  let safeReleaseError: Error | boolean | undefined;
  const safePool = fakePool(async () =>
    fakeClient(
      (config) => {
        safeStatements.push(config.text ?? '');
        return config.text === 'SELECT rejected' ? Promise.reject(readError) : queryResult([]);
      },
      (error) => {
        safeReleaseError = error;
      },
    ),
  );
  const safeFailure = await withBoundedReadOnlyTransaction(
    safePool,
    Date.now() + 500,
    async (client) => {
      await client.query('SELECT rejected');
    },
    {
      mapError: (error) => (error === readError ? mappedReadError : error),
      isUncertainError: () => true,
      isUncertainSettledQueryError: () => true,
      isUncertainWorkError: () => true,
    },
  ).catch((error: unknown) => error);
  expect(safeFailure).toBe(mappedReadError);
  expect(safeStatements).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SELECT rejected', 'ROLLBACK']);
  expect(safeReleaseError).toBeUndefined();

  const rollbackError = new Error('rollback outcome unknown');
  let failedReleaseError: Error | boolean | undefined;
  const failedPool = fakePool(async () =>
    fakeClient(
      (config) =>
        config.text === 'SELECT rejected'
          ? Promise.reject(readError)
          : config.text === 'ROLLBACK'
            ? Promise.reject(rollbackError)
            : queryResult([]),
      (error) => {
        failedReleaseError = error;
      },
    ),
  );
  const rollbackFailure = await withBoundedReadOnlyTransaction(failedPool, Date.now() + 500, async (client) => {
    await client.query('SELECT rejected');
  }).catch((error: unknown) => error);
  expect(rollbackFailure).toBe(readError);
  expect(failedReleaseError).toBe(rollbackError);
});

test('an expired callback cannot use its released client', async () => {
  const resume = deferred<void>();
  const callbackFinished = deferred<unknown>();
  const released = deferred<Error | boolean | undefined>();
  const statements: string[] = [];
  const database = fakePool(async () =>
    fakeClient(
      (config) => {
        statements.push(config.text ?? '');
        return queryResult([]);
      },
      (error) => released.resolve(error),
    ),
  );
  const visit = withBoundedReadConnection(database, Date.now() + 40, async (client) => {
    await resume.promise;
    const error = await client.query('SELECT stale').catch((failure: unknown) => failure);
    callbackFinished.resolve(error);
    return 'stale';
  });

  await expect(visit).rejects.toBeInstanceOf(BoundedReadDeadlineError);
  expect(await released.promise).toBeUndefined();
  resume.resolve();
  expect(await callbackFinished.promise).toBeInstanceOf(RetiredReadClientError);
  expect(statements).toEqual([]);
});

test('manual BEGIN and START TRANSACTION retain custody through non-query callback expiry', async () => {
  for (const begin of ['BEGIN', '-- read snapshot\nSTART /* outer /* nested */ comment */ TRANSACTION']) {
    const resume = deferred<void>();
    const callbackFinished = deferred<unknown>();
    const released = deferred<Error | boolean | undefined>();
    const statements: string[] = [];
    let checkouts = 0;
    const database = fakePool(async () => {
      checkouts += 1;
      if (checkouts > 1) return fakeClient(() => queryResult([{ healthy: true }]));
      return fakeClient(
        (config) => {
          statements.push(config.text ?? '');
          return queryResult([]);
        },
        (error) => released.resolve(error),
      );
    });
    const visit = withBoundedReadConnection(database, Date.now() + 40, async (client) => {
      await client.query(begin);
      await resume.promise;
      const late = await client.query('ROLLBACK').catch((error: unknown) => error);
      callbackFinished.resolve(late);
      return 'late';
    });

    const failure = await visit.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BoundedReadDeadlineError);
    expect(await released.promise).toBe(failure);
    expect(statements).toEqual([begin]);
    resume.resolve();
    expect(await callbackFinished.promise).toBeInstanceOf(RetiredReadClientError);
    expect(statements).toEqual([begin]);

    const next = await withBoundedReadConnection(database, Date.now() + 500, (client) => client.query('SELECT healthy'));
    expect(next.rows).toEqual([{ healthy: true }]);
    expect(checkouts).toBe(2);
  }
});

test('only full terminal commands release manual transaction custody', async () => {
  const cases = [
    { commands: ['BEGIN', 'SAVEPOINT checkpoint'], open: true },
    { commands: ['BEGIN', 'SAVEPOINT checkpoint', 'ROLLBACK TO SAVEPOINT checkpoint'], open: true },
    {
      commands: ['BEGIN', 'SAVEPOINT checkpoint', 'ROLLBACK WORK TO checkpoint', 'RELEASE SAVEPOINT checkpoint'],
      open: true,
    },
    { commands: ['START TRANSACTION', 'COMMIT'], open: false },
    { commands: ['BEGIN', 'ROLLBACK TRANSACTION'], open: false },
    { commands: ['BEGIN', 'COMMIT AND CHAIN'], open: true },
    { commands: ['BEGIN', 'ROLLBACK AND NO CHAIN'], open: false },
  ];
  for (const { commands, open } of cases) {
    const resume = deferred<void>();
    const callbackFinished = deferred<void>();
    const released = deferred<Error | boolean | undefined>();
    const statements: string[] = [];
    const database = fakePool(async () =>
      fakeClient(
        (config) => {
          statements.push(config.text ?? '');
          return queryResult([]);
        },
        (error) => released.resolve(error),
      ),
    );
    const visit = withBoundedReadConnection(database, Date.now() + 40, async (client) => {
      for (const command of commands) await client.query(command);
      await resume.promise;
      callbackFinished.resolve();
    });

    await expect(visit).rejects.toBeInstanceOf(BoundedReadDeadlineError);
    const releaseError = await released.promise;
    if (open) expect(releaseError).toBeInstanceOf(BoundedReadDeadlineError);
    else expect(releaseError).toBeUndefined();
    expect(statements).toEqual(commands);
    resume.resolve();
    await callbackFinished.promise;
  }
});

test('manual callback expiry preserves the configured public error mapping', async () => {
  const deadlineError = new BoundedReadDeadlineError();
  const mapped = new Error('mapped read deadline', { cause: deadlineError });
  const resume = deferred<void>();
  const released = deferred<Error | boolean | undefined>();
  const database = fakePool(async () => fakeClient(() => queryResult([]), (error) => released.resolve(error)));
  const visit = withBoundedReadConnection(
    database,
    Date.now() + 40,
    async (client) => {
      await client.query('BEGIN');
      await resume.promise;
    },
    { deadlineError: () => deadlineError, mapError: (error) => (error === deadlineError ? mapped : error) },
  );

  expect(await visit.catch((error: unknown) => error)).toBe(mapped);
  expect(await released.promise).toBeInstanceOf(Error);
  resume.resolve();
});

test('manual transaction queries retain config and callback overloads without automatic completion', async () => {
  const submitted: NativeReadQueryConfig[] = [];
  const releases: Array<Error | boolean | undefined> = [];
  const database = fakePool(async () =>
    fakeClient(
      (config) => {
        submitted.push(config);
        return queryResult([]);
      },
      (error) => releases.push(error),
    ),
  );
  const request: NativeReadQueryConfig = { text: 'START TRANSACTION', values: [], query_timeout: 25 };
  const result = await withBoundedReadConnection(database, Date.now() + 500, async (client) => {
    await new Promise<void>((resolve, reject) => {
      client.query(request, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      client.query('COMMIT', [], (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    return 'completed';
  });

  expect(result).toBe('completed');
  expect(submitted.map(({ text }) => text)).toEqual(['START TRANSACTION', 'COMMIT']);
  expect(submitted[0]?.values).toBe(request.values);
  expect(submitted[0]?.query_timeout).toBe(25);
  expect(submitted[0]).not.toBe(request);
  expect(request.query_timeout).toBe(25);
  expect(releases).toEqual([undefined]);
});

test('returning with manual work open rolls back and rejects without silently committing', async () => {
  const statements: string[] = [];
  const releases: Array<Error | boolean | undefined> = [];
  const database = fakePool(async () =>
    fakeClient(
      (config) => {
        statements.push(config.text ?? '');
        return queryResult([]);
      },
      (error) => releases.push(error),
    ),
  );

  await expect(
    withBoundedReadConnection(database, Date.now() + 500, async (client) => {
      await client.query('BEGIN');
      return 'unfinished';
    }),
  ).rejects.toThrow('manual transaction still open');
  expect(statements).toEqual(['BEGIN', 'ROLLBACK']);
  expect(releases).toEqual([undefined]);
});

test('settled PostgreSQL transaction errors remain recoverable before the deadline', async () => {
  for (const rejected of ['BEGIN', 'COMMIT', 'ROLLBACK', 'ROLLBACK TO SAVEPOINT missing']) {
    const serverError = Object.assign(new Error('transaction command rejected'), { code: '42601', severity: 'ERROR' });
    const statements: string[] = [];
    const releases: Array<Error | boolean | undefined> = [];
    let rejectNext = true;
    const database = fakePool(async () =>
      fakeClient(
        (config) => {
          statements.push(config.text ?? '');
          if (config.text === rejected && rejectNext) {
            rejectNext = false;
            return Promise.reject(serverError);
          }
          return queryResult([]);
        },
        (error) => releases.push(error),
      ),
    );

    const result = await withBoundedReadConnection(database, Date.now() + 500, async (client) => {
      if (rejected !== 'BEGIN') await client.query('BEGIN');
      const failure = await client.query(rejected).catch((error: unknown) => error);
      expect(failure).toBe(serverError);
      if (rejected !== 'BEGIN') await client.query('ROLLBACK');
      return 'recovered';
    });
    expect(result).toBe('recovered');
    expect(statements).toEqual(rejected === 'BEGIN' ? ['BEGIN'] : ['BEGIN', rejected, 'ROLLBACK']);
    expect(releases).toEqual([undefined]);
  }
});

test('failed manual terminal commands retain unresolved custody until expiry', async () => {
  for (const terminal of ['COMMIT', 'ROLLBACK']) {
    const serverError = Object.assign(new Error('terminal command rejected'), { code: '40001', severity: 'ERROR' });
    const resume = deferred<void>();
    const released = deferred<Error | boolean | undefined>();
    const statements: string[] = [];
    const database = fakePool(async () =>
      fakeClient(
        (config) => {
          statements.push(config.text ?? '');
          return config.text === terminal ? Promise.reject(serverError) : queryResult([]);
        },
        (error) => released.resolve(error),
      ),
    );
    const visit = withBoundedReadConnection(database, Date.now() + 40, async (client) => {
      await client.query('BEGIN');
      const failure = await client.query(terminal).catch((error: unknown) => error);
      expect(failure).toBe(serverError);
      await resume.promise;
    });

    await expect(visit).rejects.toBeInstanceOf(BoundedReadDeadlineError);
    expect(await released.promise).toBeInstanceOf(BoundedReadDeadlineError);
    expect(statements).toEqual(['BEGIN', terminal]);
    resume.resolve();
  }
});

test('late native transaction responses cannot rehabilitate a discarded checkout or replace its first cause', async () => {
  const cases = [
    { pending: 'BEGIN', failed: false },
    { pending: 'COMMIT', failed: false },
    { pending: 'ROLLBACK', failed: false },
    { pending: 'COMMIT', failed: true },
    { pending: 'ROLLBACK', failed: true },
  ];
  for (const { pending, failed } of cases) {
    const native = deferred<FakeQueryResult>();
    const released = deferred<Error | boolean | undefined>();
    const releases: Array<Error | boolean | undefined> = [];
    const statements: string[] = [];
    let client!: PoolClient;
    const database = fakePool(async () =>
      fakeClient(
        (config) => {
          statements.push(config.text ?? '');
          return config.text === pending ? native.promise : queryResult([]);
        },
        (error) => {
          releases.push(error);
          released.resolve(error);
        },
      ),
    );
    const visit = withBoundedReadConnection(database, Date.now() + 40, async (current) => {
      client = current;
      await client.query('BEGIN');
      if (pending !== 'BEGIN') await client.query(pending);
    });

    const failure = await visit.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BoundedReadDeadlineError);
    expect(await released.promise).toBe(failure);
    if (failed) native.reject(Object.assign(new Error('late server error'), { code: '40001', severity: 'ERROR' }));
    else native.resolve(queryResult([]));
    await native.promise.catch(() => {});
    await expect(client.query('SELECT stale')).rejects.toBeInstanceOf(RetiredReadClientError);
    expect(releases).toEqual([failure]);
    expect(statements).toEqual(pending === 'BEGIN' ? ['BEGIN'] : ['BEGIN', pending]);
  }
});

test('manual rollback cannot extend the deadline or replace the original work failure', async () => {
  const original = new Error('callback failed');
  const rollback = deferred<FakeQueryResult>();
  const released = deferred<Error | boolean | undefined>();
  const statements: string[] = [];
  const database = fakePool(async () =>
    fakeClient(
      (config) => {
        statements.push(config.text ?? '');
        return config.text === 'ROLLBACK' ? rollback.promise : queryResult([]);
      },
      (error) => released.resolve(error),
    ),
  );
  const visit = withBoundedReadConnection(database, Date.now() + 40, async (client) => {
    await client.query('BEGIN');
    throw original;
  });

  expect(await visit.catch((error: unknown) => error)).toBe(original);
  expect(await released.promise).toBeInstanceOf(Error);
  expect(statements).toEqual(['BEGIN', 'ROLLBACK']);
  rollback.resolve(queryResult([]));
});

test('a caught uncertain terminal failure remains the first cause when callback work expires', async () => {
  const original = new Error('commit connection lost');
  const resume = deferred<void>();
  const released = deferred<Error | boolean | undefined>();
  const database = fakePool(async () =>
    fakeClient(
      (config) => (config.text === 'COMMIT' ? Promise.reject(original) : queryResult([])),
      (error) => released.resolve(error),
    ),
  );
  const visit = withBoundedReadConnection(database, Date.now() + 40, async (client) => {
    await client.query('BEGIN');
    expect(await client.query('COMMIT').catch((error: unknown) => error)).toBe(original);
    await resume.promise;
  });

  expect(await visit.catch((error: unknown) => error)).toBe(original);
  expect(await released.promise).toBe(original);
  resume.resolve();
});

test('nested checkout is refused before another physical connection is requested', async () => {
  let checkouts = 0;
  const database = fakePool(async () => {
    checkouts += 1;
    return fakeClient(() => queryResult([]));
  });

  await expect(
    withBoundedReadConnection(database, Date.now() + 500, async () => withConnection(database, async () => 'nested')),
  ).rejects.toBeInstanceOf(NestedPoolCheckoutError);
  expect(checkouts).toBe(1);
});

test('an adopted Continue reader preserves native options and accounts one checkout and each query once', async () => {
  const submitted: NativeReadQueryConfig[] = [];
  const accounted: string[] = [];
  let connections = 0;
  const database = fakePool(async () =>
    fakeClient((config) => {
      submitted.push(config);
      if (config.text === 'SELECT current') {
        const current: [string] = ['ready'];
        return queryArrayResult([current]);
      }
      return queryResult([]);
    }),
  );
  const accounting: QueryAccounting = {
    query<T>(sql: string, _operands: readonly unknown[], dispatch: () => Promise<T>): Promise<T> {
      accounted.push(sql);
      return dispatch();
    },
    connection<T>(dispatch: () => Promise<T>): Promise<T> {
      connections += 1;
      return dispatch();
    },
  };
  const types = { getTypeParser: () => (value: string) => value };
  const request: NativeReadQueryArrayConfig = {
    text: 'SELECT current',
    values: ['route'],
    rowMode: 'array',
    types,
    query_timeout: 25,
  };

  const rows = await withQueryAccounting(accounting, () =>
    withContinueReadSnapshot(database, Date.now() + 500, async (client) => {
      const result = await new Promise<QueryArrayResult<[string]>>((resolve, reject) => {
        client.query<[string]>(request, (error, received) => {
          if (error) reject(error);
          else resolve(received);
        });
      });
      return result.rows;
    }),
  );

  expect(rows).toEqual([['ready']]);
  expect(submitted.map(({ text }) => text)).toEqual([
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    'SELECT current',
    'COMMIT',
  ]);
  expect(submitted[1]?.rowMode).toBe('array');
  expect(submitted[1]?.types).toBe(types);
  expect(submitted[1]?.values).toBe(request.values);
  expect(submitted[1]?.query_timeout).toBe(25);
  expect(submitted[1]).not.toBe(request);
  expect(request.query_timeout).toBe(25);
  expect(accounted).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SELECT current', 'COMMIT']);
  expect(connections).toBe(1);
});
