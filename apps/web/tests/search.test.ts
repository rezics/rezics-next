import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import { chromium, type Browser, type Page } from 'playwright';
import { slug } from '@rezics/definitions/slug';
import type { KernelClient } from '@rezics/client';
import fixtures from '../src/kernel/fixtures.json';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const clientId = 'rezics-website';
const resource = 'https://api.rezics.test';
const scopes = ['media:create', 'media:read_reservation', 'media:read', 'media:complete', 'media:erase'];

// The OpenID keys and discovery provider are copied from session.test.ts; these cases stay signed out.
const clientKeys = await generateKeyPair('ES256', { extractable: true });
const clientJwk = { ...(await exportJWK(clientKeys.privateKey)), alg: 'ES256', kid: 'website-1' };
const issuerKeys = await generateKeyPair('ES256', { extractable: true });
const issuerJwk = { ...(await exportJWK(issuerKeys.publicKey)), alg: 'ES256', kid: 'issuer-1', use: 'sig' };

type Search = NonNullable<Awaited<ReturnType<KernelClient['subjects']['$search']['post']>>['data']>;
type SearchInput = Parameters<KernelClient['subjects']['$search']['post']>[0];
type Suggest = NonNullable<Awaited<ReturnType<KernelClient['subjects']['$suggest']['get']>>['data']>;
type Read = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['subjects']>['get']>>['data']>;
const subjects: Read['subject'][] = fixtures.subjects.map(({ id, type, labels }) => ({
  id,
  type,
  labels,
  revision: 1,
  release: 'test-release',
  context: '00000000-0000-0000-0000-000000000001',
  resolution: {},
  descriptions: {},
  aliases: {},
  statements: {},
}));
const first: Search['subjects'][number] = {
  id: subjects[0]!.id,
  type: 'book',
  labels: { en: 'Kokoro search match' },
};
const second: Search['subjects'][number] = {
  id: subjects[1]!.id,
  type: 'book',
  labels: { en: 'Soseki search match' },
};
const third: Search['subjects'][number] = {
  id: subjects[2]!.id,
  type: 'book',
  labels: { en: 'Taketori search match' },
};
const cursor = 'opaque+page/2=?&';
const asOf = '2026-10-01T00:00:00.000Z';
const kernelCalls: { method: string; path: string; query: string | null; body: SearchInput | null }[] = [];
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    const issuer = `${url.origin}/auth`;
    const tokenEndpoint = `${issuer}/token`;
    if (url.pathname === '/auth/.well-known/openid-configuration')
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: tokenEndpoint,
        jwks_uri: `${issuer}/jwks`,
        revocation_endpoint: `${issuer}/revoke`,
        end_session_endpoint: `${issuer}/end-session`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        id_token_signing_alg_values_supported: ['ES256'],
        token_endpoint_auth_methods_supported: ['private_key_jwt'],
        token_endpoint_auth_signing_alg_values_supported: ['ES256'],
      });
    if (url.pathname === '/auth/jwks') return json({ keys: [issuerJwk] });
    if (url.pathname.startsWith('/v1/')) {
      const body: SearchInput | null = request.method === 'POST' ? await request.json() : null;
      kernelCalls.push({ method: request.method, path: url.pathname, query: url.searchParams.get('q'), body });
      if (url.pathname === '/v1/subjects:search' && request.method === 'POST') {
        const empty = body?.text === 'unfindable';
        const nextPage = body?.cursor === cursor;
        const response: Search = {
          subjects: empty ? [] : nextPage ? [third] : [first, second],
          next: empty || nextPage ? null : cursor,
          as_of: asOf,
        };
        return json(response);
      }
      if (url.pathname === '/v1/subjects:suggest' && request.method === 'GET') {
        const response: Suggest = { subjects: [first, second], as_of: asOf };
        return json(response);
      }
      const subject = subjects.find((entry) => url.pathname === `/v1/subjects/${entry.id}`);
      if (subject && request.method === 'GET') {
        const response: Read = { subject, related: {} };
        return json(response);
      }
    }
    return new Response(null, { status: 404 });
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

