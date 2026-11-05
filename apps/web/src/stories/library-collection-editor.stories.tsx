import type { Meta, StoryObj } from '@storybook/react-vite';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Suspense } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { CollectionPage } from '../library/collection-page';
import { collectionPageQuery, readCollectionPage } from '../library/collection-queries';
import { CollectionFilters } from '../library/collection-filters';
import {
  completePendingCollectionSave,
  collectionStoryDestinationId,
  setCollectionStoryMode,
  type CollectionStoryMode,
} from '../kernel/fake/collection-page-stories';
import { m } from '../paraglide/messages.js';
import { PageStory, PatternStory, pagePaths, pageReady } from './page';

const meta = {
  title: 'Patterns/Collection Editor',
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'The actual owner editor: Edit enters a local draft, keyboard buttons and drag handles reorder only loaded occurrences, Save sends current native commands, and Cancel discards the draft. Move to start/end are immediate native boundary commands after saving or canceling drafts; an uncertain result retains the same request for retry. Writes are independently receipted. Existing imported cover and exact Type choices use the current native metadata command. Selected removal and cross-Collection transfer use the delivered native atomic commands on Save; built-in dynamic rules remain immutable.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const id = pagePaths['library-collection'].split('/').at(-1)!;

function EditorRegion({ cursor }: { cursor?: string | undefined }) {
  const query = collectionPageQuery(id, cursor, 'session');
  const { data } = useSuspenseQuery(query);
  if ('preparing' in data) throw new Error('Expected a curated Collection');
  return (
    <CollectionPage
      page={data}
      cursor={cursor}
      queryKey={query.queryKey}
      readEditorPage={async () => {
        const editable = await readCollectionPage({
          data: { id, credentialMode: 'session', editor: true, ...(cursor ? { cursor } : {}) },
        });
        if ('preparing' in editable) throw new Error('Expected a curated Collection');
        return editable;
      }}
      refreshPage={async () => {
        const refreshed = await readCollectionPage({
          data: { id, credentialMode: 'session', ...(cursor ? { cursor } : {}) },
        });
        if ('preparing' in refreshed) throw new Error('Expected a curated Collection');
        return refreshed;
      }}
    />
  );
}
function renderEditor(mode: CollectionStoryMode = 'private', cursor?: string) {
  setCollectionStoryMode(mode, true);
  return (
    <PatternStory visitor="Signed In" path={pagePaths['library-collection']}>
      <Suspense fallback={null}>
        <div className="w-full p-4">
          <EditorRegion cursor={cursor} />
        </div>
      </Suspense>
    </PatternStory>
  );
}
async function openEditor(canvasElement: HTMLElement, details = true) {
  const canvas = within(canvasElement);
  await canvas.findByRole('heading', { level: 1, name: 'Books I come back to' });
  const trigger = canvas.getByRole('button', { name: m.library_collection_actions() });
  await userEvent.click(trigger);
  const menu = await menuForTrigger(trigger, m.library_collection_actions());
  const edit = menu.getByText(m.library_collection_edit(), { exact: true });
  await userEvent.click(edit);
  await canvas.findByRole('button', { name: m.library_collection_save() });
  if (details) await userEvent.click(canvas.getByText(m.library_collection_details(), { selector: 'summary' }));
  if (details) await canvas.findByRole('textbox', { name: m.library_collection_title() });
  return canvas;
}
function minimumActionTarget() {
  return window.matchMedia('(max-width: 767px)').matches || window.matchMedia('(pointer: coarse)').matches ? 44 : 36;
}

async function menuForTrigger(trigger: HTMLElement, title: string) {
  const view = trigger.ownerDocument.defaultView!;
  const sheet = view.matchMedia('(max-width: 767px)').matches || view.matchMedia('(pointer: coarse)').matches;
  const panel = await waitFor(() => {
    if (sheet) {
      const dialog = within(trigger.ownerDocument.body).getByRole('dialog', { name: title });
      expect(dialog).toBeVisible();
      return dialog;
    }
    const controlledId = trigger.getAttribute('aria-controls');
    expect(controlledId).toBeTruthy();
    const menu = trigger.ownerDocument.getElementById(controlledId!);
    expect(menu).toHaveAttribute('role', 'menu');
    expect(menu).toHaveAttribute('aria-labelledby', trigger.id);
    expect(menu).toBeVisible();
    return menu!;
  });
  return within(panel);
}
function firstRow(canvasElement: HTMLElement) {
  const row = canvasElement.querySelector<HTMLElement>('[data-collection-members] [data-slot="list-row"]');
  if (!row) throw new Error('Missing member row');
  return row;
}
function rowAction(row: HTMLElement, action: string) {
  const title = within(row).getByRole('link').textContent!;
  const position = Array.from(row.parentElement!.children).indexOf(row) + 1;
  const context = m.library_member_occurrence({ title, position });
  return within(row).getByRole('button', { name: `${action}: ${context}` });
}

async function openNote(row: HTMLElement) {
  const details = row.querySelector<HTMLDetailsElement>('[data-collection-note-editor]')!;
  if (!details.open) await userEvent.click(details.querySelector('summary')!);
}

export const OwnerEdit: Story = {
  name: 'Owner edit from browse route',
  parameters: { layout: 'fullscreen' },
  render: () => {
    setCollectionStoryMode('private', true);
    return <PageStory visitor="Signed In" path={pagePaths['library-collection']} credentialMode="session" />;
  },
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const canvas = within(canvasElement);
    await canvas.findByRole('button', { name: m.account_menu() });
    const main = within(await canvas.findByRole('main'));
    await main.findByRole('heading', { level: 1, name: 'Books I come back to' });
    const trigger = main.getByRole('button', { name: m.library_collection_actions() });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    const menu = await menuForTrigger(trigger, m.library_collection_actions());
    await userEvent.click(menu.getByText(m.library_collection_edit(), { exact: true }));
    await main.findByRole('button', { name: m.library_collection_save() });
    await userEvent.click(main.getByText(m.library_collection_details(), { selector: 'summary' }));
    await main.findByRole('textbox', { name: m.library_collection_title() });
    await expect(main.getAllByRole('checkbox')).toHaveLength(4);
    const cancel = main.getByRole('button', { name: m.library_collection_cancel() });
    cancel.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(main.queryByRole('button', { name: m.library_collection_save() })).toBeNull());
    await expect(main.getByRole('heading', { level: 1, name: 'Books I come back to' })).toBeVisible();
  },
};
export const Details: Story = {
  render: () => renderEditor(),
  play: async ({ canvasElement }) => {
    await openEditor(canvasElement);
  },
};
export const Members: Story = {
  render: () => renderEditor(),
  play: async ({ canvasElement }) => {
    const canvas = await openEditor(canvasElement, false);
    await expect(canvas.getAllByRole('checkbox')).toHaveLength(4);
    for (const row of canvasElement.querySelectorAll<HTMLElement>('[data-collection-members] [data-member]')) {
      await openNote(row);
      const label = within(row).getByText(m.library_member_note(), { selector: 'label', exact: true });
      const note = within(row).getByRole('textbox');
      await expect(label).toBeVisible();
      await expect(label).toHaveAttribute('for', note.id);
      await expect(note).toHaveAttribute('id', `collection-member-note-${row.dataset.member}`);
      await userEvent.click(row.querySelector('[data-collection-note-editor] summary')!);
    }
  },
};
export const RowActionContext: Story = {
  render: () => renderEditor('notes-duplicates'),
  play: async ({ canvasElement }) => {
    const canvas = await openEditor(canvasElement);
    const rows = Array.from(canvasElement.querySelectorAll<HTMLElement>('[data-collection-members] [data-member]'));
    await expect(rows).toHaveLength(5);
    const actions = [
      m.library_collection_actions(),
      m.library_member_move_up(),
      m.library_member_move_down(),
      m.library_member_remove(),
    ];
    for (const action of actions) {
      const names = new Set<string>();
      for (const row of rows) {
        const control = rowAction(row, action);
        const name = control.getAttribute('aria-label')!;
        names.add(name);
        await expect(control).toHaveAttribute('title', name);
        const minimumTarget = minimumActionTarget();
        await expect(control.getBoundingClientRect().width).toBeGreaterThanOrEqual(minimumTarget);
        await expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(minimumTarget);
      }
      await expect(names.size).toBe(rows.length);
    }
    await expect(rowAction(rows[0]!, m.library_member_move_up())).toBeDisabled();
    await expect(rowAction(rows.at(-1)!, m.library_member_move_down())).toBeDisabled();
    const duplicate = rows[1]!;
    await openNote(duplicate);
    const originalNote = within(duplicate).getByRole('textbox') as HTMLTextAreaElement;
    const noteId = originalNote.id;
    const noteValue = originalNote.value;
    await userEvent.click(within(duplicate).getByRole('checkbox'));
    const trigger = rowAction(duplicate, m.library_collection_actions());
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    const menu = await menuForTrigger(trigger, trigger.getAttribute('aria-label')!);
    const copy = menu.getByText(m.library_collection_copy(), { exact: true });
    await expect(copy).toBeVisible();
    await expect(menu.queryByText(m.library_collection_edit(), { exact: true })).toBeNull();
    await expect(menu.queryByText(m.report_action(), { exact: true })).toBeNull();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(copy).not.toBeVisible());
    await waitFor(() => expect(trigger).toHaveFocus());
    await expect(within(duplicate).getByRole('textbox')).toHaveValue(noteValue);
    rowAction(duplicate, m.library_member_move_up()).focus();
    await userEvent.keyboard('{Enter}');
    await expect(firstRow(canvasElement)).toHaveAttribute('data-member', duplicate.dataset.member);
    await expect(within(firstRow(canvasElement)).getByRole('checkbox')).toBeChecked();
    await expect(within(firstRow(canvasElement)).getByRole('textbox')).toHaveAttribute('id', noteId);
    await expect(within(firstRow(canvasElement)).getByRole('textbox')).toHaveValue(noteValue);
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_cancel() }));
    await openEditor(canvasElement);
    await expect(firstRow(canvasElement)).toHaveAttribute('data-member', rows[0]!.dataset.member);
    await openNote(firstRow(canvasElement));
    await expect(within(firstRow(canvasElement)).getByRole('textbox')).toHaveValue('');
  },
};
export const Selection: Story = {
  render: () => renderEditor(),
  play: async ({ canvasElement }) => {
    const canvas = await openEditor(canvasElement, false);
    await userEvent.click(canvas.getAllByRole('checkbox')[0]!);
    await userEvent.click(canvas.getAllByRole('checkbox')[1]!);
    await expect(canvas.getByText(m.library_collection_selection_count({ count: 2 }))).toBeVisible();
  },
};
export const Reordering: Story = {
  render: () => renderEditor(),
  play: async ({ canvasElement }) => {
    const canvas = await openEditor(canvasElement, false);
    const row = firstRow(canvasElement);
    const controls = [m.library_member_move_up(), m.library_member_move_down(), m.library_member_remove()].map((name) =>
      rowAction(row, name),
    );
    const minimumTarget = minimumActionTarget();
    for (const control of controls) {
      const target = control.getBoundingClientRect();
      await expect(target.width).toBeGreaterThanOrEqual(minimumTarget);
      await expect(target.height).toBeGreaterThanOrEqual(minimumTarget);
    }
    for (let index = 1; index < controls.length; index++) {
      const previous = controls[index - 1]!.getBoundingClientRect();
      const current = controls[index]!.getBoundingClientRect();
      const gap = Math.max(current.left - previous.right, previous.left - current.right, current.top - previous.bottom);
      await expect(gap).toBeGreaterThanOrEqual(index === 2 && current.top < previous.bottom ? 16 : 8);
    }
    const down = rowAction(firstRow(canvasElement), m.library_member_move_down());
    down.focus();
    await expect(down).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(firstRow(canvasElement)).toHaveTextContent('The Tale of Genji');
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_save() }));
    await waitFor(() => expect(canvas.queryByRole('textbox', { name: m.library_collection_title() })).toBeNull());
    await expect(firstRow(canvasElement)).toHaveTextContent('The Tale of Genji');
    await openEditor(canvasElement, false);
    await expect(firstRow(canvasElement)).toHaveTextContent('The Tale of Genji');
    await expect(canvas.getByRole('button', { name: m.library_collection_save() })).toBeVisible();
  },
};
export const Note: Story = {
  render: () => renderEditor(),
  play: async ({ canvasElement }) => {
    const canvas = await openEditor(canvasElement);
    await openNote(firstRow(canvasElement));
    await userEvent.type(within(firstRow(canvasElement)).getByRole('textbox'), 'A draft note');
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_cancel() }));
    await expect(canvas.queryByDisplayValue('A draft note')).toBeNull();
    await openEditor(canvasElement);
    await openNote(firstRow(canvasElement));
    await expect(within(firstRow(canvasElement)).getByRole('textbox')).toHaveValue('');
    await userEvent.type(within(firstRow(canvasElement)).getByRole('textbox'), 'A saved note');
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_save() }));
    await waitFor(() => expect(canvas.queryByRole('textbox', { name: m.library_collection_title() })).toBeNull());
    await expect(await canvas.findByText('A saved note', { exact: true })).toBeVisible();
    await openEditor(canvasElement);
    await openNote(firstRow(canvasElement));
    await expect(within(firstRow(canvasElement)).getByRole('textbox')).toHaveValue('A saved note');
  },
};
export const SavePending: Story = {
  render: () => renderEditor('pending-save'),
  play: async ({ canvasElement }) => {
    const canvas = await openEditor(canvasElement);
    await userEvent.type(canvas.getByRole('textbox', { name: m.library_collection_title() }), ' — revised');
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_save() }));
    await expect(await canvas.findByRole('button', { name: m.library_collection_save_pending() })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: m.library_collection_cancel() })).toBeDisabled();
  },
  beforeEach: () => () => completePendingCollectionSave(),
};
export const SaveError: Story = {
  render: () => renderEditor('failed-save'),
  play: async ({ canvasElement }) => {
    const canvas = await openEditor(canvasElement);
    await userEvent.type(canvas.getByRole('textbox', { name: m.library_collection_title() }), ' — revised');
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_save() }));
    await expect(await canvas.findByRole('alert')).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: m.library_collection_title() })).toHaveValue(
      'Books I come back to — revised',
    );
  },
};
export const DynamicRule: Story = {
  render: () => (
    <PatternStory>
      <section className="space-y-4 p-4">
        <h1>{m.library_dynamic_liked()}</h1>
        <p>{m.library_collection_builtin_rule()}</p>
        <CollectionFilters
          id="dynamic-liked"
          type="schema:Book"
          properties={[{ id: 'schema:wordCount', label: 'Word count', datatype: 'quantity' }]}
          params={{ selected: {}, selectedLabels: {}, ranges: {}, ignored: [] }}
        />
      </section>
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole('button', { name: m.collection_filters() }));
    await expect(await within(document.body).findByRole('button', { name: m.collection_filter_apply() })).toBeVisible();
  },
};

