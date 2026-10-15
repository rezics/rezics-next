import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, within } from 'storybook/test';
import catalogueDiscovery from '../zones/catalogue-discovery.stories.tsx';
import episodeProgress from '../tracking/anime-two-device-recorded.stories.tsx';
import animeHub from '../work-page/anime-hub-recorded.stories.tsx';
import mangaHub from '../work-page/manga-hub-recorded.stories.tsx';
import novelsHub from '../work-page/visual-novels-hub-recorded.stories.tsx';
import gamesHub from '../work-page/games-hub-recorded.stories.tsx';
import animeContents from '../work-page/anime-contents-recorded.stories.tsx';
import mangaBrowse from '../zones/manga-browse-recorded.stories.tsx';
import novelsBrowse from '../zones/visual-novels-browse-recorded.stories.tsx';
import animeCatalogue from '../official-zone-stories/anime.stories.tsx';
import mangaCatalogue from '../official-zone-stories/manga.stories.tsx';
import gamesLibrary from '../library/games-library-recorded.stories.tsx';
import novelsLibrary from '../library/visual-novels-library-recorded.stories.tsx';
import chapterProgress from '../tracking/chapter-progress-page.stories.tsx';
import libraryJa from '../library/messages/ja.ts';
import { messages as libraryEn } from '../library/messages.ts';

type Surface = 'animeHub' | 'mangaHub' | 'novelsHub' | 'gamesHub' | 'animeContents'
  | 'mangaBrowse' | 'novelsBrowse' | 'animeCatalogue' | 'mangaCatalogue'
  | 'gamesLibrary' | 'novelsLibrary' | 'chapterProgress' | 'gamesBrowse' | 'animeBrowse' | 'episodeProgress';
function MediaPages({ surface, locale }: { surface: Surface; locale: 'en' | 'ja' }) {
  switch (surface) {
    case 'episodeProgress': return <episodeProgress.component {...episodeProgress.args} locale={locale} />;
    case 'gamesBrowse': return <catalogueDiscovery.component {...catalogueDiscovery.args} slug="games" locale={locale} />;
    case 'animeBrowse': return <animeCatalogue.component {...animeCatalogue.args} locale={locale} />;
    case 'animeHub': return <animeHub.component {...animeHub.args} locale={locale} />;
    case 'mangaHub': return <mangaHub.component {...mangaHub.args} locale={locale} />;
    case 'novelsHub': return <novelsHub.component {...novelsHub.args} persona="visitor" locale={locale} />;
    case 'gamesHub': return <gamesHub.component {...gamesHub.args} locale={locale} />;
    case 'animeContents': return <animeContents.component {...animeContents.args} persona="member" locale={locale} />;
    case 'mangaBrowse': return <mangaBrowse.component {...mangaBrowse.args} locale={locale} />;
    case 'novelsBrowse': return <novelsBrowse.component {...novelsBrowse.args} locale={locale} />;
    case 'animeCatalogue': return <animeCatalogue.component {...animeCatalogue.args} locale={locale} />;
    case 'mangaCatalogue': return <mangaCatalogue.component {...mangaCatalogue.args} locale={locale} />;
    case 'gamesLibrary': return <gamesLibrary.component {...gamesLibrary.args} locale={locale}
      messages={locale === 'ja' ? { ...libraryEn, ...libraryJa } : libraryEn} />;
    case 'novelsLibrary': return <novelsLibrary.component {...novelsLibrary.args} locale={locale}
      messages={locale === 'ja' ? { ...libraryEn, ...libraryJa } : libraryEn} />;
    case 'chapterProgress': return <chapterProgress.component {...chapterProgress.args} locale={locale} />;
  }
}

