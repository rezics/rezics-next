import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { PageStory, PatternStory, libraryHeadingReady, pagePaths, pageReady } from './page';
import { LabelsPageView } from '../library/labels-page';
import type { LabelsPage } from '../library/labels-read';
import { getLocale } from '../paraglide/runtime.js';
import { labelOperations } from '../kernel/fake/library-labels';
import { setFakeAdmitted } from '../kernel/fake';
import { setLibraryLabelStorySizes } from '../kernel/fake/library-label-assignments';
import { unprofiledSubjectId } from '../kernel/fake/library-unprofiled-subject';
import { m } from '../paraglide/messages.js';

const meta = {
  title: 'Library/Labels',
  id: 'pages-library-labels',
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
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

async function labelsReady(context: { canvasElement: HTMLElement }) {
  await libraryHeadingReady(context, m.library_labels_heading);
}

async function openAction(
  context: { canvasElement: HTMLElement },
  operation: 'rename' | 'delete',
  name = 'Winter reads',
) {
  await labelsReady(context);
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
    await labelsReady(context);
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
    await labelsReady(context);
    const main = within(context.canvasElement).getByRole('main');
    await expect(await within(main).findByText(m.library_sign_in(), { exact: true })).toBeVisible();
    expect(within(main).getAllByText(m.library_sign_in(), { exact: true })).toHaveLength(1);
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
    await labelsReady(context);
    await within(context.canvasElement).findByText(m.library_labels_empty());
  },
};
export const NextPage: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-labels']} labelsFixture="next" />,
  play: async (context) => {
    await labelsReady(context);
    const view = within(context.canvasElement);
    await view.findByRole('button', { name: m.library_label_more() });
    async function target(element: HTMLElement) {
      element.scrollIntoView({ block: 'nearest' });
      const bounds = element.getBoundingClientRect();
      await expect(bounds.height).toBeGreaterThanOrEqual(44);
      await expect(bounds.width).toBeGreaterThanOrEqual(44);
      await expect(bounds.left).toBeGreaterThanOrEqual(0);
      await expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
      await expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
      await expect(getComputedStyle(element).whiteSpace).toBe('normal');
    }
    async function focused(element: HTMLElement) {
      await expect(element).toHaveFocus();
      await expect(element.matches(':focus-visible')).toBe(true);
      await expect(parseFloat(getComputedStyle(element).outlineWidth)).toBeGreaterThanOrEqual(2);
      await expect(getComputedStyle(element).outlineStyle).not.toBe('none');
    }
    const prefix = view.getByRole('textbox', { name: m.library_labels_prefix() });
    await userEvent.click(prefix);
    await userEvent.type(prefix, 'Winter');
    await userEvent.tab();
    const filter = view.getByRole('button', { name: m.library_labels_filter() });
    await focused(filter);
    await target(filter);
    await userEvent.keyboard('{Enter}');
    const clear = await view.findByRole('link', { name: m.library_clear_state() });
    await target(clear);
    await expect(view.queryByRole('link', { name: '読み返したい本 · Books to revisit' })).toBeNull();
    await expect(view.getByRole('link', { name: m.library_label_more() })).toHaveAttribute(
      'href',
      expect.stringContaining('q=Winter&cursor='),
    );
    await userEvent.click(clear);
    await view.findByRole('link', { name: '読み返したい本 · Books to revisit' });

    const trigger = view.getByRole('button', { name: m.library_label_actions({ name: 'Winter reads' }) });
    const rename = await openAction(context, 'rename');
    const name = rename.getByRole('textbox', { name: m.library_label_name() });
    await userEvent.click(name);
    await userEvent.tab();
    const cancel = rename.getByRole('button', { name: m.action_cancel() });
    await focused(cancel);
    await target(cancel);
    await userEvent.tab();
    const save = rename.getByRole('button', { name: m.library_label_rename() });
    await focused(save);
    await target(save);
    await userEvent.click(cancel);
    await waitFor(() => expect(trigger).toHaveFocus());

    const edit = await openAction(context, 'rename');
    const draft = edit.getByRole('textbox', { name: m.library_label_name() });
    const longName = '読み返したい本'.repeat(12);
    await userEvent.clear(draft);
    await userEvent.type(draft, longName);
    await userEvent.click(edit.getByRole('button', { name: m.library_label_rename() }));
    await view.findByRole('link', { name: longName });
    const confirmation = await openAction(context, 'delete', longName);
    await expect(confirmation.getByText(m.library_label_delete_confirmation({ name: longName }))).toBeVisible();
    const dialog = within(document.body).getByRole('dialog', { name: m.library_label_delete() });
    await expect(dialog.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    await expect(dialog.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
    await expect(dialog.clientHeight).toBeLessThanOrEqual(window.innerHeight - 32);
    await expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
    await expect(getComputedStyle(dialog).overflowY).toBe('auto');
    const remove = confirmation.getByRole('button', { name: m.library_label_delete() });
    await target(remove);
    await target(confirmation.getByRole('button', { name: m.action_cancel() }));
    await userEvent.click(remove);
    const status = await view.findByRole('status');
    await expect(status).toHaveTextContent(m.library_label_deleted({ name: longName }));
    const undo = within(status).getByRole('button', { name: m.library_label_undo() });
    await target(undo);
    await userEvent.click(undo);
    await view.findByRole('link', { name: longName });
    const article = context.canvasElement.querySelector('article')!;
    await expect(article.scrollWidth).toBeLessThanOrEqual(article.clientWidth);
    let more = view.getByRole('button', { name: m.library_label_more() });
    await target(more);
    await userEvent.click(more);
    await view.findByText(m.library_labels_page_empty());
    const previous = view.getByRole('button', { name: m.library_labels_previous() });
    await target(previous);
    await userEvent.click(previous);
    await view.findByRole('link', { name: 'Winter reads' });
    more = view.getByRole('button', { name: m.library_label_more() });
    await userEvent.click(more);
    await view.findByText(m.library_labels_page_empty());
    const first = view.getByRole('button', { name: m.library_collections_first_page() });
    await target(first);
    await userEvent.click(first);
    await view.findByRole('link', { name: 'Winter reads' });
  },
};
export const RenameConflict: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-labels']} labelsFixture="conflict" />,
  play: async (context) => {
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
    await labelsReady(context);
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
    await labelsReady(context);
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
    await labelsReady(context);
    await within(context.canvasElement).findByText(m.library_subject_label_no_results());
  },
};

