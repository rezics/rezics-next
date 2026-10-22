import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { context, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { Client, Query, type ClientConfig, type Pool, type PoolClient } from 'pg';
import {
  boundedPool, CONNECTION_CHECKOUT_WAIT_MS, nestedPoolCheckoutMode, observeSqlPool,
  setNestedPoolCheckoutMode, type SqlWorkEvent, type SqlWorkObserver,
} from '../src/infrastructure/pg-pool.ts';
import { measureStatements } from '../src/infrastructure/statement-cost.ts';

// Only the external PostgreSQL protocol is controlled. These cases run the
// actual pg pool/client/query queues and the existing bounded/statement owners.
class Wire extends EventEmitter {
  _connecting = false;
  parsedStatements = {};
  submittedNamedStatements = {};
  commands = 0;
  closing = false;
  autoClose = true;
  failure?: Error;
  stream = { destroy: () => this.end() };
  connect() {
    this._connecting = true;
    queueMicrotask(() => this.failure ? this.emit('error', this.failure) : this.emit('connect'));
  }
  startup() { queueMicrotask(() => this.emit('readyForQuery', { status: 'I' })); }
  query() { this.commands++; }
  parse() { /* extended protocol input */ }
  bind() { /* extended protocol input */ }
  describe() { /* extended protocol input */ }
  execute() { this.commands++; }
  sync() { /* the test controls the backend response */ }
  flush() { /* extended protocol input */ }
  ref() { /* no socket */ }
  unref() { /* no socket */ }
  finish(error?: Error) {
    if (error) this.emit('errorMessage', error);
    else this.emit('commandComplete', { text: 'SELECT 1' });
    this.emit('readyForQuery', { status: 'I' });
  }
  end() { this.closing = true; if (this.autoClose) queueMicrotask(() => this.close()); }
  close() { this.emit('end'); }
}

const manager = new AsyncLocalStorageContextManager();
const callers = new AsyncLocalStorage<string>();
const pools: Pool[] = [];
const clients: PoolClient[] = [];
const wires: Wire[] = [];
const a = 'a'.repeat(32), b = 'b'.repeat(32), c = 'c'.repeat(32);
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const unowned = AsyncLocalStorage.snapshot();
const scope = <T>(id: string, run: () => T): T => unowned(() =>
  new AsyncResource('sql-test-request').runInAsyncScope(() => context.with(trace.setSpanContext(ROOT_CONTEXT,
    { traceId: id, spanId: '1'.repeat(16), traceFlags: 1 }), () => callers.run(id, run))));

beforeAll(() => { context.setGlobalContextManager(manager.enable()); });
afterAll(() => { context.disable(); manager.disable(); });
afterEach(async () => {
  for (const wire of wires.splice(0)) { wire.autoClose = true; if (wire.closing) wire.close(); }
  for (const client of clients.splice(0)) { try { client.release(true); } catch { /* already released */ } }
  await Promise.all(pools.splice(0).filter(pool => !pool.ending).map(pool => pool.end()));
});

function fixture(options: { max?: number; wait?: number; failure?: Error; construction?: Error } = {}) {
  const local: Wire[] = [];
  class ProtocolClient extends Client {
    constructor(config?: ClientConfig) {
      if (options.construction) throw options.construction;
      const wire = new Wire();
      wire.failure = options.failure;
      super({ ...config, connection: wire } as ClientConfig);
      local.push(wire); wires.push(wire);
    }
  }
  const pool = boundedPool({ Client: ProtocolClient, max: options.max ?? 1, idleTimeoutMillis: 0,
    ...(options.wait === undefined ? {} : { connectionTimeoutMillis: options.wait }) });
  pool.on('acquire', client => clients.push(client));
  pools.push(pool);
  return { pool, local };
}

function capture(pool: Pool) {
  const events: SqlWorkEvent[] = [];
  const attachment = observeSqlPool(pool, event => { events.push(event); });
  return { events, attachment, latest: () => events.at(-1)!.totals };
}

function conserved(events: readonly SqlWorkEvent[]) {
  for (const event of events) {
    const m = event.totals;
    expect(m.starts).toBe(m.released + m.active + m.pending);
    expect(m.active).toBeGreaterThanOrEqual(0);
    expect(m.pending).toBeGreaterThanOrEqual(0);
    if (m.active + m.pending) expect(m.zeroSince).toBeNull();
    else if (event.complete) expect(m.zeroSince).toBeNumber();
    if (m.lastStartAt !== null) expect(m.lastStartAt).toBeLessThanOrEqual(event.at);
    if (m.zeroSince !== null) expect(m.zeroSince).toBeLessThanOrEqual(event.at);
  }
}

test('fresh callback checkout released without SQL reaches observed idle before pool shutdown', async () => {
  const { pool } = fixture();
  const events: SqlWorkEvent[] = [];
  const attachment = observeSqlPool(pool, event => { events.push(event); });
  let actual: Client | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      pool.connect((error, client, done) => {
        if (error || !client) { reject(error ?? new Error('missing client')); return; }
        actual = client;
        done();
        resolve();
      });
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(pool.totalCount).toBe(1);
    expect(pool.idleCount).toBe(1);
    expect(pool.waitingCount).toBe(0);
    expect(attachment.status()).toMatchObject({ attached: true, complete: true, failures: 0, dropped: 0, pendingNotifications: 0 });
    const driver = actual as Client & { readyForQuery: boolean; _queryQueue: unknown[]; _sentQueryQueue: unknown[] };
    expect(driver.readyForQuery).toBe(true);
    expect(driver._queryQueue).toHaveLength(0);
    expect(driver._sentQueryQueue).toHaveLength(0);
    // A real returned, idle checkout must have retired before shutdown.
    expect(events.at(-1)!.totals).toMatchObject({ starts: 1, released: 1, active: 0, pending: 0 });
  } finally {
    attachment.detach();
    await attachment.drain();
    await pool.end();
  }
});

