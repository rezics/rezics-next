import { useMemo } from 'react';
import {
  Link,
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { FeedResults, type FeedResultsAvailability, type FeedResultsMessages } from '../features/feed/feed-results';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import type { MyRealmsPage } from '../community/space';

type MyRealmSummary = MyRealmsPage['realms'][number];

const realmPage: MyRealmsPage = {
  signedIn: true,
  realms: [
    {
      realmId: '01a1a000-0000-7000-8000-000000000731',
      name: 'Home Reading Room',
      description: 'A small place for reading together.',
    },
    {
      realmId: '01a1a000-0000-7000-8000-000000000732',
      name: 'Evening Discussions',
      description: 'Current conversations and shared notes.',
    },
  ],
  next: 'opaque-realms-cursor/%2B?x=1',
};

const messages: FeedResultsMessages = {
  loading: 'Loading realms',
  partial: 'Some realms are unavailable',
  empty: m.realms_empty(),
  sparse: 'No realms on this page; more may follow',
  retry: m.library_follow_retry(),
  restart: m.home_feed_restart(),
  failure: {
    request: m.home_feed_request(),
    auth: m.home_feed_auth(),
    denied: m.home_feed_denied(),
    closed: m.home_feed_closed(),
    cursor: m.home_feed_cursor(),
    deadline: m.home_feed_deadline(),
    unavailable: m.home_feed_unavailable(),
  },
};

function realmPresentation(realm: MyRealmSummary, locale: string) {
  return {
    title: realm.name,
    href: `/${locale}/realms/${encodeURIComponent(realm.realmId)}`,
    preview: realm.description ? (
      <p className="text-sm leading-relaxed text-muted-foreground">{realm.description}</p>
    ) : undefined,
  };
}

function RealmResults({
  availability = { state: 'complete' },
  items = realmPage.realms,
}: {
  availability?: FeedResultsAvailability | undefined;
  items?: readonly MyRealmSummary[] | undefined;
}) {
  const locale = getLocale();
  const next = realmPage.next;
  return (
    <article className="max-w-3xl space-y-8 text-foreground">
      <header>
        <PageHeading>{m.realms_heading()}</PageHeading>
      </header>
      <FeedResults
        regionLabel={m.realms_heading()}
        itemHeadingLevel={2}
        listAs="ul"
        listClassName="space-y-1"
        result={{ state: 'ready', items, hasNext: next !== null, availability }}
        messages={messages}
        getItemKey={(realm) => realm.realmId}
        itemPresentation={(realm) => realmPresentation(realm, locale)}
        onRetry={() => {}}
        nextControl={
          next ? (
            <nav aria-label={m.realms_heading()}>
              <Link
                to="/realms"
                search={{ cursor: next }}
                className="inline-flex min-h-10 items-center rounded-lg border border-border px-4 text-primary underline-offset-4 hover:bg-muted hover:underline"
              >
                {m.realms_more()}
              </Link>
            </nav>
          ) : undefined
        }
      />
    </article>
  );
}

function RealmRouter({
  availability,
  items,
}: {
  availability?: FeedResultsAvailability | undefined;
  items?: readonly MyRealmSummary[] | undefined;
}) {
  const router = useMemo(() => {
    const root = createRootRoute({ component: Outlet });
    const realms = createRoute({
      getParentRoute: () => root,
      path: '/realms',
      component: () => <RealmResults availability={availability} items={items} />,
    });
    return createRouter({
      routeTree: root.addChildren([realms]),
      history: createMemoryHistory({ initialEntries: ['/realms'] }),
    });
  }, [availability, items]);
  return <RouterProvider router={router} />;
}

const meta = {
  title: 'Components/Feeds/Shared Results',
  parameters: {
    docs: {
      description: {
        component:
          'A typed embedded MyRealms summary consumer. The rows use the installed MyRealmsPage summary and projection; the actual Router Link keeps its opaque next cursor. This story is not a native mixed-feed claim.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const MyRealmsSummaries: Story = {
  render: () => <RealmRouter />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('region', { name: m.realms_heading() })).toBeVisible();
    await expect(canvas.getByRole('list', { name: m.realms_heading() }).querySelectorAll('h2')).toHaveLength(2);
    await expect(canvas.getByRole('link', { name: m.realms_more() })).toHaveAttribute(
      'href',
      expect.stringContaining('cursor='),
    );
  },
};

export const PartialMyRealmsSummaries: Story = {
  render: () => <RealmRouter availability={{ state: 'partial', sources: { realms: 'unavailable' } }} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('region', { name: m.realms_heading() })).toBeVisible();
    await expect(canvas.getByText('Some realms are unavailable')).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.library_follow_retry() })).toBeEnabled();
  },
};

export const SparseRealmsContinuation: Story = {
  render: () => <RealmRouter items={[]} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('No realms on this page; more may follow')).toBeVisible();
    await expect(canvas.getByRole('link', { name: m.realms_more() })).toBeVisible();
  },
};