export const LaterPagePrefix: Story = {
  name: 'Empty later page, keep the filter',
  render: () => (
    <PageStory
      visitor="Signed In"
      path={`${pagePaths['library-labels']}?${new URLSearchParams({ q: 'No match %_ + 読書', cursor: 'next-label-page' })}`}
      labelsFixture="catalogue"
    />
  ),
  play: async (context) => {
    await labelsReady(context);
    const view = within(context.canvasElement);
    await view.findByText(m.library_labels_page_empty());
    await expect(view.queryByText(m.library_labels_empty())).toBeNull();
    await expect(view.queryByText(m.library_subject_label_no_results())).toBeNull();
    const first = await view.findByRole('link', { name: m.library_collections_first_page() });
    await expect(first).toHaveAttribute(
      'href',
      `/${getLocale()}/library/labels?${new URLSearchParams({ q: 'No match %_ + 読書' })}`,
    );
    await userEvent.click(first);
    await view.findByText(m.library_subject_label_no_results());
    await expect(view.getByRole('textbox', { name: m.library_labels_prefix() })).toHaveValue('No match %_ + 読書');
  },
};

// Supplied presentation states illustrate recovery only; they do not establish native outcomes.
function RecoveryState({ uncertain = false }: { uncertain?: boolean }) {
  const page: LabelsPage = {
    signedIn: true,
    state: uncertain ? 'loaded' : 'unavailable',
    query: '読み返したい本 · Books to revisit · '.repeat(4),
    operations: ['library_label.list', 'library_label.create'],
    csrfToken: 'illustrative-csrf',
    createKey: '00000000-0000-4000-8000-000000000001',
    undoKey: '00000000-0000-4000-8000-000000000002',
    labels: [],
    next: null,
    feedback: uncertain
      ? {
          ok: false,
          reason: 'unavailable',
          operation: 'create',
          name: '読み返したい本 · Books to revisit · '.repeat(3),
        }
      : { ok: false, reason: 'stale_cursor' },
  };
  return (
    <PatternStory visitor="Signed In" path={pagePaths['library-labels']}>
      <div className="min-w-0 p-4">
        <LabelsPageView page={page} cursor="exact+/old-page==" />
      </div>
    </PatternStory>
  );
}