test('fresh callback release keeps SQL queued during initial readiness visible until the wire settles', async () => {
  const { pool, local } = fixture();
  const view = capture(pool);
  const { running } = await new Promise<{ running: Promise<unknown> }>((resolve, reject) => {
    pool.connect((error, client, done) => {
      if (error || !client) { reject(error ?? new Error('missing client')); return; }
      const running = client.query('SELECT 1');
      done();
      resolve({ running });
    });
  });
  await turn();
  expect(local[0]!.commands).toBe(1);
  expect(view.latest()).toMatchObject({ starts: 1, released: 0, active: 1, pending: 0, zeroSince: null });
  expect(view.events.some(event => event.kind === 'released')).toBe(false);
  local[0]!.finish();
  await running;
  expect(view.latest()).toMatchObject({ starts: 1, released: 1, active: 0, pending: 0 });
  conserved(view.events);
});

test('promise checkout records the real queue, requesting trace, unmatched traffic and actual release timestamps', async () => {
  const { pool } = fixture();
  const view = capture(pool);
  const initial = view.events[0]!;
  const first = await scope(a, () => pool.connect());
  const waiting = scope(b, async () => {
    const client = await pool.connect();
    expect(callers.getStore()).toBe(b);
    expect(trace.getSpan(context.active())!.spanContext().traceId).toBe(b);
    return client;
  });
  expect(pool.waitingCount).toBe(1);
  expect(view.latest()).toMatchObject({ starts: 2, released: 0, active: 1, pending: 1, zeroSince: null });
  scope(c, () => first.release());
  const second = await waiting;
  scope(c, () => second.release());
  const unmatched = await pool.connect();
  unmatched.release();
  expect(view.latest()).toMatchObject({ starts: 3, released: 3, active: 0, pending: 0 });
  expect(view.events.filter(e => e.checkout === 2).map(e => [e.kind, e.trace]))
    .toEqual([['pending', b], ['active', b], ['released', b]]);
  expect(view.events.filter(e => e.checkout === 3).every(e => e.trace === undefined)).toBe(true);
  expect(initial.totals).toMatchObject({ starts: 0, released: 0, lastStartAt: null });
  expect(view.attachment.status().complete).toBe(true);
  conserved(view.events);
});

