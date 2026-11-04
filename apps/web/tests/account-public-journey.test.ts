import { expect, test, mock } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import type { SubjectPageData } from '../src/features/pages/subject';
// Render-only tests do not invoke Worker bindings. API assertions below use the actual generated client.
mock.module('cloudflare:workers', () => ({ env: {} }));

const { accountOf, viewIsPublic } = await import('../src/features/pages/account-read');
const { loadPublicAccountJourney, pageProfile } = await import('../src/accounts/public-profile/page-read');
const { readPublicRealms } = await import('../src/accounts/public-profile/read');
const { PublicRealmsPage } = await import('../src/accounts/public-profile/view');
const { PublicProfilePage } = await import('../src/accounts/public-profile/page');
const { profilePage } = await import('../src/stories/pages/accounts-public-profile/fixtures');
const { contributionPage, clippedContributionPage, contributionLongTitle } =
  await import('../src/stories/pages/accounts-public-profile/fixtures');
const { continueAgentList } = await import('../src/features/pages/agent');
const { threadHref } = await import('../src/threads/thread-href');
const { isRecord } = await import('../src/features/pages/shared');
const { m } = await import('../src/paraglide/messages.js');

const accountId = '0192f3a0-6c1e-7b2a-8000-000000000001';
const realmId = '0192f3a0-6c1e-7b2a-8000-000000000002';
const hiddenId = '0192f3a0-6c1e-7b2a-8000-000000000003';
const profile = (extra: Record<string, unknown> = {}) =>
  accountOf({
    accounts: [
      {
        id: accountId,
        kind: 'actor',
        state: 'active',
        handle: 'reader',
        publicViews: { realms: true },
        ...extra,
      },
    ],
  })!;

function clientWith(handler: (request: Request) => Response | Promise<Response>) {
  return createKernelClient('https://kernel.test', {
    fetch: ((input, init) => handler(new Request(input, init))) as typeof fetch,
  });
}

test('public profile only marks a visible verified Subject; pending and deleted accounts have no presentation', () => {
  expect(profile({ verified: true, subject: null }).verified).toBe(false);
  expect(
    profile({ verified: false, subject: { id: realmId, label: 'Pointer only', type: 'schema:Person' } }).verified,
  ).toBe(false);
  expect(
    profile({
      verified: true,
      subject: { id: realmId, label: 'Catalogue person', type: 'schema:Person' },
      verificationRequest: { evidence: 'private' },
    }),
  ).toMatchObject({ verified: true });
  expect(JSON.stringify(profile({ evidence: 'private', email: 'private@example.test' }))).not.toContain('private');
  for (const state of ['pending', 'deleted'])
    expect(accountOf({ accounts: [{ id: accountId, state }] })).toBeUndefined();
  expect(viewIsPublic(profile({ publicViews: {} }), 'realms')).toBe(false);
});

test('Realms consumes the signed owner continuation anonymously, omits hidden rows and never scans for handles', async () => {
  const calls: string[] = [];
  const client = clientWith((request) => {
    expect(request.headers.has('authorization')).toBe(false);
    const url = new URL(request.url);
    calls.push(url.pathname);
    if (url.pathname.endsWith(`/accounts/${accountId}/realms`)) {
      expect(url.searchParams.get('cursor')).toBe('signed+/=cursor');
      expect(url.searchParams.get('limit')).toBe('20');
      return Response.json({
        realms: [
          { id: realmId, role: 'member' },
          { id: hiddenId, role: 'owner' },
        ],
        next: 'next-signed',
      });
    }
    if (url.pathname.endsWith(hiddenId)) return Response.json({ code: 'not_found' }, { status: 404 });
    return Response.json({ realm: { realmId, title: 'Public reading room', summary: null } });
  });
  const result = await readPublicRealms(client, profile(), 'signed+/=cursor');
  expect(result).toEqual({
    state: 'ready',
    realms: [{ id: realmId, role: 'member', title: 'Public reading room', summary: null }],
    next: 'next-signed',
  });
  expect(calls).toEqual([`/v1/accounts/${accountId}/realms`, `/v1/realms/${realmId}`, `/v1/realms/${hiddenId}`]);
  calls.length = 0;
  expect(await readPublicRealms(client, profile({ publicViews: { realms: false } }))).toEqual({ state: 'denied' });
  expect(calls).toEqual([]);
});

