import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { userEvent, within, waitFor } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { displayLibraryTitle } from '../library/title';
import { PageStory, exposureStory, libraryEntriesReady, libraryHeadingReady, pageReady, pagePaths } from './page';
import entries from '../kernel/recorded/library-entries.json';
import { setLibraryEntriesStoryMode, setLibraryTypesStoryState } from '../kernel/fake/library-entries-story';
import { pickText } from '@rezics/composition';
import { displayTypeLabel, type Release } from '../subject/definitions';
import definitions from '../kernel/recorded/definitions-release.json';
import { libraryStateLabel } from '../library/profiles';
import { setContinueStorySize } from '../kernel/fake/library-continue';
import { setLibraryNavigationStoryState } from '../kernel/fake/library-pins';

const meta = {
  title: 'Pages/Library/Entries',
  parameters: { layout: 'fullscreen' },
  beforeEach: () => setLibraryEntriesStoryMode('recorded'),
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const stateFilterEntry = entries.libraryEntries.find((entry) => entry.state === 'planned')!;

function filteredEntriesPath(title: string): string {
  const row = entries.libraryEntries.find(
    (entry) => displayLibraryTitle(entry.subject.label, getLocale()).text === title,
  );
  if (!row) throw new Error(`No recorded entry exists for ${title}.`);
  return `${pagePaths['library-entries']}?state=${encodeURIComponent(row.state)}&layout=list`;
}
export const SignedIn: Story = {
  name: 'Owner',
  play: libraryEntriesReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-entries']} />,
};
export const ExposureOpen: Story = exposureStory(pagePaths['library-entries']);
export const ExposureClosed: Story = exposureStory(pagePaths['library-entries'], true);

// UNRUN: the route harness owns real filter navigation, while the connected pattern owns row interactions.
export const StateFilterCleared: Story = {
  name: 'Owner, state filter cleared',
  render: () => (
    <PageStory
      visitor="Signed In"
      path={`${pagePaths['library-entries']}?state=${encodeURIComponent(stateFilterEntry.state)}&layout=list&size=l`}
    />
  ),
  play: async (context) => {
    await libraryHeadingReady(context, m.library_heading);
    const canvas = within(context.canvasElement);
    const status = libraryStateLabel(
      definitions.release as unknown as Release,
      stateFilterEntry.subject.type,
      stateFilterEntry.state,
      getLocale(),
    )!.text;
    await canvas.findByRole('heading', { name: m.library_tracked_entries_state({ status }) });
    const clear = await canvas.findByRole('link', { name: m.library_clear_state() });
    await expect(clear).toHaveAttribute('href', `/${getLocale()}/library?layout=list&size=l`);
    await expect(canvas.getByText(m.library_filtered_by({ status }))).toBeVisible();
    await userEvent.click(clear);
    await expect(await canvas.findByRole('heading', { name: m.library_tracked_entries() })).toBeVisible();
    expect(canvas.queryByRole('link', { name: m.library_clear_state() })).toBeNull();
    const layout = within(await canvas.findByRole('group', { name: m.library_layout() }));
    await expect(layout.getByRole('button', { name: m.library_layout_list() })).toHaveAttribute('aria-pressed', 'true');
  },
};

export const FilteredEmpty: Story = {
  render: () => {
    setLibraryEntriesStoryMode('empty');
    setContinueStorySize(0);
    setLibraryNavigationStoryState({ pinCount: 0, builtins: 'none', collectionCount: 0 });
    return (
      <PageStory
        visitor="Signed In"
        path={`${pagePaths['library-entries']}?state=${encodeURIComponent(entries.libraryEntries[0]!.state)}&layout=list&size=l`}
      />
    );
  },
  play: async (context) => {
    await libraryHeadingReady(context, m.library_heading);
    const main = within(within(context.canvasElement).getByRole('main'));
    await expect(await main.findByText(m.library_filter_empty_description())).toBeVisible();
    expect(main.queryByText(m.library_empty_title())).toBeNull();
    await expect(main.getByRole('link', { name: m.library_clear_state() })).toHaveAttribute(
      'href',
      `/${getLocale()}/library?layout=list&size=l`,
    );
  },
};

async function removeFromShelf(
  context: { canvasElement: HTMLElement },
  title = displayLibraryTitle(entries.libraryEntries[0]!.subject.label, getLocale()).text,
) {
  await pageReady(context);
  const canvas = within(context.canvasElement);
  const actions = await canvas.findByRole('button', { name: m.library_entry_actions({ title }) });
  await waitFor(() => expect(actions).toBeEnabled());
  await userEvent.click(actions);
  const sheet = window.matchMedia('(max-width: 767px)').matches || window.matchMedia('(pointer: coarse)').matches;
  await userEvent.click(
    await within(document.body).findByRole(sheet ? 'button' : 'menuitem', {
      name: m.library_remove_from_library(),
    }),
  );
  await userEvent.click(await within(document.body).findByRole('button', { name: m.library_remove_submit() }));
  await expect(await within(document.body).findByRole('button', { name: m.editor_undo() })).toBeVisible();
  await waitFor(() => expect(canvas.queryByRole('button', { name: m.library_entry_actions({ title }) })).toBeNull());
  window.scrollTo({ top: 0, behavior: 'instant' });
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

function removalStory(title: string, refusal: 'occupied' | 'stale' | 'expired') {
  return async (context: { canvasElement: HTMLElement }) => {
    await removeFromShelf(context, title);
    const canvas = within(context.canvasElement);
    await userEvent.click(await within(document.body).findByRole('button', { name: m.editor_undo() }));
    await expect(await canvas.findByText(m[`library_restore_${refusal}`]())).toBeVisible();
    if (refusal === 'occupied') await canvas.findByText('I Am a Cat');
  };
}

export const UndoAfterShelfRemoval: Story = {
  tags: ['!dev'],
  name: 'Owner, entry removed',
  play: (context) => removeFromShelf(context),
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-entries']} />,
};

export const RestoreOccupied: Story = {
  tags: ['!dev'],
  name: 'Restore blocked by existing entry',
  play: removalStory('I Am a Cat', 'occupied'),
  render: () => <PageStory visitor="Signed In" path={filteredEntriesPath('I Am a Cat')} />,
};

export const RestoreStale: Story = {
  tags: ['!dev'],
  name: 'Restore blocked by changed entry',
  play: removalStory('The Tale of Genji', 'stale'),
  render: () => <PageStory visitor="Signed In" path={filteredEntriesPath('The Tale of Genji')} />,
};

export const RestoreExpired: Story = {
  tags: ['!dev'],
  name: 'Restore window expired',
  play: removalStory('Norwegian Wood', 'expired'),
  render: () => <PageStory visitor="Signed In" path={filteredEntriesPath('Norwegian Wood')} />,
};

export const UndoRestored: Story = {
  tags: ['!dev'],
  name: 'Owner, entry restored',
  play: async (context) => {
    await removeFromShelf(context);
    await userEvent.click(await within(document.body).findByRole('button', { name: m.editor_undo() }));
    await expect(await within(context.canvasElement).findByRole('link', { name: 'Kokoro' })).toBeVisible();
  },
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-entries']} />,
};

export const SelectedLoadedPage: Story = {
  name: 'Owner, loaded page selected',
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-entries']} />,
  play: async (context) => {
    await libraryEntriesReady(context);
    const canvas = within(context.canvasElement);
    const select = await canvas.findByRole('button', { name: m.library_selection_page() });
    await waitFor(() => expect(select).toBeEnabled());
    await userEvent.click(select);
    await expect(await canvas.findByRole('region', { name: m.library_selection_heading() })).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.library_selection_clear() })).toBeEnabled();
  },
};

