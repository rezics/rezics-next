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
import { createKernel, type KernelDependencies } from '../../src/http/kernel.ts';
import { ProblemError } from '../../src/http/problem.ts';
import { createFeedActivityStore } from '../../src/content/feed-activity.ts';
import { decodeFeedCursor, feedBinding, fingerprint } from '../../src/content/feed-cursor.ts';

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
    const created = await driver.request(
      'editor',
      'POST',
      '/v1/subjects',
      {
        type: 'schema:Book',
        labels: { en: '000 Native mixed feed book' },
      },
      key(),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const book = (created.body.subject as { id: string }).id;
    const metadata = bundledRelease.types['schema:Book']!.library!;
    const active = bundledRelease.libraryProfiles![metadata.profileId]!.entryStateSet!.states.find(
      (state) => state.role === 'active',
    )!.id;
    const entry = await driver.fixtures.send(viewer, 'PUT', `/v1/libraryEntries/${book}`, { state: active }, key());
    expect(entry.status, JSON.stringify(entry.body)).toBe(201);
    const collection = await driver.fixtures.send(
      curator,
      'POST',
      '/v1/collections',
      {
        title: 'Native followed collection',
        visibility: 'public',
      },
      key(),
    );
    expect(collection.status, JSON.stringify(collection.body)).toBe(201);
    const collectionId = (collection.body.collection as { id: string }).id;
    const follow = await driver.fixtures.send(viewer, 'PUT', `/v1/follows/${collectionId}`, undefined, key());
    expect(follow.status, JSON.stringify(follow.body)).toBe(200);
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
    await worker.ready;
    // Use the registered canonical owner's actual work, never an alternate Continue provider.
    work = await createWorkClient(runtime.databaseUrl);
    const canonical = await work.enqueue(
      {
        workflowName: CANONICAL_SOURCE_WORKFLOW,
        queueName: 'maintenance',
        workflowID: `feed-native-source:${randomUUID()}`,
      },
      {
        accounts: [viewer.accountId],
        collectionId: builtinCollectionId(viewer.accountId, { kind: 'everything' }),
      },
    );
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
      return result.sources.discovery === 'ready' && result.feedItems.some((item) => item.key.id === book)
        ? result
        : undefined;
    });
    expect(anonymous.sources).toEqual({ discovery: 'ready', following: 'not_requested', continue: 'not_requested' });
    expect(anonymous.feedItems.every((item) => item.source === 'discovery' && !('continue' in item))).toBe(true);
    const mixed = await eventually(async () => {
      const result = await page(viewer);
      return result.sources.continue === 'ready' &&
        result.sources.following === 'ready' &&
        result.feedItems.some((item) => item.source === 'continue' && item.key.id === book) &&
        result.feedItems.some((item) => item.source === 'following' && item.key.id === collectionId) &&
        result.feedItems.some((item) => item.source === 'discovery')
        ? result
        : undefined;
    });
    expect(mixed.feedItems.filter((item) => item.key.id === book)).toHaveLength(1);
    expect(mixed.feedItems.slice(0, 3).map((item) => item.source)).toEqual(['continue', 'following', 'discovery']);
    expect(mixed.feedItems.find((item) => item.source === 'continue')!.continue).toMatchObject({
      subjectId: book,
      state: active,
      activeProgressSession: null,
    });
    const unfollow = await driver.fixtures.send(viewer, 'DELETE', `/v1/follows/${collectionId}`, undefined, key());
    expect(unfollow.status).toBe(200);
    // No cleanup/projection wait: the native current negative immediately overrides retained refs.
    expect((await page(viewer, 'following')).feedItems.some((item) => item.key.id === collectionId)).toBe(false);
    await driver.grant('editor', ['moderation:hide'], book);
    const hidden = await driver.request(
      'editor',
      'POST',
      `/v1/subjects/${book}:hide`,
      { reason: 'Current feed disclosure' },
      key(),
    );
    expect(hidden.status, JSON.stringify(hidden.body)).toBe(200);
    expect((await page(null)).feedItems.some((item) => item.key.id === book)).toBe(false);
    expect((await page(viewer)).feedItems.some((item) => item.key.id === book)).toBe(false);
    if (mixed.next)
      expect((await page(viewer, 'home', mixed.next)).feedItems.some((item) => item.key.id === book)).toBe(false);
  } finally {
    try {
      await server?.stop();
    } finally {
      try {
        await worker?.close();
      } finally {
        try {
          await work?.close();
        } finally {
          try {
            const owned = await search.request<{ indices: { name: string }[] }>(
              'GET',
              `/_resolve/index/${prefix}*`,
              undefined,
              { query: { expand_wildcards: 'all' } },
            );
            for (const { name } of owned.body.indices) {
              if (!name.startsWith(prefix)) throw new Error('Feed cleanup escaped its owned prefix');
              await search.request('DELETE', `/${name}`);
            }
          } finally {
            await driver.close();
          }
        }
      }
    }
  }
}, 240_000);