test('denied, preparing, invalid continuation and unavailable are distinct from a genuinely empty Realm page', async () => {
  for (const [status, state] of [
    [403, 'denied'],
    [202, 'preparing'],
    [400, 'invalid-cursor'],
    [503, 'unavailable'],
  ] as const) {
    expect(
      await readPublicRealms(
        clientWith(() => Response.json({ code: 'failure' }, { status })),
        profile(),
      ),
    ).toEqual({ state });
  }
  expect(
    await readPublicRealms(
      clientWith(() => Response.json({ realms: [], next: null })),
      profile(),
    ),
  ).toEqual({ state: 'ready', realms: [], next: null });
  const failedHydration = clientWith((request) =>
    new URL(request.url).pathname.endsWith('/realms')
      ? Response.json({ realms: [{ id: realmId, role: 'member' }], next: null })
      : Response.json({ code: 'dependency_unavailable' }, { status: 503 }),
  );
  expect(await readPublicRealms(failedHydration, profile())).toEqual({ state: 'unavailable' });
  const html = renderToString(
    createElement(PublicRealmsPage, {
      handle: 'reader',
      title: 'Reader',
      locale: 'en',
      result: { state: 'ready', realms: [], next: 'signed+/=' },
    }),
  );
  expect(html).toContain('cursor=signed%2B%2F%3D');
  expect(html).not.toContain('No public Realms to show');
  for (const state of ['denied', 'preparing', 'invalid-cursor', 'unavailable'] as const) {
    const failure = renderToString(
      createElement(PublicRealmsPage, {
        handle: 'reader',
        title: 'Reader',
        locale: 'en',
        result: { state },
        retry: () => {},
        search: '?role=owner&cursor=expired&role=member&cursor=duplicate',
      }),
    );
    expect(failure.includes('<button')).toBe(state === 'unavailable');
    if (state === 'invalid-cursor') {
      expect(failure).toContain('href="/en/@reader/realms?role=owner&amp;role=member"');
    }
  }
});

test('composed public pages keep automation visible when operator hydration is unavailable or has no handle', () => {
  const page = profilePage({ profile: { automated: true, operatorId: accountId } });
  const render = (
    operator?: { id: string; handle: string | null; displayName: string | null },
    target = page,
  ) => {
    const cache = new QueryClient();
    cache.setQueryData(['exposure', 'anonymous'], []);
    return renderToString(
      createElement(QueryClientProvider, {
        client: cache,
        children: createElement(PublicProfilePage, {
          page: target,
          locale: 'en',
          messages: {
            unknown: 'Unknown',
            none: 'None',
            unlabelled: 'Account',
            sources: 'Sources',
            aliases: 'Aliases',
            details: 'Details',
          },
          publicRealms: true,
          renderJsonLd: false,
          ...(operator ? { operator } : {}),
        }),
      }),
    );
  };
  const unavailable = render();
  expect(unavailable).toContain('Automated account');
  expect(unavailable).toContain('Operated by');
  expect(unavailable).toContain('Operator unavailable');
  expect(unavailable).not.toContain(`href="/en/@${accountId}"`);
  expect(unavailable).toContain('Person');
  expect(render(undefined, profilePage({ profile: { kind: 'organization' } }))).toContain('Organization');
  const html = render({ id: accountId, handle: null, displayName: 'Reading Room' });
  expect(html).toContain('Reading Room');
  expect(html).not.toContain('href="/en/@"');
  expect(html).not.toContain('followers');
});

test('the real generated page client retains source view privacy and canonical forwarding without listing accounts', async () => {
  const page = profilePage({
    profile: { movedTo: 'current-reader', handle: 'current-reader', publicViews: { realms: false } },
  });
  const calls: string[] = [];
  const client = clientWith(async (request) => {
    const url = new URL(request.url);
    calls.push(url.pathname);
    expect(request.headers.has('authorization')).toBe(false);
    const body = (await request.json()) as { target: { account: string; view?: string } };
    expect(body.target).toEqual({ account: 'former-reader' });
    return Response.json({ ...page, account: page.account!.id });
  });
  expect(
    await loadPublicAccountJourney(client, {
      handle: 'former-reader',
      locale: 'en',
      view: 'realms',
      search: '?cursor=signed',
    }),
  ).toEqual({ kind: 'redirect', redirectTo: '/en/@current-reader/realms?cursor=signed' });
  expect(calls).toEqual(['/v1/pages:read']);
  expect(pageProfile(page)?.publicViews.realms).toBe(false);
});

