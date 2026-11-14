import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { collectionReviewPath, resetCollectionReview } from '../kernel/fake/a-collection-review';
import { reviewGenres } from '../kernel/fixtures/collection-showcase';
import { getLocale } from '../paraglide/runtime.js';
import { PageStory } from './page';

type Kind = Parameters<typeof collectionReviewPath>[0];
function CollectionVisit({
  kind = 'media',
  member = false,
  query = '',
}: {
  kind?: Kind;
  member?: boolean;
  query?: string;
}) {
  const locale = getLocale();
  useMemo(() => resetCollectionReview(), [kind, member, query, locale]);
  return (
    <PageStory previewNewTabs visitor={member ? 'Signed In' : 'Signed Out'} path={collectionReviewPath(kind, query)} />
  );
}

const meta = {
  title: 'Library/Collection review',
  id: 'pages-collections-showcase',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'One synthetic catalogue, served through the installed Collection and Subject application routes. Original local covers, supplied author/year/type facts, independent duplicate occurrences and sparse records retain their native identities. These are contract-shaped illustrative fixtures, separate from recordings and native acceptance. Open Filters, apply or clear a predicate, switch List/Grid, continue, open any item and return to its exact occurrence. Owner, member and anonymous visits use their matching viewer. Main entries do not navigate automatically. Use the shared locale, theme and viewport globals. Publication belongs to the existing Web publisher; decoded-cover, keyboard, phone and desktop acceptance stays with the dev verifier.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Books: Story = {
  name: 'Book collection',
  render: () => <CollectionVisit key={getLocale()} kind="books" />,
};
export const MixedMedia: Story = {
  name: 'Mixed books, games and animation',
  render: () => <CollectionVisit key={getLocale()} />,
};
export const Member: Story = {
  render: () => <CollectionVisit key={getLocale()} member />,
};
export const Owner: Story = {
  render: () => <CollectionVisit key={getLocale()} kind="owner" member />,
};
export const Grid: Story = {
  render: () => <CollectionVisit key={getLocale()} query="layout=grid" />,
};
export const Empty: Story = {
  render: () => <CollectionVisit key={getLocale()} kind="empty" />,
};
export const SparseContinuation: Story = {
  render: () => <CollectionVisit key={getLocale()} kind="sparse" />,
};
export const UnavailableRetry: Story = {
  render: () => <CollectionVisit key={getLocale()} kind="unavailable" />,
};
export const FilteredBooks: Story = {
  render: () => (
    <CollectionVisit
      key={getLocale()}
      kind="books"
      query={new URLSearchParams({
        type: 'schema:Book',
        'f.schema:genre': reviewGenres[0].id,
        'l.schema:genre': reviewGenres[0].label,
      }).toString()}
    />
  ),
};
