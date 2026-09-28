import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { RealmPageStory } from '../realm/story-page.tsx';
import { fictionModules, fictionZone } from '../zones/fixtures.ts';
import type { PlacedModule } from '../zones/zone-home.tsx';
import fiction from '../../zones/official/fiction/index.tsx';

const at = '2026-09-28T08:30:00.000Z';
const placed = fictionModules('en').find(item => item.module.id === 'latest');
if (placed?.module.type !== 'shelf' || placed.state.state !== 'ready') {
  throw new Error('Latest shelf fixture is missing');
}
type ShelfModule = Extract<PlacedModule, { module: { type: 'shelf' } }>;
const latest = placed as ShelfModule;
const shelf = latest.state;
if (shelf.state !== 'ready') throw new Error('Latest shelf fixture is not ready');
const module = { ...latest, state: { state: 'ready', data: { tabs: shelf.data.tabs.map(tab => ({
  ...tab, items: tab.items.map(work => work.latestChapter
    ? { ...work, latestChapter: { ...work.latestChapter, at } } : work),
})) } } } as PlacedModule;

const unnamedModule = { ...latest, state: { state: 'ready', data: { tabs: shelf.data.tabs.map(tab => ({
  ...tab, items: tab.items.map(work => work.latestChapter
    ? { ...work, latestChapter: { ...work.latestChapter, title: null, at: null } } : work),
})) } } } as PlacedModule;

function Page({ unnamed = false }: { unnamed?: boolean }) {
  return <RealmPageStory zone={fictionZone('en')} modules={[unnamed ? unnamedModule : module]} locale="en" pkg={fiction}
    execution={{ mode: 'package', slug: 'fiction' }} />;
}

const meta = { title: 'Zones/Official fiction lists', component: Page } satisfies Meta<typeof Page>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ChapterUpdates: Story = {
  async play({ canvasElement }) {
    const region = within(canvasElement).getByRole('region', { name: 'Latest' });
    await expect(within(region).getByRole('tab', { name: 'New chapters' })).toHaveAttribute('aria-selected', 'true');
    const first = within(region).getAllByRole('listitem')[0]!;
    await expect(within(first).getByRole('link', { name: '第 212 章' })).toBeVisible();
    await expect(within(first).getByRole('link', { name: '雨夜书店' })).toBeVisible();
    await expect(first.querySelector('time')).toHaveAttribute('datetime', at);
    await expect(within(first).getByRole('link', { name: 'Why 雨夜书店 is here' })).toBeVisible();
  },
};

export const ChapterWithoutPublishedTitle: Story = {
  args: { unnamed: true },
  async play({ canvasElement }) {
    const region = within(canvasElement).getByRole('region', { name: 'Latest' });
    const first = within(region).getAllByRole('listitem')[0]!;
    await expect(within(first).getByRole('link', { name: 'Latest chapter' })).toBeVisible();
    await expect(first.querySelector('time')).toBeNull();
  },
};
