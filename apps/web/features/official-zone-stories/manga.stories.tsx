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
// A card shows only recorded facts. The work page names a missing year or volume count.
// Chapter counts are never shown as volumes.

const longSeries = catalogueWork('m1', '長編漫画', 'ja', 'completed', 'catalogue-editor');
const yearless = catalogueWork('m2', 'A single chapter', 'en', 'upcoming');
const cancelled = catalogueWork('m3', 'Stopped', 'en', 'cancelled');

function Page({ locale, bounded = false }: { locale: UiLocale; bounded?: boolean }) {
  const browse = localizedPath(spaceHref('manga', 'site', ['browse']), locale);
  const results = materializeData(zoneMessagesFor(locale), { locale }).browseTitle({ zone: 'Manga' });
  return <CatalogueZoneFrame slug="manga" pkg={manga} locale={locale}>
    {(zone, card) => <>
      <div className="mx-auto grid w-full max-w-6xl gap-4 px-4 sm:px-6 lg:px-10">
        <MangaBrowseHeader zone={zone} fallback={null} Link={catalogueLink} filter={null} filtered={false} year={{
          action: browse, value: '1995', kept: [{ name: 'status', value: 'completed' }],
          clearHref: browse, directoryHref: `${browse}?years=1`, directory: false, window: 200, bounded,
        }} />
        <section aria-labelledby="manga-results">
          <h2 id="manga-results" className="sr-only">{results}</h2>
          <ul className="grid gap-3">
            <li>{card(longSeries, catalogueFacts('Manga', [1995], 21))}</li>
            <li>{card(yearless, catalogueFacts('One-shot', [], null))}</li>
            <li>{card(cancelled, catalogueFacts('Manga', [1997], 3))}</li>
          </ul>
        </section>
      </div>
      <div className="grid gap-4 p-4">
        <MangaCataloguePanel zone={zone} fallback={null} Link={catalogueLink} credits={null}
          work={longSeries} facts={catalogueFacts('Manga', [1995], 21)} />
        <MangaCataloguePanel zone={zone} fallback={null} Link={catalogueLink} credits={null}
          work={yearless} facts={catalogueFacts('One-shot', [], null)} />
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
  year: string; volumes: string; status: string; cancelled: string; sibling: string;
  cardOmits: readonly string[]; panelNames: readonly string[];
}) {
  const canvas = within(canvasElement);
  await expect(canvas.getByLabelText(copy.year)).toBeVisible();
  await expect(canvas.getAllByText(copy.volumes).length).toBeGreaterThan(0);
  await expect(canvas.getByText(copy.cancelled)).toBeVisible();
  const cards = canvasElement.querySelectorAll('[data-catalogue-card]');
  await expect(cards[0]?.textContent?.match(new RegExp(copy.status, 'g'))).toHaveLength(1);
  const oneShot = cards[1];
  const cardText = oneShot?.textContent ?? '';
  for (const line of copy.cardOmits) await expect(cardText).not.toContain(line);
  await expect(cardText).toContain(copy.panelNames[0]);
  const gap = canvasElement.querySelectorAll('[data-catalogue-panel]')[1]?.textContent ?? '';
  for (const line of copy.panelNames) await expect(gap).toContain(line);
  await expect(canvas.getByRole('link', { name: copy.sibling })).toBeVisible();
  await expect(canvas.getByRole('link', { name: 'Bangumi' })).toHaveAttribute('href', 'https://bgm.tv');
  await expect(canvas.getByRole('link', { name: 'CC BY-SA 3.0' })).toHaveAttribute('href', 'https://creativecommons.org/licenses/by-sa/3.0/');
  await expect(canvas.queryByText('catalogue-editor')).toBeNull();
  await expect(canvas.queryByText(/\d+ episodes/)).toBeNull();
  await fits();
}

export const EnglishDesktop: Story = {
  parameters: { viewport: { defaultViewport: 'desktop' } },
  async play({ canvasElement }) {
    await recorded(canvasElement, {
      year: 'Publication year', volumes: '21 volumes', status: 'Completed', cancelled: 'Cancelled',
      cardOmits: ['Year not recorded', 'Volume count not recorded'],
      panelNames: ['One-shot', 'Year not recorded', 'Volume count not recorded', 'Upcoming'],
      sibling: 'Open the Anime Zone',
    });
    await captureCatalogueStory('EnglishDesktop');
  },
};

export const EnglishPhone: Story = {
  parameters: { viewport: { defaultViewport: 'phone' } },
  async play({ canvasElement }) {
    await recorded(canvasElement, {
      year: 'Publication year', volumes: '21 volumes', status: 'Completed', cancelled: 'Cancelled',
      cardOmits: ['Year not recorded', 'Volume count not recorded'],
      panelNames: ['One-shot', 'Year not recorded', 'Volume count not recorded', 'Upcoming'],
      sibling: 'Open the Anime Zone',
    });
    await captureCatalogueStory('EnglishPhone');
  },
};

export const JapaneseDesktop: Story = {
  args: { locale: 'ja' },
  globals: { locale: 'ja' },
  parameters: { viewport: { defaultViewport: 'desktop' } },
  async play({ canvasElement }) {
    await recorded(canvasElement, {
      year: '公開年', volumes: '21 巻', status: '完結', cancelled: '中止',
      cardOmits: ['年は記録されていません', '巻数は記録されていません'],
      panelNames: ['One-shot', '年は記録されていません', '巻数は記録されていません', '未発売'],
      sibling: 'アニメゾーンを開く',
    });
    await captureCatalogueStory('JapaneseDesktop');
  },
};

export const JapanesePhone: Story = {
  args: { locale: 'ja' },
  globals: { locale: 'ja' },
  parameters: { viewport: { defaultViewport: 'phone' } },
  async play({ canvasElement }) {
    await recorded(canvasElement, {
      year: '公開年', volumes: '21 巻', status: '完結', cancelled: '中止',
      cardOmits: ['年は記録されていません', '巻数は記録されていません'],
      panelNames: ['One-shot', '年は記録されていません', '巻数は記録されていません', '未発売'],
      sibling: 'アニメゾーンを開く',
    });
    await captureCatalogueStory('JapanesePhone');
  },
};

export const BoundedYear: Story = {
  args: { bounded: true },
  parameters: { viewport: { defaultViewport: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/first 200 Works in the current order/)).toBeVisible();
    await fits();
    await captureCatalogueStory('BoundedYear');
  },
};
