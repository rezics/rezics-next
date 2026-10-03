import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { uuidToSid } from '@rezics/model/address/sid';
import { createMainApp } from '../../../services/main/src/app.ts';
import { rateLimitBudgets } from '../../../services/main/src/modules/rate-limit/budgets.ts';
import { PostgresRateLimitStore } from '../../../services/main/src/modules/rate-limit/store.ts';
import { NAME_COST } from '../../../services/main/src/modules/address/registry.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { addressFixture } from './g-937-support.ts';

test('G1003: public navigation survives miss exhaustion; validators follow renames and live visibility', async () => {
  const f = await addressFixture('g-1003');
  try {
    const record = await f.work('Address navigation');
    await f.permit(record.work);
    const first = await f.receipt(
      await f.nameWrite('work', record.work, 'claim', 'Navigation first', null),
    );
    const options = {
      secret: `g-1003-${randomUUID()}-address-budget`,
      serviceClientIds: new Set<string>(),
      trustedProxyPeers: new Set<string>(),
      clientIpHeader: 'x-rezics-client-ip',
    };
    const app = createMainApp(f.env.fuseki, {
      environment: f.env,
      access: f.access,
      account: f.account.verifier,
      rateLimit: {
        options,
        budgets: rateLimitBudgets(),
        store: new PostgresRateLimitStore(f.accessPool, options),
      },
    });
    const call = (query: string, headers?: HeadersInit) =>
      app.handle(new Request(`http://main.local/v1/addresses/resolve?${query}`, { headers }));
    const resolve = (key: string, headers?: HeadersInit) =>
      call(new URLSearchParams({ scope: 'work', key }).toString(), headers);
    const read = await resolve(first.key);
    expect(read.status, await read.clone().text()).toBe(200);
    const etag = read.headers.get('etag')!;
    expect(etag).toContain(first.revision);
    expect(read.headers.get('cache-control')).toBe('public, max-age=30, must-revalidate');
    expect(read.headers.get('vary')?.toLowerCase()).toContain('x-rezics-display-languages');
    const unchanged = await resolve(first.key, { 'if-none-match': `"other", W/${etag}` });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe('');
    expect(unchanged.headers.get('etag')).toBe(etag);
    const authenticated = await call(
      new URLSearchParams({ scope: 'work', key: first.key, actingSubject: f.actor }).toString(),
      { authorization: `Bearer ${f.account.tokenA}`, 'if-none-match': etag },
    );
    expect(authenticated.status).toBe(200);
    expect(authenticated.headers.get('cache-control')).toBe('no-store');
    expect(authenticated.headers.has('etag')).toBe(false);
    const selectedActor = await call(
      new URLSearchParams({ scope: 'work', key: first.key, actingSubject: f.actor }).toString(),
    );
    expect(selectedActor.status).toBe(200);
    expect(selectedActor.headers.get('cache-control')).toBe('no-store');
    const identity = uuidToSid(record.work.slice(-36));
    const identityEtag = (await resolve(identity)).headers.get('etag')!;
    let graphCalls = 0;
    const query = f.env.fuseki.query.bind(f.env.fuseki);
    f.env.fuseki.query = async (...args) => {
      graphCalls++;
      return query(...args);
    };
    for (let i = 0; i < 40; i++) {
      graphCalls = 0;
      const hit = await resolve(i % 2 ? first.key : identity);
      expect(hit.status, await hit.clone().text()).toBe(200);
      // The miss policy adds no graph traversal to the existing bounded read.
      expect(graphCalls).toBeLessThanOrEqual(NAME_COST.fusekiRequests.resolve);
    }
    const renamed = await f.receipt(
      await f.nameWrite('work', record.work, 'rename', 'Navigation second', first.revision),
    );
    for (const [key, tag] of [
      [first.key, etag],
      [identity, identityEtag],
    ]) {
      const moved = await resolve(key!, { 'if-none-match': tag! });
      expect(moved.status).toBe(200);
      expect(moved.headers.get('etag')).not.toBe(tag!);
      expect(await moved.json()).toMatchObject({ canonical: { key: renamed.key } });
    }
    const hidden = await f.work('Hidden navigation');
    await f.nativeFuseki.update(`INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(hidden.work)} <https://rezics.com/vocab/protectionHead> ${iri(`https://rezics.com/id/${randomUUID()}`)} } }`);
    const misses = [
      await resolve(hidden.work.slice(-36)),
      await call('scope=work&key='),
      await call('scope=unknown&key=name'),
    ];
    for (const miss of misses) {
      expect([400, 404]).toContain(miss.status);
      expect(miss.headers.get('cache-control')).toBe('no-store');
      expect(miss.headers.has('etag')).toBe(false);
    }
    for (let i = misses.length; i < 30; i++)
      expect((await resolve(`g-1003-missing-${i}`)).status).toBe(404);
    const exhausted = await Promise.all(
      Array.from({ length: 4 }, (_, i) => resolve(`g-1003-exhausted-${i}`)),
    );
    for (const miss of exhausted) {
      expect(miss.status).toBe(429);
      expect(Number(miss.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(Number(miss.headers.get('retry-after'))).toBeLessThanOrEqual(60);
      expect(await miss.json()).toMatchObject({ code: 'rate_limited', family: 'address' });
    }
    expect((await resolve(renamed.key)).status).toBe(200);
    const current = await resolve(first.key);
    expect(
      (await resolve(first.key, { 'if-none-match': current.headers.get('etag')! })).status,
    ).toBe(304);
    // A conditional request must still check visibility before returning 304.
    await f.nativeFuseki.update(`INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(record.work)} <https://rezics.com/vocab/protectionHead> ${iri(`https://rezics.com/id/${randomUUID()}`)} } }`);
    expect(
      (await resolve(first.key, { 'if-none-match': current.headers.get('etag')! })).status,
    ).toBe(429);
  } finally {
    await f.close();
  }
}, 120_000);
