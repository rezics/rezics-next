import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import anime from '../../zones/official/anime/index.tsx';
import manga from '../../zones/official/manga/index.tsx';
import type { RealmView } from '../realm/realm-page.tsx';
import {
  CatalogueZoneFrame,
  catalogueFacts,
  catalogueWork,
  catalogueZone,
} from '../official-zone-stories/catalogue-zone.tsx';
import { applyCatalogueYear } from './catalogue-browse.tsx';
import { browseModel } from './browse-view.ts';
import { parseBrowseState } from './browse-state.ts';
import { ZoneBrowse } from './browse.tsx';
import { zoneMessagesFor } from './fixtures.ts';

const meta = {
  title: 'Zones/Publication year browse',
  args: { slug: 'anime' as 'anime' | 'manga', secondPage: false },
  loaders: [
    async ({ args }) => {
      const zone = catalogueZone(args.slug, 'en'),
        messages = zoneMessagesFor('en');
      const pkg = args.slug === 'anime' ? anime : manga;
      const search = { year: '1995', ...(args.secondPage ? { cursor: 'api-page-two' } : {}) };
      const model = browseModel({
        base: zone.links.browse,
        zoneName: zone.name.value,
        state: parseBrowseState(search),
        admitted: new Map(),
        locale: 'en',
        messages,
        page: {
          items: [
            catalogueWork(
              args.secondPage ? '212' : '211',
              'A recorded 1995 work',
              'en',
              'completed',
            ),
          ],
          facets: { type: [], concept: [], status: [], length: [] },
          matches: {
            value: args.secondPage ? 35 : 20,
            kind: args.secondPage ? 'exact' : 'lower-bound',
          },
          window: { scanned: 64, complete: args.secondPage },
          tags: 'current',
          nextCursor: args.secondPage ? null : 'api-page-two',
          sort: 'newest',
        },
      });
      const view = {
        kind: 'view',
        zone,
        context: { locale: 'en' },
        pkg,
        zoneMessages: messages,
      } as unknown as Extract<RealmView, { kind: 'view' }>;
      const year = await applyCatalogueYear({ view, search, model });
      return { zone, pkg, model, messages, header: year.header };
    },
  ],
  render: (args, { loaded }) => (
    <CatalogueZoneFrame slug={args.slug} pkg={loaded.pkg} locale="en">
      {(_zone, card) => (
        <ZoneBrowse
          model={loaded.model}
          messages={loaded.messages}
          header={loaded.header}
          card={(work) =>
            card(work, catalogueFacts(args.slug === 'anime' ? 'TV' : 'Manga', [1995], null))
          }
        />
      )}
    </CatalogueZoneFrame>
  ),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByLabelText('Publication year')).toHaveValue('1995');
    await expect(canvas.getByRole('link', { name: 'All years' })).toBeVisible();
    await expect(canvas.getByRole('status')).toHaveTextContent(
      args.secondPage ? '35 results' : '20+ results',
    );
    const next = canvas.queryByRole('link', { name: 'Next' });
    if (args.secondPage) await expect(next).toBeNull();
    else {
      await expect(next).toHaveAttribute('href', expect.stringContaining('cursor=api-page-two'));
      await expect(next).toHaveAttribute('href', expect.stringContaining('year=1995'));
    }
    await expect(canvas.queryByText(/first 200 Works/)).toBeNull();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
} satisfies Meta<{ slug: 'anime' | 'manga'; secondPage: boolean }>;
export default meta;
type Story = StoryObj<typeof meta>;

export const AnimeFirstPage: Story = {};
export const MangaSecondPagePhone: Story = {
  args: { slug: 'manga', secondPage: true },
  globals: { viewport: { value: 'phone' } },
};
