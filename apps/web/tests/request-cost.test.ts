import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import { authRequest } from '../src/session/routes.ts';
import { prepareSession } from '../src/session/request.ts';
import { mediaRequest } from '../src/media/index.ts';
import { createFakeKernelFetch } from '../src/kernel/fake.ts';
import { slug } from '@rezics/definitions/slug';
import fixtures from '../src/kernel/fixtures.json';
import { threadHref } from '../src/threads/thread-href';

const app = join(import.meta.dir, '..');
const cookieId = 'a'.repeat(43);
const keyPair = await generateKeyPair('ES256', { extractable: true });
const clientJwk = { ...(await exportJWK(keyPair.privateKey)), alg: 'ES256', kid: 'request-cost' };
const subjectId = (fixtures.subjects[0] as { id: string }).id;
const subjectSlug = slug((fixtures.subjects[0] as { labels: Record<string, string> }).labels.en!);
const fakeKernel = createFakeKernelFetch(fixtures);
const kernelCalls: string[] = [];
const kernelAuthorizations: (string | null)[] = [];
const authCalls: string[] = [];
let subjectSize = 1;
let searchSize = 1;
const contentId = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const boardId = contentId(800);
const threadId = contentId(801);
let boardSize = 1;
let postSize = 1;
const pageMetadata = {
  route: 0,
  visibility: 'published',
  securityRevision: '1',
  createdAt: '2026-01-01T00:00:00.000Z',
};
const documentBody = (n: number) => ({
  version: 'rezics-document-v1',
  profile: 'blocks',
  doc: {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: { id: `post-${n}` },
        content: [{ type: 'text', text: `Post ${n}` }],
      },
    ],
  },
});
const post = (n: number) => ({
  ...pageMetadata,
  id: contentId(900 + n),
  threadId,
  boardId,
  authorId: contentId(999),
  parentId: null,
  revisionId: contentId(1200 + n),
  sha256: 'a'.repeat(64),
  licence: 'CC-BY-4.0',
  subjectIds: [],
  mediaIds: [],
  availability: 'available',
  body: documentBody(n),
});
function recordKernelCall(request: Request, url: URL, includeQuery = true) {
  kernelCalls.push(`${request.method} ${url.pathname}${includeQuery ? url.search : ''}`);
  kernelAuthorizations.push(request.headers.get('authorization'));
}
/** Inflate the page read's embedded subject and its reads. The page still makes one kernel call. */
function growPageRead(body: Record<string, any>, size: number) {
  const each = Math.max(1, Math.floor(size / 4));
  const reads = body.reads as Record<string, { status?: number; body?: { subject?: Record<string, any> } }>;
  for (const read of Object.values(reads)) {
    const subject = read?.body?.subject;
    if (!subject || typeof subject !== 'object' || Array.isArray(subject)) continue;
    subject.labels = Object.fromEntries(Array.from({ length: each }, (_, i) => [`x${i}`, `Label ${i}`]));
    subject.aliases = { en: Array.from({ length: size === 1 ? 0 : each }, (_, i) => `Alias ${i}`) };
    subject.statements = Object.fromEntries(
      Array.from({ length: size === 1 ? 0 : each }, (_, i) => [
        `property-${i}`,
        [
          {
            id: `statement-${i}`,
            rank: 'normal',
            property: { id: `property-${i}`, data_type: 'string' },
            value: { type: 'value', content: `value-${i}` },
            qualifiers: [],
            references: [],
          },
        ],
      ]),
    );
    subject.related_subjects = Array.from({ length: size === 1 ? 0 : size - each * 3 }, (_, i) => ({
      id: `related-${i}`,
      labels: { en: `Related ${i}` },
    }));
  }
  for (let i = 0; i < (size === 1 ? 0 : size); i++) {
    reads[`grown-${i}`] = {
      status: 200,
      body: {
        subject: {
          id: contentId(500 + i),
          type: 'schema:Thing',
          labels: { en: `Grown ${i}` },
          descriptions: {},
          aliases: {},
          statements: {},
        },
      },
    };
  }
}