export const Presentation: Story = {
  render: () => renderEditor('presentation'),
  play: async ({ canvasElement }) => {
    const canvas = await openEditor(canvasElement);
    const kind = canvas.getByRole('combobox', { name: m.library_collection_kind() });
    await expect(kind).toHaveValue('schema:Book');
    await userEvent.selectOptions(kind, '');
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.subject_cover() }), '');
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_save() }));
    await waitFor(() => expect(canvas.queryByRole('textbox', { name: m.library_collection_title() })).toBeNull());
    await openEditor(canvasElement);
    await expect(canvas.getByRole('combobox', { name: m.library_collection_kind() })).toHaveValue('');
    await expect(canvas.getByRole('combobox', { name: m.subject_cover() })).toHaveValue('');
    await expect(canvas.getByText(m.library_collection_kind_pending())).toBeVisible();
  },
};

export const RemovalAndUndo: Story = {
  render: () => renderEditor(),
  play: async ({ canvasElement }) => {
    const canvas = await openEditor(canvasElement);
    await userEvent.type(canvas.getByRole('textbox', { name: m.library_collection_title() }), ' — revised');
    await userEvent.click(rowAction(firstRow(canvasElement), m.library_member_remove()));
    await userEvent.click(rowAction(firstRow(canvasElement), m.library_member_remove()));
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_save() }));
    await waitFor(() => expect(canvas.queryByRole('textbox', { name: m.library_collection_title() })).toBeNull());
    await expect(canvas.queryByText('Snow Country', { exact: true })).toBeNull();
    await expect(canvas.queryByText('The Tale of Genji', { exact: true })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: `${m.editor_undo()} 1` }));
    await expect(await canvas.findByText('Snow Country', { exact: true })).toBeVisible();
  },
};

