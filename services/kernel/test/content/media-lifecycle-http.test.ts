/**
 * ---
 * acceptance:
 *   - after the 24-hour collection the API answers each persona from the remaining objects only
 *   - every produced ladder width and format is downloadable per persona and refused to a suspended account
 * ---
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { routeOf } from '../../src/route/route.ts';
import { createContentMediaDriver, currentMediaScenario } from './media-driver.ts';
import { digest } from './support/media-fixtures.ts';
import type { ContentCredential } from './support/system.ts';

let driver: Awaited<ReturnType<typeof createContentMediaDriver>>;
beforeEach(async () => {
  driver = await createContentMediaDriver();
});
afterEach(async () => {
  await driver?.close();
});

async function call(actor: ContentCredential | null, method: string, path: string, body?: unknown) {
  return currentMediaScenario().system.kernel.handle(
    new Request(`https://content.test${path}`, {
      method,
      headers: {
        ...(actor ? { authorization: `Bearer ${actor.bearer}` } : {}),
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(crypto.randomUUID()) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function available(kind: 'landscape' | 'tiny' = 'tiny') {
  const source = await driver.source(kind);
  const requestId = crypto.randomUUID();
  const containerId = driver.containers.thread.id;
  const reserved = await driver.reserve('author', {
    requestId,
    containerId,
    purpose: 'post-image',
    type: source.type,
    length: source.bytes.length,
    sha256: source.sha256,
  });
  if (reserved.outcome !== 'permitted') throw new Error('Native media reservation refused');
  await driver.placeOriginal(reserved.media.id, source.bytes);
  expect(
    await driver.complete('worker', {
      requestId: crypto.randomUUID(),
      reservationRequestId: requestId,
      containerId,
      byteCount: source.bytes.length,
      sha256: source.sha256,
    }),
  ).toBe('permitted');
  expect(await driver.process('job', reserved.media.id)).toBe('permitted');
  const stored = (await driver.inspect()).media.find(({ id }) => id === reserved.media.id)!;
  expect(stored.state).toBe('available');
  expect(stored.claimedAt).toBeNull();
  return { ...stored, source };
}

async function claim(mediaId: string) {
  const response = await call(
    currentMediaScenario().system.actors.author,
    'POST',
    `/v1/threads/${driver.containers.thread.id}/posts`,
    {
      body: fromPlainText('A native claimed image'),
      licence: 'MIT',
      mediaIds: [mediaId],
    },
  );
  expect(response.status).toBe(201);
  const post = (await response.json()).post;
  expect(post.mediaIds).toEqual([mediaId]);
  return post;
}

async function denied(response: Response, code = 'not_found', command = false) {
  expect(response.status).toBe(code === 'not_found' ? 404 : 401);
  expect(response.headers.get(SESSION_HEADER)).toBeNull();
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  const { request_id, ...problem } = await response.json();
  expect(request_id).toBeString();
  expect(problem).toEqual({
    type: `https://rezics.com/problems/${code}`,
    title:
      code === 'not_found'
        ? 'Not Found'
        : code === 'invalid_credentials'
          ? 'Invalid Credentials'
          : 'Authentication Required',
    status: code === 'not_found' ? 404 : 401,
    code,
    retryable: false,
    effect_status: command ? 'not_applied' : 'not_applicable',
  });
  if (code === 'invalid_credentials') expect(response.headers.get('www-authenticate')).toContain('invalid_token');
}

async function variants(id: string) {
  return (
    await currentMediaScenario().system.database.pool.query<{
      key: string;
      format: 'avif' | 'webp';
      width: number;
      height: number;
      sha256: string;
      media_type: string;
      byte_count: string;
    }>(
      `SELECT key,format,width,height,sha256,media_type,byte_count::text
     FROM content.media_variant WHERE route=$1 AND media_id=$2 ORDER BY format,width`,
      [routeOf(id), id],
    )
  ).rows;
}

test('every produced ladder width and format is downloadable per persona and refused to a suspended account', async () => {
  const { system } = currentMediaScenario();
  const media = await available('landscape');
  expect(media.source.orientedWidth).toBeGreaterThan(2560);
  await claim(media.id);
  const stored = await variants(media.id);
  expect(stored.map(({ format, width }) => `${format}-${width}`)).toEqual(
    ['avif', 'webp'].flatMap((format) => [320, 640, 960, 1280, 1920, 2560].map((width) => `${format}-${width}`)),
  );
  const originalStorage = (await driver.inspect()).storage;
  const native = await driver.derivatives(media.id);
  expect(native).toHaveLength(12);
  // Run the site's actual media route against the native kernel and stored Sharp bytes.
  // The bucket adapter only transports bytes; it has no media state or authorization logic.
  const { mediaRequest } = (await import(new URL('../../../../apps/web/src/media/index.ts', import.meta.url).href)) as {
    mediaRequest(request: Request, env: { KERNEL_ORIGIN: string; MEDIA: unknown }): Promise<Response>;
  };
  const kernel = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => system.kernel.handle(request) });
  const reads: string[] = [];
  const bucket = {
    async head(key: string) {
      reads.push(key);
      const object = (await driver.derivatives(media.id)).find((object) => object.key === key);
      return object ? { size: object.bytes.byteLength } : null;
    },
    async get(key: string) {
      reads.push(key);
      const object = (await driver.derivatives(media.id)).find((object) => object.key === key);
      return object
        ? { size: object.bytes.byteLength, body: new Blob([Uint8Array.from(object.bytes)]).stream() }
        : null;
    },
  };
  try {
    for (const variant of stored) {
      const slot = `${variant.format}-${variant.width}`;
      const object = native.find(({ key }) => key === variant.key)!;
      expect(digest(object.bytes)).toBe(variant.sha256);
      const decoded = await driver.decode(object.bytes);
      expect(decoded).toMatchObject({
        format: variant.format,
        width: variant.width,
        height: variant.height,
        metadata: [],
      });
      for (const actor of [null, system.actors.author, system.actors.moderator]) {
        const response = await call(actor, 'GET', `/v1/media/${media.id}:authorizeDownload?variant=${slot}`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          allowed: true,
          key: variant.key,
          sha256: variant.sha256,
          mediaType: variant.media_type,
          byteCount: Number(variant.byte_count),
          publicCache: false,
          cacheControl: 'private, no-cache',
        });
        const delivered = await mediaRequest(
          new Request(`https://site.test/media/${media.id}/${slot}`, {
            headers: actor ? { authorization: `Bearer ${actor.bearer}` } : {},
          }),
          { KERNEL_ORIGIN: kernel.url.origin, MEDIA: bucket },
        );
        expect(delivered.status).toBe(200);
        expect(delivered.headers.get('content-type')).toBe(variant.media_type);
        expect(delivered.headers.get('cache-control')).toBe('private, no-cache');
        expect(delivered.headers.get('etag')).toBe(JSON.stringify(variant.sha256));
        const bytes = new Uint8Array(await delivered.arrayBuffer());
        expect(bytes).toEqual(Uint8Array.from(object.bytes));
        expect(bytes.byteLength).toBe(Number(variant.byte_count));
        expect(digest(bytes)).toBe(variant.sha256);
      }
      const before = await driver.inspect();
      await denied(
        await call(system.actors.suspended, 'GET', `/v1/media/${media.id}:authorizeDownload?variant=${slot}`),
        'invalid_credentials',
      );
      const readCount = reads.length;
      const refused = await mediaRequest(
        new Request(`https://site.test/media/${media.id}/${slot}`, {
          headers: {
            authorization: `Bearer ${system.actors.suspended.bearer}`,
            'if-none-match': JSON.stringify(variant.sha256),
          },
        }),
        { KERNEL_ORIGIN: kernel.url.origin, MEDIA: bucket },
      );
      expect(refused.status).toBe(404);
      expect(refused.headers.get('etag')).toBeNull();
      expect(await refused.json()).toEqual({
        type: 'https://rezics.com/problems/not_found',
        title: 'Not Found',
        status: 404,
        code: 'not_found',
      });
      expect(reads).toHaveLength(readCount);
      expect(await driver.inspect()).toEqual(before);
    }
    for (const actor of [null, system.actors.moderator]) {
      await denied(await call(actor, 'GET', `/v1/media/${media.id}:authorizeDownload?variant=original`));
      const before = reads.length;
      const response = await mediaRequest(
        new Request(`https://site.test/media/${media.id}/original`, {
          headers: actor ? { authorization: `Bearer ${actor.bearer}` } : {},
        }),
        { KERNEL_ORIGIN: kernel.url.origin, MEDIA: bucket },
      );
      expect(response.status).toBe(404);
      expect(reads).toHaveLength(before);
    }
    expect(reads).not.toContain(media.key);
    expect((await driver.inspect()).storage).toEqual(originalStorage);
  } finally {
    await kernel.stop(true);
  }
});

test('after the 24-hour collection the API answers each persona from the remaining objects only', async () => {
  const { system } = currentMediaScenario();
  const cutoff = await available();
  const young = await available();
  const claimed = await available();
  const post = await claim(claimed.id);
  const at = Date.now();
  const boundary = new Date(at - 24 * 60 * 60 * 1000).toISOString();
  await driver.setCreatedAt(cutoff.id, boundary);
  await driver.setCreatedAt(young.id, new Date(at - 24 * 60 * 60 * 1000 + 1000).toISOString());
  await driver.setCreatedAt(claimed.id, boundary);
  await driver.setTime(new Date(at).toISOString());
  const before = await driver.inspect();
  const beforeRows = await system.database.pool.query(
    'SELECT * FROM content.media WHERE route=$1 AND media_id=ANY($2::uuid[]) ORDER BY media_id',
    [driver.containers.thread.route, [cutoff.id, young.id, claimed.id]],
  );
  expect(beforeRows.rows.find((row) => row.media_id === cutoff.id)).toMatchObject({
    state: 'available',
    claimed_at: null,
    collection_pending: false,
  });
  expect(beforeRows.rows.find((row) => row.media_id === young.id)).toMatchObject({
    state: 'available',
    claimed_at: null,
  });
  expect(beforeRows.rows.find((row) => row.media_id === claimed.id)).toMatchObject({
    state: 'available',
    claimed_item_id: post.id,
  });
  expect(await driver.collect('job', cutoff.partition)).toMatchObject({ outcome: 'permitted' });
  const after = await driver.inspect();
  expect(after.media.map(({ id }) => id).sort()).toEqual([young.id, claimed.id].sort());
  expect(after.storage).toEqual(before.storage.filter(({ key }) => !key.startsWith(`m/${cutoff.id}/`)));
  expect(before.storage.filter(({ key }) => key.startsWith(`m/${cutoff.id}/`))).toHaveLength(3);
  const afterRows = await system.database.pool.query(
    'SELECT * FROM content.media WHERE route=$1 AND media_id=ANY($2::uuid[]) ORDER BY media_id',
    [driver.containers.thread.route, [cutoff.id, young.id, claimed.id]],
  );
  expect(afterRows.rows).toEqual(beforeRows.rows.filter((row) => row.media_id !== cutoff.id));
  expect(await variants(cutoff.id)).toEqual([]);
  expect(await driver.derivatives(cutoff.id)).toEqual([]);
  const events = await system.database.pool.query<{ type: string; subject: string }>(
    `SELECT type,subject FROM core.outbox WHERE subject=$1 AND type IN
     ('com.rezics.content.media.collection-pending.v1','com.rezics.content.media.collected.v1') ORDER BY type`,
    [cutoff.id],
  );
  expect(events.rows).toEqual([
    { type: 'com.rezics.content.media.collected.v1', subject: cutoff.id },
    { type: 'com.rezics.content.media.collection-pending.v1', subject: cutoff.id },
  ]);
  expect(await driver.collect('job', cutoff.partition)).toMatchObject({ outcome: 'permitted' });
  expect(await driver.inspect()).toEqual(after);
  for (const actor of [null, system.actors.author, system.actors.moderator, system.actors.suspended]) {
    const invalid = actor === system.actors.suspended;
    for (const media of [cutoff, young, claimed]) {
      const response = await call(actor, 'GET', `/v1/media/${media.id}`);
      if (!invalid && actor === system.actors.author && media.id !== cutoff.id) {
        expect(response.status).toBe(200);
        expect((await response.json()).media).toMatchObject({ id: media.id, state: 'available', key: media.key });
      } else
        await denied(
          response,
          invalid ? 'invalid_credentials' : actor === null ? 'authentication_required' : 'not_found',
        );
      const download = await call(actor, 'GET', `/v1/media/${media.id}:authorizeDownload?variant=webp-127`);
      if (!invalid && media.id === claimed.id) {
        expect(download.status).toBe(200);
        const decision = await download.json();
        const stored = (await driver.derivatives(media.id)).find(({ key }) => key === decision.key)!;
        expect(digest(stored.bytes)).toBe(decision.sha256);
      } else await denied(download, invalid ? 'invalid_credentials' : 'not_found');
    }
  }
  // The remaining young object's actual source and derivatives are still intact and claimable.
  expect(await driver.download('author', young.id, 'original')).toMatchObject({
    outcome: 'permitted',
    sha256: young.source.sha256,
  });
  for (const media of [young, claimed]) {
    const outputs = await driver.derivatives(media.id);
    for (const variant of await variants(media.id))
      expect(digest(outputs.find(({ key }) => key === variant.key)!.bytes)).toBe(variant.sha256);
  }
  const stateBeforeRefusedClaim = await driver.inspect();
  const lost = await call(system.actors.author, 'POST', `/v1/threads/${cutoff.containerId}/posts`, {
    body: fromPlainText('Collected media cannot return'),
    licence: 'MIT',
    mediaIds: [cutoff.id],
  });
  expect(lost.status).toBe(409);
  expect((await lost.json()).code).toBe('media_unavailable');
  expect(await driver.inspect()).toEqual(stateBeforeRefusedClaim);
  await claim(young.id);
  for (const actor of [null, system.actors.author, system.actors.moderator])
    expect((await call(actor, 'GET', `/v1/media/${young.id}:authorizeDownload?variant=webp-127`)).status).toBe(200);
});
