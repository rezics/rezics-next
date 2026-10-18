import { expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { Pool, PoolClient } from 'pg';
import { FusekiClient, fusekiReadBudget } from '../src/infrastructure/fuseki.ts';
import { notificationGraphRead, notificationRead, notificationReadPool, notificationReadStep,
  NOTIFICATION_READ_COST } from '../src/modules/notification/request-budget.ts';
import { NotificationStore, NotificationUnavailable } from '../src/modules/notification/store.ts';
import { AccountAssertionVerifier } from '../src/modules/account/verify-assertion.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { notificationRecipientsAllowed } from '../src/modules/notification/recipient-policy.ts';

const epoch = '11111111-1111-4111-8111-111111111111';
const routing = '22222222-2222-4222-8222-222222222222';

/** Transport fixture only: these unit checks do not qualify real mixed load. */
function graphFixture(nativeVersion = true) {
  let sequence = 1;
  const calls: string[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const query = await request.text();
    calls.push(query);
    return Response.json({ results: { bindings: [{ sequence: { type: 'literal', value: String(sequence) } }] } },
      { headers: nativeVersion ? { 'x-rezics-graph-version': `${epoch}:${routing}:${sequence}` } : {} });
  } });
  const fuseki = new FusekiClient(`${server.url}`);
  const environment: WorkActivationEnvironment = { fuseki,
    lineage: { dataEpoch: epoch, routingEpoch: routing }, objectDirectory: '.temp/notification-budget-unit' };
  return { environment, calls, advance: () => sequence++, stop: () => server.stop(true) };
}

test('fifty distinct subjects reuse graph inputs while all live owner decisions run', async () => {
  const fixture = graphFixture();
  let ownerDecisions = 0;
  try {
    const page = await notificationRead(new Request('http://main.local/v1/me/notifications'), () =>
      notificationGraphRead(fixture.environment, async () => {
        const items: number[] = [];
        for (let index = 0; index < 50; index++) {
          for (let fence = 0; fence < 2; fence++) {
            await fixture.environment.fuseki.query('SELECT ?realm WHERE { }', 4096);
            await fixture.environment.fuseki.query(`SELECT ?subject WHERE { BIND(${index} AS ?subject) }`, 4096);
            await fixture.environment.fuseki.query('SELECT ?title WHERE { }', 4096);
            ownerDecisions++;
          }
          items.push(index);
        }
        return items;
      }));
    expect(page).toEqual(Array.from({ length: 50 }, (_, index) => index));
    expect(ownerDecisions).toBe(100);
    expect(fixture.calls).toHaveLength(54);
    expect(fixture.calls.length).toBeLessThanOrEqual(NOTIFICATION_READ_COST.graphCalls);
  } finally { fixture.stop(); }
});

test('a graph movement discards retained inputs and retries without renewing the allocation', async () => {
  const fixture = graphFixture();
  let attempts = 0;
  const meters: number[] = [];
  try {
    const result = await notificationRead(undefined, () => notificationGraphRead(fixture.environment, async () => {
      attempts++;
      meters.push(fusekiReadBudget.getStore()!.callsLeft);
      await fixture.environment.fuseki.query('SELECT ?title WHERE { }', 4096);
      if (attempts === 1) fixture.advance();
      return attempts;
    }));
    expect(result).toBe(2);
    expect(fixture.calls.filter(query => query === 'SELECT ?title WHERE { }')).toHaveLength(2);
    expect(meters[1]).toBeLessThan(meters[0]!);
  } finally { fixture.stop(); }
});

test('retained graph inputs never cross requests or concurrent readers', async () => {
  const fixture = graphFixture();
  try {
    for (const readers of [1, 2, 4, 8]) {
      const start = fixture.calls.length;
      await Promise.all(Array.from({ length: readers }, () => notificationRead(undefined, () =>
        notificationGraphRead(fixture.environment, async () => {
          await fixture.environment.fuseki.query('SELECT ?private WHERE { }', 4096);
          await fixture.environment.fuseki.query('SELECT ?private WHERE { }', 4096);
        }))));
      expect(fixture.calls.length - start).toBe(readers * 3);
    }
  } finally { fixture.stop(); }
});

