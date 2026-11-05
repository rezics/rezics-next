import type { Meta, StoryObj } from '@storybook/react-vite';
import { useQuery } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import { expect, fn, screen, userEvent, within } from 'storybook/test';
import { Button } from '@rezics/ui/shadcn/button';
import { loadBoardPageWithAuthors } from '../identity/page-loaders';
import { createStoryRecordedKernelFetch } from '../kernel/fake';
import { continuationCursor, emptyBoardId, rankRefreshedAt } from '../kernel/fake/board-continuation';
import board from '../kernel/recorded/board.json';
import threads from '../kernel/recorded/board-threads.json';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { BoardFeed } from '../threads/board-feed';
import { BoardCommunityStatus } from '../threads/board-community';
import type { BoardFeedThread, CommunityBoardPage } from '../threads/board-feed-data';
import type { BoardSort } from '../threads/board-sort';
import { fullDateTime } from '../threads/byline';
import { threadLocation } from '../threads/thread-href';
import { ContinueHot as continuation } from './board-continuation.stories';
import { Sort as sortNavigation } from './patterns/board-community/board-community.stories';
import { PatternStory } from './page';

const now = '2026-11-01T00:00:00.000Z';
const threadId = threads.threads[0]!.id;
const lastActivityAt = '2026-10-31T12:34:56.789Z';
const title = `Reading across languages 共讀與交流 ${'A patient discussion of translations and interpretations. '.repeat(5)}${'UnbrokenThreadTitle'.repeat(12)}`;
const displayName = `Readers around the world 共讀 ${'UnbrokenSuppliedAuthor'.repeat(12)}`;
const actionLabel = `Start a discussion 共讀與交流 ${'SuppliedActionLabel'.repeat(14)}`;
const reactions = 1234567890123;
const replies = 987654321012;
const action = fn();
const clipboardWrite = fn(async (_value: string): Promise<void> => {});
type Variant = 'populated' | 'multiple' | 'unavailable' | 'deleted-author' | 'sparse' | 'final';

// Recorded DTOs supply the shape; long text, counts, dates and unavailable variants are explicit consumer fixtures.
// No native availability, aggregate, authorization, signing or growth evidence is claimed by these observations.
async function loadExample(): Promise<CommunityBoardPage> {
  const loaded = await loadBoardPageWithAuthors(
    createKernelClient('https://kernel.story', { fetch: createStoryRecordedKernelFetch() }),
    { id: board.board.id },
  );
  const source = loaded.threads.threads[0]!;
  const author = loaded.authors?.[source.authorId];
  const supplied = { ...source, title, reactions: { like: reactions }, replyCount: replies, lastActivityAt };
  return {
    ...loaded,
    now,
    authors:
      author?.state === 'active'
        ? { [source.authorId]: { ...author, displayName, handle: 'supplied_long_author_handle'.repeat(6) } }
        : loaded.authors,
    threads: { ...loaded.threads, threads: [supplied], next: continuationCursor, rankRefreshedAt },
  };
}

function FeedExamples({
  variant = 'populated',
  direction = 'ltr',
  sort = 'hot',
}: {
  variant?: Variant;
  direction?: 'ltr' | 'rtl';
  sort?: BoardSort;
}) {
  const query = useQuery({ queryKey: ['board-feed-interface'], queryFn: loadExample });
  if (query.isPending) return <BoardCommunityStatus state="loading" />;
  if (query.isError) return <BoardCommunityStatus state="error" />;
  const loaded = query.data;
  const source = loaded.threads.threads[0]!;
  const opening: BoardFeedThread = {
    ...source,
    title: null,
    firstPost: { ...source.firstPost, availability: 'erased', removed: true, body: null, sha256: null },
  };
  const erased: BoardFeedThread = {
    ...opening,
    id: '01a17a3b-09b4-77bf-a24b-1234ebeab5b3',
    availability: 'erased',
  };
  const page =
    variant === 'sparse' || variant === 'final'
      ? {
          ...loaded.threads,
          threads: [],
          next: variant === 'sparse' ? continuationCursor : null,
          rankRefreshedAt: null,
        }
      : variant === 'unavailable'
        ? { ...loaded.threads, threads: [opening, erased], next: null, rankRefreshedAt: null }
        : loaded.threads;
  const authors: CommunityBoardPage['authors'] =
    variant === 'unavailable'
      ? {}
      : variant === 'deleted-author'
        ? { [source.authorId]: { id: source.authorId, state: 'deleted', kind: 'actor' } }
        : loaded.authors;
  return (
    <main dir={direction} className="mx-auto min-w-0 max-w-4xl space-y-12 p-4 text-foreground sm:p-8">
      <BoardFeed
        boardId={loaded.board.id}
        sort={sort}
        page={page}
        authors={authors}
        now={now}
        actions={
          <Button variant="outline" onClick={action}>
            {actionLabel}
          </Button>
        }
      />
      {variant === 'multiple' ? (
        <>
          <BoardFeed boardId={loaded.board.id} sort="active" page={page} authors={authors} now={now} />
          <BoardFeed
            boardId={emptyBoardId}
            sort="new"
            page={{
              ...page,
              threads: page.threads.map((thread) => ({
                ...thread,
                boardId: emptyBoardId,
                firstPost: { ...thread.firstPost, boardId: emptyBoardId },
              })),
            }}
            authors={authors}
            now={now}
          />
        </>
      ) : null}
    </main>
  );
}

