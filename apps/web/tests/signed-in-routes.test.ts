import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { createStoryRecordedKernelFetch } from '../src/kernel/fake';
import { readSessionState } from '../src/session/state';
import type { SessionEnv } from '../src/session/client';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
let visitor = 0;
const visitorHeaders = () => ({ 'CF-Connecting-IP': `192.0.2.${++visitor}` });
const routes = [
  ['library/index.tsx', '/library'],
  ['library/collections.tsx', '/library/collections'],
  ['library/copies.tsx', '/library/copies'],
  ['library/following.tsx', '/library/following'],
  ['library/progress.index.tsx', '/library/progress'],
  ['library/progress.$id.tsx', '/library/progress/example'],
  ['settings.tsx', '/settings'],
  ['collections/new.tsx', '/collections/new'],
  ['boards/$id_.new.tsx', '/boards/example/new'],
  ['orders/$id.tsx', '/orders/example'],
  ['curate/presentation.tsx', '/curate/presentation'],
  ['realms/index.tsx', '/realms'],
] as const;
const components = [
  'library/entries-page.tsx',
  'library/copies-page.tsx',
  'library/mine-collections-page.tsx',
  'library/mine-following-page.tsx',
  'library/progress-page.tsx',
  'library/progress-session.tsx',
  'library/logs-progress.tsx',
  'settings/settings-page.tsx',
  'community/my-realms-page.tsx',
  'features/pages/curate-view.tsx',
  'checkout/order-page.tsx',
];
const locales: string[] = await Bun.file(join(app, 'project.inlang/settings.json'))
  .json()
  .then((s) => s.locales);
