import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createKernelClient } from '@rezics/client';
import type { DocumentSnapshot } from '@rezics/document';
import { mediaRequest } from '../src/media/index.ts';
import { newCsrfToken } from '../src/session/csrf.ts';
import type { SessionEnv } from '../src/session/client.ts';
import { prepareSession } from '../src/session/request.ts';
import { startThreadRequest } from '../src/threads/post-writes.ts';

// Workers-only classes, standing in with the behaviour Cloudflare documents for them.
class FixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(length: number) {
    let seen = 0;
    super({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > length) throw new TypeError('the stream is longer than its declared length');
        controller.enqueue(chunk);
      },
      flush() {
        if (seen !== length) throw new TypeError('the stream is shorter than its declared length');
      },
    });
  }
}
class DigestStream extends WritableStream<Uint8Array> {
  readonly digest: Promise<ArrayBuffer>;
  constructor(algorithm: string) {
    const hash = createHash(algorithm.replace('-', '').toLowerCase());
    let resolve!: (value: ArrayBuffer) => void;
    const digest = new Promise<ArrayBuffer>((done) => (resolve = done));
    super({
      write(chunk) {
        hash.update(chunk);
      },
      close() {
        const bytes = hash.digest();
        resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      },
    });
    this.digest = digest;
  }
}
if (!('FixedLengthStream' in globalThis))
  Object.defineProperty(globalThis, 'FixedLengthStream', { value: FixedLengthStream, configurable: true });
if (!('DigestStream' in crypto))
  Object.defineProperty(crypto, 'DigestStream', { value: DigestStream, configurable: true });

const contentId = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const boardId = contentId(1);
const threadId = contentId(3);
const idempotencyKey = '550e8400-e29b-41d4-a716-446655440000';
const sessionId = 'a'.repeat(43);
const csrf = newCsrfToken();
const bytes = new Uint8Array([1, 2, 3, 4]);
const opening: DocumentSnapshot = {
  version: 'rezics-document-v1',
  profile: 'blocks',
  doc: {
    type: 'doc',
    content: [{ type: 'paragraph', attrs: { id: 'paragraph' }, content: [{ type: 'text', text: 'See this chart' }] }],
  },
};

type Metrics = { K: number; D: number; R: number; A: number };
type KernelCall = { method: string; path: string; body: unknown };
type Reservation = {
  id: string;
  state: string;
  byteCount: number;
  mediaType: string;
  sha256: string | null;
  containerId: string;
  uploaderId: string;
  key: string;
  reservationRequestId: string;
};

const metrics: Metrics = { K: 0, D: 0, R: 0, A: 0 };
const calls: KernelCall[] = [];
const reservations = new Map<string, Reservation>();
let stored = 0;

const kernel = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/auth')) {
      metrics.A += 1;
      return new Response(null, { status: 500 });
    }
    const body = request.method === 'GET' || request.method === 'HEAD' ? null : await request.json().catch(() => null);
    metrics.K += 1;
    calls.push({ method: request.method, path: url.pathname, body });
    if (url.pathname === '/v1/media' && request.method === 'GET') {
      return Response.json({ media: [...reservations.values()] });
    }
    if (url.pathname === '/v1/media' && request.method === 'POST') {
      const id = contentId(800);
      const media: Reservation = {
        id,
        state: 'reserved',
        byteCount: bytes.byteLength,
        mediaType: 'image/png',
        sha256: null,
        containerId: contentId(80),
        uploaderId: 'member',
        key: `private/${id}/original`,
        reservationRequestId: contentId(81),
      };
      reservations.set(id, media);
      return Response.json({ media }, { status: 201 });
    }
    const match = /^\/v1\/media\/([^/:]+)(?::complete)?$/.exec(url.pathname);
    const media = reservations.get(match?.[1] ?? '');
    if (match && media && url.pathname.endsWith(':complete') && request.method === 'POST') {
      media.state = 'available';
      return Response.json({ media: { id: media.id, state: 'uploaded' } });
    }
    if (match && media && request.method === 'GET') return Response.json({ media });
    if (url.pathname === '/v1/threads' && request.method === 'POST') {
      const draft = body as { mediaIds?: string[]; title?: string } | null;
      return Response.json({
        thread: {
          id: threadId,
          route: 0,
          authorId: contentId(90),
          title: draft?.title ?? null,
          visibility: 'published',
          securityRevision: '1',
          availability: 'available',
          createdAt: '2026-01-01T00:00:00.000Z',
          licence: 'LicenseRef-rezics-terms',
          subjectIds: [],
          boardId,
          firstPost: {
            id: contentId(13),
            threadId,
            boardId,
            authorId: contentId(90),
            parentId: null,
            revisionId: contentId(113),
            sha256: 'a'.repeat(64),
            licence: 'LicenseRef-rezics-terms',
            subjectIds: [],
            mediaIds: draft?.mediaIds ?? [],
            availability: 'available',
            route: 0,
            visibility: 'published',
            securityRevision: '1',
            createdAt: '2026-01-01T00:00:00.000Z',
            body: opening,
          },
        },
      });
    }
    return Response.json({ status: 404, code: 'not_found' }, { status: 404 });
  },
});