test('Default public identity and management presentation keeps long phone identities readable, management links distinct and connected managed detail stories within their real session/query providers', async () => {
  const { AccountManagementPage } = await import('../src/accounts/management/pages');
  const { detailExample, human } = await import('../src/accounts/management/story-api');
  const displayName = '閱讀者與翻譯者共同維護的獨立閱讀室'.repeat(256).slice(0, 4096);
  const bio = 'Reading notes across languages.\n閱讀筆記與翻譯持續更新。\n'.repeat(128).slice(0, 4096);
  const handle = 'international-reading-room'.padEnd(64, 'x');
  const links = Array.from({ length: 5 }, (_, index) => ({
    label: `${'閱讀紀錄與翻譯'.repeat(10).slice(0, 63)}${index + 1}`,
    url: `https://example.test/journal/${index + 1}`.padEnd(2048, 'x'),
  }));
  const cache = new QueryClient();
  cache.setQueryData(['exposure', 'anonymous'], []);
  const html = renderToString(
    createElement(QueryClientProvider, {
      client: cache,
      children: createElement(PublicProfilePage, {
        page: profilePage({ profile: { displayName, handle, bio, links } }),
        locale: 'en',
        messages: {
          unknown: 'Unknown',
          none: 'None',
          unlabelled: 'Account',
          sources: 'Sources',
          aliases: 'Aliases',
          details: 'Details',
        },
        publicRealms: true,
        renderJsonLd: false,
      }),
    }),
  );
  const heading = html.match(/<h1 class="([^"]+)">([\s\S]*?)<\/h1>/)!;
  expect(heading[1]).toContain('font-sans');
  expect(heading[1]).toContain('wrap-anywhere');
  expect(heading[2]).toBe(displayName);
  expect(html).toContain(`@${handle}</p><p data-slot="agent-kind"`);
  const description = html.match(/data-slot="agent-description" class="([^"]+)">/)!;
  // The default phone body spans both avatar/name columns; desktop keeps its text column.
  expect(description[1]).toContain('col-span-full');
  expect(description[1]).toContain('sm:col-start-2');
  expect(html).toContain(bio);
  for (const link of links)
    expect(html).toContain(`href="${link.url}" rel="nofollow noopener noreferrer ugc">${link.label}</a>`);
  expect(html).not.toContain('followers');

  const realms = renderToString(
    createElement(PublicRealmsPage, {
      handle,
      title: displayName,
      locale: 'en',
      result: { state: 'ready', realms: [], next: 'signed+/=' },
    }),
  );
  expect(realms.match(/<h1 class="([^"]+)">/)![1]).toContain('font-sans');
  expect(realms).toContain(`href="/en/@${handle}"`);
  expect(realms).toContain(`href="/en/@${handle}/realms?cursor=signed%2B%2F%3D"`);

  const detail = detailExample(human.id);
  detail.account = { ...detail.account, handle, displayName };
  const management = renderToString(
    createElement(AccountManagementPage, {
      page: { state: 'ready', value: detail, issuer: null, organizationsAvailable: null },
      retry: () => {},
    }),
  );
  const identity = management.match(/data-slot="account-management-identity" class="([^"]+)">([\s\S]*?)<\/div>/)!;
  expect(identity[1]).toContain('grid');
  expect(identity[1]).toContain('gap-3');
  const destinations = [...identity[2]!.matchAll(/<a ([^>]+)>/g)].map((link) => ({
    href: link[1]!.match(/href="([^"]+)"/)![1],
    classes: link[1]!.match(/class="([^"]+)"/)![1],
  }));
  expect(destinations.map((link) => link.href)).toEqual([`/en/@${handle}`, '/en/settings']);
  for (const link of destinations) expect(link.classes).toContain('min-h-11');

  // Keep the original pattern on the established provider, with the same viewer as its reader.
  const story = await Bun.file(
    new URL('../src/stories/patterns/managed-account-detail.stories.tsx', import.meta.url),
  ).text();
  expect(story).toMatch(
    /<PatternStory visitor="Signed In"[^>]*>\s*<ConnectedDetail \{\.\.\.props\} \/>\s*<\/PatternStory>/,
  );
  expect(story).toContain('client.setQueryData(sessionQuery.queryKey,');
  expect(story).toContain('subject: human.id');
  expect(story).toContain('new ManagedAccountReader(human.id, organization.id, read)');
});

