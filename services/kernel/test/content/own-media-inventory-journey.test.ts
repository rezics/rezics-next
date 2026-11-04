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

async function reserve(actor: ContentCredential, containerId: string) {
  const source = await driver.source('tiny');
  const response = await call(actor, 'POST', '/v1/media', {
    containerId,
    purpose: 'post-image',
    mediaType: source.type,
    byteCount: source.bytes.length,
    sha256: source.sha256,
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { media: { id: string } }).media.id;
}

test('the native inventory exposes one uploader page with safe reserved advice and no other uploader locator', async () => {
  const { system, anchors } = currentMediaScenario();
  await driver.grantParent('other', anchors.thread.id);
  const authorId = await reserve(system.actors.author, anchors.thread.id);
  const otherId = await reserve(system.actors.other, anchors.thread.id);

  const authorPage = await call(system.actors.author, 'GET', '/v1/media');
  expect(authorPage.status).toBe(200);
  expect(authorPage.headers.get(SESSION_HEADER)).toBeString();
  expect(authorPage.headers.get('cache-control')).toBe('private, no-store');
  const authorBody = (await authorPage.json()) as {
    entries: Array<Record<string, unknown> & { id: string; actions: Record<string, unknown> }>;
    nextCursor: string | null;
  };
  expect(authorBody.entries.map(({ id }) => id)).toEqual([authorId]);
  expect(authorBody.nextCursor).toBeNull();
  expect(authorBody.entries[0]).toMatchObject({
    purpose: 'post-image',
    state: 'reserved',
    container: { id: anchors.thread.id, kind: 'thread' },
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
  });
  expect(authorBody.entries[0]!.id).not.toBe(otherId);
  for (const privateField of ['key', 'reservationRequestId', 'provenance', 'heldReason', 'body']) {
    expect(authorBody.entries[0]).not.toHaveProperty(privateField);
  }

  const otherPage = await call(system.actors.other, 'GET', '/v1/media');
  expect(otherPage.status).toBe(200);
  const otherBody = (await otherPage.json()) as { entries: Array<{ id: string }> };
  expect(otherBody.entries.map(({ id }) => id)).toEqual([otherId]);

  expect((await call(null, 'GET', '/v1/media')).status).toBe(401);
});
