import { expect, mock, test } from 'bun:test';
import type { KernelClient } from '@rezics/client';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { ScreenReadingBoundary } = await import('../src/features/pages/data');
function bound(node: ReactNode) {
  return <ScreenReadingBoundary>{node}</ScreenReadingBoundary>;
}

const { ScreenEpisodeList } = await import('../src/features/catalogue/screen-episode-reader/view');
const { screenEpisodeContinuationHref } = await import('../src/features/catalogue/screen-episode-reader/navigation');
const { subjectVisitReturn } = await import('../src/features/pages/subject-visit-navigation');
const { subjectHref } = await import('../src/subject/subject-href');
const { readScreenEpisodePage, SCREEN_EPISODE_PAGE_MAX_BYTES } =
  await import('../src/features/catalogue/screen-episode-reader/read');
type ScreenEpisodeEntry = import('../src/features/catalogue/screen-episode-reader/read').ScreenEpisodeEntry;
const { screenProfileFixture } = await import('../src/kernel/fake/catalogue-screen-profile');

const seasonId = '00000000-0000-4000-8000-000000000902';
const episodeId = '00000000-0000-4000-8000-000000000903';
const seasonMembership = '00000000-0000-4000-8000-000000000912';
const episodeMembership = '00000000-0000-4000-8000-000000000913';
const realmId = '00000000-0000-4000-8000-000000000904';

function statement(
  id: string,
  parent: string,
  position?: string,
  spoiler = false,
  source = 'https://example.invalid/source',
) {
  return {
    id,
    rank: 'normal',
    property: { id: 'schema:isPartOf', data_type: 'wikibase-item' },
    value: { type: 'value', content: parent },
    qualifiers: [
      ...(position
        ? [{ property: { id: 'schema:position', data_type: 'string' }, value: { type: 'value', content: position } }]
        : []),
      ...(spoiler
        ? [
            {
              property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
              value: { type: 'value', content: { amount: '+2', unit: '1' } },
            },
          ]
        : []),
    ],
    references: [
      {
        parts: [{ property: { id: 'schema:url', data_type: 'url' }, value: { type: 'value', content: source } }],
        hash: 'reference-hash',
      },
    ],
    rezics: { release: 'screen-release', revision: 1 },
  } as NonNullable<ScreenEpisodeEntry['statement']>;
}

function link(subject: string, id: string, label: string, type: string, membership: ScreenEpisodeEntry['statement']) {
  return {
    subject,
    property: 'schema:isPartOf',
    statement: id,
    ...(membership ? { assertion: membership } : {}),
    type,
    label,
    summary: { id: subject, type, label: { value: label, language: 'en' } },
  };
}

function clientFor(page: unknown, queries: unknown[] = []) {
  return {
    subjects: ({ id }: { id: string }) => ({
      links: {
        get: async ({ query }: { query: Record<string, unknown> }) => {
          queries.push({ id, ...query });
          return { status: 200, data: page };
        },
      },
    }),
  } as unknown as KernelClient;
}

function linkPage(links: unknown[], count?: { value: number; exact: boolean }, next: string | null = null) {
  return {
    ...(count ? { count } : {}),
    next,
    freshness: { consistency: 'eventual', target_seconds: 10, caught_up: true },
    links,
  };
}

