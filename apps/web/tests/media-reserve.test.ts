import { readSessionToken } from './session-token';
import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const clientId = 'rezics-website';
const sessionCookie = '__Host-rezics_session';
const loginCookie = '__Host-rezics_login';
const scopes = 'media:create media:read_reservation media:complete';
const clientKeys = await generateKeyPair('ES256', { extractable: true });
const clientJwk = { ...(await exportJWK(clientKeys.privateKey)), alg: 'ES256', kid: 'website-1' };
const issuerKeys = await generateKeyPair('ES256', { extractable: true });
const issuerJwk = { ...(await exportJWK(issuerKeys.publicKey)), alg: 'ES256', kid: 'issuer-1', use: 'sig' };
type Grant = { sub: string; nonce: string; challenge: string; redirectUri: string };
type Reservation = {
  id: string;
  state: string;
  containerId: string;
  mediaType: string;
  byteCount: number;
  sha256: string | null;
  uploaderId: string;
  key: string;
  reservationRequestId: string;
};
const grants = new Map<string, Grant>();
const tokens = new Map<string, string>();
const reservations = new Map<string, Reservation>();
const calls: { method: string; path: string; authorization: string | null; body: unknown }[] = [];
const problem = (status: number, code: string) => ({
  type: `https://kernel.example/problems/${code}`,
  title: `Kernel ${code}`,
  status,
  code,
});
const failure = (status: number, code: string) =>
  Response.json(problem(status, code), { status, headers: { 'content-type': 'application/problem+json' } });

// The issuer issues a person's website token only through the real Worker sign-in flow.
// The kernel records every call, including unsuccessful calls, before applying uploader permissions.
const fake = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const issuer = `${url.origin}/auth`;
    if (url.pathname === '/auth/.well-known/openid-configuration')
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        id_token_signing_alg_values_supported: ['ES256'],
        token_endpoint_auth_methods_supported: ['private_key_jwt'],
        token_endpoint_auth_signing_alg_values_supported: ['ES256'],
      });
    if (url.pathname === '/auth/jwks') return Response.json({ keys: [issuerJwk] });
    if (url.pathname === '/auth/token') {
      const form = new URLSearchParams(await request.text());
      if (form.get('grant_type') !== 'authorization_code') return failure(400, 'unsupported_grant_type');
      await jwtVerify(form.get('client_assertion')!, clientKeys.publicKey, {
        issuer: clientId,
        subject: clientId,
        audience: issuer,
        algorithms: ['ES256'],
      });
      const grant = grants.get(form.get('code') ?? '');
      grants.delete(form.get('code') ?? '');
      if (
        !grant ||
        grant.redirectUri !== form.get('redirect_uri') ||
        grant.challenge !== createHash('sha256').update(form.get('code_verifier')!).digest('base64url')
      )
        return failure(400, 'invalid_grant');
      const token = `access-${randomUUID()}`;
      tokens.set(token, grant.sub);
      return Response.json({
        access_token: token,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: `refresh-${randomUUID()}`,
        scope: `openid offline_access ${scopes}`,
        id_token: await new SignJWT({ nonce: grant.nonce })
          .setProtectedHeader({ alg: 'ES256', kid: 'issuer-1' })
          .setIssuer(issuer)
          .setSubject(grant.sub)
          .setAudience(clientId)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(issuerKeys.privateKey),
      });
    }
    if (!url.pathname.startsWith('/v1/')) return failure(404, 'not_found');
    // Unknown /v1 routes, including the anonymous home pages:read, answer 404. A bearer is required only for media.
    const creating = request.method === 'POST' && url.pathname === '/v1/media';
    const match = /^\/v1\/media\/([^/:]+)(:complete)?$/.exec(url.pathname);
    const reading = request.method === 'GET' && match !== null && match[2] === undefined;
    const completing = request.method === 'POST' && match?.[2] === ':complete';
    if (!creating && !reading && !completing) {
      await request.body?.cancel().catch(() => {});
      return failure(404, 'not_found');
    }
    const authorization = request.headers.get('authorization');
    const body = request.method === 'POST' ? await request.json() : null;
    calls.push({ method: request.method, path: url.pathname, authorization, body });
    const sub = tokens.get(authorization?.replace(/^Bearer /, '') ?? '');
    if (!sub) return failure(401, 'authentication_required');
    if (creating) {
      if (!request.headers.get('idempotency-key')) return failure(400, 'invalid_request');
      const input = body as Record<string, unknown>;
      const id = randomUUID();
      const future = input.newThread as { idempotencyKey?: string } | undefined;
      const media: Reservation = {
        id,
        state: 'reserved',
        containerId:
          typeof input.containerId === 'string'
            ? input.containerId
            : `0192f3a0-6c1e-7b2a-9d4e-${(future?.idempotencyKey ?? id).replace(/-/g, '').slice(0, 12)}`,
        mediaType: input.mediaType as string,
        byteCount: input.byteCount as number,
        sha256: (input.sha256 as string | undefined) ?? null,
        uploaderId: sub,
        key: `private/${id}/original`,
        reservationRequestId: randomUUID(),
      };
      reservations.set(id, media);
      return Response.json({ media }, { status: 201, headers: { location: `/v1/media/${id}` } });
    }
    const media = reservations.get(match?.[1] ?? '');
    if (!media || media.uploaderId !== sub) return failure(404, 'not_found');
    if (match?.[2] && request.method === 'POST') {
      if (!request.headers.get('idempotency-key')) return failure(400, 'invalid_request');
      media.state = 'uploaded';
      return Response.json({ media: { id: media.id, state: media.state } });
    }
    return Response.json({ media });
  },
});

