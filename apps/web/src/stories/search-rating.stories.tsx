import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory, pagePaths, searchRatingReady } from './page';

const meta = { title: 'Pages/Search', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const TopRated: Story = {
  name: 'Top rated',
  play: searchRatingReady,
  render: () => <PageStory visitor="Signed Out" path={pagePaths['search-rating']} />,
};