test('queued callback checkout restores the whole requester context and preserves the release alias and query callback', async () => {
  const { pool, local } = fixture();
  const view = capture(pool);
  const held = await scope(a, () => pool.connect());
  const measured = scope(b, () => measureStatements(() => new Promise<void>((resolve, reject) => {
    const returned = pool.connect((error, client, done) => {
      if (error || !client) { reject(error ?? new Error('missing client')); return; }
      expect(callers.getStore()).toBe(b);
      expect(trace.getSpan(context.active())!.spanContext().traceId).toBe(b);
      expect(done).toBe(client.release);
      const callback = (failure: Error | null | undefined) => {
        if (failure) { reject(failure); return; }
        done(); resolve();
      };
      expect(client.query('SELECT $1', ['private-value'], callback)).toBeUndefined();
      const active = client as PoolClient & { _activeQuery: { callback: unknown } };
      expect(active._activeQuery.callback).toBe(callback);
    });
    expect(returned).toBeUndefined();
  })));
  scope(c, () => held.release());
  await turn();
  expect(view.latest()).toMatchObject({ starts: 2, active: 1, pending: 0, released: 1 });
  scope(c, () => local[0]!.finish());
  expect((await measured).statements).toBe(1);
  expect(view.events.filter(e => e.checkout === 2).every(e => e.trace === b)).toBe(true);
  conserved(view.events);
});

test('pool.query promise and callback forwarding count one checkout and one statement each', async () => {
  const { pool, local } = fixture();
  const view = capture(pool);
  const first = scope(a, () => measureStatements(() => pool.query('SELECT 1')));
  await turn(); local[0]!.finish();
  expect((await first).statements).toBe(1);
  const second = scope(b, () => measureStatements(() => new Promise<void>((resolve, reject) => {
    pool.query({ text: 'SELECT $1', values: [1] }, (error, result) => {
      if (error) reject(error);
      else { expect(result.command).toBe('SELECT'); resolve(); }
    });
  })));
  await turn(); local[0]!.finish();
  expect((await second).statements).toBe(1);
  expect(local[0]!.commands).toBe(2);
  expect(view.latest()).toMatchObject({ starts: 2, released: 2, active: 0, pending: 0 });
  conserved(view.events);
});

test('actual queued callback and promise timeouts retire refused acquisitions without releasing the held client', async () => {
  const { pool } = fixture({ wait: 15 });
  const view = capture(pool);
  const held = await scope(a, () => pool.connect());
  const failed = scope(b, () => pool.connect()).catch(error => error);
  const callbackFailed = scope(c, () => new Promise<Error>(resolve => {
    pool.connect((error, client) => { expect(client).toBeUndefined(); resolve(error!); });
  }));
  expect(view.latest()).toMatchObject({ starts: 3, active: 1, pending: 2, released: 0 });
  expect((await failed).message).toContain('timeout');
  expect((await callbackFailed).message).toContain('timeout');
  expect(view.latest()).toMatchObject({ starts: 3, active: 1, pending: 0, released: 2, zeroSince: null });
  held.release();
  conserved(view.events);
});

test('ended-pool and connection failures preserve errors and conserve callback and promise attempts', async () => {
  const failure = new Error('external connect refused');
  const { pool } = fixture({ failure });
  const view = capture(pool);
  expect(await scope(a, () => pool.connect()).catch(error => error)).toBe(failure);
  expect(await scope(b, () => new Promise<Error>(resolve => pool.connect(error => resolve(error!))))).toBe(failure);
  await pool.end();
  await expect(pool.connect()).rejects.toThrow('Cannot use a pool after calling end');
  await new Promise<void>(resolve => pool.connect(error => { expect(error).toBeInstanceOf(Error); resolve(); }));
  expect(view.latest()).toMatchObject({ starts: 4, released: 4, active: 0, pending: 0 });
  conserved(view.events);
});

test('synchronous driver construction throws remain identical for both checkout overloads', () => {
  const error = new Error('external driver construction');
  const { pool } = fixture({ construction: error });
  const view = capture(pool);
  expect(() => pool.connect()).toThrow(error);
  expect(() => pool.connect(() => { throw new Error('unreachable'); })).toThrow(error);
  expect(view.latest()).toMatchObject({ starts: 2, released: 2, active: 0, pending: 0 });
  conserved(view.events);
});