export const StalePage: Story = {
  name: 'Stale page, restart with the same filter',
  render: () => <RecoveryState />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(await view.findByRole('alert')).toHaveTextContent(m.library_labels_stale_cursor());
    await expect(view.getByRole('link', { name: m.library_collections_first_page() })).toHaveAttribute(
      'href',
      `/${getLocale()}/library/labels?${new URLSearchParams({ q: '読み返したい本 · Books to revisit · '.repeat(4) })}`,
    );
    await expect(view.queryByRole('link', { name: m.subject_view_retry() })).toBeNull();
  },
};

export const UnconfirmedChange: Story = {
  name: 'Unconfirmed create, retained long draft',
  render: () => <RecoveryState uncertain />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(await view.findByRole('alert')).toHaveTextContent(m.library_label_unconfirmed());
    await expect(view.getByRole('textbox', { name: m.library_label_name() })).toHaveValue(
      '読み返したい本 · Books to revisit · '.repeat(3),
    );
    await expect(view.getByRole('button', { name: m.library_label_create() })).toBeEnabled();
    await view.findByText(m.library_labels_page_empty());
  },
};

export const RetainedUndoAfterStale: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-labels']} labelsFixture="conflict" />,
  play: async (context) => {
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
      path={`${pagePaths['library-labels']}?labelRead=unavailable&q=Winter%20%25_&cursor=exact%2B%2Fpage%3D%3D`}
      labelsFixture="catalogue"
    />
  ),
  play: async (context) => {
    await labelsReady(context);
    const view = within(context.canvasElement);
    await view.findAllByText(m.library_labels_unavailable());
    await expect(view.getByRole('alert')).toHaveTextContent(m.library_labels_unavailable());
    await expect(view.getByRole('link', { name: m.subject_view_retry() })).toHaveAttribute(
      'href',
      `/${getLocale()}/library/labels?${new URLSearchParams({ q: 'Winter %_', cursor: 'exact+/page==' })}`,
    );
    await expect(view.queryByText(m.library_labels_empty())).toBeNull();
    await expect(view.queryByText(m.library_subject_label_no_results())).toBeNull();
    await expect(view.queryByRole('link', { name: 'Winter reads' })).toBeNull();
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
    await labelsReady(context);
    await within(context.canvasElement).findByText(m.library_labels_preparing());
  },
};

