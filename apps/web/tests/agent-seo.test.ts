import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import type { SessionEnv } from '../src/session/client.ts';
import type { SessionStore } from '../src/session/store.ts';
import { loadReader } from '../src/subject/load-reader.ts';
import { defaultReader } from '../src/subject/reader.ts';
import recording from '../src/kernel/recorded/agent-page.json';
import { createFakeKernelFetch, type FakeKernelCall } from '../src/kernel/fake.ts';
import fixtures from '../src/kernel/fixtures.json';
import { loadAgentPage } from '../src/features/pages/agent.tsx';
import { agentPageHead, agentPagePaths, agentPathView, agentViewAvailable } from '../src/features/pages/agent-page.ts';
import { pageLinks } from '../src/shell/head.ts';

type Page = Parameters<typeof agentPageHead>[0];

function page(kind: 'actor' | 'organization' = 'actor', avatar = true): Page {
  const recorded = structuredClone(recording);
  const value = {
    ...recorded,
    account: { id: recorded.account, handle: recorded.handle },
  } as unknown as Page;
  const reads = value.reads as Record<string, { status: number; body: any }>;
  const accountRead = Object.values(reads).find((read) => Array.isArray(read.body?.accounts))!;
  const account = accountRead.body.accounts[0];
  account.kind = kind;
  account.avatar = avatar ? account.avatar : null;
  const subjectRead = Object.values(reads).find((read) => read.body?.subject?.descriptions);
  subjectRead!.body.subject.descriptions['zh-Hans'] = '日本小说家与翻译家';
  return value;
}

const meta = (head: ReturnType<typeof agentPageHead>, name: string) =>
  head.meta.find((item: any) => item.name === name || item.property === name) as { content: string } | undefined;

function graph(head: ReturnType<typeof agentPageHead>) {
  const script = head.scripts.find((item: any) => item.type === 'application/ld+json') as { children: string };
  return JSON.parse(script.children) as { '@graph': Record<string, any>[] };
}

test('agent pages and views have localized profile metadata, a share card, and one complete JSON-LD graph', () => {
  for (const [view, suffix] of [
    [undefined, ''],
    ['posts', '/posts'],
  ] as const) {
    const paths = agentPagePaths('haruka', view);
    const head = agentPageHead(page(), 'zh-Hans', 'https://rezics.com', paths, view);
    expect(meta(head, 'description')?.content).toBe('日本小说家与翻译家');
    expect(meta(head, 'og:type')?.content).toBe('profile');
    expect(meta(head, 'profile:username')?.content).toBe('haruka');
    expect(meta(head, 'og:image')?.content).toContain('/media/');
    expect(head.meta.find((item: any) => 'title' in item)?.title).toBe('Haruka Aizawa (@haruka) – REZICS');
    expect(meta(head, 'og:url')?.content).toBe(`https://rezics.com/zh-Hans/@haruka${suffix}`);

    expect(head.scripts.filter((item: any) => item.type === 'application/ld+json')).toHaveLength(1);
    const data = graph(head);
    expect(data['@graph']).toHaveLength(2);
    expect(data['@graph'][0]!.url).toBe(`https://rezics.com/zh-Hans/@haruka${suffix}`);
    expect(data['@graph'][0]).toMatchObject({
      '@type': 'ProfilePage',
      mainEntity: {
        '@type': 'Person',
        name: 'Haruka Aizawa',
        alternateName: 'haruka',
        url: 'https://rezics.com/zh-Hans/@haruka',
        image: expect.stringContaining('/media/'),
        sameAs: ['https://example.com/haruka'],
      },
    });
    expect(data['@graph'][1]).toEqual({
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'REZICS', item: 'https://rezics.com/zh-Hans' },
        {
          '@type': 'ListItem',
          position: 2,
          name: 'Haruka Aizawa (@haruka)',
          item: `https://rezics.com/zh-Hans/@haruka${suffix}`,
        },
      ],
    });
  }
});

