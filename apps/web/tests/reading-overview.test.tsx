import { expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import {
  readingOverviewExample,
  type ReadingExampleDomain,
  type ReadingExampleState,
} from '../src/kernel/fake/reading-overview';
import { ratingsFixtures } from '../src/kernel/fake/ratings';
import { BookShelfLink } from '../src/books/catalogue/shelf-link';
import { LiteraryReader } from '../src/features/catalogue/literary-reader/view';
import { LiteraryOverviewDestinations } from '../src/features/catalogue/literary-reader/overview';
import { literaryWorkIdentity } from '../src/features/catalogue/literary-reader/model';
import { subjectTabs } from '../src/features/pages/views';
import { subjectPageMessages, viewTabLabels } from '../src/features/pages/route-support';
import { CandidateValue } from '../src/features/pages/scalar-value';
import { ReadingOverviewContext } from '../src/features/pages/reading-overview';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: {} }));
const [
  { SubjectPage },
  { SubjectLibrarySlot },
  { RatingsPreviewContext },
  { GameReader },
  { ScreenProfileReader },
  { ScreenReadingBoundary },
  { WorkReadingBinding },
  { SubjectHeaderActions },
] = await Promise.all([
  import('../src/features/pages/subject'),
  import('../src/library/subject-slot-view'),
  import('../src/features/pages/subject-ratings-view'),
  import('../src/features/catalogue/game-reader/view'),
  import('../src/features/catalogue/screen-profile-reader'),
  import('../src/features/pages/data'),
  import('../src/features/pages/work-reading-binding'),
  import('../src/features/pages/subject-reactions-view'),
]);

async function renderPage(domain: ReadingExampleDomain, state: ReadingExampleState = 'rich') {
  const fixture = readingOverviewExample(domain, state);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['session'], { state: 'signed-out' });
  client.setQueryData(['exposure', 'anonymous'], ['personal_library']);
  const rating = ratingsFixtures[state === 'sparse' ? 'subject-ratings-empty' : 'subject-ratings-global'].preview;
  const content: ReactNode = (
    <RatingsPreviewContext.Provider value={rating}>
      <SubjectPage
        page={fixture.page}
        view="overview"
        locale="en"
        messages={subjectPageMessages()}
        tabs={subjectTabs(fixture.page)}
        tabLabels={viewTabLabels()}
        renderJsonLd={false}
        actions={({ id, type }) => (
          <SubjectHeaderActions
            id={id}
            reactions={null}
            signedIn={false}
            returnTo={`/en/subjects/${id}`}
            verification={{ sitekey: '', scriptUrl: '' }}
          >
            <SubjectLibrarySlot
              subject={{ id, type, label: fixture.identity.title }}
              locale="en"
              data={{
                session: 'signed-out',
                csrfToken: null,
                entryAvailable: false,
                entry: null,
                publicCollections: null,
                publicCollectionsNext: null,
                collectionsLoaded: false,
                collections: null,
                labels: null,
              }}
            />
          </SubjectHeaderActions>
        )}
      />
    </RatingsPreviewContext.Provider>
  );
  const router = createRouter({
    routeTree: createRootRoute({ component: () => content }),
    history: createMemoryHistory({ initialEntries: [`/en/subjects/${fixture.identity.id}`] }),
  });
  await router.load();
  try {
    return {
      fixture,
      html: renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      ),
    };
  } finally {
    client.clear();
  }
}

for (const domain of ['book', 'game', 'anime'] as const) {
  test(`${domain} complete Overview leads with one identity, native actions, reading and a bounded review preview`, async () => {
    const { html, fixture } = await renderPage(domain);
    const header = html.indexOf('data-slot="subject-header"');
    const summary = html.indexOf('data-slot="subject-summary"');
    const reviews = html.indexOf('data-slot="review-list"');
    const tools = html.indexOf('data-slot="reading-overview-tools"');
    expect(html.match(/data-slot="subject-header"/g)).toHaveLength(1);
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(html).toContain(fixture.identity.title);
    expect(header).toBeGreaterThan(-1);
    expect(summary).toBeGreaterThan(header);
    expect(reviews).toBeGreaterThan(summary);
    expect(tools).toBeGreaterThan(reviews);
    expect(html).toContain('data-slot="subject-library-actions"');
    expect(html).toContain('data-slot="book-identity-ratings"');
    expect(html).toContain('1,203');
    expect(html).toContain('A quiet story with a lasting afterglow');
    expect(html).toContain('A place I wanted to return to');
    expect(html).not.toContain('Notes for a second visit');
    expect(html).toContain('CC-BY-4.0');
    expect(html).toContain('Read more');
    expect(html).toMatch(/<details data-slot="reading-overview-tools"[^>]*>/);
    expect(html).not.toMatch(/<details data-slot="reading-overview-tools"[^>]* open/);
    expect(html).not.toContain('data-slot="subject-list"');
    expect(subjectTabs(fixture.page).map(({ view }) => view)).toContain('relations');
    if (domain === 'book') {
      expect(subjectTabs(fixture.page).map(({ view }) => view)).toEqual(
        expect.arrayContaining(['contents', 'editions']),
      );
      expect(html).toContain('data-slot="literary-overview-destinations"');
    }
  });

  test(`${domain} sparse and failed sections preserve reading and expose native empty or retry states`, async () => {
    const sparse = await renderPage(domain, 'sparse');
    expect(sparse.html).toContain(sparse.fixture.identity.title);
    expect(sparse.html).toContain(m.subject_reviews_empty());
    expect(sparse.html).not.toContain('A quiet story with a lasting afterglow');
    expect(sparse.html).not.toContain('1,203');
    const failed = await renderPage(domain, 'section-failure');
    expect(failed.html).toContain(failed.fixture.identity.title);
    expect(failed.html).toContain('data-slot="subject-summary"');
    expect(failed.html).toContain(m.subject_section_failed());
    expect(failed.html).toContain('data-slot="retry"');
    expect(failed.html).not.toContain('HTTP 503');
    expect(failed.html).toContain('data-slot="reading-overview-tools"');
  });
}

