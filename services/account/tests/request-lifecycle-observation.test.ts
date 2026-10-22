import { expect, spyOn, test } from 'bun:test';
import { Pool, type PoolClient, type QueryResult } from 'pg';
import { createAccountApp, type AccountAppOptions, type AccountRequestWork } from '../src/app.ts';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(condition: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await Bun.sleep(1);
  }
  throw new Error('owner transition did not arrive');
}

const token = `${Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'current-key' })).toString('base64url')}.e30.signature`;
const request = (signal?: AbortSignal) => new Request('https://account.example.test/api/auth/oauth2/introspect', {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ token }), signal,
});

function payload() {
  const now = Math.floor(Date.now() / 1000);
  return { active: true, client_id: 'reader', sub: 'reader', jti: 'current-token', iat: now, exp: now + 300,
    scope: 'work:read', rezics_auth_mode: 'workload', rezics_installation_id: 'installation',
    rezics_content_evidence: { private: 'must not escape provider input' } };
}

/** Only external provider/pg I/O is controlled. The app, introspection and every
 * signing/installation/consent enforcement function execute their real bodies. */
function fixture(options: {
  observer?: AccountAppOptions['observeRequestWork'];
  provider?: (request: Request) => Promise<Response>;
  connect?: () => Promise<PoolClient>;
  query?: (sql: string) => Promise<void>;
  denied?: 'key' | 'installation' | 'scope' | 'consent';
} = {}) {
  const events: AccountRequestWork[] = [];
  const sql: string[] = [];
  let releases = 0;
  const pool = new Pool();
  const client = {
    query: async (statement: string) => {
      sql.push(statement);
      await options.query?.(statement);
      if (statement.includes('FROM public.rezics_signing_key')) return {
        rows: [{ state: options.denied === 'key' ? 'retired' : 'active', activated: '0' }], rowCount: 1,
      };
      if (statement.includes('FROM public.rezics_oauth_installation')) return {
        rows: [], rowCount: options.denied === 'installation' || options.denied === 'scope' ? 0 : 1,
      };
      if (statement.includes('FROM "oauthClient"')) return {
        rows: [{ skipConsent: false, grantTypes: ['client_credentials'] }], rowCount: 1,
      };
      if (statement.includes('FROM "oauthConsent"')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
    release: () => { releases++; },
  } as unknown as PoolClient;
  const connect = spyOn(pool, 'connect').mockImplementation((() =>
    options.connect ? options.connect() : Promise.resolve(client)) as typeof pool.connect);
  const auth = {
    options: { baseURL: 'https://account.example.test', secret: 'private-provider-secret' },
    handler: options.provider ?? (async () => Response.json({ ...payload(),
      ...(options.denied === 'consent' ? { sub: 'member', rezics_auth_mode: 'consent',
        rezics_consent_id: 'consent', rezics_consent_generation: '1' } : {}) })),
  } as Parameters<typeof createAccountApp>[0];
  const app = createAccountApp(auth, pool, { observeRequestWork: options.observer ?? (event => { events.push(event); }) });
  return { app, pool, auth, client, connect, events, sql, get releases() { return releases; },
    close: () => pool.end() };
}

function conserved(events: AccountRequestWork[]) {
  for (const event of events) {
    const { starts, released, active, pending, zeroSince, lastStartAt } = event.total;
    expect(starts).toBe(released + active + pending);
    expect(Math.min(starts, released, active, pending)).toBeGreaterThanOrEqual(0);
    expect(zeroSince === null).toBe(active + pending !== 0);
    if (lastStartAt !== null) expect(lastStartAt).toBeLessThanOrEqual(event.at);
    if (zeroSince !== null) expect(zeroSince).toBeLessThanOrEqual(event.at);
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.total)).toBe(true);
    expect(Object.keys(event).sort()).toEqual(['at', 'kind', 'request', 'state', 'total']);
  }
}