const meta = {
  title: 'Patterns/Community/Board Feed Interface',
  component: FeedExamples,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Actual BoardFeed and BoardSortNav with the existing router and recorded board/threads/accounts DTOs. Authored observations are UNRUN: phone390/desktop1280, en/zh-Hant/de, light/dark and RTL stress full supplied text, 44px controls, independent actions, local clipboard outcomes and own-heading associations. Native reads, privacy/lifetime, physical growth and full acceptance remain owed. Navigation exports reuse the existing actual-page plays without changing their fixtures or IDs.',
      },
    },
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
  args: { variant: 'populated', direction: 'ltr', sort: 'hot' },
  render: (args) => (
    <PatternStory>
      <FeedExamples {...args} />
    </PatternStory>
  ),
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    const feeds = await view.findAllByRole('region', { name: m.board_threads_heading() });
    await expect(feeds).toHaveLength(args.variant === 'multiple' ? 3 : 1);
    const ids: string[] = [];
    for (const [index, feed] of feeds.entries()) {
      const region = within(feed);
      const heading = region.getByRole('heading', { level: 2, name: m.board_threads_heading() });
      await expect(feed).toHaveAttribute('aria-labelledby', heading.id);
      await expect(heading.id).not.toBe('');
      await expect(canvasElement.ownerDocument.getElementById(heading.id)).toBe(heading);
      ids.push(heading.id);
      const nav = region.getByRole('navigation', { name: m.board_sort_label() });
      const sorts = within(nav).getAllByRole('link');
      await expect(sorts.map((link) => link.textContent)).toEqual([
        m.board_sort_active(),
        m.board_sort_hot(),
        m.board_sort_new(),
      ]);
      for (const [option, link] of sorts.entries()) {
        const url = new URL(link.getAttribute('href')!, window.location.origin);
        await expect(url.searchParams.has('cursor')).toBe(false);
        await expect(url.searchParams.get('sort')).toBe([null, 'hot', 'new'][option]);
      }
      const selected = index === 1 ? 'active' : index === 2 ? 'new' : args.sort;
      await expect(within(nav).getAllByRole('link', { current: 'page' })).toHaveLength(1);
      await expect(within(nav).getByRole('link', { current: 'page' })).toHaveTextContent(
        selected === 'hot' ? m.board_sort_hot() : selected === 'new' ? m.board_sort_new() : m.board_sort_active(),
      );
      const sparse = args.variant === 'sparse';
      const final = args.variant === 'final';
      if (sparse || final) {
        await expect(region.getByText(sparse ? m.board_threads_page_empty() : m.board_threads_empty())).toBeVisible();
        await expect(region.queryByText(sparse ? m.board_threads_empty() : m.board_threads_page_empty())).toBeNull();
        await expect(feed.querySelector('ul')).toBeNull();
      } else if (args.variant === 'unavailable') {
        await expect(region.getByText(m.board_feed_opening_unavailable())).toBeVisible();
        await expect(region.getByRole('heading', { level: 3, name: m.threads_untitled() })).toBeVisible();
        await expect(region.getByRole('heading', { level: 3, name: m.thread_post_deleted() })).toBeVisible();
        await expect(region.getByText(m.thread_author_unknown())).toBeVisible();
        await expect(region.queryByText('Flight notes Watch the baobabs')).toBeNull();
        await expect(region.queryByText(displayName)).toBeNull();
        const rows = region.getAllByRole('listitem');
        await expect(rows).toHaveLength(2);
        await expect(within(rows[0]!).getByText(m.board_feed_reactions({ count: reactions }))).toBeVisible();
        await expect(
          within(rows[0]!).getByRole('link', {
            name: `${m.feed_action_reply()} ${new Intl.NumberFormat(getLocale()).format(replies)}`,
          }),
        ).toBeVisible();
        await expect(rows[0]!.querySelector(`time[datetime="${lastActivityAt}"]`)).toBeVisible();
        await expect(within(rows[1]!).queryByText(m.board_feed_reactions({ count: reactions }))).toBeNull();
        await expect(within(rows[1]!).queryByText(m.board_feed_replies({ count: replies }))).toBeNull();
        await expect(rows[1]!.querySelector('time')).toBeNull();
        await expect(within(rows[1]!).queryByText(m.board_feed_opening_unavailable())).toBeNull();
      } else {
        const row = region.getByRole('listitem');
        const item = within(row);
        await expect(item.getByRole('heading', { level: 3, name: title })).toBeVisible();
        if (args.variant === 'deleted-author') {
          await expect(item.getByText(m.thread_author_deleted())).toBeVisible();
          await expect(item.queryByText(displayName)).toBeNull();
          await expect(item.queryByText(m.thread_author_unknown())).toBeNull();
          await expect(row.querySelector('a[href*="/@"]')).toBeNull();
        } else await expect(item.getByText(displayName)).toBeVisible();
        await expect(item.getByText(m.board_feed_reactions({ count: reactions }))).toBeVisible();
        await expect(
          item.getByRole('link', {
            name: `${m.feed_action_reply()} ${new Intl.NumberFormat(getLocale()).format(replies)}`,
          }),
        ).toBeVisible();
        await expect(row.querySelector(`time[datetime="${lastActivityAt}"]`)).toHaveAttribute(
          'title',
          fullDateTime(lastActivityAt, getLocale()),
        );
        const preview = item.getByText('Flight notes Watch the baobabs');
        await expect(getComputedStyle(preview).webkitLineClamp).toBe('2');
        await expect(getComputedStyle(item.getByRole('heading', { level: 3 })).webkitLineClamp).toBe('none');
        const byline = row.querySelector('.truncate')!;
        await expect(getComputedStyle(byline).whiteSpace).toBe('normal');
        await expect(getComputedStyle(byline).overflow).toBe('visible');
        await expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
      }
      const next = region.queryByRole('link', { name: m.threads_next_page() });
      if (final || args.variant === 'unavailable') await expect(next).toBeNull();
      else {
        await expect(next).toBeVisible();
        const url = new URL(next!.getAttribute('href')!, window.location.origin);
        await expect(url.searchParams.get('cursor')).toBe(continuationCursor);
        await expect(url.searchParams.get('sort')).toBe(selected === 'active' ? null : selected);
        await expect(url.pathname.endsWith(index === 2 ? emptyBoardId : board.board.id)).toBe(true);
      }
      const rank = feed.querySelector('details');
      if (final || sparse || args.variant === 'unavailable' || selected === 'new') await expect(rank).toBeNull();
      else await expect(rank?.querySelector('time')).toHaveAttribute('datetime', rankRefreshedAt);
      const controls = feed.querySelectorAll<HTMLElement>(
        'nav a, [data-content-item-slot="actions"] a, [data-content-item-slot="actions"] button, summary',
      );
      for (const control of controls) {
        await expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
        await expect(control.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
        await expect(control.scrollWidth).toBeLessThanOrEqual(control.clientWidth + 1);
      }
      await expect(feed.scrollWidth).toBeLessThanOrEqual(feed.clientWidth + 1);
    }
    await expect(new Set(ids).size).toBe(ids.length);
    const suppliedAction = view.getByRole('button', { name: actionLabel });
    await expect(suppliedAction.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await expect(getComputedStyle(suppliedAction).whiteSpace).toBe('normal');
    await expect(suppliedAction.scrollWidth).toBeLessThanOrEqual(suppliedAction.clientWidth + 1);
    const main = view.getByRole('main');
    await expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth + 1);
  },
} satisfies Meta<typeof FeedExamples>;
export default meta;
type Story = StoryObj<typeof meta>;