export const ChosenColumns: Story = {
  name: 'Owner, chosen table columns',
  render: () => (
    <PageStory visitor="Signed In" path={`${pagePaths['library-entries']}?layout=table&columns=title,status`} />
  ),
  play: async (context) => {
    await libraryHeadingReady(context, m.library_heading);
    const canvas = within(context.canvasElement);
    const title = displayLibraryTitle(entries.libraryEntries[0]!.subject.label, getLocale()).text;
    await expect(await canvas.findByRole('link', { name: title })).toBeVisible();
    if (window.matchMedia('(min-width: 640px)').matches) {
      await expect(canvas.getByRole('button', { name: m.library_columns() })).toBeEnabled();
      await expect(canvas.getByRole('columnheader', { name: m.library_column_status() })).toBeVisible();
      await expect(canvas.queryByRole('columnheader', { name: m.library_sort_activity() })).toBeNull();
    } else {
      await expect(canvas.queryByRole('button', { name: m.library_columns() })).toBeNull();
    }
    await expect(canvas.getByRole('button', { name: m.library_entry_actions({ title }) })).toBeEnabled();
  },
};

export const SelectedLabelChoice: Story = {
  name: 'Owner, existing label chosen for selected entries',
  parameters: {
    admitted: ['personal_library', 'reading_progress', 'collections', 'library_label.list', 'library_label.assign'],
  },
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-entries']} />,
  play: async (context) => {
    await libraryEntriesReady(context);
    const canvas = within(context.canvasElement);
    const select = await canvas.findByRole('button', { name: m.library_selection_page() });
    await waitFor(() => expect(select).toBeEnabled());
    await userEvent.click(select);
    await userEvent.click(canvas.getByRole('button', { name: m.library_selected_labels_open() }));
    const dialog = within(await within(document.body).findByRole('dialog', { name: m.library_selected_labels_open() }));
    await userEvent.type(dialog.getByRole('textbox', { name: m.library_selected_labels_search() }), 'Read');
    await userEvent.click(await dialog.findByRole('checkbox', { name: 'Reading list' }));
    await expect(dialog.getByRole('button', { name: m.library_selected_labels_apply() })).toBeEnabled();
    await expect(dialog.getByText(m.library_selected_labels_description())).toBeVisible();
  },
};