test('graph inputs without a native version are read live on both sides of owner checks', async () => {
  const fixture = graphFixture(false);
  try {
    await notificationRead(undefined, () => notificationGraphRead(fixture.environment, async () => {
      await fixture.environment.fuseki.query('SELECT ?policy WHERE { }', 4096);
      await fixture.environment.fuseki.query('SELECT ?policy WHERE { }', 4096);
    }));
    expect(fixture.calls).toHaveLength(4);
  } finally { fixture.stop(); }
});

test('nested owner reads debit their parent allocation and a fresh request recovers', async () => {
  await expect(notificationRead(undefined, async () => {
    const budget = fusekiReadBudget.getStore()!;
    budget.callsLeft = 7;
    await notificationRead(undefined, async () => {
      expect(fusekiReadBudget.getStore()).toBe(budget);
      budget.callsLeft--;
    });
    expect(budget.callsLeft).toBe(6);
    throw new NotificationUnavailable('temporary owner failure');
  })).rejects.toThrow('temporary owner failure');
  await notificationRead(undefined, async () => {
    expect(fusekiReadBudget.getStore()!.callsLeft).toBe(NOTIFICATION_READ_COST.graphCalls);
  });
});

test('cancellation before authentication starts no Account, SQL or subject work', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await expect(notificationRead(new Request('http://main.local', { signal: controller.signal }), async () => {
    calls++;
  })).rejects.toBeInstanceOf(NotificationUnavailable);
  expect(calls).toBe(0);
});

test('cancellation retires an in-flight SQL checkout and prevents the next statement', async () => {
  const controller = new AbortController();
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  let fail!: (error: Error) => void;
  let releases = 0;
  const queries: string[] = [];
  const client = { query: (query: string) => {
    queries.push(query);
    started();
    return new Promise((_resolve, reject) => { fail = reject; });
  }, release: (destroy?: boolean) => {
    releases++;
    expect(destroy).toBe(true);
    fail(new Error('connection terminated'));
  } } as unknown as PoolClient;
  const pool = notificationReadPool({ connect: async () => client } as unknown as Pool);
  const pending = notificationRead(new Request('http://main.local', { signal: controller.signal }), async () => {
    await pool.query('SELECT first');
    await pool.query('SELECT later');
  });
  const failure = expect(pending).rejects.toBeInstanceOf(NotificationUnavailable);
  await entered;
  controller.abort();
  await failure;
  expect(queries).toEqual(['SELECT first']);
  expect(releases).toBe(1);
});

test('cancelling during an owner read stops later adapters even if that owner swallows the abort', async () => {
  const controller = new AbortController();
  let later = 0;
  await expect(notificationRead(new Request('http://main.local', { signal: controller.signal }), async () => {
    await notificationReadStep(async () => { controller.abort(); return null; });
    later++;
  })).rejects.toBeInstanceOf(NotificationUnavailable);
  expect(later).toBe(0);
});

test('the complete allocation bounds an adapter that has not finished its own timeout', async () => {
  let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  let later = 0;
  try {
    await expect(fusekiReadBudget.run({ signal: new AbortController().signal,
      deadline: performance.now() + 25, callsLeft: 160, bytesLeft: 4_194_304 }, () =>
      notificationRead(undefined, async () => {
        await notificationReadStep(() => held);
        later++;
      }))).rejects.toBeInstanceOf(NotificationUnavailable);
    expect(later).toBe(0);
  } finally { finish(); }
});