export const FullControlsPhone: Story = { globals: { locale: 'en', viewport: { value: 'phone390' } } };
export const LongGermanPhone: Story = { globals: { locale: 'de', viewport: { value: 'phone390' } } };
export const DarkGermanPhone: Story = {
  globals: { theme: 'dark', locale: 'de', viewport: { value: 'phone390' } },
};
export const TraditionalChineseRtl: Story = {
  args: { direction: 'rtl' },
  globals: { locale: 'zh-Hant', viewport: { value: 'phone390' } },
};
export const MultipleInstances: Story = {
  args: { variant: 'multiple' },
  globals: { locale: 'en', viewport: { value: 'desktop1280' } },
};
export const MultipleInstancesRtl: Story = {
  args: { variant: 'multiple', direction: 'rtl' },
  globals: { locale: 'zh-Hant', viewport: { value: 'phone390' } },
};
export const SparseContinuation: Story = {
  args: { variant: 'sparse', sort: 'active' },
  globals: { locale: 'en', viewport: { value: 'phone390' } },
};
export const FinalEmpty: Story = { args: { variant: 'final' } };
export const SuppliedUnavailable: Story = {
  args: { variant: 'unavailable' },
  globals: { locale: 'zh-Hant', viewport: { value: 'phone390' } },
};
export const DeletedAuthor: Story = {
  args: { variant: 'deleted-author' },
  globals: { locale: 'de', viewport: { value: 'phone390' } },
};
export const NewWithoutRankExplanation: Story = { args: { sort: 'new' } };
export const ExactCursorNavigation: Story = { ...continuation };
export const SortNavigation: Story = { ...sortNavigation };

