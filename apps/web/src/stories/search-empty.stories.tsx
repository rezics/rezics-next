import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory, pages, searchEmptyReady } from './page';

const meta = { title: 'Pages/Search Empty', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {
  name: 'Signed In',
  play: searchEmptyReady,
  render: () => <PageStory visitor="Signed In">{pages['search-empty']}</PageStory>,
};
export const SignedOut: Story = {
  name: 'Signed Out',
  play: searchEmptyReady,
  render: () => <PageStory visitor="Signed Out">{pages['search-empty']}</PageStory>,
};
