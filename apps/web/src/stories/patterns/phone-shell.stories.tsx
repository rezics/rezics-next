import type { Meta, StoryObj } from '@storybook/react-vite';
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Suspense, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { AppShell } from '../../shell/shell';
import { HeaderSearch } from '../../search/header-search/header-search';
import { rememberRecent, type RecentHistory } from '../../search/recent-history';
import type { SearchDiscovery } from '../../search/recent-panel';
import { SearchPage } from '../../search/search';
import { searchQueryOptions } from '../../search/search-queries';
import { searchLoaderDeps } from '../../search/search-params';
import { searchFacetStoryPaths } from '../../kernel/fake/search-facets';
import type { UnreadCount } from '../../inbox/inbox-read';
import { unreadCountQuery } from '../../inbox/inbox-query';
import { sessionQuery } from '../../session/query';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { PageHeading } from '../../shell/page-heading';
import { PatternStory, pageReady } from '../page';
import recording from '../../kernel/recorded/search.json';
import realmRecording from '../../kernel/recorded/realm.json';

const params = searchLoaderDeps({
  q: 'Prince',
  type: 'schema:Book',
  'f.schema:genre': '01a17dfd-5da5-76da-bc50-a1fb5dbc87d2',
});
function Filters() {
  const { data } = useSuspenseQuery(searchQueryOptions(getLocale(), params));
  return <SearchPage query={params.query} data={data} filtersOnly />;
}
type State =
  | 'rest'
  | 'unread'
  | 'unavailable'
  | 'empty'
  | 'recent'
  | 'trending'
  | 'typing'
  | 'filters'
  | 'creation'
  | 'settings';
