import type { Meta, StoryObj } from '@storybook/react-vite';
import type { SubjectRead } from '@rezics/client';
import { PlainLink } from '../features/pages/shared';
import { ScreenProfileReader } from '../features/catalogue/screen-profile-reader';
import type { ScreenEpisodeEntry, ScreenEpisodeRead } from '../features/catalogue/screen-episode-reader/read';
import { screenEpisodeReturn, type ScreenEpisodeOrigin } from '../features/catalogue/screen-episode-reader/navigation';
import { useScreenEpisodeVisit } from '../features/catalogue/screen-episode-reader/visit/owner';

const seriesId = '00000000-0000-4000-8000-000000000901';
const seasonId = '00000000-0000-4000-8000-000000000902';
const episodeId = '00000000-0000-4000-8000-000000000903';
const otherEpisodeId = '00000000-0000-4000-8000-000000000904';
const seriesMembership = '00000000-0000-4000-8000-000000000911';
const episodeMembership = '00000000-0000-4000-8000-000000000912';
const retiredMembership = '00000000-0000-4000-8000-000000000913';
const contextId = '00000000-0000-4000-8000-000000000906';
const observation = { state: 'signed-out' };

function membership(id: string, parentId: string, position?: string): NonNullable<ScreenEpisodeEntry['statement']> {
  return {
    id,
    rank: 'normal',
    property: { id: 'schema:isPartOf', data_type: 'wikibase-item' },
    value: { type: 'value', content: parentId },
    qualifiers: position
      ? [{ property: { id: 'schema:position', data_type: 'string' }, value: { type: 'value', content: position } }]
      : [],
    references: [],
    rezics: { release: 'story-release', revision: 1 },
  } as NonNullable<ScreenEpisodeEntry['statement']>;
}

function entry({
  membershipId,
  id,
  parentId,
  type,
  label,
  position,
}: {
  membershipId: string;
  id: string;
  parentId: string;
  type: ScreenEpisodeEntry['type'];
  label: string;
  position?: string;
}): ScreenEpisodeEntry {
  return {
    membershipId,
    holderId: id,
    parentId,
    context: contextId,
    id,
    type,
    label,
    language: 'en',
    typeLabel: { text: type === 'schema:TVSeason' ? 'TV season' : 'Episode', lang: 'en' },
    ...(position !== undefined ? { position } : {}),
    statement: membership(membershipId, parentId, position),
  };
}

function admitted(entries: ScreenEpisodeEntry[], next: string | null = null): ScreenEpisodeRead {
  return { ok: true, state: 'ready', entries, next };
}

function subject(id: string, type: string, label: string): SubjectRead {
  return {
    subject: {
      id,
      type,
      context: contextId,
      labels: { en: label },
      statements: {},
      sourceRecords: [],
    },
    related: {},
    account: null,
    summary: null,
  } as unknown as SubjectRead;
}

function ReaderStory({
  id,
  type,
  label,
  origin,
  read,
}: {
  id: string;
  type: string;
  label: string;
  origin: ScreenEpisodeOrigin;
  read?: ScreenEpisodeRead;
}) {
  const address = `${origin.pathname}${origin.searchStr}${origin.hash ?? ''}`;
  const directReturn = screenEpisodeReturn(origin.searchStr, 'en');
  const visit = useScreenEpisodeVisit({
    sourceKey: JSON.stringify([id, type, contextId, origin.pathname]),
    pageKey: address,
    origin,
    locale: 'en',
    observation,
    observationCurrent: () => true,
    ...(read ? { read } : {}),
    loading: false,
    settledKey: 'story',
    ...(directReturn ? { directReturn } : {}),
  });
  return (
    <ScreenProfileReader
      locale="en"
      public={subject(id, type, label)}
      {...(read ? { episodeRead: read } : {})}
      episodeOrigin={origin}
      episodeVisit={visit}
      episodeVisitKey={address}
      link={PlainLink}
    />
  );
}

