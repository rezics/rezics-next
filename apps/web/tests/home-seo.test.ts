import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { loadRoutePage } from '../src/features/pages/route.tsx';
import { homeJsonLd } from '../src/features/pages/jsonld.ts';
import { createFakeKernelFetch } from '../src/kernel/fake.ts';
import fixtures from '../src/kernel/fixtures.json';
import { pageHead } from '../src/shell/head.ts';

const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
const origin = 'https://rezics.example';

test('the home page publishes localized site metadata and one WebSite graph', async () => {
  for (const locale of locales) {
    const messages = (await Bun.file(new URL(`../messages/${locale}.json`, import.meta.url)).json()) as Record<
      string,
      string
    >;
    const graph = homeJsonLd({ origin, locale });
    const head = pageHead(
      { description: messages.home_meta_description!, jsonLd: graph },
      { origin, locale, path: '/' },
    );

    expect(head.meta).toContainEqual({ title: 'REZICS' });
    expect(head.meta).toContainEqual({ name: 'description', content: messages.home_meta_description });
    expect(head.meta).toContainEqual({ property: 'og:image', content: `${origin}/cards/default.png` });
    expect(head.scripts).toHaveLength(1);

    const website = JSON.parse(head.scripts[0]!.children) as Record<string, unknown>;
    expect(website).toMatchObject({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'REZICS',
      alternateName: 'rezics.com',
      url: `${origin}/${locale}`,
      inLanguage: locale,
      potentialAction: {
        '@type': 'SearchAction',
        target: `${origin}/${locale}/search?q={search_term_string}`,
      },
    });
    expect(website.potentialAction).not.toHaveProperty('query-input');
  }

  const route = await Bun.file(new URL('../src/routes/index.tsx', import.meta.url)).text();
  expect(route).toContain('pageHead(');
  expect(route).toContain('renderJsonLd={false}');
});

test('the home page read is public and Continue is a hydrated personal query with reserved space', async () => {
  const homeQueries = await Bun.file(new URL('../src/features/pages/home-queries.ts', import.meta.url)).text();
  const route = await Bun.file(new URL('../src/routes/index.tsx', import.meta.url)).text();
  const continueRead = await Bun.file(new URL('../src/library/continue-read.ts', import.meta.url)).text();
  const continueView = await Bun.file(new URL('../src/library/continue.tsx', import.meta.url)).text();
  const sessionQuery = await Bun.file(new URL('../src/session/query.ts', import.meta.url)).text();

  expect(homeQueries).toContain('queryOptions(');
  expect(homeQueries).toContain('...publicRead');
  expect(route).toContain('ensureQueryData(homePageQuery(');
  expect(route).toContain('useSuspenseQuery(homePageQuery(');
  expect(continueRead).toContain('queryOptions(');
  expect(continueRead).toContain('...personalRead');
  expect(route).toContain("enabled: personalRead.enabled && state === 'signed-in'");
  expect(route).toContain('useSession()');
  expect(sessionQuery).toContain('() => false');
  expect(continueView).toMatch(/min-h-(?:\[|\d)/);
});

test('the server home read is anonymous and a signed-out home does not start Continue', async () => {
  const route = await Bun.file(new URL('../src/routes/index.tsx', import.meta.url)).text();
  const homeQueries = await Bun.file(new URL('../src/features/pages/home-queries.ts', import.meta.url)).text();
  const continueRead = await Bun.file(new URL('../src/library/continue-read.ts', import.meta.url)).text();
  const calls: string[] = [];
  const fake = createFakeKernelFetch(fixtures as never);
  const client = createKernelClient('https://kernel.invalid', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      return fake(input, init);
    }) as typeof fetch,
  });

  const page = await loadRoutePage(client, '/');
  expect(page.kind).toBe('page');
  expect(calls).toEqual(['POST /v1/pages:read']);
  expect(homeQueries).not.toMatch(/readSession|prepareSession|loadContinue|sessionQuery/);
  expect(route).toContain('ensureQueryData(homePageQuery(');
  expect(route).not.toMatch(/loader:[\s\S]{0,240}loadContinue/);
  expect(route).toContain("state === 'signed-in'");
  expect(continueRead).toContain('enabled: personalRead.enabled');
});

test('the home loader keeps Worker bindings server-only and passes its validated origin to head', async () => {
  const homeQueries = await Bun.file(new URL('../src/features/pages/home-queries.ts', import.meta.url)).text();
  const route = await Bun.file(new URL('../src/routes/index.tsx', import.meta.url)).text();

  expect(homeQueries).toContain('validatePublicOrigin');
  expect(homeQueries).toMatch(/createServerFn\([\s\S]*?import\(['"]cloudflare:workers['"]\)/);
  expect(route).not.toContain("from 'cloudflare:workers'");
  expect(route).toContain('loaderData.origin');
  expect(route).toContain('routePageJsonLd(loaderData.page, locale, origin)');
});