test('nested rejection preserves its authority check and retires both refused overloads before driver work', async () => {
  const { pool, local } = fixture();
  const view = capture(pool);
  const mode = nestedPoolCheckoutMode();
  setNestedPoolCheckoutMode('throw');
  try {
    await scope(a, async () => {
      const held = await pool.connect();
      await expect(pool.connect()).rejects.toThrow('Nested PostgreSQL pool checkout');
      await new Promise<void>(resolve => pool.connect(error => { expect(error?.name).toBe('NestedPoolCheckoutError'); resolve(); }));
      expect(view.latest()).toMatchObject({ starts: 3, released: 2, active: 1, pending: 0 });
      held.release();
    });
    expect(local).toHaveLength(1);
    expect(local[0]!.commands).toBe(0);
    conserved(view.events);
  } finally { setNestedPoolCheckoutMode(mode); }
});

test('early release keeps actual wire SQL visible while an unaffected concurrent checkout succeeds', async () => {
  const { pool, local } = fixture({ max: 2 });
  const view = capture(pool);
  const held = await scope(a, () => pool.connect());
  const result = held.query('SELECT 1');
  const other = scope(b, () => pool.query('SELECT 2'));
  await turn();
  held.release();
  local[1]!.finish(); await other;
  expect(view.latest()).toMatchObject({ starts: 2, released: 1, active: 1, pending: 0, zeroSince: null });
  expect(view.events.some(e => e.checkout === 1 && e.kind === 'released')).toBe(false);
  local[0]!.finish(); await result;
  expect(view.latest()).toMatchObject({ starts: 2, released: 2, active: 0, pending: 0 });
  conserved(view.events);
});

test('client query timeout and departure are not native SQL release while the actual query still runs', async () => {
  const { pool, local } = fixture();
  const view = capture(pool);
  const client = await scope(a, () => pool.connect());
  const config = { text: 'SELECT 1', query_timeout: 10 };
  await expect(client.query(config)).rejects.toThrow('Query read timeout');
  client.release();
  expect(view.latest()).toMatchObject({ starts: 1, released: 0, active: 1, zeroSince: null });
  local[0]!.finish();
  expect(view.latest()).toMatchObject({ starts: 1, released: 1, active: 0, pending: 0 });
  conserved(view.events);
});

test('a query error callback cannot establish release before the real protocol fence settles', async () => {
  const { pool, local } = fixture();
  const view = capture(pool);
  const client = await scope(a, () => pool.connect());
  const failure = new Error('external query rejected');
  const result = client.query('SELECT 1').catch(error => error);
  local[0]!.emit('errorMessage', failure);
  expect(await result).toBe(failure);
  client.release();
  expect(view.latest()).toMatchObject({ starts: 1, released: 0, active: 1, zeroSince: null });
  local[0]!.emit('readyForQuery', { status: 'I' });
  expect(view.latest()).toMatchObject({ starts: 1, released: 1, active: 0, pending: 0 });
  conserved(view.events);
});

test('release with error remains active through actual delayed driver termination', async () => {
  const { pool, local } = fixture();
  const view = capture(pool);
  const client = await pool.connect();
  local[0]!.autoClose = false;
  client.release(new Error('discard this connection'));
  expect(local[0]!.closing).toBe(true);
  expect(view.latest()).toMatchObject({ starts: 1, released: 0, active: 1, zeroSince: null });
  local[0]!.close(); await turn();
  expect(view.latest()).toMatchObject({ starts: 1, released: 1, active: 0, pending: 0 });
  conserved(view.events);
});

test('actual query object, callback, promise overloads and later prototype instrumentation remain intact', async () => {
  const { pool, local } = fixture();
  const view = capture(pool);
  const client = await pool.connect();
  const query = new Query('SELECT 1');
  const end = new Promise<void>((resolve, reject) => { query.on('end', () => resolve()); query.on('error', reject); });
  expect(client.query(query)).toBe(query);
  local[0]!.finish(); await end;
  const original = Client.prototype.query;
  let hooks = 0;
  Client.prototype.query = function (this: Client, ...args: unknown[]) { hooks++; return Reflect.apply(original, this, args); } as Client['query'];
  try {
    const measured = measureStatements(() => client.query({ text: 'SELECT $1', values: [2], rowMode: 'array' }));
    local[0]!.finish();
    expect((await measured).statements).toBe(1);
    expect(hooks).toBe(1);
  } finally { Client.prototype.query = original; }
  client.release();
  expect(() => client.release()).toThrow('already been released');
  expect(view.latest()).toMatchObject({ starts: 1, released: 1, active: 0, pending: 0 });
  conserved(view.events);
});

