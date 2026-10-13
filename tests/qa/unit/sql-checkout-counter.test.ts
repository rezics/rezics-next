import { expect, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import pg, { type PoolClient } from 'pg';
import { runBackgroundOperation } from '../integration/support/operation-cost.ts';
import { attributeSqlCheckoutCallers, foregroundCounted } from '../integration/support/query-cost-meter.ts';
import { startPostgresCluster } from '../support/postgres-cluster.ts';

type Caller = { name: string; background: boolean; statements: number; foregroundStatements: number };
const callers = new AsyncLocalStorage<Caller>();

function caller(name: string, background = false): Caller {
  return { name, background, statements: 0, foregroundStatements: 0 };
}

function asCaller<T>(context: Caller, operation: () => T): T {
  return callers.run(context, () => context.background ? runBackgroundOperation(operation) : operation());
}

function countStatements(): { unattributed: string[]; restore(): void } {
  const prototype = pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
  const originalQuery = prototype.query;
  const unattributed: string[] = [];
  prototype.query = function (this: unknown, ...args: unknown[]) {
    const context = callers.getStore();
    if (context) {
      context.statements++;
      if (foregroundCounted()) context.foregroundStatements++;
    } else unattributed.push(String(args[0]));
    return originalQuery.apply(this, args);
  };
  return { unattributed, restore: () => { prototype.query = originalQuery; } };
}

function callbackCheckout<T>(pool: pg.Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const result = pool.connect((error, client, release) => {
      if (error) { reject(error); return; }
      // Exercise both callback arguments and release identity, including failure cleanup.
      if (!client || release !== client.release) {
        release?.();
        reject(new Error('checkout did not forward its client and release'));
        return;
      }
      void operation(client).then(resolve, reject);
    });
    expect(result).toBeUndefined();
  });
}

async function statements(client: PoolClient, context: Caller, count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    const result = await client.query<{ caller: string }>('SELECT $1::text AS caller', [context.name]);
    expect(result.rows).toEqual([{ caller: context.name }]);
  }
}

test('concurrent callback, promise and pool-query callers receive exactly their own SQL statements', async () => {
  const cluster = await startPostgresCluster();
  const pool = new pg.Pool({ ...cluster.connection, max: 1, idleTimeoutMillis: 0 });
  const originalConnect = pg.Pool.prototype.connect;
  const originalQuery = pg.Client.prototype.query;
  const restoreCheckoutCallers = attributeSqlCheckoutCallers();
  const counter = countStatements();
  const holder = caller('background holder', true);
  const callback = caller('foreground callback');
  const promise = caller('foreground promise');
  const background = caller('background callback', true);
  const query = caller('foreground pool query');
  let held: PoolClient | undefined;
  let released = false;
  const pending: Promise<unknown>[] = [];
  const reused: PoolClient[] = [];
  try {
    held = await asCaller(holder, () => pool.connect());
    const use = async (client: PoolClient, context: Caller, count: number) => {
      reused.push(client);
      try { await statements(client, context, count); }
      finally { client.release(); }
    };
    pending.push(asCaller(callback, () => callbackCheckout(pool, client => use(client, callback, 3))));
    pending.push(asCaller(promise, async () => use(await pool.connect(), promise, 5)));
    pending.push(asCaller(background, () => callbackCheckout(pool, client => use(client, background, 7))));
    pending.push(asCaller(query, () => pool.query<{ caller: string }>('SELECT $1::text AS caller', [query.name])));
    // The holder keeps every caller queued; no timer decides who hands off the client.
    expect(pool.waitingCount).toBe(4);
    await asCaller(holder, () => statements(held!, holder, 2));
    asCaller(holder, () => { held!.release(); released = true; });
    const outcomes = await Promise.allSettled(pending);
    expect(outcomes.every(outcome => outcome.status === 'fulfilled')).toBe(true);
    expect(outcomes[3]).toMatchObject({ status: 'fulfilled', value: { rows: [{ caller: query.name }] } });
    expect(reused).toEqual([held, held, held]);
    expect(pool.totalCount).toBe(1);
    expect(pool.idleCount).toBe(1);
    expect(pool.waitingCount).toBe(0);
    expect([holder, callback, promise, background, query].map(context => ({
      name: context.name, statements: context.statements, foregroundStatements: context.foregroundStatements,
    }))).toEqual([
      { name: holder.name, statements: 2, foregroundStatements: 0 },
      { name: callback.name, statements: 3, foregroundStatements: 3 },
      { name: promise.name, statements: 5, foregroundStatements: 5 },
      { name: background.name, statements: 7, foregroundStatements: 0 },
      { name: query.name, statements: 1, foregroundStatements: 1 },
    ]);
    expect(counter.unattributed).toEqual([]);
    expect(callers.getStore()).toBeUndefined();
    expect(foregroundCounted()).toBe(true);
  } finally {
    if (held && !released) asCaller(holder, () => held!.release());
    await Promise.allSettled(pending);
    counter.restore();
    restoreCheckoutCallers();
    try { await pool.end(); }
    finally { cluster.remove(); }
  }
  expect(pg.Pool.prototype.connect).toBe(originalConnect);
  expect(pg.Client.prototype.query).toBe(originalQuery);
});

