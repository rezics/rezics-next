import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { StoryObj } from '@storybook/react-vite';
import { anonymousReadMode, type ReadCredentialMode } from '../kernel/credential';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import '../../.storybook/route-root';
import { routeTree } from '../routeTree.gen';
import { setStoryRequestContext } from '../../.storybook/react-start';
import { deLocalizeUrl, getLocale, localizeUrl } from '../paraglide/runtime.js';
import { deletedOrganizationThreadId } from '../kernel/fake';
import { searchFacetStoryPaths } from '../kernel/fake/search-facets';
import { selectLabelStory } from '../kernel/fake/library-labels';
import { selectRatingsFixture, type RatingsFixtureName } from '../kernel/fake/ratings';
import { threadHref } from '../threads/thread-href';
import { RatingsPreviewContext } from '../features/pages/subject-ratings-view';
import type { Ratings } from '../features/pages/subject-ratings';
import boardRecording from '../kernel/recorded/board.json';
import boardThreadsRecording from '../kernel/recorded/board-threads.json';
import searchEmptyRecording from '../kernel/recorded/search-empty.json';
import searchRecording from '../kernel/recorded/search.json';
import searchTypedRecording from '../kernel/recorded/search-typed.json';
import subjectRecording from '../kernel/recorded/subject.json';
import threadRecording from '../kernel/recorded/thread.json';
import threadOwnedRecording from '../kernel/recorded/thread-owned.json';
import threadOwnedPostsRecording from '../kernel/recorded/thread-owned-posts.json';
import offerRecording from '../kernel/recorded/offer.json';
import offerCjkRecording from '../kernel/recorded/offer-cjk.json';
import offerDelistedRecording from '../kernel/recorded/offer-delisted.json';
import orderFailedRecording from '../kernel/recorded/order-failed.json';
import orderPaidRecording from '../kernel/recorded/order-paid.json';
import orderPendingRecording from '../kernel/recorded/order-pending.json';
import libraryChangesRecording from '../kernel/recorded/library-progress-changes.json';
import libraryCollectionMembersRecording from '../kernel/recorded/library-collection-members.json';
import libraryCollectionRecording from '../kernel/recorded/library-collection.json';
import libraryCollectionsRecording from '../kernel/recorded/library-collections.json';
import libraryCopiesRecording from '../kernel/recorded/library-copies.json';
import libraryEntriesRecording from '../kernel/recorded/library-entries.json';
import libraryFollowsRecording from '../kernel/recorded/library-follows.json';
import libraryLogRecording from '../kernel/recorded/library-published-log.json';
import libraryProgressSessionRecording from '../kernel/recorded/library-progress-session.json';
import libraryProgressSessionsRecording from '../kernel/recorded/library-progress-sessions.json';
import { m } from '../paraglide/messages.js';
import { subjectHref } from '../subject/subject-href';

const missingSubjectId = '00000000-0000-4000-8000-000000000000';

const PatternChildren = createContext<ReactNode>(null);

function PatternRoot() {
  return useContext(PatternChildren);
}

const patternRoute = createRootRoute({ component: PatternRoot });

