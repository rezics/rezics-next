import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import { readConfig, startServer } from '../../src/server.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { builtinCollectionId } from '../../src/library/builtin-identity.ts';
import { CANONICAL_SOURCE_WORKFLOW } from '../../src/library/canonical-source-store.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import type { FeedPage } from '../../src/content/feed-contract.ts';
import { createSemanticDriver } from '../semantic/outcome-driver.ts';
import { workerTestEnv } from '../support/worker-env.ts';
import { startOutcomeWorkerProcess } from '../search/support/outcome-rpc.ts';

async function eventually<T>(read: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + 150_000;
  while (Date.now() < end) {
    const result = await read();
    if (result !== undefined) return result;
    await Bun.sleep(100);
  }
  throw new Error('Default feed native sources did not become ready');
}

test('Default mixed feed composes real discovery, current Following and Continue while keeping private activity out of anonymous responses and withholding revoked references', async () => {
  const endpoint = process.env.OPENSEARCH_URL;
  if (!endpoint) throw new Error('OPENSEARCH_URL must name the native test service');
  const driver = await createSemanticDriver(undefined, { isolatedAuth: true });
  const { runtime } = driver.fixtures;
  const prefix = `feed-${randomUUID().replaceAll('-', '').slice(0, 20)}-`;
  const search = createOpenSearch(endpoint);
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let worker: ReturnType<typeof startOutcomeWorkerProcess> | undefined;
  let work: Awaited<ReturnType<typeof createWorkClient>> | undefined;
  try {
    await driver.fixtures.openFeatures(['search', 'search_advanced', 'personal_library', 'reading_progress']);
    const viewer = await driver.fixtures.person('feed-reader');
    const curator = await driver.fixtures.person('feed-curator');
    const key = () => ({ 'Idempotency-Key': `"${randomUUID()}"` });
    const created = await driver.request('editor', 'POST', '/v1/subjects', {
      type: 'schema:Book', labels: { en: '000 Native mixed feed book' },
    }, key());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const book = (created.body.subject as { id: string }).id;
    const metadata = bundledRelease.types['schema:Book']!.library!;
    const active = bundledRelease.libraryProfiles![metadata.profileId]!.entryStateSet!.states.find((state) => state.role === 'active')!.id;
    const entry = await driver.fixtures.send(viewer, 'PUT', `/v1/libraryEntries/${book}`, { state: active }, key());
    expect(entry.status, JSON.stringify(entry.body)).toBe(201);
    const collection = await driver.fixtures.send(curator, 'POST', '/v1/collections', {
      title: 'Native followed collection', visibility: 'public',
    }, key());
    expect(collection.status, JSON.stringify(collection.body)).toBe(201);
    const collectionId = (collection.body.collection as { id: string }).id;
    const follow = await driver.fixtures.send(viewer, 'PUT', `/v1/follows/${collectionId}`, undefined, key());
    expect(follow.status, JSON.stringify(follow.body)).toBe(200);
    const env = workerTestEnv({ DATABASE_URL: runtime.databaseUrl, KERNEL_ROUTE_KEY: runtime.routeKey,
      KERNEL_SESSION_KEYS: runtime.sessionKeys, AUTH_ISSUER: runtime.authIssuer, AUTH_AUDIENCE: runtime.authAudience,
      AUTH_JWKS_URL: runtime.authJwksUrl, OPENSEARCH_URL: endpoint, KERNEL_SEARCH_PREFIX: prefix, KERNEL_PORT: '0' });
    worker = startOutcomeWorkerProcess(env);
    await worker.ready;
    // Use the registered canonical owner's actual work, never an alternate Continue provider.
    work = await createWorkClient(runtime.databaseUrl);
    const canonical = await work.enqueue({ workflowName: CANONICAL_SOURCE_WORKFLOW, queueName: 'maintenance',
      workflowID: `feed-native-source:${randomUUID()}` }, {
      accounts: [viewer.accountId], collectionId: builtinCollectionId(viewer.accountId, { kind: 'everything' }),
    });
    await canonical.getResult();
    server = await startServer(readConfig(env)); // Its createKernel consumes the ordinary Search producer.
    async function page(account: typeof viewer | null, stream = 'home', cursor?: string) {
      const query = new URLSearchParams({ stream, limit: '20' });
      if (cursor) query.set('cursor', cursor);
      const response = await fetch(new URL(`/v1/feedItems?${query}`, server!.url), {
        headers: { ...(account ? { authorization: `Bearer ${account.bearer}` } : {}), 'accept-language': 'en' },
      });
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(200);
      if (account) expect(response.headers.get('cache-control')).toBe('private, no-store');
      return body as FeedPage;
    }
    const anonymous = await eventually(async () => {
      const result = await page(null);
      return result.sources.discovery === 'ready' && result.feedItems.some((item) => item.key.id === book) ? result : undefined;
    });
    expect(anonymous.sources).toEqual({ discovery: 'ready', following: 'not_requested', continue: 'not_requested' });
    expect(anonymous.feedItems.every((item) => item.source === 'discovery' && !('continue' in item))).toBe(true);
    const mixed = await eventually(async () => {
      const result = await page(viewer);
      return result.sources.continue === 'ready' && result.sources.following === 'ready' &&
        result.feedItems.some((item) => item.source === 'continue' && item.key.id === book) &&
        result.feedItems.some((item) => item.source === 'following' && item.key.id === collectionId) &&
        result.feedItems.some((item) => item.source === 'discovery') ? result : undefined;
    });
    expect(mixed.feedItems.filter((item) => item.key.id === book)).toHaveLength(1);
    expect(mixed.feedItems.find((item) => item.source === 'continue')!.continue).toMatchObject({
      subjectId: book, state: active, activeProgressSession: null,
    });
    const unfollow = await driver.fixtures.send(viewer, 'DELETE', `/v1/follows/${collectionId}`, undefined, key());
    expect(unfollow.status).toBe(200);
    // No cleanup/projection wait: the native current negative immediately overrides retained refs.
    expect((await page(viewer, 'following')).feedItems.some((item) => item.key.id === collectionId)).toBe(false);
    await driver.grant('editor', ['moderation:hide'], book);
    const hidden = await driver.request('editor', 'POST', `/v1/subjects/${book}:hide`, { reason: 'Current feed disclosure' }, key());
    expect(hidden.status, JSON.stringify(hidden.body)).toBe(200);
    expect((await page(null)).feedItems.some((item) => item.key.id === book)).toBe(false);
    expect((await page(viewer)).feedItems.some((item) => item.key.id === book)).toBe(false);
    if (mixed.next) expect((await page(viewer, 'home', mixed.next)).feedItems.some((item) => item.key.id === book)).toBe(false);
  } finally {
    try { await server?.stop(); } finally {
      try { await worker?.close(); } finally {
        try { await work?.close(); } finally {
          try {
            const owned = await search.request<{ indices: { name: string }[] }>('GET', `/_resolve/index/${prefix}*`, undefined,
              { query: { expand_wildcards: 'all' } });
            for (const { name } of owned.body.indices) {
              if (!name.startsWith(prefix)) throw new Error('Feed cleanup escaped its owned prefix');
              await search.request('DELETE', `/${name}`);
            }
          } finally { await driver.close(); }
        }
      }
    }
  }
}, 240_000);
