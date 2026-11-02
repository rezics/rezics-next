import { afterAll, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { createStoryRecordedKernelFetch } from '../src/kernel/fake';
import { readSessionState } from '../src/session/state';
import type { SessionEnv } from '../src/session/client';
import { cleanupAll, ownNodeProcess, withCleanup, type ProcessCustody } from './support/server-custody.ts';

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
let custody: ProcessCustody | undefined;
let directory: string | undefined;
let started: Promise<string> | undefined;
type ResourceScope = 'suite' | 'test';
type OwnedResource = { label: string; scope: ResourceScope; close: () => Promise<void> };
type ResourceLease<T> = OwnedResource & { value: Promise<T> };
const resources = new Set<OwnedResource>();
const resourceByValue = new WeakMap<object, OwnedResource>();
let browserLease: ResourceLease<Browser> | undefined;
let teardownStarted = false;

function ownResource<T extends object>(
  label: string,
  scope: ResourceScope,
  create: () => T | PromiseLike<T>,
  dispose: (resource: T) => unknown | PromiseLike<unknown>,
): ResourceLease<T> {
  if (teardownStarted) throw new Error(`${label} acquisition began after suite teardown`);
  let resource: T | undefined;
  let closing: Promise<void> | undefined;
  let lease!: ResourceLease<T>;
  const value = Promise.resolve()
    .then(create)
    .then((created) => {
      resource = created;
      resourceByValue.set(created, lease);
      if (teardownStarted) void lease.close().catch(() => {});
      return created;
    });
  void value.catch(() => {});
  const close = () =>
    (closing ??= (async () => {
      let current = resource;
      if (current === undefined) {
        try {
          current = await value;
        } catch {
          resources.delete(lease);
          return;
        }
      }
      await dispose(current);
      resources.delete(lease);
    })());
  lease = { label, scope, value, close };
  resources.add(lease);
  return lease;
}

function browserForTest(): Promise<Browser> {
  if (teardownStarted) throw new Error('Signed-in-routes browser acquisition began after suite teardown');
  browserLease ??= ownResource(
    'Signed-in-routes browser',
    'suite',
    () => chromium.launch(),
    (browser) => browser.close(),
  );
  return browserLease.value;
}

function resourceCleanupActions(scope?: ResourceScope, after?: Set<OwnedResource>) {
  return [...resources]
    .filter(
      (resource) => (scope === undefined || resource.scope === scope) && (after === undefined || !after.has(resource)),
    )
    .map((resource) => ({ label: resource.label, run: resource.close, timeoutMs: 6000 }));
}

function lifetimeTest(name: string, operation: () => void | Promise<void>, timeoutMs?: number): void {
  const run = async () => {
    const existing = new Set(resources);
    await withCleanup(operation, [
      {
        label: 'Signed-in-routes test pages',
        run: () => cleanupAll(resourceCleanupActions('test', existing)),
        timeoutMs: 8000,
      },
    ]);
  };
  if (timeoutMs === undefined) test(name, run);
  else test(name, run, timeoutMs);
}

function pageForTest(): Promise<Page> {
  if (teardownStarted) throw new Error('Signed-in-routes page acquisition began after suite teardown');
  return browserForTest().then((browser) => {
    const lease = ownResource(
      'Signed-in-routes browser page',
      'test',
      () => browser.newPage(),
      (page) => page.close(),
    );
    return lease.value;
  });
}

async function closePage(page: Page): Promise<void> {
  const resource = resourceByValue.get(page);
  await (resource ? resource.close() : page.close());
}
function site() {
  return (started ??= (async () => {
    let siteCustody: ProcessCustody | undefined;
    try {
      if (teardownStarted) throw new Error('Signed-in-routes Vite acquisition began after suite teardown');
      const root = resolve(app, '../..');
      await mkdir(join(root, '.temp'), { recursive: true });
      directory = await mkdtemp(join(root, '.temp/signed-in-routes-'));
      const config = join(directory, 'vite.config.ts');
      // Substitute only the session store boundary. Routing, queries and loaders remain real.
      await Bun.write(
        config,
        `
      import { resolveWebViteConfig } from ${JSON.stringify(pathToFileURL(join(app, 'tests/support/vite-config.ts')).href)};
      export default async (env) => {
        const config = await resolveWebViteConfig(env, ${JSON.stringify(app)});
        return { ...config, cacheDir: ${JSON.stringify(join(directory, 'cache'))}, plugins: [...(config.plugins ?? []), {
        name: 'controlled-session-store', enforce: 'pre',
        transform(code, id) {
          if (id.endsWith('/src/router.tsx')) return code.replace('return router;', "if (typeof window !== 'undefined') window.__testRouter = router; return router;");
          if (id.endsWith('/src/session/state.ts')) return code.replace(
            'return readSessionIdentity(request, env);',
            'return (await fetch(${JSON.stringify(`${backend.url.origin}/session`)})).json();'
          );
        }
      }] };
      };
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
      const origin = `http://127.0.0.1:${port}`;
      if (teardownStarted) throw new Error('Signed-in-routes Vite acquisition began after suite teardown');
      const child = spawn(
        'bun',
        ['run', 'dev', '--config', config, '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
        {
          cwd: app,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, KERNEL_ORIGIN: backend.url.origin, PUBLIC_ORIGIN: 'https://www.rezics.test' },
        },
      );
      siteCustody = ownNodeProcess(child, { label: 'Signed-in-routes Vite server', outputLimit: 12_000 });
      custody = siteCustody;
      const deadline = Date.now() + 150_000;
      while (Date.now() < deadline) {
        if (teardownStarted) throw new Error('Signed-in-routes Vite readiness ended when suite teardown began');
        if (child.exitCode !== null) throw new Error(siteCustody.diagnostics());
        try {
          if ((await fetch(`${origin}/en`, { signal: AbortSignal.timeout(60_000) })).status === 200) return origin;
        } catch {}
        await Bun.sleep(250);
      }
      throw new Error(`dev server did not serve /en in time:\n${siteCustody.diagnostics()}`);
    } catch (error) {
      if (siteCustody) {
        await withCleanup(async () => {
          throw error;
        }, [{ label: 'Signed-in-routes Vite startup', run: () => siteCustody!.close(), timeoutMs: 7000 }]);
      } else if (directory) {
        const partialDirectory = directory;
        await withCleanup(async () => {
          throw error;
        }, [
          {
            label: 'Partial signed-in-routes Vite fixture directory',
            run: async () => {
              await rm(partialDirectory, { recursive: true, force: true });
              if (directory === partialDirectory) directory = undefined;
            },
            timeoutMs: 5000,
          },
        ]);
      }
      throw error;
    }
  })());
}
afterAll(async () => {
  teardownStarted = true;
  await withCleanup(
    () =>
      withCleanup(
        () => cleanupAll(resourceCleanupActions('test')),
        [
          ...resourceCleanupActions('suite'),
          { label: 'Signed-in-routes Vite server', run: () => custody?.close(), timeoutMs: 7000 },
          { label: 'Signed-in-routes fixture backend', run: () => backend.stop(true), timeoutMs: 5000 },
        ],
      ),
    [
      {
        label: 'Signed-in-routes generated Vite config and cache directory',
        run: async () => {
          if (!directory) return;
          await started?.catch(() => {});
          if (!directory || (custody && !custody.settled)) return;
          const ownedDirectory = directory;
          await rm(ownedDirectory, { recursive: true, force: true });
          if (directory === ownedDirectory) directory = undefined;
        },
        timeoutMs: 5000,
      },
    ],
  );
});

lifetimeTest(
  'every signed-in route guards beforeLoad and every private or offer head uses pageHead noindex, nofollow',
  async () => {
    for (const [file] of routes) {
      const source = await Bun.file(join(app, 'src/routes', file)).text();
      if (file === 'library/progress.index.tsx' || file === 'library/progress.$id.tsx') {
        expect(source, file).toMatch(
          /beforeLoad:\s*async\s*\(args\)\s*=>\s*\{\s*await requireSignedIn\(args\);\s*await prepareExposure\(args\.context\.queryClient\);\s*\}/,
        );
      } else {
        expect(source, file).toMatch(/beforeLoad:\s*requireSignedIn/);
      }
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
  },
);

lifetimeTest(
  'private pages, My Realms and the public offer produce noindex, nofollow metadata through their route heads',
  async () => {
    const origin = await site();
    state = 'signed-out';
    const page = await pageForTest();
    await withCleanup(async () => {
      await page.setExtraHTTPHeaders(visitorHeaders());
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
    }, [{ label: 'Signed-in-routes metadata browser page', run: () => closePage(page), timeoutMs: 6000 }]);
  },
  timeout,
);

lifetimeTest(
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

lifetimeTest(
  'client navigations use the cached session and redirect before loaders',
  async () => {
    const origin = await site();
    state = 'signed-out';
    const page = await pageForTest();
    await withCleanup(async () => {
      await page.setExtraHTTPHeaders(visitorHeaders());
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
    }, [{ label: 'Signed-in-routes client navigation browser page', run: () => closePage(page), timeoutMs: 6000 }]);
  },
  timeout,
);

lifetimeTest(
  'a protected server render hydrates the cached session and its CSRF token without another session read',
  async () => {
    const origin = await site();
    state = 'signed-in';
    try {
      const page = await pageForTest();
      await withCleanup(async () => {
        await page.setExtraHTTPHeaders(visitorHeaders());
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
      }, [{ label: 'Signed-in-routes protected SSR browser page', run: () => closePage(page), timeoutMs: 6000 }]);
    } finally {
      state = 'signed-out';
    }
  },
  timeout,
);

lifetimeTest('a failed session-store read is unavailable rather than signed out', async () => {
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

lifetimeTest(
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
lifetimeTest(
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

lifetimeTest(
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