function renderContributions(page: SubjectPageData, locale = 'en', admitted: string[] = ['collections']) {
  const cache = new QueryClient();
  cache.setQueryData(['exposure', 'anonymous'], admitted);
  return renderToString(
    createElement(QueryClientProvider, {
      client: cache,
      children: createElement(PublicProfilePage, {
        page,
        locale,
        base: `/${locale}/@${page.account!.handle}`,
        messages: {
          unknown: 'Unknown',
          none: 'None',
          unlabelled: 'Account',
          sources: 'Sources',
          aliases: 'Aliases',
          details: 'Details',
        },
        publicRealms: false,
        renderJsonLd: false,
      }),
    }),
  );
}

const contributionViews = [
  { view: 'posts', field: 'posts', kind: 'accountPosts', slot: 'account-posts', limit: 20 },
  { view: 'reviews', field: 'threads', kind: 'accountThreads', slot: 'account-reviews', limit: 12 },
  { view: 'collections', field: 'collections', kind: 'accountCollections', slot: 'account-collections', limit: 24 },
] as const;

function activityResult(page: SubjectPageData, field: string) {
  const entry = Object.entries(page.reads).find(([, result]) => isRecord(result.body) && field in result.body)!;
  return { key: entry[0], result: entry[1], body: entry[1].body as Record<string, unknown> };
}

function contributionSection(html: string, slot: string) {
  const section = html.match(new RegExp(`<section[^>]*data-slot="${slot}"[\\s\\S]*?</section>`));
  expect(section).not.toBeNull();
  return section![0];
}

function renderedRows(html: string) {
  return [...html.matchAll(/<li\b[^>]*data-slot="list-row"[\s\S]*?<\/li>/g)].map(([row]) => row);
}

test('production contribution excerpts keep passive prose below the primary link and native controls independent without changing disclosure', () => {
  const page = clippedContributionPage();
  const html = renderContributions(page);
  for (const slot of ['account-posts', 'account-reviews']) {
    const rows = renderedRows(contributionSection(html, slot));
    const row = rows[0]!;
    const preview = row.slice(row.indexOf('data-content-item-slot="preview"'));
    expect(preview).not.toContain('data-slot="list-row-control"');
    expect(preview).toContain('[&amp;_a]:relative');
    expect(preview).toContain('[&amp;_a]:z-10');
    expect(preview).toContain('[&amp;_button]:z-10');
    expect(preview).toContain('max-h-40 overflow-hidden');
    expect(preview).toContain('data-slot="document-body"');
    expect(preview).toContain('<p');
    expect(preview).toContain('Reply 1: I read it on the train and kept missing my stop.');
    expect(preview).toContain('href="https://example.com/b612" rel="noopener noreferrer nofollow ugc"');
    expect(preview.match(/Reply 1: I read it on the train and kept missing my stop\./g)).toHaveLength(11);
    expect(row.match(/data-slot="list-row-link"/g)).toHaveLength(1);
    const heading = row.match(/<h3\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/h3>/)!;
    expect(heading[2]).toBe(contributionLongTitle);
    expect(row).toContain(`aria-labelledby="${heading[1]}"`);
    const primary = row.match(/<a\b[^>]*data-slot="list-row-link"[\s\S]*?<\/a>/)![0];
    expect(primary).not.toContain('<button');
    expect(primary).not.toContain('https://example.com');
    expect(rows[1]).toContain('aria-expanded="false"');
    expect(rows[1]).toContain('document-spoiler');
    expect(row.match(/<li[^>]*class="([^"]+)"/)![1]).not.toMatch(/(?:^| )(?:border|bg-card|shadow-)/);
  }
  // Rendering changes no supplied document, summary, or account publication authority.
  expect(page).toEqual(clippedContributionPage());
});