test('screen episode windows retain ordered original memberships, disclosures, citations and selected return', async () => {
  const fixture = screenProfileFixture('ready', 'en', true, 'schema:TVSeries');
  const profile = await fixture.transport.load();
  if (!profile.ok || !profile.public) throw new Error('Expected a current Screen profile');
  const queries: unknown[] = [];
  const membership = statement(seasonMembership, profile.public.subject.id, '1');
  const special = statement(episodeMembership, profile.public.subject.id, 'SP 1');
  const client = clientFor(
    linkPage(
      [
        link(seasonId, seasonMembership, 'Season One', 'schema:TVSeason', membership),
        link(episodeId, episodeMembership, 'The Special', 'schema:Episode', special),
      ],
      { value: 2, exact: false },
      'next-window',
    ),
    queries,
  );

  const read = await readScreenEpisodePage(client, profile.release, profile.public, 'en', realmId, 'opaque-page-two');
  expect(queries).toEqual([
    {
      id: profile.public.subject.id,
      property: 'schema:isPartOf',
      language: 'en',
      limit: 20,
      context: realmId,
      cursor: 'opaque-page-two',
    },
  ]);
  expect(read).toMatchObject({
    ok: true,
    state: 'ready',
    entries: [
      {
        membershipId: seasonMembership,
        holderId: seasonId,
        parentId: profile.public.subject.id,
        type: 'schema:TVSeason',
        statement: {
          id: seasonMembership,
          value: { content: profile.public.subject.id },
          qualifiers: [{ property: { id: 'schema:position' }, value: { content: '1' } }],
        },
      },
      {
        membershipId: episodeMembership,
        holderId: episodeId,
        type: 'schema:Episode',
        statement: {
          id: episodeMembership,
          references: [{ parts: [{ value: { content: 'https://example.invalid/source' } }] }],
          qualifiers: [{ property: { id: 'schema:position' }, value: { content: 'SP 1' } }],
        },
      },
    ],
    next: 'next-window',
  });
  if (!read.ok) throw new Error('Expected a disclosed episode window');

  const list = subjectHref({ id: profile.public.subject.id, label: 'The Observatory' }, 'en').href;
  const origin = {
    pathname: list,
    searchStr: `?realm=${realmId}&screenCursor=opaque-page-two&screenSelection=${seasonMembership}`,
    hash: `#screen-episode-entry-${seasonMembership}`,
  };
  const html = renderToStaticMarkup(
    bound(<ScreenEpisodeList locale="en" read={read} release={profile.release} origin={origin} />),
  );
  expect(html).toContain(`/en/subjects/${seasonId}/season-one`);
  expect(html).toContain(`/en/subjects/${episodeId}/the-special`);
  expect(html).not.toContain('SP 1');
  expect(html).toContain('https://example.invalid/source');
  expect(html).toContain(`statement=${seasonMembership}`);
  expect(html).not.toMatch(/type="checkbox"|aria-checked|Mark watched|completed/i);
  expect(html).not.toContain('/library/progress');

  const specialHref = html.match(/href="([^"]*the-special[^"]*)"/)?.[1];
  if (!specialHref) throw new Error('Expected the exact Episode destination');
  const target = new URL(specialHref.replaceAll('&amp;', '&'), 'https://site.invalid');
  const via = target.searchParams.get('via');
  if (!via) throw new Error('Expected a bounded SubjectVisitReturn');
  expect(subjectVisitReturn(via, 'en')).toBe(via);
  const returned = new URL(via, 'https://site.invalid');
  expect(returned.pathname).toBe(new URL(list, 'https://site.invalid').pathname);
  expect(returned.searchParams.get('screenCursor')).toBe('opaque-page-two');
  expect(returned.searchParams.get('screenSelection')).toBe(episodeMembership);
  expect(returned.searchParams.get('realm')).toBe(realmId);
  expect(returned.hash).toBe(`#screen-episode-entry-${episodeMembership}`);
  expect(screenEpisodeContinuationHref(origin, 'next-window')).not.toContain(`screenSelection=${seasonMembership}`);
});

test('spoiler membership titles stay out of the tree and unsupported membership does not use a fallback stream', async () => {
  const fixture = screenProfileFixture('ready', 'en', true, 'schema:TVSeries');
  const profile = await fixture.transport.load();
  if (!profile.ok || !profile.public) throw new Error('Expected a current Screen profile');
  const privateMembership = statement(episodeMembership, profile.public.subject.id, 'SP 1', true);
  const spoiled = await readScreenEpisodePage(
    clientFor(
      linkPage([link(episodeId, episodeMembership, 'Secret title', 'schema:Episode', privateMembership)], {
        value: 1,
        exact: true,
      }),
    ),
    profile.release,
    profile.public,
    'en',
  );
  const html = renderToStaticMarkup(
    bound(
      <ScreenEpisodeList
        locale="en"
        read={spoiled}
        release={profile.release}
        readerSpoilerLevel={0}
        origin={{ pathname: '/en/subjects/00000000-0000-4000-8000-000000000901/the-observatory', searchStr: '' }}
      />,
    ),
  );
  expect(html).toContain('Show spoilers');
  expect(html).not.toContain('Secret title');
  expect(html).not.toContain(`/en/subjects/${episodeId}`);

  let requests = 0;
  const noMembershipRelease = { ...profile.release, properties: {} } as typeof profile.release;
  const unsupported = await readScreenEpisodePage(
    {
      subjects: () => ({
        links: {
          get: async () => {
            requests += 1;
            return { status: 200, data: linkPage([]) };
          },
        },
      }),
    } as unknown as KernelClient,
    noMembershipRelease,
    profile.public,
    'en',
  );
  expect(unsupported).toEqual({ ok: false, reason: 'unsupported' });
  expect(requests).toBe(0);
});

