import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { createStoryRecordedKernelFetch, storyViewerId } from '../src/kernel/fake';
import spaceAddress from '../src/kernel/recorded/space-address.json';
import space from '../src/kernel/recorded/space.json';
import realm from '../src/kernel/recorded/realm.json';
import board from '../src/kernel/recorded/board.json';
import thread from '../src/kernel/recorded/thread.json';
import threadPosts from '../src/kernel/recorded/thread-posts.json';
import collection from '../src/kernel/recorded/library-collection.json';
import { threadHref } from '../src/threads/thread-href';

const app = join(import.meta.dir, '..');
const root = resolve(app, '../..');
const timeout = 300_000;
const sessionCookie = '__Host-rezics_session';
const sessionId = 'a'.repeat(43);
const readerCredential = 'Bearer anonymous-reads-reader';
const spaceId = spaceAddress.spaceId;
const realmId = realm.realm.realmId;
const boardId = board.board.id;
const threadId = thread.thread.id;
const collectionId = collection.collection.id;
const threadPath = `/en${threadHref({ id: threadId, title: thread.thread.title })}`;
const privateThreadId = '01a17a3b-09b4-77bf-a24b-1234ebeab5c3';
const privateThreadTitle = 'Members-only letters';
const privateThreadPath = `/en${threadHref({ id: privateThreadId, title: privateThreadTitle })}`;
const sessionCookieHeader = `${sessionCookie}=${sessionId}`;

type KernelCall = { method: string; path: string; authorization: string | null };
const kernelCalls: KernelCall[] = [];
let sessionReads = 0;
let credentialReads = 0;
let spaceAccess: 'public' | 'member' | 'non-member' = 'public';
let realmHasNoAddress = false;
let privateThreadEnabled = false;
let privateThreadAccess: 'member' | 'non-member' = 'member';
const recorded = createStoryRecordedKernelFetch();

const platformClosed = {
  type: 'https://rezics.com/problems/platform_closed',
  title: 'Platform Closed',
  status: 403,
  code: 'platform_closed',
  retryable: false,
  effect_status: 'not_applied',
  request_id: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
};
const notFound = {
  type: 'https://rezics.com/problems/not_found',
  title: 'Not Found',
  status: 404,
  code: 'not_found',
  retryable: false,
  effect_status: 'not_applicable',
  request_id: '0192f3a0-6c1e-7b2a-9d4e-000000000002',
};

const kernel = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/session-read') {
      sessionReads += 1;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/credential-read') {
      credentialReads += 1;
      return new Response(null, { status: 204 });
    }
    if (!url.pathname.startsWith('/v1/')) return new Response(null, { status: 404 });

    const authorization = request.headers.get('authorization');
    kernelCalls.push({ method: request.method, path: `${url.pathname}${url.search}`, authorization });

    if (url.pathname === `/v1/spaces/${spaceId}` && spaceAccess !== 'public') {
      const mayRead = authorization === readerCredential && spaceAccess === 'member';
      if (!mayRead)
        return Response.json(platformClosed, {
          status: 403,
          headers: { 'content-type': 'application/problem+json' },
        });
    }
    if (url.pathname === `/v1/threads/${privateThreadId}` && privateThreadEnabled) {
      if (authorization !== readerCredential || privateThreadAccess !== 'member')
        return Response.json(notFound, { status: 404, headers: { 'content-type': 'application/problem+json' } });
      return Response.json({
        thread: {
          ...thread.thread,
          id: privateThreadId,
          title: privateThreadTitle,
          authorId: storyViewerId,
          firstPost: { ...thread.thread.firstPost, authorId: storyViewerId, threadId: privateThreadId },
        },
      });
    }
    if (url.pathname === `/v1/threads/${privateThreadId}/posts` && privateThreadEnabled) {
      if (authorization !== readerCredential || privateThreadAccess !== 'member')
        return Response.json(notFound, { status: 404, headers: { 'content-type': 'application/problem+json' } });
      return Response.json({
        posts: threadPosts.posts.map((post) => ({ ...post, authorId: storyViewerId, threadId: privateThreadId })),
        next: threadPosts.next,
      });
    }
    if (url.pathname === `/v1/spaces/${space.space.spaceId}` && realmHasNoAddress)
      return Response.json({ space: { ...space.space, address: null } });
    return recorded(request);
  },
});

