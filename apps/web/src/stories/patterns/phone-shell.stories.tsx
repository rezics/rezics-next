import type { Meta, StoryObj } from '@storybook/react-vite';
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Suspense, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { AppShell } from '../../shell/shell';
import { HeaderSearch } from '../../search/header-search/header-search';
import { rememberRecent, type RecentHistory } from '../../search/recent-history';
import type { SearchRealmDiscoveryLoader } from '../../search/realm-discovery-section';
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
// Interface fakes for the single Content section. These are not native discovery recordings.
const emptyRealms = fn<SearchRealmDiscoveryLoader>(async () => ({ kind: 'ready', realms: [], next: null }));
const loadingRealms = fn<SearchRealmDiscoveryLoader>(() => new Promise(() => {}));
const unavailableRealms = fn<SearchRealmDiscoveryLoader>(async () => ({ kind: 'unavailable' }));
const closedRealms = fn<SearchRealmDiscoveryLoader>(async () => ({ kind: 'closed' }));
const nextRealmPage = 'native/opaque+cursor?one';
const sparseRealmPage = 'native/opaque+cursor?two';
const readyRealms = fn<SearchRealmDiscoveryLoader>(async ({ cursor }) => ({
  kind: 'ready',
  realms:
    cursor === undefined
      ? [
          {
            realmId: realmRecording.realm.realmId,
            spaceId: realmRecording.realm.spaceId,
            name: realmRecording.realm.title,
            description: realmRecording.realm.summary ?? '',
            avatar: null,
          },
        ]
      : [],
  next: cursor === undefined ? nextRealmPage : cursor === nextRealmPage ? sparseRealmPage : null,
}));
function Connected({ state, loadRealms = emptyRealms }: { state: State; loadRealms?: SearchRealmDiscoveryLoader }) {
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
  return (
    <AppShell
      search={
        <HeaderSearch
          locale={getLocale()}
          history={history}
          loadRealmDiscovery={loadRealms}
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
function Example({ state = 'rest', loadRealms }: { state?: State; loadRealms?: SearchRealmDiscoveryLoader }) {
  return (
    <PatternStory visitor="Signed In" path={searchFacetStoryPaths.active}>
      <Connected state={state} {...(loadRealms ? { loadRealms } : {})} />
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
    emptyRealms.mockClear();
    const { canvas } = await search(context);
    await expect(canvas.getByText(m.header_search_recent_empty())).toBeVisible();
    await realmState(context, 'ready');
    await expect(emptyRealms).toHaveBeenCalledTimes(1);
    await expect(emptyRealms).toHaveBeenLastCalledWith({ locale: getLocale(), sort: 'trending', limit: 20 });
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
  render: () => <Example state="trending" loadRealms={readyRealms} />,
  play: async (context) => {
    readyRealms.mockClear();
    const { canvas } = await search(context);
    await expect(canvas.getByRole('heading', { name: m.header_search_trending_searches() })).toBeVisible();
    const region = await realmState(context, 'ready');
    await expect(readyRealms).toHaveBeenCalledTimes(1);
    await expect(readyRealms).toHaveBeenLastCalledWith({ locale: getLocale(), sort: 'trending', limit: 20 });
    // Until Content's module is delivered, the composed boundary must report unavailable, even for this fake.
    if (region.querySelector('[data-realm-discovery-producer="unavailable"]')) {
      await expect(within(region).getByText(m.realm_shelf_unavailable())).toBeVisible();
      await expect(within(region).queryByRole('link')).toBeNull();
      return;
    }
    await expect(within(region).getByRole('link', { name: new RegExp(realmRecording.realm.title) })).toHaveAttribute(
      'href',
      `/${getLocale()}/realms/${realmRecording.realm.realmId}`,
    );
    await userEvent.click(within(region).getByRole('button'));
    await waitFor(() => expect(readyRealms).toHaveBeenCalledTimes(2));
    await expect(readyRealms).toHaveBeenLastCalledWith({
      locale: getLocale(),
      sort: 'trending',
      cursor: nextRealmPage,
      limit: 20,
    });
    await realmState(context, 'ready');
    await expect(within(region).queryByRole('link')).toBeNull();
    await userEvent.click(within(region).getByRole('button'));
    await waitFor(() => expect(readyRealms).toHaveBeenCalledTimes(3));
    await expect(readyRealms).toHaveBeenLastCalledWith({
      locale: getLocale(),
      sort: 'trending',
      cursor: sparseRealmPage,
      limit: 20,
    });
    await realmState(context, 'ready');
    await expect(within(region).queryByRole('button')).toBeNull();
  },
};
async function realmState(context: { canvasElement: HTMLElement }, state: string) {
  const region = context.canvasElement.querySelector<HTMLElement>('[data-search-realm-discovery]')!;
  await waitFor(() => expect(region).toHaveAttribute('data-state', state));
  return region;
}
export const SearchLoading: Story = {
  render: () => <Example loadRealms={loadingRealms} />,
  play: async (context) => {
    loadingRealms.mockClear();
    const { input } = await search(context);
    await realmState(context, 'loading');
    await expect(loadingRealms).toHaveBeenCalledTimes(1);
    await expect(input).toHaveFocus();
  },
};
export const SearchUnavailable: Story = {
  render: () => <Example loadRealms={unavailableRealms} />,
  play: async (context) => {
    unavailableRealms.mockClear();
    await search(context);
    const region = await realmState(context, 'unavailable');
    await expect(unavailableRealms).toHaveBeenCalledTimes(1);
    await userEvent.click(within(region).getByRole('button'));
    await realmState(context, 'unavailable');
    await expect(unavailableRealms).toHaveBeenCalledTimes(2);
  },
};
export const SearchClosed: Story = {
  render: () => <Example loadRealms={closedRealms} />,
  play: async (context) => {
    closedRealms.mockClear();
    await search(context);
    const region = await realmState(context, 'closed');
    await expect(within(region).getByText(m.platform_closed_message())).toBeVisible();
    await expect(within(region).queryByRole('button')).toBeNull();
    await expect(closedRealms).toHaveBeenCalledTimes(1);
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
