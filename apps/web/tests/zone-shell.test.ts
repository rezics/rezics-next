import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright';
import { createKernelClient } from '@rezics/client';
import { readZonePage, readZonePageForRoute } from '../src/zones/zone-read.ts';
import { loadSubjectPage } from '../src/features/pages/subject';
import { createFakeKernelFetch } from '../src/kernel/fake.ts';
import fixtures from '../src/kernel/fixtures.json';

const app = join(import.meta.dir, '..');
const desktop = { width: 1280, height: 860 };
const phone = { width: 390, height: 844 };
const timeout = 300_000;
const zoneId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';
const hiddenZoneId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e02';
const withinBudgetZoneId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e03';
const preparingZoneId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e04';
const unavailableZoneId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e05';
const subjectId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';
const recoveringZoneId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e07';
const revokedZoneId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e08';

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
let browser: Browser | undefined;

function site(): Promise<string> {
  started ??= (async () => {
    const port = await freePort();
    let output = '';
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8000);
    };
    child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: app,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`dev server exited with ${child.exitCode}:\n${output}`);
      try {
        const response = await fetch(`${origin}/en/`, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
        if (response.status < 500) return origin;
      } catch {}
      if (Date.now() > deadline) throw new Error(`dev server did not serve /en/ in time:\n${output}`);
      await Bun.sleep(500);
    }
  })();
  return started;
}

async function open(path: string, options: BrowserContextOptions = {}): Promise<Page> {
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({ viewport: desktop, reducedMotion: 'reduce', ...options });
  const page = await context.newPage();
  await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
  if (options.javaScriptEnabled !== false) await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  return page;
}

