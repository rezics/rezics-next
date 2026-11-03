import { afterEach, beforeEach, expect, test } from 'bun:test';
import { normalizeDocument } from '@rezics/document';
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

async function call(
  actor: ContentCredential | null,
  method: string,
  path: string,
  body?: unknown,
  idempotencyKey = crypto.randomUUID(),
) {
  return currentMediaScenario().system.kernel.handle(
    new Request(`https://content.test${path}`, {
      method,
      headers: {
        ...(actor ? { authorization: `Bearer ${actor.bearer}` } : {}),
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(idempotencyKey) }),
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
  const input = {
    containerId,
    purpose: 'post-image',
    mediaType: source.type,
    byteCount: source.bytes.length,
    sha256: source.sha256,
  };
  const response = await call(currentMediaScenario().system.actors.author, 'POST', '/v1/media', input, requestId);
  expect(response.status).toBe(201);
  const reservation = (await response.json()) as { media: { id: string } };
  const replay = await call(currentMediaScenario().system.actors.author, 'POST', '/v1/media', input, requestId);
  expect(replay.status).toBe(201);
  expect(((await replay.json()) as { media: { id: string } }).media.id).toBe(reservation.media.id);
  return { mediaId: reservation.media.id, requestId, containerId, source };
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
      declaredByteCount: number | null;
      actualByteCount: number | null;
      createdAt: string;
      container: { id: string; kind: string } | null;
      actions: {
        read: { operationId: string; variants: string[]; recheckAtUse: true } | null;
        remove: { operationId: string } | null;
        resume: { operationId: string; mode: string; requiresOriginalFile: true } | null;
        retry: { operationId: string; guidance: string } | null;
      };
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
        actions: {
          read: null,
          remove: { operationId: 'media.erase' },
          resume: {
            operationId: 'media.read_reservation',
            mode: 'same-reservation',
            requiresOriginalFile: true,
          },
          retry: null,
        },
      },
    ],
    nextCursor: null,
  });

  await driver.placeOriginal(media.mediaId, media.source.bytes);
  const completion = {
    requestId: crypto.randomUUID(),
    reservationRequestId: media.requestId,
    containerId: media.containerId,
    byteCount: media.source.bytes.length,
    sha256: media.source.sha256,
  };
  expect(await driver.complete('worker', completion)).toBe('permitted');
  expect(await driver.complete('worker', completion)).toBe('permitted');
  expect((await inventory(system.actors.author)).entries[0]).toMatchObject({
    state: 'uploaded',
    actions: {
      read: null,
      resume: {
        operationId: 'media.read_reservation',
        mode: 'processing',
        requiresOriginalFile: true,
      },
    },
  });
  expect(await driver.process('job', media.mediaId)).toBe('permitted');
  expect(
    await driver.reference('author', {
      requestId: crypto.randomUUID(),
      containerId: media.containerId,
      kind: 'post',
      document: normalizeDocument({
        version: 'rezics-document-v1',
        profile: 'text',
        doc: {
          type: 'doc',
          content: [
            { type: 'paragraph', attrs: { id: 'own-media-post' }, content: [{ type: 'text', text: 'A post' }] },
          ],
        },
      }),
      mediaIds: [media.mediaId],
    }),
  ).toBe('permitted');
  const available = await inventory(system.actors.author);
  expect(available.entries[0]).toMatchObject({
    id: media.mediaId,
    state: 'available',
    actualByteCount: media.source.bytes.length,
    actions: {
      read: { operationId: 'media.authorize_download', recheckAtUse: true },
      remove: { operationId: 'media.erase' },
      resume: null,
      retry: null,
    },
  });
  expect(available.entries[0]!.actions.read?.variants).toContain('original');
  expect(available.entries[0]!.container?.kind).toBe('post');
  expect(available.entries[0]).not.toHaveProperty('key');
  expect(available.entries[0]).not.toHaveProperty('reservationRequestId');
  expect(available.entries[0]).not.toHaveProperty('provenance');
  const selectedRead = await call(
    system.actors.author,
    'GET',
    `/v1/media/${media.mediaId}:authorizeDownload?variant=original`,
  );
  expect(selectedRead.status).toBe(200);
  expect(await selectedRead.json()).toMatchObject({ allowed: true });

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
    actions: { read: null, remove: null, resume: null, retry: null },
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
    actions: {
      read: null,
      remove: { operationId: 'media.erase' },
      resume: null,
      retry: { operationId: 'media.create', guidance: 'choose-new-file' },
    },
  });
});
