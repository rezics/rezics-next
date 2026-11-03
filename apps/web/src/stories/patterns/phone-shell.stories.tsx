import type { Meta, StoryObj } from '@storybook/react-vite';
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Suspense, useMemo, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { AppShell } from '../../shell/shell';
import { useRegisterPhoneCreationActions, type PhoneCreationAction } from '../../shell/phone-navigation';
import { useOperation } from '../../kernel/exposure';
import { HeaderSearch } from '../../search/header-search/header-search';
import { rememberRecent, type RecentHistory } from '../../search/recent-history';
import type { SearchRealmDiscoveryLoader } from '../../search/realm-discovery-section';
import { SearchPage } from '../../search/search';
import { searchQueryOptions } from '../../search/search-queries';
import { searchLoaderDeps } from '../../search/search-params';
import { searchFacetStoryPaths } from '../../kernel/fake/search-facets';
import type { UnreadCount } from '../../inbox/inbox-read';
import { unreadCountQueryFor } from '../../inbox/inbox-query';
import { currentInboxViewer } from '../../inbox/inbox-viewer';
import { sessionQuery, useSession } from '../../session/query';
import type { SessionState } from '../../session/state';
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
  | 'creation-owners'
  | 'creation-session'
  | 'settings';

function CreationOwner({ actions }: { actions: readonly PhoneCreationAction[] }) {
  useRegisterPhoneCreationActions(actions);
  return null;
}
function CreationOwners({ transitions }: { transitions: boolean }) {
  const client = useQueryClient();
  const { state } = useSession();
  const collection = useOperation('collection.create');
  const offered = state === 'signed-in' && collection;
  const locale = getLocale();
  const [first, setFirst] = useState(true);
  const [second, setSecond] = useState(true);
  const [updated, setUpdated] = useState(false);
  // Interface-only owners reuse the offered Collection route; fragments distinguish their local destinations.
  const firstActions = useMemo(
    () =>
      offered
        ? [
            {
              id: 'first',
              label: updated ? 'Updated first creation' : 'First creation',
              href: `/${locale}/collections/new#first${updated ? '-updated' : ''}`,
            },
            { id: 'shared', label: 'First shared creation', href: `/${locale}/collections/new#shared` },
          ]
        : [],
    [offered, locale, updated],
  );
  const secondActions = useMemo(
    () =>
      offered
        ? [
            { id: 'second', label: 'Unsafe creation', href: '//example.invalid/new' },
            { id: 'second', label: 'Second creation', href: `/${locale}/collections/new#second` },
            { id: 'shared', label: 'Second shared creation', href: `/${locale}/collections/new#shared` },
            { id: 'collection', label: 'Duplicate Collection', href: `/${locale}/collections/new` },
          ]
        : [],
    [offered, locale],
  );
  function session(state: SessionState) {
    client.setQueryData(sessionQuery.queryKey, {
      state,
      csrfToken: null,
      subject: state === 'signed-in' ? 'phone-pattern-account' : null,
    });
  }
  return (
    <div className="flex flex-wrap gap-3 py-4 [&>button]:rounded-xl [&>button]:border [&>button]:p-3">
      {first ? <CreationOwner actions={firstActions} /> : null}
      {second ? <CreationOwner actions={secondActions} /> : null}
      <button type="button" onClick={() => setUpdated(true)}>
        Update first owner
      </button>
      <button type="button" onClick={() => setFirst((value) => !value)}>
        {first ? 'Unmount first owner' : 'Mount first owner'}
      </button>
      <button type="button" onClick={() => setSecond((value) => !value)}>
        {second ? 'Unmount second owner' : 'Mount second owner'}
      </button>
      {transitions ? (
        <>
          <button type="button" onClick={() => session('signed-out')}>
            Sign out
          </button>
          <button type="button" onClick={() => session('unavailable')}>
            Session unavailable
          </button>
          <button type="button" onClick={() => session('signed-in')}>
            Sign in
          </button>
        </>
      ) : null}
    </div>
  );
}
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
    client.setQueryData<UnreadCount>(unreadCountQueryFor(currentInboxViewer(client)).queryKey, () => unread);
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
          loadSuggestions={async () => ({
            as_of: recording.as_of,
            subjects: recording.subjects.map(({ id, type, labels, summary }) => ({
              id,
              type,
              labels,
              summary: summary ?? null,
            })),
            types: {},
          })}
        />
      }
    >
      <PageHeading>{m.nav_home()}</PageHeading>
      {state === 'creation-owners' || state === 'creation-session' ? (
        <CreationOwners transitions={state === 'creation-session'} />
      ) : null}
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
  const trigger =
    canvas.queryByRole('button', { name: m.header_search_global() }) ??
    canvas.getByRole('combobox', { name: m.search_label() });
  await userEvent.click(trigger);
  const input = await canvas.findByRole('combobox', { name: m.search_label() });
  await waitFor(() => expect(input).toHaveAttribute('aria-expanded', 'true'));
  await waitFor(() => expect(input).toHaveFocus());
  await expect(context.canvasElement.querySelectorAll('input[role="combobox"]')).toHaveLength(1);
  return { canvas, input, trigger };
}
export const Rest: Story = {
  play: async (context) => {
    const { trigger } = await search(context);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(trigger).toHaveFocus());
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
    const { canvas, input } = await search(context);
    await expect(canvas.getByRole('heading', { name: m.header_search_recent() })).toBeVisible();
    await expect(canvas.getByRole('button', { name: recording.query })).toBeVisible();
    await expect(canvas.getByRole('button', { name: realmRecording.realm.title })).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.header_search_history() })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(input).toHaveFocus();
  },
};
export const SearchHistory: Story = {
  render: () => <Example state="recent" />,
  play: async (context) => {
    await SearchRecent.play!(context);
    const canvas = within(context.canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.header_search_history() }));
    await expect(canvas.getByRole('heading', { name: m.header_search_history() })).toBeVisible();
    await expect(canvas.getByRole('button', { name: recording.query })).toBeVisible();
    await expect(canvas.getByRole('button', { name: realmRecording.realm.title })).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.header_search_recent() })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  },
};
export const SearchHistoryTransition: Story = {
  tags: ['!dev'],
  render: () => <Example state="recent" />,
  play: async (context) => {
    await SearchHistory.play!(context);
    const canvas = within(context.canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.header_search_recent() }));
    await expect(canvas.getByRole('heading', { name: m.header_search_recent() })).toBeVisible();
    await expect(canvas.getByRole('button', { name: recording.query })).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.header_search_history() })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
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
    const realm = within(region).getByRole('link', { name: new RegExp(realmRecording.realm.title) });
    await expect(realm).toBeVisible();
    await expect(realm).toHaveAttribute('href', `/${getLocale()}/realms/${realmRecording.realm.realmId}`);
    await expect(within(region).getByRole('button', { name: m.realm_discovery_continue() })).toBeVisible();
  },
};
export const SearchTrendingSparsePage: Story = {
  render: () => <Example state="trending" loadRealms={readyRealms} />,
  play: async (context) => {
    await SearchTrending.play!(context);
    const region = await realmState(context, 'ready');
    await userEvent.click(within(region).getByRole('button', { name: m.realm_discovery_continue() }));
    await waitFor(() => expect(readyRealms).toHaveBeenCalledTimes(2));
    await expect(readyRealms).toHaveBeenLastCalledWith({
      locale: getLocale(),
      sort: 'trending',
      cursor: nextRealmPage,
      limit: 20,
    });
    await realmState(context, 'ready');
    await expect(within(region).queryByRole('link')).toBeNull();
    await expect(within(region).getByRole('status')).toHaveTextContent(m.realm_discovery_page_empty());
    await expect(within(region).getByRole('status')).toBeVisible();
    await expect(within(region).getByRole('button', { name: m.realm_discovery_continue() })).toBeVisible();
  },
};
export const SearchTrendingPagination: Story = {
  tags: ['!dev'],
  render: () => <Example state="trending" loadRealms={readyRealms} />,
  play: async (context) => {
    await SearchTrendingSparsePage.play!(context);
    const region = await realmState(context, 'ready');
    await userEvent.click(within(region).getByRole('button', { name: m.realm_discovery_continue() }));
    await waitFor(() => expect(readyRealms).toHaveBeenCalledTimes(3));
    await expect(readyRealms).toHaveBeenLastCalledWith({
      locale: getLocale(),
      sort: 'trending',
      cursor: sparseRealmPage,
      limit: 20,
    });
    await realmState(context, 'ready');
    await expect(within(region).queryByRole('link')).toBeNull();
    await expect(within(region).queryByRole('button')).toBeNull();
    await expect(within(region).getByRole('status')).toHaveTextContent(m.realm_discovery_empty());
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
    const region = await realmState(context, 'loading');
    const discovery = within(region).getByRole('region', { name: m.realm_discovery_trending() });
    await expect(discovery).toBeVisible();
    await expect(discovery).toHaveAttribute('aria-busy', 'true');
    const status = within(discovery).getByRole('status');
    await expect(status).toBeVisible();
    await expect(status).toHaveTextContent(m.realm_discovery_loading());
    await waitFor(() => expect(loadingRealms).toHaveBeenCalledTimes(1));
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
    await expect(within(region).getByText(m.realm_discovery_closed({}, { locale: getLocale() }))).toBeVisible();
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
      await userEvent.click(await within(context.canvasElement).findByRole('button', { name: m.shell_create() }));
      const sheet = within(await within(document.body).findByRole('dialog', { name: m.shell_create() }));
      const collection = await sheet.findByRole('link', { name: m.library_collection_new() }, { timeout: 5_000 });
      await expect(collection).toHaveAttribute('href', `/${getLocale()}/collections/new`);
    }
  },
};
async function creationSheet({ canvasElement }: { canvasElement: HTMLElement }) {
  await userEvent.click(within(canvasElement).getByRole('button', { name: m.shell_create() }));
  return within(await within(document.body).findByRole('dialog', { name: m.shell_create() }));
}
async function creationOrder(sheet: ReturnType<typeof within>, fragments: string[]) {
  await waitFor(() =>
    expect(sheet.queryAllByRole('link').map((link: HTMLElement) => link.getAttribute('href'))).toEqual(
      ['', ...fragments].map((fragment) => `/${getLocale()}/collections/new${fragment}`),
    ),
  );
}
export const CreationOwnersLifecycle: Story = {
  tags: ['!dev'],
  render: () => <Example state="creation-owners" />,
  play: async (context) => {
    await pageReady(context);
    if (!phone()) return;
    const canvas = within(context.canvasElement);
    await creationOrder(await creationSheet(context), ['#first', '#shared', '#second']);
    await userEvent.keyboard('{Escape}');
    await expect(canvas.getByRole('button', { name: m.shell_create() })).toHaveFocus();
    await userEvent.click(canvas.getByRole('button', { name: 'Update first owner' }));
    await creationOrder(await creationSheet(context), ['#first-updated', '#shared', '#second']);
    await userEvent.keyboard('{Escape}');
    await userEvent.click(canvas.getByRole('button', { name: 'Unmount second owner' }));
    await creationOrder(await creationSheet(context), ['#first-updated', '#shared']);
    await userEvent.keyboard('{Escape}');
    await userEvent.click(canvas.getByRole('button', { name: 'Mount second owner' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Unmount first owner' }));
    const sheet = await creationSheet(context);
    await creationOrder(sheet, ['#second', '#shared']);
    await expect(sheet.getByRole('link', { name: 'Second shared creation' })).toBeVisible();
  },
};
export const CreationSessionTransition: Story = {
  tags: ['!dev'],
  render: () => <Example state="creation-session" />,
  play: async (context) => {
    await pageReady(context);
    if (!phone()) return;
    const canvas = within(context.canvasElement);
    await creationOrder(await creationSheet(context), ['#first', '#shared', '#second']);
    await userEvent.keyboard('{Escape}');
    for (const state of ['Sign out', 'Session unavailable']) {
      await userEvent.click(canvas.getByRole('button', { name: state }));
      const sheet = await creationSheet(context);
      await waitFor(() => expect(sheet.queryAllByRole('link')).toHaveLength(0));
      await expect(sheet.getByText(m.shell_creation_unavailable())).toBeVisible();
      await userEvent.keyboard('{Escape}');
    }
    await userEvent.click(canvas.getByRole('button', { name: 'Update first owner' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Unmount second owner' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Sign in' }));
    await creationOrder(await creationSheet(context), ['#first-updated', '#shared']);
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
