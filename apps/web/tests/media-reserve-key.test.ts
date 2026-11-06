import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mediaRequest } from '../src/media/index.ts';

type Reservation = {
  id: string;
  state: string;
  containerId: string;
  mediaType: string;
  byteCount: number;
  sha256: string | null;
  uploaderId: string;
  reservationRequestId: string;
  purpose: string;
};

const accountId = '0192f3a0-6c1e-7b2a-9d4e-0000000000ab';
const realmId = '0192f3a0-6c1e-7b2a-9d4e-0000000000ac';
const token = `access-${randomUUID()}`;
const reservations = new Map<string, Reservation>();
const keys: string[] = [];

const kernel = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const realmRoute = request.method === 'POST' ? /^\/v1\/realms\/([^/]+)\/media$/.exec(url.pathname) : null;
    if (!realmRoute) return Response.json({ code: 'not_found' }, { status: 404 });
    if (request.headers.get('authorization') !== `Bearer ${token}`)
      return Response.json({ code: 'authentication_required' }, { status: 401 });
    const rawKey = request.headers.get('idempotency-key');
    if (!rawKey) return Response.json({ code: 'invalid_request' }, { status: 400 });
    const parsed: unknown = JSON.parse(rawKey);
    if (typeof parsed !== 'string') return Response.json({ code: 'invalid_request' }, { status: 400 });
    keys.push(parsed);
    const replay = [...reservations.values()].find(
      (media) => media.reservationRequestId === parsed && media.uploaderId === accountId,
    );
    if (replay) return Response.json({ media: replay }, { status: 201 });
    const body = (await request.json()) as { purpose: string; mediaType: string; byteCount: number };
    const media: Reservation = {
      id: randomUUID(),
      state: 'reserved',
      containerId: realmRoute[1]!,
      mediaType: body.mediaType,
      byteCount: body.byteCount,
      sha256: null,
      uploaderId: accountId,
      reservationRequestId: parsed,
      purpose: body.purpose,
    };
    reservations.set(media.id, media);
    return Response.json({ media }, { status: 201 });
  },
});

const env = { KERNEL_ORIGIN: kernel.url.origin, MEDIA: {} as R2Bucket };
const posted = JSON.stringify({ realmId, purpose: 'realm-banner', mediaType: 'image/png', byteCount: 4 });

function reserveRequest(key: string, extraHeaders: HeadersInit = {}) {
  return new Request('http://web.test/media', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': JSON.stringify(key),
      ...extraHeaders,
    },
    body: posted,
  });
}

afterAll(() => {
  kernel.stop(true);
});

test('a Realm appearance reservation forwards the caller key so a repeated command finds the same reservation', async () => {
  const key = randomUUID();
  const first = await mediaRequest(reserveRequest(key), env);
  expect(first.status).toBe(201);
  expect(first.headers.get('cache-control')).toBe('private, no-store');
  const reserved = (await first.json()) as { media: { id: string; containerId: string } };
  expect(reserved.media.containerId).toBe(realmId);
  const replay = await mediaRequest(reserveRequest(key), env);
  expect(replay.status).toBe(201);
  expect(await replay.json()).toEqual(reserved);
  expect(reservations.size).toBe(1);
  expect([...reservations.values()][0]).toMatchObject({
    id: reserved.media.id,
    reservationRequestId: key,
    purpose: 'realm-banner',
    uploaderId: accountId,
  });
  expect(keys).toEqual([key, key]);
});

test('a malformed reservation key is refused before a second Realm object is created', async () => {
  const before = reservations.size;
  const response = await mediaRequest(reserveRequest('unused', { 'idempotency-key': 'not-a-structured-key' }), env);
  expect(response.status).toBe(400);
  expect(reservations.size).toBe(before);
});