function SubjectLabelStory({
  count,
  unprofiled = false,
  unassignFailure = false,
}: {
  count: number;
  unprofiled?: boolean;
  unassignFailure?: boolean;
}) {
  setFakeAdmitted([
    'personal_library',
    'reading_progress',
    'library_label.assignment_list',
    ...labelOperations,
    'library_label.assign',
    'library_label.unassign',
  ]);
  setLibraryLabelStorySizes({ subject: count, unassignFailure });
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
    await userEvent.click(await view.findByRole('button', { name: m.library_subject_label_review_apply() }));
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
    await userEvent.click(await view.findByRole('button', { name: m.library_subject_label_review_apply() }));
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

async function openLabelForm(context: { canvasElement: HTMLElement }) {
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

export const PickerCancelAndReopen: Story = {
  render: () => <SubjectLabelStory count={31} />,
  play: async (context) => {
    const { trigger, form } = await openLabelForm(context);
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

export const CapacityRetainsDraft: Story = {
  render: () => <SubjectLabelStory count={32} />,
  play: async (context) => {
    const { view, input, create } = await openLabelForm(context);
    await userEvent.click(create);
    await userEvent.click(await view.findByRole('button', { name: m.library_subject_label_review_apply() }));
    await view.findByText(m.library_subject_label_capacity());
    await expect(context.canvasElement.querySelectorAll('[data-subject-label-chip]')).toHaveLength(32);
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('One more label');
  },
};

export const RenameSelected: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-labels']} labelsFixture="catalogue" />,
  play: async (context) => {
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
    const dialog = await openAction(context, 'delete');
    await expect(dialog.getByText(m.library_label_delete_confirmation({ name: 'Winter reads' }))).toBeVisible();
    await userEvent.click(dialog.getByRole('button', { name: m.action_cancel() }));
    await expect(within(context.canvasElement).getByRole('link', { name: 'Winter reads' })).toBeVisible();
  },
};

function LabelDirectoryStory() {
  setFakeAdmitted([
    ...labelOperations,
    'personal_library',
    'reading_progress',
    'library_label.assignment_list',
    'library_label.unassign',
  ]);
  setLibraryLabelStorySizes({ subject: 3, shelf: 3, scenario: 'reading' });
  return <PageStory visitor="Signed In" path={pagePaths['library-labels']} labelsFixture="directory" />;
}

export const DirectoryToMembers: Story = {
  name: 'Private directory to label members',
  render: () => <LabelDirectoryStory />,
  play: async (context) => {
    await labelsReady(context);
    const view = within(context.canvasElement);
    await expect(view.getByText(m.library_labels_directory_count({ count: 5 }))).toBeVisible();
    const label = view.getByRole('link', { name: 'Winter reads' });
    await expect(label).toHaveAttribute('href', `/${getLocale()}/library?label=01a17a3b-6ef3-71cc-80d0-f4ccb5814bbf`);
    await userEvent.click(label);
    await view.findByRole('heading', { level: 1, name: 'Winter reads' });
    await expect(await view.findByText('The Left Hand of Darkness')).toBeVisible();
    await expect(view.getByText(m.library_labels_member_page_count({ count: 3 }))).toBeVisible();
    const detail = context.canvasElement.querySelector('[data-label-detail-navigation]')!;
    await userEvent.click(within(detail as HTMLElement).getByRole('link', { name: m.library_labels_heading() }));
    await labelsReady(context);
    await expect(view.getByRole('link', { name: 'Family read-alouds' })).toBeVisible();
  },
};

export const RenamedWhileEditing: Story = {
  name: 'Rename recovery keeps the draft beside the current name',
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-labels']} labelsFixture="rename-recovery" />,
  play: async (context) => {
    const dialog = await openAction(context, 'rename');
    const field = dialog.getByRole('textbox', { name: m.library_label_name() });
    await userEvent.clear(field);
    await userEvent.type(field, 'My winter reading');
    await userEvent.click(dialog.getByRole('button', { name: m.library_label_rename() }));
    await expect(await dialog.findByRole('alert')).toHaveTextContent(m.library_label_stale());
    await expect(field).toHaveValue('My winter reading');
    await expect(
      dialog.getByText(m.library_labels_current_name({ name: 'Winter reading · shared update' })),
    ).toBeVisible();
    await expect(
      within(context.canvasElement).getByRole('link', { name: 'Winter reading · shared update' }),
    ).toBeVisible();
  },
};

export const UncertainRename: Story = {
  name: 'Uncertain rename retries the original change',
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-labels']} labelsFixture="uncertain-rename" />,
  play: async (context) => {
    const dialog = await openAction(context, 'rename');
    const input = dialog.getByRole('textbox', { name: m.library_label_name() });
    await userEvent.clear(input);
    await userEvent.type(input, 'Long winter evenings');
    const form = (input as HTMLInputElement).form!;
    const original = new FormData(form);
    await userEvent.click(dialog.getByRole('button', { name: m.library_label_rename() }));
    await expect(await dialog.findByRole('alert')).toHaveTextContent(m.library_label_unconfirmed());
    await expect(input).toHaveValue('Long winter evenings');
    await expect(new FormData(form).get('idempotencyKey')).toBe(original.get('idempotencyKey'));
    await expect(new FormData(form).get('library_label_revision')).toBe(original.get('library_label_revision'));
    await userEvent.click(dialog.getByRole('button', { name: m.library_label_rename() }));
    await waitFor(() =>
      expect(within(document.body).queryByRole('dialog', { name: m.library_label_rename() })).toBeNull(),
    );
    await expect(within(context.canvasElement).getByRole('link', { name: 'Long winter evenings' })).toBeVisible();
  },
};

export const UncertainDeletion: Story = {
  name: 'Missing label keeps the original delete until its receipt returns',
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-labels']} labelsFixture="uncertain-delete" />,
  play: async (context) => {
    const dialog = await openAction(context, 'delete');
    await userEvent.click(dialog.getByRole('button', { name: m.library_label_delete() }));
    await expect(await dialog.findByRole('alert')).toHaveTextContent(m.library_label_unconfirmed());
    await expect(dialog.getByText(m.library_labels_recovery_off_page())).toBeVisible();
    await expect(within(context.canvasElement).queryByRole('link', { name: 'Winter reads' })).toBeNull();
    await userEvent.click(dialog.getByRole('button', { name: m.library_label_delete() }));
    await waitFor(() =>
      expect(within(document.body).queryByRole('dialog', { name: m.library_label_delete() })).toBeNull(),
    );
    const undo = context.canvasElement.querySelector<HTMLFormElement>('form[role="status"]')!;
    await expect(undo).toBeVisible();
    await expect(new FormData(undo).get('library_label_revision')).toBe('73');
    await userEvent.click(within(undo).getByRole('button', { name: m.library_label_undo() }));
    await expect(await within(context.canvasElement).findByRole('link', { name: 'Winter reads' })).toBeVisible();
  },
};

export const DeliberateAssignmentAndRemoval: Story = {
  name: 'Choose, edit, assign and deliberately remove a private label',
  render: () => <SubjectLabelStory count={0} />,
  play: async (context) => {
    await pageReady(context);
    const view = within(context.canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.library_subject_label_add() }));
    const input = await view.findByRole('textbox', { name: m.library_subject_label_name() });
    await userEvent.type(input, 'Quiet weekends');
    await userEvent.click(
      await view.findByRole('button', { name: m.library_subject_label_create({ name: 'Quiet weekends' }) }),
    );
    let review = await view.findByRole('region', { name: m.library_subject_label_review_heading() });
    await expect(within(review).getByText('Quiet weekends', { exact: true })).toBeVisible();
    await expect(view.queryByRole('link', { name: 'Quiet weekends' })).toBeNull();
    await userEvent.click(within(review).getByRole('button', { name: m.library_subject_label_review_edit() }));
    await expect(await view.findByRole('textbox', { name: m.library_subject_label_name() })).toHaveValue(
      'Quiet weekends',
    );
    await userEvent.click(
      await view.findByRole('button', { name: m.library_subject_label_create({ name: 'Quiet weekends' }) }),
    );
    review = await view.findByRole('region', { name: m.library_subject_label_review_heading() });
    await userEvent.click(within(review).getByRole('button', { name: m.library_subject_label_review_discard() }));
    await expect(view.queryByRole('link', { name: 'Quiet weekends' })).toBeNull();
    await userEvent.click(
      await view.findByRole('button', { name: m.library_subject_label_create({ name: 'Quiet weekends' }) }),
    );
    await userEvent.click(await view.findByRole('button', { name: m.library_subject_label_review_apply() }));
    await expect(await view.findByRole('link', { name: 'Quiet weekends' })).toBeVisible();
    const remove = view.getByRole('button', { name: m.library_subject_label_remove({ name: 'Quiet weekends' }) });
    await userEvent.click(remove);
    let removal = context.canvasElement.querySelector<HTMLElement>('[data-subject-label-review-card]')!;
    await expect(removal).toBeVisible();
    await expect(within(removal).getByText('Quiet weekends', { exact: true })).toBeVisible();
    await userEvent.click(within(removal).getByRole('button', { name: m.library_subject_label_review_keep() }));
    await expect(view.getByRole('link', { name: 'Quiet weekends' })).toBeVisible();
    await userEvent.click(remove);
    removal = context.canvasElement.querySelector<HTMLElement>('[data-subject-label-review-card]')!;
    await userEvent.click(within(removal).getByRole('button', { name: m.library_subject_label_review_remove() }));
    await expect(await view.findByRole('button', { name: m.library_subject_label_undo() })).toBeVisible();
    await expect(view.queryByRole('link', { name: 'Quiet weekends' })).toBeNull();
  },
};

export const UncertainRelationshipRemoval: Story = {
  name: 'Uncertain removal retains the relationship until the original retry succeeds',
  render: () => <SubjectLabelStory count={3} unassignFailure />,
  play: async (context) => {
    await pageReady(context);
    const view = within(context.canvasElement);
    await userEvent.click(
      await view.findByRole('button', { name: m.library_subject_label_remove({ name: 'Reading list' }) }),
    );
    const review = context.canvasElement.querySelector<HTMLElement>('[data-subject-label-review-card]')!;
    await userEvent.click(within(review).getByRole('button', { name: m.library_subject_label_review_remove() }));
    await expect(await view.findByText(m.library_subject_label_unavailable())).toBeVisible();
    await expect(view.getByRole('link', { name: 'Reading list' })).toBeVisible();
    await userEvent.click(await view.findByRole('button', { name: m.library_subject_label_retry_original() }));
    await expect(await view.findByRole('button', { name: m.library_subject_label_undo() })).toBeVisible();
    await expect(view.queryByRole('link', { name: 'Reading list' })).toBeNull();
  },
};
