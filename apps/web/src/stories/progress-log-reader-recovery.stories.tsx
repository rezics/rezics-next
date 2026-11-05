import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { Button } from '@rezics/ui/shadcn/button';
import { profileSession } from '../kernel/fake/progress-profiles';
import recording from '../kernel/recorded/library-published-logs.json';
import { ProgressLogs } from '../library/logs-progress';
import type { PublishedLog, PublishedLogPage } from '../library/logs-read';
import type { ProgressSessionPage } from '../library/progress-reads';
import type { ProgressDetailOrigin } from '../library/progress-session';
import { subjectOf } from '../library/reads';
import { m } from '../paraglide/messages.js';
import { PatternStory } from './page';

// UNRUN: dedicated supplied-reader stories and interactions; no visual, native or authority proof.
const meta = {
  title: 'Patterns/Library/Progress Log Reader Recovery',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Recorded published-log fields with explicit DTO variants for long text, empty pages and unavailable summaries. The local origin guard illustrates retirement; it is not native authorization evidence.',
      },
    },
    viewport: {
      options: {
        phone320: { name: 'Phone 320', styles: { width: '320px', height: '844px' }, type: 'mobile' },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' }, type: 'desktop' },
      },
    },
  },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const progress: Extract<ProgressSessionPage, { signedIn: true }> = {
  signedIn: true,
  idempotencyKey: '10203040-5060-4070-8090-102030405060',
  session: {
    ...profileSession,
    mode: 'scalar_amount',
    state: 'active',
    changes: [],
    changesNext: null,
    units: [],
    unitsNext: null,
  },
};
const recorded = recording.publishedLogs[0]!;
const log: PublishedLog = { ...recorded, sessionState: 'active', subject: subjectOf(recorded.subject) };
const otherCursors = { changes: 'changes/original+?=&二%', units: 'units/original+== &三%' };
const laterSearch = { ...otherCursors, logs: 'logs/later+?=&四%' };
const next = 'logs/next+?=&五%';
const longNote = `  An original note with preserved spacing.\n\n${'unbroken_note_二'.repeat(50)}\n  <literal text & punctuation>  `;
const longLog: PublishedLog = {
  ...log,
  account: { displayName: 'A very long account name '.repeat(10), handle: 'unbroken_account_handle'.repeat(12) },
  note: longNote,
};
const unavailableLog: PublishedLog = { ...log, id: 'retained-snapshot', account: null, subject: null, note: null };

function Reader({
  logs = [log],
  later = false,
  continuation = null,
  initiallyRetired = false,
  retirementControl = false,
}: {
  logs?: PublishedLog[];
  later?: boolean;
  continuation?: string | null;
  initiallyRetired?: boolean;
  retirementControl?: boolean;
}) {
  const [retired, setRetired] = useState(initiallyRetired);
  const current = useRef(!retired);
  current.current = !retired;
  const search = later ? laterSearch : otherCursors;
  const originating: ProgressDetailOrigin = {
    viewer: 'story-owner',
    address: { id: progress.session.id, ...search },
    isCurrent: () => current.current,
    capture: () => ({ isCurrent: () => current.current, headers: () => null }),
    refresh: async () => progress,
  };
  const page: PublishedLogPage = { signedIn: true, logs, next: continuation };
  return (
    <PatternStory visitor="Signed In" path={`/library/progress/${progress.session.id}`}>
      <main className="mx-auto w-full max-w-4xl space-y-6 p-4">
        {retirementControl ? (
          <Button variant="outline" onClick={() => setRetired(true)} disabled={retired}>
            Retire this view (story control)
          </Button>
        ) : null}
        <ProgressLogs progress={progress} logs={page} search={search} originating={originating} />
      </main>
    </PatternStory>
  );
}

async function reader(canvasElement: HTMLElement) {
  return within(await within(canvasElement).findByRole('region', { name: m.library_logs_heading() }));
}

export const Normal: Story = {
  render: () => <Reader logs={[log, { ...log, id: 'second-snapshot', note: null }]} continuation={next} />,
  play: async ({ canvasElement }) => {
    const view = await reader(canvasElement);
    expect(view.getAllByRole('listitem')).toHaveLength(2);
    const more = await view.findByRole('link', { name: m.library_logs_more() });
    expect(new URL(more.getAttribute('href')!, document.baseURI).searchParams.get('logs')).toBe(next);
    expect(view.queryByRole('link', { name: m.library_progress_log_reader_first_page() })).not.toBeInTheDocument();
    expect(view.getAllByRole('listitem')[0]!.querySelector('time')?.getAttribute('datetime')).toBe(log.publishedAt);
  },
};