let child: ChildProcess | undefined;
let browser: Browser | undefined;
let started: Promise<string> | undefined;
let directory: string | undefined;
function reset() {
  kernelCalls.length = 0;
  sessionReads = 0;
  credentialReads = 0;
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolvePort(port));
    });
  });
}

function site(): Promise<string> {
  return (started ??= (async () => {
    await mkdir(join(root, '.temp'), { recursive: true });
    directory = await mkdtemp(join(root, '.temp/anonymous-reads-'));
    const config = join(directory, 'vite.config.ts');
    const sessionReadUrl = `${kernel.url.origin}/session-read`;
    const credentialReadUrl = `${kernel.url.origin}/credential-read`;
    await Bun.write(
      config,
      `
      import config from ${JSON.stringify(pathToFileURL(join(app, 'vite.config.ts')).href)};
      export default { ...config, cacheDir: ${JSON.stringify(join(directory, 'cache'))}, plugins: [...config.plugins, {
        name: 'anonymous-reads-session-fixture', enforce: 'pre',
        transform(code, id) {
          if (!id.endsWith('/src/session/store.ts')) return;
          return code
            .replace(
              'async signedIn(): Promise<{ signedIn: boolean; subject?: string; csrfToken: string | null }> {',
              'async signedIn(): Promise<{ signedIn: boolean; subject?: string; csrfToken: string | null }> { await fetch(${JSON.stringify(sessionReadUrl)}); return { signedIn: true, subject: ${JSON.stringify(thread.thread.authorId)}, csrfToken: "anonymous-reads-csrf" };',
            )
            .replace(
              'credential(): Promise<Credential> {',
              'credential(): Promise<Credential> { return fetch(${JSON.stringify(credentialReadUrl)}).then(() => ({ status: "active", subject: ${JSON.stringify(storyViewerId)}, accessToken: "anonymous-reads-reader", csrfToken: "anonymous-reads-csrf" }));',
            );
        }
      }] };
      `,
    );
    const port = await freePort();
    const origin = `http://localhost:${port}`;
    let output = '';
    const keep = (chunk: Buffer) => (output = (output + chunk.toString()).slice(-12000));
    child = spawn(
      'bun',
      ['run', 'dev', '--config', config, '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
      {
        cwd: app,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          KERNEL_ORIGIN: kernel.url.origin,
          PUBLIC_ORIGIN: origin,
          AUTH_ISSUER: `${kernel.url.origin}/auth`,
          WEBSITE_CLIENT_ID: 'rezics-anonymous-reads',
          WEBSITE_CLIENT_KEY: JSON.stringify({ kty: 'EC', crv: 'P-256', d: 'fixture', kid: 'anonymous-reads' }),
          API_RESOURCE: 'https://api.rezics.test',
          WEBSITE_SCOPES: 'media:create media:read media:complete media:erase',
        },
      },
    );
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`dev server exited with ${child.exitCode}:\n${output}`);
      try {
        if ((await fetch(`${origin}/en`)).status < 500) return origin;
      } catch {}
      await Bun.sleep(250);
    }
    throw new Error(`dev server did not start:\n${output}`);
  })());
}

async function signedInPage(origin: string): Promise<Page> {
  browser ??= await chromium.launch();
  const context = await browser.newContext();
  const cookieUrl = new URL(origin);
  cookieUrl.protocol = 'https:';
  await context.addCookies([
    { name: sessionCookie, value: sessionId, url: cookieUrl.href, secure: true, sameSite: 'Lax' },
  ]);
  const page = await context.newPage();
  // Keep session counts scoped to page data reads; cover authorization has its own session path.
  const appOrigin = new URL(origin).origin;
  await page.route(
    (url) => url.origin === appOrigin && url.pathname.startsWith('/media/'),
    (route) => route.abort(),
  );
  return page;
}

