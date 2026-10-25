import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory, pages, searchReady } from './page';

const meta = { title: 'Pages/Search', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {
  name: 'Signed In',
  play: searchReady,
  render: () => <PageStory visitor="Signed In">{pages.search}</PageStory>,
};
export const SignedOut: Story = {
  name: 'Signed Out',
  play: searchReady,
  render: () => <PageStory visitor="Signed Out">{pages.search}</PageStory>,
};