export const NarrowLongText: Story = {
  globals: { viewport: { value: 'phone320', isRotated: false } },
  render: () => <Reader logs={[longLog, unavailableLog, longLog]} later continuation={next} />,
  play: async ({ canvasElement }) => {
    const view = await reader(canvasElement);
    const rows = view.getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    const expand = within(rows[0]!).getByRole('button', { name: m.library_progress_log_reader_full_note() });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(expand);
    expect(expand).toHaveAttribute('aria-expanded', 'true');
    const note = canvasElement.ownerDocument.getElementById(expand.getAttribute('aria-controls')!)!;
    expect(note.textContent).toBe(longNote);
    expect(note).toBeVisible();
    expect(within(rows[0]!).getByRole('link')).toBeVisible();
    expect(rows[0]!.querySelector('time')).toBeVisible();
    await userEvent.keyboard('{Enter}');
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(rows[2]!.querySelector('button')).toHaveAttribute('aria-expanded', 'false');
  },
};

export const FirstPageEmpty: Story = {
  render: () => <Reader logs={[]} />,
  play: async ({ canvasElement }) => {
    const view = await reader(canvasElement);
    expect(view.getByText(m.library_logs_empty())).toBeVisible();
    expect(view.queryByRole('link')).not.toBeInTheDocument();
  },
};

export const LaterPageEmpty: Story = {
  render: () => <Reader logs={[]} later />,
  play: async ({ canvasElement }) => {
    const view = await reader(canvasElement);
    expect(view.getByText(m.library_progress_log_reader_page_empty())).toBeVisible();
    expect(view.queryByText(m.library_logs_empty())).not.toBeInTheDocument();
    const first = await view.findByRole('link', { name: m.library_progress_log_reader_first_page() });
    const url = new URL(first.getAttribute('href')!, document.baseURI);
    expect(decodeURIComponent(url.pathname.split('/library/progress/')[1]!)).toBe(progress.session.id);
    expect(Object.fromEntries(url.searchParams)).toEqual(otherCursors);
    expect(view.queryByRole('link', { name: m.library_logs_more() })).not.toBeInTheDocument();
  },
};

export const EmptyPageWithContinuation: Story = {
  render: () => <Reader logs={[]} later continuation={next} />,
  play: async ({ canvasElement }) => {
    const view = await reader(canvasElement);
    expect(view.getByText(m.library_progress_log_reader_page_empty())).toBeVisible();
    await view.findByRole('link', { name: m.library_progress_log_reader_first_page() });
    const more = await view.findByRole('link', { name: m.library_logs_more() });
    expect(Object.fromEntries(new URL(more.getAttribute('href')!, document.baseURI).searchParams)).toEqual({
      logs: next,
      ...otherCursors,
    });
  },
};

export const Unavailable: Story = {
  name: 'Unavailable account summary and operation admission',
  parameters: { admitted: [] },
  render: () => <Reader logs={[unavailableLog]} later continuation={next} />,
  play: async ({ canvasElement }) => {
    const view = await reader(canvasElement);
    expect(view.getByRole('heading', { level: 3, name: m.library_account_deleted() })).toBeVisible();
    expect(view.queryByRole('link')).not.toBeInTheDocument();
    expect(view.getByRole('listitem').querySelector('time')).toBeVisible();
  },
};

export const AuthorityRetired: Story = {
  render: () => <Reader logs={[]} later continuation={next} initiallyRetired />,
  play: async ({ canvasElement }) => {
    const view = await reader(canvasElement);
    expect(view.getByText(m.library_progress_log_reader_page_empty())).toBeVisible();
    expect(view.queryByRole('link')).not.toBeInTheDocument();
  },
};

export const RetirementWhileMounted: Story = {
  render: () => <Reader logs={[longLog]} later continuation={next} retirementControl />,
  play: async ({ canvasElement }) => {
    const view = await reader(canvasElement);
    await view.findByRole('link', { name: m.library_progress_log_reader_first_page() });
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Retire this view (story control)' }));
    expect(view.queryByRole('link', { name: m.library_progress_log_reader_first_page() })).not.toBeInTheDocument();
    expect(view.queryByRole('link', { name: m.library_logs_more() })).not.toBeInTheDocument();
  },
};