export const pagePaths = {
  home: '/',
  shell: '/',
  subject: subjectHref(
    { id: subjectRecording.subject.id, label: subjectRecording.subject.labels.en ?? 'Subject' },
    'en',
  ).href.replace(/^\/en/, ''),
  'missing-subject': `/subjects/${missingSubjectId}`,
  board: `/boards/${boardRecording.board.id}`,
  thread: threadHref(threadRecording.thread),
  'thread-owned': threadHref(threadOwnedRecording.thread),
  'thread-deleted-organization': threadHref({
    id: deletedOrganizationThreadId,
    title: threadOwnedRecording.thread.title,
  }),
  'board-new': `/boards/${boardRecording.board.id}/new`,
  offer: `/offers/${offerRecording.offer.id}`,
  'offer-cjk': `/offers/${offerCjkRecording.offer.id}`,
  'offer-delisted': `/offers/${offerDelistedRecording.offer.id}`,
  'order-paid': `/orders/${orderPaidRecording.order.id}?checkout=success`,
  'order-pending': `/orders/${orderPendingRecording.order.id}?checkout=success`,
  'order-canceled': `/orders/${orderPendingRecording.order.id}?checkout=canceled`,
  'order-failed': `/orders/${orderFailedRecording.order.id}`,
  search: `/search?q=${encodeURIComponent(searchRecording.query)}`,
  'search-typed': `/search?q=${encodeURIComponent(searchTypedRecording.query)}&type=${encodeURIComponent(searchTypedRecording.filterType)}`,
  'search-rating': '/search?q=Kokoro&sort=rating',
  'search-empty': `/search?q=${encodeURIComponent(searchEmptyRecording.query)}`,
  'search-facets': searchFacetStoryPaths.results,
  'search-facet-active': searchFacetStoryPaths.active,
  'search-no-results': searchFacetStoryPaths.noResults,
  'search-empty-query': searchFacetStoryPaths.emptyQuery,
  'library-entries': '/library',
  'library-collections': '/library/collections',
  'library-labels': '/library/labels',
  'library-copies': '/library/copies',
  'library-following': '/library/following',
  'library-progress': `/library/progress?subjectId=${libraryProgressSessionsRecording.progressSessions[0]?.subjectId}`,
  'library-progress-session': `/library/progress/${libraryProgressSessionRecording.progressSession.id}`,
  'library-collection': `/collections/${libraryCollectionRecording.collection.id}`,
  'library-log': `/logs/${libraryLogRecording.publishedLog.id}`,
} as const;

function parseSearch(searchString: string): Record<string, unknown> {
  const search = new URLSearchParams(searchString);
  const parsed: Record<string, unknown> = Object.create(null);
  for (const [key, value] of search) {
    if (!Object.hasOwn(parsed, key)) parsed[key] = value;
    else if (Array.isArray(parsed[key])) (parsed[key] as string[]).push(value);
    else parsed[key] = [parsed[key] as string, value];
  }
  return parsed;
}

function stringifySearch(search: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (typeof value === 'string') params.append(key, value);
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string') params.append(key, item);
    }
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

function localizedEntry(path: string): string {
  const url = localizeUrl(new URL(path, 'http://rezics.local'));
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Each story enters the generated application route tree at its localized public URL. */
export function PageStory({
  visitor,
  path,
  credentialMode = anonymousReadMode,
  ratings,
  ratingsFixture,
  labelsFixture,
}: {
  visitor: 'Signed In' | 'Signed Out';
  path: string;
  credentialMode?: ReadCredentialMode;
  ratings?: Ratings;
  ratingsFixture?: RatingsFixtureName;
  labelsFixture?: Parameters<typeof selectLabelStory>[0];
}) {
  const entry = localizedEntry(path);
  selectRatingsFixture(ratingsFixture);
  setStoryRequestContext({ visitor, url: entry });
  const { router, queryClient } = useMemo(() => {
    if (labelsFixture) selectLabelStory(labelsFixture);
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000 } } });
    const router = createRouter({
      routeTree,
      context: { queryClient, credentialMode },
      history: createMemoryHistory({ initialEntries: [entry] }),
      parseSearch,
      stringifySearch,
      ssr: {},
      rewrite: { input: ({ url }) => deLocalizeUrl(url).href, output: ({ url }) => localizeUrl(url).href },
    });
    return { router, queryClient };
  }, [entry, labelsFixture]);
  return (
    <RatingsPreviewContext.Provider value={ratings}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </RatingsPreviewContext.Provider>
  );
}

/** Render a connected region with the same request, query, locale and theme context as a page story, without the site shell. */
export function PatternStory({
  children,
  visitor = 'Signed Out',
  path = '/',
}: {
  children: React.ReactNode;
  visitor?: 'Signed In' | 'Signed Out';
  path?: string;
}) {
  const entry = localizedEntry(path);
  setStoryRequestContext({ visitor, url: entry });
  const { router, queryClient } = useMemo(() => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000 } } });
    const router = createRouter({
      routeTree: patternRoute,
      history: createMemoryHistory({ initialEntries: [entry] }),
      parseSearch,
      stringifySearch,
      ssr: {},
      rewrite: { input: ({ url }) => deLocalizeUrl(url).href, output: ({ url }) => localizeUrl(url).href },
    });
    return { router, queryClient };
  }, [entry]);
  return (
    <PatternChildren.Provider value={children}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </PatternChildren.Provider>
  );
}

export async function pageReady({ canvasElement }: { canvasElement: HTMLElement }) {
  await within(canvasElement).findByRole('main');
}

