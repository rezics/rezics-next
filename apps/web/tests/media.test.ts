import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { mediaRequest, type MediaEnv } from '../src/media/index.ts';

const app = join(import.meta.dir, '..');
const timeout = 780_000;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

type Media = {
  id: string;
  state: 'reserved' | 'uploaded' | 'available' | 'rejected' | 'erased';
  byteCount: number;
  mediaType: string;
  sha256: string | null;
  containerId: string;
  uploaderId: string;
  key: string;
  reservationRequestId: string;
};
type Decision = {
  allowed: true;
  key: string;
  sha256: string;
  mediaType: string;
  byteCount: number;
  publicCache: false;
  cacheControl: string;
};
type Seen = {
  method: string;
  path: string;
  authorization: string | null;
  idempotencyKey: string | null;
  body: unknown;
};

// The content media API as the frozen contract describes it, recording every call. A bearer token `user:<id>` stands for
// a person's access token from the site session: sub is the person, client_id is the website, and only the website
// client may receive the media:complete scope it carries.
const media = new Map<string, Media>();
const decisions = new Map<string, Decision>();
const seen: Seen[] = [];

const problem = (status: number, code: string) =>
  Response.json(
    {
      type: `https://rezics.com/problems/${code}`,
      title: code,
      status,
      code,
      retryable: false,
      effect_status: 'not_applicable',
      request_id: randomUUID(),
    },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    const match = /^\/v1\/media\/([^/:]+)(?::(complete|authorizeDownload))?$/.exec(url.pathname);
    if (!match) return problem(404, 'not_found');
    const [, id, method] = match as unknown as [string, string, string | undefined];
    const authorization = request.headers.get('authorization');
    const body = request.method === 'POST' ? await request.json() : null;
    seen.push({
      method: method ?? request.method,
      path: url.pathname + url.search,
      authorization,
      idempotencyKey: request.headers.get('idempotency-key'),
      body,
    });
    const entry = media.get(id);
    if (!method && request.method === 'GET') {
      if (!entry || authorization !== `Bearer user:${entry.uploaderId}`) return problem(404, 'not_found');
      return Response.json({ media: entry });
    }
    if (method === 'complete' && request.method === 'POST') {
      if (!request.headers.get('idempotency-key')) return problem(400, 'invalid_request');
      const sent = body as Record<string, unknown>;
      if (Object.keys(sent).sort().join() !== 'byteCount,containerId,reservationRequestId,sha256')
        return problem(400, 'invalid_request');
      // The uploader is the token's subject, never a field of the body.
      if (
        !entry ||
        entry.state !== 'reserved' ||
        authorization !== `Bearer user:${entry.uploaderId}` ||
        sent.containerId !== entry.containerId ||
        sent.reservationRequestId !== entry.reservationRequestId ||
        sent.byteCount !== entry.byteCount ||
        (entry.sha256 !== null && sent.sha256 !== entry.sha256)
      )
        return problem(403, 'forbidden');
      entry.state = 'uploaded';
      return Response.json({ media: { id, state: 'uploaded' } });
    }
    if (method === 'authorizeDownload' && request.method === 'GET') {
      const decision = decisions.get(`${id}/${url.searchParams.get('variant')}`);
      return decision ? Response.json(decision) : problem(404, 'not_found');
    }
    return problem(404, 'not_found');
  },
});

function reserve(bytes: Uint8Array, overrides: Partial<Media> = {}): Media {
  const id = randomUUID();
  const entry: Media = {
    id,
    state: 'reserved',
    byteCount: bytes.length,
    mediaType: 'image/png',
    sha256: null,
    containerId: randomUUID(),
    uploaderId: 'alice',
    key: `m/${id}/original`,
    reservationRequestId: randomUUID(),
    ...overrides,
  };
  media.set(id, entry);
  return entry;
}

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