test('Account owner reports initial idle and exact Request start before provider work, release after settlement', async () => {
  const provider = deferred<Response>();
  const f = fixture({ provider: () => provider.promise });
  try {
    expect(f.events[0]).toMatchObject({ request: null, state: 'idle',
      total: { starts: 0, released: 0, active: 0, pending: 0, lastStartAt: null } });
    expect(f.events[0]!.total.zeroSince).toBeNumber();
    const input = request();
    const response = f.app.handle(input);
    await until(() => f.events.some(event => event.state === 'started'));
    expect(f.events[1]!.request).toBe(input);
    expect(f.events.at(-1)!.total).toMatchObject({ starts: 1, released: 0, active: 1, pending: 0, zeroSince: null });
    provider.resolve(Response.json({ active: false }));
    expect(await (await response).json()).toEqual({ active: false });
    await until(() => f.events.at(-1)!.state === 'released');
    expect(f.events.at(-1)!.request).toBe(input);
    expect(f.events.at(-1)!.total).toMatchObject({ starts: 1, released: 1, active: 0, pending: 0 });
    expect(f.connect).not.toHaveBeenCalled();
    conserved(f.events);
  } finally { await f.close(); }
});

test('Account owner distinguishes pool wait from active authority work and releases after actual COMMIT and client release', async () => {
  const acquisition = deferred<PoolClient>();
  const commit = deferred();
  const f = fixture({ connect: () => acquisition.promise, query: sql => sql === 'COMMIT' ? commit.promise : Promise.resolve() });
  try {
    const input = request();
    const response = f.app.handle(input);
    await until(() => f.events.at(-1)!.state === 'pending');
    expect(f.events.at(-1)!.total).toMatchObject({ active: 0, pending: 1, released: 0 });
    expect(f.sql).toEqual([]);
    acquisition.resolve(f.client);
    await until(() => f.sql.includes('COMMIT'));
    expect(f.events.at(-1)!.state).toBe('active');
    expect(f.releases).toBe(0);
    commit.resolve();
    const result = await response;
    expect(result.status).toBe(200);
    const body = await result.json();
    expect(body.active).toBe(true);
    expect(body.rezics_content_evidence).toBeUndefined();
    await until(() => f.events.at(-1)!.state === 'released');
    expect(f.releases).toBe(1);
    expect(f.events.filter(event => event.request === input).map(event => event.state))
      .toEqual(['started', 'pending', 'active', 'released']);
    conserved(f.events);
  } finally { await f.close(); }
});

test('caller departure does not report Account pool release, concurrent waiter and independent retry keep real cumulative counts', async () => {
  const acquisition = deferred<PoolClient>();
  let connects = 0;
  const f = fixture({ connect: () => ++connects === 1 ? acquisition.promise : Promise.resolve(f.client) });
  try {
    const caller = new AbortController();
    const leaving = request(caller.signal);
    const response = f.app.handle(leaving);
    await until(() => f.events.at(-1)!.state === 'pending');
    caller.abort(new Error('caller left'));
    expect(f.events.at(-1)!.total).toMatchObject({ pending: 1, released: 0 });
    const unaffected = request();
    expect((await f.app.handle(unaffected)).status).toBe(200);
    await until(() => f.events.some(event => event.request === unaffected && event.state === 'released'));
    expect(f.events.at(-1)!.total).toMatchObject({ starts: 2, released: 1, pending: 1, active: 0, zeroSince: null });
    expect(f.events.some(event => event.request === leaving && event.state === 'released')).toBe(false);
    acquisition.resolve(f.client);
    await response;
    await until(() => f.events.at(-1)!.total.released === 2);
    const retry = request();
    expect((await f.app.handle(retry)).status).toBe(200);
    await until(() => f.events.at(-1)!.total.released === 3);
    expect(f.releases).toBe(3);
    expect(new Set(f.events.filter(event => event.state === 'started').map(event => event.request)))
      .toEqual(new Set([leaving, unaffected, retry]));
    conserved(f.events);
  } finally { await f.close(); }
});

test('failed authority work remains active through real rollback and releases only after database cleanup', async () => {
  const rollback = deferred();
  const f = fixture({ query: async sql => {
    if (sql.includes('FROM public.rezics_signing_key')) throw new Error('database unavailable');
    if (sql === 'ROLLBACK') await rollback.promise;
  } });
  try {
    const controller = new AbortController();
    const response = f.app.handle(request(controller.signal));
    await until(() => f.sql.includes('ROLLBACK'));
    controller.abort();
    expect(f.releases).toBe(0);
    expect(f.events.at(-1)!.total).toMatchObject({ active: 1, released: 0, zeroSince: null });
    rollback.resolve();
    // Preserve Elysia's existing disconnected-response behavior. The owner
    // assertion is about actual database cleanup, not a proxy response status.
    await response;
    await until(() => f.events.at(-1)!.state === 'released');
    expect(f.releases).toBe(1);
    conserved(f.events);
  } finally { await f.close(); }
});

