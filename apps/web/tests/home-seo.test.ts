import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { homeFeedViewer, loadPublicHomeFeed } from '../src/features/pages/home-feed-read';
import { homeJsonLd } from '../src/features/pages/jsonld.ts';
import { createRecordedKernelFetch } from '../src/kernel/fake.ts';
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
        'query-input': 'required name=search_term_string',
      },
    });
  }

  const route = await Bun.file(new URL('../src/routes/index.tsx', import.meta.url)).text();
  expect(route).toContain('pageHead(');
  expect(route.match(/homeJsonLd\(/g)).toHaveLength(1);
});

test('the home page read is public and its mixed private stream waits for hydrated session authority', async () => {
  const homeQueries = await Bun.file(new URL('../src/features/pages/home-queries.ts', import.meta.url)).text();
  const route = await Bun.file(new URL('../src/routes/index.tsx', import.meta.url)).text();
  const sessionQuery = await Bun.file(new URL('../src/session/query.ts', import.meta.url)).text();

  expect(homeQueries).toContain('queryOptions(');
  expect(homeQueries).toContain('...publicRead');
  expect(route).toContain('ensureQueryData(homePageQuery(');
  expect(route).toContain('useSuspenseQuery(homePageQuery(');
  expect(route).toContain('HomeFeedConsumer');
  expect(route).toContain('homeFeedViewer(useSession())');
  expect(route).toContain('useSession()');
  expect(sessionQuery).toContain('() => false');
  expect(homeFeedViewer({ state: 'unknown', subject: 'viewer', csrfToken: 'csrf' })).toBeNull();
  expect(homeFeedViewer({ state: 'signed-in', subject: 'viewer', csrfToken: 'csrf' })).toMatchObject({
    subject: 'viewer',
  });
});

test('the server home read is anonymous and a signed-out home does not start Continue', async () => {
  const route = await Bun.file(new URL('../src/routes/index.tsx', import.meta.url)).text();
  const homeQueries = await Bun.file(new URL('../src/features/pages/home-queries.ts', import.meta.url)).text();
  const calls: string[] = [];
  const fake = createRecordedKernelFetch({});
  const client = createKernelClient('https://kernel.invalid', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      expect(request.headers.has('authorization')).toBe(false);
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      return fake(input, init);
    }) as typeof fetch,
  });

  const result = await loadPublicHomeFeed(client);
  expect(result.state).toBe('ready');
  if (result.state !== 'ready') throw new Error('Expected public feed');
  expect(result.page.feedItems.every((item) => item.source === 'discovery')).toBe(true);
  expect(result.page.sources).toMatchObject({ following: 'not_requested', continue: 'not_requested' });
  expect(calls).toEqual(['GET /v1/feedItems']);
  const publicLoader = homeQueries.slice(
    homeQueries.indexOf('const readHomePage'),
    homeQueries.indexOf('export const homePageQuery'),
  );
  expect(publicLoader).not.toMatch(/readSession|prepareSession|loadContinue|sessionQuery/);
  expect(route).toContain('ensureQueryData(homePageQuery(');
  expect(route).not.toMatch(/loader:[\s\S]{0,240}loadContinue/);
  expect(homeFeedViewer({ state: 'signed-out', subject: 'viewer', csrfToken: 'csrf' })).toBeNull();
});

test('the home loader keeps Worker bindings server-only and passes its validated origin to head', async () => {
  const homeQueries = await Bun.file(new URL('../src/features/pages/home-queries.ts', import.meta.url)).text();
  const route = await Bun.file(new URL('../src/routes/index.tsx', import.meta.url)).text();

  expect(homeQueries).toContain('validatePublicOrigin');
  expect(homeQueries).toMatch(/createServerFn\([\s\S]*?import\(['"]cloudflare:workers['"]\)/);
  expect(route).not.toContain("from 'cloudflare:workers'");
  expect(route).toContain('loaderData.origin');
  expect(route).toContain('homeJsonLd({ origin, locale })');
});
