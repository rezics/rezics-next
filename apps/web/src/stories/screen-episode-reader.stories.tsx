import type { Meta, StoryObj } from '@storybook/react-vite';
import { ScreenEpisodeList } from '../features/catalogue/screen-episode-reader/view';
import type { ScreenEpisodeRead } from '../features/catalogue/screen-episode-reader/read';

const origin = {
  pathname: '/en/subjects/00000000-0000-4000-8000-000000000901/the-observatory',
  searchStr: '?screenCursor=page-two&realm=00000000-0000-4000-8000-000000000904',
};

const meta = {
  title: 'Pages/Screen episode reader',
  component: ScreenEpisodeList,
  args: { locale: 'en', origin },
} satisfies Meta<typeof ScreenEpisodeList>;

export default meta;
type Story = StoryObj<typeof meta>;

const orderedSeriesPage: ScreenEpisodeRead = {
  ok: true,
  state: 'ready',
  next: null,
  entries: [
    {
      membershipId: 'work-part-season-one',
      id: '00000000-0000-4000-8000-000000000902',
      type: 'schema:TVSeason',
      label: 'Season One',
      language: 'en',
      typeLabel: { text: 'TV season', lang: 'en' },
      position: '1',
    },
    {
      membershipId: 'work-part-special',
      id: '00000000-0000-4000-8000-000000000903',
      type: 'schema:Episode',
      label: 'The Observatory Special',
      language: 'en',
      typeLabel: { text: 'Episode', lang: 'en' },
      position: 'SP 1',
    },
    {
      membershipId: 'work-part-unordered-episode',
      id: '00000000-0000-4000-8000-000000000905',
      type: 'schema:Episode',
      label: 'The Unnumbered Episode',
      language: 'en',
      typeLabel: { text: 'Episode', lang: 'en' },
    },
  ],
};

export const SeriesWithSpecialAndPartialOrder: Story = { args: { read: orderedSeriesPage } };

export const WithheldAndContinued: Story = {
  args: {
    read: {
      ...orderedSeriesPage,
      state: 'withheld',
      next: 'opaque-next-page',
      entries: orderedSeriesPage.entries.slice(1, 2),
    },
  },
};
