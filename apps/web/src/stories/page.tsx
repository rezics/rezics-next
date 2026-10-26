import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { expect, userEvent, within } from 'storybook/test';
import { useMemo } from 'react';
import '../../.storybook/route-root';
import { routeTree } from '../routeTree.gen';
import { setStoryRequestContext } from '../../.storybook/react-start';
import { deLocalizeUrl, getLocale, localizeUrl } from '../paraglide/runtime.js';
import boardRecording from '../kernel/recorded/board.json';
import boardThreadsRecording from '../kernel/recorded/board-threads.json';
import searchEmptyRecording from '../kernel/recorded/search-empty.json';
import searchRecording from '../kernel/recorded/search.json';
import searchTypedRecording from '../kernel/recorded/search-typed.json';
import subjectRecording from '../kernel/recorded/subject.json';
import threadRecording from '../kernel/recorded/thread.json';
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

const missingSubjectId = '00000000-0000-4000-8000-000000000000';

export const pagePaths = {
  home: '/',
  shell: '/',
  subject: `/subjects/${subjectRecording.subject.id}`,
  'missing-subject': `/subjects/${missingSubjectId}`,
  board: `/boards/${boardRecording.board.id}`,
  thread: `/threads/${threadRecording.thread.id}`,
  search: `/search?q=${encodeURIComponent(searchRecording.query)}`,
  'search-typed': `/search?q=${encodeURIComponent(searchTypedRecording.query)}&type=${encodeURIComponent(searchTypedRecording.filterType)}`,
  'search-empty': `/search?q=${encodeURIComponent(searchEmptyRecording.query)}`,
  'library-entries': '/library',
  'library-collections': '/library/collections',
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
export function PageStory({ visitor, path }: { visitor: 'Signed In' | 'Signed Out'; path: string }) {
  const entry = localizedEntry(path);
  setStoryRequestContext({ visitor, url: entry });
  const router = useMemo(
    () =>
      createRouter({
        routeTree,
        history: createMemoryHistory({ initialEntries: [entry] }),
        parseSearch,
        stringifySearch,
        ssr: {},
        rewrite: { input: ({ url }) => deLocalizeUrl(url).href, output: ({ url }) => localizeUrl(url).href },
      }),
    [entry],
  );
  return <RouterProvider router={router} />;
}

export async function pageReady({ canvasElement }: { canvasElement: HTMLElement }) {
  await within(canvasElement).findByRole('main');
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
}

export async function threadReady(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const view = viewOf(context);
  const title = threadRecording.thread.title;
  if (!title) throw new Error('The recorded thread has no title.');
  await view.findByRole('heading', { level: 1, name: title });
  await view.findByRole('heading', { level: 2, name: m.thread_posts_heading() });
  await view.findByRole('heading', { level: 2, name: 'Flight notes' });
  const note = await view.findByText('Watch the baobabs');
  const items = await view.findAllByRole('listitem');
  expect(items.some((item) => item.contains(note))).toBe(true);
  await listItemWithLink(view, 'The asteroid');
  await userEvent.click(await view.findByRole('button', { name: m.thread_reveal_spoiler() }));
  await expect(view.getByText('The rose was unique')).toBeVisible();
}

function searchLabel(recording: typeof searchRecording | typeof searchTypedRecording) {
  const labels = recording.subjects[0]?.labels;
  if (!labels) throw new Error('The recorded search has no subject.');
  return labels[getLocale()] ?? labels.en;
}

export async function searchReady(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const view = viewOf(context);
  const label = searchLabel(searchRecording);
  await view.findByRole('heading', { level: 1, name: m.search_heading() });
  await expect(view.getByRole('textbox', { name: m.search_label() })).toHaveValue(searchRecording.query);
  await view.findByRole('button', { name: m.search_submit() });
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
  () => libraryEntriesRecording.libraryEntries[0]?.subject.label,
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
export const libraryProgressReady = libraryReady(
  () => m.library_progress_heading(),
  () => libraryProgressSessionsRecording.progressSessions[0]?.subject.label,
);
export const libraryProgressSessionReady = libraryReady(
  () => m.library_progress_heading(),
  () => libraryChangesRecording.changes[0]?.intent.locator,
);
export const libraryCollectionReady = libraryReady(
  () => libraryCollectionRecording.collection.title,
  () => libraryCollectionMembersRecording.members[0]?.subject.label,
);
export const libraryLogReady = libraryReady(
  () => m.library_logs_page_heading(),
  () => libraryLogRecording.publishedLog.note,
);