afterAll(async () => {
  await browser?.close();
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
  kernel.stop(true);
  if (directory) await rm(directory, { recursive: true, force: true });
});

test(
  'Space, Realm, board, thread and collection server renders do not resolve a session or send a credential',
  async () => {
    const origin = await site();
    const paths = [
      `/en/spaces/${spaceAddress.address}`,
      `/en/realms/${realmId}`,
      `/en/boards/${boardId}`,
      threadPath,
      `/en/collections/${collectionId}`,
    ];
    for (const path of paths) {
      reset();
      const response = await fetch(`${origin}${path}`, { headers: { cookie: sessionCookieHeader } });
      expect(response.status).toBe(200);
      expect(sessionReads).toBe(0);
      expect(credentialReads).toBe(0);
      expect(kernelCalls.length).toBeGreaterThan(0);
      expect(kernelCalls.map((call) => call.authorization)).toEqual(kernelCalls.map(() => null));
    }
  },
  timeout,
);

test(
  'the signed-in Space browser reads membership after hydration without rereading the page',
  async () => {
    const origin = await site();
    reset();
    const page = await signedInPage(origin);
    await page.goto(`${origin}/en/spaces/${spaceAddress.address}`);
    await page.locator('html[data-hydrated]').waitFor();
    await page.locator('[data-member-state]').waitFor();
    expect(await page.locator('[data-member-state]').getAttribute('data-member-state')).toBe('none');
    await page.getByRole('button', { name: 'Join' }).waitFor();
    await page.waitForLoadState('networkidle');
    const spaceReads = kernelCalls.filter((call) => call.path === `/v1/spaces/${spaceId}`);
    expect(spaceReads).toHaveLength(1);
    expect(spaceReads.map((call) => call.authorization)).toEqual([null]);
    const memberReads = kernelCalls.filter((call) => call.path === `/v1/realms/${realmId}/members/me`);
    expect(memberReads).toHaveLength(1);
    expect(memberReads[0]?.authorization).toBe(readerCredential);
    expect(sessionReads).toBe(1);
    expect(credentialReads).toBe(1);
    await page.context().close();
  },
  timeout,
);

test(
  'a signed-in Realm page reads membership after hydration without rereading its page',
  async () => {
    const origin = await site();
    reset();
    realmHasNoAddress = true;
    const page = await signedInPage(origin);
    await page.goto(`${origin}/en/realms/${realmId}`);
    await page.locator('html[data-hydrated]').waitFor();
    await page.locator('[data-member-state="none"]').waitFor();
    await page.getByRole('button', { name: 'Join' }).waitFor();
    await page.waitForLoadState('networkidle');
    const realmReads = kernelCalls.filter((call) => call.path === `/v1/realms/${realmId}`);
    expect(realmReads).toHaveLength(1);
    expect(realmReads.map((call) => call.authorization)).toEqual([null]);
    const memberReads = kernelCalls.filter((call) => call.path === `/v1/realms/${realmId}/members/me`);
    expect(memberReads).toHaveLength(1);
    expect(memberReads[0]?.authorization).toBe(readerCredential);
    expect(sessionReads).toBe(1);
    expect(credentialReads).toBe(1);
    realmHasNoAddress = false;
    await page.context().close();
  },
  timeout,
);

test(
  'a signed-in marked board rereads once after hydration and keeps the session mode for navigation',
  async () => {
    const origin = await site();
    reset();
    const page = await signedInPage(origin);
    await page.goto(`${origin}/en/boards/${boardId}`);
    await page.locator('html[data-hydrated]').waitFor();
    await page.locator(`a[href="/en/boards/${boardId}/new"]`).waitFor();
    await page.waitForLoadState('networkidle');
    const boardReads = kernelCalls.filter((call) => call.path === `/v1/boards/${boardId}`);
    const threadListReads = kernelCalls.filter((call) => call.path.startsWith(`/v1/boards/${boardId}/threads`));
    expect(boardReads).toHaveLength(2);
    expect(threadListReads).toHaveLength(2);
    expect(boardReads.map((call) => call.authorization)).toEqual([null, null]);
    expect(threadListReads.map((call) => call.authorization)).toEqual([null, null]);
    await page.getByRole('link', { name: thread.thread.title }).click();
    await page.waitForURL((url) => url.pathname === threadPath);
    await page.getByRole('heading', { name: thread.thread.title }).waitFor();
    await page.waitForLoadState('networkidle');
    const threadRead = kernelCalls.filter((call) => call.path === `/v1/threads/${threadId}`);
    expect(threadRead).toHaveLength(1);
    expect(threadRead[0]?.authorization).toBe(readerCredential);
    expect(sessionReads).toBe(1);
    expect(credentialReads).toBe(1);
    await page.context().close();
  },
  timeout,
);

