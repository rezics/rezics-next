import type { Meta, StoryObj } from '@storybook/react-vite';
import { ScreenEpisodeList } from '../features/catalogue/screen-episode-reader/view';
import type { ScreenEpisodeEntry, ScreenEpisodeRead } from '../features/catalogue/screen-episode-reader/read';

const parentId = '00000000-0000-4000-8000-000000000901';
const contextId = '00000000-0000-4000-8000-000000000906';
const origin = {
  pathname: '/en/subjects/00000000-0000-4000-8000-000000000901/the-observatory',
  searchStr: '?screenCursor=page-two&realm=00000000-0000-4000-8000-000000000904',
};

function assertion(id: string, parent: string, position?: string, spoiler = false) {
  return {
    id,
    rank: 'normal',
    property: { id: 'schema:isPartOf', data_type: 'wikibase-item' },
    value: { type: 'value', content: parent },
    qualifiers: [
      ...(position
        ? [{ property: { id: 'schema:position', data_type: 'string' }, value: { type: 'value', content: position } }]
        : []),
      ...(spoiler
        ? [
            {
              property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
              value: { type: 'value', content: { amount: '+2', unit: '1' } },
            },
          ]
        : []),
    ],
    references: [
      {
        parts: [
          {
            property: { id: 'schema:url', data_type: 'url' },
            value: { type: 'value', content: 'https://example.invalid/source' },
          },
        ],
        hash: 'reference-hash',
      },
    ],
    rezics: { release: 'screen-release', revision: 1 },
  } as NonNullable<ScreenEpisodeEntry['statement']>;
}

const orderedEntries: ScreenEpisodeEntry[] = [
  {
    membershipId: '00000000-0000-4000-8000-000000000911',
    holderId: '00000000-0000-4000-8000-000000000902',
    parentId,
    context: contextId,
    id: '00000000-0000-4000-8000-000000000902',
    type: 'schema:TVSeason',
    label: 'Season One',
    language: 'en',
    typeLabel: { text: 'TV season', lang: 'en' },
    position: '1',
    statement: assertion('00000000-0000-4000-8000-000000000911', parentId, '1'),
  },
  {
    membershipId: '00000000-0000-4000-8000-000000000912',
    holderId: '00000000-0000-4000-8000-000000000903',
    parentId,
    context: contextId,
    id: '00000000-0000-4000-8000-000000000903',
    type: 'schema:Episode',
    label: 'The Observatory Special',
    language: 'en',
    typeLabel: { text: 'Episode', lang: 'en' },
    position: 'SP 1',
    statement: assertion('00000000-0000-4000-8000-000000000912', parentId, 'SP 1'),
  },
  {
    membershipId: '00000000-0000-4000-8000-000000000913',
    holderId: '00000000-0000-4000-8000-000000000905',
    parentId,
    context: contextId,
    id: '00000000-0000-4000-8000-000000000905',
    type: 'schema:Episode',
    label: 'The Unnumbered Episode',
    language: 'en',
    typeLabel: { text: 'Episode', lang: 'en' },
    statement: assertion('00000000-0000-4000-8000-000000000913', parentId),
  },
];

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
  entries: orderedEntries,
};

export const SeriesWithSpecialAndPartialOrder: Story = { args: { read: orderedSeriesPage } };

export const SpoilerChoice: Story = {
  args: {
    read: {
      ok: true,
      state: 'ready',
      next: null,
      entries: [
        { ...orderedEntries[1]!, statement: assertion(orderedEntries[1]!.membershipId, parentId, 'SP 1', true) },
      ],
    },
  },
};

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

export const UnsupportedMembershipStream: Story = {
  args: { read: { ok: false, reason: 'unsupported' } },
};
