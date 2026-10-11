import type { ZoneCatalogueFacts } from '@rezics/zone-sdk';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import anime from '../../zones/official/anime/index.tsx';
import { AnimeCataloguePanel } from '../../zones/official/anime/slots.tsx';
import manga from '../../zones/official/manga/index.tsx';
import { MangaCataloguePanel } from '../../zones/official/manga/slots.tsx';
import { zoneContentText } from '../language/untagged.ts';
import { CatalogueZoneFrame, catalogueLink, catalogueWork } from '../official-zone-stories/catalogue-zone.tsx';
import { PageContainer } from '../shell/page.tsx';

const work = catalogueWork('83', 'Harbor stories', 'en', 'completed');

/** The native card and panel receive unavailable facts when an owner continuation has not ended. */
function CatalogueRead({ slug, unavailable = false }: { slug: 'anime' | 'manga'; unavailable?: boolean }) {
  const facts: ZoneCatalogueFacts = unavailable
    ? { format: null, years: [], count: null, countName: null, unavailable: true }
    : { format: zoneContentText(slug === 'anime' ? 'TV' : 'Manga', 'en'), years: [2021],
      count: 12, countName: null, unavailable: false };
  const pkg = slug === 'anime' ? anime : manga;
  const Panel = slug === 'anime' ? AnimeCataloguePanel : MangaCataloguePanel;
  return <CatalogueZoneFrame slug={slug} pkg={pkg} locale="en">
    {(zone, card) => <PageContainer className="grid gap-4">
      <section aria-labelledby="catalogue-results">
        <h2 id="catalogue-results" className="sr-only">Catalogue entries</h2>
        <ul><li>{card(work, facts)}</li></ul>
      </section>
      <Panel zone={zone} work={work} facts={facts} fallback={null} Link={catalogueLink} credits={null} />
    </PageContainer>}
  </CatalogueZoneFrame>;
}

const meta = {
  title: 'Zone editor/Catalogue continuation',
  component: CatalogueRead,
  args: { slug: 'anime', unavailable: false },
  globals: { locale: 'en' },
} satisfies Meta<typeof CatalogueRead>;
export default meta;
type Story = StoryObj<typeof meta>;

const fits = async () => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

async function complete(canvasElement: HTMLElement, count: string) {
  const canvas = within(canvasElement);
  await expect(canvas.getAllByText('2021')).toHaveLength(2);
  await expect(canvas.getAllByText(count)).toHaveLength(2);
  await expect(canvasElement.querySelectorAll('[data-catalogue-unavailable]')).toHaveLength(0);
  await fits();
}

async function incomplete(canvasElement: HTMLElement) {
  const unavailable = canvasElement.querySelectorAll('[data-catalogue-unavailable]');
  await expect(unavailable).toHaveLength(2);
  for (const notice of unavailable) {
    await expect(notice).toBeVisible();
    await expect(notice).toHaveTextContent(/not available/);
  }
  await expect(canvasElement.querySelectorAll('[data-catalogue-facts]')).toHaveLength(0);
  await expect(within(canvasElement).queryByText('2021')).toBeNull();
  await fits();
}

export const AnimeComplete: Story = {
  async play({ canvasElement }) { await complete(canvasElement, '12 episodes'); },
};

export const AnimeIncompletePhone: Story = {
  args: { unavailable: true },
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) { await incomplete(canvasElement); },
};

export const MangaComplete: Story = {
  args: { slug: 'manga' },
  async play({ canvasElement }) { await complete(canvasElement, '12 volumes'); },
};

export const MangaIncompletePhone: Story = {
  args: { slug: 'manga', unavailable: true },
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) { await incomplete(canvasElement); },
};
