import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { PageStory, pagePaths, pageReady } from './page';
import { labelOperations } from '../kernel/fake/library-labels';
import { setFakeAdmitted } from '../kernel/fake';
import { setLibraryLabelStorySizes } from '../kernel/fake/library-label-assignments';
import { unprofiledSubjectId } from '../kernel/fake/library-unprofiled-subject';
import { m } from '../paraglide/messages.js';

const meta = {
  title: 'Pages/Library/Labels',
  parameters: {
    layout: 'fullscreen',
    admitted: labelOperations,
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
export const SignedIn: Story = {
  name: 'Signed In',
  play: pageReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-labels']} labelsFixture="catalogue" />,
};
export const SignedOut: Story = {
  name: 'Signed Out',
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={pagePaths['library-labels']} />,
};
export const Empty: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-labels']} labelsFixture="empty" />,
  play: async (context) => {
    await pageReady(context);
    await within(context.canvasElement).findByText(m.library_labels_empty());
  },
};
export const NextPage: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-labels']} labelsFixture="next" />,
  play: async (context) => {
    await pageReady(context);
    await within(context.canvasElement).findByRole('link', { name: m.library_label_more() });
  },
};
export const RenameConflict: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-labels']} labelsFixture="conflict" />,
  play: async (context) => {
    await pageReady(context);
    const view = within(context.canvasElement);
    const rename = (await view.findAllByRole('button', { name: m.library_label_rename() }))[0]!;
    const field = within(rename.closest('form')!).getByRole('textbox');
    await userEvent.clear(field);
    await userEvent.type(field, 'Outdated draft');
    await userEvent.click(rename);
    await expect(await view.findByRole('alert')).toHaveTextContent(m.library_label_stale());
    await expect(view.getByDisplayValue('Winter reads')).toBeVisible();
  },
};
export const Undo: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-labels']} labelsFixture="undo" />,
  play: async (context) => {
    await pageReady(context);
    const view = within(context.canvasElement);
    await userEvent.click((await view.findAllByRole('button', { name: m.library_label_delete() }))[0]!);
    await expect(await view.findByRole('status')).toHaveTextContent(m.library_label_deleted({ name: 'Winter reads' }));
    await expect(within(view.getByRole('status')).getByRole('button', { name: m.library_label_undo() })).toBeEnabled();
  },
};

export const LiteralPrefix: Story = {
  render: () => (
    <PageStory visitor="Signed In" path={`${pagePaths['library-labels']}?q=Winter`} labelsFixture="catalogue" />
  ),
  play: async (context) => {
    await pageReady(context);
    const view = within(context.canvasElement);
    await expect(await view.findByDisplayValue('Winter')).toBeVisible();
    await expect(await view.findByRole('link', { name: 'Winter reads' })).toBeVisible();
    const field = view.getByRole('textbox', { name: m.library_labels_prefix() });
    await userEvent.clear(field);
    await userEvent.type(field, '%_\\');
    await userEvent.keyboard('{Escape}');
    await expect(field).toHaveValue('%_\\');
  },
};

export const SparsePrefix: Story = {
  render: () => <PageStory visitor="Signed In" path={`${pagePaths['library-labels']}?q=%25_`} labelsFixture="next" />,
  play: async (context) => {
    await pageReady(context);
    const view = within(context.canvasElement);
    await view.findByText(m.library_subject_label_no_results());
    await expect(await view.findByRole('link', { name: m.library_label_more() })).toHaveAttribute(
      'href',
      expect.stringContaining('q=%25_&cursor='),
    );
  },
};

export const EmptyPrefix: Story = {
  render: () => (
    <PageStory visitor="Signed In" path={`${pagePaths['library-labels']}?q=No%20match`} labelsFixture="catalogue" />
  ),
  play: async (context) => {
    await pageReady(context);
    await within(context.canvasElement).findByText(m.library_subject_label_no_results());
  },
};

