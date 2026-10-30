import type { Meta, StoryObj } from '@storybook/react-vite';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Suspense } from 'react';
import { expect, within } from 'storybook/test';
import { readPersonalLibrary } from '../library/entries-actions';
import { PersonalLibraryPage } from '../library/entries-page';
import type { LibraryEntryStateWrite } from '../library/entries-read';
import type { ShelfLayout, ShelfSize } from '../library/shelf-params';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PatternStory, pagePaths } from './page';

const meta = { title: 'Patterns/Library/Entry layouts', parameters: { layout: 'fullscreen' } } satisfies Meta;
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

function story(name: string, layout: ShelfLayout, size: ShelfSize = 'm', state?: LibraryEntryStateWrite): Story {
  const path = state ? `${pagePaths['library-entries']}?state=${state}` : pagePaths['library-entries'];
  return {
    name,
    play: async ({ canvasElement }) => {
      const view = within(canvasElement);
      await view.findByRole('heading', { name: m.library_heading() });
      if (layout === 'table' && window.matchMedia('(max-width: 639px)').matches) return;
      const layoutNav = within(await view.findByRole('navigation', { name: m.library_layout() }));
      const layoutLabel =
        layout === 'grid' ? m.library_layout_grid() : layout === 'list' ? m.library_layout_list() : m.library_layout_table();
      await expect(await layoutNav.getByRole('link', { name: layoutLabel }).getAttribute('aria-current')).toBe('true');
      if (layout === 'grid') {
        const sizeNav = within(await view.findByRole('navigation', { name: m.library_size() }));
        const sizeLabel = size === 's' ? m.library_size_small() : size === 'l' ? m.library_size_large() : m.library_size_medium();
        await expect(await sizeNav.getByRole('link', { name: sizeLabel }).getAttribute('aria-current')).toBe('true');
      }
    },
    render: () => (
      <PatternStory visitor="Signed In" path={path}>
        <Suspense fallback={null}>
          <div className="w-full max-w-6xl p-4">
            <EntriesPattern layout={layout} size={size} {...(state ? { state } : {})} />
          </div>
        </Suspense>
      </PatternStory>
    ),
  };
}

export const GridMedium: Story = story('Grid, medium cards', 'grid');
export const ListLayout: Story = story('List layout', 'list');
export const TableLayout: Story = story('Table layout', 'table');
export const SmallGrid: Story = story('Small cards', 'grid', 's');
export const LargeGrid: Story = story('Large cards', 'grid', 'l');
export const InProgress: Story = story('In-progress tab', 'grid', 'm', 'in_progress');
