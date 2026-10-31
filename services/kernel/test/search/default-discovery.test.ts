import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readConfig, startServer } from '../../src/server.ts';
import { createSemanticDriver } from '../semantic/outcome-driver.ts';
import { workerTestEnv } from '../support/worker-env.ts';
import { startOutcomeWorkerProcess } from './support/outcome-rpc.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { allocateDiscovery, discoveryConsumer, discoveryGenerations } from '../../src/search/generations.ts';
import { nativeDiscoveryRegistry } from '../../src/search/account-discovery.ts';
import { createRatedSubjectSource } from '../../src/search/rated-source.ts';
import { readFreshness } from '../../src/search/freshness.ts';
import type { DiscoveryHit, DiscoveryPage } from '../../src/search/discovery.ts';

async function eventually<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error('Default discovery did not complete native preparation');
    await Bun.sleep(100);
  }
}

test('ordinary configured server returns current mixed discovery through its default owner producers and retained continuation', async () => {
  const endpoint = process.env.OPENSEARCH_URL;
  if (!endpoint) throw new Error('OPENSEARCH_URL must name the check node');
  // The fixture establishes actual owner resources only. Every search below goes to startServer.
  const driver = await createSemanticDriver(undefined, { isolatedAuth: true });
  const { pool, runtime } = driver.fixtures;
  const prefix = `default-${randomUUID().replaceAll('-', '').slice(0, 20)}-`;
  const marker = `mixed${randomUUID().replaceAll('-', '')}`;
  const search = createOpenSearch(endpoint);
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let worker: ReturnType<typeof startOutcomeWorkerProcess> | undefined;
  try {
    await driver.fixtures.openFeatures(['search', 'search_advanced']);
    const account = await driver.fixtures.person('discoverable');
    const identity = await driver.fixtures.send(null, 'GET', `/v1/accounts?ids=${account.accountId}`);
    expect(identity.status).toBe(200);
    const profile = (identity.body.accounts as { id: string; handle: string; displayName: string | null }[])[0]!;
    expect(profile.id).toBe(account.accountId);
    expect(typeof profile.handle).toBe('string');
    const subjects: string[] = [];
    for (let n = 0; n < 2; n++) {
      const created = await driver.request(
        'editor',
        'POST',
        '/v1/subjects',
        {
          type: 'schema:Person',
          labels: { en: `${marker} English ${n}`, fr: `${marker} Français ${n}` },
        },
        { 'Idempotency-Key': `"${randomUUID()}"` },
      );
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      subjects.push((created.body.subject as { id: string }).id);
    }
    const env = workerTestEnv({
      DATABASE_URL: runtime.databaseUrl,
      KERNEL_ROUTE_KEY: runtime.routeKey,
      KERNEL_SESSION_KEYS: runtime.sessionKeys,
      AUTH_ISSUER: runtime.authIssuer,
      AUTH_AUDIENCE: runtime.authAudience,
      AUTH_JWKS_URL: runtime.authJwksUrl,
      OPENSEARCH_URL: endpoint,
      KERNEL_SEARCH_PREFIX: prefix,
      KERNEL_PORT: '0',
    });
    worker = startOutcomeWorkerProcess(env);
    await worker.ready; // Ordinary default module registration includes native Source work.
    server = await startServer(readConfig(env));
    const origin = server.url;
    const request = {
      representation: 'discovery-v1',
      text: `${marker} | ${profile.handle}`,
      filter: { kind: { in: ['schema:Person', 'account'] } },
      languages: ['fr', 'en'],
      sort: 'id',
      limit: 1,
    };
    async function send(body: Record<string, unknown>) {
      const response = await fetch(new URL('/v1/subjects:search', origin), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { response, body: await response.json() };
    }
    async function page(body: Record<string, unknown>): Promise<DiscoveryPage> {
      return eventually(async () => {
        const result = await send(body);
        if (result.response.status === 200) return result.body as DiscoveryPage;
        expect(result.response.status, JSON.stringify(result.body)).toBe(503);
        expect(result.body.code).toBe('index_not_ready');
        expect(result.response.headers.get('retry-after')).toBeTruthy();
        return undefined; // Readiness is a prerequisite, never a passing alternative.
      });
    }
    const expected = [...subjects, account.accountId].sort();
    await eventually(async () => {
      const current = await page({ ...request, limit: 100 });
      return JSON.stringify(current.hits.map(({ key }) => key.id)) === JSON.stringify(expected) ? true : undefined;
    });
    const active = (await discoveryGenerations(pool, prefix)).find(({ state }) => state === 'active')!;
    const before = await readFreshness(pool, discoveryConsumer(prefix, active.generation));
    const first = await page(request);
    const after = await readFreshness(pool, discoveryConsumer(prefix, active.generation));
    expect(Date.parse(first.as_of)).toBeGreaterThanOrEqual(before.asOf.getTime());
    expect(Date.parse(first.as_of)).toBeLessThanOrEqual(after.asOf.getTime());
    expect(first.hits).toHaveLength(1);
    expect(typeof first.next).toBe('string');
    const all: DiscoveryHit[] = [...first.hits];
    let next = first.next;
    for (let n = 0; next !== null && n < 3; n++) {
      const continued = await page({ ...request, cursor: next });
      all.push(...continued.hits);
      next = continued.next;
    }
    expect(next).toBeNull();
    expect(all.map(({ key }) => key.id)).toEqual(expected);
    expect(new Set(all.map(({ key }) => `${key.owner}:${key.kind}:${key.id}`)).size).toBe(3);
    for (const hit of all) {
      expect(hit.summary.value.id).toBe(hit.key.id);
      if (hit.summary.kind === 'subject') {
        expect(hit.key.owner).toBe('semantic');
        expect(hit.key.kind).toBe('schema:Person');
        expect(hit.summary.value.label?.language).toBe('fr');
      } else {
        expect(hit.key.owner).toBe('accounts');
        expect(hit.key.kind).toBe('account');
        expect(hit.summary.value.handle).toBe(profile.handle);
        expect(hit.summary.value.displayName).toBe(profile.displayName);
      }
    }
    for (const [n, action] of ['hide', 'takedown'].entries()) {
      await driver.grant('editor', [`moderation:${action}`], subjects[n]!);
      const changed = await driver.request(
        'editor',
        'POST',
        `/v1/subjects/${subjects[n]}:${action}`,
        action === 'hide'
          ? { reason: 'Default discovery current disclosure' }
          : {
              notice: { complaint: 'Default discovery current disclosure', received_at: new Date().toISOString() },
            },
        { 'Idempotency-Key': `"${randomUUID()}"` },
      );
      expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    }
    const current = await page({ ...request, limit: 100 });
    expect(current.hits.map(({ key }) => key.id)).toEqual([account.accountId]);
    expect(current.next).toBeNull();
    const routeKey = new Uint8Array(Buffer.from(runtime.routeKey, 'base64url'));
    const registry = await nativeDiscoveryRegistry(pool, routeKey, createRatedSubjectSource(pool, routeKey).source);
    await allocateDiscovery(pool, prefix, registry);
    await eventually(async () =>
      (await discoveryGenerations(pool, prefix)).some(
        ({ generation, state }) => generation > active.generation && state === 'active',
      )
        ? true
        : undefined,
    );
    const switched = await send({ ...request, cursor: first.next });
    expect(switched.response.status, JSON.stringify(switched.body)).toBe(409);
    expect(switched.body.code).toBe('search_restart_required');
  } finally {
    try {
      await server?.stop();
    } finally {
      try {
        await worker?.close();
      } finally {
        try {
          const owned = await search.request<{ indices: { name: string }[] }>(
            'GET',
            `/_resolve/index/${prefix}*`,
            undefined,
            { query: { expand_wildcards: 'all' } },
          );
          for (const { name } of owned.body.indices) {
            if (!name.startsWith(prefix)) throw new Error('Discovery cleanup escaped its owned prefix');
            await search.request('DELETE', `/${name}`);
          }
        } finally {
          await driver.close();
        }
      }
    }
  }
}, 240_000);
