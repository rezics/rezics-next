import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import {
  progressLogsStoryCursors as cursors,
  progressLogsStoryNote,
  setLibraryProgressLogsStory,
  type LibraryProgressLogsStory,
} from '../kernel/fake/library-progress-logs-story';
import logsRecording from '../kernel/recorded/library-published-logs.json';
import { m } from '../paraglide/messages.js';
import { PageStory, pagePaths, pageReady } from './page';

// UNRUN: actual-route log-region composition. Native, visual and authority proof remain deferred.
const meta = {
  title: 'Pages/Library/Progress log reader',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Actual `/library/progress/$id` PageStory and readProgressDetail composition for published-log reader states. Bounded `/v1/publishedLogs` pages reuse recorded public snapshot fields for this story account and cursor; they are constructed presentation examples. Viewer logs stay account-scoped, not session-filtered. Restart uses the installed newest-page retry while the URL keeps the stale logs cursor and unrelated changes/units; the list adds no restart banner. Supplemental Patterns/Library/Progress Log Reader Recovery exports stay. Canonical capture IDs remain unresolved.',
      },
    },
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' }, type: 'desktop' },
      },
    },
  },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  beforeEach() {
    setLibraryProgressLogsStory();
    return () => setLibraryProgressLogsStory();
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const sessionPath = pagePaths['library-progress-session'];
const sessionId = sessionPath.slice('/library/progress/'.length);
const retained = { changes: cursors.changes, units: cursors.units };

function path(logs?: string) {
  return `${sessionPath}?${new URLSearchParams({ ...retained, ...(logs ? { logs } : {}) })}`;
}

function scenario(value: LibraryProgressLogsStory, logs?: string) {
  return {
    beforeEach: () => setLibraryProgressLogsStory(value),
    render: () => <PageStory visitor="Signed In" path={path(logs)} />,
  };
}

async function logsRegion(canvasElement: HTMLElement) {
  await pageReady({ canvasElement });
  return within(await within(canvasElement).findByRole('region', { name: m.library_logs_heading() }));
}

function searchOf(link: HTMLElement) {
  return Object.fromEntries(new URL(link.getAttribute('href')!, document.baseURI).searchParams);
}

function sessionOf(link: HTMLElement) {
  return decodeURIComponent(new URL(link.getAttribute('href')!, document.baseURI).pathname.split('/library/progress/')[1]!);
}

export const LongUnavailableSummaries: Story = {
  globals: { viewport: { value: 'phone390', isRotated: false } },
  ...scenario('long'),
  play: async ({ canvasElement }) => {
    const view = await logsRegion(canvasElement);
    const rows = view.getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getByRole('heading', { level: 3, name: m.library_account_deleted() })).toBeVisible();
    const expand = within(rows[0]!).getByRole('button', { name: m.library_progress_log_reader_full_note() });
    const other = within(rows[2]!).getByRole('button', { name: m.library_progress_log_reader_full_note() });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(expand);
    expect(expand).toHaveAttribute('aria-expanded', 'true');
    expect(other).toHaveAttribute('aria-expanded', 'false');
    expect(canvasElement.ownerDocument.getElementById(expand.getAttribute('aria-controls')!)!.textContent).toBe(
      progressLogsStoryNote,
    );
    const more = await view.findByRole('link', { name: m.library_logs_more() });
    expect(sessionOf(more)).toBe(sessionId);
    expect(searchOf(more)).toEqual({ ...retained, logs: cursors.next });
    expect(view.queryByRole('link', { name: m.library_progress_log_reader_first_page() })).not.toBeInTheDocument();
  },
};

export const FirstEmpty: Story = {
  ...scenario('empty'),
  play: async ({ canvasElement }) => {
    const view = await logsRegion(canvasElement);
    expect(view.getByText(m.library_logs_empty())).toBeVisible();
    expect(view.queryByRole('link')).not.toBeInTheDocument();
  },
};

export const LaterEmptyWithContinuation: Story = {
  ...scenario('later-empty', cursors.later),
  play: async ({ canvasElement }) => {
    const view = await logsRegion(canvasElement);
    expect(view.getByText(m.library_progress_log_reader_page_empty())).toBeVisible();
    expect(view.queryByText(m.library_logs_empty())).not.toBeInTheDocument();
    const first = await view.findByRole('link', { name: m.library_progress_log_reader_first_page() });
    const more = await view.findByRole('link', { name: m.library_logs_more() });
    expect(sessionOf(first)).toBe(sessionId);
    expect(searchOf(first)).toEqual(retained);
    expect(searchOf(more)).toEqual({ ...retained, logs: cursors.next });
  },
};

export const StaleCursorRestart: Story = {
  ...scenario('restart', cursors.stale),
  play: async ({ canvasElement }) => {
    const view = await logsRegion(canvasElement);
    expect(view.getByText(logsRecording.publishedLogs[0]!.note!)).toBeVisible();
    const first = await view.findByRole('link', { name: m.library_progress_log_reader_first_page() });
    expect(sessionOf(first)).toBe(sessionId);
    expect(searchOf(first)).toEqual(retained);
    expect(view.queryByRole('link', { name: m.library_logs_more() })).not.toBeInTheDocument();
  },
};