let child: ChildProcess | undefined;
let started: Promise<string> | undefined;
function site(): Promise<string> {
  started ??= (async () => {
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as { port: number };
        probe.close(() => resolve(port));
      });
    });
    let output = '';
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8000);
    };
    child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: app,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        KERNEL_ORIGIN: fake.url.origin,
        AUTH_ISSUER: `${fake.url.origin}/auth`,
        WEBSITE_CLIENT_ID: clientId,
        WEBSITE_CLIENT_KEY: JSON.stringify(clientJwk),
        API_RESOURCE: 'https://api.rezics.test',
        WEBSITE_SCOPES: scopes,
      },
    });
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`dev server exited: ${output}`);
      try {
        if ((await fetch(`${origin}/en`, { signal: AbortSignal.timeout(60_000) })).status < 500) return origin;
      } catch {}
      if (Date.now() > deadline) throw new Error(`dev server did not start: ${output}`);
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

const cookieValue = (response: Response, name: string) =>
  response.headers
    .getSetCookie()
    .find((line) => line.startsWith(`${name}=`))
    ?.split(';')[0]!
    .slice(name.length + 1);
async function signIn(sub: string) {
  const origin = await site();
  const start = await fetch(`${origin}/auth/sign-in`, { redirect: 'manual' });
  const params = new URL(start.headers.get('location')!).searchParams;
  const code = randomUUID();
  grants.set(code, {
    sub,
    nonce: params.get('nonce')!,
    challenge: params.get('code_challenge')!,
    redirectUri: params.get('redirect_uri')!,
  });
  const answer = await fetch(`${params.get('redirect_uri')}?code=${code}&state=${params.get('state')}`, {
    redirect: 'manual',
    headers: { cookie: `${loginCookie}=${cookieValue(start, loginCookie)}` },
  });
  expect(answer.status, await answer.clone().text()).toBe(303);
  const value = cookieValue(answer, sessionCookie);
  expect(value).toBeDefined();
  const page = await fetch(`${origin}/en`, { headers: { cookie: `${sessionCookie}=${value}` } });
  expect(page.status).toBe(200);
  const csrfToken = await readSessionToken(origin, `${sessionCookie}=${value}`);
  expect(csrfToken).toBeDefined();
  return {
    origin,
    headers: { cookie: `${sessionCookie}=${value}`, origin, 'X-CSRF-Token': csrfToken! },
    authorization: `Bearer ${[...tokens].findLast(([, person]) => person === sub)![0]}`,
  };
}
const input = () => ({ containerId: randomUUID(), purpose: 'post-image', mediaType: 'image/png', byteCount: 4 });
const publicMedia = ({ id, state, mediaType, byteCount, sha256, containerId }: Reservation) => ({
  media: { id, state, mediaType, byteCount, sha256, containerId },
});
const privateResponse = (response: Response) => expect(response.headers.get('cache-control')).toBe('private, no-store');

