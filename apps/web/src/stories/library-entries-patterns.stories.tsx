import type { Meta, StoryObj } from '@storybook/react-vite';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Suspense } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { readPersonalLibrary } from '../library/entries-actions';
import { PersonalLibraryPage } from '../library/entries-page';
import type { LibraryEntryStateWrite } from '../library/entries-read';
import type { ShelfLayout, ShelfSize } from '../library/shelf-params';
import { displayLibraryTitle } from '../library/title';
import entries from '../kernel/recorded/library-entries.json';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PatternStory, pagePaths } from './page';

const viewports = {
  phone: { name: 'Phone', styles: { width: '390px', height: '844px' } },
  desktop: { name: 'Desktop', styles: { width: '1280px', height: '900px' } },
};

const meta = {
  title: 'Patterns/Library/Entry layouts',
  parameters: { layout: 'fullscreen', viewport: { options: viewports } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function EntriesPattern({
  layout,
  size = 'm',
  state,
}: {
  layout: ShelfLayout;
  size?: ShelfSize;
  state?: LibraryEntryStateWrite;
}) {
  const { data } = useSuspenseQuery({
    queryKey: ['story', 'library-entry-layout', state ?? 'all'],
    queryFn: () => readPersonalLibrary({ data: state ? { state } : {} }),
  });
  return <PersonalLibraryPage page={data} locale={getLocale()} display={{ layout, size }} />;
}

function renderPattern(layout: ShelfLayout, size: ShelfSize, state?: LibraryEntryStateWrite) {
  const path = state ? `${pagePaths['library-entries']}?state=${state}` : pagePaths['library-entries'];
  return (
    <PatternStory visitor="Signed In" path={path}>
      <Suspense fallback={null}>
        <div className="w-full max-w-6xl p-4">
          <EntriesPattern layout={layout} size={size} {...(state ? { state } : {})} />
        </div>
      </Suspense>
    </PatternStory>
  );
}

function story(name: string, layout: ShelfLayout, size: ShelfSize = 'm', state?: LibraryEntryStateWrite): Story {
  return {
    name,
    play: async ({ canvasElement }) => {
      const view = within(canvasElement);
      await view.findByRole('heading', { name: m.library_heading() });
      if (layout === 'table' && window.matchMedia('(max-width: 639px)').matches) return;
      const layoutGroup = within(await view.findByRole('group', { name: m.library_layout() }));
      const layoutLabel =
        layout === 'grid'
          ? m.library_layout_grid()
          : layout === 'list'
            ? m.library_layout_list()
            : m.library_layout_table();
      await expect(await layoutGroup.getByRole('button', { name: layoutLabel }).getAttribute('aria-pressed')).toBe(
        'true',
      );
      if (layout === 'grid') {
        const sizeGroup = within(await view.findByRole('group', { name: m.library_size() }));
        const sizeLabel =
          size === 's' ? m.library_size_small() : size === 'l' ? m.library_size_large() : m.library_size_medium();
        await expect(await sizeGroup.getByRole('button', { name: sizeLabel }).getAttribute('aria-pressed')).toBe(
          'true',
        );
      }
      if (state) {
        const status = m.library_state_in_progress();
        await view.findByRole('heading', { name: m.library_tracked_entries_state({ status }) });
        await view.findByRole('link', { name: m.library_clear_state() });
      }
    },
    render: () => renderPattern(layout, size, state),
  };
}

export const GridMedium: Story = story('Grid, medium cards', 'grid');
export const ListLayout: Story = story('List layout', 'list');
export const TableLayout: Story = story('Table layout', 'table');
export const SmallGrid: Story = story('Small cards', 'grid', 's');
export const LargeGrid: Story = story('Large cards', 'grid', 'l');
export const InProgress: Story = story('In-progress filter', 'grid', 'm', 'in_progress');

export const PhoneTileMenuOpen: Story = {
  name: 'Phone tile actions open',
  globals: { viewport: { value: 'phone' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { name: m.library_heading() });
    const title = displayLibraryTitle(entries.libraryEntries[0]!.subject.label, getLocale()).text;
    const actionName = m.library_entry_actions({ title });
    const trigger = await canvas.findByRole('button', { name: actionName });
    await waitFor(() => expect(trigger).toBeEnabled(), { timeout: 5000 });
    await userEvent.click(trigger);
    const dialog = await within(document.body).findByRole('dialog', { name: actionName });
    await expect(dialog.querySelector('[data-slot="drawer-content"]')).toBeTruthy();
  },
  render: () => renderPattern('grid', 'm'),
};
