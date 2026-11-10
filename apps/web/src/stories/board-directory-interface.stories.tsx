import { useState } from 'react';
import { createKernelClient } from '@rezics/client';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import recording from '../kernel/recorded/board.json';
import { createStoryRecordedKernelFetch } from '../kernel/fake';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { BoardDirectory } from '../threads/board-directory-view';
import {
  boardDirectoryHref,
  boardDirectoryPrevious,
  createNativeBoardDirectoryAdapter,
  loadBoardDirectory,
  type BoardDirectoryPrevious,
  type BoardDirectoryRequest,
  type BoardDirectoryState,
  type DirectoryBoard,
} from '../threads/board-directory';
import { PatternStory } from './page';

const title = `Reading together across languages العربية 日本語 ${'UnbrokenBoardTitle'.repeat(12)}`;
const contribution = {
  subject: '01a17a3b-0884-721b-91ef-d7ffd7bb58e4',
  subjectTitle: `The complete supplied Subject title العربية 日本語 ${'LongSubjectTitle'.repeat(32)}`.slice(0, 512),
};
const currentCursor = 'signed:current/+opaque=';
const priorCursor = 'signed:prior/+opaque=';
const nextCursor = 'signed:next/+opaque=';
type State = 'ready' | 'protected' | 'sparse' | 'empty' | 'loading' | 'unavailable' | 'denied' | 'closed';

/** Supplied initial DTOs only. Every navigation/retry uses the installed adapter and existing recordings. */
function DirectoryInterface({
  state = 'ready',
  purpose = 'reviews',
  direction = 'ltr',
  multiple = false,
  enlargedLabels = false,
  onRead,
}: {
  state?: State;
  purpose?: BoardDirectoryRequest['purpose'];
  direction?: 'ltr' | 'rtl';
  multiple?: boolean;
  enlargedLabels?: boolean;
  onRead: (request: BoardDirectoryRequest) => void;
}) {
  const board: DirectoryBoard = {
    ...recording.board,
    community: null,
    title,
    purpose,
    visibility: state === 'protected' ? 'protected' : 'published',
    availability: 'available',
  };
  const [request, setRequest] = useState<BoardDirectoryRequest>({ purpose, cursor: currentCursor, limit: 20 });
  const [previous, setPrevious] = useState<BoardDirectoryPrevious | undefined>({
    request: { purpose, cursor: priorCursor, limit: 20 },
    target: currentCursor,
    contribution,
  });
  const [result, setResult] = useState<BoardDirectoryState>(() =>
    state === 'ready' || state === 'protected'
      ? { state: 'ready', boards: [board], next: nextCursor }
      : state === 'sparse' || state === 'empty'
        ? { state: 'ready', boards: [], next: state === 'sparse' ? nextCursor : null }
        : { state },
  );
  const read = async (destination: BoardDirectoryRequest) => {
    onRead(destination);
    setResult({ state: 'loading' });
    setResult(
      await loadBoardDirectory(
        destination,
        createNativeBoardDirectoryAdapter(
          createKernelClient('https://kernel.invalid', { fetch: createStoryRecordedKernelFetch() }),
        ),
      ),
    );
  };
  return (
    <PatternStory path={boardDirectoryHref(request, getLocale(), contribution).replace(`/${getLocale()}`, '')}>
      <div
        data-directory-interface=""
        dir={direction}
        className={`w-[390px] max-w-full space-y-12 p-4 ${enlargedLabels ? '[&_a]:text-[28px] [&_button]:text-[28px]' : ''}`}
      >
        {Array.from({ length: multiple ? 2 : 1 }, (_, index) => (
          <BoardDirectory
            key={index}
            request={request}
            contribution={contribution}
            result={result}
            {...(previous ? { previous } : {})}
            onNavigate={(destination) => {
              setPrevious(
                result.state === 'loading'
                  ? undefined
                  : boardDirectoryPrevious(request, result, destination, contribution),
              );
              setRequest(destination);
              void read(destination);
            }}
            onRetry={() => {
              void read(request);
            }}
          />
        ))}
      </div>
    </PatternStory>
  );
}

