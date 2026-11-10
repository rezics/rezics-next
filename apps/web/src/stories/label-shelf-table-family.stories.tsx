import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import type { LabelShelfEntry } from '../library/label-shelf-read';
import { libraryStateLabel } from '../library/profiles';
import { LabelShelfEntries } from '../library/shelf-view';
import definitions from '../kernel/recorded/definitions-release.json';
import recording from '../kernel/recorded/library-entries.json';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import type { Release } from '../subject/definitions';
import { PatternStory } from './page';

// Illustrative assignment envelopes around recorded subject/state summaries; not native acceptance evidence.
// These dedicated stories and their interactions are authored and UNRUN in this source delivery.
const admitted = ['personal_library', 'reading_progress', 'library_label.assignment_list', 'library_label.unassign'];
const label = { id: '0192f3a0-6c1e-7b2a-9d4e-000000000801', name: 'Reading list' };
const meta = {
  title: 'Library/Label shelf table family',
  id: 'patterns-library-label-shelf-table-family',
  parameters: {
    layout: 'fullscreen',
    admitted,
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' }, type: 'desktop' },
      },
    },
  },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function fixtures(longText: boolean): LabelShelfEntry[] {
  const recorded = recording.libraryEntries[0]!;
  const stateLabel =
    libraryStateLabel(definitions.release as unknown as Release, recorded.subject.type, recorded.state, getLocale())
      ?.text ?? m.library_other();
  const subject = {
    ...recorded.subject,
    ...(longText
      ? { label: { value: '日本語の長い題名と読書記録：何度も読み返したい物語とその続き'.repeat(3), language: 'ja' } }
      : {}),
  };
  return [
    {
      id: '0192f3a0-6c1e-7b2a-9d4e-000000001202',
      labelId: label.id,
      subjectId: recorded.subjectId,
      revision: 9,
      removeKey: '0192f3a0-6c1e-7b2a-9d4e-000000002202',
      subject,
      state: recorded.state,
      stateLabel,
      activeProgressSession: {
        mode: 'scalar_amount',
        unit: 'percent',
        dimension: 'percent',
        amount: '0',
        total: null,
        completedUnitCount: 0,
        locator: null,
      },
    },
    {
      id: '0192f3a0-6c1e-7b2a-9d4e-000000001201',
      labelId: label.id,
      subjectId: recorded.subjectId,
      revision: 3,
      removeKey: '0192f3a0-6c1e-7b2a-9d4e-000000002201',
      subject,
      activeProgressSession: {
        mode: 'cursor_position',
        unit: 'page',
        amount: null,
        total: null,
        completedUnitCount: 0,
        locator: 'Chapter 4',
        position: null,
      },
    },
  ];
}

function TablePattern({
  columns,
  longText = false,
  unavailable = false,
  retired = false,
}: {
  columns?: string;
  longText?: boolean;
  unavailable?: boolean;
  retired?: boolean;
}) {
  const entries = fixtures(longText);
  if (unavailable)
    entries.splice(1, 0, {
      id: '0192f3a0-6c1e-7b2a-9d4e-000000001203',
      labelId: label.id,
      subjectId: '0192f3a0-6c1e-7b2a-9d4e-000000001199',
      revision: 5,
      removeKey: '0192f3a0-6c1e-7b2a-9d4e-000000002203',
      subject: null,
    });
  return (
    <PatternStory visitor="Signed In" path={`/library?label=${label.id}&layout=table`}>
      <section className="mx-auto w-full max-w-6xl space-y-4 p-4" aria-label={label.name}>
        <h1 className="text-xl font-semibold">{label.name}</h1>
        <LabelShelfEntries
          entries={entries}
          label={label}
          locale={getLocale()}
          layout="table"
          size="m"
          {...(columns ? { columns } : {})}
          csrfToken="label-table-story-csrf"
          isCurrent={() => !retired}
        />
      </section>
    </PatternStory>
  );
}

async function tableReady(canvasElement: HTMLElement, count: number) {
  const table = await within(canvasElement).findByRole('table');
  await expect(table.querySelectorAll('tbody tr')).toHaveLength(count);
  await expect(table.querySelector('thead button, th[aria-sort], time')).toBeNull();
  return table;
}

export const Normal: Story = {
  name: 'Native order · repeated subject · zero and unknown progress',
  render: () => <TablePattern />,
  play: async ({ canvasElement }) => {
    const table = await tableReady(canvasElement, 2);
    await expect(within(table).getByText('0%')).toBeVisible();
    await expect(within(table).getByText('Chapter 4')).toBeVisible();
    await expect(table.querySelectorAll('[role="progressbar"]')).toHaveLength(1);
  },
};

export const NarrowLongText: Story = {
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => <TablePattern longText columns="title,status" />,
  play: async ({ canvasElement }) => {
    const table = await tableReady(canvasElement, 2);
    await expect(table.querySelectorAll('a[lang="ja"]')).toHaveLength(2);
    await expect(table.querySelectorAll('th')).toHaveLength(2);
    const trigger = within(table).getAllByRole('button')[0]!;
    await expect(trigger).toBeEnabled();
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    await expect(
      await within(document.body).findByRole('button', { name: m.library_label_shelf_remove() }),
    ).toBeVisible();
  },
};

export const Unavailable: Story = {
  name: 'Unavailable subject · absent state · unknown progress',
  render: () => <TablePattern unavailable />,
  play: async ({ canvasElement }) => {
    const table = await tableReady(canvasElement, 3);
    const missing = table.querySelectorAll('tbody tr')[1]!;
    await expect(missing.querySelector('[data-slot="tombstone"]')).toBeTruthy();
    await expect(missing.querySelector('a')).toBeNull();
    await expect(missing.textContent).not.toContain('0192f3a0');
  },
};

export const TitleOnlyActions: Story = {
  render: () => <TablePattern columns="title,added,finished,lastActivity" />,
  play: async ({ canvasElement }) => {
    const table = await tableReady(canvasElement, 2);
    await expect([...table.querySelectorAll('th')].map((node) => node.textContent)).toEqual([
      m.library_column_title(),
      m.library_column_actions(),
    ]);
    await expect(table.querySelector('[data-slot="progress-row"]')).toBeNull();
  },
};

export const NoUnassignAdmission: Story = {
  parameters: { admitted: admitted.filter((group) => group !== 'library_label.unassign') },
  render: () => <TablePattern columns="title" unavailable />,
  play: async ({ canvasElement }) => {
    const table = await tableReady(canvasElement, 3);
    await expect(table.querySelectorAll('th')).toHaveLength(1);
    await expect(within(table).queryByRole('button')).toBeNull();
  },
};

export const AuthorityRetired: Story = {
  name: 'Retired current guard rejects the original removal form',
  render: () => <TablePattern columns="title" retired />,
  play: async ({ canvasElement }) => {
    const table = await tableReady(canvasElement, 2);
    await userEvent.click(within(table).getAllByRole('button')[0]!);
    const remove = await within(document.body).findByRole('button', { name: m.library_label_shelf_remove() });
    const form = remove.closest('form')!;
    await expect(new FormData(form).get('assignmentId')).toBe('0192f3a0-6c1e-7b2a-9d4e-000000001202');
    await expect(new FormData(form).get('revision')).toBe('9');
    const event = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(event);
    await expect(event.defaultPrevented).toBe(true);
    await expect(new FormData(form).get('idempotencyKey')).toBe('0192f3a0-6c1e-7b2a-9d4e-000000002202');
  },
};