test(
  'a signed-in uploader reserves through the site and uploads to the address it returns',
  async () => {
    const alice = await signIn('alice');
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const posted = { ...input(), sha256 };
    const before = calls.length;
    const response = await fetch(`${alice.origin}/media`, {
      method: 'POST',
      headers: { ...alice.headers, 'content-type': 'application/json' },
      body: JSON.stringify(posted),
      redirect: 'manual',
    });
    expect(response.status, await response.clone().text()).toBe(201);
    privateResponse(response);
    expect(calls.slice(before)).toEqual([
      { method: 'POST', path: '/v1/media', authorization: alice.authorization, body: posted },
    ]);
    const media = [...reservations.values()].at(-1)!;
    expect(await response.json()).toEqual(publicMedia(media));
    const location = response.headers.get('location');
    expect(location).toBe(`/media/${media.id}`);
    const uploaded = await fetch(`${alice.origin}${location}`, {
      method: 'PUT',
      headers: { ...alice.headers, 'content-type': posted.mediaType, 'content-length': String(bytes.length) },
      body: bytes,
      redirect: 'manual',
    });
    expect(uploaded.status, await uploaded.clone().text()).toBe(200);
    privateResponse(uploaded);
    expect(await uploaded.json()).toEqual({ media: { id: media.id, state: 'uploaded' } });
    expect(calls.slice(before + 1)).toEqual([
      { method: 'GET', path: `/v1/media/${media.id}`, authorization: alice.authorization, body: null },
      {
        method: 'POST',
        path: `/v1/media/${media.id}:complete`,
        authorization: alice.authorization,
        body: {
          containerId: posted.containerId,
          reservationRequestId: media.reservationRequestId,
          byteCount: 4,
          sha256,
        },
      },
    ]);
  },
  timeout,
);

