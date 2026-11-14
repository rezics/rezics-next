import { useLayoutEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { View } from '@rezics/composition';
import {
  anime,
  animeEpisodes,
  animeId,
  animeRealm,
  animeSeasons,
  animeSummary,
} from '../kernel/fixtures/anime-showcase';
import { selectAnimeShowcase, type AnimeScenario } from '../kernel/fake/anime-showcase';
import { screenEpisodeSubjectHref } from '../features/catalogue/screen-episode-reader/navigation';
import { subjectVisitReturn } from '../features/pages/subject-visit-navigation';
import { subjectHref, subjectViewHref } from '../subject/subject-href';
import { getLocale } from '../paraglide/runtime.js';
import { PageStory } from './page';

type Entry = 'series' | 'season' | 'episode' | 'later-window' | 'sparse-season' | 'progress';

/** Direct entries use the same membership ids and one-hop return addresses as a manual visit. */
function entryPath(entry: Entry, locale: string, view: View, realm: boolean) {
  const identity = (id: string) => ({ id, label: animeSummary(id, locale).label.value });
  const query = realm ? `?realm=${animeRealm}` : '';
  const seriesPath = `${subjectHref(identity(anime.id), locale).href}${query}`;
  const source = (address: string) => {
    const url = new URL(address, 'https://rezics.invalid');
    return { pathname: url.pathname, searchStr: url.search, hash: url.hash };
  };
  const hrefs = { subjectHref, visitReturn: subjectVisitReturn };
  const season = animeSeasons[entry === 'sparse-season' ? 2 : 0]!;
  const membership = season.statements['schema:isPartOf']![0]!;
  const seasonPath = screenEpisodeSubjectHref(
    { id: season.id, membershipId: membership.id },
    identity(season.id).label,
    locale,
    source(seriesPath),
    hrefs,
  );
  if (entry === 'season' || entry === 'sparse-season') return seasonPath;
  const seasonUrl = new URL(seasonPath, 'https://rezics.invalid');
  if (entry === 'later-window') {
    seasonUrl.searchParams.set('screenCursor', 'anime:schema:isPartOf:20');
    return `${seasonUrl.pathname}${seasonUrl.search}#screen-episode-list`;
  }
  if (entry === 'episode') {
    const episode = animeEpisodes[20]!;
    const statement = episode.statements['schema:isPartOf']![0]!;
    // The exact parent frontier is the later native window, not a title-derived episode index.
    seasonUrl.searchParams.set('screenCursor', 'anime:schema:isPartOf:20');
    return screenEpisodeSubjectHref(
      { id: episode.id, membershipId: statement.id },
      identity(episode.id).label,
      locale,
      source(`${seasonUrl.pathname}${seasonUrl.search}`),
      hrefs,
    );
  }
  if (entry === 'progress') {
    return `/${locale}/library/progress/${animeId(500)}`;
  }
  return subjectViewHref(identity(anime.id), locale, view, query);
}

function AnimeStory({
  entry = 'series',
  view = 'overview',
  member = true,
  scenario = 'rich',
  realm = false,
}: {
  entry?: Entry;
  view?: View;
  member?: boolean;
  scenario?: AnimeScenario;
  realm?: boolean;
}) {
  const locale = getLocale();
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    selectAnimeShowcase(scenario);
    setReady(true);
    return () => selectAnimeShowcase();
  }, [scenario, locale, member, entry, realm]);
  if (!ready) return null;
  return (
    <PageStory
      key={`${locale}:${member}:${entry}:${view}:${scenario}:${realm}`}
      previewNewTabs
      visitor={member ? 'Signed In' : 'Signed Out'}
      path={entryPath(entry, locale, view, realm)}
      ratingsFixture={entry === 'sparse-season' ? 'subject-ratings-empty' : 'subject-ratings-global'}
    />
  );
}

const meta = {
  title: 'Library/Anime',
  id: 'pages-library-anime',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The Last Observatory is an invented anime with three seasons, 28 episode identities, a companion film, people and characters. Authored local artwork and contract-shaped synthetic responses illustrate the installed Screen and common Subject readers; they are not native API or provider acceptance. This is the actual PageStory route tree, shell and released composition. The main page stays still: choose tabs, open a season, continue its native window, open an exact episode and use Return to restore the parent membership and frontier. Direct Episode enters from Season One’s later window. The third season deliberately withholds dates, credits, cover and episode population. Member progress is a separate private scalar session; it does not mark individual episodes complete. Failed page retry succeeds only after the reader chooses Retry. Locale, Theme and viewport globals work on all entries without replacing identities. No autoplay or publisher is installed here.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Series: Story = { name: 'Anime · series', render: () => <AnimeStory /> };
export const SignedOut: Story = { render: () => <AnimeStory member={false} /> };
export const Contents: Story = { render: () => <AnimeStory view="contents" /> };
export const Characters: Story = { render: () => <AnimeStory view="characters" /> };
export const Credits: Story = { render: () => <AnimeStory view="credits" /> };
export const Relations: Story = { render: () => <AnimeStory view="relations" /> };
export const Reviews: Story = { render: () => <AnimeStory view="reviews" /> };
export const Discussion: Story = { render: () => <AnimeStory view="discussion" /> };
export const Lists: Story = { render: () => <AnimeStory view="lists" /> };
export const Details: Story = { render: () => <AnimeStory view="details" /> };
export const Season: Story = { render: () => <AnimeStory entry="season" /> };
export const Episode: Story = { render: () => <AnimeStory entry="episode" /> };
export const LaterEpisodeWindow: Story = { render: () => <AnimeStory entry="later-window" /> };
export const SparseSeason: Story = { render: () => <AnimeStory entry="sparse-season" /> };
export const FailedPageRetry: Story = { render: () => <AnimeStory scenario="failure" /> };
export const MemberProgress: Story = { render: () => <AnimeStory entry="progress" /> };
