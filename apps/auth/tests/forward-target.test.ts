import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { get } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';

const received: { path: string; cookie: string | null }[] = [];
const forwarded: { path: string; method: string; body: string; headers: Record<string, string> }[] = [];
const escaped: string[] = [];
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    received.push({ path: url.pathname + url.search, cookie: request.headers.get('cookie') });
    forwarded.push({
      path: url.pathname + url.search,
      method: request.method,
      body: await request.text(),
      headers: Object.fromEntries(request.headers),
    });
    return new Response('Auth', {
      status: 202,
      headers: { 'cache-control': 'no-store', 'set-cookie': 'auth_session=renewed; HttpOnly; SameSite=Lax' },
    });
  },
});
const other = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(request) {
    escaped.push(request.url);
    return new Response('Other host');
  },
});
let child: ChildProcess | undefined;
let started: Promise<string> | undefined;

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

function site(): Promise<string> {
  return (started ??= startSite());
}

async function startSite(): Promise<string> {
  const port = await freePort();
  let output = '';
  const keep = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-8000);
  };
  child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: join(import.meta.dir, '..'),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AUTH_ORIGIN: fake.url.origin },
  });
  let startError: Error | undefined;
  child.on('error', (error) => {
    startError = error;
  });
  child.stdout!.on('data', keep);
  child.stderr!.on('data', keep);
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 150_000;
  for (;;) {
    if (startError) throw startError;
    if (child.exitCode !== null) throw new Error(`dev server exited with ${child.exitCode}:\n${output}`);
    try {
      const response = await fetch(`${origin}/login`, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
      await response.text();
      if (response.status < 500) return origin;
    } catch {}
    if (Date.now() > deadline) throw new Error(`dev server did not serve /login in time:\n${output}`);
    await Bun.sleep(500);
  }
}

afterAll(() => {
  fake.stop(true);
  other.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

test('a forwarded path always reaches AUTH_ORIGIN, even when it starts with two slashes', async () => {
  const origin = await site();
  const paths = [`//127.0.0.1:${other.port}/x?y=1`, `/%2F%2F127.0.0.1:${other.port}/x?y=1`];
  const cookie = 'auth_session=opaque-session';
  for (const path of paths) {
    // Use absolute-form HTTP so Bun's fetch and Vite's URL resolution cannot rewrite the leading slashes.
    await new Promise<void>((resolve, reject) => {
      const request = get(origin, { path: `${origin}${path}`, headers: { cookie } }, (response) => {
        response.resume();
        response.once('end', resolve);
        response.once('error', reject);
      });
      request.once('error', reject);
      request.setTimeout(60_000, () => request.destroy(new Error('forwarded request timed out')));
    });
  }
  expect(escaped, 'the second fake must never receive a forwarded request').toEqual([]);
  expect(received).toEqual(paths.map((path) => ({ path, cookie })));
}, 300_000);

test('POST /consent and POST /signup reach Auth unchanged and return its answer without page headers', async () => {
  const origin = await site();
  for (const path of ['/consent', '/signup']) {
    const body = '{ "client_id": "reader+client", "scope": ["openid"] }';
    const headers = {
      'content-type': 'application/json',
      cookie: 'auth_session=opaque-session; rezics_locale=fr',
      origin,
      'x-client-request': 'preserved',
    };
    const before = forwarded.length;
    const response = await fetch(`${origin}${path}?source=client`, { method: 'POST', body, headers });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('Auth');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toBe('auth_session=renewed; HttpOnly; SameSite=Lax');
    expect(response.headers.has('content-security-policy')).toBe(false);
    expect(response.headers.has('x-frame-options')).toBe(false);
    expect(response.headers.has('set-cookie') && response.headers.get('set-cookie')).not.toContain('rezics_locale');
    expect(forwarded.slice(before)).toEqual([
      { path: `${path}?source=client`, method: 'POST', body, headers: expect.objectContaining(headers) },
    ]);
  }
}, 300_000);

test('GET and HEAD still render page paths without reaching Auth', async () => {
  const origin = await site();
  for (const path of ['/consent', '/signup']) {
    for (const method of ['GET', 'HEAD']) {
      const before = forwarded.length;
      const response = await fetch(`${origin}${path}`, { method, headers: { 'accept-language': 'en' } });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      const body = await response.text();
      if (method === 'HEAD') expect(body).toBe('');
      else expect(body).toContain(path === '/consent' ? 'Review permissions' : 'Create an account');
      expect(forwarded).toHaveLength(before);
    }
  }
}, 300_000);