let sessionReads = 0;
let kernelReads = 0;
let state = 'signed-out';
const recorded = createStoryRecordedKernelFetch();
const backend = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    if (new URL(request.url).pathname === '/session') {
      sessionReads++;
      return Response.json({ state, csrfToken: state === 'signed-in' ? 'cached-session-csrf' : null });
    }
    kernelReads++;
    return recorded(request);
  },
});
let child: ChildProcess | undefined;
let browser: Browser | undefined;
let directory: string | undefined;
let started: Promise<string> | undefined;
function site() {
  return (started ??= (async () => {
    const root = resolve(app, '../..');
    await mkdir(join(root, '.temp'), { recursive: true });
    directory = await mkdtemp(join(root, '.temp/signed-in-routes-'));
    const config = join(directory, 'vite.config.ts');
    // Substitute only the session store boundary. Routing, queries and loaders remain real.
    await Bun.write(
      config,
      `
      import config from ${JSON.stringify(pathToFileURL(join(app, 'vite.config.ts')).href)};
      export default { ...config, cacheDir: ${JSON.stringify(join(directory, 'cache'))}, plugins: [...config.plugins, {
        name: 'controlled-session-store', enforce: 'pre',
        transform(code, id) {
          if (id.endsWith('/src/router.tsx')) return code.replace('return router;', "if (typeof window !== 'undefined') window.__testRouter = router; return router;");
          if (id.endsWith('/src/session/state.ts')) return code.replace(
            'return readSessionIdentity(request, env);',
            'return (await fetch(${JSON.stringify(`${backend.url.origin}/session`)})).json();'
          );
        }
      }] };
    `,
    );
    const port = await new Promise<number>((done, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as { port: number };
        probe.close(() => done(port));
      });
    });
    let output = '';
    child = spawn(
      'bun',
      ['run', 'dev', '--config', config, '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
      {
        cwd: app,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, KERNEL_ORIGIN: backend.url.origin, PUBLIC_ORIGIN: 'https://www.rezics.test' },
      },
    );
    child.stdout!.on('data', (chunk) => (output = (output + chunk).slice(-12000)));
    child.stderr!.on('data', (chunk) => (output = (output + chunk).slice(-12000)));
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(output);
      try {
        if ((await fetch(`${origin}/en`)).status === 200) return origin;
      } catch {}
      await Bun.sleep(250);
    }
    throw new Error(`dev server did not serve /en in time:\n${output}`);
  })());
}
afterAll(async () => {
  await browser?.close();
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((done) => child!.once('exit', done));
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
    await exited;
  }
  backend.stop(true);
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('every signed-in route guards beforeLoad and every private or offer head uses pageHead noindex, nofollow', async () => {
  for (const [file] of routes) {
    const source = await Bun.file(join(app, 'src/routes', file)).text();
    expect(source, file).toMatch(/beforeLoad:\s*requireSignedIn/);
    expect(source, file).toMatch(/pageHead\(/);
    expect(source, file).toContain("robots: 'noindex, nofollow'");
    expect(source, file).not.toMatch(/session\s*===|session\s*!==|SignInPrompt/);
  }
  const offer = await Bun.file(join(app, 'src/routes/offers/$id.tsx')).text();
  expect(offer).toMatch(/pageHead\(/);
  expect(offer).toContain("robots: 'noindex, nofollow'");
  expect(offer).not.toContain('requireSignedIn');
  for (const file of components) {
    const source = await Bun.file(join(app, 'src', file)).text();
    expect(source, file).not.toMatch(
      /SignInPrompt|(?:if\s*\([^\n]*|\{!?)(?:page|progress)\.signedIn|current\.reason === 'signed-out'/,
    );
  }
});

test(
  'private pages, My Realms and the public offer produce noindex, nofollow metadata through their route heads',
  async () => {
    const origin = await site();
    state = 'signed-out';
    browser ??= await chromium.launch();
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders(visitorHeaders());
    try {
      const sessionResponse = page.waitForResponse((response) => response.url().includes('/_serverFn/'));
      await page.goto(origin + '/en');
      await page.waitForSelector('html[data-hydrated]');
      await sessionResponse;
      await page.waitForLoadState('networkidle');
      for (const [file, path] of [...routes, ['offers/$id.tsx', '/offers/example']]) {
        const head = await page.evaluate(
          async ({ file, path }) => {
            const route = await import('/src/routes/' + file);
            return route.Route.options.head({ match: { pathname: path } });
          },
          { file, path },
        );
        expect(head.meta, file).toContainEqual({ name: 'robots', content: 'noindex, nofollow' });
        expect(
          head.meta.some((meta: { title?: string }) => meta.title?.endsWith(' – REZICS')),
          file,
        ).toBe(true);
      }
    } finally {
      await page.close();
    }
  },
  timeout,
);

test(
  'signed-out GETs redirect 302 with the full localized path and search before any loader, with one session read and zero kernel reads',
  async () => {
    const origin = await site();
    state = 'signed-out';
    for (const [file, path] of routes) {
      for (const locale of locales) {
        sessionReads = kernelReads = 0;
        const target = `/${locale}${path}?cursor=a%2Fb&extra=keep`;
        const response = await fetch(origin + target, { redirect: 'manual', headers: visitorHeaders() });
        await response.text();
        expect(response.status, file + target).toBe(302);
        const location = new URL(response.headers.get('location')!, origin);
        expect(location.pathname).toBe('/auth/sign-in');
        expect(location.searchParams.get('return_to')).toBe(target);
        expect(sessionReads, target).toBe(1);
        expect(kernelReads, target).toBe(0);
      }
    }
  },
  timeout,
);

test(
  'client navigations use the cached session and redirect before loaders',
  async () => {
    const origin = await site();
    state = 'signed-out';
    browser ??= await chromium.launch();
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders(visitorHeaders());
    try {
      for (const [, path] of routes) {
        // Observe before navigation so a fast session response cannot race the observer.
        const sessionResponse = page.waitForResponse((response) => response.url().includes('/_serverFn/'));
        await page.goto(origin + '/en');
        await page.waitForSelector('html[data-hydrated]');
        await sessionResponse;
        await page.waitForLoadState('networkidle');
        sessionReads = kernelReads = 0;
        const target = `/en${path}?extra=keep%2Fthis`;
        await page.route('**/auth/sign-in?**', (route) =>
          route.fulfill({ status: 200, contentType: 'text/plain', body: 'Sign in' }),
        );
        const signIn = page.waitForRequest((request) => new URL(request.url()).pathname === '/auth/sign-in');
        // Use the application's router so this exercises navigation without a document GET.
        await page.evaluate((path) => {
          const router = (
            window as unknown as {
              __testRouter: { navigate: (options: { to: string; search: Record<string, string> }) => unknown };
            }
          ).__testRouter;
          void router.navigate({ to: path, search: { extra: 'keep/this' } });
        }, path);
        const request = await signIn;
        expect(new URL(request.url()).searchParams.get('return_to')).toBe(target);
        expect(sessionReads).toBe(0);
        expect(kernelReads).toBe(0);
      }
    } finally {
      await page.close();
    }
  },
  timeout,
);

test(
  'a protected server render hydrates the cached session and its CSRF token without another session read',
  async () => {
    const origin = await site();
    state = 'signed-in';
    browser ??= await chromium.launch();
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders(visitorHeaders());
    try {
      sessionReads = kernelReads = 0;
      await page.goto(origin + '/en/collections/new');
      await page.waitForSelector('html[data-hydrated]');
      await page.waitForLoadState('networkidle');
      const token = await page.evaluate(async () => {
        const { sessionCsrfToken } = await import('/src/session/query.ts');
        return sessionCsrfToken();
      });
      expect(token).toBe('cached-session-csrf');
      expect(sessionReads).toBe(1);
      expect(kernelReads).toBe(0);
    } finally {
      state = 'signed-out';
      await page.close();
    }
  },
  timeout,
);

test('a failed session-store read is unavailable rather than signed out', async () => {
  const session = await readSessionState(
    new Request('https://site.test/en/settings', {
      headers: { cookie: '__Host-rezics_session=' + 'a'.repeat(43) },
    }),
    {
      AUTH_ISSUER: 'https://auth.test',
      API_RESOURCE: 'https://api.test',
      WEBSITE_SCOPES: 'openid',
      WEBSITE_CLIENT_ID: 'website',
      WEBSITE_CLIENT_KEY: '{}',
      SESSIONS: {
        idFromName() {
          throw new Error('Store unavailable');
        },
      },
    } as unknown as SessionEnv,
  );
  expect(session.state).toBe('unavailable');
});

test(
  'an unavailable session shows the existing error page without running loaders or redirecting',
  async () => {
    const origin = await site();
    state = 'unavailable';
    sessionReads = kernelReads = 0;
    const response = await fetch(origin + '/en/settings', { redirect: 'manual', headers: visitorHeaders() });
    const html = await response.text();
    expect(response.headers.get('location')).toBeNull();
    expect(html).toContain((await Bun.file(join(app, 'messages/en.json')).json()).error_heading);
    expect(sessionReads).toBe(1);
    expect(kernelReads).toBe(0);
    state = 'signed-out';
  },
  timeout,
);

function blocked(robots: string, path: string) {
  return robots
    .split('\n')
    .filter((line) => line.startsWith('Disallow: '))
    .some((line) =>
      new RegExp(
        '^' +
          line
            .slice(10)
            .replace(/[.+?^{}()|[\]\\]/g, '\\$&')
            .replaceAll('*', '.*'),
      ).test(path),
    );
}
test(
  'robots.txt is a plain-text server route blocking private paths in every locale while allowing My Realms, offers and public pages',
  async () => {
    expect(await Bun.file(join(app, 'src/routes/robots[.]txt.ts')).exists()).toBe(true);
    const origin = await site();
    const response = await fetch(origin + '/robots.txt', { headers: visitorHeaders() });
    expect(response.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    const robots = await response.text();
    expect(robots).toContain('User-agent: *\nAllow: /\n');
    for (const locale of locales) {
      for (const [, path] of routes) expect(blocked(robots, `/${locale}${path}`), path).toBe(path !== '/realms');
      for (const path of [
        '/realms',
        '/realms/example',
        '/offers/example',
        '/subjects/example',
        '/collections/example',
        '/boards/example',
      ])
        expect(blocked(robots, `/${locale}${path}`), path).toBe(false);
    }
    for (const path of ['/auth/sign-in', '/auth/callback', '/_serverFn/example'])
      expect(blocked(robots, path), path).toBe(true);
  },
  timeout,
);

test(
  'only auth and server-function responses carry X-Robots-Tag noindex, including refused requests',
  async () => {
    const origin = await site();
    for (const path of ['/auth/unknown', '/auth/sign-out', '/_serverFn/unknown']) {
      for (const method of ['GET', 'POST']) {
        const response = await fetch(origin + path, {
          method,
          redirect: 'manual',
          headers: {
            ...visitorHeaders(),
            origin: 'https://outside.test',
            cookie: '__Host-rezics_session=' + 'a'.repeat(43),
          },
        });
        await response.text();
        expect(response.headers.get('x-robots-tag'), method + path).toBe('noindex');
      }
    }
    for (const path of ['/en', '/robots.txt', '/en/settings']) {
      const response = await fetch(origin + path, { redirect: 'manual', headers: visitorHeaders() });
      await response.text();
      expect(response.headers.get('x-robots-tag'), path).toBeNull();
    }
  },
  timeout,
);