test('organizations use Organization, unpictured profiles use the default card, and views own every locale URL', () => {
  const paths = agentPagePaths('haruka', 'reviews');
  expect(paths).toEqual({
    en: '/@haruka/reviews',
    'zh-Hans': '/@haruka/reviews',
    'zh-Hant': '/@haruka/reviews',
    ja: '/@haruka/reviews',
    ko: '/@haruka/reviews',
    de: '/@haruka/reviews',
    fr: '/@haruka/reviews',
    es: '/@haruka/reviews',
  });
  const links = pageLinks('https://rezics.com', 'zh-Hans', paths['zh-Hans']!, paths);
  expect(links[0]).toEqual({ rel: 'canonical', href: 'https://rezics.com/zh-Hans/@haruka/reviews' });
  const alternates = links.filter((link) => link.rel === 'alternate').map((link) => link.href);
  expect(alternates).toHaveLength(9);
  expect(alternates).toEqual(
    expect.arrayContaining([
      'https://rezics.com/en/@haruka/reviews',
      'https://rezics.com/zh-Hant/@haruka/reviews',
      'https://rezics.com/zh-Hans/@haruka/reviews',
      'https://rezics.com/ja/@haruka/reviews',
      'https://rezics.com/ko/@haruka/reviews',
      'https://rezics.com/de/@haruka/reviews',
      'https://rezics.com/fr/@haruka/reviews',
      'https://rezics.com/es/@haruka/reviews',
      'https://rezics.com/@haruka/reviews',
    ]),
  );

  const head = agentPageHead(page('organization', false), 'en', 'https://rezics.com', paths, 'reviews');
  expect(meta(head, 'og:image')?.content).toBe('https://rezics.com/cards/default.png');
  expect(graph(head)['@graph'][0]!.mainEntity).toMatchObject({
    '@type': 'Organization',
  });
  expect(graph(head)['@graph'][0]!.mainEntity).not.toHaveProperty('image');
  expect(meta(head, 'og:url')?.content).toBe('https://rezics.com/en/@haruka/reviews');
  const continuation = agentPageHead(page(), 'en', 'https://rezics.com', paths, 'reviews', 'c20');
  expect(meta(continuation, 'robots')?.content).toBe('noindex, follow');

  const withheld = page('organization', false);
  const subject = Object.values(withheld.reads).find((read) => (read.body as any)?.subject?.descriptions)!;
  const body = subject.body as any;
  body.summary = {
    ...(body.summary ?? {}),
    cover: {
      media: '0192f3a0-6c1e-7b2a-a001-000000000003',
      width: 512,
      height: 512,
      withheld: 'suitability',
      variants: [{ format: 'webp', width: 320 }],
    },
  };
  const withheldHead = agentPageHead(withheld, 'en', 'https://rezics.com', paths);
  expect(meta(withheldHead, 'og:image')?.content).toBe('https://rezics.com/cards/default.png');
  expect(graph(withheldHead)['@graph'][0]!.mainEntity).not.toHaveProperty('image');
});

test('agent routes use public query factories and keep reader queries out of the server render', async () => {
  const root = new URL('../src/', import.meta.url);
  const files = [
    ['routes/@{$handle}.tsx', true],
    ['routes/@{$handle}_.$view.tsx', true],
  ] as const;
  for (const [file] of files) {
    const source = await Bun.file(new URL(file, root)).text();
    expect(source).toContain('ensureQueryData');
    expect(source).toContain('useSuspenseQuery');
    expect(source).toContain(file.includes('$view') ? 'agentViewQuery' : 'agentPageQuery');
    expect(source).toContain('useSession()');
    expect(source).toContain('useQuery(');
    expect(source).toContain('agentReaderQuery');
    expect(source).toContain('agentPagePaths');
    expect(source).not.toContain("from '../features/pages/agent-actions'");
    expect(source).not.toContain('loadReader(');
  }
  const queries = await Bun.file(new URL('features/pages/agent-queries.ts', root)).text();
  expect(queries).toContain('queryOptions(');
  expect(queries).toContain('publicRead');
  expect(queries).toContain('personalRead');
  expect(queries).toContain('agentViewQuery');
  expect(queries).toContain('agentReaderQuery');
  const page = await Bun.file(new URL('features/pages/agent-page.ts', root)).text();
  expect(page).not.toContain('getRequest(');
  expect(page).not.toContain('loadReader(');
  const actions = await Bun.file(new URL('features/pages/agent-actions.ts', root)).text();
  const publicRead = actions.slice(
    actions.indexOf('export const readAgentPage'),
    actions.indexOf('export const readAgentReader'),
  );
  expect(publicRead).not.toContain('getRequest(');
  expect(publicRead).not.toContain('loadReader(');
});

