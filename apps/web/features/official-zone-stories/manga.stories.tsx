import type { Meta, StoryObj } from '@storybook/react-vite';
import { materializeData } from 'native-i18n';
import { expect, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { spaceHref } from '../address/path.ts';
import { zoneMessagesFor } from '../zones/fixtures.ts';
import manga from '../../zones/official/manga/index.tsx';
import { MangaBrowseHeader, MangaCataloguePanel } from '../../zones/official/manga/slots.tsx';
import { captureCatalogueStory, CatalogueZoneFrame, catalogueFacts, catalogueLink, catalogueWork } from './catalogue-zone.tsx';

// The Manga Zone's browse, fact panel and footer. Volume count is the recorded count.
// A one-shot with no year says so, and chapter counts are never shown as volumes.

const longSeries = catalogueWork('m1', '長編漫画', 'ja', 'completed');
const yearless = catalogueWork('m2', 'A single chapter', 'en', 'upcoming');
const cancelled = catalogueWork('m3', 'Stopped', 'en', 'cancelled');

function Page({ locale, bounded = false }: { locale: UiLocale; bounded?: boolean }) {
  const browse = localizedPath(spaceHref('manga', 'site', ['browse']), locale);
  const results = materializeData(zoneMessagesFor(locale), { locale }).browseTitle({ zone: 'Manga' });
  return <CatalogueZoneFrame slug="manga" pkg={manga} locale={locale}>
    {(zone, card) => <>
      <MangaBrowseHeader zone={zone} fallback={null} Link={catalogueLink} filter={null} filtered={false} year={{
        action: browse, value: '1995', kept: [{ name: 'status', value: 'completed' }],
        clearHref: browse, directoryHref: `${browse}?years=1`, directory: false, bounded,
      }} />
      <section aria-labelledby="manga-results">
        <h2 id="manga-results" className="sr-only">{results}</h2>
        <ul className="grid grid-cols-2 gap-x-(--zone-shelf-gap) gap-y-8 p-4 sm:grid-cols-3 lg:grid-cols-4">
          <li>{card(longSeries, catalogueFacts('Manga', [1995], 21))}</li>
          <li>{card(yearless, catalogueFacts('One-shot', [], null))}</li>
          <li>{card(cancelled, catalogueFacts('Manga', [1997], 3))}</li>
        </ul>
      </section>
      <div className="p-4">
        <MangaCataloguePanel zone={zone} fallback={null} Link={catalogueLink} credits={null}
          work={longSeries} facts={catalogueFacts('Manga', [1995], 21)} />
      </div>
    </>}
  </CatalogueZoneFrame>;
}

const meta = {
  title: 'Zones/Manga',
  component: Page,
  args: { locale: 'en', bounded: false },
  parameters: { route: { pathname: localizedPath(spaceHref('manga', 'site', ['browse']), 'en') } },
  render: (args, { globals }) => <Page {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />,
} satisfies Meta<typeof Page>;
export default meta;
type Story = StoryObj<typeof meta>;

const fits = async () => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

async function recorded(canvasElement: HTMLElement, copy: {
  year: string; volumes: string; missing: string; cancelled: string; sibling: string; archive: string | RegExp;
}) {
  const canvas = within(canvasElement);
  await expect(canvas.getByLabelText(copy.year)).toBeVisible();
  await expect(canvas.getAllByText(copy.volumes).length).toBeGreaterThan(0);
  await expect(canvas.getByText(copy.missing)).toBeVisible();
  await expect(canvas.getByText(copy.cancelled)).toBeVisible();
  await expect(canvas.getByRole('link', { name: copy.sibling })).toBeVisible();
  await expect(canvas.getAllByText(copy.archive).length).toBeGreaterThan(0);
  await expect(canvas.queryByText(/\d+ episodes/)).toBeNull();
  await fits();
}

export const EnglishDesktop: Story = {
  parameters: { viewport: { defaultViewport: 'desktop' } },
  async play({ canvasElement }) {
    await recorded(canvasElement, {
      year: 'Publication year', volumes: '21 volumes', missing: 'Year not recorded',
      cancelled: 'Cancelled', sibling: 'Open the Anime Zone', archive: /Bangumi Archive wiki export/,
    });
    await captureCatalogueStory(canvasElement, 'manga-en-desktop');
  },
};

export const EnglishPhone: Story = {
  parameters: { viewport: { defaultViewport: 'phone' } },
  async play({ canvasElement }) {
    await recorded(canvasElement, {
      year: 'Publication year', volumes: '21 volumes', missing: 'Year not recorded',
      cancelled: 'Cancelled', sibling: 'Open the Anime Zone', archive: /Bangumi Archive wiki export/,
    });
    await captureCatalogueStory(canvasElement, 'manga-en-phone');
  },
};

export const JapaneseDesktop: Story = {
  args: { locale: 'ja' },
  globals: { locale: 'ja' },
  parameters: { viewport: { defaultViewport: 'desktop' } },
  async play({ canvasElement }) {
    await recorded(canvasElement, {
      year: '公開年', volumes: '21 巻', missing: '年は記録されていません',
      cancelled: '中止', sibling: 'アニメゾーンを開く', archive: /Bangumi Archive/,
    });
    await captureCatalogueStory(canvasElement, 'manga-ja-desktop');
  },
};

export const JapanesePhone: Story = {
  args: { locale: 'ja' },
  globals: { locale: 'ja' },
  parameters: { viewport: { defaultViewport: 'phone' } },
  async play({ canvasElement }) {
    await recorded(canvasElement, {
      year: '公開年', volumes: '21 巻', missing: '年は記録されていません',
      cancelled: '中止', sibling: 'アニメゾーンを開く', archive: /Bangumi Archive/,
    });
    await captureCatalogueStory(canvasElement, 'manga-ja-phone');
  },
};

export const BoundedYear: Story = {
  args: { bounded: true },
  parameters: { viewport: { defaultViewport: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/stops after the publication years/)).toBeVisible();
    await fits();
    await captureCatalogueStory(canvasElement, 'manga-bounded');
  },
};
