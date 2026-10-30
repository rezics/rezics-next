import type { Meta, StoryObj } from '@storybook/react-vite';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Suspense } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { CollectionPage } from '../library/collection-page';
import { collectionPageQuery, readCollectionPage } from '../library/collection-queries';
import { CollectionFilters } from '../library/collection-filters';
import {
  completePendingCollectionSave,
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
          'The actual owner editor: Edit enters a local draft, keyboard buttons and drag handles reorder only loaded occurrences, Save sends current native commands, and Cancel discards the draft. Writes are independently receipted. Cover selection and native cross-Collection transfer await the generated producer; built-in dynamic rules remain immutable.',
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
      refreshPage={async () => {
        const refreshed = await readCollectionPage({ data: { id, credentialMode: 'session' } });
        if ('preparing' in refreshed) throw new Error('Expected a curated Collection');
        return refreshed;
      }}
    />
  );
}
function renderEditor(mode: CollectionStoryMode = 'private') {
  setCollectionStoryMode(mode);
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
  await userEvent.click(canvas.getAllByRole('button', { name: m.library_collection_actions(), exact: true })[0]!);
  const body = within(document.body);
  const edit = await body.findByText(m.library_collection_edit(), { exact: true });
  await userEvent.click(edit);
  await canvas.findByRole('textbox', { name: m.library_collection_title() });
  return canvas;
}
function firstRow(canvasElement: HTMLElement) {
  const row = canvasElement.querySelector<HTMLElement>('[data-member]');
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
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_save(), exact: true }));
    await waitFor(() => expect(canvas.queryByRole('textbox', { name: m.library_collection_title() })).toBeNull());
    await expect(firstRow(canvasElement)).toHaveTextContent('The Tale of Genji');
  },
};
export const Note: Story = {
  render: () => renderEditor(),
  play: async ({ canvasElement }) => {
    const canvas = await openEditor(canvasElement);
    await userEvent.type(within(firstRow(canvasElement)).getByRole('textbox'), 'A draft note');
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_cancel(), exact: true }));
    await expect(canvas.queryByDisplayValue('A draft note')).toBeNull();
    await openEditor(canvasElement);
    await expect(within(firstRow(canvasElement)).getByRole('textbox')).toHaveValue('');
    await userEvent.type(within(firstRow(canvasElement)).getByRole('textbox'), 'A saved note');
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_save(), exact: true }));
    await waitFor(() => expect(canvas.queryByRole('textbox', { name: m.library_collection_title() })).toBeNull());
    await expect(await canvas.findByText('A saved note', { exact: true })).toBeVisible();
  },
};
export const SavePending: Story = {
  render: () => renderEditor('pending-save'),
  play: async ({ canvasElement }) => {
    const canvas = await openEditor(canvasElement);
    await userEvent.type(canvas.getByRole('textbox', { name: m.library_collection_title() }), ' — revised');
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_save(), exact: true }));
    await expect(await canvas.findByRole('button', { name: m.library_collection_save_pending() })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: m.library_collection_cancel(), exact: true })).toBeDisabled();
  },
  beforeEach: () => () => completePendingCollectionSave(),
};
export const SaveError: Story = {
  render: () => renderEditor('failed-save'),
  play: async ({ canvasElement }) => {
    const canvas = await openEditor(canvasElement);
    await userEvent.type(canvas.getByRole('textbox', { name: m.library_collection_title() }), ' — revised');
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_save(), exact: true }));
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