test(
  'a signed-in collection rereads once and restores the curator controls',
  async () => {
    const origin = await site();
    reset();
    const page = await signedInPage(origin);
    await page.goto(`${origin}/en/collections/${collectionId}`);
    await page.locator('html[data-hydrated]').waitFor();
    await page.locator('[data-visibility="public"]').waitFor();
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    await page.getByRole('textbox', { name: 'Title' }).waitFor();
    await page.waitForLoadState('networkidle');
    const collectionReads = kernelCalls.filter((call) => call.path.startsWith(`/v1/collections/${collectionId}?`));
    const memberReads = kernelCalls.filter((call) => call.path.startsWith(`/v1/collections/${collectionId}/members`));
    expect(collectionReads).toHaveLength(2);
    expect(memberReads).toHaveLength(2);
    expect(collectionReads.map((call) => call.authorization)).toEqual([null, readerCredential]);
    expect(memberReads.map((call) => call.authorization)).toEqual([null, readerCredential]);
    expect(sessionReads).toBe(1);
    expect(credentialReads).toBe(1);
    await page.context().close();
  },
  timeout,
);

test(
  'an anonymous reader gets one protected Space read set and signed-in members and non-members get two',
  async () => {
    const origin = await site();
    const path = `/en/spaces/${spaceAddress.address}`;

    reset();
    spaceAccess = 'member';
    const anonymous = await fetch(`${origin}${path}`);
    expect(anonymous.status).toBe(403);
    expect(kernelCalls.filter((call) => call.path === `/v1/spaceAddresses/${spaceAddress.address}`)).toHaveLength(1);
    expect(kernelCalls.filter((call) => call.path === `/v1/spaces/${spaceId}`)).toHaveLength(1);
    expect(kernelCalls).toHaveLength(2);
    expect(sessionReads).toBe(0);
    expect(credentialReads).toBe(0);

    for (const access of ['member', 'non-member'] as const) {
      reset();
      spaceAccess = access;
      const page = await signedInPage(origin);
      const response = await page.goto(`${origin}${path}`);
      await page.locator('html[data-hydrated]').waitFor();
      if (access === 'member') await page.getByRole('heading', { name: space.space.title }).waitFor();
      else await page.getByRole('heading', { name: /not open yet/i }).waitFor();
      await page.waitForLoadState('networkidle');
      expect(response?.status()).toBe(403);
      expect(kernelCalls.filter((call) => call.path === `/v1/spaceAddresses/${spaceAddress.address}`)).toHaveLength(2);
      const reads = kernelCalls.filter((call) => call.path === `/v1/spaces/${spaceId}`);
      expect(reads).toHaveLength(2);
      expect(reads.map((call) => call.authorization)).toEqual([null, readerCredential]);
      const anonymousReads = kernelCalls.filter((call) => call.authorization === null);
      const sessionReadsFromKernel = kernelCalls.filter((call) => call.authorization === readerCredential);
      expect(anonymousReads).toHaveLength(2);
      expect(sessionReadsFromKernel).toHaveLength(access === 'member' ? 12 : 2);
      expect(kernelCalls).toHaveLength(access === 'member' ? 14 : 4);
      expect(sessionReads).toBe(1);
      expect(credentialReads).toBe(1);
      const html = await page.locator('html').innerHTML();
      if (access === 'non-member')
        expect(html).toMatch(/name="robots"[^>]*content="noindex"|content="noindex"[^>]*name="robots"/);
      await page.context().close();
    }
    spaceAccess = 'public';
  },
  timeout,
);

