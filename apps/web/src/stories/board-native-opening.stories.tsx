import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import { expect, userEvent, within } from 'storybook/test';
import { loadBoardPageWithAuthors } from '../identity/page-loaders';
import { BoardCommunity, BoardCommunityStatus } from '../threads/board-community';
import { BoardParticipation, BoardStartThread } from '../threads/board-community-actions';
import { boardOpeningExample, boardOpeningId, type BoardOpeningExample } from '../threads/board-opening-fixtures';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { PatternStory } from './page';

type State = BoardOpeningExample | 'restart' | 'unavailable';
function Opening({ state }: { state: State }) {
  const locale = getLocale();
  const client = useMemo(
    () =>
      createKernelClient('https://board-opening.test', {
        fetch: Object.assign(
          async () =>
            state === 'restart'
              ? Response.json({ code: 'invalid_cursor' }, { status: 400 })
              : state === 'unavailable'
                ? Response.json({ code: 'dependency_unavailable' }, { status: 503 })
                : Response.json(boardOpeningExample(state)),
          { preconnect() {} },
        ),
      }),
    [state],
  );
  const query = useQuery({
    queryKey: ['board-opening-example', state, locale],
    retry: false,
    queryFn: () =>
      loadBoardPageWithAuthors(client, {
        id: boardOpeningId,
        sort: 'hot',
        ...(state === 'restart' ? { cursor: 'obsolete-pin-cohort' } : {}),
      }),
  });
  if (query.isPending) return <BoardCommunityStatus state="loading" />;
  if (query.isError)
    return (
      <BoardCommunityStatus
        state={state === 'restart' ? 'restart' : 'error'}
        restart={{ boardId: boardOpeningId, sort: 'hot' }}
        onRetry={() => void query.refetch()}
      />
    );
  return (
    <BoardCommunity
      page={query.data}
      sort="hot"
      participation={(page) => (
        <BoardParticipation community={page.community} returnTo={`/${locale}/boards/${boardOpeningId}`} />
      )}
      start={(page) => (
        <BoardStartThread
          board={page.board}
          advice={page.actions.createThread}
          viewer={page.viewer}
          returnTo={`/${locale}/boards/${boardOpeningId}`}
        />
      )}
    />
  );
}
function Example({ state = 'current' }: { state?: State }) {
  return (
    <PatternStory>
      <div className="mx-auto max-w-6xl p-4">
        <Opening state={state} />
      </div>
    </PatternStory>
  );
}
const meta = {
  title: 'Community/Board native opening',
  id: 'pages-community-board-native-opening',
  component: Example,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

export const CurrentOpening: Story = {
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByRole('heading', { level: 1, name: 'Reading room' });
    await expect(canvasElement.querySelectorAll('[data-thread-id]')).toHaveLength(25);
    await userEvent.tab();
  },
};
export const ConcealedOptionalContext: Story = { args: { state: 'concealed' } };
export const ZeroAndUnknownInteractions: Story = { args: { state: 'interactions' } };
export const SparseContinuation: Story = { args: { state: 'sparse' } };
export const InvalidCursorRestart: Story = {
  args: { state: 'restart' },
  play: async ({ canvasElement }) => {
    const restart = await within(canvasElement).findByRole('link', { name: m.board_reading_restart() });
    await expect(restart).toHaveAttribute('href', `/${getLocale()}/boards/${boardOpeningId}?sort=hot`);
    restart.focus();
    await expect(restart).toHaveFocus();
  },
};
export const DeniedActions: Story = { args: { state: 'denied' } };
export const UnavailableRetry: Story = {
  args: { state: 'unavailable' },
  play: async ({ canvasElement }) => {
    const retry = await within(canvasElement).findByRole('button', { name: m.board_community_retry() });
    retry.focus();
    await userEvent.keyboard('{Enter}');
    await expect(await within(canvasElement).findByRole('button', { name: m.board_community_retry() })).toBeVisible();
  },
};