function clipboardFixture(failed: boolean) {
  return () => {
    const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    action.mockClear();
    clipboardWrite.mockReset();
    clipboardWrite.mockImplementation(async () => {
      if (failed) throw new Error('Clipboard unavailable in this explicit local interaction fixture');
    });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboardWrite } });
    return () => {
      if (previous) Object.defineProperty(navigator, 'clipboard', previous);
      else Reflect.deleteProperty(navigator, 'clipboard');
    };
  };
}

function localControls(failed: boolean) {
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const view = within(canvasElement);
    const feed = await view.findByRole('region', { name: m.board_threads_heading() });
    const heading = within(feed).getByRole('heading', { level: 2 });
    const id = heading.id;
    const trigger = within(feed).getByRole('button', { name: m.thread_content_more_actions() });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    const sheet = window.matchMedia('(max-width: 767px)').matches || window.matchMedia('(pointer: coarse)').matches;
    const open = await screen.findByRole(sheet ? 'link' : 'menuitem', { name: m.board_feed_open_thread() });
    await expect(open).toHaveAttribute('href', threadLocation(getLocale(), { id: threadId, title }));
    await expect(
      await screen.findByRole(sheet ? 'button' : 'menuitem', { name: m.thread_content_copy_link() }),
    ).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await expect(trigger).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await userEvent.click(
      await screen.findByRole(sheet ? 'button' : 'menuitem', { name: m.thread_content_copy_link() }),
    );
    await expect(await within(feed).findByRole('status')).toHaveTextContent(
      failed ? m.board_feed_copy_failed() : m.board_feed_link_copied(),
    );
    await expect(clipboardWrite).toHaveBeenCalledTimes(1);
    await expect(clipboardWrite).toHaveBeenCalledWith(
      new URL(threadLocation(getLocale(), { id: threadId, title }), window.location.origin).href,
    );
    await expect(trigger).toHaveFocus();
    await expect(within(feed).getByRole('heading', { level: 2 })).toHaveAttribute('id', id);
    await expect(feed).toHaveAttribute('aria-labelledby', id);
    const status = within(feed).getByRole('status');
    await expect(status.scrollWidth).toBeLessThanOrEqual(status.clientWidth + 1);
    const summary = within(feed).getByText(m.board_feed_order_help()).closest('summary')!;
    summary.focus();
    await userEvent.keyboard(' ');
    await expect(summary.parentElement).toHaveAttribute('open');
    await expect(summary.querySelector('time')).toHaveAttribute('datetime', rankRefreshedAt);
    await expect(summary.querySelector('time')).toHaveAttribute('title', fullDateTime(rankRefreshedAt, getLocale()));
    await expect(summary.parentElement?.querySelector('p')).toBeVisible();
    await userEvent.keyboard(' ');
    await expect(summary.parentElement).not.toHaveAttribute('open');
    await userEvent.click(view.getByRole('button', { name: actionLabel }));
    await expect(action).toHaveBeenCalledTimes(1);
  };
}

export const CopyAndManualControls: Story = {
  globals: { locale: 'en', viewport: { value: 'phone390' } },
  beforeEach: clipboardFixture(false),
  play: localControls(false),
};
export const ClipboardUnavailable: Story = {
  args: { direction: 'rtl' },
  globals: { locale: 'zh-Hant', viewport: { value: 'desktop1280' } },
  beforeEach: clipboardFixture(true),
  play: localControls(true),
};
export const ClipboardUnavailableRtlPhone: Story = {
  ...ClipboardUnavailable,
  globals: { theme: 'dark', locale: 'zh-Hant', viewport: { value: 'phone390' } },
};