test('cancellation while waiting for a SQL checkout releases it without starting a statement', async () => {
  const controller = new AbortController();
  let checkout!: (client: PoolClient) => void;
  let released!: () => void;
  const drained = new Promise<void>(resolve => { released = resolve; });
  let statements = 0;
  const pool = notificationReadPool({ connect: () => new Promise<PoolClient>(resolve => { checkout = resolve; }) } as Pool);
  const pending = notificationRead(new Request('http://main.local', { signal: controller.signal }), async () => {
    await pool.query('SELECT subject');
  });
  controller.abort();
  await expect(pending).rejects.toBeInstanceOf(NotificationUnavailable);
  checkout({ query: () => { statements++; }, release: (destroy: boolean) => {
    expect(destroy).toBe(true); released();
  } } as unknown as PoolClient);
  await drained;
  expect(statements).toBe(0);
});

async function accountFixture() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const key = { ...await exportJWK(publicKey), kid: 'active', alg: 'RS256', use: 'sig' };
  const issuer = 'http://account.local', audience = 'http://main.local';
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'active' })
    .setIssuer(issuer).setAudience(audience).setSubject('recipient').setIssuedAt(now)
    .setExpirationTime(now + 300).sign(privateKey);
  let keyCalls = 0, introspections = 0;
  let keys!: () => void, enteredKeys!: () => void;
  const keyHold = new Promise<void>(resolve => { keys = resolve; });
  const keysStarted = new Promise<void>(resolve => { enteredKeys = resolve; });
  let enteredIntrospection!: () => void, finishIntrospection!: () => void;
  const introspectionStarted = new Promise<void>(resolve => { enteredIntrospection = resolve; });
  const introspectionHold = new Promise<void>(resolve => { finishIntrospection = resolve; });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname === '/jwks') {
      keyCalls++; enteredKeys(); await keyHold;
      return Response.json({ keys: [key] });
    }
    introspections++; enteredIntrospection(); await introspectionHold;
    return Response.json({ active: true, iss: issuer, sub: 'recipient', aud: audience,
      scope: 'notification:manage', exp: now + 300 });
  } });
  const verifier = new AccountAssertionVerifier({ issuer, audience, jwksUrl: new URL('/jwks', server.url).href,
    introspectUrl: new URL('/introspect', server.url).href, clientId: 'main', clientSecret: 'unit-secret' });
  const request = (signal?: AbortSignal) => new Request(`${audience}/v1/me/notifications`, {
    headers: { authorization: `Bearer ${token}` }, signal });
  const verify = (signal?: AbortSignal) => notificationRead(request(signal), budgetSignal =>
    notificationReadStep(() => verifier.verify(request(budgetSignal), ['notification:manage'])));
  return { keys, keysStarted, introspectionStarted, finishIntrospection, verify,
    counts: () => ({ keyCalls, introspections }), stop: () => server.stop(true) };
}

test('a shared Account key refresh drains after cancellation without starting later introspection', async () => {
  const fixture = await accountFixture();
  const controller = new AbortController();
  try {
    const pending = fixture.verify(controller.signal);
    await fixture.keysStarted;
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(NotificationUnavailable);
    fixture.keys(); fixture.finishIntrospection();
    expect(await fixture.verify()).toMatchObject({ subject: 'recipient' });
    expect(fixture.counts()).toEqual({ keyCalls: 1, introspections: 1 });
  } finally { fixture.keys(); fixture.finishIntrospection(); fixture.stop(); }
});

test('cancelling Account introspection permits a fresh independently verified retry', async () => {
  const fixture = await accountFixture();
  const controller = new AbortController();
  try {
    fixture.keys();
    const pending = fixture.verify(controller.signal);
    await fixture.introspectionStarted;
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(NotificationUnavailable);
    fixture.finishIntrospection();
    expect(await fixture.verify()).toMatchObject({ subject: 'recipient' });
    expect(fixture.counts()).toEqual({ keyCalls: 1, introspections: 2 });
  } finally { fixture.keys(); fixture.finishIntrospection(); fixture.stop(); }
});

test('deferred work cannot use an allocation after its response completes', async () => {
  let deferred!: () => Promise<void>;
  const { AsyncResource } = await import('node:async_hooks');
  await notificationRead(undefined, async () => {
    deferred = AsyncResource.bind(() => notificationReadStep(async () => {}));
  });
  await expect(deferred()).rejects.toThrow();
});

