import { useLayoutEffect, useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { getLocale } from '../paraglide/runtime.js';
import { PageStory } from './page';
import { bookReviewCursor, selectBookListReview, type BookListScenario } from '../kernel/fake/a-collection-review';

/** The actual entry, Search, Subject and Library routes share one router for the whole visit. */
function BookListVisit({
  path = '/books',
  member = false,
  scenario = 'ready',
}: {
  path?: string;
  member?: boolean;
  scenario?: BookListScenario;
}) {
  const locale = getLocale();
  useMemo(() => selectBookListReview(scenario), [scenario, locale, member, path]);
  useLayoutEffect(() => {
    selectBookListReview(scenario, false);
    return () => {
      selectBookListReview(undefined, false);
    };
  }, [scenario, locale, member, path]);
  return <PageStory previewNewTabs visitor={member ? 'Signed In' : 'Signed Out'} path={path} />;
}

const meta = {
  title: 'Library/Book catalogue visit',
  id: 'pages-books-catalogue',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Synthetic, contract-shaped Book, Series and Edition records with original local artwork. These are not API recordings or native acceptance. Every entry mounts the application route tree through PageStory: use Search filters and sorting, continue the native page, open its exact Subject, and use the reader return or browser Back. The entry’s normal separate-tab destinations are previewed in the same story router. Main entries stay at rest. Shared Locale, Theme and phone390/desktop1280 globals remain freely changeable. Tests, typecheck, browser and cover review are deferred to the dev verifier in the maintainer source-only window.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** Existing IDs remain the public entry and member shelf handoff, without an automatic navigation walk. */
export const AnonymousBrowse: Story = {
  render: () => <BookListVisit key={getLocale()} />,
};
export const MemberShelfHandoff: Story = {
  render: () => <BookListVisit key={getLocale()} member />,
};
export const CompleteBookList: Story = {
  name: 'Book list, public catalogue',
  render: () => <BookListVisit key={getLocale()} path="/search?type=schema%3ABook" />,
};
export const Empty: Story = {
  render: () => <BookListVisit key={getLocale()} path="/search?q=unwritten&type=schema%3ABook" scenario="empty" />,
};
export const Sparse: Story = {
  render: () => <BookListVisit key={getLocale()} path="/search?type=schema%3ABook" scenario="sparse" />,
};
export const UnavailableRecovery: Story = {
  render: () => (
    <BookListVisit
      key={getLocale()}
      path={`/search?type=schema%3ABook&cursor=${encodeURIComponent(bookReviewCursor)}`}
      scenario="unavailable"
    />
  ),
};