test(
  'an avatar reservation keeps the account container and avatar purpose through the site upload route',
  async () => {
    const alice = await signIn('0192f3a0-6c1e-7b2a-9d4e-000000000001');
    const bytes = new Uint8Array([9, 8, 7, 6]);
    const body = {
      containerId: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
      purpose: 'avatar',
      mediaType: 'image/png',
      byteCount: bytes.byteLength,
    };
    const before = calls.length;
    const reserveResponse = await fetch(`${alice.origin}/media`, {
      method: 'POST',
      headers: { ...alice.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(reserveResponse.status, await reserveResponse.clone().text()).toBe(201);
    expect(calls[before]).toMatchObject({
      method: 'POST',
      path: '/v1/media',
      authorization: alice.authorization,
      body,
    });
    const reserved = (await reserveResponse.json()) as { media: { id: string } };
    const uploaded = await fetch(`${alice.origin}/media/${reserved.media.id}`, {
      method: 'PUT',
      headers: { ...alice.headers, 'content-type': body.mediaType },
      body: bytes,
    });
    expect(uploaded.status, await uploaded.clone().text()).toBe(200);
    expect(
      calls.slice(before + 1).map(({ method, path, body: requestBody }) => ({ method, path, body: requestBody })),
    ).toEqual([
      { method: 'GET', path: `/v1/media/${reserved.media.id}`, body: null },
      {
        method: 'POST',
        path: `/v1/media/${reserved.media.id}:complete`,
        body: expect.objectContaining({ containerId: body.containerId }),
      },
    ]);
  },
  timeout,
);

test(
  'reservations are read through the site by their uploader only',
  async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bob');
    const posted = input();
    const reserved = await fetch(`${alice.origin}/media`, {
      method: 'POST',
      headers: { ...alice.headers, 'content-type': 'application/json' },
      body: JSON.stringify(posted),
    });
    expect(reserved.status, await reserved.clone().text()).toBe(201);
    const media = [...reservations.values()].at(-1)!;
    const before = calls.length;
    for (const [headers, credential, status] of [
      [alice.headers, alice.authorization, 200],
      [bob.headers, bob.authorization, 404],
      [{}, null, 401],
      [{ ...bob.headers, authorization: alice.authorization }, alice.authorization, 200],
    ] as const) {
      const response = await fetch(`${alice.origin}/media/${media.id}`, { headers, redirect: 'manual' });
      expect(response.status, await response.clone().text()).toBe(status);
      privateResponse(response);
      expect(await response.json()).toEqual(
        status === 200 ? publicMedia(media) : problem(status, status === 404 ? 'not_found' : 'authentication_required'),
      );
      expect(calls.at(-1)).toEqual({
        method: 'GET',
        path: `/v1/media/${media.id}`,
        authorization: credential,
        body: null,
      });
    }
    expect(calls.length - before).toBe(4);
  },
  timeout,
);

test(
  'the reserve route refuses malformed or oversized bodies before calling the kernel',
  async () => {
    const alice = await signIn('alice');
    const before = calls.length;
    const posted = JSON.stringify(input());
    for (const [body, type, origin, status] of [
      [posted, 'text/plain', alice.origin, 415],
      [' '.repeat(4097), 'application/json', alice.origin, 413],
      ['{', 'application/json', alice.origin, 400],
      [JSON.stringify({ ...input(), uploaderId: 'bob' }), 'application/json', alice.origin, 400],
      ['null', 'application/json', alice.origin, 400],
      ['[]', 'application/json', alice.origin, 400],
      [JSON.stringify({ ...input(), byteCount: '4' }), 'application/json', alice.origin, 400],
      [posted, 'application/json', 'https://evil.example', 403],
    ] as const) {
      // A stream omits Content-Length: the size limit must also apply while reading actual bytes.
      const response = await fetch(`${alice.origin}/media`, {
        method: 'POST',
        headers: { ...alice.headers, origin, 'content-type': type },
        body: new ReadableStream({
          start(controller) {
            const bytes = new TextEncoder().encode(body);
            controller.enqueue(bytes.slice(0, 100));
            controller.enqueue(bytes.slice(100));
            controller.close();
          },
        }),
        redirect: 'manual',
      });
      expect(response.status, body.slice(0, 100)).toBe(status);
      privateResponse(response);
      if (status === 400) expect(await response.json()).toMatchObject({ code: 'invalid_request', status: 400 });
      expect(calls.length).toBe(before);
    }
  },
  timeout,
);

test(
  'a future thread is reserved in place of a container, and any other target is refused',
  async () => {
    const alice = await signIn('alice');
    const boardId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
    const posted = {
      newThread: { boardId, idempotencyKey: randomUUID() },
      purpose: 'post-image',
      mediaType: 'image/png',
      byteCount: 4,
      sha256: 'ab'.repeat(32),
    };
    const before = calls.length;
    const accepted = await fetch(`${alice.origin}/media`, {
      method: 'POST',
      headers: { ...alice.headers, 'content-type': 'application/json' },
      body: JSON.stringify(posted),
      redirect: 'manual',
    });
    expect(accepted.status, await accepted.clone().text()).toBe(201);
    privateResponse(accepted);
    expect(calls.slice(before)).toEqual([
      { method: 'POST', path: '/v1/media', authorization: alice.authorization, body: posted },
    ]);
    const hostile = [
      { ...posted, containerId: randomUUID() },
      { purpose: 'post-image', mediaType: 'image/png', byteCount: 4 },
      { ...posted, note: 'no' },
    ];
    for (const body of hostile) {
      const at = calls.length;
      const response = await fetch(`${alice.origin}/media`, {
        method: 'POST',
        headers: { ...alice.headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'manual',
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
      privateResponse(response);
      expect(await response.json()).toMatchObject({ code: 'invalid_request', status: 400 });
      expect(calls.length).toBe(at);
    }
  },
  timeout,
);