function movieLabel() {
  return displayTypeLabel(pickText(definitions.release.types['schema:Movie'].labels, getLocale()).text, getLocale());
}

export const TypeSelected: Story = {
  name: 'Owner, Type selected',
  beforeEach: () => setLibraryEntriesStoryMode('type-filter'),
  render: () => <PageStory visitor="Signed In" path={`${pagePaths['library-entries']}?layout=list&size=l`} />,
  play: async (context) => {
    await libraryHeadingReady(context, m.library_heading);
    const canvas = within(context.canvasElement);
    const action = await canvas.findByRole('button', { name: m.library_type_action({ type: m.library_types_all() }) });
    await waitFor(() => expect(action).toBeEnabled());
    await userEvent.click(action);
    const dialog = within(await within(document.body).findByRole('dialog', { name: m.library_types_heading() }));
    await userEvent.click(await dialog.findByRole('button', { name: m.library_types_next() }));
    await userEvent.click(await dialog.findByRole('link', { name: movieLabel() }));
    await expect(await canvas.findByText(m.library_type_filtered({ type: movieLabel() }))).toBeVisible();
    await expect(canvas.getByRole('link', { name: m.library_type_clear() })).toHaveAttribute(
      'href',
      `/${getLocale()}/library?orderBy=lastActivity&direction=desc&layout=list&size=l`,
    );
  },
};

export const TypeNoMatch: Story = {
  name: 'Owner, no entries match Type',
  beforeEach: () => setLibraryEntriesStoryMode('type-empty'),
  render: () => (
    <PageStory visitor="Signed In" path={`${pagePaths['library-entries']}?type=schema%3AMovie&layout=list&size=l`} />
  ),
  play: async (context) => {
    await libraryHeadingReady(context, m.library_heading);
    const canvas = within(context.canvasElement);
    await expect(await canvas.findByText(m.library_type_empty_title({ type: movieLabel() }))).toBeVisible();
    expect(canvas.queryByText(m.library_empty_title())).toBeNull();
    expect(canvas.getAllByRole('link', { name: m.library_type_clear() }).length).toBeGreaterThan(0);
  },
};

export const TypePickerUnavailable: Story = {
  name: 'Owner, Type picker failed with shelf retained',
  beforeEach: () => {
    setLibraryEntriesStoryMode('type-filter');
    setLibraryTypesStoryState('unavailable');
  },
  render: () => (
    <PageStory visitor="Signed In" path={`${pagePaths['library-entries']}?type=schema%3AMovie&layout=list&size=l`} />
  ),
  play: async (context) => {
    await libraryHeadingReady(context, m.library_heading);
    const canvas = within(context.canvasElement);
    const action = await canvas.findByRole('button', { name: m.library_type_action({ type: movieLabel() }) });
    await waitFor(() => expect(action).toBeEnabled());
    await userEvent.click(action);
    const dialog = within(await within(document.body).findByRole('dialog', { name: m.library_types_heading() }));
    await expect(await dialog.findByText(m.library_types_unavailable())).toBeVisible();
    await expect(dialog.getByRole('button', { name: m.library_types_retry() })).toBeEnabled();
    expect(canvas.queryAllByRole('listitem').length).toBeGreaterThan(0);
  },
};