// The documented command, pointed at the fake through the environment it reads in development.
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
      env: {
        ...process.env,
        KERNEL_ORIGIN: fake.url.origin,
        AUTH_ISSUER: `${fake.url.origin}/auth`,
        WEBSITE_CLIENT_ID: clientId,
        WEBSITE_CLIENT_KEY: JSON.stringify(clientJwk),
        API_RESOURCE: resource,
        WEBSITE_SCOPES: scopes.join(' '),
      },
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

let browser: Browser | undefined;

// Browser setup is copied from subject.test.ts, including the hydration guard before interaction.
async function open(path: string): Promise<Page> {
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  return page;
}

afterAll(async () => {
  await browser?.close();
  fake.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

const searches = (since: number) => kernelCalls.slice(since).filter((call) => call.path === '/v1/subjects:search');
const suggestions = (since: number) => kernelCalls.slice(since).filter((call) => call.path === '/v1/subjects:suggest');

// Implement the search route, render its subject links, and forward the cursor to enable test(...).
test(
  'the search page lists matching subjects and pages with the cursor',
  async () => {
    const before = kernelCalls.length;
    const query = 'Kokoro & Soseki';
    const page = await open(`/en/search?q=${encodeURIComponent(query)}`);
    try {
      const main = page.getByRole('main');
      expect(await main.getByRole('link', { name: first.labels.en!, exact: true }).count()).toBe(1);
      expect(await main.getByRole('link', { name: first.labels.en!, exact: true }).getAttribute('href')).toBe(
        `/en/subjects/${first.id}/${slug(first.labels.en!)}`,
      );
      expect(await main.getByRole('link', { name: second.labels.en!, exact: true }).getAttribute('href')).toBe(
        `/en/subjects/${second.id}/${slug(second.labels.en!)}`,
      );
      expect(searches(before)).toHaveLength(1);
      expect(searches(before)[0]).toMatchObject({ method: 'POST', body: { text: query } });
      expect(searches(before)[0]!.body?.cursor).toBeUndefined();
      const more = main.getByRole('link', { name: /more/i });
      const target = new URL((await more.getAttribute('href'))!, page.url());
      expect(target.pathname).toBe('/en/search');
      expect(target.searchParams.get('q')).toBe(query);
      expect(target.searchParams.get('cursor')).toBe(cursor);
      await more.click();
      await main.getByRole('link', { name: third.labels.en!, exact: true }).waitFor();
      expect(searches(before)).toHaveLength(2);
      expect(searches(before)[1]).toMatchObject({ method: 'POST', body: { text: query, cursor } });
      expect(await main.getByRole('link', { name: third.labels.en!, exact: true }).getAttribute('href')).toBe(
        `/en/subjects/${third.id}/${slug(third.labels.en!)}`,
      );
      expect(await main.getByRole('link', { name: /more/i }).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

// Render the empty-query search form without fetching results to enable test(...).
test(
  'an empty query shows the search form without calling the kernel',
  async () => {
    for (const suffix of ['', '?q=']) {
      const before = kernelCalls.length;
      const page = await open(`/en/search${suffix}`);
      try {
        const form = page.getByRole('main').locator('form');
        expect(await form.count()).toBe(1);
        const input = form.locator('input[name="q"]');
        expect(await input.inputValue()).toBe('');
        expect((await form.getAttribute('method')) ?? 'get').toMatch(/^get$/i);
        expect(new URL((await form.getAttribute('action')) || page.url(), page.url()).pathname).toBe('/en/search');
        expect(kernelCalls.slice(before)).toEqual([]);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

// Render an explicit no-results message for an empty search response to enable test(...).
test(
  'a query with no matches says so',
  async () => {
    const before = kernelCalls.length;
    const page = await open('/en/search?q=unfindable');
    try {
      expect(await page.getByRole('main').innerText()).toMatch(/no (?:results|matches|subjects)(?: found)?/i);
      expect(searches(before)).toHaveLength(1);
      expect(searches(before)[0]).toMatchObject({ method: 'POST', body: { text: 'unfindable' } });
      expect(await page.getByRole('main').locator('a[href*="/subjects/"]').count()).toBe(0);
      expect(await page.getByRole('main').getByRole('link', { name: /more/i }).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

// Add the shell combobox, suggestion results, and keyboard selection navigation to enable test(...).
test(
  'the shell search box suggests subjects as you type and opens the one chosen',
  async () => {
    const page = await open(`/ja/subjects/${subjects[0]!.id}`);
    try {
      const before = kernelCalls.length;
      const input = page.getByRole('combobox').and(page.locator('input'));
      expect(await input.count()).toBe(1);
      await input.fill('Soseki');
      const options = page.getByRole('option');
      await options.first().waitFor();
      expect(await options.count()).toBe(2);
      expect(await options.nth(0).innerText()).toContain(first.labels.en!);
      expect(await options.nth(1).innerText()).toContain(second.labels.en!);
      expect(suggestions(before)).toHaveLength(1);
      expect(suggestions(before)[0]).toMatchObject({ method: 'GET', query: 'Soseki' });
      expect(await input.getAttribute('aria-expanded')).toBe('true');
      await input.press('ArrowDown');
      await input.press('ArrowDown');
      await input.press('ArrowUp');
      await input.press('ArrowDown');
      await input.press('Enter');
      await page.waitForURL(`${await site()}/ja/subjects/${second.id}/${slug(second.labels.en!)}`);
      expect(new URL(page.url()).pathname).toBe(`/ja/subjects/${second.id}/${slug(second.labels.en!)}`);
      expect(searches(before)).toHaveLength(0);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

// Debounce suggestion reads until typing has paused for 200 ms to enable test(...).
test(
  'typing quickly sends one suggestion request per pause, not one per keystroke',
  async () => {
    const page = await open(`/en/subjects/${subjects[0]!.id}`);
    try {
      const input = page.getByRole('combobox').and(page.locator('input'));
      expect(await input.count()).toBe(1);
      await input.focus();
      await page.clock.install({ time: new Date('2026-10-01T12:00:00Z') });
      await page.clock.pauseAt('2026-10-01T12:00:01Z');
      const before = kernelCalls.length;
      // Page time controls the debounce; real time lets a premature kernel request reach the fake.
      for (const letter of 'Koko') {
        await page.keyboard.type(letter);
        await page.clock.runFor(40);
        await Bun.sleep(50);
        expect(suggestions(before)).toHaveLength(0);
      }
      await page.clock.runFor(159);
      await Bun.sleep(100);
      expect(suggestions(before)).toHaveLength(0);
      await page.clock.runFor(1);
      await page.getByRole('option').first().waitFor();
      expect(suggestions(before).map((call) => call.query)).toEqual(['Koko']);
      await page.keyboard.type('r');
      await page.clock.runFor(100);
      await page.keyboard.type('o');
      await page.clock.runFor(199);
      await Bun.sleep(100);
      expect(suggestions(before).map((call) => call.query)).toEqual(['Koko']);
      await page.clock.runFor(1);
      // The response may cross the Worker asynchronously, so poll without advancing page time.
      const deadline = Date.now() + 10_000;
      while (suggestions(before).length < 2 && Date.now() < deadline) await Bun.sleep(20);
      expect(suggestions(before).map((call) => call.query)).toEqual(['Koko', 'Kokoro']);
      await page.clock.runFor(1_000);
      await Bun.sleep(100);
      expect(suggestions(before)).toHaveLength(2);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

// Submit unselected combobox text to the locale's search page on Enter to enable test(...).
test(
  'pressing Enter in the search box opens the search page for the query',
  async () => {
    const page = await open(`/ja/subjects/${subjects[0]!.id}`);
    try {
      const input = page.getByRole('combobox').and(page.locator('input'));
      expect(await input.count()).toBe(1);
      await input.fill('Kokoro & Soseki');
      await page.getByRole('option').first().waitFor();
      // Suggestions are visible, but no arrow key or click has chosen one.
      await input.press('Enter');
      await page.waitForURL((url) => url.pathname === '/ja/search');
      const url = new URL(page.url());
      expect(url.pathname).toBe('/ja/search');
      expect(url.searchParams.get('q')).toBe('Kokoro & Soseki');
      expect(url.searchParams.has('cursor')).toBe(false);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);