export function exposureStory(path: string, closed = false): StoryObj {
  return {
    name: closed ? 'Exposure closed' : 'Exposure open',
    tags: ['exposure'],
    ...(closed ? { parameters: { admitted: [] } } : {}),
    play: async ({ canvasElement }) => {
      await pageReady({ canvasElement });
      await within(canvasElement).findByRole('button', { name: m.account_menu() });
    },
    render: () => <PageStory visitor="Signed In" path={path} />,
  };
}

function viewOf({ canvasElement }: { canvasElement: HTMLElement }) {
  return within(within(canvasElement).getByRole('main'));
}

// A list item's accessible name stays empty; the named control inside it carries the text.
async function listItemWithLink(view: ReturnType<typeof within>, name: string): Promise<void> {
  const link = await view.findByRole('link', { name });
  const items = await view.findAllByRole('listitem');
  expect(items.some((item: HTMLElement) => item.contains(link))).toBe(true);
}

export async function boardReady(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const view = viewOf(context);
  const title = boardThreadsRecording.threads[0]?.title;
  if (!title) throw new Error('The recorded board has no thread.');
  await view.findByRole('heading', { level: 1, name: boardRecording.board.title });
  await view.findByRole('heading', { level: 2, name: m.board_threads_heading() });
  await listItemWithLink(view, title);
  const primary = await view.findByRole('link', { name: title });
  await view.findByRole('link', {
    name: 'A long title about the quiet planet, the little fox, and the stars that guide every traveler home',
  });
  await view.findByRole('link', { name: 'When the stars are quiet, where does the fox sleep?' });
  const row = primary.closest<HTMLElement>('[data-slot="list-row"]');
  if (!row) throw new Error('The board thread title is not in a ListRow.');
  row.dataset.overlay = 'visible';
}

export async function threadReady(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const view = viewOf(context);
  const title = threadRecording.thread.title;
  if (!title) throw new Error('The recorded thread has no title.');
  await view.findByRole('heading', { level: 1, name: title });
  await view.findByRole('heading', { level: 2, name: m.thread_posts_heading() });
  await view.findAllByText(m.thread_post_edited());
  await expect(view.getAllByText(m.thread_post_edited())).toHaveLength(1);
  const attached = subjectRecording.subject.labels as Record<string, string>;
  await view.findByRole('link', { name: attached[getLocale()] ?? attached.en! });
  await view.findByRole('heading', { level: 2, name: 'Flight notes' });
  const note = await view.findByText('Watch the baobabs');
  const items = await view.findAllByRole('listitem');
  expect(items.some((item) => item.contains(note))).toBe(true);
  await listItemWithLink(view, 'The asteroid');
  await userEvent.click(await view.findByRole('button', { name: m.thread_reveal_spoiler() }));
  await expect(view.getByText('The rose was unique')).toBeVisible();
}

export async function threadPolishReady(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const view = viewOf(context);
  const title = threadRecording.thread.title;
  if (!title) throw new Error('The recorded thread has no title.');
  await view.findByRole('heading', { level: 1, name: title });
  await view.findByRole('heading', { level: 2, name: m.thread_posts_heading() });
  await view.findAllByText(m.thread_post_edited());
  await expect(view.getAllByText(m.thread_post_edited())).toHaveLength(1);
}

/** The offer page shows its locale's subject label, the read's price and one checkout control. */
function offerReady(recording: typeof offerRecording, available: boolean) {
  return async (context: { canvasElement: HTMLElement }) => {
    await pageReady(context);
    const view = viewOf(context);
    const { currency, title, unitAmountMinor } = recording.offer;
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
    const subjectLabels = subjectRecording.subject.labels as Record<string, string>;
    await view.findByRole('heading', { level: 1, name: subjectLabels[getLocale()] ?? subjectLabels.en! });
    await view.findByText(title, { exact: false });
    await view.findByText(
      new Intl.NumberFormat(getLocale(), { style: 'currency', currency }).format(unitAmountMinor / 10 ** (digits ?? 2)),
    );
    const buy = await view.findByRole('button', { name: m.offer_buy() });
    if (available) await expect(buy).toBeEnabled();
    else {
      await expect(buy).toBeDisabled();
      await view.findByText(m.offer_unavailable());
    }
  };
}

