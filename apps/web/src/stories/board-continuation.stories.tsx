import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { continuationBoardId, continuationCursor, emptyBoardId, rankRefreshedAt } from '../kernel/fake/board-continuation';
import threads from '../kernel/recorded/board-threads.json';
import { m } from '../paraglide/messages.js';
import { BoardThreads } from '../threads/board-continuation';
import { PageStory } from './page';

const meta = {
  title: 'Patterns/Community/Board Continuation',
  component: BoardThreads,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    docs: { description: { component: 'The board page reuses this bounded list pattern. Empty pages retain Next until the returned continuation is null. Ranking shows only a returned refresh time. Plays traverse the real page route using isolated recorded-response variants; native authorization and signing remain integration evidence.' } },
    viewport: { options: {
      phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
      desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
    } },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj;

function example(sort = '') {
  return <PageStory visitor="Signed Out" path={`/boards/${continuationBoardId}${sort ? `?sort=${sort}` : ''}`} />;
}

export const EmptyPage: Story = {
  render: () => example(),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByText(m.board_threads_page_empty());
    await expect(view.queryByText(m.board_threads_empty())).toBeNull();
    await expect(view.getByRole('link', { name: m.threads_next_page() })).toBeVisible();
  },
};

function continuePage(sort: 'active' | 'hot' | 'new') {
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const view = within(canvasElement);
    await view.findByText(m.board_threads_page_empty());
    const next = view.getByRole('link', { name: m.threads_next_page() });
    const target = new URL(next.getAttribute('href')!, window.location.origin);
    await expect(target.searchParams.get('cursor')).toBe(continuationCursor);
    await expect(target.searchParams.get('sort')).toBe(sort === 'active' ? null : sort);
    for (let step = 0; step < 20 && document.activeElement !== next; step += 1) await userEvent.tab();
    await expect(next).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await view.findByRole('link', { name: threads.threads[0]!.title });
    const nav = view.getByRole('navigation', { name: m.board_sort_label() });
    const label = sort === 'active' ? m.board_sort_active() : sort === 'hot' ? m.board_sort_hot() : m.board_sort_new();
    await expect(within(nav).getByRole('link', { name: label })).toHaveAttribute('aria-current', 'page');
    await expect(view.queryByText(m.board_threads_page_empty())).toBeNull();
    await expect(view.queryByRole('link', { name: m.threads_next_page() })).toBeNull();
    const freshness = canvasElement.querySelector(`time[datetime="${rankRefreshedAt}"]`);
    if (sort === 'new') await expect(freshness).toBeNull();
    else await expect(freshness).toBeVisible();
  };
}

export const ContinueActive: Story = { render: () => example(), play: continuePage('active') };
export const ContinueHot: Story = { render: () => example('hot'), play: continuePage('hot') };
export const ContinueNewest: Story = { render: () => example('new'), play: continuePage('new') };
export const TerminalEmpty: Story = {
  render: () => <PageStory visitor="Signed Out" path={`/boards/${emptyBoardId}`} />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByText(m.board_threads_empty());
    await expect(view.queryByRole('link', { name: m.threads_next_page() })).toBeNull();
  },
};