// The documented command, pointed at the fake through the environment it reads in development.
function site(): Promise<string> {
  started ??= (async () => {
    const port = await freePort();
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      KERNEL_ORIGIN: fake.url.origin,
      WEBSITE_CLIENT_KEY: JSON.stringify({ ...privateKey.export({ format: 'jwk' }), kid: 'media-worker-test' }),
    };
    // This fixture owns the R2 transport; task-local native bindings must not replace its store.
    delete env.LOCAL_MEDIA_ORIGIN;
    delete env.LOCAL_MEDIA_TOKEN;
    let output = '';
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8000);
    };
    // Diagnostic for the Worker startup: Vite's optimizer timeline (scan, crawl end, rerun) reaches the check log.
    child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: app,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, DEBUG: 'vite:deps' },
    });
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    const origin = `http://127.0.0.1:${port}`;
    const missingMedia = `${origin}/media/${randomUUID()}/original`;
    // Vite's configuration, the Paraglide step and the Cloudflare plugin's Worker graph load run before the port
    // listens. On a loaded check host that took more than four minutes, so this probe allows 720 seconds; it still
    // requires the real Worker's media response.
    const deadline = Date.now() + 720_000;
    let probe = 'no response yet';
    for (;;) {
      if (child.exitCode !== null) throw new Error(`dev server exited with ${child.exitCode}:\n${output}`);
      try {
        // The fixture implements media APIs, so readiness must not depend on home-page discovery or rendering.
        const response = await fetch(missingMedia, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
        const ready = response.status === 404 && response.headers.get('content-type')?.includes('application/problem+json');
        probe = `HTTP ${response.status} ${response.headers.get('content-type') ?? 'no content type'}`;
        await response.body?.cancel();
        if (ready) return origin;
      } catch (error) {
        probe = error instanceof Error ? error.message : String(error);
      }
      if (Date.now() > deadline)
        throw new Error(`dev server did not serve the media route in time; last probe: ${probe}\n${output}`);
      await Bun.sleep(500);
    }
  })();
  return started;
}