export const offerPageReady = offerReady(offerRecording, true);
export const offerCjkReady = offerReady(offerCjkRecording, true);
export const offerDelistedReady = offerReady(offerDelistedRecording, false);

/** The order page states what happened to the payment in its heading. */
function orderReady(heading: () => string, note?: () => string) {
  return async (context: { canvasElement: HTMLElement }) => {
    await pageReady(context);
    const view = viewOf(context);
    await view.findByRole('heading', { level: 1, name: heading() });
    if (note) await view.findByText(note());
  };
}

export const orderPaidReady = async (context: { canvasElement: HTMLElement }) => {
  await orderReady(() => m.order_paid())(context);
  const view = viewOf(context);
  await view.findByRole('heading', { level: 2, name: m.order_receipt() });
  await view.findByRole('link', {
    name: subjectRecording.subject.labels[getLocale()] ?? subjectRecording.subject.labels.en,
  });
  await view.findByRole('link', { name: m.order_open_library() });
};
export const orderPendingReady = orderReady(
  () => m.order_pending(),
  () => m.order_confirming(),
);
export const orderCanceledReady = async (context: { canvasElement: HTMLElement }) => {
  await orderReady(() => m.order_canceled())(context);
  await viewOf(context).findByRole('link', { name: m.order_back() });
};
export const orderFailedReady = async (context: { canvasElement: HTMLElement }) => {
  await orderReady(() => m.order_failed())(context);
  await viewOf(context).findByRole('link', { name: m.order_back() });
};

/** The new-thread page asks for a title and a body, and cannot send until both are filled. */
export async function newThreadReady(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const view = viewOf(context);
  await view.findByRole('heading', { level: 1, name: m.thread_new_heading() });
  await view.findByRole('textbox', { name: m.thread_title_label() });
  await expect(await view.findByRole('button', { name: m.thread_write_send() })).toBeDisabled();
}

/** A reply is typed under the thread; sending becomes possible once there is something to send. */
export async function replyReady(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const view = viewOf(context);
  await view.findByRole('heading', { level: 1, name: threadRecording.thread.title });
  // The recorded thread holds a hidden spoiler; the thread story reveals it for the same reason.
  await userEvent.click(await view.findByRole('button', { name: m.thread_reveal_spoiler() }));
  const editor = await view.findByRole('textbox', { name: m.thread_reply_body_label() });
  await expect(await view.findByRole('button', { name: m.thread_write_send() })).toBeDisabled();
  await userEvent.click(editor);
  await userEvent.keyboard('The baobabs are easy to spot once you know the leaves.');
  await waitFor(async () => expect(await view.findByRole('button', { name: m.thread_write_send() })).toBeEnabled());
}

/** The author of a post opens its inline editor from the post's action menu. */
export async function editReady(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const view = viewOf(context);
  const opening = threadOwnedPostsRecording.posts[0];
  if (!opening) throw new Error('The recorded thread has no post to edit.');
  await view.findByRole('heading', { level: 1, name: threadOwnedRecording.thread.title });
  const [actions] = await view.findAllByRole('button', { name: m.thread_content_more_actions() });
  if (!actions) throw new Error('The author sees no post actions.');
  await userEvent.click(actions);
  await userEvent.click(await within(document.body).findByRole('menuitem', { name: m.thread_content_edit() }));
  await expect(await view.findByRole('button', { name: m.thread_edit_save() })).toBeEnabled();
  await view.findByRole('button', { name: m.thread_edit_cancel() });
}

function searchLabel(recording: typeof searchRecording | typeof searchTypedRecording) {
  const labels = recording.subjects[0]?.labels;
  if (!labels) throw new Error('The recorded search has no subject.');
  return labels[getLocale()] ?? labels.ja ?? labels.en;
}

export async function searchReady(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const view = viewOf(context);
  const label = searchLabel(searchRecording);
  await view.findByRole('heading', { level: 1, name: m.search_heading() });
  await expect(view.getByRole('textbox', { name: m.search_label() })).toHaveValue(searchRecording.query);
  await view.findByRole('button', { name: m.search_submit() });
  await expect(view.getByLabelText(m.search_sort_label())).toHaveValue('relevance');
  await listItemWithLink(view, label);
}

