import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { withSurface } from '../stories/support.tsx';
import { CoverCard, CoverGrid, CoverRow } from './cover-card.tsx';
import { ShelfTabs, ShelfToolbar, ShelfTypeChips } from './shelf-toolbar.tsx';

const labels = {
  search: 'Search library',
  sort: 'Sort',
  direction: 'Direction',
  ascending: 'Ascending',
  descending: 'Descending',
  filter: 'Filter',
  clearFilters: 'Clear filters',
  removeFilter: 'Remove filter',
  layout: 'Layout',
  grid: 'Grid',
  list: 'List',
  table: 'Table',
  display: 'Display',
  density: 'Density',
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
  select: 'Select',
  view: 'View',
  items: 'items',
};
const subjects = [
  { id: '1', title: 'The Long Way Home', types: ['schema:Book'] },
  { id: '2', title: 'A Garden of Stars', types: ['schema:MusicAlbum'] },
  { id: '3', title: 'The Quiet Sea', types: ['schema:Book'] },
  { id: '4', title: 'Four Seasons', types: ['schema:MusicAlbum'] },
];
const tabs = [
  { value: 'all', label: 'All', count: 4, href: '#all' },
  { value: 'progress', label: 'In progress', count: 2, href: '#progress' },
  { value: 'planned', label: 'Planned', count: 2, href: '#planned' },
  { value: 'completed', label: 'Completed', count: 0, href: '#completed' },
];
function Page({ initial = 'all' }: { initial?: string }) {
  const [tab, setTab] = useState(initial);
  const [type, setType] = useState('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('recent');
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  const [layout, setLayout] = useState<'grid' | 'list' | 'table'>('grid');
  const [density, setDensity] = useState<'small' | 'medium' | 'large'>('medium');
  const cards = (items: typeof subjects) =>
    items.map((subject, index) => (
      <CoverCard
        key={subject.id}
        href={`#${subject.id}`}
        title={subject.title}
        cover={{ subject, cover: null, src: () => '' }}
        secondary="A. Reader"
        progress={{ value: (index + 1) / 4, label: `${(index + 1) * 25}%` }}
      />
    ));
  return (
    <main className="mx-auto max-w-7xl space-y-6 p-4 sm:p-8">
      <header>
        <p className="text-sm text-muted-foreground">Your collection</p>
        <h1 className="text-3xl font-semibold">Library</h1>
      </header>
      <ShelfTabs tabs={tabs} value={tab} onValueChange={setTab} />
      <ShelfTypeChips
        label="Type"
        options={[
          { value: 'all', label: 'All types' },
          { value: 'books', label: 'Books' },
          { value: 'music', label: 'Music' },
        ]}
        value={type}
        onValueChange={setType}
      />
      <ShelfToolbar
        labels={labels}
        search={search}
        onSearch={setSearch}
        sorts={[
          { value: 'recent', label: 'Recent activity' },
          { value: 'title', label: 'Title' },
        ]}
        sort={sort}
        direction={direction}
        onSortChange={(s, d) => {
          setSort(s);
          setDirection(d);
        }}
        filters={<p>Filter by type or status</p>}
        active={[]}
        onRemoveFilter={() => {}}
        onClearFilters={() => {}}
        layout={layout}
        onLayoutChange={setLayout}
        density={density}
        onDensityChange={setDensity}
        onSelect={() => {}}
        count={4}
      />
      {tab === 'all' ? (
        <>
          <section className="space-y-3">
            <div className="flex justify-between">
              <h2 className="text-xl font-semibold">
                Continue <span className="text-muted-foreground">2</span>
              </h2>
              <a href="#progress" onClick={() => setTab('progress')}>
                View all
              </a>
            </div>
            <CoverRow ratio="2:3" label="Continue">
              {cards(subjects.slice(0, 2))}
            </CoverRow>
          </section>
          <section className="space-y-3">
            <div className="flex justify-between">
              <h2 className="text-xl font-semibold">
                Planned <span className="text-muted-foreground">2</span>
              </h2>
              <a href="#planned" onClick={() => setTab('planned')}>
                View all
              </a>
            </div>
            <CoverGrid ratio="2:3">{cards(subjects.slice(2))}</CoverGrid>
          </section>
        </>
      ) : (
        <section className="space-y-3">
          <h2 className="text-xl font-semibold">In progress</h2>
          <CoverGrid ratio="2:3">{cards(subjects)}</CoverGrid>
        </section>
      )}
    </main>
  );
}
const meta = { title: 'Rezics UI/Shelf Page', component: Page, decorators: [withSurface] } satisfies Meta<typeof Page>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Overview: Story = {
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { name: 'Library' })).toBeVisible();
  },
};
export const InProgress: Story = { args: { initial: 'progress' } };
