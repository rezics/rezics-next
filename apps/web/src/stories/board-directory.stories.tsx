import { useEffect, useState } from 'react';
import { createKernelClient } from '@rezics/client';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import recording from '../kernel/recorded/board.json';
import { createStoryRecordedKernelFetch } from '../kernel/fake';
import { communitySubject } from '../kernel/fake/subject-community';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/shell';
import { BoardDirectory } from '../threads/board-directory-view';
import {
  boardDirectoryPrevious,
  boardContribution,
  boardDirectoryHref,
  boardDirectoryRequest,
  createNativeBoardDirectoryAdapter,
  loadBoardDirectory,
  type BoardDirectoryRequest,
  type BoardDirectoryState,
  type BoardDirectoryPrevious,
  type DirectoryBoard,
  type BoardDirectorySearch,
  type BoardContribution,
} from '../threads/board-directory';
import { PageStory, PatternStory } from './page';

const board: DirectoryBoard = {
  ...recording.board,
  community: null,
  purpose: 'discussion',
  visibility: 'published',
  availability: 'available',
};
const cursor = 'directory:next/+opaque=';
type Scenario = 'current' | 'select' | 'sparse' | 'empty' | 'loading' | 'unavailable' | 'denied' | 'closed';

/** Initial states are illustrative. Navigation uses the existing native adapter; absent recordings stay unavailable. */
export function DirectoryExample({
  scenario = 'current',
  page = false,
  initialSearch,
  contribution: presetContribution,
}: {
  scenario?: Scenario;
  page?: boolean;
  initialSearch?: BoardDirectorySearch;
  contribution?: BoardContribution;
}) {
  const contribution = boardContribution(
    initialSearch ??
      presetContribution ??
      (scenario === 'select' || scenario === 'sparse' || scenario === 'unavailable'
        ? { subject: communitySubject.id, subjectTitle: communitySubject.label }
        : {}),
  );
  const [request, setRequest] = useState<BoardDirectoryRequest>(() =>
    boardDirectoryRequest(
      initialSearch ?? {
        purpose: scenario === 'select' ? 'reviews' : 'discussion',
      },
    ),
  );
  const [result, setResult] = useState<BoardDirectoryState>(() =>
    initialSearch
      ? { state: 'loading' }
      : scenario === 'current'
        ? { state: 'ready', boards: [board], next: null }
        : scenario === 'sparse'
          ? { state: 'ready', boards: [], next: cursor }
          : scenario === 'empty' || scenario === 'select'
            ? { state: 'ready', boards: [], next: null }
            : { state: scenario },
  );
  const [previous, setPrevious] = useState<BoardDirectoryPrevious>();
  const [opened, setOpened] = useState(false);
  const [composer, setComposer] = useState<string>();
  const read = async (destination: BoardDirectoryRequest) => {
    setResult({ state: 'loading' });
    setResult(
      await loadBoardDirectory(
        destination,
        createNativeBoardDirectoryAdapter(
          createKernelClient('https://kernel.invalid', {
            fetch: createStoryRecordedKernelFetch(),
          }),
        ),
      ),
    );
  };
  useEffect(() => {
    if (initialSearch) void read(boardDirectoryRequest(initialSearch));
  }, [initialSearch]);
  if (opened) return <PageStory visitor="Signed Out" path={`/boards/${board.id}`} />;
  if (composer) return <PageStory visitor="Signed Out" path={composer} />;
  const content = (
    <div
      onClickCapture={(event) => {
        if (!(event.target instanceof Element)) return;
        const link = event.target.closest('a');
        if (link?.getAttribute('href') === `/${getLocale()}/boards/${board.id}`) {
          event.preventDefault();
          setOpened(true);
        } else if (link?.pathname.endsWith('/new')) {
          event.preventDefault();
          setComposer(link.pathname.replace(`/${getLocale()}`, '') + link.search);
        }
      }}
    >
      <BoardDirectory
        request={request}
        {...(contribution ? { contribution } : {})}
        result={result}
        {...(previous ? { previous } : {})}
        onNavigate={(destination) => {
          setPrevious(
            result.state === 'loading' ? undefined : boardDirectoryPrevious(request, result, destination, contribution),
          );
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
    <PatternStory path={boardDirectoryHref(request, getLocale(), contribution).replace(`/${getLocale()}`, '')}>
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
          'Ready boards use shared ContentItem rows with level-two titles and supplied global, purpose and access metadata. The primary title opens the board; its independent action opens, discusses or reviews it. Global board choice uses the default directory and existing composer destinations. Subject presets survive purpose, cursor and retry navigation. One native page is requested per action; listing never grants creation. Initial DTO states and the recorded board are illustrative. Navigation uses the native adapter with existing recordings; an absent collection response remains unavailable. No successful native listing or permission is implied.',
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

export const Current: Story = {
  args: { contribution: { subject: communitySubject.id, subjectTitle: communitySubject.label } },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const write = view.getByRole('link', {
      name: m.board_directory_discuss_named({ title: board.title!, subject: communitySubject.label }),
    });
    const url = new URL(write.getAttribute('href')!, window.location.origin);
    await expect(url.pathname).toBe(`/${getLocale()}/boards/${board.id}/new`);
    await expect(url.searchParams.get('subject')).toBe(communitySubject.id);
    await expect(url.searchParams.get('subjectTitle')).toBe(communitySubject.label);
  },
};
export const SelectPurpose: Story = {
  args: { scenario: 'select' },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByRole('link', { name: m.board_directory_reviews() })).toHaveAttribute('aria-current', 'page');
    await userEvent.click(view.getByRole('link', { name: m.board_directory_discussion() }));
    await expect(await view.findByText(m.board_directory_unavailable())).toBeVisible();
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
    await expect(await view.findByText(m.board_directory_unavailable())).toBeVisible();
    await expect(view.queryByRole('link', { name: m.board_directory_next() })).toBeNull();
    await expect(view.queryByText(m.board_directory_empty())).toBeNull();
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
    await expect(await view.findByText(m.board_directory_unavailable())).toBeVisible();
    await expect(view.queryByText(m.board_directory_empty())).toBeNull();
  },
};
export const Loading: Story = { args: { scenario: 'loading' } };
export const Empty: Story = { args: { scenario: 'empty' } };
export const Sparse: Story = { args: { scenario: 'sparse' } };
export const Unavailable: Story = { args: { scenario: 'unavailable' } };
export const Denied: Story = { args: { scenario: 'denied' } };
export const Closed: Story = { args: { scenario: 'closed' } };
