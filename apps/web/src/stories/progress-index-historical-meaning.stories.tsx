import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ProgressIndexPage } from '../library/progress-page';
import type { ProgressIndex } from '../library/progress-reads';
import recorded from '../kernel/recorded/library-progress-sessions.json';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PatternStory } from './page';

const meta = {
  title: 'Library/Progress history',
  id: 'patterns-library-progress-history',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'UNRUN. Recorded index session shapes with explicit missing-label, zero, blank and long-text presentation fixtures. These stories do not establish native meaning or current browser geometry.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
type Session = ProgressIndex['sessions'][number];

const source = recorded.progressSessions[0]!;
const cursor = 'earlier/opaque+==';
const next = 'next/opaque+==';
const path = `/library/progress?subjectId=${source.subjectId}&cursor=${encodeURIComponent(cursor)}`;
function session(index: number, changes: Partial<Session>): Session {
  const row = recorded.progressSessions[index]!;
  return {
    ...row,
    mode: 'scalar_amount',
    state: 'active',
    subject: { ...row.subject, types: [row.subject.type], cover: null },
    versionSubject: null,
    ...changes,
  };
}
const unknown: Session[] = [
  session(0, {
    amount: '0.123456',
    position: null,
    locator: null,
    total: null,
    unit: 'historical:unit~' + 'unmapped'.repeat(14),
  }),
  session(1, { amount: '0', total: null, unit: '' }),
  session(2, { mode: 'cursor_position', amount: null, total: null, position: '0', locator: '' }),
  session(3, { mode: 'cursor_position', amount: null, total: null, position: null, locator: 'Ch. 3, 9' }),
  session(4, { mode: 'completed_units', amount: null, total: null, completedUnitCount: 2 }),
];
function History({ sessions = unknown }: { sessions?: Session[] }) {
  const page: ProgressIndex = {
    signedIn: true,
    subjectId: source.subjectId,
    selectedSubject: null,
    sessions,
    next,
    idempotencyKey: '019a1b2c-3d4e-7f00-8a00-000000000099',
  };
  return (
    <PatternStory visitor="Signed In" path={path}>
      <main className="w-full max-w-4xl p-4">
        <ProgressIndexPage page={page} cursor={cursor} />
      </main>
    </PatternStory>
  );
}

export const MissingHistoricalMeaning: Story = {
  render: () => <History />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findAllByText(m.library_progress_index_reader_history_unavailable());
    const rows = [...canvasElement.querySelectorAll('ol > li')];
    expect(rows).toHaveLength(unknown.length);
    for (const [index, row] of rows.entries()) {
      const details = row.querySelector('details')!;
      expect(details).not.toHaveAttribute('open');
      expect(row.querySelector('code')).not.toBeVisible();
      expect(row.querySelector('code')?.textContent).toBe(`${unknown[index]!.mode} / ${unknown[index]!.unit}`);
      expect(row.querySelector('[role="progressbar"]')).toBeNull();
    }
    expect(rows[0]!.textContent).toContain('0.123456');
    expect(rows[1]!.querySelector('[data-slot="progress-row"]')?.textContent).toContain('0');
    expect(rows[2]!.querySelector('[data-slot="progress-row"]')?.textContent).toContain('0');
    expect(rows[3]!.textContent).toContain('Ch. 3, 9');
    expect(canvasElement.textContent).not.toMatch(/%|1\s*[-–]\s*2/);
  },
};

export const ExactValuesByKeyboard: Story = {
  render: () => <History />,
  play: async (context) => {
    await MissingHistoricalMeaning.play?.(context);
    const details = context.canvasElement.querySelector('details')!;
    const summary = details.querySelector('summary')!;
    summary.focus();
    await userEvent.keyboard('{Enter}');
    expect(details).toHaveAttribute('open');
    expect(summary).toHaveFocus();
    expect(details.querySelector('code')).toBeVisible();
    expect(details.querySelector('code')?.textContent).toBe(`${unknown[0]!.mode} / ${unknown[0]!.unit}`);
    expect(details.scrollWidth).toBeLessThanOrEqual(details.clientWidth);
    expect(within(details).getByText(m.library_history_unavailable())).toBeVisible();
  },
};

export const KnownUnitUnchanged: Story = {
  render: () => (
    <History
      sessions={[
        session(0, {
          mode: 'scalar_amount',
          unit: 'page',
          unitLabel: 'pages',
          amount: '3',
          total: '12',
          position: null,
          locator: null,
        }),
      ]}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('progressbar');
    expect(canvasElement.querySelector('details')).toBeNull();
    expect(canvas.queryByText(m.library_progress_index_reader_history_unavailable())).not.toBeInTheDocument();
    expect(canvas.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
  },
};

export const LongPaginationLabels: Story = {
  globals: { viewport: { value: 'phone390' } },
  render: () => <History sessions={[]} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const nav = await canvas.findByRole('navigation', { name: m.library_progress_index_reader_pagination() });
    const first = within(nav).getByRole('link', { name: m.library_collections_first_page() });
    const more = within(nav).getByRole('link', { name: m.library_progress_more() });
    for (const [index, link] of [first, more].entries()) {
      const destination = new URL(link.getAttribute('href')!, window.location.origin);
      expect(destination.pathname).toBe(`/${getLocale()}/library/progress`);
      expect(destination.searchParams.get('subjectId')).toBe(source.subjectId);
      expect(destination.searchParams.get('cursor')).toBe(index ? next : null);
      // Stress the actual anchor using the active locale's label, without a second renderer or destination.
      link.textContent = Array(12).fill(link.textContent).join(' ');
      const box = link.getBoundingClientRect();
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(link.scrollWidth).toBeLessThanOrEqual(link.clientWidth);
      const range = document.createRange();
      range.selectNodeContents(link);
      expect(range.getClientRects().length).toBeGreaterThan(1);
    }
    expect(nav.scrollWidth).toBeLessThanOrEqual(nav.clientWidth);
    first.focus();
    await userEvent.tab();
    expect(more).toHaveFocus();
    expect(more.matches(':focus-visible')).toBe(true);
    expect(Number.parseFloat(getComputedStyle(more).outlineWidth)).toBeGreaterThan(0);
  },
};