function Connected({ state }: { state: State }) {
  const client = useQueryClient();
  const [entries, setEntries] = useState(() => {
    client.setQueryData(sessionQuery.queryKey, {
      state: 'signed-in',
      csrfToken: null,
      subject: 'phone-pattern-account',
    });
    const unread: UnreadCount =
      state === 'unavailable'
        ? { signedIn: true, state: 'unavailable', failure: { status: 503 } }
        : { signedIn: true, state: 'ready', count: state === 'unread' ? 3 : 0, capped: false };
    client.setQueryData<UnreadCount>(unreadCountQuery.queryKey, () => unread);
    return state === 'recent'
      ? rememberRecent(rememberRecent([], recording.query), '', {
          kind: 'Realm',
          id: realmRecording.realm.realmId,
          name: realmRecording.realm.title,
        })
      : [];
  });
  const history: RecentHistory = {
    entries,
    persistence: 'memory',
    sync: 'local-only',
    remember: (query, scope) => setEntries((previous) => rememberRecent(previous, query, scope)),
    remove: (id) => setEntries((previous) => previous.filter((entry) => entry.id !== id)),
  };
  // Contract-shaped future owner response, used ONLY by SearchTrending. No production source is claimed.
  const discovery: SearchDiscovery | undefined =
    state === 'trending'
      ? {
          trendingQueries: [recording.query],
          trendingRealms: [
            {
              id: realmRecording.realm.realmId,
              name: realmRecording.realm.title,
              description: realmRecording.realm.summary ?? '',
              href: `/${getLocale()}/realms/${realmRecording.realm.realmId}`,
            },
          ],
        }
      : undefined;
  return (
    <AppShell
      search={
        <HeaderSearch
          locale={getLocale()}
          history={history}
          discovery={discovery}
          loadSuggestions={async () => ({ as_of: recording.as_of, subjects: recording.subjects, types: {} })}
        />
      }
    >
      <PageHeading>{m.home_heading()}</PageHeading>
      {state === 'filters' ? (
        <Suspense fallback={null}>
          <Filters />
        </Suspense>
      ) : null}
    </AppShell>
  );
}
function Example({ state = 'rest' }: { state?: State }) {
  return (
    <PatternStory visitor="Signed In" path={searchFacetStoryPaths.active}>
      <Connected state={state} />
    </PatternStory>
  );
}
const meta = {
  title: 'Patterns/Phone Shell',
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
  globals: { viewport: { value: 'phone390' } },
  render: () => <Example />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const phone = () => window.matchMedia('(max-width: 767px)').matches;
async function search(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const canvas = within(context.canvasElement);
  await userEvent.click(
    phone()
      ? canvas.getByRole('button', { name: m.search_label() })
      : canvas.getByRole('combobox', { name: m.search_label() }),
  );
  const input = canvas.getByRole('combobox', { name: m.search_label() });
  await expect(input).toHaveFocus();
  await expect(context.canvasElement.querySelectorAll('input[role="combobox"]')).toHaveLength(1);
  return { canvas, input };
}
export const Rest: Story = {
  play: async (context) => {
    const { canvas } = await search(context);
    await userEvent.keyboard('{Escape}');
    await expect(
      phone() ? canvas.getByRole('button', { name: m.search_label() }) : canvas.getByRole('combobox'),
    ).toHaveFocus();
  },
};
export const Unread: Story = {
  render: () => <Example state="unread" />,
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    if (phone()) await expect(canvas.getByLabelText(m.shell_new_activity())).toBeVisible();
    const navigation = canvas.getByRole('navigation', { name: phone() ? m.shell_phone_tabs() : m.shell_navigation() });
    await expect(within(navigation).getByLabelText(m.inbox_unread_count({ count: '3' }))).toHaveTextContent('3');
  },
};
export const UnreadUnavailable: Story = {
  render: () => <Example state="unavailable" />,
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await expect(canvas.queryByLabelText(m.shell_new_activity())).toBeNull();
    const navigation = canvas.getByRole('navigation', { name: phone() ? m.shell_phone_tabs() : m.shell_navigation() });
    await expect(within(navigation).getByRole('img', { name: m.inbox_unread_unavailable() })).toBeEmptyDOMElement();
  },
};
export const DesktopPersonalNavigation: Story = {
  globals: { viewport: { value: 'desktop1280' } },
  play: async (context) => {
    await pageReady(context);
    const navigation = within(within(context.canvasElement).getByRole('navigation', { name: m.shell_navigation() }));
    await expect(await navigation.findByRole('link', { name: m.nav_library() })).toHaveAttribute(
      'href',
      `/${getLocale()}/library`,
    );
    await expect(navigation.getByRole('link', { name: m.nav_inbox() })).toHaveAttribute(
      'href',
      `/${getLocale()}/inbox`,
    );
  },
};
export const DesktopPersonalUnavailable: Story = {
  globals: { viewport: { value: 'desktop1280' } },
  parameters: { admitted: [] },
  play: async (context) => {
    await pageReady(context);
    const navigation = within(within(context.canvasElement).getByRole('navigation', { name: m.shell_navigation() }));
    const library = await navigation.findByRole('link', {
      name: `${m.nav_library()}: ${m.library_subject_unavailable()}`,
    });
    await expect(library).toHaveAttribute('aria-disabled', 'true');
    await expect(library).not.toHaveAttribute('href');
    await expect(navigation.getByRole('link', { name: m.nav_inbox() })).toHaveAttribute(
      'href',
      `/${getLocale()}/inbox`,
    );
  },
};
export const SearchEmpty: Story = {
  render: () => <Example state="empty" />,
  play: async (context) => {
    const { canvas } = await search(context);
    await expect(canvas.getByText(m.header_search_recent_empty())).toBeVisible();
  },
};
export const SearchRecent: Story = {
  render: () => <Example state="recent" />,
  play: async (context) => {
    const { canvas } = await search(context);
    await expect(canvas.getByRole('button', { name: recording.query })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.header_search_history() }));
    await expect(canvas.getByRole('heading', { name: m.header_search_history() })).toBeVisible();
  },
};
export const SearchTrending: Story = {
  render: () => <Example state="trending" />,
  play: async (context) => {
    const { canvas } = await search(context);
    await expect(canvas.getByRole('heading', { name: m.header_search_trending_searches() })).toBeVisible();
  },
};
export const SearchTyping: Story = {
  render: () => <Example state="typing" />,
  play: async (context) => {
    const { input, canvas } = await search(context);
    await userEvent.type(input, recording.query);
    await waitFor(() => expect(canvas.getAllByRole('option')).toHaveLength(recording.subjects.length));
  },
};
export const SearchFiltersOpen: Story = {
  render: () => <Example state="filters" />,
  play: async (context) => {
    const { canvas } = await search(context);
    const region = context.canvasElement.querySelector('[data-search-composer]')!;
    const button = within(region as HTMLElement).getByRole('button', { name: new RegExp(m.search_filters()) });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    await waitFor(() =>
      expect(
        within(document.body)
          .getAllByRole('checkbox')
          .some((item) => (item as HTMLInputElement).checked),
      ).toBe(true),
    );
  },
};
export const CreationSheet: Story = {
  render: () => <Example state="creation" />,
  play: async (context) => {
    await pageReady(context);
    if (phone()) {
      await userEvent.click(within(context.canvasElement).getByRole('button', { name: m.shell_create() }));
      await expect(await within(document.body).findByRole('link', { name: m.library_collection_new() })).toBeVisible();
    }
  },
};
export const YouSettings: Story = {
  render: () => <Example state="settings" />,
  play: async (context) => {
    await pageReady(context);
    if (phone()) {
      await userEvent.click(within(context.canvasElement).getByRole('button', { name: m.shell_you() }));
      await expect(await within(document.body).findByRole('region', { name: m.shell_appearance() })).toBeVisible();
      await expect(within(document.body).getByRole('button', { name: m.shell_theme() })).toBeVisible();
    } else await expect(within(context.canvasElement).getByRole('button', { name: m.shell_theme() })).toBeVisible();
  },
};