afterAll(() => {
  fake.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

const upload = async (
  entry: Media,
  bytes: Uint8Array<ArrayBuffer>,
  token = `user:${entry.uploaderId}`,
  type = entry.mediaType,
) =>
  fetch(`${await site()}/media/${entry.id}`, {
    method: 'PUT',
    redirect: 'manual',
    body: bytes,
    headers: { authorization: `Bearer ${token}`, 'content-type': type },
  });

// What storage holds at an object's key, read back through the download route with an allowing decision.
async function stored(entry: Media): Promise<Uint8Array | null> {
  decisions.set(`${entry.id}/original`, {
    allowed: true,
    key: entry.key,
    sha256: '0'.repeat(64),
    mediaType: entry.mediaType,
    byteCount: entry.byteCount,
    publicCache: false,
    cacheControl: 'private, no-store',
  });
  const response = await fetch(`${await site()}/media/${entry.id}/original`, {
    redirect: 'manual',
    headers: { authorization: `Bearer user:${entry.uploaderId}` },
  });
  decisions.delete(`${entry.id}/original`);
  return response.status === 200 ? new Uint8Array(await response.arrayBuffer()) : null;
}

const completions = () => seen.filter((call) => call.method === 'complete');

test('genuine native small derivative variant syntax passes the Worker boundary while malformed variants and exact-slot denial remain closed', async () => {
  const id = randomUUID();
  const bytes = new Uint8Array(randomBytes(32));
  const key = `m/${id}/webp-160`;
  const decision: Decision = {
    allowed: true,
    key,
    sha256: sha256(bytes),
    mediaType: 'image/webp',
    byteCount: bytes.length,
    publicCache: false,
    cacheControl: 'private, no-cache',
  };
  decisions.set(`${id}/webp-160`, decision);
  // An allowed original must never rescue a denied derivative slot.
  decisions.set(`${id}/original`, { ...decision, key: `m/${id}/original` });
  const storage: string[] = [];
  const env: MediaEnv = {
    KERNEL_ORIGIN: fake.url.origin,
    MEDIA: {
      async head(storedKey: string) {
        storage.push(`head:${storedKey}`);
        return { size: bytes.length };
      },
      async get(storedKey: string) {
        storage.push(`get:${storedKey}`);
        return { size: bytes.length, body: new Blob([bytes]).stream() };
      },
    } as unknown as R2Bucket,
  };
  const request = (variant: string) =>
    mediaRequest(
      new Request(`https://site.test/media/${id}/${variant}`, {
        headers: { authorization: 'Bearer user:bob', 'if-none-match': '"stale"' },
      }),
      env,
    );
  const asked = () =>
    seen.filter((call) => call.method === 'authorizeDownload' && call.path.startsWith(`/v1/media/${id}:`));
  const small = await request('webp-160');
  expect(small.status).toBe(200);
  expect(small.headers.get('content-type')).toBe('image/webp');
  expect(new Uint8Array(await small.arrayBuffer())).toEqual(bytes);
  expect(storage).toEqual([`head:${key}`, `get:${key}`]);
  for (const variant of ['webp-159', 'avif-160', 'webp-320']) {
    const denied = await mediaRequest(
      new Request(`https://site.test/media/${id}/${variant}`, {
        headers: { authorization: 'Bearer user:bob', 'if-none-match': `"${decision.sha256}"` },
      }),
      env,
    );
    expect(denied.status).toBe(404);
    expect(denied.headers.get('cache-control')).toBe('private, no-store');
    const body = await denied.text();
    expect(body).not.toContain(key);
    expect(body).not.toContain(decision.sha256);
  }
  expect(asked().map((call) => new URL(call.path, fake.url).searchParams.get('variant'))).toEqual([
    'webp-160',
    'webp-159',
    'avif-160',
    'webp-320',
  ]);
  expect(asked().every((call) => call.authorization === 'Bearer user:bob')).toBe(true);
  for (const variant of ['webp-0', 'webp-0160', 'webp-321', 'webp-160%2f..'])
    expect((await request(variant)).status).toBe(404);
  expect(asked()).toHaveLength(4);
  expect(storage).toEqual([`head:${key}`, `get:${key}`]);
});

test(
  'an upload streams the reserved bytes to storage and completes the reservation with what the Worker measured',
  async () => {
    const bytes = new Uint8Array(randomBytes(200_000));
    const entry = reserve(bytes);
    const response = await upload(entry, bytes);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ media: { id: entry.id, state: 'uploaded' } });

    // The reservation is read with the uploader's own token before any byte is written.
    const calls = seen.filter((call) => call.path.startsWith(`/v1/media/${entry.id}`));
    expect(calls.map((call) => call.method)).toEqual(['GET', 'complete']);
    expect(calls[0]!.authorization).toBe(`Bearer user:${entry.uploaderId}`);
    // Completion carries the same person's token, an idempotency key, and what the Worker measured.
    const completion = calls[1]!;
    expect(completion.authorization).toBe(`Bearer user:${entry.uploaderId}`);
    expect(completion.idempotencyKey).toBeTruthy();
    expect(completion.body).toEqual({
      containerId: entry.containerId,
      reservationRequestId: entry.reservationRequestId,
      byteCount: bytes.length,
      sha256: sha256(bytes),
    });
    expect(media.get(entry.id)!.state).toBe('uploaded');
    expect(await stored(entry)).toEqual(bytes);

    // A declared digest that matches is accepted too.
    const declared = new Uint8Array(randomBytes(1_000));
    const second = reserve(declared, { sha256: sha256(declared) });
    expect((await upload(second, declared)).status).toBe(200);
    expect(media.get(second.id)!.state).toBe('uploaded');
  },
  timeout,
);

test(
  'an upload is refused before completion unless the caller holds a reserved object of that length, type and digest',
  async () => {
    const bytes = new Uint8Array(randomBytes(4_096));
    const cases: [string, Media, () => Promise<Response>, number][] = [];
    const other = reserve(bytes);
    cases.push(['another uploader', other, () => upload(other, bytes, 'user:mallory'), 404]);
    const unknown = reserve(bytes);
    media.delete(unknown.id);
    cases.push(['an unknown object', unknown, () => upload(unknown, bytes), 404]);
    const typed = reserve(bytes);
    cases.push(['another media type', typed, () => upload(typed, bytes, undefined, 'image/svg+xml'), 415]);
    const longer = reserve(bytes);
    cases.push(['more bytes than reserved', longer, () => upload(longer, new Uint8Array(randomBytes(4_097))), 413]);
    const shorter = reserve(bytes);
    cases.push(['fewer bytes than reserved', shorter, () => upload(shorter, bytes.slice(1)), 400]);
    const digest = reserve(bytes, { sha256: sha256(new Uint8Array(randomBytes(16))) });
    cases.push(['bytes that do not match the declared digest', digest, () => upload(digest, bytes), 400]);
    const done = reserve(bytes, { state: 'uploaded' });
    cases.push(['an object that is no longer reserved', done, () => upload(done, bytes), 409]);

    for (const [name, entry, send, status] of cases) {
      const before = completions().length;
      const response = await send();
      expect(response.status, name).toBe(status);
      expect(response.headers.get('content-type'), name).toStartWith('application/problem+json');
      expect(completions().length, name).toBe(before);
      if (name !== 'an object that is no longer reserved') expect(await stored(entry), name).toBeNull();
    }
  },
  timeout,
);

