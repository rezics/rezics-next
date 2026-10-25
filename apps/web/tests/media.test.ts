import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, jwtVerify } from 'jose';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const clientId = 'rezics-site-worker';
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

type Media = {
  id: string; state: 'reserved' | 'uploaded' | 'available' | 'rejected' | 'erased'; byteCount: number; mediaType: string;
  sha256: string | null; containerId: string; uploaderId: string; key: string; reservationRequestId: string;
};
type Decision = { allowed: true; key: string; sha256: string; mediaType: string; byteCount: number; publicCache: false; cacheControl: string };
type Seen = { method: string; path: string; authorization: string | null; idempotencyKey: string | null; body: unknown };

// The content media API and the Auth token endpoint as the frozen contracts describe them, recording every call.
const media = new Map<string, Media>();
const decisions = new Map<string, Decision>();
const issued = new Set<string>();
const assertions = new Set<string>();
const seen: Seen[] = [];
const keys = await generateKeyPair('ES256', { extractable: true });
const privateJwk = { ...(await exportJWK(keys.privateKey)), alg: 'ES256', kid: 'site-worker-1' };

const problem = (status: number, code: string) => Response.json(
  { type: `https://rezics.com/problems/${code}`, title: code, status, code, retryable: false, effect_status: 'not_applicable', request_id: randomUUID() },
  { status, headers: { 'content-type': 'application/problem+json' } });

const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    const issuer = `${url.origin}/auth`;
    const tokenEndpoint = `${issuer}/oauth2/token`;
    if (url.pathname === '/auth/.well-known/openid-configuration')
      return Response.json({ issuer, token_endpoint: tokenEndpoint, token_endpoint_auth_methods_supported: ['private_key_jwt'],
        token_endpoint_auth_signing_alg_values_supported: ['ES256'], grant_types_supported: ['client_credentials'] });
    if (url.pathname === '/auth/oauth2/token' && request.method === 'POST') {
      const form = new URLSearchParams(await request.text());
      if (form.get('grant_type') !== 'client_credentials' || form.get('scope') !== 'media:complete'
        || form.get('client_assertion_type') !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer')
        return Response.json({ error: 'invalid_request' }, { status: 400 });
      try {
        const { payload } = await jwtVerify(form.get('client_assertion') ?? '', keys.publicKey, {
          issuer: clientId, subject: clientId, audience: [issuer, tokenEndpoint], algorithms: ['ES256'], maxTokenAge: '5m',
        });
        if (!payload.jti || assertions.has(payload.jti) || !payload.exp) throw new Error('replayed or unbounded assertion');
        assertions.add(payload.jti);
      } catch {
        return Response.json({ error: 'invalid_client' }, { status: 401 });
      }
      const token = `worker-${randomUUID()}`;
      issued.add(token);
      return Response.json({ access_token: token, token_type: 'Bearer', expires_in: 300, scope: 'media:complete' });
    }

    const match = /^\/v1\/media\/([^/:]+)(?::(complete|authorizeDownload))?$/.exec(url.pathname);
    if (!match) return problem(404, 'not_found');
    const [, id, method] = match as unknown as [string, string, string | undefined];
    const authorization = request.headers.get('authorization');
    const body = request.method === 'POST' ? await request.json() : null;
    seen.push({ method: method ?? request.method, path: url.pathname + url.search, authorization,
      idempotencyKey: request.headers.get('idempotency-key'), body });
    const entry = media.get(id);
    if (!method && request.method === 'GET') {
      if (!entry || authorization !== `Bearer user:${entry.uploaderId}`) return problem(404, 'not_found');
      return Response.json({ media: entry });
    }
    if (method === 'complete' && request.method === 'POST') {
      const token = authorization?.replace(/^Bearer /, '');
      if (!token || !issued.has(token)) return problem(403, 'forbidden');
      if (!request.headers.get('idempotency-key')) return problem(400, 'invalid_request');
      const sent = body as Record<string, unknown>;
      if (!entry || entry.state !== 'reserved' || sent.uploaderId !== entry.uploaderId || sent.containerId !== entry.containerId
        || sent.reservationRequestId !== entry.reservationRequestId || sent.byteCount !== entry.byteCount
        || (entry.sha256 !== null && sent.sha256 !== entry.sha256)) return problem(403, 'forbidden');
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
  const entry: Media = { id, state: 'reserved', byteCount: bytes.length, mediaType: 'image/png', sha256: null,
    containerId: randomUUID(), uploaderId: 'alice', key: `m/${id}/original`, reservationRequestId: randomUUID(), ...overrides };
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

// The documented command, pointed at the fakes through the environment it reads in development.
function site(): Promise<string> {
  started ??= (async () => {
    const port = await freePort();
    let output = '';
    const keep = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-8000); };
    child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: app, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, KERNEL_ORIGIN: fake.url.origin, AUTH_ISSUER: `${fake.url.origin}/auth`,
        MEDIA_CLIENT_ID: clientId, MEDIA_CLIENT_KEY: JSON.stringify(privateJwk) },
    });
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`dev server exited with ${child.exitCode}:\n${output}`);
      try {
        const response = await fetch(`${origin}/en`, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
        if (response.status < 500) return origin;
      } catch {}
      if (Date.now() > deadline) throw new Error(`dev server did not serve /en in time:\n${output}`);
      await Bun.sleep(500);
    }
  })();
  return started;
}