test('unknown totals keep a sparse disclosed window continuable and oversized evidence is refused whole', async () => {
  const fixture = screenProfileFixture('ready', 'en', true, 'schema:TVSeries');
  const profile = await fixture.transport.load();
  if (!profile.ok || !profile.public) throw new Error('Expected a current Screen profile');
  const terminalEmpty = await readScreenEpisodePage(clientFor(linkPage([])), profile.release, profile.public, 'en');
  expect(terminalEmpty).toEqual({ ok: true, state: 'empty', entries: [], next: null });
  const emptyHtml = renderToStaticMarkup(
    bound(
      <ScreenEpisodeList
        locale="en"
        read={terminalEmpty}
        release={profile.release}
        origin={{ pathname: '/en/subjects/00000000-0000-4000-8000-000000000901/the-observatory', searchStr: '' }}
      />,
    ),
  );
  expect(emptyHtml).toContain('This film or series has no admitted profile facts yet.');

  const terminalQueries: unknown[] = [];
  const terminalContinuation = await readScreenEpisodePage(
    clientFor(linkPage([]), terminalQueries),
    profile.release,
    profile.public,
    'en',
    realmId,
    'opaque-terminal-window',
  );
  expect(terminalContinuation).toEqual({ ok: true, state: 'ready', entries: [], next: null });
  expect(terminalQueries).toEqual([
    {
      id: profile.public.subject.id,
      property: 'schema:isPartOf',
      language: 'en',
      limit: 20,
      context: realmId,
      cursor: 'opaque-terminal-window',
    },
  ]);

  const continuationHtml = renderToStaticMarkup(
    bound(
      <ScreenEpisodeList
        locale="en"
        read={terminalContinuation}
        release={profile.release}
        origin={{
          pathname: '/en/subjects/00000000-0000-4000-8000-000000000901/the-observatory',
          searchStr: '?screenCursor=opaque-terminal-window',
        }}
        visit={
          {
            previousHref:
              '/en/subjects/00000000-0000-4000-8000-000000000901/the-observatory?screenCursor=opaque-previous',
          } as unknown as NonNullable<Parameters<typeof ScreenEpisodeList>[0]['visit']>
        }
      />,
    ),
  );
  expect(continuationHtml).toContain('Previous');
  expect(continuationHtml).not.toContain('Continue');
  expect(continuationHtml).not.toContain('This film or series has no admitted profile facts yet.');

  const membership = statement(seasonMembership, profile.public.subject.id, ' 1/2 ');
  const sparse = await readScreenEpisodePage(
    clientFor(
      linkPage(
        [link(seasonId, seasonMembership, 'Season One', 'schema:TVSeason', membership)],
        undefined,
        'next-window',
      ),
    ),
    profile.release,
    profile.public,
    'en',
  );
  expect(sparse).toMatchObject({
    ok: true,
    state: 'ready',
    entries: [
      {
        statement: {
          qualifiers: [{ property: { id: 'schema:position' }, value: { content: ' 1/2 ' } }],
        },
      },
    ],
    next: 'next-window',
  });

  const oversized = statement(
    episodeMembership,
    profile.public.subject.id,
    undefined,
    false,
    'x'.repeat(SCREEN_EPISODE_PAGE_MAX_BYTES),
  );
  const refused = await readScreenEpisodePage(
    clientFor(linkPage([link(episodeId, episodeMembership, 'Large evidence', 'schema:Episode', oversized)])),
    profile.release,
    profile.public,
    'en',
  );
  expect(refused).toEqual({ ok: false, reason: 'unavailable' });
});