export async function searchTypedReady(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const view = viewOf(context);
  const label = searchLabel(searchTypedRecording);
  await view.findByRole('heading', { level: 1, name: m.search_heading() });
  await expect(view.getByRole('textbox', { name: m.search_label() })).toHaveValue(searchTypedRecording.query);
  await listItemWithLink(view, label);
}

export async function searchRatingReady(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const view = viewOf(context);
  await view.findByRole('heading', { level: 1, name: m.search_heading() });
  await expect(view.getByLabelText(m.search_sort_label())).toHaveValue('rating');
  await view.findByText(m.search_global_score());
  await listItemWithLink(view, getLocale() === 'zh-Hans' ? '心' : 'Kokoro');
  await expect(view.getByText('8.6', { exact: true })).toBeVisible();
  const unscoredTitle = getLocale() === 'zh-Hans' ? '尚无评分的故事' : 'An Unscored Story';
  const unscoredLink = await view.findByRole('link', { name: unscoredTitle });
  const unscoredRow = unscoredLink.closest('[data-slot="list-row"]');
  await expect(unscoredRow?.querySelector('[data-slot="public-rating-figure"]')).toBeNull();
}

export async function searchEmptyReady(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const view = viewOf(context);
  await view.findByRole('heading', { level: 1, name: m.search_heading() });
  await expect(view.getByRole('textbox', { name: m.search_label() })).toHaveValue(searchEmptyRecording.query);
  await view.findByRole('button', { name: m.search_submit() });
  await expect(view.getByText(m.search_no_results())).toBeVisible();
}

/** A Library page shows its heading and a seeded item, and no error page stands in for it. */
function libraryReady(heading: () => string, item: () => string | undefined) {
  return async (context: { canvasElement: HTMLElement }) => {
    await pageReady(context);
    const view = viewOf(context);
    const seeded = item();
    if (!seeded) throw new Error('The recorded Library page has no item to show.');
    await view.findByRole('heading', { level: 1, name: heading() });
    await view.findAllByText(seeded, { exact: false });
  };
}

export const libraryEntriesReady = libraryReady(
  () => m.library_heading(),
  () => libraryEntriesRecording.libraryEntries[0]?.subject.label.value,
);
export const libraryCollectionsReady = libraryReady(
  () => m.library_collections_heading(),
  () => libraryCollectionsRecording.collections[0]?.title,
);
export const libraryCopiesReady = libraryReady(
  () => m.library_copy_heading(),
  () => libraryCopiesRecording.copies[0]?.subject.label,
);
export const libraryFollowingReady = libraryReady(
  () => m.library_following_heading(),
  () => libraryFollowsRecording.follows[0]?.target.label,
);
export async function libraryProgressReady(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const view = viewOf(context);
  const seeded = libraryProgressSessionsRecording.progressSessions[0]?.subject.label;
  await view.findByRole('heading', { level: 1, name: m.library_progress_heading() });
  if (seeded) await view.findAllByText(seeded, { exact: false });
  const [first] = await view.findAllByRole('listitem');
  if (first) await userEvent.hover(first);
}
export async function libraryProgressSessionReady(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const view = viewOf(context);
  await view.findByRole('heading', { level: 1, name: m.library_progress_heading() });
  await view.findByRole('button', { name: m.library_progress_update() });
  await view.findByText(m.library_progress_state_active(), { exact: true });
}

export async function libraryProgressUpdateOpen(context: { canvasElement: HTMLElement }) {
  await libraryProgressSessionReady(context);
  const view = viewOf(context);
  await userEvent.click(await view.findByRole('button', { name: m.library_progress_update() }));
  await within(document.body).findByRole('dialog');
  await within(document.body).findByRole('textbox', { name: m.library_progress_locator() });
}

export async function libraryProgressUnitMenuOpen(context: { canvasElement: HTMLElement }) {
  await libraryProgressReady(context);
  const view = viewOf(context);
  await userEvent.click(await view.findByRole('button', { name: m.library_progress_unit() }));
  await within(document.body).findByRole('dialog');
  await within(document.body).findByRole('radiogroup', { name: m.library_progress_unit() });
}
export const libraryCollectionReady = libraryReady(
  () => libraryCollectionRecording.collection.title,
  () => libraryCollectionMembersRecording.members[0]?.subject.label.value,
);
export const libraryLogReady = libraryReady(
  () => m.library_logs_page_heading(),
  () => libraryLogRecording.publishedLog.note,
);