const meta = {
  title: 'Community/Board Directory/Interface',
  id: 'patterns-community-board-directory-interface',
  component: DirectoryInterface,
  args: { onRead: fn() },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Authored observations UNRUN. The actual BoardDirectory renders complete long titles, current metadata and independent controls at 390px, including RTL and enlarged existing labels. Initial DTOs are illustrative, not native authorization evidence. Purpose, prior, next and manual retry callbacks use the installed native adapter; the absent directory recording stays unavailable. No browser, accessibility, native or full acceptance is claimed.',
      },
    },
  },
  globals: { viewport: { value: 'phone390', isRotated: false } },
} satisfies Meta<typeof DirectoryInterface>;
export default meta;
type Story = StoryObj<typeof meta>;

async function observeLayout(canvasElement: HTMLElement, protectedBoard = false) {
  const wrapper = canvasElement.querySelector<HTMLElement>('[data-directory-interface]')!;
  await expect(wrapper.scrollWidth).toBeLessThanOrEqual(wrapper.clientWidth + 1);
  for (const article of wrapper.querySelectorAll('article')) {
    const view = within(article);
    await expect(view.getByRole('heading', { level: 1, name: m.board_directory_heading() })).toBeVisible();
    await expect(
      view.getByText(m.board_directory_subject({ title: contribution.subjectTitle }), { exact: true }),
    ).toBeVisible();
    await expect(article.scrollWidth).toBeLessThanOrEqual(article.clientWidth + 1);
    for (const control of article.querySelectorAll<HTMLElement>('a, button')) {
      const rect = control.getBoundingClientRect();
      await expect(rect.height).toBeGreaterThanOrEqual(44);
      await expect(rect.width).toBeGreaterThanOrEqual(44);
      await expect(control.scrollWidth).toBeLessThanOrEqual(control.clientWidth + 1);
      if (!control.matches('[data-slot="list-row-link"]')) {
        await expect(getComputedStyle(control).whiteSpace).toBe('normal');
        await expect(control.scrollHeight).toBeLessThanOrEqual(control.clientHeight + 1);
      }
    }
    const heading = article.querySelector('h2[data-content-item-slot="title"]');
    if (heading) {
      const primary = view.getByRole('link', { name: title });
      const action = article.querySelector<HTMLElement>('[data-content-item-slot="actions"] a')!;
      const metadata = article.querySelector<HTMLElement>('[data-content-item-slot="metadata"]')!;
      await expect(heading.textContent).toBe(title);
      await expect(heading.scrollHeight).toBeLessThanOrEqual(heading.clientHeight + 1);
      await expect(primary).toHaveAttribute('aria-labelledby', heading.id);
      await expect(primary).toHaveAttribute('href', `/${getLocale()}/boards/${boardId}`);
      await expect(primary.contains(action)).toBe(false);
      await expect(action.getBoundingClientRect().top).toBeGreaterThanOrEqual(metadata.getBoundingClientRect().bottom);
      for (const fact of [
        m.board_directory_global(),
        protectedBoard ? m.board_directory_protected() : m.board_directory_public(),
      ])
        await expect(metadata.textContent).toContain(fact);
    }
  }
}
const boardId = recording.board.id;

async function observeContribution(canvasElement: HTMLElement, purpose: BoardDirectoryRequest['purpose']) {
  const view = within(canvasElement);
  const action = view.getByRole('link', {
    name:
      purpose === 'reviews'
        ? m.board_directory_review_named({ title, subject: contribution.subjectTitle })
        : m.board_directory_discuss_named({ title, subject: contribution.subjectTitle }),
  });
  const destination = new URL(action.getAttribute('href')!, window.location.origin);
  await expect(destination.pathname).toBe(`/${getLocale()}/boards/${boardId}/new`);
  await expect(Object.fromEntries(destination.searchParams)).toEqual(contribution);
  await expect(action.textContent).toBe(
    purpose === 'reviews' ? m.subject_community_review() : m.subject_community_discuss(),
  );
  await expect(
    view.getByRole('link', {
      name: purpose === 'reviews' ? m.board_directory_reviews() : m.board_directory_discussion(),
    }),
  ).toHaveAttribute('aria-current', 'page');
  await observeLayout(canvasElement);
}

