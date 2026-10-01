import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import lightNovels from '../../zones/official/light-novels/index.tsx';
import visualNovels from '../../zones/official/visual-novels/index.tsx';
import { ReaderActionsProvider } from '../catalogue/reader-actions.tsx';
import { RealmPageStory } from '../realm/story-page.tsx';
import * as tracking from '../tracking/fixtures.ts';
import { createMemoryMain, memoryReader } from '../tracking/memory.ts';
import { zoneMessagesFor } from '../zones/fixtures.ts';
import { cardRenderer, type PlacedModule, workRenderers, ZoneHome } from '../zones/zone-home.tsx';
import { messages as realmMessages } from '../realm/messages.ts';
import { IndexPage } from '../zones/site-pages.tsx';
import { ReleaseBrowse, ReleaseBrowseHeader } from './browse.tsx';
import { filtered, seriesWorks, zoneFor } from './fixtures.ts';
import { parseReleaseFilter, type ReleaseFilterState } from './state.ts';

// The Visual Novels and Light Novels Zones as `RealmBrowseRoute` and `ZoneSiteRoute` compose them: the
// release filter and the releases Main matched, a visual novel's page with availability first, a series'
// shelf, cards and progress. Nothing is matched here; the stories hold what Main would have returned.

const zoneSpec = (locale: UiLocale) => visualNovels.releaseFilter!(locale);
const playable = { language: 'en', platform: 'Windows', completeness: 'complete' } as const;
const state = (overrides: Record<string, string> = {}): ReleaseFilterState =>
  parseReleaseFilter({ releaseLanguage: 'en', releasePlatform: 'Windows', releaseCompleteness: 'complete', ...overrides });

function Browse({ locale, filter, items, next = null }: {
  locale: UiLocale; filter: ReleaseFilterState; items: typeof filtered; next?: string | null;
}) {
  const zone = zoneFor('visual-novels', locale);
  const messages = zoneMessagesFor(locale);
  const spec = zoneSpec(locale);
  const base = zone.links.browse;
  return <RealmPageStory zone={zone} pkg={visualNovels} execution={{ mode: 'package', slug: 'visual-novels' }}
    locale={locale}>
    <ReleaseBrowse header={<ReleaseBrowseHeader zone={zone} pkg={visualNovels} spec={spec} state={filter} base={base} />}
      spec={spec} state={filter} base={base} items={items} next={next} locale={locale} messages={messages}
      card={cardRenderer(zone, visualNovels, locale, messages)} />
  </RealmPageStory>;
}

const meta = {
  title: 'Zones/Release filter',
  component: Browse,
  args: { locale: 'en', filter: state(), items: filtered },
  parameters: { route: { pathname: '/en/r/visual-novels/browse' } },
  render: (args, { globals }) => <Browse {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />,
} satisfies Meta<typeof Browse>;
export default meta;
type Story = StoryObj<typeof meta>;

const fits = async () => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

/** "English + Windows + complete": each result names the release that matched, and the chips remove one condition. */
export const Filtered: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('form', { name: 'Find a playable release' })).toBeVisible();
    await expect(canvas.getByLabelText('Language')).toHaveValue(playable.language);
    await expect(canvas.getByLabelText('Platform')).toHaveValue(playable.platform);
    await expect(canvas.getByLabelText('Completeness')).toHaveValue(playable.completeness);
    await expect(canvas.getByText(/English · Windows · complete · fan translation by/)).toBeVisible();
    await expect(canvas.getByText('Translation Club')).toBeVisible();
    await expect(canvas.getByText('English · Switch · complete · official release')).toBeVisible();
    await expect(canvas.getByText('More releases match too.')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Remove filter: Windows' })).toHaveAttribute('href',
      '/en/r/visual-novels/browse?releaseLanguage=en&releaseCompleteness=complete');
    await fits();
  },
};

/** A fan release with no recorded translator says "fan translation" and no more; unknown completeness is said. */
export const ThinRecords: Story = {
  args: { filter: state({ releaseLanguage: 'ja', releaseOrigin: 'unofficial' }), items: filtered.slice(2) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Japanese · completeness unknown · fan translation')).toBeVisible();
    await expect(canvas.queryByText(/ by /)).toBeNull();
  },
};

/** Nothing meets every condition; a translated title alone is not an answer. */
export const NoMatch: Story = {
  args: { filter: state({ releaseLanguage: 'th' }), items: [] },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'No release meets every filter' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Clear all filters' })).toHaveAttribute('href',
      '/en/r/visual-novels/browse');
    await expect(canvas.queryByText(/matched release/i)).toBeNull();
  },
};

