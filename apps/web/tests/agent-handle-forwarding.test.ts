import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { createFakeKernelFetch } from '../src/kernel/fake.ts';
import fixtures from '../src/kernel/fixtures.json';
import {
  agentAccount,
  demoAgentAccounts,
  demoAgentSubjects,
  renamedAgentAccount,
} from '../src/kernel/agent-fixtures.ts';

const app = join(import.meta.dir, '..');
const scaledAccounts = (size: number) => {
  const fixed = [demoAgentAccounts[0]!, ...(size > 1 ? [renamedAgentAccount] : [])];
  const extra = Array.from({ length: size - fixed.length }, (_, index) =>
    agentAccount({
      id: `0192f3a0-6c1e-7b2a-9d4e-${(0x800000000000 + index).toString(16)}`,
      handle: `unrelated-${index}`,
    }),
  );
  return [...fixed, ...extra];
};
let fixtureSize = 1;
let activeFake = createFakeKernelFetch({
  ...fixtures,
  subjects: [...fixtures.subjects, ...demoAgentSubjects],
  accounts: scaledAccounts(fixtureSize),
} as never);
const accountLookups: string[] = [];
const kernelTrace: string[] = [];
const kernel = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/v1/accounts' && url.searchParams.has('handle')) {
      const handle = url.searchParams.get('handle')!;
      accountLookups.push(handle);
      if (handle === 'former' && fixtureSize === 1) {
        kernelTrace.push(`GET /v1/accounts?handle=${handle} -> moved to mira`);
        return Response.json({ accounts: [{ movedTo: 'mira' }] });
      }
      if (handle === 'bad-former') {
        kernelTrace.push(`GET /v1/accounts?handle=${handle} -> bad move`);
        return Response.json({ accounts: [{ movedTo: '../mira' }] });
      }
      if (handle === 'failed-former') {
        kernelTrace.push(`GET /v1/accounts?handle=${handle} -> unavailable`);
        return Response.json({ error: 'unavailable' }, { status: 503 });
      }
      if (handle === 'retired' || handle === 'deleted') {
        kernelTrace.push(`GET /v1/accounts?handle=${handle} -> empty`);
        return Response.json({ accounts: [] });
      }
    }
    const response = await activeFake(request);
    kernelTrace.push(`${request.method} ${url.pathname}${url.search} -> ${response.status}`);
    return response;
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
let base: Promise<string> | undefined;
function mainContent(html: string): string {
  const content = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1];
  expect(content).toBeDefined();
  return content!;
}

function site(): Promise<string> {
  base ??= (async () => {
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
        PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
        AUTH_ISSUER: `${kernel.url.origin}/auth`,
        WEBSITE_CLIENT_ID: 'rezics-website',
        WEBSITE_CLIENT_KEY: '{}',
        API_RESOURCE: 'https://api.rezics.test',
        WEBSITE_SCOPES: 'openid',
      },
    });
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 240_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`dev server exited with ${child.exitCode}:\n${output}`);
      try {
        const response = await fetch(`${origin}/favicon.svg`, {
          redirect: 'manual',
          signal: AbortSignal.timeout(60_000),
        });
        if (response.status < 500) return origin;
      } catch {
        // Keep waiting while the dev server starts.
      }
      if (Date.now() > deadline) throw new Error(`dev server did not serve /en in time:\n${output}`);
      await Bun.sleep(500);
    }
  })();
  return base;
}

afterAll(() => {
  if (child?.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  kernel.stop(true);
});

test('a moved handle redirects to the current page in the same locale, view and query with a short public cache', async () => {
  const origin = await site();
  for (const size of [1, 100, 1000]) {
    fixtureSize = size;
    activeFake = createFakeKernelFetch({
      ...fixtures,
      subjects: [...fixtures.subjects, ...demoAgentSubjects],
      accounts: scaledAccounts(size),
    } as never);

    accountLookups.length = 0;
    const found = await fetch(`${origin}/en/@mira`);
    expect(found.status, `found page at ${size} accounts`).toBe(200);
    expect(accountLookups, `found page lookup count at ${size} accounts`).toEqual([]);

    accountLookups.length = 0;
    const missing = await fetch(`${origin}/en/@unknown-private-name`);
    expect(missing.status, `missing page at ${size} accounts`).toBe(404);
    expect(accountLookups, `missing page lookup count at ${size} accounts`).toEqual(['unknown-private-name']);

    accountLookups.length = 0;
    const response = await fetch(`${origin}/zh-Hant/@former/posts?cursor=c7&sort=recent`, { redirect: 'manual' });
    expect(response.status, `moved page at ${size} accounts; ${kernelTrace.join('\n')}`).toBe(302);
    expect(response.headers.get('location')).toBe('/zh-Hant/@mira/posts?cursor=c7&sort=recent');
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(accountLookups, `moved page lookup count at ${size} accounts`).toEqual(['former']);
  }
}, 300_000);

test('found pages skip handle lookup; missing and malformed moves make one lookup and never echo the request', async () => {
  accountLookups.length = 0;
  const found = await fetch(`${await site()}/en/@mira`);
  expect(found.status).toBe(200);
  expect(accountLookups).toEqual([]);

  let unknownPage: string | undefined;
  for (const handle of ['unknown-private-name', 'retired', 'deleted', 'bad-former', 'failed-former']) {
    accountLookups.length = 0;
    const response = await fetch(`${await site()}/en/@${handle}`);
    expect(response.status).toBe(404);
    const page = await response.text();
    expect(page).not.toContain(handle);
    if (handle === 'unknown-private-name') unknownPage = mainContent(page);
    else expect(mainContent(page), `${handle} should use the ordinary unknown-handle page`).toBe(unknownPage);
    expect(accountLookups).toEqual([handle]);
  }
}, 300_000);
