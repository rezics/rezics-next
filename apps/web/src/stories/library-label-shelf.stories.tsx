import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { setFakeAdmitted } from '../kernel/fake';
import { setLibraryLabelStorySizes } from '../kernel/fake/library-label-assignments';
import { m } from '../paraglide/messages.js';
import { PageStory, pageReady } from './page';

const meta = {
  title: 'Library/Label Shelf',
  id: 'pages-library-label-shelf',
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' }, type: 'desktop' },
      },
    },
  },
  globals: {},
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const firstLabelId = '0192f3a0-6c1e-7b2a-9d4e-000000000801';
const emptyLabelId = '0192f3a0-6c1e-7b2a-9d4e-000000000832';

function LabelShelfStory({
  count,
  labelId = firstLabelId,
  search = '',
  scenario = 'default',
}: {
  count: number;
  labelId?: string;
  search?: string;
  scenario?: 'default' | 'reading' | 'sparse';
}) {
  setFakeAdmitted(['personal_library', 'reading_progress', 'library_label.assignment_list', 'library_label.unassign']);
  setLibraryLabelStorySizes({ subject: 3, shelf: count, scenario });
  return <PageStory visitor="Signed In" path={`/library?label=${labelId}${search}`} />;
}

async function shelfReady(context: { canvasElement: HTMLElement }, count: number, heading: string) {
  await pageReady(context);
  const main = within(within(context.canvasElement).getByRole('main'));
  await main.findByRole('heading', { level: 1, name: heading });
  if (count === 0) await main.findByText(m.library_label_shelf_empty());
  else
    await expect(
      context.canvasElement.querySelectorAll('[data-slot="cover-card"], [data-slot="tombstone"]'),
    ).toHaveLength(count);
}

export const ThreeWorks: Story = {
  name: 'Three works',
  globals: {},
  render: () => <LabelShelfStory count={3} />,
  play: async (context) => {
    await shelfReady(context, 3, 'Reading list');
    const trigger = within(context.canvasElement).getByRole('button', {
      name: m.library_entry_actions({ title: m.library_subject_unavailable() }),
    });
    const tile = context.canvasElement.querySelector('[data-slot="tombstone"]')!.parentElement!;
    const bounds = tile.getBoundingClientRect();
    const actions = trigger.getBoundingClientRect();
    await expect(actions.left).toBeGreaterThanOrEqual(bounds.left);
    await expect(actions.right).toBeLessThanOrEqual(bounds.right);
    await expect(bounds.right).toBeLessThanOrEqual(document.documentElement.clientWidth);
  },
};

export const FortyWorks: Story = {
  name: 'Forty works',
  render: () => <LabelShelfStory count={40} />,
  play: (context) => shelfReady(context, 40, 'Reading list'),
};

export const Empty: Story = {
  name: 'Empty label',
  render: () => <LabelShelfStory count={0} labelId={emptyLabelId} />,
  play: (context) => shelfReady(context, 0, 'Empty label'),
};

export const ShelfActions: Story = {
  render: () => <LabelShelfStory count={3} />,
  play: async (context) => {
    await shelfReady(context, 3, 'Reading list');
    const view = within(context.canvasElement);
    const trigger = await view.findByRole('button', { name: m.library_entry_actions({ title: 'Label shelf work 1' }) });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    const surface = await within(document.body).findByRole('dialog');
    await expect(await within(surface).findByRole('button', { name: m.library_label_shelf_remove() })).toBeVisible();
    const form = surface.querySelector('form')!;
    await expect(new FormData(form).get('revision')).toBe('1');
    await expect(new FormData(form).get('assignmentId')).toBe('0192f3a0-6c1e-7b2a-9d4e-000000001200');
    await userEvent.keyboard('{Escape}');
  },
};