const kernel = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/auth/.well-known/openid-configuration') {
      authCalls.push(url.pathname);
      return Response.json({
        issuer: `${url.origin}/auth`,
        authorization_endpoint: `${url.origin}/auth/authorize`,
        token_endpoint: `${url.origin}/auth/token`,
        jwks_uri: `${url.origin}/auth/jwks`,
        revocation_endpoint: `${url.origin}/auth/revoke`,
        end_session_endpoint: `${url.origin}/auth/logout`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        id_token_signing_alg_values_supported: ['ES256'],
        token_endpoint_auth_methods_supported: ['private_key_jwt'],
        token_endpoint_auth_signing_alg_values_supported: ['ES256'],
      });
    }
    if (url.pathname === '/auth/jwks') {
      authCalls.push(url.pathname);
      return Response.json({ keys: [] });
    }
    if (url.pathname.startsWith('/auth/')) {
      authCalls.push(url.pathname);
      return new Response(null, { status: 200 });
    }
    if (url.pathname === `/v1/boards/${boardId}`) {
      recordKernelCall(request, url);
      return Response.json({
        board: { ...pageMetadata, id: boardId, title: 'Cost board', availability: 'available' },
      });
    }
    if (url.pathname === `/v1/boards/${boardId}/threads`) {
      recordKernelCall(request, url);
      return Response.json({
        threads: Array.from({ length: boardSize }, (_, n) => ({
          ...pageMetadata,
          id: contentId(1000 + n),
          boardId,
          authorId: contentId(999),
          licence: 'CC-BY-4.0',
          subjectIds: [],
          title: `Thread ${n}`,
          availability: 'available',
          firstPost: post(n),
        })),
        next: null,
      });
    }
    if (url.pathname === `/v1/threads/${threadId}`) {
      recordKernelCall(request, url);
      return Response.json({
        thread: {
          ...pageMetadata,
          id: threadId,
          boardId,
          authorId: contentId(999),
          licence: 'CC-BY-4.0',
          subjectIds: [],
          title: 'Cost thread',
          availability: 'available',
          firstPost: post(0),
        },
      });
    }
    if (url.pathname === `/v1/threads/${threadId}/posts`) {
      recordKernelCall(request, url);
      return Response.json({ posts: Array.from({ length: postSize }, (_, n) => post(n)), next: null });
    }
    if (url.pathname === '/v1/subjects:search' && request.method === 'POST') {
      const body = (await request.json()) as { limit: number };
      recordKernelCall(request, url, false);
      return Response.json({
        subjects: Array.from({ length: Math.min(searchSize, body.limit) }, (_, i) => ({
          id: `${subjectId}-${i}`,
          type: 'book',
          labels: { en: `Result ${i}` },
        })),
        total: { value: searchSize, relation: 'exact' },
        next: null,
        as_of: new Date(0).toISOString(),
      });
    }
    if (url.pathname === '/v1/subjects:suggest' && request.method === 'GET') {
      recordKernelCall(request, url, false);
      return Response.json({
        subjects: Array.from({ length: Math.min(searchSize, Number(url.searchParams.get('limit')) || 8) }, (_, i) => ({
          id: `${subjectId}-${i}`,
          type: 'book',
          labels: { en: `Result ${i}` },
        })),
        as_of: new Date(0).toISOString(),
      });
    }
    if (url.pathname === `/v1/subjects/${subjectId}/collections` && request.method === 'GET') {
      recordKernelCall(request, url);
      return Response.json({ collections: [], next: null });
    }
    if (request.method === 'POST' && url.pathname === '/v1/pages:read') {
      recordKernelCall(request, url, false);
      const response = await fakeKernel(request);
      const body = (await response.json()) as Record<string, any>;
      if (response.status === 200 && body.subject === subjectId && body.reads && typeof body.reads === 'object')
        growPageRead(body, subjectSize);
      return Response.json(body, { status: response.status });
    }
    recordKernelCall(request, url);
    return fakeKernel(request);
  },
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}
let child: ChildProcess | undefined;
let started: Promise<string> | undefined;
function site(): Promise<string> {
  started ??= (async () => {
    const port = await freePort();
    let output = '';
    const keep = (chunk: Buffer) => (output = (output + chunk.toString()).slice(-8000));
    child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: app,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        KERNEL_ORIGIN: kernel.url.origin,
        AUTH_ISSUER: `${kernel.url.origin}/auth`,
        WEBSITE_CLIENT_ID: 'rezics-website',
        WEBSITE_CLIENT_KEY: JSON.stringify(clientJwk),
        API_RESOURCE: 'https://api.rezics.test',
        WEBSITE_SCOPES: 'media:create media:read media:complete media:erase',
      },
    });
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    const origin = `http://127.0.0.1:${port}`,
      deadline = Date.now() + 150_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`dev server exited with ${child.exitCode}:\n${output}`);
      try {
        if ((await fetch(`${origin}/en/`, { redirect: 'manual' })).status < 500) return origin;
      } catch {}
      if (Date.now() > deadline) throw new Error(`dev server did not start:\n${output}`);
      await Bun.sleep(250);
    }
  })();
  return started;
}