export const ExpiredUndo: Story = {
  render: () => renderEditor('expired-undo'),
  play: async ({ canvasElement }) => {
    const canvas = await openEditor(canvasElement);
    await userEvent.click(rowAction(firstRow(canvasElement), m.library_member_remove()));
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_save() }));
    await userEvent.click(await canvas.findByRole('button', { name: m.editor_undo() }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.library_restore_expired());
    await expect(canvas.queryByText('Snow Country', { exact: true })).toBeNull();
  },
};

export const SelectionUnavailable: Story = {
  render: () => renderEditor('failed-save'),
  play: async ({ canvasElement }) => {
    const canvas = await openEditor(canvasElement);
    await userEvent.click(canvas.getAllByRole('checkbox')[0]!);
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_remove_selected() }));
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_save() }));
    await expect(await canvas.findByRole('alert')).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.library_collection_remove_selected() })).toBeDisabled();
    await expect(canvas.getByText(m.library_collection_batch_unavailable())).toBeVisible();
    await expect(canvas.getByText(m.library_collection_move_unavailable())).toBeVisible();
  },
};

export const SelectedRemoval: Story = {
  render: () => renderEditor(),
  play: async ({ canvasElement }) => {
    const canvas = await openEditor(canvasElement);
    await userEvent.click(canvas.getAllByRole('checkbox')[0]!);
    await userEvent.click(canvas.getAllByRole('checkbox')[1]!);
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_remove_selected() }));
    await expect(canvas.getAllByRole('checkbox')).toHaveLength(2);
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_cancel() }));
    await openEditor(canvasElement);
    await expect(canvas.getAllByRole('checkbox')).toHaveLength(4);
    await userEvent.click(canvas.getAllByRole('checkbox')[0]!);
    await userEvent.click(canvas.getAllByRole('checkbox')[1]!);
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_remove_selected() }));
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_save() }));
    await waitFor(() => expect(canvas.queryByRole('textbox', { name: m.library_collection_title() })).toBeNull());
    await expect(canvas.getAllByRole('button', { name: new RegExp(m.editor_undo()) })).toHaveLength(2);
    await userEvent.click(canvas.getAllByRole('button', { name: new RegExp(m.editor_undo()) })[0]!);
    await expect(await canvas.findByRole('link', { name: 'Snow Country' })).toBeVisible();
    await openEditor(canvasElement);
    await expect(canvas.getAllByRole('checkbox')).toHaveLength(3);
  },
};

