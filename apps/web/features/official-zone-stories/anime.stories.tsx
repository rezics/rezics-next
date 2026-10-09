import type { Meta, StoryObj } from '@storybook/react-vite';
import { materializeData } from 'native-i18n';
import { expect, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { spaceHref } from '../address/path.ts';
import { zoneMessagesFor } from '../zones/fixtures.ts';
import anime, { animeFormatNames } from '../../zones/official/anime/index.tsx';
import { AnimeBrowseHeader, AnimeCataloguePanel } from '../../zones/official/anime/slots.tsx';
import { captureCatalogueStory, CatalogueZoneFrame, catalogueFacts, catalogueLink, catalogueWork } from './catalogue-zone.tsx';

// The Anime Zone's browse, fact panel and footer. Facts are the ones a read would pass.
// A card shows only recorded facts. The work page names each fact that is missing.

const longSeries = catalogueWork('a1', '長編シリーズ', 'ja', 'completed');
const yearless = catalogueWork('a2', 'Unclassified picture', 'en', null);
const upcoming = catalogueWork('a3', 'Soon', 'en', 'upcoming');

function Page({ locale, bounded = false }: { locale: UiLocale; bounded?: boolean }) {
  const browse = localizedPath(spaceHref('anime', 'site', ['browse']), locale);
  const results = materializeData(zoneMessagesFor(locale), { locale }).browseTitle({ zone: 'Anime' });
  return <CatalogueZoneFrame slug="anime" pkg={anime} locale={locale}>
    {(zone, card) => <>
      <AnimeBrowseHeader zone={zone} fallback={null} Link={catalogueLink} filter={null} filtered={false} year={{
        action: browse, value: '1980', kept: [{ name: 'concept', value: animeFormatNames[0] }],
        clearHref: browse, directoryHref: `${browse}?years=1`, directory: false, bounded,
      }} />
      <section aria-labelledby="anime-results">
        <h2 id="anime-results" className="sr-only">{results}</h2>
        <ul className="grid grid-cols-2 gap-x-(--zone-shelf-gap) gap-y-8 p-4 sm:grid-cols-3 lg:grid-cols-4">
          <li>{card(longSeries, catalogueFacts('TV', [1980], 1155))}</li>
          <li>{card(yearless, catalogueFacts(null, [], null))}</li>
          <li>{card(upcoming, catalogueFacts('TV', [1981], 12))}</li>
        </ul>
      </section>
      <div className="grid gap-4 p-4">
        <AnimeCataloguePanel zone={zone} fallback={null} Link={catalogueLink} credits={null}
          work={longSeries} facts={catalogueFacts('TV', [1980], 1155)} />
        <AnimeCataloguePanel zone={zone} fallback={null} Link={catalogueLink} credits={null}
          work={yearless} facts={catalogueFacts(null, [], null)} />
      </div>
    </>}
  </CatalogueZoneFrame>;
}

const meta = {
  title: 'Zones/Anime',
  component: Page,
  args: { locale: 'en', bounded: false },
  parameters: { route: { pathname: localizedPath(spaceHref('anime', 'site', ['browse']), 'en') } },
  render: (args, { globals }) => <Page {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />,
} satisfies Meta<typeof Page>;
export default meta;
type Story = StoryObj<typeof meta>;

const fits = async () => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

async function recorded(canvasElement: HTMLElement, copy: {
  year: string; episodes: string; upcoming: string; sibling: string; archive: string | RegExp;
  cardOmits: string; panelNames: readonly string[];
}) {
  const canvas = within(canvasElement);
  await expect(canvas.getByLabelText(copy.year)).toBeVisible();
  await expect(canvas.getAllByText(copy.episodes).length).toBeGreaterThan(0);
  await expect(canvas.getByText(copy.upcoming)).toBeVisible();
  const cards = canvasElement.querySelectorAll('[data-catalogue-card]');
  await expect(cards[1]?.textContent ?? '').not.toContain(copy.cardOmits);
  await expect(cards[1]?.querySelector('[data-catalogue-facts]')).toBeNull();
  const panels = canvasElement.querySelectorAll('[data-catalogue-panel]');
  const gap = panels[1]?.textContent ?? '';
  for (const line of copy.panelNames) await expect(gap).toContain(line);
  await expect(canvas.getByRole('link', { name: copy.sibling })).toBeVisible();
  await expect(canvas.getAllByText(copy.archive)).toHaveLength(1);
  await expect(canvas.queryByText(/chapter/i)).toBeNull();
  await fits();
}

/** Television, a year, the long series, and an unclassified card with no catalogue line. */
export const EnglishDesktop: Story = {
  parameters: { viewport: { defaultViewport: 'desktop' } },
  async play({ canvasElement }) {
    await recorded(canvasElement, {
      year: 'Publication year', episodes: '1,155 episodes', upcoming: 'Upcoming',
      cardOmits: 'not recorded',
      panelNames: ['Format not recorded', 'Year not recorded', 'Episode count not recorded', 'Status not recorded'],
      sibling: 'Open the Manga Zone', archive: /Bangumi Archive wiki export/,
    });
    await captureCatalogueStory(canvasElement, 'anime-en-desktop');
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Clear year' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Newest years' })).toBeVisible();
  },
};

export const EnglishPhone: Story = {
  parameters: { viewport: { defaultViewport: 'phone' } },
  async play({ canvasElement }) {
    await recorded(canvasElement, {
      year: 'Publication year', episodes: '1,155 episodes', upcoming: 'Upcoming',
      cardOmits: 'not recorded',
      panelNames: ['Format not recorded', 'Year not recorded', 'Episode count not recorded', 'Status not recorded'],
      sibling: 'Open the Manga Zone', archive: /Bangumi Archive wiki export/,
    });
    await captureCatalogueStory(canvasElement, 'anime-en-phone');
  },
};

export const JapaneseDesktop: Story = {
  args: { locale: 'ja' },
  globals: { locale: 'ja' },
  parameters: { viewport: { defaultViewport: 'desktop' } },
  async play({ canvasElement }) {
    await recorded(canvasElement, {
      year: '公開年', episodes: '1,155 話', upcoming: '未放送',
      cardOmits: '記録されていません',
      panelNames: ['形式は記録されていません', '年は記録されていません', '話数は記録されていません', '状態は記録されていません'],
      sibling: '漫画ゾーンを開く', archive: /Bangumi Archive/,
    });
    await captureCatalogueStory(canvasElement, 'anime-ja-desktop');
  },
};

export const JapanesePhone: Story = {
  args: { locale: 'ja' },
  globals: { locale: 'ja' },
  parameters: { viewport: { defaultViewport: 'phone' } },
  async play({ canvasElement }) {
    await recorded(canvasElement, {
      year: '公開年', episodes: '1,155 話', upcoming: '未放送',
      cardOmits: '記録されていません',
      panelNames: ['形式は記録されていません', '年は記録されていません', '話数は記録されていません', '状態は記録されていません'],
      sibling: '漫画ゾーンを開く', archive: /Bangumi Archive/,
    });
    await captureCatalogueStory(canvasElement, 'anime-ja-phone');
  },
};

/** The year read stopped at its bound, so the page says a work outside that window is absent. */
export const BoundedYear: Story = {
  args: { bounded: true },
  parameters: { viewport: { defaultViewport: 'desktop' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/stops after the publication years/)).toBeVisible();
    await fits();
    await captureCatalogueStory(canvasElement, 'anime-bounded');
  },
};