test.each(['callback', 'promise'] as const)('%s checkout preserves attribution and cleanup after SQL failure', async mode => {
  const cluster = await startPostgresCluster();
  const pool = new pg.Pool({ ...cluster.connection, max: 1, idleTimeoutMillis: 0 });
  const originalConnect = pg.Pool.prototype.connect;
  const originalQuery = pg.Client.prototype.query;
  const restoreCheckoutCallers = attributeSqlCheckoutCallers();
  const counter = countStatements();
  const holder = caller('background holder', true);
  const failed = caller('failed foreground checkout');
  const successor = caller('background successor', true);
  let held: PoolClient | undefined;
  let released = false;
  let failedClient: PoolClient | undefined;
  let successorClient: PoolClient | undefined;
  const pending: Promise<unknown>[] = [];
  try {
    held = await asCaller(holder, () => pool.connect());
    const fail = async (client: PoolClient) => {
      failedClient = client;
      let queryError: Error | undefined;
      try { await client.query('SELECT 1 / 0'); }
      catch (error) { queryError = error as Error; }
      finally { client.release(queryError); }
      expect(queryError).toMatchObject({ code: '22012' });
      expect(() => client.release()).toThrow('already been released');
    };
    pending.push(asCaller(failed, () => mode === 'callback'
      ? callbackCheckout(pool, fail)
      : (async () => fail(await pool.connect()))()));
    pending.push(asCaller(successor, () => callbackCheckout(pool, async client => {
      successorClient = client;
      try { await statements(client, successor, 1); }
      finally { client.release(); }
    })));
    expect(pool.waitingCount).toBe(2);
    asCaller(holder, () => { held!.release(); released = true; });
    const outcomes = await Promise.allSettled(pending);
    expect(outcomes.every(outcome => outcome.status === 'fulfilled')).toBe(true);
    expect(failedClient).toBe(held);
    expect(successorClient).toBeDefined();
    expect(successorClient).not.toBe(held);
    expect([holder.statements, failed.statements, successor.statements]).toEqual([0, 1, 1]);
    expect([holder.foregroundStatements, failed.foregroundStatements, successor.foregroundStatements]).toEqual([0, 1, 0]);
    expect(pool.waitingCount).toBe(0);
    expect(pool.idleCount).toBe(1);
    await pool.end();
    await asCaller(failed, async () => {
      // An ended pool reports a checkout error without issuing SQL or leaking context.
      await expect(pool.connect()).rejects.toThrow('Cannot use a pool after calling end');
      await new Promise<void>((resolve, reject) => {
        const result = pool.connect((error, client, release) => {
          try {
            expect(error?.message).toContain('Cannot use a pool after calling end');
            expect(client).toBeUndefined();
            expect(release).toBeUndefined();
            expect(callers.getStore()).toBe(failed);
            expect(foregroundCounted()).toBe(true);
            resolve();
          } catch (failure) { reject(failure); }
        });
        expect(result).toBeUndefined();
      });
    });
    expect(failed.statements).toBe(1);
    expect(counter.unattributed).toEqual([]);
    expect(callers.getStore()).toBeUndefined();
    expect(foregroundCounted()).toBe(true);
  } finally {
    if (held && !released) asCaller(holder, () => held!.release());
    await Promise.allSettled(pending);
    counter.restore();
    restoreCheckoutCallers();
    try { if (!pool.ended) await pool.end(); }
    finally { cluster.remove(); }
  }
  expect(pg.Pool.prototype.connect).toBe(originalConnect);
  expect(pg.Client.prototype.query).toBe(originalQuery);
});
