import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory, pages } from './page';

const meta = { title: 'Pages/Home', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {
  name: 'Signed In',
  render: () => <PageStory visitor="Signed In">{pages.home}</PageStory>,
};
export const SignedOut: Story = {
  name: 'Signed Out',
  render: () => <PageStory visitor="Signed Out">{pages.home}</PageStory>,
};