const season = entry({
  membershipId: seriesMembership,
  id: seasonId,
  parentId: seriesId,
  type: 'schema:TVSeason',
  label: 'Season One',
  position: '1',
});
const episode = entry({
  membershipId: episodeMembership,
  id: episodeId,
  parentId: seasonId,
  type: 'schema:Episode',
  label: 'The Observatory Special',
  position: 'SP 1',
});
const seriesOrigin: ScreenEpisodeOrigin = {
  pathname: `/en/subjects/${seriesId}/the-observatory`,
  searchStr: `?realm=${contextId}&screenCursor=series-window`,
  hash: '#screen-episode-list',
};
const seasonReturn = new URLSearchParams(seriesOrigin.searchStr);
seasonReturn.set('screenSelection', seriesMembership);
const seasonReturnHref = `${seriesOrigin.pathname}?${seasonReturn}#screen-episode-entry-${seriesMembership}`;
const seasonOrigin: ScreenEpisodeOrigin = {
  pathname: `/en/subjects/${seasonId}/season-one`,
  searchStr: `?realm=${contextId}&via=${encodeURIComponent(seasonReturnHref)}`,
  hash: '#screen-episode-list',
};
const episodeReturn = new URLSearchParams(seasonOrigin.searchStr);
episodeReturn.delete('via');
episodeReturn.set('screenCursor', 'season-window');
episodeReturn.set('screenSelection', episodeMembership);
const episodeReturnHref = `/en/subjects/${seasonId}/season-one?${episodeReturn}#screen-episode-entry-${episodeMembership}`;
const episodeOrigin: ScreenEpisodeOrigin = {
  pathname: `/en/subjects/${episodeId}/the-observatory-special`,
  searchStr: `?realm=${contextId}&via=${encodeURIComponent(episodeReturnHref)}`,
};

const meta = {
  title: 'Pages/Screen episode return',
  component: ReaderStory,
  args: { id: seriesId, type: 'schema:TVSeries', label: 'The Observatory', origin: seriesOrigin },
} satisfies Meta<typeof ReaderStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SeriesSeasonEpisodeReturn: Story = {
  render: () => (
    <div className="grid min-w-0 gap-6 xl:grid-cols-3">
      <ReaderStory
        id={seriesId}
        type="schema:TVSeries"
        label="The Observatory"
        origin={seriesOrigin}
        read={admitted([season])}
      />
      <ReaderStory
        id={seasonId}
        type="schema:TVSeason"
        label="Season One"
        origin={seasonOrigin}
        read={admitted([episode])}
      />
      <ReaderStory id={episodeId} type="schema:Episode" label="The Observatory Special" origin={episodeOrigin} />
    </div>
  ),
};

export const SparseLaterWindow: Story = {
  args: {
    id: seriesId,
    type: 'schema:TVSeries',
    label: 'The Observatory',
    origin: { ...seriesOrigin, searchStr: `${seriesOrigin.searchStr}&screenCursor=native-window-two` },
    read: admitted([
      entry({
        membershipId: otherEpisodeId,
        id: otherEpisodeId,
        parentId: seriesId,
        type: 'schema:Episode',
        label: 'A Later Special',
        position: 'Special 4',
      }),
    ]),
  },
};

export const StaleWindowRestart: Story = {
  args: {
    id: seriesId,
    type: 'schema:TVSeries',
    label: 'The Observatory',
    origin: { ...seriesOrigin, searchStr: `${seriesOrigin.searchStr}&screenCursor=withdrawn-window` },
    read: { ok: false, reason: 'stale' },
  },
};

export const RetiredSelectionWithoutFocusReceipt: Story = {
  args: {
    id: seriesId,
    type: 'schema:TVSeries',
    label: 'The Observatory',
    origin: {
      ...seriesOrigin,
      searchStr: `${seriesOrigin.searchStr}&screenSelection=${retiredMembership}`,
      hash: `#screen-episode-entry-${retiredMembership}`,
    },
    read: admitted([season]),
  },
};
