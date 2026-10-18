import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { AppShell } from '../shell/app-shell.tsx';
import { messages as shell } from '../shell/messages.ts';
import { libraryState, memoryLibraryApi, readingRows, storyNow, storyOverview, storyReaderActions, storyView } from './fixtures.ts';
import { LibraryPage } from './library-page.tsx';
import { messages } from './messages.ts';

const state = libraryState();
const rows = readingRows.slice(0, 2);
const meta = {
  title: 'Library/Reading first', component: LibraryPage,
  args: { state, overview: { ok: true, data: storyOverview(rows) }, view: { ok: true, data: storyView(state, rows) },
    reading: rows, now: storyNow, locale: 'en', messages,
    goal: { ok: true, data: { year: 2026, target: 12, completed: 0, version: 1, changedAt: '2026-09-28T00:00:00Z' } },
    stats: { ok: true, data: { year: 2026, books: 0, chapters: 9, detailsAvailability: 'complete',
      averageRating: null, ratedBooks: 0, knownChapters: 0, booksWithChapters: 0, topConcepts: [], titleLanguages: [],
      months: Array.from({ length: 12 }, (_, index) => ({ month: index + 1, books: 0, chapters: index === 8 ? 9 : 0 })) } },
  },
  render: args => <AppShell locale="en" messages={shell} theme="light" navCollapsed={false} signedIn
    account={<span className="text-sm">Reader</span>}>
    <LibraryPage {...args} api={memoryLibraryApi()} readerActions={storyReaderActions(rows)}
      saveGoal={async (_agent, year, target, version) => ({ ok: true,
        data: { year, target, version: version + 1, completed: 0, changedAt: '2026-09-28T00:00:00Z' } })} />
  </AppShell>,
  parameters: { route: { pathname: '/en/library' } },
  globals: { viewport: { value: 'desktop1440' } },
} satisfies Meta<typeof LibraryPage>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The real shell contributes both the fixed header and the phone's bottom navigation. */
async function expectReadingInFirstScreen(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const reading = canvas.getByRole('region', { name: 'Currently reading' });
  const first = within(reading).getAllByRole('link', { name: /^Continue/ })[0]!;
  const title = within(reading).getAllByRole('heading', { level: 3 })[0]!;
  await document.fonts.ready;
  window.scrollTo(0, 0);
  await waitFor(() => {
    const headerBottom = canvasElement.querySelector('header')!.getBoundingClientRect().bottom;
    const fixedNav = [...canvasElement.querySelectorAll('nav')]
      .find(nav => getComputedStyle(nav).position === 'fixed');
    const bottom = fixedNav?.getBoundingClientRect().top ?? window.innerHeight;
    for (const item of [title, first]) {
      const box = item.getBoundingClientRect();
      expect(box.top).toBeGreaterThanOrEqual(headerBottom);
      expect(box.bottom).toBeLessThanOrEqual(bottom);
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(window.innerWidth);
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  });
  await expect(first).toHaveAttribute('href', `/en${rows[0]!.progress!.next!.href}`);
  await expect(canvas.queryByRole('heading', { name: 'Reading in 2026' })).toBeNull();
  await expect(canvas.getByText(messages.libraryTools, { selector: 'summary' }).closest('details'))
    .not.toHaveAttribute('open');
}

export const InProgress: Story = { async play({ canvasElement }) { await expectReadingInFirstScreen(canvasElement); } };
export const InProgressPhone: Story = { ...InProgress, globals: { viewport: { value: 'phone' } } };

export const ToolsByKeyboard: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const tools = canvas.getByText(messages.libraryTools, { selector: 'summary' });
    tools.focus();
    await expect(tools).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByRole('heading', { name: 'Reading in 2026' })).toBeVisible();
    await expect(canvas.getByText('9 chapters completed')).toBeVisible();
    await expect(canvas.getByRole('list', { name: 'Reading in 2026' }).children).toHaveLength(12);
    await userEvent.click(canvas.getByRole('button', { name: 'Edit goal' }));
    await userEvent.clear(canvas.getByLabelText('Books to read'));
    await userEvent.type(canvas.getByLabelText('Books to read'), '20');
    await userEvent.click(canvas.getByRole('button', { name: 'Save' }));
    await expect(await canvas.findByText('0 of 20 books')).toBeVisible();
    await userEvent.click(canvas.getByRole('heading', { name: 'Import your books' }));
    await expect(canvas.getByLabelText('Library file')).toBeEnabled();
    await userEvent.click(canvas.getByRole('heading', { name: 'Download your library' }));
    await expect(canvas.getByRole('button', { name: 'Download library' })).toBeVisible();
  },
};

export const EmptyLibrary: Story = {
  args: { overview: { ok: true, data: storyOverview([], { customShelves: [] }) },
    view: { ok: true, data: storyView(state, []) }, reading: [] },
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const discover = canvas.getByRole('link', { name: 'Discover works' });
    const tools = canvas.getByText(messages.libraryTools, { selector: 'summary' });
    await expect(discover.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await expect(canvas.queryByRole('region', { name: 'Currently reading' })).toBeNull();
    await userEvent.click(tools);
    await expect(canvas.getByRole('heading', { name: 'Import your books' })).toBeVisible();
  },
};
