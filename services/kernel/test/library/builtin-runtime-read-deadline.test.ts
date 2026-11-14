import { expect, test } from 'bun:test';
import type { Pool, PoolClient, QueryConfig } from 'pg';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { createNativeBuiltinRuntime } from '../../src/library/adapters/builtin-runtime.ts';
import type { NativeLibraryPresentationPorts } from '../../src/library/adapters/presentation.ts';
import { builtinCollectionId } from '../../src/library/builtin-identity.ts';
import { ProblemError } from '../../src/http/problem-error.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { routeOf } from '../../src/route/route.ts';

const accountId = '019a1b2c-3d4e-7f00-8a00-6a0010000001';
const actor: AccountActor = {
  kind: 'account',
  accountId,
  clientId: 'test-client',
  scopes: ['collection:read'],
  requestedBy: null,
  authnEpoch: 1,
};
const everything = builtinCollectionId(accountId, { kind: 'everything' });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function client(
  query: (text: string) => Promise<{ rows: unknown[] }> | { rows: unknown[] } = () => ({ rows: [] }),
  release: (error?: Error | boolean) => void = () => {},
): PoolClient {
  return {
    query(input: QueryConfig | string) {
      return query(typeof input === 'string' ? input : (input.text ?? ''));
    },
    release,
  } as unknown as PoolClient;
}

function healthyQuery(sql: string) {
  return sql.includes('EXISTS(SELECT 1 FROM library.entry')
    ? { rows: [{ entry: false, session: false, copy: false, label: false }] }
    : { rows: [] };
}

function builtinRuntime(pool: Pool, readAccount = async (_client: unknown, route: number, id: string) => ({
  route,
  accountId: id,
  kind: 'actor',
  state: 'active',
  fenced: false,
  minimumAuthnEpoch: 1n,
})) {
  const ports = {
    accountEligibility: { routeOf, readAccount },
  } as unknown as NativeLibraryPresentationPorts;
  return createNativeBuiltinRuntime(ports, { pool });
}

test('late checkout and a stuck BEGIN expire, retire uncertain visits, and leave directory reads usable', async () => {
  for (const phase of ['checkout', 'begin'] as const) {
    const lateCheckout = deferred<PoolClient>();
    const released = deferred<Error | boolean | undefined>();
    let checkouts = 0;
    const pool = {
      connect: async () => {
        checkouts += 1;
        if (phase === 'checkout' && checkouts === 1) return lateCheckout.promise;
        return client(
          (sql) =>
            phase === 'begin' && checkouts === 1 && sql.startsWith('BEGIN')
              ? new Promise<{ rows: unknown[] }>(() => {})
              : healthyQuery(sql),
          (error) => released.resolve(error),
        );
      },
    } as unknown as Pool;
    const runtime = builtinRuntime(pool);

    await expect(runtime.read(actor, everything, 'collection:read', Date.now() + 100)).rejects.toBeInstanceOf(
      AccessUnavailableError,
    );
    if (phase === 'checkout') lateCheckout.resolve(client(healthyQuery, (error) => released.resolve(error)));
    const retirement = await released.promise;
    if (phase === 'checkout') expect(retirement).toBeUndefined();
    else expect(retirement).toBeInstanceOf(Error);
    const directory = await runtime.discover(actor);
    expect(directory.map(({ builtinKind }) => builtinKind).sort()).toEqual(['everything', 'liked']);
    const everythingView = directory.find(({ builtinKind }) => builtinKind === 'everything');
    expect(everythingView).toBeDefined();
    expect(await runtime.sourceVersion(actor, everythingView!, Date.now() + 500, true)).toBe('absent');
  }
});

test('an expired member-source rollback retires its client and preserves the next authorized visit', async () => {
  const released = deferred<Error | boolean | undefined>();
  let accountReads = 0;
  let checkouts = 0;
  const pool = {
    connect: async () => {
      checkouts += 1;
      return client(
        (sql) =>
          checkouts === 2 && sql === 'ROLLBACK'
            ? new Promise<{ rows: unknown[] }>(() => {})
            : healthyQuery(sql),
        checkouts === 2 ? (error) => released.resolve(error) : () => {},
      );
    },
  } as unknown as Pool;
  const runtime = builtinRuntime(pool, async (_client, route, id) => {
    accountReads += 1;
    if (accountReads === 2) throw new ProblemError('dependency_unavailable');
    return { route, accountId: id, kind: 'actor', state: 'active', fenced: false, minimumAuthnEpoch: 1n };
  });

  const expiredMembers = runtime.members(actor, everything, { deadline: Date.now() + 100 });
  await expect(expiredMembers).rejects.toBeInstanceOf(ProblemError);
  expect(await released.promise).toBeInstanceOf(Error);
  await expect(runtime.members(actor, everything, { deadline: Date.now() + 500 })).resolves.toEqual({
    members: [],
    next: null,
  });
  expect(checkouts).toBe(4);
});