for (const failure of ['provider', 'connect', 'rollback'] as const) {
  test(`${failure} failure conserves real Account owner work without a false active or pending remainder`, async () => {
    const f = fixture({
      ...(failure === 'provider' ? { provider: async () => { throw new Error('provider unavailable'); } } : {}),
      ...(failure === 'connect' ? { connect: async () => { throw new Error('connection unavailable'); } } : {}),
      ...(failure === 'rollback' ? { query: async () => { throw new Error('database unavailable'); } } : {}),
    });
    try {
      expect((await f.app.handle(request())).status).toBe(503);
      await until(() => f.events.at(-1)!.state === 'released');
      expect(f.events.at(-1)!.total).toMatchObject({ starts: 1, released: 1, active: 0, pending: 0 });
      expect(f.releases).toBe(failure === 'rollback' ? 1 : 0);
      conserved(f.events);
    } finally { await f.close(); }
  });
}

for (const mode of ['throw', 'reject', 'pending', 'mutate'] as const) {
  test(`${mode} observer cannot change current authority enforcement or await the private sink`, async () => {
    const delivered: AccountRequestWork[] = [];
    const f = fixture({ denied: 'consent', observer: event => {
      delivered.push(event);
      if (mode === 'throw') throw new Error('private sink failure');
      if (mode === 'reject') return Promise.reject(new Error('private sink failure'));
      if (mode === 'pending') return new Promise<void>(() => {});
      if (mode === 'mutate') (event.total as { active: number }).active = 1_000_000;
    } });
    try {
      expect(await (await f.app.handle(request())).json()).toEqual({ active: false });
      await until(() => delivered.at(-1)!.state === 'released');
      expect(f.sql.some(sql => sql.includes('FROM "oauthConsent"'))).toBe(true);
      expect(f.sql.at(-1)).toBe('COMMIT');
      expect(f.releases).toBe(1);
      conserved(delivered);
    } finally { await f.close(); }
  });
}

for (const denied of ['key', 'installation', 'scope', 'consent', undefined] as const) {
  test(`observed and ordinary introspection retain the same ${denied ?? 'allowed'} authority decision and private evidence`, async () => {
    const f = fixture({ denied });
    const ordinary = fixture({ denied });
    const unobserved = createAccountApp(ordinary.auth, ordinary.pool);
    try {
      const observed = await f.app.handle(request());
      const normal = await unobserved.handle(request());
      expect(observed.status).toBe(normal.status);
      expect(await observed.json()).toEqual(await normal.json());
      expect(f.sql).toEqual(ordinary.sql);
      expect(f.releases).toBe(1);
      expect(ordinary.releases).toBe(1);
      await until(() => f.events.at(-1)!.state === 'released');
      conserved(f.events);
    } finally { await f.close(); await ordinary.close(); }
  });
}

test('independent Account app owners keep separate totals and immutable earlier snapshots', async () => {
  const first = fixture();
  const second = fixture();
  try {
    const idle = first.events[0]!;
    await first.app.handle(request());
    await until(() => first.events.at(-1)!.state === 'released');
    expect(idle.total).toMatchObject({ starts: 0, released: 0 });
    expect(second.events).toHaveLength(1);
    expect(second.events[0]!.total).toMatchObject({ starts: 0, released: 0 });
    await second.app.handle(request());
    await until(() => second.events.at(-1)!.state === 'released');
    expect(second.events.at(-1)!.total).toMatchObject({ starts: 1, released: 1 });
    conserved(first.events);
    conserved(second.events);
  } finally { await first.close(); await second.close(); }
});

test('Account readiness timeout retains owner work until its actual database probe settles', async () => {
  const f = fixture();
  const probe = deferred<QueryResult>();
  const query = spyOn(f.pool, 'query').mockImplementation((() => probe.promise) as typeof f.pool.query);
  try {
    const input = new Request('https://account.example.test/health/ready');
    expect((await f.app.handle(input)).status).toBe(503);
    expect(query).toHaveBeenCalledTimes(1);
    expect(f.events.at(-1)!.total).toMatchObject({ starts: 1, released: 0, active: 1, pending: 0, zeroSince: null });
    probe.resolve({ command: 'SELECT', rowCount: 1, oid: 0, fields: [], rows: [{ '?column?': 1 }] });
    await until(() => f.events.at(-1)!.state === 'released');
    expect(f.events.at(-1)!.request).toBe(input);
    conserved(f.events);
  } finally { query.mockRestore(); await f.close(); }
});
