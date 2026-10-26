import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { expect, userEvent, within } from 'storybook/test';
import { useMemo } from 'react';
import '../../.storybook/route-root';
import { routeTree } from '../routeTree.gen';
import { setStoryRequestContext } from '../../.storybook/react-start';
import { deLocalizeUrl, localizeUrl } from '../paraglide/runtime.js';
import boardRecording from '../kernel/recorded/board.json';
import boardThreadsRecording from '../kernel/recorded/board-threads.json';
import searchEmptyRecording from '../kernel/recorded/search-empty.json';
import searchRecording from '../kernel/recorded/search.json';
import subjectRecording from '../kernel/recorded/subject.json';
import threadRecording from '../kernel/recorded/thread.json';
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
  'search-empty': `/search?q=${encodeURIComponent(searchEmptyRecording.query)}`,
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

function searchLabel(recording: typeof searchRecording) {
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

export async function searchEmptyReady(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const view = viewOf(context);
  await view.findByRole('heading', { level: 1, name: m.search_heading() });
  await expect(view.getByRole('textbox', { name: m.search_label() })).toHaveValue(searchEmptyRecording.query);
  await view.findByRole('button', { name: m.search_submit() });
  await expect(view.getByText(m.search_no_results())).toBeVisible();
}