/** Main examines a bounded stretch of the library per page; an empty page that continues says so. */
export const KeepLooking: Story = {
  args: { items: [], next: 'cursor-2' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/Nothing in this stretch of the library matched/)).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Next' })).toHaveAttribute('href',
      expect.stringContaining('cursor=cursor-2'));
    await expect(canvas.queryByRole('heading', { name: 'No release meets every filter' })).toBeNull();
  },
};

/** Keyboard only: tab to each select, choose with the keys, and submit with the button. */
export const Keyboard: Story = {
  args: { filter: parseReleaseFilter({}), items: [] },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const language = canvas.getByLabelText('Language');
    language.focus();
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.tab();
    await expect(canvas.getByLabelText('Platform')).toHaveFocus();
    await userEvent.tab();
    await expect(canvas.getByLabelText('Completeness')).toHaveFocus();
    await userEvent.tab();
    await expect(canvas.getByLabelText('Translation')).toHaveFocus();
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: 'Show matching novels' })).toHaveFocus();
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText(/English · Windows · complete · fan translation by/)).toBeVisible();
    await fits();
  },
};

export const TraditionalChinese: Story = {
  args: { locale: 'zh-Hant' },
  globals: { locale: 'zh-Hant' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('form', { name: '尋找可玩的發行版' })).toBeVisible();
    await expect(canvas.getByText(/英文 · Windows · 完整 · .*粉絲翻譯/)).toBeVisible();
    await expect(canvas.getByText('Translation Club')).toBeVisible();
  },
};

/** A visual novel's page leads with where it can be played; the description follows, with VNDB credited. */
function Detail({ locale }: { locale: UiLocale }) {
  const zone = zoneFor('visual-novels', locale);
  const Slot = visualNovels.slots.workDetail!;
  return <RealmPageStory zone={zone} pkg={visualNovels} execution={{ mode: 'package', slug: 'visual-novels' }}
    locale={locale}>
    <Slot zone={zone} work={{ id: filtered[0]!.work.id, title: filtered[0]!.work.title, kind: 'game' }}
      fallback={null} Link={'a' as never}
      regions={{ availability: <section aria-label="Editions" data-region="availability"><p>Windows · English · Translation Club</p></section>,
        about: <section data-region="about"><p>A university student chases a phone-call message through time.</p></section>,
        volumes: null, progress: null }} />
  </RealmPageStory>;
}

export const AvailabilityFirst: StoryObj<typeof Detail> = {
  render: (_, { globals }) => <Detail locale={(globals.locale as UiLocale | undefined) ?? 'en'} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const availability = canvasElement.querySelector('[data-region="availability"]')!;
    const about = canvasElement.querySelector('[data-region="about"]')!;
    await expect(availability.compareDocumentPosition(about) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await expect(canvas.getAllByText(/VNDB database dump/).length).toBeGreaterThan(0);
    await expect(canvas.getByRole('link', { name: 'Open the Light Novels Zone' })).toHaveAttribute('href',
      '/en/r/light-novels');
    await expect(canvas.getByText(/does not sell games, link to stores, show prices/)).toBeVisible();
  },
};

/** The Light Novels Zone: series cards, and "Continue your series" with the next volume Main reports. */
function Series({ locale, signedIn }: { locale: UiLocale; signedIn: boolean }) {
  const zone = zoneFor('light-novels', locale);
  const main = createMemoryMain({ summaries: { [locale]: { ...tracking.indexSummary, language: locale,
    counts: { completed: 1, required: 3, completedRequired: 1 },
    completedParts: [tracking.indexSummary.completedParts[0]!],
    next: { part: { ...tracking.indexSummary.completedParts[1]!, displayLabel: 'Volume 2', available: true },
      reason: 'next_available_required_part' } } } });
  const [actions] = useState(() => memoryReader(main, { [seriesWorks[0]!.id]: 'reading' }));
  const shelf = { module: { id: 'shelf', type: 'shelf', title: 'Light Novels', rail: false, layout: 'covers',
    shuffle: false, more: null }, state: { state: 'ready', data: { tabs: [{ id: 'all', label: 'All',
    items: seriesWorks }] } } } as PlacedModule;
  const messages = zoneMessagesFor(locale);
  const home = <ZoneHome modules={[shelf]} zone={zone} pkg={lightNovels} locale={locale} messages={messages}
    empty={null} />;
  return <RealmPageStory zone={zone} pkg={lightNovels} execution={{ mode: 'package', slug: 'light-novels' }}
    locale={locale}>
    {signedIn ? <ReaderActionsProvider signedIn signInHref="/auth/start" actions={actions}>{home}
    </ReaderActionsProvider> : home}
  </RealmPageStory>;
}