test('public previews keep native order, bounded presentation and honest See all destinations, including sparse and operation-gated collections', () => {
  for (const spec of contributionViews) {
    const page = contributionPage();
    const { body } = activityResult(page, spec.field);
    const source = body[spec.field] as Record<string, unknown>[];
    const node = page.document.content.find(
      (node) =>
        node.type ===
        (spec.view === 'posts' ? 'AccountPosts' : spec.view === 'reviews' ? 'AccountThreads' : 'AccountCollections'),
    )!;
    node.props.limit = 1;
    const section = contributionSection(renderContributions(page), spec.slot);
    expect(renderedRows(section)).toHaveLength(1);
    expect(section).toContain('data-slot="count"');
    expect(section).toContain(`>${source.length}</span>`);
    expect(section).toContain(`href="/en/@mira/${spec.view}"`);
    expect(section).not.toContain('rel="next"');
    body.next = 'signed+/=next';
    const continued = contributionSection(renderContributions(page), spec.slot);
    expect(continued).not.toContain('data-slot="count"');
    expect(continued).toContain('data-slot="see-all"');
    body[spec.field] = [];
    const sparse = contributionSection(renderContributions(page), spec.slot);
    expect(sparse).toContain('data-slot="see-all"');
    expect(sparse).not.toContain(m.agent_empty());
    body.next = null;
    expect(renderContributions(page)).not.toContain(`data-slot="${spec.slot}"`);
  }
  const page = contributionPage();
  activityResult(page, 'collections').body.next = 'signed+/=';
  const withheld = contributionSection(renderContributions(page, 'en', []), 'account-collections');
  expect(renderedRows(withheld)).toHaveLength(2);
  expect(withheld).not.toContain('<a');
  expect(withheld).toContain('Shelf 1');
  expect(withheld).toContain('Books I return to when the weather turns.');
});

test('dedicated contribution pages use the real signed continuation once with the native page bound and no row hydration', async () => {
  for (const spec of contributionViews) {
    const page = contributionPage(spec.view);
    const plan = planReads(platformRegistry, page.document as CompositionDocument, {
      subject: page.subject,
      account: page.account!,
    });
    const read = Object.values(plan.reads).find((read) => read.kind === spec.kind)!;
    expect(read).toMatchObject({ kind: spec.kind, limit: spec.limit });
    const { body } = activityResult(page, spec.field);
    const source = body[spec.field] as Record<string, unknown>[];
    body[spec.field] = Array.from({ length: spec.limit }, (_, index) => ({ ...source[0], id: `row-${index}` }));
    body.next = 'signed+/=next';
    const first = contributionSection(renderContributions(page), spec.slot);
    expect(renderedRows(first)).toHaveLength(spec.limit);
    expect(first).not.toContain('data-slot="see-all"');
    expect(first).toContain('href="?cursor=signed%2B%2F%3Dnext"');
    expect(first).toContain('rel="next"');
    const requests: Request[] = [];
    const client = clientWith((request) => {
      requests.push(request);
      const url = new URL(request.url);
      expect(url.pathname).toBe(`/v1/accounts/${page.account!.id}/${spec.field}`);
      expect(url.searchParams.get('cursor')).toBe('signed+/=next');
      expect(url.searchParams.get('limit')).toBe(String(spec.limit));
      expect(request.headers.has('authorization')).toBe(false);
      if (spec.view === 'reviews') expect(url.searchParams.get('kind')).toBe('review');
      if (spec.view === 'collections') expect(url.searchParams.get('view')).toBe('BASIC');
      return Response.json({ [spec.field]: [], next: 'second+/=signed' });
    });
    const next = await continueAgentList(client, { ...page, account: page.account! }, 'signed+/=next');
    expect(requests).toHaveLength(1);
    const sparse = contributionSection(renderContributions(next), spec.slot);
    expect(renderedRows(sparse)).toHaveLength(0);
    expect(sparse).toContain('href="?cursor=second%2B%2F%3Dsigned"');
    expect(sparse).not.toContain(m.agent_empty());
    expect(next.account).toEqual(page.account);
    if (spec.view === 'collections') {
      const closed = contributionSection(renderContributions(next, 'en', []), spec.slot);
      expect(closed).not.toContain('data-slot="continuation"');
    }
  }
});