afterAll(() => {
  fake.stop(true);
  if (child?.pid) try { process.kill(-child.pid, 'SIGTERM'); } catch {}
});

const upload = async (entry: Media, bytes: Uint8Array<ArrayBuffer>, token = `user:${entry.uploaderId}`, type = entry.mediaType) =>
  fetch(`${await site()}/media/${entry.id}`, { method: 'PUT', redirect: 'manual', body: bytes,
    headers: { authorization: `Bearer ${token}`, 'content-type': type } });

// What storage holds at an object's key, read back through the download route with an allowing decision.
async function stored(entry: Media): Promise<Uint8Array | null> {
  decisions.set(`${entry.id}/original`, { allowed: true, key: entry.key, sha256: '0'.repeat(64), mediaType: entry.mediaType,
    byteCount: entry.byteCount, publicCache: false, cacheControl: 'private, no-store' });
  const response = await fetch(`${await site()}/media/${entry.id}/original`, { redirect: 'manual',
    headers: { authorization: `Bearer user:${entry.uploaderId}` } });
  decisions.delete(`${entry.id}/original`);
  return response.status === 200 ? new Uint8Array(await response.arrayBuffer()) : null;
}

const completions = () => seen.filter(call => call.method === 'complete');

test('an upload streams the reserved bytes to storage and completes the reservation with what the Worker measured', async () => {
  const bytes = new Uint8Array(randomBytes(200_000));
  const entry = reserve(bytes);
  const response = await upload(entry, bytes);
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toEqual({ media: { id: entry.id, state: 'uploaded' } });

  // The reservation is read with the uploader's own token before any byte is written.
  const calls = seen.filter(call => call.path.startsWith(`/v1/media/${entry.id}`));
  expect(calls.map(call => call.method)).toEqual(['GET', 'complete']);
  expect(calls[0]!.authorization).toBe(`Bearer user:${entry.uploaderId}`);
  // Completion carries the Worker's own short-lived token, never the user's, and an idempotency key.
  const completion = calls[1]!;
  expect(issued.has(completion.authorization!.replace(/^Bearer /, ''))).toBe(true);
  expect(completion.idempotencyKey).toBeTruthy();
  expect(completion.body).toEqual({ uploaderId: entry.uploaderId, containerId: entry.containerId,
    reservationRequestId: entry.reservationRequestId, byteCount: bytes.length, sha256: sha256(bytes) });
  expect(media.get(entry.id)!.state).toBe('uploaded');
  expect(await stored(entry)).toEqual(bytes);

  // A declared digest that matches is accepted too.
  const declared = new Uint8Array(randomBytes(1_000));
  const second = reserve(declared, { sha256: sha256(declared) });
  expect((await upload(second, declared)).status).toBe(200);
  expect(media.get(second.id)!.state).toBe('uploaded');
}, timeout);

test('an upload is refused before completion unless the caller holds a reserved object of that length, type and digest', async () => {
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
}, timeout);

test('a download asks the kernel on every request and serves ranges, validators and the decided cache policy', async () => {
  const origin = await site();
  const bytes = new Uint8Array(randomBytes(50_000));
  const entry = reserve(bytes);
  expect((await upload(entry, bytes)).status).toBe(200);
  const etag = `"${sha256(bytes)}"`;
  // The decision names the key; here a derivative's decision points at the uploaded bytes.
  decisions.set(`${entry.id}/webp-320`, { allowed: true, key: entry.key, sha256: sha256(bytes), mediaType: 'image/webp',
    byteCount: bytes.length, publicCache: false, cacheControl: 'private, no-cache' });
  const url = `${origin}/media/${entry.id}/webp-320`;
  const asked = () => seen.filter(call => call.method === 'authorizeDownload' && call.path.startsWith(`/v1/media/${entry.id}:`));

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
}, timeout);