export const RetainedUndoAfterStale: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-labels']} labelsFixture="conflict" />,
  play: async (context) => {
    await pageReady(context);
    const view = within(context.canvasElement);
    await userEvent.click((await view.findAllByRole('button', { name: m.library_label_delete() }))[0]!);
    await waitFor(() => expect(context.canvasElement.querySelector('form[role="status"]')).not.toBeNull());
    const undo = context.canvasElement.querySelector<HTMLFormElement>('form[role="status"]')!;
    const guard = new FormData(undo);
    const rename = view.getByRole('button', { name: m.library_label_rename() });
    const field = within(rename.closest('form')!).getByRole('textbox');
    await userEvent.clear(field);
    await userEvent.type(field, 'Changed while open');
    await userEvent.click(rename);
    await expect(await view.findByRole('alert')).toHaveTextContent(m.library_label_stale());
    const retained = context.canvasElement.querySelector<HTMLFormElement>('form[role="status"]')!;
    for (const key of ['id', 'library_label_revision', 'idempotencyKey'])
      await expect(new FormData(retained).get(key)).toBe(guard.get(key));
    await userEvent.click(within(retained).getByRole('button', { name: m.library_label_undo() }));
    await expect(await view.findByDisplayValue('Winter reads')).toBeVisible();
  },
};

export const Unavailable: Story = {
  render: () => (
    <PageStory
      visitor="Signed In"
      path={`${pagePaths['library-labels']}?labelRead=unavailable`}
      labelsFixture="catalogue"
    />
  ),
  play: async (context) => {
    await pageReady(context);
    await within(context.canvasElement).findAllByText(m.library_labels_unavailable());
  },
};

export const Preparing: Story = {
  render: () => (
    <PageStory
      visitor="Signed In"
      path={`${pagePaths['library-labels']}?labelRead=preparing`}
      labelsFixture="catalogue"
    />
  ),
  play: async (context) => {
    await pageReady(context);
    await within(context.canvasElement).findByText(m.library_labels_preparing());
  },
};

function SubjectLabelStory({ count, unprofiled = false }: { count: number; unprofiled?: boolean }) {
  setFakeAdmitted([
    'personal_library',
    'reading_progress',
    'library_label.assignment_list',
    ...labelOperations,
    'library_label.assign',
    'library_label.unassign',
  ]);
  setLibraryLabelStorySizes({ subject: count });
  return (
    <PageStory visitor="Signed In" path={unprofiled ? `/subjects/${unprofiledSubjectId}/person` : pagePaths.subject} />
  );
}

export const UnprofiledSubject: Story = {
  render: () => <SubjectLabelStory count={0} unprofiled />,
  play: async (context) => {
    await pageReady(context);
    const view = within(context.canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.library_subject_label_add() }));
    await userEvent.type(await view.findByRole('textbox', { name: m.library_subject_label_name() }), 'For later');
    await userEvent.click(
      await view.findByRole('button', { name: m.library_subject_label_create({ name: 'For later' }) }),
    );
    await expect(await view.findByRole('link', { name: 'For later' })).toBeVisible();
    await expect(view.queryByText(m.library_entry_profile_unsupported())).not.toBeInTheDocument();
  },
};

export const Capacity: Story = {
  render: () => <SubjectLabelStory count={32} />,
  play: async (context) => {
    await pageReady(context);
    const view = within(context.canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.library_subject_label_add() }));
    await userEvent.type(await view.findByRole('textbox', { name: m.library_subject_label_name() }), 'One more label');
    await userEvent.click(
      await view.findByRole('button', { name: m.library_subject_label_create({ name: 'One more label' }) }),
    );
    await view.findByText(m.library_subject_label_capacity());
    await expect(context.canvasElement.querySelectorAll('[data-subject-label-chip]')).toHaveLength(32);
  },
};

export const PickerPages: Story = {
  render: () => <SubjectLabelStory count={0} />,
  play: async (context) => {
    await pageReady(context);
    const view = within(context.canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.library_subject_label_add() }));
    await userEvent.click(await view.findByRole('button', { name: m.library_label_more() }));
    await expect(await view.findByRole('button', { name: 'Empty label' })).toBeVisible();
    await userEvent.type(view.getByRole('textbox', { name: m.library_subject_label_name() }), 'Reading');
    await expect(await view.findByRole('button', { name: 'Reading list' })).toBeVisible();
    await expect(view.queryByRole('button', { name: 'Empty label' })).not.toBeInTheDocument();
  },
};