test('contribution empty, missing, malformed, denied, preparing, expired and unavailable readings retain truthful local recovery', () => {
  for (const spec of contributionViews) {
    const page = contributionPage(spec.view);
    const { key, body } = activityResult(page, spec.field);
    body[spec.field] = [];
    body.next = null;
    const empty = contributionSection(renderContributions(page), spec.slot);
    expect(empty).toContain(m.agent_empty());
    expect(empty).not.toContain('data-slot="continuation"');
    for (const [status, message, recovery] of [
      [403, m.public_account_denied(), null],
      [202, m.public_account_preparing(), 'retry'],
      [400, m.public_account_cursor_expired(), 'restart'],
      [404, m.public_account_unavailable(), 'retry'],
      [503, m.public_account_unavailable(), 'retry'],
    ] as const) {
      page.reads[key] = { status, body: {} };
      const failed = contributionSection(renderContributions(page), spec.slot);
      expect(failed).toContain(message);
      expect(failed).not.toContain(m.agent_empty());
      expect(failed).not.toContain('data-slot="continuation"');
      if (recovery) {
        expect(failed).toContain(`data-slot="${recovery}"`);
        expect(failed).toContain(recovery === 'retry' ? 'href=""' : `href="/en/@mira/${spec.view}"`);
      } else expect(failed).not.toContain('<a');
    }
    delete page.reads[key];
    expect(contributionSection(renderContributions(page), spec.slot)).toContain(m.public_account_unavailable());
    page.reads[key] = { status: 200, body: {} };
    const malformed = contributionSection(renderContributions(page), spec.slot);
    expect(malformed).toContain('data-state="failed"');
    expect(malformed).toContain('data-slot="retry"');
    expect(malformed).not.toContain(m.agent_empty());
  }
  const privatePage = profilePage({ profile: { publicViews: { posts: false, reviews: false, collections: false } } });
  const privateHtml = renderContributions(privatePage);
  for (const spec of contributionViews) expect(privateHtml).not.toContain(`data-slot="${spec.slot}"`);
});

test('current multilingual titles, fallback slugs and UTC dates remain canonical without inventing missing excerpts', () => {
  for (const locale of ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es']) {
    const page = clippedContributionPage();
    const { body: posts } = activityResult(page, 'posts');
    const source = posts.posts as Record<string, unknown>[];
    source[1]!.createdAt = 'not-a-date';
    source[1]!.body = { profile: 'text', doc: { type: 'doc', content: [] } };
    const html = renderContributions(page, locale);
    const rows = renderedRows(contributionSection(html, 'account-posts'));
    expect(rows[0]).toContain(
      `href="/${locale}${threadHref({ id: String(source[0]!.threadId), title: contributionLongTitle })}"`,
    );
    expect(rows[0]).toContain(
      new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
        new Date(String(source[0]!.createdAt)),
      ),
    );
    expect(rows[1]).not.toContain('data-slot="excerpt"');
    expect(rows[1]).toContain('data-profile-contribution-kind="reply"');
    expect(rows[2]).toContain(`href="/${locale}/threads/${source[2]!.threadId}/thread"`);
    expect(rows[2]).toContain(m.threads_untitled({}, { locale: locale as never }));
    const threads = activityResult(page, 'threads').body.threads as Record<string, unknown>[];
    threads[0]!.title = '';
    threads[0]!.firstPost = null;
    const review = renderedRows(contributionSection(renderContributions(page, locale), 'account-reviews'))[0]!;
    expect(review).toContain(`href="/${locale}/threads/${threads[0]!.id}/thread"`);
    expect(review).not.toContain('data-slot="excerpt"');
    expect(review).toContain('data-profile-contribution-kind="review"');
  }
});

test('the discussion variant uses the same native excerpt controls and exact thread destination as reviews', () => {
  const page = clippedContributionPage();
  for (const node of page.document.content) if (node.type === 'AccountThreads') node.props.threadKind = 'discussion';
  const { body } = activityResult(page, 'threads');
  for (const thread of body.threads as Record<string, unknown>[]) thread.kind = 'discussion';
  const html = renderContributions(page);
  const discussion = contributionSection(html, 'account-threads');
  expect(html).not.toContain('data-slot="account-reviews"');
  expect(discussion).toContain(m.subject_discussion());
  const row = renderedRows(discussion)[0]!;
  const thread = (body.threads as Record<string, unknown>[])[0]!;
  expect(row).toContain(`href="/en${threadHref({ id: String(thread.id), title: contributionLongTitle })}"`);
  expect(row.slice(row.indexOf('data-content-item-slot="preview"'))).not.toContain('data-slot="list-row-control"');
  expect(row).toContain('href="https://example.com/b612"');
});