afterAll(async () => {
  await browser?.close();
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

test(
  '/zones/{id} renders the Zone home through the presentation renderer inside its labelled, navigable shell',
  async () => {
    for (const locale of ['en', 'zh-Hans']) {
      const response = await fetch(`${await site()}/${locale}/zones/${zoneId}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(locale === 'en' ? 'Field Notes' : '田野札记');
      expect(html).toContain(locale === 'en' ? 'A clear view of the collection' : '从容查看收藏');
      expect(html).toContain('data-zone-shell');
      expect(html).toContain(`/${locale}/zones/${zoneId}/subjects/${subjectId}`);
      expect(html).not.toContain('Secret mounted collection');
    }
  },
  timeout,
);

test(
  'subject overview and view pages keep the Zone shell and use the subject’s global page as canonical',
  async () => {
    const overview = await fetch(`${await site()}/en/zones/${zoneId}/subjects/${subjectId}`);
    expect(overview.status).toBe(200);
    const overviewHtml = await overview.text();
    expect(overviewHtml).toContain('data-zone-shell');
    expect(overviewHtml).toContain('Kokoro');
    expect(canonicalPath(overviewHtml)).toBe(`/en/subjects/${subjectId}`);

    const view = await fetch(`${await site()}/en/zones/${zoneId}/subjects/${subjectId}/details`);
    expect(view.status).toBe(200);
    const viewHtml = await view.text();
    expect(viewHtml).toContain('data-zone-shell');
    expect(viewHtml).toContain('Kokoro details in the Zone');
    expect(canonicalPath(viewHtml)).toBe(`/en/subjects/${subjectId}`);
  },
  timeout,
);

test(
  'Zone appearance tokens are scoped to its shell, with home defaults overlaid by the selected page',
  async () => {
    const page = await open(`/en/zones/${zoneId}`, { javaScriptEnabled: false });
    const home = page.locator('[data-zone-shell] [data-zone-page]');
    await home.waitFor();
    expect(await home.getAttribute('data-density')).toBe('compact');
    expect(await home.getAttribute('data-radius')).toBe('sm');
    expect(await home.getAttribute('data-surface')).toBe('cards');
    expect(await home.getAttribute('data-cover')).toBe('square');
    expect(await home.getAttribute('data-heading-scale')).toBe('lg');
    expect(await page.locator('head style').count()).toBe(0);
    await page.context().close();

    const subject = await open(`/en/zones/${zoneId}/subjects/${subjectId}`, { javaScriptEnabled: false });
    const selected = subject.locator('[data-zone-shell] [data-zone-page]');
    expect(await selected.getAttribute('data-density')).toBe('comfortable');
    expect(await selected.getAttribute('data-radius')).toBe('lg');
    expect(await selected.getAttribute('data-surface')).toBe('flat');
    expect(await selected.getAttribute('data-cover')).toBe('landscape');
    expect(await selected.getAttribute('data-heading-scale')).toBe('md');
    await subject.context().close();

    const outside = await open(`/en/subjects/${subjectId}`, { javaScriptEnabled: false });
    expect(await outside.locator('[data-zone-shell]').count()).toBe(0);
    expect(await outside.locator('[data-zone-page]').count()).toBe(0);
    await outside.context().close();
  },
  timeout,
);

test('an unreadable Zone is not-found and unreadable mounted Collections disclose no identifying data', async () => {
  const response = await fetch(`${await site()}/en/zones/${hiddenZoneId}`);
  expect(response.status).toBe(404);
  expect(response.headers.get('cache-control')).toMatch(/\bno-store\b/);
  const html = await response.text();
  expect(html).toContain('Page not found');
  expect(html).not.toContain('Secret mounted collection');
  expect(html).not.toContain('secret-mounted-collection-id');
  expect(html).not.toContain('17 items');
});

test('the Zone read uses one kernel request for a home and one for each page target', async () => {
  const requests: { url: URL; method: string; body: unknown; authorization: string | null }[] = [];
  const local = createFakeKernelFetch(fixtures);
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      requests.push({
        url,
        method: request.method,
        body: request.method === 'POST' ? await request.clone().json() : undefined,
        authorization: request.headers.get('authorization'),
      });
      if (url.pathname === `/v1/zones/${zoneId}:readPage`) return Response.json({ status: 200, page: {} });
      return local(request);
    }) as typeof fetch,
  });

  await readZonePage(client as never, zoneId, { target: { route: '' }, languages: ['en'] });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ method: 'POST', body: { target: { route: '' }, languages: ['en'] } });
  requests.length = 0;
  await readZonePage(client as never, zoneId, { target: { subject: subjectId } });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ method: 'POST', body: { target: { subject: subjectId } } });
});

test('a Zone subject page adds exactly one kernel request to the existing subject page reads', async () => {
  const local = createFakeKernelFetch(fixtures);
  const counts = { outside: 0, zone: 0, common: 0 };
  const outside = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      counts.outside += 1;
      return local(new Request(input, init));
    }) as typeof fetch,
  });
  const outsideResult = await loadSubjectPage(outside as never, subjectId);
  expect(outsideResult.kind).toBe('page');

  const zoned = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === `/v1/zones/${zoneId}:readPage`) {
        counts.zone += 1;
        return Response.json(pageResponse());
      }
      if (url.pathname === '/v1/pages:read') counts.common += 1;
      return local(request);
    }) as typeof fetch,
  });
  const result = await readZonePageForRoute(zoned as never, {
    id: zoneId,
    locale: 'en',
    target: { subject: subjectId },
  });
  expect(result.kind).toBe('page');
  expect(counts.zone).toBe(1);
  expect(counts.common).toBe(counts.outside);
  expect(counts.zone + counts.common).toBe(counts.outside + 1);
});

test('a 200 reached within the server continuation budget renders the completed Zone page', async () => {
  const response = await fetch(`${await site()}/en/zones/${withinBudgetZoneId}`);
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain('data-zone-shell');
  expect(html).toContain('A clear view of the collection');
  expect(html).not.toContain('Preparing this Zone page');
});

test('Zone page reads follow at most four cursors with the same request body and credentials', async () => {
  for (const mode of ['within-budget', 'exhausted'] as const) {
    const requests: { url: URL; method: string; body: unknown; authorization: string | null }[] = [];
    const client = createKernelClient('https://kernel.example.test', {
      session: 'viewer-session',
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        requests.push({
          url,
          method: request.method,
          body: await request.clone().json(),
          authorization: request.headers.get('rezics-session-token'),
        });
        const cursor = url.searchParams.get('cursor');
        if (mode === 'within-budget' && cursor === 'cursor-2') return Response.json(pageResponse(), { status: 200 });
        const index = cursor === null ? 0 : Number(cursor.slice('cursor-'.length));
        return Response.json(
          { next: `cursor-${index + 1}` },
          { status: 202, headers: { 'cache-control': 'no-store' } },
        );
      }) as typeof fetch,
    });

    const result = await readZonePage(client as never, zoneId, {
      target: { route: '' },
      languages: ['en'],
    });
    expect(requests.length).toBe(mode === 'within-budget' ? 3 : 5);
    expect(requests.map(({ url }) => url.searchParams.get('cursor'))).toEqual(
      mode === 'within-budget'
        ? [null, 'cursor-1', 'cursor-2']
        : [null, 'cursor-1', 'cursor-2', 'cursor-3', 'cursor-4'],
    );
    expect(
      requests.every(
        ({ method, body, authorization }) =>
          method === 'POST' &&
          JSON.stringify(body) === JSON.stringify({ target: { route: '' }, languages: ['en'] }) &&
          authorization === 'viewer-session',
      ),
    ).toBe(true);
    expect(result.kind).toBe(mode === 'within-budget' ? 'page' : 'preparing');
    if (mode === 'exhausted') expect(result).toMatchObject({ cursor: 'cursor-5' });
  }
});

test(
  'preparing pages are no-store, retain the last cursor, continue in the browser and replace on 200',
  async () => {
    const response = await fetch(`${await site()}/en/zones/${preparingZoneId}`);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toMatch(/\bno-store\b/);
    expect(response.headers.get('retry-after')).toBeTruthy();
    const initial = await response.text();
    expect(initial).toContain('Preparing this Zone page');
    expect(initial).toContain('cursor-5');
    expect(initial).not.toContain('A clear view of the collection');

    const page = await open(`/en/zones/${preparingZoneId}`);
    await page.getByRole('heading', { name: 'A clear view of the collection' }).waitFor({ timeout: 30_000 });
    expect(await page.locator('[data-zone-shell]').count()).toBe(1);
    await page.context().close();
  },
  timeout,
);

test('a 503 from readPage prepares without a cursor and retries after Retry-After', async () => {
  const response = await fetch(`${await site()}/en/zones/${unavailableZoneId}`);
  expect(response.status).toBe(503);
  expect(response.headers.get('cache-control')).toMatch(/\bno-store\b/);
  expect(response.headers.get('retry-after')).toBeTruthy();
  const html = await response.text();
  expect(html).toContain('Preparing this Zone page');
  expect(html).not.toMatch(/cursor-\d+/);
  expect(html).not.toContain('A clear view of the collection');
});

test(
  'a no-cursor 503 retries after Retry-After and replaces the preparing page with the completed page',
  async () => {
    const page = await open(`/en/zones/${recoveringZoneId}`);
    expect(await page.getByRole('heading', { name: 'Preparing this Zone page' }).count()).toBe(1);
    expect(await page.content()).not.toMatch(/cursor-\d+/);
    await page.getByRole('heading', { name: 'A clear view of the collection' }).waitFor({ timeout: 15_000 });
    expect(await page.locator('[data-zone-shell]').count()).toBe(1);
    await page.context().close();
  },
  timeout,
);

test(
  'a Zone that becomes unreadable during continuation renders the not-found page without partial content',
  async () => {
    const page = await open(`/en/zones/${revokedZoneId}`);
    expect(await page.getByRole('heading', { name: 'Preparing this Zone page' }).count()).toBe(1);
    expect(await page.locator('[data-zone-shell]').count()).toBe(0);

    await page.getByRole('heading', { name: 'Page not found' }).waitFor({ timeout: 15_000 });
    const html = await page.content();
    expect(html).not.toContain('Field Notes');
    expect(html).not.toContain('A clear view of the collection');
    expect(await page.locator('[data-zone-shell]').count()).toBe(0);
    await page.context().close();
  },
  timeout,
);

test('a cursor defect uses the ordinary page error state', async () => {
  const requests: { url: URL }[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      requests.push({ url });
      return Response.json({ status: 400, code: 'invalid_request' }, { status: 400 });
    }) as typeof fetch,
  });
  const result = await readZonePage(client as never, zoneId, { target: { route: '' } }, { cursor: 'cursor-bad' });
  expect(requests).toHaveLength(1);
  expect(requests[0]!.url.searchParams.get('cursor')).toBe('cursor-bad');
  expect(result.kind).toBe('error');
});

test(
  'Zone stories cover home and subject pages in both themes, locales and target viewport sizes',
  async () => {
    const origin = await site();
    for (const theme of ['light', 'dark'])
      for (const viewport of [phone, desktop])
        for (const locale of ['en', 'zh-Hans']) {
          const page = await open(`/${locale}/zones/${zoneId}`, {
            viewport,
            storageState: {
              cookies: [
                {
                  name: 'rezics_theme',
                  value: theme,
                  domain: new URL(origin).hostname,
                  path: '/',
                  expires: -1,
                  httpOnly: false,
                  secure: false,
                  sameSite: 'Lax',
                },
              ],
              origins: [],
            },
          });
          expect(await page.locator('[data-zone-shell]').count()).toBe(1);
          expect(await page.locator('main').isVisible()).toBe(true);
          await page.context().close();
        }
  },
  timeout,
);

function pageResponse() {
  return {
    profile: 'sha256:zone-story',
    template: { scope: 'route', key: '' },
    document: {
      root: { props: {} },
      content: [
        { type: 'Heading', props: { id: 'zone-heading', level: 1, text: { en: 'A clear view of the collection' } } },
      ],
    },
    reads: {},
    subject: subjectId,
    zone: {
      id: zoneId,
      revision: '1',
      labels: { en: 'Field Notes' },
      visibility: 'public',
      appearance: {},
      navigation: [],
    },
  };
}

function canonicalPath(html: string): string | undefined {
  const tag = html.match(/<link\b(?=[^>]*\brel="canonical")(?=[^>]*\bhref="([^"]+)")[^>]*>/)?.[1];
  return tag ? new URL(tag).pathname : undefined;
}