test('recipient batches retain distinct audiences and fill missing decisions as denied', async () => {
  const principal = epoch;
  const statements: unknown[][] = [];
  const pool = { query: async (_sql: string, args: unknown[]) => {
    statements.push(args);
    return { rows: [{ ordinal: '2', allowed: true }, { ordinal: '1', allowed: false }] };
  } } as unknown as Pool;
  const inputs = [{ principal, actor: 'actor-a', realm: 'realm-a', resource: 'work-a' },
    { principal: routing, actor: 'actor-b', realm: 'realm-b', resource: 'work-b' }, { principal }];
  expect(await notificationRecipientsAllowed(pool, inputs)).toEqual([false, true, false]);
  expect(statements).toEqual([[[principal, routing, principal], ['actor-a', 'actor-b', null],
    ['realm-a', 'realm-b', null], ['work-a', 'work-b', null]]]);
});

function unreadFixture(size: number, deniedAtFence = 0) {
  let resolves = 0, recipientChecks = 0;
  let unavailable = false;
  const principal = { issuer: 'account', subject: 'recipient' };
  const rows = Array.from({ length: size }, (_, index) => ({ subject_owner: 'graph', subject_ref: String(index),
    subject_revision: null, disclosure_basis: 'unit', realm: null, actor_agent: null, group_key: null,
    reason: null, topic: 'reply' }));
  const query = async (sql: string, args?: unknown[]) => {
    if (sql.includes('access.recovery_fence')) return { rows: [{ open: true }] };
    if (sql.includes('access.principal')) return { rows: [{ id: epoch, active: true }] };
    if (sql.includes('SELECT generation::text')) return { rows: [{ generation: '1' }] };
    if (sql.includes('FROM access.notification_item')) return { rows };
    if (sql.includes('person_block')) {
      recipientChecks++;
      return { rows: (args![0] as string[]).map((_, index) => ({ ordinal: String(index + 1),
        allowed: recipientChecks === 1 || index >= deniedAtFence })) };
    }
    return { rows: [] };
  };
  const store = new NotificationStore(notificationReadPool({ query,
    connect: async () => ({ query, release() {} }) } as unknown as Pool));
  store.setDefaultReadSubjectReader({ resolve: async () => {
    resolves++;
    if (unavailable) return { status: 'unavailable' };
    return { status: 'available', subject: { fields: {}, private: false } };
  } });
  return { read: () => store.unreadCount(principal), resolves: () => resolves, checks: () => recipientChecks,
    setUnavailable: (value: boolean) => { unavailable = value; } };
}

test('fifty current unread subjects remain fifty, with fresh recipient decisions at disclosure', async () => {
  const fixture = unreadFixture(50);
  expect(await fixture.read()).toEqual({ generation: '1', count: 50, overflow: false });
  expect(fixture.resolves()).toBe(50);
  expect(fixture.checks()).toBe(2);
});

test('an ordinary overflowing inbox resolves only the hundred current subjects needed for 99+', async () => {
  const fixture = unreadFixture(257);
  expect(await fixture.read()).toEqual({ generation: '1', count: 99, overflow: true });
  expect(fixture.resolves()).toBe(100);
});

test('unread overflow replaces recipients denied at the final fence before reporting 99+', async () => {
  const fixture = unreadFixture(120, 1);
  expect(await fixture.read()).toEqual({ generation: '1', count: 99, overflow: true });
  expect(fixture.resolves()).toBe(101);
  expect(fixture.checks()).toBe(3);
});

test('an unavailable unread subject leaves the request retryable instead of silently lowering its count', async () => {
  const fixture = unreadFixture(1);
  fixture.setUnavailable(true);
  await expect(fixture.read()).rejects.toBeInstanceOf(NotificationUnavailable);
  fixture.setUnavailable(false);
  expect(await fixture.read()).toEqual({ generation: '1', count: 1, overflow: false });
});