export const SeriesShelf: StoryObj<typeof Series> = {
  args: { locale: 'en', signedIn: true },
  render: (args, { globals }) => <Series {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const shelf = await canvas.findByRole('region', { name: 'Continue your series' });
    await expect(within(shelf).getAllByRole('link', { name: 'Volume 2' })[0]).toBeVisible();
    await expect(within(shelf).getAllByText(/English/)[0]).toBeVisible();
    await expect(canvas.getAllByText('Sword Art Online').length).toBeGreaterThan(1);
    await expect(canvas.getByRole('link', { name: 'Open the Visual Novels Zone' })).toHaveAttribute('href',
      '/en/r/visual-novels');
    await fits();
  },
};

/** Signed out, no next-volume line or shelf is drawn; the cards are the platform's. */
export const SeriesShelfSignedOut: StoryObj<typeof Series> = {
  args: { locale: 'en', signedIn: false },
  render: args => <Series {...args} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByText('Sword Art Online').length).toBeGreaterThan(0);
    await expect(canvasElement.querySelector('[data-next-volume]')).toBeNull();
    await expect(canvasElement.querySelector('[data-next-volume-shelf]')).toBeNull();
  },
};

/** The catalogue page of the Light Novels Zone: "Continue your series" leads, then the series with their next volume. */
function SeriesIndexPage({ locale, signedIn }: { locale: UiLocale; signedIn: boolean }) {
  const zone = zoneFor('light-novels', locale);
  const messages = zoneMessagesFor(locale);
  const main = createMemoryMain({ summaries: { [locale]: { ...tracking.indexSummary, language: locale,
    counts: { completed: 1, required: 3, completedRequired: 1 }, completedParts: [tracking.indexSummary.completedParts[0]!],
    next: { part: { ...tracking.indexSummary.completedParts[1]!, displayLabel: 'Volume 2', available: true },
      reason: 'next_available_required_part' } } } });
  const [actions] = useState(() => memoryReader(main, { [seriesWorks[0]!.id]: 'reading' }));
  const card = cardRenderer(zone, lightNovels, locale, messages);
  const Slot = lightNovels.slots.index!;
  const items = seriesWorks.map(work => ({ id: work.id, revision: work.id, mainVersion: work.id,
    title: { value: work.title!.value, language: 'en', direction: 'ltr' as const, basis: 'requested' as const },
    cover: { kind: 'fallback' as const, policy: 'zone', key: work.id, resourceType: 'work' }, types: [],
    tagline: null, completionStatus: null, chapterCount: null, wordCount: null, lastUpdatedAt: null, inZone: true }));
  const route = { name: 'Catalogue', language: 'en', direction: 'ltr' as const, profile: 'zone-route-v1' as const, zone: 'z',
    path: '/catalogue', realm: null, revision: 'r', sourcePosition: { dataEpoch: 'e', sequence: '1' }, cost: {} as never,
    kind: 'index' as const, mount: { occurrence: 'o', segment: 'catalogue', target: 't' }, collection: 'c', items,
    nextCursor: null };
  const page = <IndexPage route={route} title="Catalogue" cursor={undefined}
    context={{ locale, ref: 'light-novels', realm: 'r', mounts: new Map() }} card={card} locale={locale}
    messages={realmMessages}
    arrange={(works, grid) => <Slot zone={zone} works={works} fallback={grid} Link={'a' as never}
      {...workRenderers(card, locale, messages)} />} />;
  return <RealmPageStory zone={zone} pkg={lightNovels} execution={{ mode: 'package', slug: 'light-novels' }} locale={locale}>
    <main>{signedIn ? <ReaderActionsProvider signedIn signInHref="/auth/start" actions={actions}>{page}</ReaderActionsProvider> : page}</main>
  </RealmPageStory>;
}

export const SeriesIndex: StoryObj<typeof SeriesIndexPage> = {
  args: { locale: 'en', signedIn: true },
  render: (args, { globals }) => <SeriesIndexPage {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const shelf = await canvas.findByRole('region', { name: 'Continue your series' });
    await expect(within(shelf).getAllByRole('link', { name: 'Volume 2' })[0]).toBeVisible();
    // The cards under it carry the same next volume, and the library state sits on each cover.
    await expect(canvas.getAllByText('Sword Art Online').length).toBeGreaterThan(1);
    await fits();
  },
};

export const SeriesIndexSignedOut: StoryObj<typeof SeriesIndexPage> = {
  args: { locale: 'en', signedIn: false },
  render: args => <SeriesIndexPage {...args} />,
  async play({ canvasElement }) {
    await expect(canvasElement.querySelector('[data-next-volume-shelf]')).toBeNull();
    await expect(canvasElement.querySelector('[data-next-volume]')).toBeNull();
    await expect(within(canvasElement).getAllByText('Sword Art Online').length).toBeGreaterThan(0);
  },
};