test('view routes reject unsupported paths and generate alternates for the current view', async () => {
  const root = new URL('../src/', import.meta.url);
  const source = await Bun.file(new URL('routes/@{$handle}_.$view.tsx', root)).text();
  expect(source).toContain('throw notFound()');
  expect(source).toContain('agentPagePaths');
  expect(source).toContain('agentPageHead');
  expect(agentPathView('unknown-view')).toBeUndefined();
  expect(agentPathView('overview')).toBeUndefined();
  expect(agentPathView('posts')).toBe('posts');
  expect(agentViewAvailable([{ view: 'posts' }], 'posts')).toBe(true);
  expect(agentViewAvailable([{ view: 'posts' }], 'reviews')).toBe(false);
  expect(source).toContain('agentViewAvailable(page.tabs, view)');
  const paths = agentPagePaths('haruka', 'works');
  expect(paths.en).toBe('/@haruka/works');
  expect(paths['zh-Hans']).toBe('/@haruka/works');
});

test('agent page kernel reads keep the same bound and split reader preferences after the public render', async () => {
  for (const view of [undefined, 'posts'] as const) {
    for (const signedIn of [false, true]) {
      let phase: 'server' | 'browser' = 'server';
      const calls: (FakeKernelCall & { phase: 'server' | 'browser' })[] = [];
      const fake = createFakeKernelFetch(fixtures as never, (call) => calls.push({ ...call, phase }));
      const client = createKernelClient('https://kernel.invalid', {
        fetch: (async (input, init) => {
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          if (path === '/v1/accounts/reader/preferences') {
            calls.push({
              method: request.method,
              path,
              authorization: request.headers.get('authorization'),
              cookie: request.headers.get('cookie'),
              phase,
            });
            return Response.json({ spoilerLevel: 1, suitability: 'show', version: 3 });
          }
          return fake(request);
        }) as typeof fetch,
      });

      const pageRead = loadAgentPage(client, 'haruka', view);
      const overviewRead = view ? loadAgentPage(client, 'haruka') : Promise.resolve(undefined);
      const [page, overview] = await Promise.all([pageRead, overviewRead]);
      expect(page.kind).toBe('page');
      if (view) expect(overview?.kind).toBe('page');
      const expectedPublicReads = view ? 2 : 1;
      expect(calls.filter((call) => call.phase === 'server' && call.path === '/v1/pages:read')).toHaveLength(
        expectedPublicReads,
      );
      expect(calls.filter((call) => call.phase === 'server').every((call) => call.authorization === null)).toBe(true);
      expect(calls.filter((call) => call.phase === 'server').every((call) => call.cookie === null)).toBe(true);

      phase = 'browser';
      const sessionId = 'a'.repeat(43);
      const session = {
        async credential() {
          return { status: 'active', subject: 'reader', accessToken: 'page-token', csrfToken: 'A'.repeat(22) };
        },
        async signedIn() {
          return { signedIn: true, subject: 'reader', csrfToken: 'A'.repeat(22) };
        },
      };
      const sessionEnv = {
        AUTH_ISSUER: 'https://auth.example.test',
        API_RESOURCE: 'https://api.example.test',
        WEBSITE_SCOPES: 'openid account:read',
        WEBSITE_CLIENT_ID: 'rezics-web-test',
        WEBSITE_CLIENT_KEY: 'unused-by-session-read',
        SESSIONS: {
          idFromName: (name: string) => name,
          get: () => session,
        } as unknown as DurableObjectNamespace<SessionStore>,
      } satisfies Partial<SessionEnv>;
      const reader = await loadReader(
        client,
        new Request(`https://rezics.com/en/@haruka${view ? `/${view}` : ''}`, {
          headers: signedIn ? { cookie: `__Host-rezics_session=${sessionId}` } : {},
        }),
        sessionEnv,
      );
      expect(reader).toEqual(signedIn ? { spoilerLevel: 1, suitability: 'show' } : defaultReader);
      expect(
        calls.filter((call) => call.phase === 'browser' && call.path === '/v1/accounts/reader/preferences'),
      ).toHaveLength(signedIn ? 1 : 0);
      expect(calls).toHaveLength(expectedPublicReads + (signedIn ? 1 : 0));
    }
  }
});