afterAll(() => {
  kernel.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

test('locale resolution stays within its bound as s grows', async () => {
  const origin = await site();
  for (const s of [1, 8, 64]) {
    subjectSize = s;
    kernelCalls.length = 0;
    authCalls.length = 0;
    const response = await fetch(`${origin}/`, { redirect: 'manual', headers: { 'accept-language': 'en' } });
    expect(response.status).toBe(302);
    expect(kernelCalls).toEqual([]);
    expect(authCalls).toEqual([]);
  }
}, 300_000);
test('home page stays within its bound as s grows', async () => {
  const origin = await site();
  for (const s of [1, 8, 64]) {
    subjectSize = s;
    kernelCalls.length = 0;
    authCalls.length = 0;
    for (const cookie of ['', `__Host-rezics_session=${cookieId}`]) {
      kernelCalls.length = 0;
      const response = await fetch(`${origin}/en/`, { headers: { cookie } });
      expect(response.status).toBe(200);
      expect(kernelCalls).toEqual(['POST /v1/pages:read']);
      expect(authCalls).toEqual([]);
    }
  }
}, 300_000);
test('subject page stays within its bound as s grows', async () => {
  const origin = await site();
  // Personal state is browser-only; the signed-in cookie does not alter the server's public read set.
  for (const s of [1, 8, 64]) {
    subjectSize = s;
    kernelCalls.length = 0;
    kernelAuthorizations.length = 0;
    const response = await fetch(`${origin}/en/subjects/${subjectId}/${subjectSlug}`, {
      headers: { cookie: `__Host-rezics_session=${cookieId}` },
    });
    expect(response.status).toBe(200);
    // Agent subtype classification and the page's type label use a bounded definitions read, whatever s is.
    const definitions = kernelCalls.filter((call) => call.includes('/v1/definitions/'));
    expect(definitions.length).toBeLessThanOrEqual(3);
    const page = kernelCalls.filter((call) => !call.includes('/v1/definitions/'));
    expect(page).toHaveLength(5);
    expect(page).toEqual(
      expect.arrayContaining([
        `GET /v1/subjects/${subjectId}`,
        'POST /v1/pages:read',
        `GET /v1/subjects/${subjectId}/reactions`,
        `GET /v1/subjects/${subjectId}/ratings?question=00000000-0000-7000-8000-000000000001&population=00000000-0000-8000-8000-000000000000`,
        `GET /v1/subjects/${subjectId}/source-statistics`,
      ]),
    );
    expect(kernelAuthorizations).toEqual(kernelCalls.map(() => null));
  }
}, 300_000);
test('board page stays within its bound as s grows', async () => {
  const origin = await site();
  for (const s of [1, 8, 64]) {
    boardSize = s;
    kernelCalls.length = 0;
    authCalls.length = 0;
    const response = await fetch(`${origin}/en/boards/${boardId}`);
    expect(response.status).toBe(200);
    expect(kernelCalls).toEqual([
      `GET /v1/boards/${boardId}`,
      `GET /v1/boards/${boardId}/threads?sort=active`,
      `GET /v1/accounts?ids=${contentId(999)}`,
    ]);
    expect(authCalls).toEqual([]);
  }
}, 300_000);
test('thread page stays within its bound as s grows', async () => {
  const origin = await site();
  for (const s of [1, 8, 64]) {
    postSize = s;
    kernelCalls.length = 0;
    authCalls.length = 0;
    const response = await fetch(`${origin}/en${threadHref({ id: threadId, title: 'Cost thread' })}`);
    expect(response.status).toBe(200);
    expect(kernelCalls).toEqual([
      `GET /v1/threads/${threadId}`,
      `GET /v1/threads/${threadId}/posts`,
      `GET /v1/boards/${boardId}`,
      `GET /v1/accounts?ids=${contentId(999)}`,
    ]);
    expect(authCalls).toEqual([]);
  }
}, 300_000);
test('search page stays within its bound as s grows', async () => {
  const origin = await site();
  for (const s of [1, 8, 64]) {
    searchSize = s;
    kernelCalls.length = 0;
    const response = await fetch(`${origin}/en/search?q=results`);
    expect(response.status).toBe(200);
    expect(kernelCalls).toEqual(['GET /v1/definitions/active', 'POST /v1/subjects:search']);
    // At most 100 hits, each with its cover frame and placeholder: a constant few kilobytes per hit.
    expect((await response.text()).length).toBeLessThan(300_000);
  }
}, 300_000);
test('suggestions stay within their bound as s grows', async () => {
  const origin = await site();
  for (const s of [1, 8, 64]) {
    searchSize = s;
    kernelCalls.length = 0;
    const response = await fetch(`${origin}/api/search/suggestions?q=results`);
    expect(response.status).toBe(200);
    // One suggest read, plus at most the active digest and the release that name the types, whatever s is.
    expect(kernelCalls.filter((call) => !call.includes('/v1/definitions/'))).toEqual(['GET /v1/subjects:suggest']);
    expect(kernelCalls.filter((call) => call.includes('/v1/definitions/')).length).toBeLessThanOrEqual(2);
    expect(((await response.json()) as { subjects: unknown[] }).subjects.length).toBeLessThanOrEqual(8);
  }
}, 300_000);

type Counts = {
  idFromName: number;
  get: number;
  credential: number;
  signedIn: number;
  create: number;
  takeLogin: number;
  end: number;
  kernel: number;
  r2get: number;
  r2head: number;
  r2put: number;
  r2delete: number;
  r2list: number;
  auth: number;
};
function harness(
  record: any = {
    kind: 'session',
    subject: 'person',
    accessToken: 'access',
    accessExpiresAt: Date.now() + 600_000,
    refreshToken: 'refresh',
    idToken: 'id-token',
    expiresAt: Date.now() + 600_000,
  },
) {
  const counts: Counts = {
    idFromName: 0,
    get: 0,
    credential: 0,
    signedIn: 0,
    create: 0,
    takeLogin: 0,
    end: 0,
    kernel: 0,
    r2get: 0,
    r2head: 0,
    r2put: 0,
    r2delete: 0,
    r2list: 0,
    auth: 0,
  };
  const stub = {
    async credential() {
      counts.credential++;
      return record ? { status: 'active', accessToken: record.accessToken } : { status: 'absent' };
    },
    async signedIn() {
      counts.signedIn++;
      return Boolean(record);
    },
    async create(value: any) {
      counts.create++;
      record = value;
    },
    async takeLogin() {
      counts.takeLogin++;
      const v = record?.kind === 'login' ? record : undefined;
      record = undefined;
      return v;
    },
    async end() {
      counts.end++;
      const v = record?.idToken;
      record = undefined;
      return v;
    },
  };
  const SESSIONS = {
    idFromName(_id: string) {
      counts.idFromName++;
      return _id;
    },
    get(_id: string) {
      counts.get++;
      return stub;
    },
  } as any;
  const env: any = {
    SESSIONS,
    AUTH_ISSUER: `${kernel.url.origin}/auth`,
    API_RESOURCE: 'https://api.rezics.test',
    WEBSITE_SCOPES: 'media:read media:complete',
    WEBSITE_CLIENT_ID: 'rezics-website',
    WEBSITE_CLIENT_KEY: JSON.stringify(clientJwk),
    KERNEL_ORIGIN: kernel.url.origin,
  };
  const media = {
    async get(_key: string) {
      counts.r2get++;
      return {
        body: new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array([1, 2, 3]));
            c.close();
          },
        }),
        size: 3,
        httpMetadata: { contentType: 'image/png' },
      };
    },
    async head(_key: string) {
      counts.r2head++;
      return { size: 3, httpMetadata: { contentType: 'image/png' } };
    },
    async put(_key: string, body: any) {
      counts.r2put++;
      if (body instanceof ReadableStream) await new Response(body).arrayBuffer();
      return {};
    },
    async delete() {
      counts.r2delete++;
    },
    async list() {
      counts.r2list++;
      return { objects: [] };
    },
  };
  env.MEDIA = media;
  return { counts, env };
}
const snapshot = (c: Counts) => ({
  D: c.credential + c.signedIn + c.create + c.takeLogin + c.end,
  K: c.kernel,
  R: c.r2get + c.r2head + c.r2put + c.r2delete + c.r2list,
  A: c.auth,
});
const expectBinding = (c: Counts, idFromName: number, get: number) => {
  expect({ idFromName: c.idFromName, get: c.get }).toEqual({ idFromName, get });
};