test.each(['throw', 'reject', 'mutate'] as const)('%s observer cannot affect execution, other observers or ordinary pool bounds', async mode => {
  const { pool, local } = fixture();
  const view = capture(pool);
  const noisy = observeSqlPool(pool, event => {
    if (mode === 'throw') throw new Error('private sink error');
    if (mode === 'reject') return Promise.reject(new Error('private sink rejected'));
    (event.totals as { starts: number }).starts = 999;
  });
  expect(pool.options.connectionTimeoutMillis).toBe(CONNECTION_CHECKOUT_WAIT_MS);
  const result = pool.query('SELECT 1');
  await turn(); local[0]!.finish(); await result;
  noisy.detach(); await noisy.drain();
  expect(noisy.status()).toMatchObject({ attached: false, complete: false, failures: 4, pendingNotifications: 0 });
  expect(view.attachment.status().complete).toBe(true);
  expect(view.latest()).toMatchObject({ starts: 1, released: 1, active: 0, pending: 0 });
  conserved(view.events);
});

test('unsettled observer work is bounded, explicit overflow cannot become known zero, detach drains without awaiting SQL', async () => {
  const { pool } = fixture();
  const view = capture(pool);
  let resolveSink!: () => void;
  const sink = new Promise<void>(resolve => { resolveSink = resolve; });
  const slow = observeSqlPool(pool, () => sink);
  for (let i = 0; i < 24; i++) { const client = await pool.connect(); client.release(); }
  expect(slow.status()).toMatchObject({ pendingNotifications: 64, complete: false, failures: 0 });
  expect(slow.status().dropped).toBeGreaterThan(0);
  slow.detach();
  let drained = false;
  const drain = slow.drain().then(() => { drained = true; });
  await turn(); expect(drained).toBe(false);
  expect(view.latest()).toMatchObject({ starts: 24, released: 24, active: 0, pending: 0 });
  resolveSink(); await drain;
  expect(slow.status().pendingNotifications).toBe(0);
  expect(view.attachment.status().complete).toBe(true);
  expect(clients.at(-1)!.listenerCount('drain')).toBe(0);
  conserved(view.events);
});

test('independent pools and detached or late observers never claim missing coverage as known idle', async () => {
  const first = fixture(), second = fixture();
  const one = capture(first.pool), two = capture(second.pool);
  const client = await scope(a, () => first.pool.connect());
  one.attachment.detach();
  const prior = one.events.length;
  client.release();
  expect(one.events).toHaveLength(prior);
  const late = capture(first.pool);
  expect(late.attachment.status().complete).toBe(false);
  expect(late.events[0]!.complete).toBe(false);
  expect(late.latest().zeroSince).toBeNull();
  expect(two.latest()).toMatchObject({ starts: 0, released: 0, active: 0, pending: 0 });
  expect(two.attachment.status().complete).toBe(true);
  const next = await second.pool.connect(); next.release();
  expect(two.latest()).toMatchObject({ starts: 1, released: 1 });
  expect(late.latest().starts).toBe(0);
});

test('ordinary unobserved pools keep driver results, callback identity and bounds without an observation history', async () => {
  const { pool, local } = fixture({ wait: 37 });
  const result = pool.query('SELECT 1');
  await turn(); local[0]!.finish();
  expect((await result).command).toBe('SELECT');
  expect(pool.options.connectionTimeoutMillis).toBe(37);
  const late = capture(pool);
  expect(late.latest().starts).toBe(0);
  expect(late.attachment.status().complete).toBe(false);
});

test('private attachments are bounded, additive and require the actual bounded owner', () => {
  const { pool } = fixture();
  const attached = Array.from({ length: 8 }, () => observeSqlPool(pool, (() => undefined) satisfies SqlWorkObserver));
  expect(() => observeSqlPool(pool, () => undefined)).toThrow('observer limit');
  for (const a of attached) a.detach();
  const fresh = capture(pool);
  expect(fresh.attachment.status().complete).toBe(true);
  expect(() => observeSqlPool({} as Pool, () => undefined)).toThrow('actual bounded pool');
});
