import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';

const received: { path: string; cookie: string | null }[] = [];
const escaped: string[] = [];
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(request) {
    const url = new URL(request.url);
    received.push({ path: url.pathname + url.search, cookie: request.headers.get('cookie') });
    return new Response('Auth');
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

async function site(): Promise<string> {
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
    const response = await fetch(`${origin}${path}`, {
      headers: { cookie },
      redirect: 'manual',
      signal: AbortSignal.timeout(60_000),
    });
    await response.text();
  }
  expect(escaped, 'the second fake must never receive a forwarded request').toEqual([]);
  expect(received).toEqual(paths.map((path) => ({ path, cookie })));
}, 300_000);