export const SelectedMove: Story = {
  render: () => renderEditor(),
  play: async ({ canvasElement }) => {
    const canvas = await openEditor(canvasElement);
    await userEvent.click(canvas.getAllByRole('checkbox')[0]!);
    await userEvent.click(canvas.getAllByRole('checkbox')[1]!);
    const target = canvas.getByRole('combobox', { name: m.library_collection_move_destination() });
    await canvas.findByRole('option', { name: 'Weekend reading' });
    await userEvent.selectOptions(target, collectionStoryDestinationId);
    const move = canvas.getByRole('button', { name: m.library_collection_move_selected() });
    await waitFor(() => expect(move).toBeEnabled());
    await userEvent.click(move);
    await expect(
      canvas.getByText(m.library_collection_move_pending({ count: 2, title: 'Weekend reading' })),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_save() }));
    await waitFor(() => expect(canvas.queryByRole('textbox', { name: m.library_collection_title() })).toBeNull());
    await expect(canvas.queryByText('Snow Country', { exact: true })).toBeNull();
    await openEditor(canvasElement);
    await expect(canvas.getAllByRole('checkbox')).toHaveLength(2);
  },
};

export const AddItems: Story = {
  render: () => renderEditor('empty'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.library_collection_add_items() }));
    await expect(canvas.getByRole('combobox', { name: m.library_collection_find_subject() })).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.library_collection_add_selected() })).toBeDisabled();
  },
};

