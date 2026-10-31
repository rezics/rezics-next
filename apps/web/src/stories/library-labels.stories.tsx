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

async function openAction(
  context: { canvasElement: HTMLElement },
  operation: 'rename' | 'delete',
  name = 'Winter reads',
) {
  const view = within(context.canvasElement);
  await userEvent.click(await view.findByRole('button', { name: m.library_label_actions({ name }) }));
  const sheet = window.matchMedia('(max-width: 767px)').matches || window.matchMedia('(pointer: coarse)').matches;
  const menu = await within(document.body).findByRole(
    sheet ? 'dialog' : 'menu',
    sheet ? { name: m.library_labels_heading() } : undefined,
  );
  const title = operation === 'rename' ? m.library_label_rename() : m.library_label_delete();
  await userEvent.click(within(menu).getByRole(sheet ? 'button' : 'menuitem', { name: title }));
  return within(await within(document.body).findByRole('dialog', { name: title }));
}

export const SignedIn: Story = {
  name: 'Signed In',
  play: async (context) => {
    await pageReady(context);
    const view = within(context.canvasElement);
    const link = await view.findByRole('link', { name: 'Winter reads' });
    await expect(link.closest('li')!.querySelector('input')).toBeNull();
    await expect(view.getByRole('button', { name: m.library_label_actions({ name: 'Winter reads' }) })).toBeVisible();
  },
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-labels']} labelsFixture="catalogue" />,
};
export const SignedOut: Story = {
  name: 'Signed Out',
  play: async (context) => {
    await pageReady(context);
    const main = within(context.canvasElement).getByRole('main');
    await expect(within(main).getAllByText(m.library_sign_in(), { exact: true })).toHaveLength(1);
    await expect(within(main).getByRole('link', { name: m.library_sign_in() })).toHaveAttribute(
      'href',
      '/auth/sign-in?return_to=%2Fen%2Flibrary%2Flabels',
    );
  },
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
    const dialog = await openAction(context, 'rename');
    const rename = dialog.getByRole('button', { name: m.library_label_rename() });
    const field = dialog.getByRole('textbox');
    await userEvent.clear(field);
    await userEvent.type(field, 'Outdated draft');
    await userEvent.click(rename);
    await expect(await dialog.findByRole('alert')).toHaveTextContent(m.library_label_stale());
    await expect(field).toHaveValue('Outdated draft');
    await expect(view.getByRole('link', { name: 'Winter reads' })).toBeVisible();
  },
};
export const Undo: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-labels']} labelsFixture="undo" />,
  play: async (context) => {
    await pageReady(context);
    const view = within(context.canvasElement);
    const confirmation = await openAction(context, 'delete');
    await userEvent.click(confirmation.getByRole('button', { name: m.library_label_delete() }));
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
    const confirmation = await openAction(context, 'delete');
    await userEvent.click(confirmation.getByRole('button', { name: m.library_label_delete() }));
    await waitFor(() => expect(context.canvasElement.querySelector('form[role="status"]')).not.toBeNull());
    const undo = context.canvasElement.querySelector<HTMLFormElement>('form[role="status"]')!;
    const guard = new FormData(undo);
    const dialog = await openAction(context, 'rename', '読み返したい本 · Books to revisit');
    const rename = dialog.getByRole('button', { name: m.library_label_rename() });
    const field = dialog.getByRole('textbox');
    await userEvent.clear(field);
    await userEvent.type(field, 'Changed while open');
    await userEvent.click(rename);
    await expect(await dialog.findByRole('alert')).toHaveTextContent(m.library_label_stale());
    await expect(field).toHaveValue('Changed while open');
    await userEvent.click(dialog.getByRole('button', { name: m.action_cancel() }));
    const retained = context.canvasElement.querySelector<HTMLFormElement>('form[role="status"]')!;
    for (const key of ['id', 'library_label_revision', 'idempotencyKey'])
      await expect(new FormData(retained).get(key)).toBe(guard.get(key));
    await userEvent.click(within(retained).getByRole('button', { name: m.library_label_undo() }));
    await expect(await view.findByRole('link', { name: 'Winter reads' })).toBeVisible();
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

async function openPhoneLabelForm(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const view = within(context.canvasElement);
  const trigger = await view.findByRole('button', { name: m.library_subject_label_add() });
  await waitFor(() =>
    expect(context.canvasElement.querySelector('[data-subject-label-picker]')).not.toBeInTheDocument(),
  );
  await userEvent.click(trigger);
  const input = (await view.findByRole('textbox', {
    name: m.library_subject_label_name(),
  })) as HTMLInputElement;
  await expect(input).toBeVisible();
  await expect(input).toBeRequired();
  const form = input.form!;
  await expect(form.checkValidity()).toBe(false);
  await userEvent.click(within(form).getByRole('button', { name: m.library_subject_label_add() }));
  await expect(input).toHaveValue('');
  await expect(input.validity.valueMissing).toBe(true);
  await userEvent.type(input, 'One more label');
  await expect(form.checkValidity()).toBe(true);
  const create = await within(form).findByRole('button', {
    name: m.library_subject_label_create({ name: 'One more label' }),
  });
  await expect(create).toBeVisible();
  await expect(create).toBeEnabled();
  return { view, trigger, input, form, create };
}

export const PhoneBeforeCapacity: Story = {
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => <SubjectLabelStory count={31} />,
  play: async (context) => {
    const { trigger, form } = await openPhoneLabelForm(context);
    await expect(context.canvasElement.querySelectorAll('[data-subject-label-chip]')).toHaveLength(31);
    await userEvent.click(within(form).getByRole('button', { name: m.library_collection_cancel() }));
    await waitFor(() =>
      expect(context.canvasElement.querySelector('[data-subject-label-picker]')).not.toBeInTheDocument(),
    );
    await expect(trigger).toHaveFocus();
    await userEvent.click(trigger);
    const input = await within(context.canvasElement).findByRole('textbox', {
      name: m.library_subject_label_name(),
    });
    await expect(input).toHaveValue('');
    await expect(input).toBeRequired();
  },
};

export const PhoneCapacity: Story = {
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => <SubjectLabelStory count={32} />,
  play: async (context) => {
    const { view, input, create } = await openPhoneLabelForm(context);
    await userEvent.click(create);
    await view.findByText(m.library_subject_label_capacity());
    await expect(context.canvasElement.querySelectorAll('[data-subject-label-chip]')).toHaveLength(32);
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('One more label');
  },
};

export const RenameSelected: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-labels']} labelsFixture="catalogue" />,
  play: async (context) => {
    await pageReady(context);
    const dialog = await openAction(context, 'rename');
    const input = dialog.getByRole('textbox', { name: m.library_label_name() });
    await expect(input).toHaveValue('Winter reads');
    await userEvent.clear(input);
    await expect(input).toBeInvalid();
    await userEvent.click(dialog.getByRole('button', { name: m.action_cancel() }));
    await expect(within(document.body).queryByRole('dialog', { name: m.library_label_rename() })).toBeNull();
  },
};

export const DeleteConfirmation: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-labels']} labelsFixture="catalogue" />,
  play: async (context) => {
    await pageReady(context);
    const dialog = await openAction(context, 'delete');
    await expect(dialog.getByText(m.library_label_delete_confirmation({ name: 'Winter reads' }))).toBeVisible();
    await userEvent.click(dialog.getByRole('button', { name: m.action_cancel() }));
    await expect(within(context.canvasElement).getByRole('link', { name: 'Winter reads' })).toBeVisible();
  },
};
