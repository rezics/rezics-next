import { afterEach, beforeEach, expect, test } from 'bun:test';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { createContentMediaDriver, currentMediaScenario } from './media-driver.ts';
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

async function reserve(kind: 'tiny' | 'malformed' = 'tiny') {
  const source = await driver.source(kind);
  const requestId = crypto.randomUUID();
  const containerId = driver.containers.thread.id;
  const result = await driver.reserve('author', {
    requestId,
    containerId,
    purpose: 'post-image',
    type: source.type,
    length: source.bytes.length,
    sha256: source.sha256,
  });
  if (result.outcome !== 'permitted') throw new Error('Native media reservation refused');
  return { mediaId: result.media.id, requestId, containerId, source };
}

async function inventory(actor: ContentCredential) {
  const response = await call(actor, 'GET', '/v1/media');
  expect(response.status).toBe(200);
  expect(response.headers.get(SESSION_HEADER)).toBeString();
  return (await response.json()) as {
    availability: string;
    entries: Array<{
      id: string;
      purpose: string;
      state: string;
      declaredMediaType: string;
      actualMediaType: string | null;
      declaredByteCount: number;
      actualByteCount: number | null;
      createdAt: string;
      container: { id: string; kind: string } | null;
      actions: { read: boolean; remove: boolean; resume: boolean; retry: string };
    }>;
    nextCursor: string | null;
  };
}

test('the private uploader inventory follows reservation, processing, rejection and owner removal', async () => {
  const { system } = currentMediaScenario();
  const media = await reserve();
  const reserved = await inventory(system.actors.author);
  expect(reserved).toMatchObject({
    availability: 'available',
    entries: [
      {
        id: media.mediaId,
        purpose: 'post-image',
        state: 'reserved',
        declaredMediaType: media.source.type,
        actualMediaType: null,
        declaredByteCount: media.source.bytes.length,
        actualByteCount: null,
        container: { id: media.containerId, kind: 'thread' },
        actions: { read: false, remove: true, resume: true, retry: 'same-reservation' },
      },
    ],
    nextCursor: null,
  });

  await driver.placeOriginal(media.mediaId, media.source.bytes);
  expect(
    await driver.complete('worker', {
      requestId: crypto.randomUUID(),
      reservationRequestId: media.requestId,
      containerId: media.containerId,
      byteCount: media.source.bytes.length,
      sha256: media.source.sha256,
    }),
  ).toBe('permitted');
  expect(await driver.process('job', media.mediaId)).toBe('permitted');
  const available = await inventory(system.actors.author);
  expect(available.entries[0]).toMatchObject({
    id: media.mediaId,
    state: 'available',
    actualByteCount: media.source.bytes.length,
    actions: { read: true, remove: true, resume: false, retry: 'none' },
  });
  expect(available.entries[0]).not.toHaveProperty('key');
  expect(available.entries[0]).not.toHaveProperty('reservationRequestId');
  expect(available.entries[0]).not.toHaveProperty('provenance');

  const other = await inventory(system.actors.other);
  expect(other.entries).toEqual([]);
  const anonymous = await call(null, 'GET', '/v1/media');
  expect(anonymous.status).toBe(401);

  const erased = await call(system.actors.author, 'DELETE', `/v1/media/${media.mediaId}`);
  expect(erased.status).toBe(204);
  const afterErase = await inventory(system.actors.author);
  expect(afterErase.entries[0]).toMatchObject({
    id: media.mediaId,
    state: 'erased',
    actions: { read: false, remove: false, resume: false, retry: 'none' },
  });
});

test('rejected media stays rejected and directs the uploader to choose a new file', async () => {
  const { system } = currentMediaScenario();
  const media = await reserve('malformed');
  await driver.placeOriginal(media.mediaId, media.source.bytes);
  expect(
    await driver.complete('worker', {
      requestId: crypto.randomUUID(),
      reservationRequestId: media.requestId,
      containerId: media.containerId,
      byteCount: media.source.bytes.length,
      sha256: media.source.sha256,
    }),
  ).toBe('permitted');
  expect(await driver.process('job', media.mediaId)).toBe('permitted');
  expect((await inventory(system.actors.author)).entries[0]).toMatchObject({
    id: media.mediaId,
    state: 'rejected',
    actions: { read: false, remove: false, resume: false, retry: 'new-file' },
  });
});
