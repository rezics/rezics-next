import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import recording from '../kernel/recorded/board.json';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/shell';
import { BoardDirectory } from '../threads/board-directory-view';
import {
  boardDirectoryPrevious,
  loadBoardDirectory,
  type BoardDirectoryRequest,
  type BoardDirectoryState,
  type BoardDirectoryPrevious,
  type DirectoryBoard,
} from '../threads/board-directory';
import { PageStory, PatternStory } from './page';

const board: DirectoryBoard = {
  ...recording.board,
  purpose: 'discussion',
  visibility: 'published',
  availability: 'available',
};
const cursor = 'directory:next/+opaque=';
type Scenario = 'current' | 'select' | 'sparse' | 'empty' | 'loading' | 'unavailable' | 'denied' | 'closed';

/** Only story-local responses. The displayed board is the committed native board recording. */
export function DirectoryExample({ scenario = 'current', page = false }: { scenario?: Scenario; page?: boolean }) {
  const [request, setRequest] = useState<BoardDirectoryRequest>({
    purpose: scenario === 'select' ? 'reviews' : 'discussion',
    limit: 20,
  });
  const [result, setResult] = useState<BoardDirectoryState>(() =>
    scenario === 'current'
      ? { state: 'ready', boards: [board], next: null }
      : scenario === 'sparse'
        ? { state: 'ready', boards: [], next: cursor }
        : scenario === 'empty' || scenario === 'select'
          ? { state: 'ready', boards: [], next: null }
          : { state: scenario },
  );
  const [previous, setPrevious] = useState<BoardDirectoryPrevious>();
  const [opened, setOpened] = useState(false);
  if (opened) return <PageStory visitor="Signed Out" path={`/boards/${board.id}`} />;
  const read = async (destination: BoardDirectoryRequest) => {
    setResult({ state: 'loading' });
    setResult(
      await loadBoardDirectory(destination, async (query) => ({
        state: 'ready',
        boards: query.purpose === 'discussion' && query.cursor ? [board] : [],
        next: query.purpose === 'discussion' && !query.cursor ? cursor : null,
      })),
    );
  };
  const content = (
    <div
      onClickCapture={(event) => {
        if (!(event.target instanceof Element)) return;
        const link = event.target.closest('a');
        if (link?.getAttribute('href') === `/${getLocale()}/boards/${board.id}`) {
          event.preventDefault();
          setOpened(true);
        }
      }}
    >
      <BoardDirectory
        request={request}
        result={result}
        {...(previous ? { previous } : {})}
        onNavigate={(destination) => {
          setPrevious(result.state === 'loading' ? undefined : boardDirectoryPrevious(request, result, destination));
          setRequest(destination);
          void read(destination);
        }}
        onRetry={() => {
          void read(request);
        }}
      />
    </div>
  );
  return (
    <PatternStory path="/boards">
      {page ? <AppShell>{content}</AppShell> : <div className="p-4 sm:p-6">{content}</div>}
    </PatternStory>
  );
}

const meta = {
  title: 'Patterns/Community/Board Directory',
  component: DirectoryExample,
  excludeStories: ['DirectoryExample'],
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Global board choice reuses native BoardView names and metadata and the existing board destination. One page is requested per action; sparse pages retain the opaque continuation. Purpose resets the cursor, Previous remembers one followed continuation, and Retry preserves the query. Loading, unavailable, denied and closed render no stale rows. Listing never grants creation. DTO-shaped page fixtures are story-local; the runtime default is unavailable pending native client delivery. Use the same IDs with phone390/desktop1280 viewport and locale/theme globals.',
      },
    },
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
} satisfies Meta<typeof DirectoryExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Current: Story = {};
export const SelectPurpose: Story = {
  args: { scenario: 'select' },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByRole('link', { name: m.board_directory_reviews() })).toHaveAttribute('aria-current', 'page');
    await userEvent.click(view.getByRole('link', { name: m.board_directory_discussion() }));
    await expect(await view.findByText(m.board_directory_sparse())).toBeVisible();
    await expect(view.getByRole('link', { name: m.board_directory_discussion() })).toHaveAttribute(
      'aria-current',
      'page',
    );
  },
};
export const Continue: Story = {
  args: { scenario: 'sparse' },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const next = view.getByRole('link', { name: m.board_directory_next() });
    await expect(new URL(next.getAttribute('href')!, window.location.origin).searchParams.get('cursor')).toBe(cursor);
    next.focus();
    await userEvent.keyboard('{Enter}');
    await expect(
      await view.findByRole('link', { name: m.board_directory_open_named({ title: board.title! }) }),
    ).toHaveAttribute('href', `/${getLocale()}/boards/${board.id}`);
    await expect(view.queryByRole('link', { name: m.board_directory_next() })).toBeNull();
    await userEvent.click(view.getByRole('link', { name: m.board_directory_previous() }));
    await expect(await view.findByText(m.board_directory_sparse())).toBeVisible();
  },
};
export const Open: Story = {
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const open = view.getByRole('link', { name: m.board_directory_open_named({ title: board.title! }) });
    await expect(open).toHaveAttribute('href', `/${getLocale()}/boards/${board.id}`);
    await userEvent.click(open);
    await expect(await view.findByRole('heading', { level: 1, name: board.title! })).toBeVisible();
    await expect(await view.findByRole('heading', { name: m.board_threads_heading() })).toBeVisible();
  },
};
export const Retry: Story = {
  args: { scenario: 'unavailable' },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.board_directory_retry() }));
    await expect(await view.findByText(m.board_directory_sparse())).toBeVisible();
    await expect(view.queryByText(m.board_directory_empty())).toBeNull();
  },
};
export const Loading: Story = { args: { scenario: 'loading' } };
export const Empty: Story = { args: { scenario: 'empty' } };
export const Sparse: Story = { args: { scenario: 'sparse' } };
export const Unavailable: Story = { args: { scenario: 'unavailable' } };
export const Denied: Story = { args: { scenario: 'denied' } };
export const Closed: Story = { args: { scenario: 'closed' } };