async function boundaryMenu(canvasElement: HTMLElement) {
  const rows = canvasElement.querySelectorAll<HTMLElement>('[data-collection-members] [data-member]');
  const occurrence = rows[1]!;
  const trigger = rowAction(occurrence, m.library_collection_actions());
  await userEvent.click(trigger);
  return menuForTrigger(trigger, trigger.getAttribute('aria-label')!);
}

export const LaterPageBoundaries: Story = {
  render: () => renderEditor('boundary-later', 'page-two'),
  play: async ({ canvasElement }) => {
    const canvas = await openEditor(canvasElement, false);
    await expect(rowAction(firstRow(canvasElement), m.library_member_move_down())).toBeDisabled();
    const menu = await boundaryMenu(canvasElement);
    await expect(menu.getByText(m.library_collection_boundary_start(), { exact: true })).toBeVisible();
    await expect(menu.getByText(m.library_collection_boundary_end(), { exact: true })).toBeVisible();
    await userEvent.keyboard('{Escape}');
    const duplicate = canvasElement.querySelectorAll<HTMLElement>('[data-member]')[1]!;
    await openNote(duplicate);
    await userEvent.type(within(duplicate).getByRole('textbox'), ' An unsaved note');
    await expect(canvas.getByText(m.library_collection_move_save_first())).toBeVisible();
    const blocked = await boundaryMenu(canvasElement);
    for (const label of [m.library_collection_boundary_start(), m.library_collection_boundary_end()]) {
      const action = blocked.getByText(label, { exact: true });
      await expect(
        action.closest('[role="menuitem"],button')?.matches('[disabled],[aria-disabled="true"],[data-disabled]'),
      ).toBe(true);
    }
  },
};