test('Default feed route applies the selected native kind across the mixed stream and binds its examined source frontier to that selection', async () => {
  const endpoint = process.env.OPENSEARCH_URL;
  if (!endpoint) throw new Error('OPENSEARCH_URL must name the native test service');
  let mounted!: KernelDependencies;
  const driver = await createSemanticDriver(
    (deps) => {
      mounted = deps;
      return createKernel(deps);
    },
    { isolatedAuth: true },
  );
  const { runtime } = driver.fixtures;
  const prefix = `feed-kind-${randomUUID().replaceAll('-', '').slice(0, 20)}-`;
  const search = createOpenSearch(endpoint);
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let worker: ReturnType<typeof startOutcomeWorkerProcess> | undefined;
  let work: Awaited<ReturnType<typeof createWorkClient>> | undefined;
  try {
    await driver.fixtures.openFeatures(['search', 'search_advanced', 'personal_library', 'reading_progress']);
    const viewer = await driver.fixtures.person('kind-reader');
    const curator = await driver.fixtures.person('kind-curator');
    const key = () => ({ 'Idempotency-Key': `"${randomUUID()}"` });
    const subjects: Record<string, string> = {};
    for (const type of ['schema:Book', 'schema:Movie']) {
      const created = await driver.request(
        'editor',
        'POST',
        '/v1/subjects',
        {
          type,
          labels: { en: `000 Native selected ${type}` },
        },
        key(),
      );
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const id = (created.body.subject as { id: string }).id;
      subjects[type] = id;
      const metadata = bundledRelease.types[type]!.library!;
      const active = bundledRelease.libraryProfiles![metadata.profileId]!.entryStateSet!.states.find(
        (state) => state.role === 'active',
      )!.id;
      const entry = await driver.fixtures.send(viewer, 'PUT', `/v1/libraryEntries/${id}`, { state: active }, key());
      expect(entry.status, JSON.stringify(entry.body)).toBe(201);
    }
    const book = subjects['schema:Book']!;
    const movie = subjects['schema:Movie']!;
    const created = await driver.fixtures.send(
      curator,
      'POST',
      '/v1/collections',
      {
        title: 'Selected-kind followed collection',
        visibility: 'public',
      },
      key(),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const collection = (created.body.collection as { id: string }).id;
    expect((await driver.fixtures.send(viewer, 'PUT', `/v1/follows/${collection}`, undefined, key())).status).toBe(200);
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
    await worker.ready;
    work = await createWorkClient(runtime.databaseUrl);
    await (
      await work.enqueue(
        {
          workflowName: CANONICAL_SOURCE_WORKFLOW,
          queueName: 'maintenance',
          workflowID: `feed-kind-native-source:${randomUUID()}`,
        },
        {
          accounts: [viewer.accountId],
          collectionId: builtinCollectionId(viewer.accountId, { kind: 'everything' }),
        },
      )
    ).getResult();
    server = await startServer(readConfig(env));
    const headers = { authorization: `Bearer ${viewer.bearer}`, 'accept-language': 'en' };
    async function response(query: URLSearchParams, personal = true) {
      const result = await fetch(new URL(`/v1/feedItems?${query}`, server!.url), {
        headers: personal ? headers : { 'accept-language': 'en' },
      });
      return { status: result.status, headers: result.headers, body: await result.json() };
    }
    async function page(kind?: string, stream = 'home', limit = 20, cursor?: string, personal = true) {
      const query = new URLSearchParams({ stream, limit: String(limit) });
      if (kind !== undefined) query.set('kind', kind);
      if (cursor) query.set('cursor', cursor);
      const result = await response(query, personal);
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      if (personal) expect(result.headers.get('cache-control')).toBe('private, no-store');
      return result.body as FeedPage;
    }
    // Establish the original mixed composition with all three native lanes before selecting.
    const mixed = await eventually(async () => {
      const result = await page();
      return result.feedItems.some((item) => item.source === 'continue' && item.key.id === movie) &&
        result.feedItems.some((item) => item.source === 'following' && item.key.id === collection) &&
        result.feedItems.some((item) => item.source === 'discovery')
        ? result
        : undefined;
    });
    expect(mixed.sources).toEqual({ discovery: 'ready', following: 'ready', continue: 'ready' });
    const selected = await eventually(async () => {
      const result = await page('schema:Book');
      return result.sources.discovery === 'ready' && result.feedItems.some((item) => item.key.id === book)
        ? result
        : undefined;
    });
    expect(selected.feedItems.length).toBeGreaterThan(0);
    expect(selected.feedItems.every((item) => item.key.kind === 'schema:Book')).toBe(true);
    expect(selected.feedItems.find((item) => item.key.id === book)?.source).toBe('continue');
    const anonymous = await eventually(async () => {
      const result = await page('schema:Book', 'home', 20, undefined, false);
      return result.sources.discovery === 'ready' && result.feedItems.some((item) => item.key.id === book)
        ? result
        : undefined;
    });
    expect(anonymous.feedItems.every((item) => item.source === 'discovery' && item.key.kind === 'schema:Book')).toBe(
      true,
    );
    expect(anonymous.sources).toEqual({ discovery: 'ready', following: 'not_requested', continue: 'not_requested' });

    // Book sorts before Movie. With P=1, filtering an all-kind discovery page after
    // enumeration would return an empty page instead of this native selected hit.
    const movieDiscovery = await eventually(async () => {
      const result = await page('schema:Movie', 'home', 1, undefined, false);
      return result.sources.discovery === 'ready' ? result : undefined;
    });
    expect(movieDiscovery.feedItems).toHaveLength(1);
    expect(movieDiscovery.feedItems[0]).toMatchObject({
      source: 'discovery',
      key: { id: movie, kind: 'schema:Movie' },
    });

    const actor = await driver.fixtures.authenticatedAccount(viewer);
    const tokens = mounted.tokens!;
    const position = (cursor: string, stream: string, kind?: string) =>
      decodeFeedCursor(tokens, feedBinding(actor, stream, 1, ['en'], kind), cursor, new Date());
    const nativeContinue = await fetch(new URL('/v1/libraryContinue?limit=6&view=FULL', server.url), { headers });
    expect(nativeContinue.status).toBe(200);
    const continued = (await nativeContinue.json()) as { subjects: { subjectId: string; lastActivityAt: string }[] };
    expect(continued.subjects[0]!.subjectId).toBe(movie);
    // P=1: reject the first Continue row, consume the Following row, then emit Discovery.
    const first = await eventually(async () => {
      const result = await page('schema:Book', 'home', 1);
      return result.sources.discovery === 'ready' && result.feedItems.length === 1 ? result : undefined;
    });
    expect(first.feedItems[0]!.source).toBe('discovery');
    expect(first.next).toBeString();
    const frontier = await position(first.next!, 'home', 'schema:Book');
    expect(frontier.resume).toEqual({
      fingerprint: fingerprint(continued.subjects.map((row) => [row.subjectId, row.lastActivityAt])),
      after: fingerprint([movie, continued.subjects[0]!.lastActivityAt]),
    });
    const second = await page('schema:Book', 'home', 1, first.next!);
    expect(second.feedItems[0]).toMatchObject({ source: 'continue', key: { id: book, kind: 'schema:Book' } });

    const raw = await createFeedActivityStore({ pool: driver.fixtures.pool, tokens }).pageFollowingActivity(
      viewer.accountId,
      { limit: 1 },
      Date.now() + 30_000,
    );
    expect(raw.activities[0]!.object.id).toBe(collection);
    const empty = await page('schema:Book', 'following', 1);
    expect(empty.feedItems).toEqual([]);
    expect(empty.sources.following).toBe('ready');
    expect(empty.next).toBeString();
    // Rejected rows advance the native source cursor, even when the output is empty.
    const examined = await position(empty.next!, 'following', 'schema:Book');
    const nativeAfter = await createFeedActivityStore({ pool: driver.fixtures.pool, tokens }).pageFollowingActivity(
      viewer.accountId,
      { limit: 1, cursor: examined.following as string },
      Date.now() + 30_000,
    );
    expect(nativeAfter.activities.some((activity) => activity.id === raw.activities[0]!.id)).toBe(false);
    expect((await page('collection', 'following', 1)).feedItems[0]!.key.id).toBe(collection);
    for (const kind of [undefined, 'schema:Movie']) {
      const query = new URLSearchParams({ stream: 'home', limit: '1', cursor: first.next! });
      if (kind !== undefined) query.set('kind', kind);
      const refused = await response(query);
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('invalid_cursor');
    }
    const all = await page(undefined, 'following', 1);
    const changed = await response(
      new URLSearchParams({ stream: 'following', limit: '1', cursor: all.next!, kind: 'collection' }),
    );
    expect(changed.status).toBe(400);
    expect(changed.body.code).toBe('invalid_cursor');
    for (const kind of ['', 'x'.repeat(257), '\u0000', 'é'.repeat(129)]) {
      const invalid = await response(new URLSearchParams({ kind }));
      expect(invalid.status).toBe(400);
      expect(invalid.body.code).toBe('invalid_request');
      expect(invalid.headers.get('content-type')).toContain('application/problem+json');
    }
    const repeated = await response(
      new URLSearchParams([
        ['kind', 'schema:Book'],
        ['kind', 'schema:Movie'],
      ]),
    );
    expect(repeated.status).toBe(400);
    expect(repeated.body.code).toBe('invalid_request');
    // A syntactically valid but unregistered kind reaches the real native admission boundary.
    const unsupported = await response(new URLSearchParams({ kind: 'unregistered-kind' }));
    expect(unsupported.status).toBe(422);
    expect(unsupported.body.code).toBe('unsupported_query');
    expect(unsupported.headers.get('content-type')).toContain('application/problem+json');
    // Inject only a dependency fault at the existing ABI; the mounted default reader still
    // composes real Following/Continue instead of broadening or returning a successful empty lane.
    const degraded = createKernel({
      ...mounted,
      workClient: work,
      discovery: async () => {
        throw new ProblemError('dependency_unavailable');
      },
    });
    const failure = await degraded.handle(
      new Request('http://kernel.test/v1/feedItems?kind=schema%3ABook', { headers }),
    );
    expect(failure.status).toBe(200);
    const partial = (await failure.json()) as FeedPage;
    expect(partial.sources).toEqual({ discovery: 'unavailable', following: 'ready', continue: 'ready' });
    expect(partial.feedItems.some((item) => item.source === 'continue' && item.key.id === book)).toBe(true);
    expect(partial.feedItems.every((item) => item.key.kind === 'schema:Book')).toBe(true);
    const anonymousFailure = await degraded.handle(new Request('http://kernel.test/v1/feedItems'));
    expect(anonymousFailure.status).toBe(200);
    expect(await anonymousFailure.json()).toMatchObject({
      feedItems: [],
      next: null,
      sources: { discovery: 'unavailable', following: 'not_requested', continue: 'not_requested' },
    });
    // Metadata cannot stand in for the missing native candidate-membership producers.
    // All three selections remain conjunctive, including under the Following-only mode.
    for (const stream of ['home', 'following']) {
      const unavailable = await response(
        new URLSearchParams({
          stream,
          kind: 'schema:Book',
          spaceId: book,
          ratingQuestionId: movie,
        }),
      );
      expect(unavailable.status).toBe(503);
      expect(unavailable.body.code).toBe('dependency_unavailable');
    }
    for (const name of ['spaceId', 'ratingQuestionId']) {
      expect((await response(new URLSearchParams({ [name]: 'invalid' }))).status).toBe(400);
      expect(
        (
          await response(
            new URLSearchParams([
              [name, book],
              [name, movie],
            ]),
          )
        ).status,
      ).toBe(400);
      const rebound = await response(
        new URLSearchParams({ stream: 'home', limit: '1', kind: 'schema:Book', cursor: first.next!, [name]: book }),
      );
      expect(rebound.status).toBe(400);
      expect(rebound.body.code).toBe('invalid_cursor');
    }
  } finally {
    try {
      await server?.stop();
    } finally {
      try {
        await worker?.close();
      } finally {
        try {
          await work?.close();
        } finally {
          try {
            const owned = await search.request<{ indices: { name: string }[] }>(
              'GET',
              `/_resolve/index/${prefix}*`,
              undefined,
              { query: { expand_wildcards: 'all' } },
            );
            for (const { name } of owned.body.indices) {
              if (!name.startsWith(prefix)) throw new Error('Feed cleanup escaped its owned prefix');
              await search.request('DELETE', `/${name}`);
            }
          } finally {
            await driver.close();
          }
        }
      }
    }
  }
}, 240_000);