test(
  'a not-found thread becomes visible for a signed-in reader, with at most one reread',
  async () => {
    const origin = await site();
    reset();
    privateThreadEnabled = true;
    privateThreadAccess = 'member';
    const page = await signedInPage(origin);
    const response = await page.goto(`${origin}${privateThreadPath}`);
    await page.locator('html[data-hydrated]').waitFor();
    await page.getByRole('heading', { name: privateThreadTitle }).waitFor();
    await page
      .getByRole('button', { name: /more actions/i })
      .first()
      .click();
    await page.getByRole('menuitem', { name: 'Edit' }).waitFor();
    await page.waitForLoadState('networkidle');
    expect(response?.status()).toBe(404);
    const reads = kernelCalls.filter((call) => call.path === `/v1/threads/${privateThreadId}`);
    expect(reads).toHaveLength(2);
    expect(reads.map((call) => call.authorization)).toEqual([null, readerCredential]);
    const postReads = kernelCalls.filter((call) => call.path === `/v1/threads/${privateThreadId}/posts`);
    expect(postReads).toHaveLength(1);
    expect(postReads[0]?.authorization).toBe(readerCredential);
    expect(sessionReads).toBe(1);
    expect(credentialReads).toBe(1);
    privateThreadEnabled = false;
    await page.context().close();
  },
  timeout,
);

test(
  'a not-found thread stays not found for a signed-in reader without access, with only one reread',
  async () => {
    const origin = await site();
    reset();
    privateThreadEnabled = true;
    privateThreadAccess = 'non-member';
    const page = await signedInPage(origin);
    const response = await page.goto(`${origin}${privateThreadPath}`);
    await page.locator('html[data-hydrated]').waitFor();
    await page.getByRole('heading', { name: 'Page not found' }).waitFor();
    await page.waitForLoadState('networkidle');
    expect(response?.status()).toBe(404);
    const reads = kernelCalls.filter((call) => call.path === `/v1/threads/${privateThreadId}`);
    expect(reads).toHaveLength(2);
    expect(reads.map((call) => call.authorization)).toEqual([null, readerCredential]);
    expect(sessionReads).toBe(1);
    expect(credentialReads).toBe(1);
    expect(await page.locator('html').innerHTML()).toMatch(
      /name="robots"[^>]*content="noindex"|content="noindex"[^>]*name="robots"/,
    );
    privateThreadEnabled = false;
    privateThreadAccess = 'member';
    await page.context().close();
  },
  timeout,
);

test('closed and not-found pages return their real status and robots noindex', async () => {
  const origin = await site();
  reset();
  spaceAccess = 'non-member';
  const closed = await fetch(`${origin}/en/spaces/${spaceAddress.address}`, {
    headers: { cookie: sessionCookieHeader },
  });
  expect(closed.status).toBe(403);
  expect(await closed.text()).toMatch(/name="robots"[^>]*content="noindex"|content="noindex"[^>]*name="robots"/);
  expect(sessionReads).toBe(0);
  expect(credentialReads).toBe(0);

  reset();
  spaceAccess = 'public';
  const missing = await fetch(`${origin}/en/route-that-does-not-exist`);
  expect(missing.status).toBe(404);
  expect(await missing.text()).toMatch(/name="robots"[^>]*content="noindex"|content="noindex"[^>]*name="robots"/);
});

test('public community routes omit session rereads while personalized routes retain them', async () => {
  for (const path of ['spaces/$address', 'realms/$id']) {
    const source = await Bun.file(join(app, `src/routes/${path}.tsx`)).text();
    expect(source).not.toContain('sessionReread: true');
  }
  for (const path of ['boards/$id', 'threads/$id_.$slug', 'collections/$id']) {
    const source = await Bun.file(join(app, `src/routes/${path}.tsx`)).text();
    expect(source).toContain('sessionReread: true');
  }
});
