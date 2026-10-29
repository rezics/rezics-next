import { afterAll, expect, test } from 'bun:test';
import { startDevServer } from './support/dev-server.ts';
import { join } from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { FILTER_LIMITS } from '@rezics/filter';
import { chromium, type Browser, type Page } from 'playwright';
import homePage from '../src/kernel/recorded/home-page.json';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const clientId = 'rezics-website';
const resource = 'https://api.rezics.test';
const scopes = ['media:create', 'media:read_reservation', 'media:read', 'media:complete', 'media:erase'];

const clientKeys = await generateKeyPair('ES256', { extractable: true });
const clientJwk = { ...(await exportJWK(clientKeys.privateKey)), alg: 'ES256', kid: 'website-1' };
const issuerKeys = await generateKeyPair('ES256', { extractable: true });
const issuerJwk = { ...(await exportJWK(issuerKeys.publicKey)), alg: 'ES256', kid: 'issuer-1', use: 'sig' };

const kernelCalls: { method: string; path: string }[] = [];
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
      kernelCalls.push({ method: request.method, path: url.pathname });
      if (url.pathname === '/v1/definitions/active') return json({ digest: bundledDigest });
      if (url.pathname === `/v1/definitions/releases/${bundledDigest}`)
        return json({ digest: bundledDigest, release: bundledRelease });
      if (url.pathname === '/v1/subjects:search')
        return json({
          subjects: [],
          total: { value: 0, relation: 'exact' },
          next: null,
          as_of: '2026-10-01T00:00:00.000Z',
        });
      if (url.pathname === '/v1/subjects:facets')
        return json({ facets: [], total: { value: 0, relation: 'exact' }, as_of: '2026-10-01T00:00:00.000Z' });
      if (url.pathname === '/v1/pages:read' && request.method === 'POST') {
        const { status: _status, ...body } = homePage;
        return json(body);
      }
    }
    return new Response(null, { status: 404 });
  },
});

let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
let started: Promise<string> | undefined;

function site(): Promise<string> {
  started ??= startDevServer({
    warmUpPaths: [],
    env: {
      ...process.env,
      KERNEL_ORIGIN: fake.url.origin,
      AUTH_ISSUER: `${fake.url.origin}/auth`,
      WEBSITE_CLIENT_ID: clientId,
      WEBSITE_CLIENT_KEY: JSON.stringify(clientJwk),
      API_RESOURCE: resource,
      WEBSITE_SCOPES: scopes.join(' '),
      PUBLIC_ORIGIN: 'https://rezics.test',
    },
  }).then((running) => {
    server = running;
    return running.origin;
  });
  return started;
}

let browser: Browser | undefined;

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
  await server?.stop();
});

const searches = (since: number) => kernelCalls.slice(since).filter((call) => call.path === '/v1/subjects:search');

test('the search query factory uses publicRead and keys the locale with all validated params', async () => {
  const querySource = await Bun.file(join(app, 'src/search/search-queries.ts'))
    .text()
    .catch(() => '');
  expect(querySource).toContain('queryOptions');
  expect(querySource).toContain('...publicRead');
  expect(querySource).toMatch(/queryKey:\s*\[\s*'search',\s*locale,\s*params\s*\]/);
});

test('search validates and defaults every public search parameter, and its loader deps match the read', async () => {
  const routeSource = await Bun.file(join(app, 'src/routes/search.tsx')).text();
  expect(routeSource).toContain('validateSearch: searchParams');
  expect(routeSource).toContain('loaderDeps: ({ search }) => searchLoaderDeps(search)');

  const paramsModule = await import('../src/search/search-params.ts');
  const valibot = await import('valibot');
  const missing = valibot.safeParse(paramsModule.searchParams, {});
  expect(missing.success).toBe(true);
  if (!missing.success) return;
  expect(missing.output.q).toBe('');
  expect(missing.output.type).toBeUndefined();
  expect(missing.output.cursor).toBeUndefined();

  const invalid = valibot.safeParse(paramsModule.searchParams, {
    q: 'q'.repeat(257),
    type: 't'.repeat(129),
    cursor: 'c'.repeat(2049),
    'f.P1': Array.from({ length: FILTER_LIMITS.in + 2 }, (_, index) => `value-${index}`),
  });
  expect(invalid.success).toBe(true);
  if (!invalid.success) return;
  expect(invalid.output.q).toBe('');
  expect(invalid.output.type).toBeUndefined();
  expect(invalid.output.cursor).toBeUndefined();
  expect(invalid.output['f.P1']).toHaveLength(FILTER_LIMITS.in);
  expect(paramsModule.searchLoaderDeps(invalid.output)).toEqual({
    query: '',
    type: undefined,
    facets: { P1: Array.from({ length: FILTER_LIMITS.in }, (_, index) => `value-${index}`) },
    cursor: undefined,
  });

  const loader = routeSource.match(/loader:\s*\([\s\S]*?\n\s*\},\n\s*head:/)?.[0];
  expect(loader).toBeTruthy();
  const dependencies = [...(loader ?? '').matchAll(/\bdeps\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]);
  expect([...new Set(dependencies)].sort()).toEqual(['cursor', 'facets', 'query', 'type']);
});

test(
  'search pages are always noindex, name the query in their localized title, and emit no JSON-LD',
  async () => {
    for (const locale of ['en', 'zh-Hans']) {
      for (const query of ['', 'Hana']) {
        const page = await open(`/${locale}/search${query ? `?q=${encodeURIComponent(query)}` : ''}`);
        try {
          const heading = (await page.getByRole('main').getByRole('heading', { level: 1 }).innerText()).trim();
          expect(await page.title()).toBe(`${query ? `${query} – ` : ''}${heading} – REZICS`);
          expect(await page.locator('meta[name="robots"]').getAttribute('content')).toBe('noindex, follow');
          expect(await page.locator('script[type="application/ld+json"]').count()).toBe(0);
        } finally {
          await page.context().close();
        }
      }
    }
  },
  timeout,
);

test(
  'a client navigation back to a recently read search reuses its query without another kernel request',
  async () => {
    const before = kernelCalls.length;
    const page = await open('/en/search?q=cache-reuse');
    try {
      expect(searches(before)).toHaveLength(1);
      await page.getByRole('link', { name: 'REZICS' }).click();
      await page.getByRole('main').getByRole('heading', { name: 'A clearer view of what matters' }).waitFor();
      await page.goBack();
      await page.getByRole('main').getByRole('heading', { level: 1 }).waitFor();
      expect(searches(before)).toHaveLength(1);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);
