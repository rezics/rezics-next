import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { RealmPageStory } from '../realm/story-page.tsx';
import { officialWorks, officialZone } from '../zones/official-fixtures.ts';
import type { PlacedModule } from '../zones/zone-home.tsx';
import books from '../../zones/official/books/index.tsx';

const works = officialWorks('books', 'en', 'rich').slice(0, 5);
const module = { module: { id: 'readers', type: 'ranking', title: 'Readers’ charts',
  rail: false, layout: 'rows', shuffle: false, more: null }, state: { state: 'ready',
  data: { metric: 'reads', tabs: (['day', 'week', 'month'] as const).map(interval => ({ interval,
    items: works.map((work, index) => ({ rank: index + 1, work })) })) } } } as PlacedModule;

function Page() {
  return <RealmPageStory zone={officialZone('books', 'en')} modules={[module]} locale="en" pkg={books}
    execution={{ mode: 'package', slug: 'books' }} />;
}

const meta = { title: 'Zones/Official books lists', component: Page } satisfies Meta<typeof Page>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ReaderCharts: Story = {
  async play({ canvasElement }) {
    const region = within(canvasElement).getByRole('region', { name: 'Readers’ charts' });
    await expect(within(region).getByText('Ranked by reads')).toBeVisible();
    await expect(within(region).getByRole('tab', { name: 'Today' })).toHaveAttribute('aria-selected', 'true');
    await expect(within(region).getAllByRole('listitem')).toHaveLength(5);
    await expect(within(region).getAllByText('Completed')[0]).toBeVisible();
    await expect(within(region).getByRole('link', { name: 'Why Jane Eyre is here' })).toBeVisible();
    await userEvent.click(within(region).getByRole('tab', { name: 'This month' }));
    await expect(within(region).getByRole('tab', { name: 'This month' })).toHaveAttribute('aria-selected', 'true');
  },
};