test(
  'a download asks the kernel on every request and serves ranges, validators and the decided cache policy',
  async () => {
    const origin = await site();
    const bytes = new Uint8Array(randomBytes(50_000));
    const entry = reserve(bytes);
    expect((await upload(entry, bytes)).status).toBe(200);
    const etag = `"${sha256(bytes)}"`;
    // The decision names the key; here a derivative's decision points at the uploaded bytes.
    decisions.set(`${entry.id}/webp-320`, {
      allowed: true,
      key: entry.key,
      sha256: sha256(bytes),
      mediaType: 'image/webp',
      byteCount: bytes.length,
      publicCache: false,
      cacheControl: 'private, no-cache',
    });
    const url = `${origin}/media/${entry.id}/webp-320`;
    const asked = () =>
      seen.filter((call) => call.method === 'authorizeDownload' && call.path.startsWith(`/v1/media/${entry.id}:`));

    const full = await fetch(url, { redirect: 'manual' });
    expect(full.status).toBe(200);
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(bytes);
    expect(full.headers.get('content-type')).toBe('image/webp');
    expect(full.headers.get('content-length')).toBe(String(bytes.length));
    expect(full.headers.get('etag')).toBe(etag);
    expect(full.headers.get('cache-control')).toBe('private, no-cache');
    expect(full.headers.get('x-content-type-options')).toBe('nosniff');
    expect(full.headers.get('content-disposition')).toBeTruthy();
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    // An anonymous viewer is asked about as anonymous; a signed-in viewer with their own token.
    expect(asked().at(-1)!.authorization).toBeNull();
    expect(asked().at(-1)!.path).toBe(`/v1/media/${entry.id}:authorizeDownload?variant=webp-320`);
    await fetch(url, { redirect: 'manual', headers: { authorization: 'Bearer user:bob' } });
    expect(asked().at(-1)!.authorization).toBe('Bearer user:bob');

    const part = await fetch(url, { redirect: 'manual', headers: { range: 'bytes=10-19' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 10-19/${bytes.length}`);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.slice(10, 20));
    const tail = await fetch(url, { redirect: 'manual', headers: { range: 'bytes=-5' } });
    expect(tail.status).toBe(206);
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(bytes.slice(-5));
    const beyond = await fetch(url, { redirect: 'manual', headers: { range: `bytes=${bytes.length}-` } });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get('content-range')).toBe(`bytes */${bytes.length}`);

    const head = await fetch(url, { method: 'HEAD', redirect: 'manual' });
    expect(head.status).toBe(200);
    expect(head.headers.get('etag')).toBe(etag);
    expect((await head.arrayBuffer()).byteLength).toBe(0);

    // A conditional request is decided again: 304 saves the bytes, not the decision.
    const before = asked().length;
    const fresh = await fetch(url, { redirect: 'manual', headers: { 'if-none-match': etag } });
    expect(fresh.status).toBe(304);
    expect(asked().length).toBe(before + 1);
    decisions.delete(`${entry.id}/webp-320`);
    const revoked = await fetch(url, { redirect: 'manual', headers: { 'if-none-match': etag } });
    expect(revoked.status).toBe(404);
    expect(revoked.headers.get('content-type')).toStartWith('application/problem+json');
    const text = await revoked.text();
    expect(text).not.toContain(entry.key);
    expect(text).not.toContain(sha256(bytes));

    // A variant outside the contract is not found without asking the kernel.
    const count = asked().length;
    expect((await fetch(`${origin}/media/${entry.id}/png-12`, { redirect: 'manual' })).status).toBe(404);
    expect(asked().length).toBe(count);
  },
  timeout,
);
