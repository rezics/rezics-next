import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useMemo, useRef } from 'react';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { BoardCommunity } from '../threads/board-community';
import { BoardWatchControl, type BoardWatchSession } from '../threads/board-watch/control';
import type { BoardWatchNative, BoardWatchPage } from '../threads/board-watch/contract';
import type { BoardWatchVisitBinding } from '../threads/board-watch/visit';
import { receiveBoardOpeningPage } from '../threads/board-opening';
import { boardOpeningExample } from '../threads/board-opening-fixtures';
import { PatternStory } from './page';

type State = 'long-title' | 'watching' | 'unwatched' | 'pending' | 'unknown' | 'stale' | 'signed-out';
type Viewport = 'phone390' | 'desktop1280';
const longTitle = 'A very long Board title that wraps cleanly beside its watch controls on a narrow screen';
const pageBase = receiveBoardOpeningPage(boardOpeningExample());
const boardId = pageBase.board.id;
const accountId = 'board-watch-reader';

const meta = {
  title: 'Community/Board watch',
  id: 'pages-community-board-watch',
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: '390 × 844', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: '1280 × 900', styles: { width: '1280px', height: '900px' } },
      },
    },
    docs: {
      description: {
        component:
          'The real Board community renderer with a recorded page and explicit watch-control states. Use the same states at phone 390 and desktop 1280; buttons expose their visible action names to keyboard and assistive technology.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function watchPage(watching: boolean, advice: 'available' | 'denied' = 'available'): BoardWatchPage {
  return Object.freeze({
    boardId,
    accountId,
    viewer: Object.freeze({ state: 'current' as const, watching, revision: watching ? 4 : 3 }),
    actions: Object.freeze({
      watch: watching ? ('not-applicable' as const) : advice,
      unwatch: watching ? advice : ('not-applicable' as const),
    }),
    source: Object.freeze({ epoch: 1, position: '38' }),
  });
}

function Preview({ state }: { state: State }) {
  const commands = useRef<unknown[]>([]);
  const session: BoardWatchSession =
    state === 'signed-out'
      ? { state: 'signed-out', subject: null, csrfToken: null }
      : { state: 'signed-in', subject: accountId, csrfToken: 'story-csrf' };
  const authority = useMemo<Pick<BoardWatchVisitBinding, 'authorityKey' | 'isCurrent'>>(
    () => ({ authorityKey: 'board-watch-story-visit', isCurrent: () => true }),
    [],
  );
  const native = useMemo<BoardWatchNative>(
    () => ({
      async read() {
        if (state === 'stale') return { kind: 'conflict' };
        return { kind: 'current', page: watchPage(state === 'watching') };
      },
      async set(command) {
        commands.current.push(command);
        if (state === 'pending') return new Promise(() => {});
        if (state === 'unknown') return { kind: 'unknown' };
        return { kind: 'acknowledged', watching: command.watching, revision: command.expectedRevision + 1 };
      },
    }),
    [state],
  );
  const title = state === 'long-title' ? longTitle : pageBase.board.title;
  const page = { ...pageBase, board: { ...pageBase.board, title } };
  const watch = (
    <BoardWatchControl
      boardId={boardId}
      returnTo={`/en/boards/${boardId}?sort=new`}
      session={session}
      authority={{ key: authority.authorityKey, isCurrent: authority.isCurrent }}
      native={native}
    />
  );
  return (
    <PatternStory visitor={state === 'signed-out' ? 'Signed Out' : 'Signed In'} path={`/boards/${boardId}`}>
      <AppShell>
        <BoardCommunity page={page} sort="active" watch={watch} />
      </AppShell>
    </PatternStory>
  );
}

function story(state: State, viewport: Viewport): Story {
  return {
    globals: {},
    render: () => <Preview state={state} />,
    play: async ({ canvasElement }) => {
      const canvas = within(canvasElement);
      const start = m.board_watch_start();
      const stop = m.board_watch_stop();
      if (state === 'signed-out') {
        await expect(await canvas.findByRole('link', { name: m.board_watch_sign_in() })).toHaveAttribute(
          'href',
          `/auth/sign-in?return_to=${encodeURIComponent(`/en/boards/${boardId}?sort=new`)}`,
        );
        return;
      }
      if (state === 'long-title') await canvas.findByRole('heading', { name: longTitle });
      if (state === 'stale') {
        const inspect = await canvas.findByRole('button', { name: m.board_watch_check_again() });
        inspect.focus();
        await expect(inspect).toHaveFocus();
        return;
      }
      if (state === 'watching' || state === 'unwatched' || state === 'long-title') {
        const button = await canvas.findByRole('button', { name: state === 'watching' ? stop : start });
        button.focus();
        await expect(button).toHaveFocus();
        return;
      }
      const action = await canvas.findByRole('button', { name: start });
      action.focus();
      await expect(action).toHaveFocus();
      await userEvent.keyboard('{Enter}');
      if (state === 'pending') {
        await canvas.findByText(m.board_watch_sending());
      } else {
        await canvas.findByRole('button', { name: m.board_watch_retry_exact() });
        await canvas.findByRole('button', { name: m.board_watch_check_again() });
      }
    },
  };
}

export const LongTitle390 = story('long-title', 'phone390');
export const LongTitle1280 = story('long-title', 'desktop1280');
export const Watching390 = story('watching', 'phone390');
export const Watching1280 = story('watching', 'desktop1280');
export const Unwatched390 = story('unwatched', 'phone390');
export const Unwatched1280 = story('unwatched', 'desktop1280');
export const Pending390 = story('pending', 'phone390');
export const Pending1280 = story('pending', 'desktop1280');
export const Unknown390 = story('unknown', 'phone390');
export const Unknown1280 = story('unknown', 'desktop1280');
export const Stale390 = story('stale', 'phone390');
export const Stale1280 = story('stale', 'desktop1280');
export const SignedOut390 = story('signed-out', 'phone390');
export const SignedOut1280 = story('signed-out', 'desktop1280');