test('shelf links preserve admitted names and languages while both literary consumers use human fallback guidance', () => {
  const fixture = readingOverviewExample('book');
  const labelled = renderToStaticMarkup(<BookShelfLink locale="en" type="schema:Book" label="文学" language="ja" />);
  expect(labelled).toContain('<span lang="ja">文学</span>');
  const fallback = m.books_catalogue_shelf();
  const link = renderToStaticMarkup(<BookShelfLink locale="en" type="schema:Book" />);
  expect(link).toContain(fallback);
  expect(link.replace(/<[^>]+>/g, '')).not.toContain('schema:Book');
  const reader = renderToStaticMarkup(
    <LiteraryReader
      locale="en"
      identity={literaryWorkIdentity(fixture.publicRead.subject, 'en')}
      shelfType="schema:Book"
    />,
  );
  const overview = renderToStaticMarkup(
    <LiteraryOverviewDestinations
      locale="en"
      subject={fixture.identity.id}
      readingType="schema:Book"
      views={['contents', 'editions', 'relations']}
    />,
  );
  for (const html of [reader, overview]) {
    expect(html).toContain(fallback);
    expect(html.replace(/<[^>]+>/g, '')).not.toContain('schema:Book');
  }
  expect(renderToStaticMarkup(<BookShelfLink locale="en" type="schema:Person" />)).toBe('');
});

test('compact Game and Anime readers keep their native facts, natural dates and detailed destinations', async () => {
  const { gameExample } = await import('../src/features/catalogue/game-reader/examples');
  const game = gameExample();
  const ready = await game.read(game.address);
  const gameClient = new QueryClient();
  const gameHtml = renderToStaticMarkup(
    <QueryClientProvider client={gameClient}>
      <ReadingOverviewContext.Provider value={true}>
        <WorkReadingBinding>
          <GameReader
            {...game.address}
            locale="en"
            source={game}
            reader={null}
            transport={game.read}
            initial={ready}
            compact
          />
        </WorkReadingBinding>
      </ReadingOverviewContext.Provider>
    </QueryClientProvider>,
  );
  gameClient.clear();
  expect(gameHtml).toContain('Windows');
  expect(gameHtml).toContain('May 2024');
  expect(gameHtml).toContain('Harbour trial');
  expect(gameHtml).toMatch(/<details data-slot="game-release-destination"[^>]*>/);
  expect(gameHtml).not.toMatch(/<details data-slot="game-release-destination"[^>]* open/);
  const anime = readingOverviewExample('anime');
  const row = anime.links.links[0]!;
  const animeHtml = renderToStaticMarkup(
    <ReadingOverviewContext.Provider value={true}>
      <ScreenReadingBoundary>
        <ScreenProfileReader
          compact
          locale="en"
          release={anime.release}
          public={anime.publicRead}
          episodeRead={{
            ok: true,
            state: 'ready',
            next: null,
            entries: [
              {
                id: row.subject,
                type: 'schema:TVSeason',
                label: 'Season One',
                language: 'en',
                typeLabel: { text: 'Season', lang: 'en' },
                membershipId: row.statement,
                holderId: row.subject,
                parentId: anime.identity.id,
                context: anime.publicRead.subject.context,
              },
            ],
          }}
        />
      </ScreenReadingBoundary>
    </ReadingOverviewContext.Provider>,
  );
  expect(animeHtml).toContain('Season One');
  expect(animeHtml).toContain('May 16, 2024');
  expect(animeHtml).toContain('山田 葵');
  expect(animeHtml).toContain('data-slot="screen-reading-details"');
  expect(animeHtml).not.toContain(m.screen_intro());
});

test('Overview dates preserve supplied precision and retain native presentation for out-of-range years and uncertainty', () => {
  const renderDate = (time: string, precision: number, extra = {}) =>
    renderToStaticMarkup(
      <ReadingOverviewContext.Provider value={true}>
        <CandidateValue
          locale="en"
          related={{}}
          snak={{
            property: { id: 'schema:datePublished', data_type: 'time' },
            value: {
              type: 'value',
              content: { time, precision, calendarmodel: 'http://www.wikidata.org/entity/Q1985727', ...extra },
            },
          }}
        />
      </ReadingOverviewContext.Provider>,
    );
  expect(renderDate('+2024-00-00T00:00:00Z', 9)).toMatch(/datetime="2024"/i);
  expect(renderDate('+2024-05-00T00:00:00Z', 10)).toContain('May 2024');
  expect(renderDate('+2024-05-00T00:00:00Z', 10)).not.toContain('May 1,');
  expect(renderDate('+1000000000000000-00-00T00:00:00Z', 9)).toContain('+1000000000000000');
  const uncertain = renderDate('+2024-05-16T00:00:00Z', 11, { before: 2, after: 3 });
  expect(uncertain).not.toContain('<time');
  expect(uncertain).toContain('+2024-05-16');
});