export const RetainedUndo: Story = {
  render: () => (
    <LabelShelfStory
      count={3}
      search={`&labelResult=label-restore-stale&undoLabelId=${firstLabelId}&undoSubjectId=0192f3a0-6c1e-7b2a-9d4e-000000001102&undoAssignmentId=0192f3a0-6c1e-7b2a-9d4e-000000001202&undoRevision=2&undoKey=0192f3a0-6c1e-7b2a-9d4e-000000001900`}
    />
  ),
  play: async (context) => {
    await shelfReady(context, 3, 'Reading list');
    const view = within(context.canvasElement);
    await view.findByText(m.library_subject_label_restore_stale());
    const form = context.canvasElement.querySelector<HTMLFormElement>('[data-label-undo]')!;
    await expect(new FormData(form).get('revision')).toBe('2');
    await expect(new FormData(form).get('assignmentId')).toBe('0192f3a0-6c1e-7b2a-9d4e-000000001202');
    await expect(new FormData(form).get('idempotencyKey')).toBe('0192f3a0-6c1e-7b2a-9d4e-000000001900');
    await expect(within(form).getByRole('button', { name: m.library_subject_label_undo() })).toBeEnabled();
  },
};

export const Unavailable: Story = {
  render: () => <LabelShelfStory count={3} search="&labelRead=unavailable" />,
  play: async (context) => {
    await pageReady(context);
    await within(context.canvasElement).findByText(m.library_subject_label_unavailable());
  },
};

export const Preparing: Story = {
  render: () => <LabelShelfStory count={3} search="&labelRead=preparing" />,
  play: async (context) => {
    await pageReady(context);
    await within(context.canvasElement).findByText(m.library_labels_preparing());
  },
};

export const Hidden: Story = {
  render: () => <LabelShelfStory count={3} search="&labelRead=denied" />,
  play: async (context) => {
    await pageReady(context);
    await within(context.canvasElement).findByRole('heading', { name: m.not_found_heading() });
    await expect(context.canvasElement.querySelector('[data-slot="cover-card"]')).toBeNull();
  },
};

export const SparseContinued: Story = {
  name: 'Sparse page continues in native order',
  render: () => <LabelShelfStory count={40} scenario="sparse" />,
  play: async (context) => {
    await shelfReady(context, 1, 'Reading list');
    const view = within(context.canvasElement);
    await expect(view.getByText(m.library_labels_member_page_count({ count: 1 }))).toBeVisible();
    await expect(view.getByText('The Left Hand of Darkness')).toBeVisible();
    await userEvent.click(view.getByRole('link', { name: m.library_more(), exact: true }));
    await waitFor(() =>
      expect(context.canvasElement.querySelectorAll('[data-slot="cover-card"], [data-slot="tombstone"]')).toHaveLength(
        2,
      ),
    );
    await expect(view.getByText(m.library_labels_member_page_count({ count: 2 }))).toBeVisible();
    await expect(view.getByRole('link', { name: m.library_label_previous_page() })).toBeVisible();
    await expect(view.queryByRole('link', { name: m.library_more(), exact: true })).toBeNull();
  },
};

export const ReadMeaningfulMembers: Story = {
  name: 'Member reading keeps status and progress independent',
  render: () => <LabelShelfStory count={3} scenario="reading" />,
  play: async (context) => {
    await shelfReady(context, 3, 'Reading list');
    const view = within(context.canvasElement);
    await userEvent.click(
      view.getByRole('button', {
        name: m.library_received_reading_open_named({ position: 1, title: 'The Left Hand of Darkness' }),
      }),
    );
    const reading = context.canvasElement.querySelector<HTMLElement>('[data-received-assignment-reader]')!;
    await expect(reading).toBeVisible();
    await expect(within(reading).getByRole('heading', { name: 'The Left Hand of Darkness' })).toBeVisible();
    const details = reading.querySelector<HTMLDetailsElement>('[data-received-progress] details')!;
    await expect(details.open).toBe(false);
    await userEvent.click(within(details).getByText(m.library_labels_reading_details()));
    await expect(details.open).toBe(true);
    const link = within(reading).getByRole('link', { name: m.library_received_reading_open_work() });
    const href = link.getAttribute('href')!;
    await expect(href).not.toContain('label=');
    await expect(href).not.toContain('cursor=');
    await expect(href).not.toContain('assignmentId');
    await userEvent.click(within(reading).getByRole('button', { name: m.library_received_reading_close() }));
    await waitFor(() => expect(context.canvasElement.querySelector('[data-received-assignment-reader]')).toBeNull());
  },
};