export const LongReviewTitles: Story = {
  play: async ({ canvasElement }) => observeContribution(canvasElement, 'reviews'),
};
export const LongDiscussionTitlesRtl: Story = {
  args: { purpose: 'discussion', direction: 'rtl' },
  play: async ({ canvasElement }) => observeContribution(canvasElement, 'discussion'),
};
export const SuppliedProtectedFacts: Story = {
  args: { state: 'protected', direction: 'rtl' },
  play: async ({ canvasElement, args }) => {
    // Defensive presentation of a supplied DTO is not evidence that the native directory discloses it.
    await observeLayout(canvasElement, true);
    const view = within(canvasElement);
    await expect(view.getByRole('link', { name: m.board_directory_open_named({ title }) })).toHaveAttribute(
      'href',
      `/${getLocale()}/boards/${boardId}`,
    );
    await expect(
      view.queryByRole('link', {
        name: m.board_directory_review_named({ title, subject: contribution.subjectTitle }),
      }),
    ).toBeNull();
    await expect(args.onRead).not.toHaveBeenCalled();
  },
};
export const EnlargedGermanLabelsRtl: Story = {
  args: { direction: 'rtl', enlargedLabels: true },
  globals: { locale: 'de' },
  play: async ({ canvasElement }) => {
    await observeContribution(canvasElement, 'reviews');
    await expect(
      canvasElement.querySelector('[data-content-item-slot="actions"] a')!.getBoundingClientRect().height,
    ).toBeGreaterThan(44);
  },
};
export const MultipleInstancesRtl: Story = {
  args: { direction: 'rtl', multiple: true },
  play: async ({ canvasElement }) => {
    await observeLayout(canvasElement);
    const headings = [...canvasElement.querySelectorAll('h2[data-content-item-slot="title"]')];
    await expect(headings).toHaveLength(2);
    await expect(new Set(headings.map((heading) => heading.id)).size).toBe(2);
  },
};
export const KeyboardDestinations: Story = {
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const controls = [...canvasElement.querySelectorAll<HTMLElement>('article a')];
    controls[0]!.focus();
    for (const control of controls.slice(1)) {
      await userEvent.tab();
      await expect(control).toHaveFocus();
    }
    await expect(view.getByRole('link', { name: title })).toHaveAttribute('href', `/${getLocale()}/boards/${boardId}`);
  },
};

