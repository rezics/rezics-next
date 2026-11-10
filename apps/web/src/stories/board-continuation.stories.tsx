import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import {
  continuationBoardId,
  continuationCursor,
  emptyBoardId,
  rankRefreshedAt,
} from '../kernel/fake/board-continuation';
import threads from '../kernel/recorded/board-threads.json';
import { m } from '../paraglide/messages.js';
import { BoardThreads } from '../threads/board-continuation';
import { PageStory } from './page';

const meta = {
  title: 'Community/Board Continuation Workflow',
  id: 'patterns-community-board-continuation',
  component: BoardThreads,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The board page reuses this bounded list pattern. Empty pages retain Next until the returned continuation is null. Ranking shows only a returned refresh time. Plays traverse the real page route using isolated recorded-response variants; native authorization and signing remain integration evidence.',
      },
    },
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj;

export const EmptyPage: Story = {
  render: () => <PageStory visitor="Signed Out" path={`/boards/${continuationBoardId}`} />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByText(m.board_threads_page_empty());
    await expect(view.queryByText(m.board_threads_empty())).toBeNull();
    await expect(view.getByRole('link', { name: m.threads_next_page() })).toBeVisible();
  },
};

export const ContinueHot: Story = {
  render: () => <PageStory visitor="Signed Out" path={`/boards/${continuationBoardId}?sort=hot`} />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByText(m.board_threads_page_empty());
    const next = view.getByRole('link', { name: m.threads_next_page() });
    const target = new URL(next.getAttribute('href')!, window.location.origin);
    await expect(target.searchParams.get('cursor')).toBe(continuationCursor);
    await expect(target.searchParams.get('sort')).toBe('hot');
    for (let step = 0; step < 40 && document.activeElement !== next; step += 1) await userEvent.tab();
    await expect(next).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await view.findByRole('link', { name: threads.threads[0]!.title });
    const nav = view.getByRole('navigation', { name: m.board_sort_label() });
    await expect(within(nav).getByRole('link', { name: m.board_sort_hot() })).toHaveAttribute('aria-current', 'page');
    await expect(view.queryByText(m.board_threads_page_empty())).toBeNull();
    await expect(view.queryByRole('link', { name: m.threads_next_page() })).toBeNull();
    await expect(canvasElement.querySelector(`time[datetime="${rankRefreshedAt}"]`)).toBeVisible();
  },
};
export const TerminalEmpty: Story = {
  render: () => <PageStory visitor="Signed Out" path={`/boards/${emptyBoardId}`} />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByText(m.board_threads_empty());
    await expect(view.queryByRole('link', { name: m.threads_next_page() })).toBeNull();
  },
};