const sessionStub = {
  async credential() {
    metrics.D += 1;
    return { status: 'active' as const, subject: 'member', accessToken: 'access', csrfToken: csrf };
  },
  async signedIn() {
    metrics.D += 1;
    return { signedIn: true, subject: 'member', csrfToken: csrf };
  },
};
const env = {
  SITE_ORIGINS: 'https://site.test',
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://api.test',
  WEBSITE_SCOPES: 'thread:create media:create media:read_reservation media:complete media:read',
  WEBSITE_CLIENT_ID: 'rezics-website',
  WEBSITE_CLIENT_KEY: '{}',
  KERNEL_ORIGIN: kernel.url.origin,
  SESSIONS: {
    idFromName() {
      return sessionId;
    },
    get() {
      return sessionStub;
    },
  },
  MEDIA: {
    async put(_key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null) {
      metrics.R += 1;
      if (value instanceof ReadableStream) await new Response(value).arrayBuffer();
      return { key: _key };
    },
  },
} as unknown as Partial<SessionEnv> & { KERNEL_ORIGIN: string; MEDIA: R2Bucket };

const client = createKernelClient(kernel.url.origin);

function seed(size: number) {
  metrics.K = 0;
  metrics.D = 0;
  metrics.R = 0;
  metrics.A = 0;
  calls.length = 0;
  reservations.clear();
  stored = size;
  for (let index = 0; index < size; index += 1) {
    const id = contentId(10_000 + index);
    reservations.set(id, {
      id,
      state: 'available',
      byteCount: 1,
      mediaType: 'image/png',
      sha256: null,
      containerId: contentId(70),
      uploaderId: 'member',
      key: `private/${id}/original`,
      reservationRequestId: contentId(71),
    });
  }
}

function siteRequest(method: string, path: string, body?: BodyInit, contentType?: string) {
  const headers = new Headers({
    origin: 'https://site.test',
    cookie: `__Host-rezics_session=${sessionId}`,
    'x-csrf-token': csrf,
  });
  if (contentType) headers.set('content-type', contentType);
  return new Request(`https://site.test${path}`, { method, headers, body });
}

async function siteCall(method: string, path: string, body?: BodyInit, contentType?: string) {
  const request = siteRequest(method, path, body, contentType);
  await prepareSession(request, env);
  return mediaRequest(request, env);
}

const refused = () => ({ ok: false as const, reason: 'unavailable' as const });

afterAll(() => {
  kernel.stop(true);
});

test("a new thread's opening image keeps K/D/R/A fixed as stored media grows", async () => {
  for (const size of [1, 10, 100]) {
    seed(size);
    expect(reservations.size).toBe(stored);
    const reserved = await siteCall(
      'POST',
      '/media',
      JSON.stringify({
        newThread: { boardId, idempotencyKey },
        purpose: 'post-image',
        mediaType: 'image/png',
        byteCount: bytes.byteLength,
      }),
      'application/json',
    );
    expect(reserved.status, await reserved.clone().text()).toBe(201);
    const created = (await reserved.json()) as { media: { id: string } };
    const uploaded = await siteCall('PUT', `/media/${created.media.id}`, bytes, 'image/png');
    expect(uploaded.status, await uploaded.clone().text()).toBe(200);
    const read = await siteCall('GET', `/media/${created.media.id}`);
    expect(read.status, await read.clone().text()).toBe(200);
    const started = await startThreadRequest(
      {
        boardId,
        title: 'A charted reading',
        body: opening,
        idempotencyKey,
        mediaIds: [created.media.id],
      },
      siteRequest('POST', '/_server/start-thread'),
      env,
      client,
      refused,
    );
    expect(started.ok).toBe(true);
    if (started.ok) expect(started.thread.id).toBe(threadId);
    expect(metrics).toEqual({ K: 5, D: 4, R: 1, A: 0 });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /v1/media',
      `GET /v1/media/${created.media.id}`,
      `POST /v1/media/${created.media.id}:complete`,
      `GET /v1/media/${created.media.id}`,
      'POST /v1/threads',
    ]);
    expect(calls[0]?.body).toEqual({
      newThread: { boardId, idempotencyKey },
      purpose: 'post-image',
      mediaType: 'image/png',
      byteCount: bytes.byteLength,
    });
    expect((calls[4]?.body as { mediaIds?: string[] }).mediaIds).toEqual([created.media.id]);
    expect(calls).toHaveLength(5);
    expect(reservations.size).toBe(size + 1);
  }
});
