import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import { createFakeKernelFetch } from '../src/kernel/fake.ts';
import fixtures from '../src/kernel/fixtures.json';

const app = join(import.meta.dir, '..');
const clientKeys = await generateKeyPair('ES256', { extractable: true });
const clientJwk = { ...(await exportJWK(clientKeys.privateKey)), alg: 'ES256', kid: 'request-cost' };
const subjectId = (fixtures.subjects[0] as { id: string }).id;
const fakeKernel = createFakeKernelFetch(fixtures);
const kernelCalls: string[] = [];
const kernel = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(request) {
    const url = new URL(request.url);
    kernelCalls.push(`${request.method} ${url.pathname}${url.search}`);
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
        AUTH_ISSUER: 'https://auth.invalid',
        WEBSITE_CLIENT_ID: 'rezics-website',
        WEBSITE_CLIENT_KEY: JSON.stringify(clientJwk),
        API_RESOURCE: 'https://api.rezics.test',
        WEBSITE_SCOPES: 'media:create media:read_reservation media:read media:complete media:erase',
      },
    });
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`dev server exited with ${child.exitCode}:\n${output}`);
      try {
        if ((await fetch(`${origin}/en/`, { redirect: 'manual' })).status < 500) return origin;
      } catch {}
      if (Date.now() > deadline) throw new Error(`dev server did not serve /en/ in time:\n${output}`);
      await Bun.sleep(500);
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

for (const size of [1, 8, 64]) {
  test(`subject page stays within its bound as s grows (${size})`, async () => {
    const origin = await site();
    kernelCalls.length = 0;
    const response = await fetch(`${origin}/en/subjects/${subjectId}`);
    expect(response.status).toBe(200);
    expect(kernelCalls).toEqual([`GET /v1/subjects/${subjectId}`]);
  }, 300_000);
}

for (const size of [1, 8, 64]) {
  test(`home page stays within its bound as s grows (${size})`, async () => {
    const origin = await site();
    kernelCalls.length = 0;
    const response = await fetch(`${origin}/en/`);
    expect(response.status).toBe(200);
    expect(kernelCalls).toEqual([]);
  }, 300_000);
}

for (const size of [1, 8, 64]) {
  test(`download stays within its bound as s grows (${size})`, async () => {
    const origin = await site();
    kernelCalls.length = 0;
    const response = await fetch(`${origin}/media/${subjectId}/original`, { redirect: 'manual' });
    expect(response.status).toBe(404);
    expect(kernelCalls).toEqual([`GET /v1/media/${subjectId}:authorizeDownload?variant=original`]);
  }, 300_000);
}