function directoryDestination(link: HTMLElement) {
  return new URL(link.getAttribute('href')!, window.location.origin);
}
async function observePageControl(canvasElement: HTMLElement, name: string, cursor: string) {
  const link = within(canvasElement).getByRole('link', { name });
  const url = directoryDestination(link);
  await expect(url.pathname).toBe(`/${getLocale()}/boards`);
  await expect(Object.fromEntries(url.searchParams)).toEqual({ purpose: 'reviews', cursor, ...contribution });
  link.focus();
  await userEvent.keyboard('{Enter}');
  await expect(await within(canvasElement).findByText(m.board_directory_unavailable())).toBeVisible();
}
export const PriorAndManualRetry: Story = {
  play: async ({ canvasElement, args }) => {
    await expect(args.onRead).not.toHaveBeenCalled();
    await observePageControl(canvasElement, m.board_directory_previous(), priorCursor);
    const destination = { purpose: 'reviews', cursor: priorCursor, limit: 20 };
    await expect(args.onRead).toHaveBeenCalledTimes(1);
    await expect(args.onRead).toHaveBeenLastCalledWith(destination);
    const retry = within(canvasElement).getByRole('button', { name: m.board_directory_retry() });
    retry.focus();
    await userEvent.keyboard(' ');
    await expect(args.onRead).toHaveBeenCalledTimes(2);
    await expect(args.onRead).toHaveBeenLastCalledWith(destination);
    await expect(within(canvasElement).queryByText(m.board_directory_empty())).toBeNull();
  },
};
export const NextPage: Story = {
  play: async ({ canvasElement, args }) => {
    await observePageControl(canvasElement, m.board_directory_next(), nextCursor);
    await expect(args.onRead).toHaveBeenCalledTimes(1);
    await expect(args.onRead).toHaveBeenLastCalledWith({ purpose: 'reviews', cursor: nextCursor, limit: 20 });
    await expect(within(canvasElement).queryByRole('link', { name: m.board_directory_next() })).toBeNull();
  },
};
export const CurrentPurpose: Story = {
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    const discussion = view.getByRole('link', { name: m.board_directory_discussion() });
    await expect(Object.fromEntries(directoryDestination(discussion).searchParams)).toEqual({
      purpose: 'discussion',
      ...contribution,
    });
    await userEvent.click(discussion);
    await expect(await view.findByText(m.board_directory_unavailable())).toBeVisible();
    await expect(args.onRead).toHaveBeenCalledTimes(1);
    await expect(args.onRead).toHaveBeenLastCalledWith({ purpose: 'discussion', limit: 20 });
    await expect(view.getByRole('link', { name: m.board_directory_discussion() })).toHaveAttribute(
      'aria-current',
      'page',
    );
  },
};
export const SparseContinuation: Story = {
  args: { state: 'sparse', direction: 'rtl' },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByText(m.board_directory_sparse())).toBeVisible();
    await expect(view.queryByText(m.board_directory_empty())).toBeNull();
    await observeLayout(canvasElement);
    await observePageControl(canvasElement, m.board_directory_next(), nextCursor);
  },
};
export const TerminalEmpty: Story = {
  args: { state: 'empty' },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByText(m.board_directory_empty())).toBeVisible();
    await expect(view.queryByText(m.board_directory_sparse())).toBeNull();
    await expect(view.queryByRole('link', { name: m.board_directory_next() })).toBeNull();
    await expect(view.getByRole('link', { name: m.board_directory_previous() })).toBeVisible();
    await observeLayout(canvasElement);
  },
};

async function observeUnavailable(canvasElement: HTMLElement, state: 'loading' | 'unavailable' | 'denied' | 'closed') {
  const view = within(canvasElement);
  const text =
    state === 'loading'
      ? m.board_directory_loading()
      : state === 'unavailable'
        ? m.board_directory_unavailable()
        : state === 'denied'
          ? m.board_directory_denied()
          : m.platform_closed_message();
  await expect(view.getByText(text)).toBeVisible();
  await expect(view.queryByText(m.board_directory_empty())).toBeNull();
  await expect(view.queryByText(m.board_directory_sparse())).toBeNull();
  await expect(
    canvasElement.querySelectorAll('li, article nav[aria-label="' + m.board_directory_pages() + '"]'),
  ).toHaveLength(0);
  await expect(canvasElement.innerHTML).not.toContain(boardId);
  await expect(canvasElement.textContent).not.toContain(title);
  await expect(view.queryByRole('button', { name: m.board_directory_retry() }) !== null).toBe(state === 'unavailable');
  await observeLayout(canvasElement);
}
export const Loading: Story = {
  args: { state: 'loading' },
  play: async ({ canvasElement }) => observeUnavailable(canvasElement, 'loading'),
};
export const UnavailableManualRetry: Story = {
  args: { state: 'unavailable', direction: 'rtl', enlargedLabels: true },
  play: async ({ canvasElement, args }) => {
    await observeUnavailable(canvasElement, 'unavailable');
    await expect(args.onRead).not.toHaveBeenCalled();
    await userEvent.click(within(canvasElement).getByRole('button', { name: m.board_directory_retry() }));
    await expect(args.onRead).toHaveBeenCalledTimes(1);
    await expect(args.onRead).toHaveBeenLastCalledWith({ purpose: 'reviews', cursor: currentCursor, limit: 20 });
    await expect(await within(canvasElement).findByText(m.board_directory_unavailable())).toBeVisible();
  },
};
export const Denied: Story = {
  args: { state: 'denied' },
  play: async ({ canvasElement }) => observeUnavailable(canvasElement, 'denied'),
};
export const PlatformClosed: Story = {
  args: { state: 'closed' },
  play: async ({ canvasElement }) => observeUnavailable(canvasElement, 'closed'),
};