test('credential resolution stays within its bound as s grows', async () => {
  for (const s of [1, 8, 64]) {
    const { counts, env } = harness();
    const request = new Request('https://site.test/media/id/original', {
      headers: { cookie: `__Host-rezics_session=${cookieId}` },
    });
    await prepareSession(request, env);
    expect(snapshot(counts)).toEqual({ D: 1, K: 0, R: 0, A: 0 });
    expectBinding(counts, 1, 1);
  }
});
test('sign-in stays within its bound as s grows', async () => {
  for (const s of [1, 8, 64]) {
    authCalls.length = 0;
    const { counts, env } = harness();
    env.WEBSITE_CLIENT_ID = `rezics-cost-${s}`;
    const res = await authRequest(new Request('https://site.test/auth/sign-in'), env);
    expect(res.status).toBe(302);
    counts.auth = authCalls.length;
    expect(snapshot(counts)).toEqual({ D: 1, K: 0, R: 0, A: 1 });
    expectBinding(counts, 1, 1);
  }
});
test('callback stays within its bound as s grows', async () => {
  for (const s of [1, 8, 64]) {
    const { counts, env } = harness({
      kind: 'login',
      state: 'expected',
      nonce: 'nonce',
      verifier: 'verifier',
      returnTo: '/',
      expiresAt: Date.now() + 60_000,
    });
    const res = await authRequest(
      new Request('https://site.test/auth/callback?state=wrong', {
        headers: { cookie: `__Host-rezics_login=${cookieId}` },
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(snapshot(counts)).toEqual({ D: 1, K: 0, R: 0, A: 0 });
    expectBinding(counts, 1, 1);
  }
});
test('sign-out stays within its bound as s grows', async () => {
  for (const s of [1, 8, 64]) {
    authCalls.length = 0;
    const { counts, env } = harness();
    env.WEBSITE_CLIENT_ID = `rezics-signout-${s}`;
    const res = await authRequest(
      new Request('https://site.test/auth/sign-out', {
        method: 'POST',
        headers: { cookie: `__Host-rezics_session=${cookieId}` },
      }),
      env,
    );
    expect([302, 303]).toContain(res.status);
    counts.auth = authCalls.length;
    expect(snapshot(counts)).toEqual({ D: 1, K: 0, R: 0, A: 1 });
    expectBinding(counts, 1, 1);
  }
});
test('upload stays within its bound as s grows', async () => {
  // The request body sizes vary while the reserved-state rejection stays at one kernel request and no R2 calls.
  for (const s of [1, 8, 64])
    for (const size of [64 * 1024, 512 * 1024, 4 * 1024 * 1024]) {
      const { counts, env } = harness();
      const oldFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        counts.kernel++;
        const url = String(input);
        if (url.endsWith('/v1/media/id'))
          return Response.json({
            media: {
              id: 'id',
              state: 'uploaded',
              byteCount: size,
              mediaType: 'application/octet-stream',
              sha256: null,
              containerId: 'c',
              uploaderId: 'u',
              key: 'key',
              reservationRequestId: 'req',
            },
          });
        return Response.json({ media: { id: 'id', state: 'uploaded' } });
      };
      try {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            for (let n = 0; n < size; n += 65536) c.enqueue(new Uint8Array(Math.min(65536, size - n)));
            c.close();
          },
        });
        const res = await mediaRequest(
          new Request('https://site.test/media/id', {
            method: 'PUT',
            headers: { 'content-type': 'application/octet-stream', 'content-length': String(size) },
            body,
            duplex: 'half',
          } as RequestInit),
          env,
        );
        expect(res.status).toBe(409);
        expect(snapshot(counts)).toEqual({ D: 0, K: 1, R: 0, A: 0 });
      } finally {
        globalThis.fetch = oldFetch;
      }
    }
});
test('download stays within its bound as s grows', async () => {
  for (const s of [1, 8, 64])
    for (const size of [64 * 1024, 512 * 1024, 4 * 1024 * 1024]) {
      const { counts, env } = harness();
      const oldFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        counts.kernel++;
        return Response.json({
          allowed: true,
          key: 'key',
          sha256: 'abc',
          mediaType: 'image/png',
          byteCount: size,
          publicCache: false,
          cacheControl: 'private, no-store',
        });
      };
      try {
        const res = await mediaRequest(new Request('https://site.test/media/id/original'), env);
        expect(res.status).toBe(200);
        await res.arrayBuffer();
        expect(snapshot(counts)).toEqual({ D: 0, K: 1, R: 2, A: 0 });
      } finally {
        globalThis.fetch = oldFetch;
      }
    }
});