export const BoundaryPending: Story = {
  render: () => renderEditor('boundary-pending', 'page-two'),
  play: async ({ canvasElement }) => {
    const canvas = await openEditor(canvasElement, false);
    const menu = await boundaryMenu(canvasElement);
    await userEvent.click(menu.getByText(m.library_collection_boundary_end(), { exact: true }));
    await waitFor(() => expect(canvasElement.querySelector('[data-collection-boundary]')).toBeVisible());
    await expect(canvas.getByRole('button', { name: m.library_collection_cancel() })).toBeDisabled();
    await expect(canvas.getAllByRole('checkbox')[0]).toBeDisabled();
  },
  beforeEach: () => () => completePendingCollectionSave(),
};

async function unknownBoundary(canvasElement: HTMLElement) {
  const canvas = await openEditor(canvasElement, false);
  const menu = await boundaryMenu(canvasElement);
  await userEvent.click(menu.getByText(m.library_collection_boundary_end(), { exact: true }));
  await canvas.findByRole('button', { name: m.library_collection_boundary_retry() });
  await expect(canvas.getByRole('button', { name: m.library_collection_cancel() })).toBeDisabled();
  return canvas;
}

export const BoundaryUnknown: Story = {
  render: () => renderEditor('boundary-unknown', 'page-two'),
  play: async ({ canvasElement }) => {
    await unknownBoundary(canvasElement);
  },
};

export const BoundaryResolved: Story = {
  render: () => renderEditor('boundary-unknown', 'page-two'),
  play: async ({ canvasElement }) => {
    const canvas = await unknownBoundary(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_boundary_retry() }));
    await waitFor(() => expect(canvas.queryByRole('button', { name: m.library_collection_save() })).toBeNull());
    await expect(canvasElement.querySelector('[data-collection-boundary]')).toHaveTextContent(
      m.library_collection_boundary_moved_end({
        title: m.library_member_occurrence({ title: 'Snow Country', position: 2 }),
      }),
    );
  },
};

export const BoundaryReadRecovery: Story = {
  render: () => renderEditor('boundary-refresh-failed', 'page-two'),
  play: async ({ canvasElement }) => {
    const canvas = await openEditor(canvasElement, false);
    const menu = await boundaryMenu(canvasElement);
    await userEvent.click(menu.getByText(m.library_collection_boundary_start(), { exact: true }));
    await expect(await canvas.findByText(m.library_collection_boundary_refresh_failed())).toBeVisible();
    await expect(canvas.queryByRole('button', { name: m.library_collection_boundary_retry() })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_boundary_refresh() }));
    await waitFor(() => expect(canvas.queryByRole('button', { name: m.library_collection_save() })).toBeNull());
  },
};