// Reuse the recorded page readers; desktop evidence follows the production review width.
const meta = {
  title: 'Media/Production page review', component: MediaPages,
  args: { surface: 'animeHub', locale: 'en' },
  render: args => <MediaPages key={`${args.surface}:${args.locale}`} {...args} />,
  parameters: { controls: { disable: true }, viewport: { options: {
    reviewDesktop: { name: 'Review desktop (1440 × 1000)', styles: { width: '1440px', height: '1000px' }, type: 'desktop' },
  } } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).findAllByRole('heading')).resolves.not.toHaveLength(0);
    await waitFor(() => expect(canvasElement.querySelector('[aria-busy=true]')).toBeNull());
    await document.fonts.ready;
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    await expect(within(canvasElement).queryByRole('alert')).not.toBeInTheDocument();
  },
} satisfies Meta<typeof MediaPages>;
export default meta;
type Story = StoryObj<typeof meta>;
function review(surface: Surface, locale: 'en' | 'ja', phone: boolean): Story {
  return { args: { surface, locale }, globals: { locale, viewport: { value: phone ? 'phone' : 'reviewDesktop' } } };
}
export const AnimeHubEnglishPhone: Story = review('animeHub', 'en', true);
export const AnimeHubEnglishDesktop: Story = review('animeHub', 'en', false);
export const AnimeHubJapanesePhone: Story = review('animeHub', 'ja', true);
export const AnimeHubJapaneseDesktop: Story = review('animeHub', 'ja', false);
export const MangaHubEnglishPhone: Story = review('mangaHub', 'en', true);
export const MangaHubEnglishDesktop: Story = review('mangaHub', 'en', false);
export const MangaHubJapanesePhone: Story = review('mangaHub', 'ja', true);
export const MangaHubJapaneseDesktop: Story = review('mangaHub', 'ja', false);
export const NovelsHubEnglishPhone: Story = review('novelsHub', 'en', true);
export const NovelsHubEnglishDesktop: Story = review('novelsHub', 'en', false);
export const NovelsHubJapanesePhone: Story = review('novelsHub', 'ja', true);
export const NovelsHubJapaneseDesktop: Story = review('novelsHub', 'ja', false);
export const GamesHubEnglishPhone: Story = review('gamesHub', 'en', true);
export const GamesHubEnglishDesktop: Story = review('gamesHub', 'en', false);
export const GamesHubJapanesePhone: Story = review('gamesHub', 'ja', true);
export const GamesHubJapaneseDesktop: Story = review('gamesHub', 'ja', false);
export const AnimeContentsEnglishPhone: Story = review('animeContents', 'en', true);
export const AnimeContentsEnglishDesktop: Story = review('animeContents', 'en', false);
export const AnimeContentsJapanesePhone: Story = review('animeContents', 'ja', true);
export const AnimeContentsJapaneseDesktop: Story = review('animeContents', 'ja', false);
export const MangaBrowseEnglishPhone: Story = review('mangaBrowse', 'en', true);
export const MangaBrowseEnglishDesktop: Story = review('mangaBrowse', 'en', false);
export const MangaBrowseJapanesePhone: Story = review('mangaBrowse', 'ja', true);
export const MangaBrowseJapaneseDesktop: Story = review('mangaBrowse', 'ja', false);
export const NovelsBrowseEnglishPhone: Story = review('novelsBrowse', 'en', true);
export const NovelsBrowseEnglishDesktop: Story = review('novelsBrowse', 'en', false);
export const NovelsBrowseJapanesePhone: Story = review('novelsBrowse', 'ja', true);
export const NovelsBrowseJapaneseDesktop: Story = review('novelsBrowse', 'ja', false);
export const AnimeCatalogueEnglishPhone: Story = review('animeCatalogue', 'en', true);
export const AnimeCatalogueEnglishDesktop: Story = review('animeCatalogue', 'en', false);
export const AnimeCatalogueJapanesePhone: Story = review('animeCatalogue', 'ja', true);
export const AnimeCatalogueJapaneseDesktop: Story = review('animeCatalogue', 'ja', false);
export const MangaCatalogueEnglishPhone: Story = review('mangaCatalogue', 'en', true);
export const MangaCatalogueEnglishDesktop: Story = review('mangaCatalogue', 'en', false);
export const MangaCatalogueJapanesePhone: Story = review('mangaCatalogue', 'ja', true);
export const MangaCatalogueJapaneseDesktop: Story = review('mangaCatalogue', 'ja', false);
export const GamesLibraryEnglishPhone: Story = review('gamesLibrary', 'en', true);
export const GamesLibraryEnglishDesktop: Story = review('gamesLibrary', 'en', false);
export const GamesLibraryJapanesePhone: Story = review('gamesLibrary', 'ja', true);
export const GamesLibraryJapaneseDesktop: Story = review('gamesLibrary', 'ja', false);
export const NovelsLibraryEnglishPhone: Story = review('novelsLibrary', 'en', true);
export const NovelsLibraryEnglishDesktop: Story = review('novelsLibrary', 'en', false);
export const NovelsLibraryJapanesePhone: Story = review('novelsLibrary', 'ja', true);
export const NovelsLibraryJapaneseDesktop: Story = review('novelsLibrary', 'ja', false);
export const ChapterProgressEnglishPhone: Story = review('chapterProgress', 'en', true);
export const ChapterProgressEnglishDesktop: Story = review('chapterProgress', 'en', false);
export const ChapterProgressJapanesePhone: Story = review('chapterProgress', 'ja', true);
export const ChapterProgressJapaneseDesktop: Story = review('chapterProgress', 'ja', false);
export const GamesBrowseEnglishPhone: Story = review('gamesBrowse', 'en', true);
export const GamesBrowseEnglishDesktop: Story = review('gamesBrowse', 'en', false);
export const GamesBrowseJapanesePhone: Story = review('gamesBrowse', 'ja', true);
export const GamesBrowseJapaneseDesktop: Story = review('gamesBrowse', 'ja', false);
export const AnimeBrowseEnglishPhone: Story = review('animeBrowse', 'en', true);
export const AnimeBrowseEnglishDesktop: Story = review('animeBrowse', 'en', false);
export const AnimeBrowseJapanesePhone: Story = review('animeBrowse', 'ja', true);
export const AnimeBrowseJapaneseDesktop: Story = review('animeBrowse', 'ja', false);
export const EpisodeProgressEnglishPhone: Story = review('episodeProgress', 'en', true);
export const EpisodeProgressEnglishDesktop: Story = review('episodeProgress', 'en', false);
export const EpisodeProgressJapanesePhone: Story = review('episodeProgress', 'ja', true);
export const EpisodeProgressJapaneseDesktop: Story = review('episodeProgress', 'ja', false);

