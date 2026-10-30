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
import { PatternStory, pagePaths } from './page';

const meta = {
  title: 'Patterns/Collection Editor',
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'The actual owner editor: Edit enters a local draft, keyboard buttons and drag handles reorder only loaded occurrences, Save sends current native commands, and Cancel discards the draft. Writes are independently receipted. Existing imported cover and exact Type choices use the current native metadata command. Selected removal and cross-Collection transfer use the delivered native atomic commands on Save; built-in dynamic rules remain immutable.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const id = pagePaths['library-collection'].split('/').at(-1)!;

function EditorRegion() {
  const query = collectionPageQuery(id, undefined, 'session');
  const { data } = useSuspenseQuery(query);
  if ('preparing' in data) throw new Error('Expected a curated Collection');
  return (
    <CollectionPage
      page={data}
      cursor={undefined}
      queryKey={query.queryKey}
      readEditorPage={async () => {
        const editable = await readCollectionPage({ data: { id, credentialMode: 'session', editor: true } });
        if ('preparing' in editable) throw new Error('Expected a curated Collection');
        return editable;
      }}
      refreshPage={async () => {
        const refreshed = await readCollectionPage({ data: { id, credentialMode: 'session' } });
        if ('preparing' in refreshed) throw new Error('Expected a curated Collection');
        return refreshed;
      }}
    />
  );
}
function renderEditor(mode: CollectionStoryMode = 'private') {
  setCollectionStoryMode(mode, true);
  return (
    <PatternStory visitor="Signed In" path={pagePaths['library-collection']}>
      <Suspense fallback={null}>
        <div className="w-full p-4">
          <EditorRegion />
        </div>
      </Suspense>
    </PatternStory>
  );
}
async function openEditor(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await canvas.findByRole('heading', { level: 1, name: 'Books I come back to' });
  await userEvent.click(canvas.getAllByRole('button', { name: m.library_collection_actions() })[0]!);
  const body = within(document.body);
  const edit = await body.findByText(m.library_collection_edit(), { exact: true });
  await userEvent.click(edit);
  await canvas.findByRole('textbox', { name: m.library_collection_title() });
  return canvas;
}
function firstRow(canvasElement: HTMLElement) {
  const row = canvasElement.querySelector<HTMLElement>('[data-collection-members] [data-slot="list-row"]');
  if (!row) throw new Error('Missing member row');
  return row;
}

export const Details: Story = {
  render: () => renderEditor(),
  play: async ({ canvasElement }) => {
    await openEditor(canvasElement);
  },
};
export const Members: Story = {
  render: () => renderEditor(),
  play: async ({ canvasElement }) => {
    const canvas = await openEditor(canvasElement);
    await expect(canvas.getAllByRole('checkbox')).toHaveLength(4);
  },
};
export const Selection: Story = {
  render: () => renderEditor(),
  play: async ({ canvasElement }) => {
    const canvas = await openEditor(canvasElement);
    await userEvent.click(canvas.getAllByRole('checkbox')[0]!);
    await userEvent.click(canvas.getAllByRole('checkbox')[1]!);
    await expect(canvas.getByText(m.library_collection_selection_count({ count: 2 }))).toBeVisible();
  },
};
export const Reordering: Story = {
  render: () => renderEditor(),
  play: async ({ canvasElement }) => {
    const canvas = await openEditor(canvasElement);
    const down = within(firstRow(canvasElement)).getByRole('button', { name: m.library_member_move_down() });
    down.focus();
    await userEvent.keyboard('{Enter}');
    await expect(firstRow(canvasElement)).toHaveTextContent('The Tale of Genji');
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_save() }));
    await waitFor(() => expect(canvas.queryByRole('textbox', { name: m.library_collection_title() })).toBeNull());
    await expect(firstRow(canvasElement)).toHaveTextContent('The Tale of Genji');
    await openEditor(canvasElement);
    await expect(firstRow(canvasElement)).toHaveTextContent('The Tale of Genji');
    await expect(canvas.getByRole('button', { name: m.library_collection_save() })).toBeVisible();
  },
};
export const Note: Story = {
  render: () => renderEditor(),
  play: async ({ canvasElement }) => {
    const canvas = await openEditor(canvasElement);
    await userEvent.type(within(firstRow(canvasElement)).getByRole('textbox'), 'A draft note');
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_cancel() }));
    await expect(canvas.queryByDisplayValue('A draft note')).toBeNull();
    await openEditor(canvasElement);
    await expect(within(firstRow(canvasElement)).getByRole('textbox')).toHaveValue('');
    await userEvent.type(within(firstRow(canvasElement)).getByRole('textbox'), 'A saved note');
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_save() }));
    await waitFor(() => expect(canvas.queryByRole('textbox', { name: m.library_collection_title() })).toBeNull());
    await expect(await canvas.findByText('A saved note', { exact: true })).toBeVisible();
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
    await userEvent.click(within(firstRow(canvasElement)).getByRole('button', { name: m.library_member_remove() }));
    await userEvent.click(within(firstRow(canvasElement)).getByRole('button', { name: m.library_member_remove() }));
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
    await userEvent.click(within(firstRow(canvasElement)).getByRole('button', { name: m.library_member_remove() }));
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
    await expect(await canvas.findByRole('link', { name: 'Snow Country', exact: true })).toBeVisible();
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
